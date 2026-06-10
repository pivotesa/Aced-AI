/**
 * Paper-generation state persistence — Firestore collection `paperGenerations`.
 *
 * Status flow: generating → validating → repairing → quality_check → complete | failed
 * (repairing / quality_check are skipped when not needed.)
 *
 * The frontend can subscribe to paperGenerations/{id} to show real progress,
 * and a `failed` document is the audit trail proving the user's free-paper
 * quota was never decremented for that attempt (quota increments happen only
 * after a successful response — see public/js/app.js).
 *
 * State writes must never crash the pipeline — all errors are swallowed.
 */

import { initAdmin } from './_auth.js';

async function db() {
  initAdmin();
  const { getFirestore } = await import('firebase-admin/firestore');
  return getFirestore();
}

export async function createGenerationState(uid, { subject, paper, mode }) {
  const id = `gen_${uid}_${Date.now()}`;
  try {
    await (await db()).collection('paperGenerations').doc(id).set({
      uid, subject, paper, mode: mode || 'full',
      status: 'generating',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[state] create failed:', err.message);
  }
  return id;
}

export async function updateGenerationState(id, status, extra = {}) {
  if (!id) return;
  try {
    await (await db()).collection('paperGenerations').doc(id).set({
      status,
      updatedAt: new Date().toISOString(),
      ...extra,
    }, { merge: true });
  } catch (err) {
    console.error('[state] update failed:', err.message);
  }
}
