/**
 * Telemetry — logs per-paper generation metadata to Firestore.
 * Never logs full paper content (cost/size concern).
 *
 * Firestore collection: paperTelemetry/{sessionId}
 */

import { initAdmin } from './_auth.js';

/**
 * @param {string|null} sessionId  - Firestore session doc ID (may be null for pre-save calls)
 * @param {object}      data       - telemetry payload (see fields below)
 *
 * data shape:
 * {
 *   uid, subject, paper, mode,
 *   generationModel, correctionModel,
 *   tokensIn, tokensOut,           // totals across all calls
 *   repairIterations,              // how many repair calls were made
 *   validatorFailures,             // array of failure reason strings
 *   bankFallbacksUsed,             // number of question-bank substitutions
 *   durationMs,                    // wall-clock time from first call to response
 *   success,                       // boolean
 * }
 */
export async function logTelemetry(sessionId, data) {
  try {
    initAdmin();
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore();

    const docId = sessionId || `anon_${Date.now()}`;
    await db.collection('paperTelemetry').doc(docId).set({
      ...data,
      recordedAt: new Date().toISOString(),
    }, { merge: true });
  } catch (err) {
    // Telemetry must never crash the generation pipeline
    console.error('[telemetry] write failed:', err.message);
  }
}
