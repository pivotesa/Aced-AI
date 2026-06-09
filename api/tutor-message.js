import Anthropic from '@anthropic-ai/sdk';
import admin from 'firebase-admin';

function initAdmin() {
  if (admin.apps.length) return;
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  initAdmin();

  let uid;
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const decoded = await admin.auth().verifyIdToken(token);
    uid = decoded.uid;
  } catch {
    res.status(401).json({ error: 'Unauthorised' }); return;
  }

  const snap = await admin.firestore().collection('users').doc(uid).get();
  const userDoc = snap.exists ? snap.data() : null;
  const { messages, paperJSON, subject } = req.body || {};

  if (userDoc?.tier === 'free' && messages.filter(m => m.role === 'user').length > 10) {
    res.status(403).json({ error: 'Free tutor message limit reached', code: 'LIMIT_REACHED' }); return;
  }

  const paperContext = paperJSON
    ? `\n\nCURRENT PRACTICE PAPER: ${paperJSON.subject} ${paperJSON.paper} (${paperJSON.totalMarks} marks)\nTopics: ${paperJSON.questions?.map(q => `Q${q.questionNumber}: ${q.topic}`).join(', ')}`
    : '';

  const system = `You are an expert IEB Grade 12 exam tutor specialising in ${subject || 'all subjects'}.${paperContext}\n\nGuide students to the answer — do not give it directly. Show full working when explaining methods. Keep responses concise and exam-focused. Maximum 4 paragraphs.`;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system,
      messages: messages.slice(-10).map(m => ({ role: m.role, content: m.content }))
    });
    res.status(200).json({ reply: response.content[0].text.trim() });
  } catch (err) {
    console.error('Tutor error:', err);
    res.status(500).json({ error: 'Tutor unavailable. Please try again.' });
  }
}
