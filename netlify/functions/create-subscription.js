import crypto from 'crypto';
import { verifyToken, getUserDoc, jsonResponse } from './_auth.js';

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' } };
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  let uid, decoded;
  try {
    decoded = await verifyToken(event);
    uid = decoded.uid;
  } catch {
    return jsonResponse(401, { error: 'Unauthorised' });
  }

  const userDoc = await getUserDoc(uid);
  if (!userDoc) return jsonResponse(404, { error: 'User not found' });

  const merchantId  = process.env.PAYFAST_MERCHANT_ID;
  const merchantKey = process.env.PAYFAST_MERCHANT_KEY;
  const passphrase  = process.env.PAYFAST_PASSPHRASE;
  const baseUrl     = process.env.URL || 'https://your-site.netlify.app';

  const params = {
    merchant_id:    merchantId,
    merchant_key:   merchantKey,
    return_url:     `${baseUrl}/settings?upgrade=success`,
    cancel_url:     `${baseUrl}/settings`,
    notify_url:     `${baseUrl}/api/subscription-webhook`,
    name_first:     userDoc.name?.split(' ')[0] || '',
    name_last:      userDoc.name?.split(' ').slice(1).join(' ') || '',
    email_address:  userDoc.email,
    m_payment_id:   uid,
    amount:         '79.00',
    item_name:      'Aced AI Pro Monthly',
    subscription_type: '1',
    billing_date:   new Date().toISOString().split('T')[0],
    recurring_amount: '79.00',
    frequency:      '3', // Monthly
    cycles:         '0', // Indefinite
    custom_str1:    uid
  };

  // Generate PayFast signature
  const paramString = Object.entries(params)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v)).replace(/%20/g, '+')}`)
    .join('&');

  const withPassphrase = passphrase ? `${paramString}&passphrase=${encodeURIComponent(passphrase)}` : paramString;
  params.signature = crypto.createHash('md5').update(withPassphrase).digest('hex');

  const payfastUrl = `https://www.payfast.co.za/eng/process?${Object.entries(params).map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;

  return jsonResponse(200, { payfastUrl });
};
