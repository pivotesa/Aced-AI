import Anthropic from '@anthropic-ai/sdk';
import { verifyToken, getUserDoc, initAdmin } from './_auth.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-6';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  initAdmin();

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
    const draft = await generateDraft(subject, paper, mode, topic);
    const fixed = fixMarkTotals(draft);
    const paperJSON = await correctSolutions(fixed);
    res.status(200).json({ paperJSON });
  } catch (err) {
    console.error('Generate error:', err.message);
    res.status(500).json({ error: 'Paper generation failed. Please try again.' });
  }
}

async function generateDraft(subject, paper, mode, topic) {
  const topicInstruction = mode === 'topic' && topic
    ? `Focus ONLY on the topic: "${topic}". Generate exactly 3 targeted questions on this topic, each with 2-3 parts.`
    : 'Generate a practice paper with exactly 5 questions covering the key IEB topics for this paper. Each question should have 2-4 parts. Keep solutions concise — one line per step.';

  const rules = SUBJECT_RULES[subject]?.[paper] || '';
  const system = `You are an expert IEB Grade 12 exam paper creator.\n\nCRITICAL RULES:\n- Return ONLY valid JSON. No markdown. No explanation. No code blocks.\n- All mark allocations must follow IEB standards exactly.\n- All mathematics must be correct and verifiable.\n- Questions must be self-contained.\n- Solutions must show full working step by step.\n${rules}`;

  const response = await client.messages.create({
    model: MODEL, max_tokens: 6000, system,
    messages: [{ role: 'user', content: `Generate an IEB Grade 12 ${subject} ${paper} practice paper. ${topicInstruction}\n\nReturn ONLY valid JSON:\n{"subject":"${subject}","paper":"${paper}","grade":12,"totalMarks":<number>,"duration":"<e.g. 3 hours>","questions":[{"questionNumber":<number>,"topic":"<topic>","context":"<context or null>","parts":[{"part":"<a/b/c>","instruction":"<text>","expression":"<math or null>","marks":<number>,"solution":{"steps":["Step 1:..."],"answer":"<answer>","methodMarks":[{"mark":1,"criterion":"<criterion>"}]}}],"questionTotal":<number>}]}` }]
  });

  const raw = response.content[0].text.trim();
  return JSON.parse(extractJSON(raw));
}


// Option 1: pure arithmetic — recompute all mark totals from parts
function fixMarkTotals(paperJSON) {
  const questions = paperJSON.questions.map(q => {
    const questionTotal = q.parts.reduce((sum, p) => sum + (p.marks || 0), 0);
    return { ...q, questionTotal };
  });
  const totalMarks = questions.reduce((sum, q) => sum + q.questionTotal, 0);
  return { ...paperJSON, questions, totalMarks };
}

// Option 2: lightweight Claude call — check & fix solution working only (no solutions regenerated, just flagged errors corrected)
async function correctSolutions(paperJSON) {
  // Build a compact representation: question + parts with marks + answers only (no steps)
  const compact = paperJSON.questions.map(q => ({
    questionNumber: q.questionNumber,
    topic: q.topic,
    parts: q.parts.map(p => ({
      part: p.part,
      instruction: p.instruction,
      expression: p.expression || null,
      marks: p.marks,
      answer: p.solution?.answer
    }))
  }));

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: `You are checking an IEB Grade 12 ${paperJSON.subject} exam paper for mathematical errors.\n\nFor each question part below, verify the answer is correct. If an answer is wrong, provide the correct answer. Return ONLY valid JSON — same structure as input but with corrected answers where needed.\n\n${JSON.stringify(compact)}`
    }]
  });

  const raw = response.content[0].text.trim();
  let corrected;
  try {
    corrected = JSON.parse(extractJSON(raw));
  } catch {
    return paperJSON; // if the correction call fails, use original
  }

  // Merge corrected answers back into the full paperJSON (preserving steps/methodMarks)
  const questions = paperJSON.questions.map(q => {
    const cq = corrected.find(c => c.questionNumber === q.questionNumber);
    if (!cq) return q;
    const parts = q.parts.map(p => {
      const cp = cq.parts?.find(c => c.part === p.part);
      if (!cp || cp.answer === p.solution?.answer) return p;
      return { ...p, solution: { ...p.solution, answer: cp.answer } };
    });
    return { ...q, parts };
  });

  return { ...paperJSON, questions };
}

const SUBJECT_RULES = {
  'Mathematics': {
    'Paper 1': 'Total marks: 150, Duration: 3 hours. Required topics: Algebra, Sequences, Functions, Logarithms, Financial mathematics, Probability.',
    'Paper 2': 'Total marks: 150, Duration: 3 hours. Required topics: Statistics, Analytical geometry, Trigonometry, Euclidean geometry.'
  },
  'Physical Sciences': {
    'Physics': 'Total marks: 150, Duration: 3 hours. Include Newton\'s laws, momentum, electricity, and waves.',
    'Chemistry': 'Total marks: 150, Duration: 3 hours. Include organic chemistry, equilibrium, acids/bases, electrochemistry.'
  },
  'English Home Language': {
    'Paper 1: Language': 'Total marks: 70, Duration: 2 hours.',
    'Paper 2: Literature': 'Total marks: 80, Duration: 2.5 hours.',
    'Paper 3: Writing': 'Total marks: 100, Duration: 2.5 hours.'
  },
  'Life Sciences': {
    'Paper 1': 'Total marks: 150, Duration: 2.5 hours.',
    'Paper 2': 'Total marks: 150, Duration: 2.5 hours.'
  },
  'Accounting': {
    'Paper 1': 'Total marks: 300, Duration: 3 hours.'
  }
};

function extractJSON(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1) return text.slice(start, end + 1);
  return text;
}
