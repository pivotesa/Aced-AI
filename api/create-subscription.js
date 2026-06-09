import crypto from 'crypto';
import { verifyToken, getUserDoc } from './_auth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  let uid;
  try {
    const decoded = await verifyToken(req);
    uid = decoded.uid;
  } catch {
    res.status(401).json({ error: 'Unauthorised' }); return;
  }

  const userDoc = await getUserDoc(uid);
  if (!userDoc) { res.status(404).json({ error: 'User not found' }); return; }

  const merchantId  = process.env.PAYFAST_MERCHANT_ID;
  const merchantKey = process.env.PAYFAST_MERCHANT_KEY;
  const passphrase  = process.env.PAYFAST_PASSPHRASE;
  const baseUrl     = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : (process.env.URL || 'https://your-site.vercel.app');

  const params = {
    merchant_id:      merchantId,
    merchant_key:     merchantKey,
    return_url:       `${baseUrl}/settings?upgrade=success`,
    cancel_url:       `${baseUrl}/settings`,
    notify_url:       `${baseUrl}/api/subscription-webhook`,
    name_first:       userDoc.name?.split(' ')[0] || '',
    name_last:        userDoc.name?.split(' ').slice(1).join(' ') || '',
    email_address:    userDoc.email,
    m_payment_id:     uid,
    amount:           '79.00',
    item_name:        'Aced AI Pro Monthly',
    subscription_type: '1',
    billing_date:     new Date().toISOString().split('T')[0],
    recurring_amount: '79.00',
    frequency:        '3',
    cycles:           '0',
    custom_str1:      uid
  };

  const paramString = Object.entries(params)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v)).replace(/%20/g, '+')}`)
    .join('&');

  const withPassphrase = passphrase ? `${paramString}&passphrase=${encodeURIComponent(passphrase)}` : paramString;
  params.signature = crypto.createHash('md5').update(withPassphrase).digest('hex');

  const payfastUrl = `https://www.payfast.co.za/eng/process?${Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;

  res.status(200).json({ payfastUrl });
}
