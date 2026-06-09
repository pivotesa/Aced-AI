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

const MODEL = 'claude-haiku-4-5';

const SUBJECT_RULES = {
  'Mathematics': {
    'Paper 1': `MATHEMATICS PAPER 1:\n- Factorisation: minimum 3 marks each\n- Log equations: must include domain check (+1 mark)\n- Nature of roots: discriminant calculation AND conclusion required\n- Financial mathematics: minimum 4 marks per question\n- Total marks: 150, Duration: 3 hours\n- Required topics: Algebra and equations, Patterns and sequences, Functions and graphs, Logarithms, Financial mathematics, Probability`,
    'Paper 2': `MATHEMATICS PAPER 2:\n- Statistics: include regression line question\n- Analytical geometry: distance, gradient, midpoint, equation of line/circle\n- Trigonometry: include both 2D and 3D problems\n- Euclidean geometry: include at least one formal proof\n- Total marks: 150, Duration: 3 hours`
  },
  'Physical Sciences': {
    'Physics':   "Total marks: 150, Duration: 3 hours. Include Newton's laws, momentum, electricity, and waves.",
    'Chemistry': 'Total marks: 150, Duration: 3 hours. Include organic chemistry, equilibrium, acids/bases, electrochemistry.'
  },
  'English Home Language': {
    'Paper 1: Language':  'Total marks: 70, Duration: 2 hours. Include unseen comprehension, summary, and language questions.',
    'Paper 2: Literature':'Total marks: 80, Duration: 2.5 hours.',
    'Paper 3: Writing':   'Total marks: 100, Duration: 2.5 hours. Include essay and transactional writing tasks.'
  },
  'Life Sciences': {
    'Paper 1': 'Total marks: 150, Duration: 2.5 hours.',
    'Paper 2': 'Total marks: 150, Duration: 2.5 hours.'
  },
  'Accounting': {
    'Paper 1': 'Total marks: 300, Duration: 3 hours. Include financial statements, analysis and interpretation.'
  }
};

async function generateDraft(subject, paper, mode, topic) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const topicInstruction = mode === 'topic' && topic
    ? `Focus ONLY on the topic: "${topic}". Generate 3–5 targeted questions on this topic.`
    : 'Generate a FULL exam paper covering ALL required IEB topics for this paper.';

  const rules = SUBJECT_RULES[subject]?.[paper] || '';
  const system = `You are an expert IEB Grade 12 exam paper creator.\n\nCRITICAL RULES:\n- Return ONLY valid JSON. No markdown. No explanation. No code blocks.\n- All mark allocations must follow IEB standards exactly.\n- All mathematics must be correct and verifiable.\n- Questions must be self-contained — no references to diagrams unless fully described in text.\n- Solutions must show full working step by step.\n- Method marks must match IEB marking guidelines.\n${rules}`;

  const response = await client.messages.create({
    model: MODEL, max_tokens: 5000, system,
    messages: [{ role: 'user', content: `Generate an IEB Grade 12 ${subject} ${paper} practice paper. ${topicInstruction}\n\nReturn ONLY valid JSON:\n{"subject":"${subject}","paper":"${paper}","grade":12,"totalMarks":<number>,"duration":"<e.g. 3 hours>","questions":[{"questionNumber":<number>,"topic":"<topic>","context":"<context or null>","parts":[{"part":"<a/b/c>","instruction":"<text>","expression":"<math or null>","marks":<number>,"solution":{"steps":["Step 1:..."],"answer":"<answer>","methodMarks":[{"mark":1,"criterion":"<criterion>"}]}}],"questionTotal":<number>}]}` }]
  });
  return JSON.parse(extractJSON(response.content[0].text.trim()));
}

async function verifyDraft(paperJSON) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: MODEL, max_tokens: 500,
    messages: [{ role: 'user', content: `Verify this IEB exam paper JSON:\n1. totalMarks equals sum of all questionTotal values\n2. Each questionTotal equals sum of its parts' marks\n3. No question references a diagram not defined in text\n4. Question numbering sequential from 1\n\nPaper: ${JSON.stringify(paperJSON)}\n\nRespond ONLY: {"valid":true} OR {"valid":false,"issues":["..."]}` }]
  });
  return JSON.parse(extractJSON(response.content[0].text.trim()));
}

async function generateWithRetry(subject, paper, mode, topic, retriesLeft) {
  try {
    return await generateDraft(subject, paper, mode, topic);
  } catch (err) {
    if (retriesLeft <= 0) throw err;
    return generateWithRetry(subject, paper, mode, topic, retriesLeft - 1);
  }
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
  if (!userDoc) { res.status(404).json({ error: 'User not found' }); return; }

  if (userDoc.tier === 'free' && (userDoc.papersGenerated || 0) >= 5) {
    res.status(403).json({ error: 'Free paper limit reached', code: 'LIMIT_REACHED' }); return;
  }

  const { subject, paper, mode, topic } = req.body || {};
  if (!subject || !paper) { res.status(400).json({ error: 'subject and paper are required' }); return; }

  try {
    const paperJSON = await generateWithRetry(subject, paper, mode, topic, 2);
    console.log('paperJSON type:', typeof paperJSON, 'keys:', paperJSON ? Object.keys(paperJSON) : 'null');
    if (!paperJSON) {
      res.status(500).json({ error: 'Paper generation returned empty result.' }); return;
    }
    res.status(200).json({ paperJSON });
  } catch (err) {
    console.error('Generate error:', err.message, err.stack);
    res.status(500).json({ error: 'Paper generation failed. Please try again.' });
  }
}
