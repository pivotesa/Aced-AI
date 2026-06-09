import crypto from 'crypto';
import { initAdmin } from './_auth.js';
import admin from 'firebase-admin';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  // PayFast sends URL-encoded body — need raw string
  let body = '';
  if (typeof req.body === 'string') {
    body = req.body;
  } else if (req.body && typeof req.body === 'object') {
    body = new URLSearchParams(req.body).toString();
  }

  const params = new URLSearchParams(body);
  const data = Object.fromEntries(params.entries());

  if (!verifyPayfastSignature(data)) {
    console.error('Invalid PayFast signature');
    res.status(400).json({ error: 'Invalid signature' }); return;
  }

  if (data.payment_status !== 'COMPLETE') {
    res.status(200).json({ received: true }); return;
  }

  const uid = data.custom_str1 || data.m_payment_id;
  if (!uid) { res.status(400).json({ error: 'Missing user ID' }); return; }

  try {
    initAdmin();
    await admin.firestore().collection('users').doc(uid).update({
      tier: 'pro',
      payfastSubscriptionId: data.token || data.pf_payment_id || '',
      upgradedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log(`Upgraded user ${uid} to Pro`);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Firestore update failed:', err);
    try {
      initAdmin();
      await admin.firestore().collection('webhookErrors').add({
        uid, data, error: err.message,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch {}
    res.status(500).json({ error: 'Database update failed' });
  }
}

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
