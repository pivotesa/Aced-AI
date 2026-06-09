import { onRequest } from 'firebase-functions/v2/https';
import { setGlobalOptions } from 'firebase-functions/v2';
import admin from 'firebase-admin';
import Anthropic from '@anthropic-ai/sdk';
import crypto from 'crypto';

// ── INIT ──────────────────────────────────────────────────────
setGlobalOptions({ region: 'us-central1' });

// In Cloud Functions, Admin auto-uses the service account — no JSON needed
admin.initializeApp();

const db  = admin.firestore();
const auth = admin.auth();

// ── HELPERS ───────────────────────────────────────────────────
function cors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

function handleOptions(req, res) {
  if (req.method === 'OPTIONS') {
    cors(res);
    res.status(204).send('');
    return true;
  }
  return false;
}

async function verifyToken(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) throw new Error('Missing auth token');
  return auth.verifyIdToken(token);
}

async function getUserDoc(uid) {
  const snap = await db.collection('users').doc(uid).get();
  return snap.exists ? snap.data() : null;
}

function extractJSON(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start !== -1 && end !== -1) return text.slice(start, end + 1);
  return text;
}

const MODEL = 'claude-sonnet-4-6';

// ══════════════════════════════════════════════════════════════
//  GENERATE PAPER
// ══════════════════════════════════════════════════════════════
export const generatePaper = onRequest(async (req, res) => {
  cors(res);
  if (handleOptions(req, res)) return;
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

  if (userDoc.tier === 'free' && (userDoc.papersGenerated || 0) >= 5) {
    res.status(403).json({ error: 'Free paper limit reached', code: 'LIMIT_REACHED' }); return;
  }

  const { subject, paper, mode, topic } = req.body || {};
  if (!subject || !paper) { res.status(400).json({ error: 'subject and paper are required' }); return; }

  try {
    const paperJSON = await generateWithRetry(subject, paper, mode, topic, 2);
    res.status(200).json({ paperJSON });
  } catch (err) {
    console.error('Generate error:', err);
    res.status(500).json({ error: 'Paper generation failed. Please try again.' });
  }
});

async function generateWithRetry(subject, paper, mode, topic, retriesLeft) {
  try {
    const draft    = await generateDraft(subject, paper, mode, topic);
    const verified = await verifyDraft(draft);
    if (verified.valid) return draft;
    if (retriesLeft <= 0) return draft;
    console.log('Verification failed, retrying:', verified.issues);
    return generateWithRetry(subject, paper, mode, topic, retriesLeft - 1);
  } catch (err) {
    if (retriesLeft <= 0) throw err;
    return generateWithRetry(subject, paper, mode, topic, retriesLeft - 1);
  }
}

async function generateDraft(subject, paper, mode, topic) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const topicInstruction = mode === 'topic' && topic
    ? `Focus ONLY on the topic: "${topic}". Generate 3–5 targeted questions on this topic.`
    : 'Generate a FULL exam paper covering ALL required IEB topics for this paper.';

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: buildGenerateSystem(subject, paper),
    messages: [{
      role: 'user',
      content: `Generate an IEB Grade 12 ${subject} ${paper} practice paper. ${topicInstruction}

Return ONLY valid JSON matching this schema (no markdown, no explanation):
{
  "subject": "${subject}",
  "paper": "${paper}",
  "grade": 12,
  "totalMarks": <number>,
  "duration": "<e.g. 3 hours>",
  "questions": [
    {
      "questionNumber": <number>,
      "topic": "<IEB topic name>",
      "context": "<optional shared context or null>",
      "parts": [
        {
          "part": "<letter a/b/c...>",
          "instruction": "<question instruction text>",
          "expression": "<mathematical expression or null>",
          "marks": <number>,
          "solution": {
            "steps": ["Step 1: ...", "Step 2: ..."],
            "answer": "<final answer>",
            "methodMarks": [{ "mark": 1, "criterion": "<what earns this mark>" }]
          }
        }
      ],
      "questionTotal": <sum of part marks>
    }
  ]
}`
    }]
  });

  const raw = response.content[0].text.trim();
  return JSON.parse(extractJSON(raw));
}

async function verifyDraft(paperJSON) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: `Verify this IEB exam paper JSON:
1. totalMarks equals sum of all questionTotal values
2. Each questionTotal equals sum of its parts' marks
3. No question references a diagram not defined in text
4. Simultaneous equations involving circles have rational solutions
5. Question numbering is sequential from 1

Paper: ${JSON.stringify(paperJSON)}

Respond ONLY with JSON: {"valid": true} OR {"valid": false, "issues": ["..."]}`
    }]
  });
  return JSON.parse(extractJSON(response.content[0].text.trim()));
}

function buildGenerateSystem(subject, paper) {
  const rules = SUBJECT_RULES[subject]?.[paper] || '';
  return `You are an expert IEB Grade 12 exam paper creator.

CRITICAL RULES:
- Return ONLY valid JSON. No markdown. No explanation. No code blocks.
- All mark allocations must follow IEB standards exactly.
- All mathematics must be correct and verifiable.
- Questions must be self-contained — no references to diagrams unless fully described in text.
- Solutions must show full working step by step.
- Method marks must match IEB marking guidelines.
${rules}`;
}

const SUBJECT_RULES = {
  'Mathematics': {
    'Paper 1': `MATHEMATICS PAPER 1:
- Factorisation: minimum 3 marks each
- Log equations: must include domain check (+1 mark)
- Nature of roots: discriminant calculation AND conclusion required
- Financial mathematics: minimum 4 marks per question
- Total marks: 150, Duration: 3 hours
- Required topics: Algebra and equations, Patterns and sequences, Functions and graphs, Logarithms, Financial mathematics, Probability`,
    'Paper 2': `MATHEMATICS PAPER 2:
- Statistics: include regression line question
- Analytical geometry: distance, gradient, midpoint, equation of line/circle
- Trigonometry: include both 2D and 3D problems
- Euclidean geometry: include at least one formal proof
- Total marks: 150, Duration: 3 hours`
  },
  'Physical Sciences': {
    'Physics':    'Total marks: 150, Duration: 3 hours. Include Newton\'s laws, momentum, electricity, and waves.',
    'Chemistry':  'Total marks: 150, Duration: 3 hours. Include organic chemistry, equilibrium, acids/bases, electrochemistry.'
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

// ══════════════════════════════════════════════════════════════
//  MARK PAPER
// ══════════════════════════════════════════════════════════════
export const markPaper = onRequest(async (req, res) => {
  cors(res);
  if (handleOptions(req, res)) return;
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    await verifyToken(req);
  } catch {
    res.status(401).json({ error: 'Unauthorised' }); return;
  }

  const { paperJSON, answers } = req.body || {};
  if (!paperJSON || !answers) { res.status(400).json({ error: 'paperJSON and answers are required' }); return; }

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 6000,
      system: `You are an IEB Grade 12 marking expert. Mark student answers strictly but fairly, following IEB marking guidelines. Award method marks where working is correct even if the final answer is wrong. Be specific in feedback — reference the actual error made.`,
      messages: [{
        role: 'user',
        content: `Mark these student answers for IEB ${paperJSON.subject} ${paperJSON.paper}.

PAPER (with solutions and marking criteria):
${JSON.stringify(paperJSON, null, 2)}

STUDENT ANSWERS (keyed as "q1_a", "q1_b" etc):
${JSON.stringify(answers, null, 2)}

Return ONLY valid JSON (no markdown):
{
  "questionMarking": [
    {
      "questionNumber": <number>,
      "part": "<letter>",
      "marksAwarded": <number>,
      "marksAvailable": <number>,
      "feedback": "<specific feedback>",
      "methodMarksBreakdown": [{ "criterion": "<criterion>", "awarded": <true|false> }]
    }
  ],
  "totalAwarded": <number>,
  "totalAvailable": <number>,
  "percentage": <integer 0-100>,
  "generalFeedback": "<2-3 sentence summary>",
  "weakTopics": ["<topic>"],
  "strongTopics": ["<topic>"]
}`
      }]
    });

    const markingJSON = JSON.parse(extractJSON(response.content[0].text.trim()));
    res.status(200).json({ markingJSON });
  } catch (err) {
    console.error('Marking error:', err);
    res.status(500).json({ error: 'Marking failed. Please try again.' });
  }
});

// ══════════════════════════════════════════════════════════════
//  TUTOR MESSAGE
// ══════════════════════════════════════════════════════════════
const FREE_MSG_LIMIT = 10;

export const tutorMessage = onRequest(async (req, res) => {
  cors(res);
  if (handleOptions(req, res)) return;
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

  const paperContext = paperJSON
    ? `\n\nCURRENT PRACTICE PAPER: ${paperJSON.subject} ${paperJSON.paper} (${paperJSON.totalMarks} marks)\nTopics covered: ${paperJSON.questions?.map(q => `Q${q.questionNumber}: ${q.topic}`).join(', ') || ''}`
    : '';

  const systemPrompt = `You are an expert IEB Grade 12 exam tutor specialising in ${subject || 'all subjects'}.${paperContext}

Your approach:
- Guide students to the answer — do not give it directly. Ask leading questions.
- Show full working when explaining a method, referencing IEB instruction words (calculate, determine, describe, explain, discuss).
- Keep responses concise and exam-focused. Align to IEB curriculum and examiner expectations.
- Use simple, clear language. Format maths clearly using plain text or LaTeX.
- Maximum response length: 4 paragraphs or a clear step-by-step list.`;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 600,
      system: systemPrompt,
      messages: messages.slice(-10).map(m => ({ role: m.role, content: m.content }))
    });

    res.status(200).json({ reply: response.content[0].text.trim() });
  } catch (err) {
    console.error('Tutor error:', err);
    res.status(500).json({ error: 'Tutor unavailable. Please try again.' });
  }
});

// ══════════════════════════════════════════════════════════════
//  CREATE SUBSCRIPTION (PayFast)
// ══════════════════════════════════════════════════════════════
export const createSubscription = onRequest(async (req, res) => {
  cors(res);
  if (handleOptions(req, res)) return;
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
  const baseUrl     = process.env.APP_URL || 'https://claude-aced-ai.web.app';

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
    subscription_type:'1',
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
});

// ══════════════════════════════════════════════════════════════
//  SUBSCRIPTION WEBHOOK (PayFast → upgrade user to Pro)
// ══════════════════════════════════════════════════════════════
export const subscriptionWebhook = onRequest(async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const data = req.body;

  if (!verifyPayfastSignature(data)) {
    console.error('Invalid PayFast signature');
    res.status(400).json({ error: 'Invalid signature' }); return;
  }

  if (data.payment_status !== 'COMPLETE') {
    res.status(200).json({ received: true }); return;
  }

  const uid = data.custom_str1 || data.m_payment_id;
  if (!uid) { res.status(400).json({ error: 'Missing user ID' }); return; }

  try {
    await db.collection('users').doc(uid).update({
      tier: 'pro',
      payfastSubscriptionId: data.token || data.pf_payment_id || '',
      upgradedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log(`Upgraded user ${uid} to Pro`);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Firestore update failed:', err);
    try {
      await db.collection('webhookErrors').add({
        uid, data, error: err.message,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch {}
    res.status(500).json({ error: 'Database update failed' });
  }
});

function verifyPayfastSignature(data) {
  const passphrase = process.env.PAYFAST_PASSPHRASE;
  const { signature, ...rest } = data;
  const paramString = Object.entries(rest)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v)).replace(/%20/g, '+')}`)
    .join('&');
  const withPassphrase = passphrase ? `${paramString}&passphrase=${encodeURIComponent(passphrase)}` : paramString;
  const computed = crypto.createHash('md5').update(withPassphrase).digest('hex');
  return computed === signature;
}
