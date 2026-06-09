import crypto from 'crypto';
import admin from 'firebase-admin';

function initAdmin() {
  if (admin.apps.length) return;
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

function verifyPayfastSignature(data) {
  const passphrase = process.env.PAYFAST_PASSPHRASE;
  const { signature, ...rest } = data;
  const paramString = Object.entries(rest).filter(([,v]) => v !== '')
    .map(([k,v]) => `${k}=${encodeURIComponent(String(v)).replace(/%20/g, '+')}`)
    .join('&');
  const withPassphrase = passphrase ? `${paramString}&passphrase=${encodeURIComponent(passphrase)}` : paramString;
  return crypto.createHash('md5').update(withPassphrase).digest('hex') === signature;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  initAdmin();
  const data = req.body;

  if (!verifyPayfastSignature(data)) {
    res.status(400).json({ error: 'Invalid signature' }); return;
  }

  if (data.payment_status !== 'COMPLETE') { res.status(200).json({ received: true }); return; }

  const uid = data.custom_str1 || data.m_payment_id;
  if (!uid) { res.status(400).json({ error: 'Missing user ID' }); return; }

  try {
    await admin.firestore().collection('users').doc(uid).update({
      tier: 'pro',
      payfastSubscriptionId: data.token || data.pf_payment_id || '',
      upgradedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Database update failed' });
  }
}
