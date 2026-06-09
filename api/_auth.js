import admin from 'firebase-admin';

let initialised = false;

export function initAdmin() {
  if (initialised) return;
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  initialised = true;
}

export async function verifyToken(req) {
  const authHeader = req.headers?.authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) throw new Error('Missing auth token');
  initAdmin();
  const decoded = await admin.auth().verifyIdToken(token);
  return decoded;
}

export async function getUserDoc(uid) {
  initAdmin();
  const snap = await admin.firestore().collection('users').doc(uid).get();
  return snap.exists() ? snap.data() : null;
}
