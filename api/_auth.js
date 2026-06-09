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
  const ref = admin.firestore().collection('users').doc(uid);
  const snap = await ref.get();
  if (snap.exists) return snap.data();

  // Create a default doc for users who authenticated but have no Firestore record
  const defaultDoc = { tier: 'free', papersGenerated: 0, createdAt: admin.firestore.FieldValue.serverTimestamp() };
  await ref.set(defaultDoc);
  return defaultDoc;
}
