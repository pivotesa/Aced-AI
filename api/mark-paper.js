import Anthropic from '@anthropic-ai/sdk';
import admin from 'firebase-admin';

function initAdmin() {
  if (admin.apps.length) return;
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

function extractJSON(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1) return text.slice(start, end + 1);
  return text;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  initAdmin();

  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    await admin.auth().verifyIdToken(token);
  } catch {
    res.status(401).json({ error: 'Unauthorised' }); return;
  }

  const { paperJSON, answers } = req.body || {};
  if (!paperJSON || !answers) { res.status(400).json({ error: 'paperJSON and answers are required' }); return; }

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 6000,
      system: `You are an IEB Grade 12 marking expert. Mark student answers strictly but fairly, following IEB marking guidelines. Award method marks where working is correct even if the final answer is wrong. Be specific in feedback.`,
      messages: [{ role: 'user', content: `Mark these student answers for IEB ${paperJSON.subject} ${paperJSON.paper}.\n\nPAPER:\n${JSON.stringify(paperJSON, null, 2)}\n\nSTUDENT ANSWERS:\n${JSON.stringify(answers, null, 2)}\n\nReturn ONLY valid JSON:\n{"questionMarking":[{"questionNumber":<n>,"part":"<letter>","marksAwarded":<n>,"marksAvailable":<n>,"feedback":"<feedback>","methodMarksBreakdown":[{"criterion":"<text>","awarded":<bool>}]}],"totalAwarded":<n>,"totalAvailable":<n>,"percentage":<0-100>,"generalFeedback":"<2-3 sentences>","weakTopics":["<topic>"],"strongTopics":["<topic>"]}` }]
    });
    const markingJSON = JSON.parse(extractJSON(response.content[0].text.trim()));
    res.status(200).json({ markingJSON });
  } catch (err) {
    console.error('Marking error:', err);
    res.status(500).json({ error: 'Marking failed. Please try again.' });
  }
}
