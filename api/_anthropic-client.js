/**
 * Shared Anthropic API client wrapper — ALL model calls in this codebase go
 * through callClaude(). No raw SDK calls elsewhere.
 *
 * Responsibilities:
 *  - Retry with exponential backoff on 429 / 529 / 5xx (cap RETRY.maxAttempts).
 *    On 429 the `retry-after` response header is honoured — we wait at least
 *    that many seconds before retrying.
 *  - Never surfaces a raw 429 to callers: after retries are exhausted a
 *    wrapped MODEL_CALL_FAILED error is thrown, which the pipeline turns into
 *    a `failed` paper state (and never a quota decrement).
 *  - Pacing between sequential calls: the OTPM limit is a continuously
 *    replenishing token bucket, so we track the
 *    `anthropic-ratelimit-output-tokens-remaining` header and sleep when
 *    headroom is low.
 *  - Telemetry: accumulates input/output tokens AND prompt-cache counters
 *    (cache_creation_input_tokens / cache_read_input_tokens) per call so the
 *    cache hit rate and per-paper cost are visible in Firestore.
 */

import Anthropic from '@anthropic-ai/sdk';
import { PRICING, RETRY, PACING } from './_config.js';

let _client = null;
function getDefaultClient() {
  if (!_client) {
    // maxRetries: 0 — this wrapper owns retry behaviour (the SDK's built-in
    // retry would not let us record attempts or enforce our pacing).
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  }
  return _client;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Rate-limit state shared across the sequential calls of one invocation.
const rateState = { outputTokensRemaining: null, outputTokensResetAt: null, lastCallAt: 0 };

/** Test helper — clears pacing state between test cases. */
export function _resetRateState() {
  rateState.outputTokensRemaining = null;
  rateState.outputTokensResetAt = null;
  rateState.lastCallAt = 0;
}

function readHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

function updateRateState(headers) {
  const remaining = Number(readHeader(headers, 'anthropic-ratelimit-output-tokens-remaining'));
  if (Number.isFinite(remaining)) rateState.outputTokensRemaining = remaining;
  const reset = readHeader(headers, 'anthropic-ratelimit-output-tokens-reset');
  if (reset) rateState.outputTokensResetAt = reset;
}

/**
 * Sleeps before the next call: a small fixed floor between calls, plus a
 * longer pause when the rolling-minute output-token bucket is nearly drained.
 */
async function paceBeforeCall() {
  const sinceLast = Date.now() - rateState.lastCallAt;
  let waitMs = Math.max(0, PACING.minInterCallMs - sinceLast);

  if (
    rateState.outputTokensRemaining != null &&
    rateState.outputTokensRemaining < PACING.minOutputTokenHeadroom
  ) {
    let untilReset = PACING.lowHeadroomPauseMs;
    if (rateState.outputTokensResetAt) {
      const ms = new Date(rateState.outputTokensResetAt).getTime() - Date.now();
      if (Number.isFinite(ms) && ms > 0) untilReset = ms;
    }
    waitMs = Math.max(waitMs, Math.min(untilReset, PACING.maxPauseMs));
  }

  if (waitMs > 0) await sleep(waitMs);
}

function recordUsage(telemetry, message, model, label, attempts) {
  if (!telemetry || !message?.usage) return;
  const u = message.usage;
  telemetry.tokensIn            = (telemetry.tokensIn            || 0) + (u.input_tokens || 0);
  telemetry.tokensOut           = (telemetry.tokensOut           || 0) + (u.output_tokens || 0);
  telemetry.cacheCreationTokens = (telemetry.cacheCreationTokens || 0) + (u.cache_creation_input_tokens || 0);
  telemetry.cacheReadTokens     = (telemetry.cacheReadTokens     || 0) + (u.cache_read_input_tokens || 0);
  if (!Array.isArray(telemetry.calls)) telemetry.calls = [];
  telemetry.calls.push({
    label,
    model,
    attempts,
    inputTokens:              u.input_tokens || 0,
    outputTokens:             u.output_tokens || 0,
    cacheCreationInputTokens: u.cache_creation_input_tokens || 0,
    cacheReadInputTokens:     u.cache_read_input_tokens || 0,
  });
}

function pricingFor(model) {
  const key = Object.keys(PRICING).find((k) => k !== 'baselineModel' && model?.startsWith(k));
  return PRICING[key] || PRICING['claude-haiku-4-5'];
}

/**
 * Estimated USD cost of accumulated telemetry usage on the given model.
 * Cached reads are billed at 10% of input; cache writes at 125%.
 */
export function estimateCostUSD(telemetry, model) {
  const p = pricingFor(model);
  const M = 1e6;
  return (
    ((telemetry.tokensIn || 0) * p.input) / M +
    ((telemetry.cacheCreationTokens || 0) * p.input * 1.25) / M +
    ((telemetry.cacheReadTokens || 0) * p.input * 0.10) / M +
    ((telemetry.tokensOut || 0) * p.output) / M
  );
}

/**
 * What the same token volume would cost on the previous single-large-model
 * pipeline (no caching) — logged alongside the real cost for comparison.
 */
export function estimateBaselineCostUSD(telemetry) {
  const p = pricingFor(PRICING.baselineModel);
  const M = 1e6;
  const allInput =
    (telemetry.tokensIn || 0) +
    (telemetry.cacheCreationTokens || 0) +
    (telemetry.cacheReadTokens || 0);
  return (allInput * p.input) / M + ((telemetry.tokensOut || 0) * p.output) / M;
}

function isRetryable(status) {
  return status === 429 || status === 529 || (typeof status === 'number' && status >= 500);
}

/**
 * Make a Messages API call with pacing, retry, and telemetry.
 *
 * @param {object} params     - client.messages.create params (model, system, messages, max_tokens)
 * @param {object} telemetry  - mutable accumulator (tokensIn/Out, cache counters, calls[])
 * @param {object} [options]
 * @param {object} [options.client] - injected client (tests)
 * @param {string} [options.label]  - call label for telemetry ("generate:1", "repair:Q3", ...)
 * @returns {Promise<object>} the Message object
 */
export async function callClaude(params, telemetry, { client = getDefaultClient(), label = 'call' } = {}) {
  let lastErr = null;

  for (let attempt = 1; attempt <= RETRY.maxAttempts; attempt++) {
    await paceBeforeCall();
    rateState.lastCallAt = Date.now();

    try {
      const apiPromise = client.messages.create(params);

      // withResponse() exposes the raw HTTP headers for pacing. Mock clients
      // in tests may return a plain promise — fall back gracefully.
      let message;
      if (typeof apiPromise.withResponse === 'function') {
        const { data, response } = await apiPromise.withResponse();
        message = data;
        updateRateState(response?.headers);
      } else {
        message = await apiPromise;
      }

      recordUsage(telemetry, message, params.model, label, attempt);
      return message;
    } catch (err) {
      lastErr = err;
      const status = err?.status;

      if (!isRetryable(status) || attempt === RETRY.maxAttempts) break;

      let delayMs = RETRY.baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
      if (status === 429) {
        // retry-after is in seconds; earlier retries will just fail again.
        const retryAfter = Number(readHeader(err.headers, 'retry-after'));
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
          delayMs = Math.max(delayMs, retryAfter * 1000);
        }
      }
      delayMs = Math.min(delayMs, RETRY.maxDelayMs);

      console.warn(
        `[anthropic] ${label}: attempt ${attempt}/${RETRY.maxAttempts} failed ` +
        `(${status ?? err.message}) — retrying in ${Math.round(delayMs / 1000)}s`
      );
      await sleep(delayMs);
    }
  }

  // Never propagate a raw 429/529 — wrap so the pipeline marks the paper
  // `failed` (and the user's quota is never decremented).
  const wrapped = new Error(
    `Model call "${label}" failed after retries: ${lastErr?.status ?? ''} ${lastErr?.message ?? 'unknown error'}`.trim()
  );
  wrapped.code = 'MODEL_CALL_FAILED';
  wrapped.status = lastErr?.status;
  wrapped.cause = lastErr;
  throw wrapped;
}
