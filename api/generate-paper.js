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
  const rules = SUBJECT_RULES[subject]?.[paper] || {};
  const duration = rules.duration || '3 hours';

  if (mode === 'topic' && topic) {
    const questions = await generateBatch(subject, paper, [`Focus ONLY on the topic: "${topic}". Generate 3 questions on this topic.`], 1, rules);
    const totalMarks = questions.reduce((s, q) => s + q.questionTotal, 0);
    return { subject, paper, grade: 12, totalMarks, duration, questions };
  }

  // Full paper: 3 parallel batches of 2 questions each (6 questions total, ~25 marks each)
  const batches = rules.topicGroups || [
    'Generate questions 1–2 on the first third of topics for this paper.',
    'Generate questions 3–4 on the middle third of topics for this paper.',
    'Generate questions 5–6 on the final third of topics for this paper.'
  ];

  const [b1, b2, b3] = await Promise.all([
    generateBatch(subject, paper, batches[0], 1, rules),
    generateBatch(subject, paper, batches[1], 3, rules),
    generateBatch(subject, paper, batches[2], 5, rules),
  ]);

  const questions = [...b1, ...b2, ...b3].map((q, i) => ({ ...q, questionNumber: i + 1 }));
  const totalMarks = questions.reduce((s, q) => s + q.questionTotal, 0);
  return { subject, paper, grade: 12, totalMarks, duration, questions };
}

async function generateBatch(subject, paper, topicInstruction, startQuestion, rules) {
  const ruleText = rules.marks ? `Target approximately ${Math.round(rules.marks / 3)} marks for this batch.` : '';
  const system = `You are an expert IEB Grade 12 exam paper creator.\n\nCRITICAL RULES:\n- Return ONLY a valid JSON array of questions. No markdown, no wrapper object, no explanation.\n- Questions must be numbered starting from ${startQuestion}.\n- Each question must have 3-5 parts.\n- Solutions must show concise working — one line per step.\n- All mathematics must be correct.\n${ruleText}`;

  const response = await client.messages.create({
    model: MODEL, max_tokens: 3500, system,
    messages: [{ role: 'user', content: `Generate exactly 2 IEB Grade 12 ${subject} ${paper} questions. ${topicInstruction}\n\nReturn ONLY a valid JSON array:\n[{"questionNumber":${startQuestion},"topic":"<topic>","context":null,"parts":[{"part":"a","instruction":"<text>","expression":null,"marks":<number>,"solution":{"steps":["Step 1: ..."],"answer":"<answer>","methodMarks":[{"mark":1,"criterion":"<criterion>"}]}}],"questionTotal":<number>}]` }]
  });

  const raw = response.content[0].text.trim();
  const parsed = JSON.parse(extractJSONArray(raw));
  return Array.isArray(parsed) ? parsed : parsed.questions || [];
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
    'Paper 1': {
      marks: 150, duration: '3 hours',
      topicGroups: [
        'Generate questions 1–2 on Algebra and Sequences (number patterns, arithmetic & geometric series).',
        'Generate questions 3–4 on Functions and Logarithms (hyperbola, parabola, exponential, log equations).',
        'Generate questions 5–6 on Financial Mathematics and Probability (compound interest, annuities, counting principles).'
      ]
    },
    'Paper 2': {
      marks: 150, duration: '3 hours',
      topicGroups: [
        'Generate questions 1–2 on Statistics (regression, standard deviation, ogives, box-and-whisker).',
        'Generate questions 3–4 on Analytical Geometry and Trigonometry (circles, lines, trig equations, compound angles).',
        'Generate questions 5–6 on Euclidean Geometry (circle theorems, proofs, similarity and congruence).'
      ]
    }
  },
  'Physical Sciences': {
    'Physics': {
      marks: 150, duration: '3 hours',
      topicGroups: [
        "Generate questions 1–2 on Newton's laws and momentum (impulse, conservation of momentum).",
        'Generate questions 3–4 on Electricity (Ohm\'s law, circuits, power, internal resistance).',
        'Generate questions 5–6 on Waves, Sound and Light (Doppler effect, electromagnetic spectrum, photoelectric effect).'
      ]
    },
    'Chemistry': {
      marks: 150, duration: '3 hours',
      topicGroups: [
        'Generate questions 1–2 on Organic Chemistry (naming, reactions, polymers).',
        'Generate questions 3–4 on Chemical Equilibrium and Acids & Bases (Le Chatelier, pH, titrations).',
        'Generate questions 5–6 on Electrochemistry (galvanic cells, electrolytic cells, standard electrode potentials).'
      ]
    }
  },
  'English Home Language': {
    'Paper 1: Language': { marks: 70, duration: '2 hours',
      topicGroups: [
        'Generate questions 1–2 on comprehension and language use (reading a passage, answering questions).',
        'Generate questions 3–4 on summary writing skills.',
        'Generate questions 5–6 on language structures and conventions (grammar, vocabulary).'
      ]
    },
    'Paper 2: Literature': { marks: 80, duration: '2.5 hours',
      topicGroups: [
        'Generate questions 1–2 on poetry analysis (imagery, tone, structure).',
        'Generate questions 3–4 on drama (character, theme, dramatic devices).',
        'Generate questions 5–6 on prose (novel/short story — plot, character, context).'
      ]
    },
    'Paper 3: Writing': { marks: 100, duration: '2.5 hours',
      topicGroups: [
        'Generate questions 1–2 on transactional writing (formal letter, report, speech).',
        'Generate questions 3–4 on essay writing (discursive or argumentative).',
        'Generate questions 5–6 on creative writing (narrative or descriptive).'
      ]
    }
  },
  'Life Sciences': {
    'Paper 1': {
      marks: 150, duration: '2.5 hours',
      topicGroups: [
        'Generate questions 1–2 on Meiosis and Genetics (Mendelian inheritance, monohybrid crosses).',
        'Generate questions 3–4 on DNA, RNA and Protein Synthesis (transcription, translation, mutations).',
        'Generate questions 5–6 on Evolution (natural selection, evidence, speciation).'
      ]
    },
    'Paper 2': {
      marks: 150, duration: '2.5 hours',
      topicGroups: [
        'Generate questions 1–2 on the Human Nervous System and Sense Organs.',
        'Generate questions 3–4 on Homeostasis (thermoregulation, osmoregulation, blood glucose).',
        'Generate questions 5–6 on Human Reproduction and Responding to the Environment.'
      ]
    }
  },
  'Accounting': {
    'Paper 1': {
      marks: 300, duration: '3 hours',
      topicGroups: [
        'Generate questions 1–2 on Financial Statements (income statement, balance sheet, notes).',
        'Generate questions 3–4 on Reconciliations and Internal Control (bank rec, debtors/creditors).',
        'Generate questions 5–6 on Analysis and Interpretation of Financial Statements (ratios, cash flow).'
      ]
    }
  }
};

function extractJSON(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1) return text.slice(start, end + 1);
  return text;
}

function extractJSONArray(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  // Try array first
  const arrStart = text.indexOf('['), arrEnd = text.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd !== -1) return text.slice(arrStart, arrEnd + 1);
  // Fall back to object
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1) return text.slice(start, end + 1);
  return text;
}
