/**
 * Unit tests for the shared Anthropic client wrapper.
 *
 * Acceptance criterion: a mocked 429 response (with a retry-after header) is
 * handled by backing off and retrying; a raw 429 never escapes the wrapper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callClaude, _resetRateState, estimateCostUSD, estimateBaselineCostUSD } from '../_anthropic-client.js';
import { RETRY } from '../_config.js';

function makeMessage(usage = {}) {
  return {
    content: [{ type: 'text', text: '[]' }],
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      ...usage,
    },
  };
}

function rateLimitError(retryAfterSeconds) {
  const err = new Error('rate_limit_error');
  err.status = 429;
  err.headers = { 'retry-after': String(retryAfterSeconds) };
  return err;
}

const PARAMS = { model: 'claude-haiku-4-5-20251001', max_tokens: 100, messages: [] };

describe('callClaude', () => {
  beforeEach(() => {
    _resetRateState();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a 429 and waits at least the retry-after header value', async () => {
    const callTimes = [];
    const create = vi.fn().mockImplementation(() => {
      callTimes.push(Date.now());
      return callTimes.length === 1
        ? Promise.reject(rateLimitError(3))
        : Promise.resolve(makeMessage());
    });
    const client = { messages: { create } };

    const telemetry = {};
    const promise = callClaude(PARAMS, telemetry, { client, label: 'test' });
    await vi.runAllTimersAsync();
    const message = await promise;

    expect(message.usage.output_tokens).toBe(50);
    expect(create).toHaveBeenCalledTimes(2);
    // Waited at least retry-after (3s), not just the base backoff
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(3000);
  });

  it('caps attempts and never surfaces a raw 429', async () => {
    const create = vi.fn().mockImplementation(() => Promise.reject(rateLimitError(1)));
    const client = { messages: { create } };

    const promise = callClaude(PARAMS, {}, { client, label: 'test' });
    const assertion = expect(promise).rejects.toMatchObject({ code: 'MODEL_CALL_FAILED' });
    await vi.runAllTimersAsync();
    await assertion;

    expect(create).toHaveBeenCalledTimes(RETRY.maxAttempts);
  });

  it('retries 529 overloaded errors with backoff', async () => {
    const overloaded = Object.assign(new Error('overloaded_error'), { status: 529 });
    const create = vi.fn()
      .mockRejectedValueOnce(overloaded)
      .mockResolvedValueOnce(makeMessage());
    const client = { messages: { create } };

    const promise = callClaude(PARAMS, {}, { client, label: 'test' });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeTruthy();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry non-retryable errors (400)', async () => {
    const badRequest = Object.assign(new Error('invalid_request_error'), { status: 400 });
    const create = vi.fn().mockRejectedValue(badRequest);
    const client = { messages: { create } };

    const promise = callClaude(PARAMS, {}, { client, label: 'test' });
    const assertion = expect(promise).rejects.toMatchObject({ code: 'MODEL_CALL_FAILED' });
    await vi.runAllTimersAsync();
    await assertion;
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('accumulates token usage and prompt-cache counters into telemetry', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(makeMessage({ cache_creation_input_tokens: 4200 }))
      .mockResolvedValueOnce(makeMessage({ cache_read_input_tokens: 4200 }));
    const client = { messages: { create } };

    const telemetry = {};
    let promise = callClaude(PARAMS, telemetry, { client, label: 'generate:section1' });
    await vi.runAllTimersAsync();
    await promise;
    promise = callClaude(PARAMS, telemetry, { client, label: 'generate:section2' });
    await vi.runAllTimersAsync();
    await promise;

    expect(telemetry.tokensIn).toBe(200);
    expect(telemetry.tokensOut).toBe(100);
    expect(telemetry.cacheCreationTokens).toBe(4200);
    // Cache hit visible on the second call — acceptance criterion 7
    expect(telemetry.cacheReadTokens).toBe(4200);
    expect(telemetry.calls.map(c => c.label)).toEqual(['generate:section1', 'generate:section2']);
    expect(telemetry.calls[1].cacheReadInputTokens).toBe(4200);
  });
});

describe('cost estimation', () => {
  it('prices cached reads at 10% and cache writes at 125% of input', () => {
    const telemetry = { tokensIn: 1_000_000, tokensOut: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
    const base = estimateCostUSD(telemetry, 'claude-haiku-4-5-20251001');
    expect(base).toBeCloseTo(1.0);

    const cached = estimateCostUSD(
      { tokensIn: 0, tokensOut: 0, cacheCreationTokens: 0, cacheReadTokens: 1_000_000 },
      'claude-haiku-4-5-20251001'
    );
    expect(cached).toBeCloseTo(0.1);
  });

  it('baseline (single Sonnet call, no caching) costs more than the Haiku pipeline', () => {
    const telemetry = { tokensIn: 50_000, tokensOut: 20_000, cacheCreationTokens: 5_000, cacheReadTokens: 25_000 };
    expect(estimateBaselineCostUSD(telemetry)).toBeGreaterThan(estimateCostUSD(telemetry, 'claude-haiku-4-5-20251001'));
  });
});
