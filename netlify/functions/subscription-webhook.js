import crypto from 'crypto';
import { initAdmin, jsonResponse } from './_auth.js';
import admin from 'firebase-admin';

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  const params = new URLSearchParams(event.body);
  const data = Object.fromEntries(params.entries());

  // Verify PayFast signature
  if (!verifyPayfastSignature(data)) {
    console.error('Invalid PayFast signature');
    return jsonResponse(400, { error: 'Invalid signature' });
  }

  // Only process successful subscription payments
  if (data.payment_status !== 'COMPLETE') {
    return jsonResponse(200, { received: true });
  }

  const uid = data.custom_str1 || data.m_payment_id;
  if (!uid) return jsonResponse(400, { error: 'Missing user ID' });

  try {
    initAdmin();
    await admin.firestore().collection('users').doc(uid).update({
      tier: 'pro',
      payfastSubscriptionId: data.token || data.pf_payment_id || '',
      upgradedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log(`Upgraded user ${uid} to Pro`);
    return jsonResponse(200, { success: true });
  } catch (err) {
    console.error('Firestore update failed:', err);
    // Log to webhookErrors collection for manual recovery
    try {
      await admin.firestore().collection('webhookErrors').add({
        uid, data, error: err.message,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch {}
    return jsonResponse(500, { error: 'Database update failed' });
  }
};

function verifyPayfastSignature(data) {
  const passphrase = process.env.PAYFAST_PASSPHRASE;
  const { signature, ...rest } = data;

  const paramString = Object.entries(rest)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v)).replace(/%20/g, '+')}`)
    .join('&');

  const withPassphrase = passphrase ? `${paramString}&passphrase=${encodeURIComponent(passphrase)}` : paramString;
  const computed = crypto.createHash('md5').update(withPassphrase).digest('hex');
  return computed === signature;
}
