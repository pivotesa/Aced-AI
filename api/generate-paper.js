/**
 * POST /api/generate-paper — HTTP entrypoint for the generation pipeline.
 *
 * The pipeline itself lives in _pipeline.js (testable, dependency-injected).
 * This handler owns: auth, quota gating, Firestore state transitions
 * (generating → validating → repairing → quality_check → complete | failed),
 * and telemetry.
 *
 * QUOTA SAFETY: papersGenerated is incremented client-side ONLY after a 200
 * response (public/js/app.js). This handler never increments it, and a failed
 * generation returns 5xx + a `failed` paperGenerations doc — so failed papers
 * never count against the free-tier limit.
 */

import { verifyToken, getUserDoc, initAdmin } from './_auth.js';
import { MODELS, SUBJECT_RULES } from './_config.js';
import { generateValidatedPaper } from './_pipeline.js';
import { estimateCostUSD, estimateBaselineCostUSD } from './_anthropic-client.js';
import { createGenerationState, updateGenerationState } from './_state.js';
import { logTelemetry } from './_telemetry.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')   { res.status(405).json({ error: 'Method not allowed' }); return; }

  initAdmin();

  let uid;
  try {
    const decoded = await verifyToken(req);
    uid = decoded.uid;
  } catch {
    res.status(401).json({ error: 'Unauthorised' }); return;
  }

  const userDoc = await getUserDoc(uid);
  if (!userDoc) { res.status(404).json({ error: 'User not found' }); return; }

  // Free tier limit temporarily disabled
  // if (userDoc.tier === 'free' && (userDoc.papersGenerated || 0) >= 5) {
  //   res.status(403).json({ error: 'Free paper limit reached', code: 'LIMIT_REACHED' }); return;
  // }

  const { subject, paper, mode, topic } = req.body || {};
  if (!subject || !paper)      { res.status(400).json({ error: 'subject and paper are required' }); return; }
  if (!(SUBJECT_RULES[subject]?.[paper])) {
    res.status(400).json({ error: `Unknown subject/paper combination: ${subject} / ${paper}` }); return;
  }

  const startMs = Date.now();
  const telemetry = {
    uid, subject, paper, mode: mode || 'full',
    generationModel: MODELS.generation,
    correctionModel: MODELS.correction,
    tokensIn: 0, tokensOut: 0,
    cacheCreationTokens: 0, cacheReadTokens: 0,
    calls: [],
    repairIterations: 0, validatorFailures: [], bankFallbacksUsed: 0,
    success: false,
  };

  const generationId = await createGenerationState(uid, { subject, paper, mode });

  try {
    const { paper: studentPaper, memo, verification_report } = await generateValidatedPaper({
      subject, paper, mode, topic, telemetry,
      deps: { onStatus: (status) => updateGenerationState(generationId, status) },
    });

    telemetry.success = true;
    telemetry.durationMs = Date.now() - startMs;
    telemetry.costEstimateUSD = round6(estimateCostUSD(telemetry, MODELS.generation));
    telemetry.baselineSonnetCostUSD = round6(estimateBaselineCostUSD(telemetry));

    // Persist the memo SERVER-SIDE only. It is never sent to the browser at
    // generation time — the marking endpoint loads it by generationId after the
    // student submits, so solutions cannot be read from the network response.
    await updateGenerationState(generationId, 'complete', {
      durationMs: telemetry.durationMs,
      verificationReport: verification_report,
      memo,
    });
    // Fire-and-forget — don't await, don't fail the request on error
    logTelemetry(generationId, telemetry).catch(() => {});

    // Return ONLY the student paper (solutions stripped) + the generation id.
    res.status(200).json({ paper: studentPaper, generationId, verificationReport: verification_report });

  } catch (err) {
    console.error('Generate error:', err.message);
    telemetry.durationMs = Date.now() - startMs;
    telemetry.costEstimateUSD = round6(estimateCostUSD(telemetry, MODELS.generation));
    telemetry.error = err.code || err.message;

    // Mark failed in Firestore — the frontend does NOT increment the user's
    // quota on a failed response, so this attempt is free for the user.
    await updateGenerationState(generationId, 'failed', { error: err.code || err.message });
    logTelemetry(generationId, telemetry).catch(() => {});

    res.status(500).json({ error: 'Paper generation failed. Please try again — this attempt does not count against your quota.', generationId });
  }
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}
