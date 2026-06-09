import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signInWithPopup, GoogleAuthProvider, signOut } from 'https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc, updateDoc, collection, addDoc, query, where, orderBy, limit, getDocs, increment, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: "AIzaSyD7Hypls5qhMheQxA487igODehlA345k64",
  authDomain: "claude-aced-ai.firebaseapp.com",
  projectId: "claude-aced-ai",
  storageBucket: "claude-aced-ai.firebasestorage.app",
  messagingSenderId: "1026322215445",
  appId: "1:1026322215445:web:705e87bf4103a365c6541c"
};

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);
const googleProvider = new GoogleAuthProvider();

// ── AUTH ────────────────────────────────────────────────────
export async function signInEmail(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

export async function signUpEmail(email, password, name) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  await createUserDoc(cred.user.uid, { email, name });
  return cred;
}

export async function signInGoogle() {
  const cred = await signInWithPopup(auth, googleProvider);
  const userSnap = await getDoc(doc(db, 'users', cred.user.uid));
  if (!userSnap.exists()) {
    await createUserDoc(cred.user.uid, {
      email: cred.user.email,
      name: cred.user.displayName || ''
    });
  }
  return cred;
}

export function signOutUser() {
  return signOut(auth);
}

export function onAuth(callback) {
  return onAuthStateChanged(auth, callback);
}

export async function getIdToken() {
  const user = auth.currentUser;
  if (!user) throw new Error('Not authenticated');
  return user.getIdToken();
}

// ── USER DOCS ───────────────────────────────────────────────
async function createUserDoc(uid, { email, name }) {
  await setDoc(doc(db, 'users', uid), {
    email,
    name: name || '',
    tier: 'free',
    papersGenerated: 0,
    createdAt: serverTimestamp()
  });
}

export async function getUserDoc(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? snap.data() : null;
}

export async function incrementPapersGenerated(uid) {
  await updateDoc(doc(db, 'users', uid), { papersGenerated: increment(1) });
}

export async function setUserPro(uid, subscriptionId) {
  await updateDoc(doc(db, 'users', uid), {
    tier: 'pro',
    payfastSubscriptionId: subscriptionId
  });
}

// ── SESSIONS ────────────────────────────────────────────────
export async function saveSession(uid, sessionData) {
  const ref = await addDoc(collection(db, 'sessions'), {
    uid,
    ...sessionData,
    generatedAt: serverTimestamp()
  });
  return ref.id;
}

export async function updateSession(sessionId, updates) {
  await updateDoc(doc(db, 'sessions', sessionId), updates);
}

export async function getRecentSessions(uid, limitCount = 6) {
  const q = query(
    collection(db, 'sessions'),
    where('uid', '==', uid),
    orderBy('generatedAt', 'desc'),
    limit(limitCount)
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function getSession(sessionId) {
  const snap = await getDoc(doc(db, 'sessions', sessionId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

// ── TOPIC PERFORMANCE ───────────────────────────────────────
export async function updateTopicPerformance(uid, subject, weakTopics, strongTopics, allTopicScores) {
  for (const [topic, score] of Object.entries(allTopicScores)) {
    const ref = doc(db, 'topicPerformance', `${uid}_${subject}_${topic.replace(/\s+/g, '_')}`);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const data = snap.data();
      await updateDoc(ref, {
        totalAttempts: data.totalAttempts + 1,
        averageScore: Math.round((data.averageScore * data.totalAttempts + score) / (data.totalAttempts + 1)),
        lastAttempted: serverTimestamp()
      });
    } else {
      await setDoc(ref, {
        uid, subject, topicName: topic,
        totalAttempts: 1,
        averageScore: score,
        lastAttempted: serverTimestamp()
      });
    }
  }
}

export async function getTopicPerformance(uid) {
  const q = query(
    collection(db, 'topicPerformance'),
    where('uid', '==', uid),
    orderBy('averageScore', 'asc')
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => d.data());
}

// ── TUTOR MESSAGES ──────────────────────────────────────────
export async function saveTutorMessage(sessionId, message) {
  await updateDoc(doc(db, 'sessions', sessionId), {
    tutorMessages: message
  });
}

export { auth, db };
