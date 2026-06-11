import { verifyToken, getUserDoc } from './_auth.js';
import { MODELS } from './_config.js';
import { callClaude } from './_anthropic-client.js';

const FREE_MSG_LIMIT = 10;

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
  const { messages, paperJSON, subject, paper } = req.body || {};

  if (userDoc?.tier === 'free' && messages.filter(m => m.role === 'user').length > FREE_MSG_LIMIT) {
    res.status(403).json({ error: 'Free tutor message limit reached', code: 'LIMIT_REACHED' }); return;
  }

  const systemPrompt = buildTutorSystem(subject, paper, paperJSON);
  const apiMessages = messages.slice(-10).map(m => ({ role: m.role, content: m.content }));

  try {
    const response = await callClaude({
      model: MODELS.tutor,
      max_tokens: 600,
      system: systemPrompt,
      messages: apiMessages
    }, null, { label: 'tutor' });

    const reply = response.content[0].text.trim();
    res.status(200).json({ reply });
  } catch (err) {
    console.error('Tutor error:', err);
    res.status(500).json({ error: 'Tutor unavailable. Please try again.' });
  }
}

function buildTutorSystem(subject, paper, paperJSON) {
  let paperContext = '';
  if (paperJSON) {
    const topics = paperJSON.questions?.map(q => `Q${q.questionNumber}: ${q.topic}`).join(', ') || '';
    paperContext = `\n\nCURRENT PRACTICE PAPER: ${paperJSON.subject} ${paperJSON.paper} (${paperJSON.totalMarks} marks)\nTopics covered: ${topics}`;
  }

  return `You are an expert IEB Grade 12 exam tutor specialising in ${subject || 'all subjects'}.${paperContext}

Your approach:
- Guide students to the answer — do not give it directly. Ask leading questions.
- Show full working when explaining a method, referencing IEB instruction words (calculate, determine, describe, explain, discuss).
- Keep responses concise and exam-focused. Align to IEB curriculum and examiner expectations.
- If the student asks about a specific question from their practice paper, reference it directly.
- Use simple, clear language. ALWAYS format mathematics as LaTeX wrapped in dollar delimiters so it renders: inline as $x^2$, $\\frac{a}{b}$, $\\sqrt{x}$; display equations as $$...$$. Never write bare ^ or _ outside dollars.
- Maximum response length: 4 paragraphs or a clear step-by-step list.`;
}
