import Anthropic from '@anthropic-ai/sdk';
import { verifyToken, getUserDoc, jsonResponse, initAdmin } from './_auth.js';
import admin from 'firebase-admin';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL  = 'claude-sonnet-4-6';

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' } };
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  let uid;
  try {
    const decoded = await verifyToken(event);
    uid = decoded.uid;
  } catch {
    return jsonResponse(401, { error: 'Unauthorised' });
  }

  const userDoc = await getUserDoc(uid);
  if (!userDoc) return jsonResponse(404, { error: 'User not found' });

  if (userDoc.tier === 'free' && (userDoc.papersGenerated || 0) >= 5) {
    return jsonResponse(403, { error: 'Free paper limit reached', code: 'LIMIT_REACHED' });
  }

  const { subject, paper, mode, topic } = JSON.parse(event.body || '{}');
  if (!subject || !paper) return jsonResponse(400, { error: 'subject and paper are required' });

  const paperJSON = await generateWithRetry(subject, paper, mode, topic, 2);
  if (!paperJSON) return jsonResponse(500, { error: 'Paper generation failed after retries. Please try again.' });

  return jsonResponse(200, { paperJSON });
};

async function generateWithRetry(subject, paper, mode, topic, retriesLeft) {
  try {
    const draft = await generateDraft(subject, paper, mode, topic);
    const verified = await verifyDraft(draft);
    if (verified.valid) return draft;
    if (retriesLeft <= 0) return draft; // Return best effort
    console.log('Verification failed, regenerating:', verified.issues);
    return generateWithRetry(subject, paper, mode, topic, retriesLeft - 1);
  } catch (err) {
    if (retriesLeft <= 0) throw err;
    return generateWithRetry(subject, paper, mode, topic, retriesLeft - 1);
  }
}

async function generateDraft(subject, paper, mode, topic) {
  const topicInstruction = mode === 'topic' && topic
    ? `Focus ONLY on the topic: "${topic}". Generate 3–5 targeted questions on this topic.`
    : 'Generate a FULL exam paper covering ALL required IEB topics for this paper.';

  const systemPrompt = buildSystemPrompt(subject, paper);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: systemPrompt,
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
      "context": "<optional shared context for the question>",
      "parts": [
        {
          "part": "<letter a/b/c...>",
          "instruction": "<question instruction text>",
          "expression": "<mathematical expression or null>",
          "marks": <number>,
          "solution": {
            "steps": ["Step 1: ...", "Step 2: ..."],
            "answer": "<final answer>",
            "methodMarks": [
              {"mark": 1, "criterion": "<what earns this mark>"}
            ]
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
  const json = extractJSON(raw);
  return JSON.parse(json);
}

async function verifyDraft(paperJSON) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: `Verify this IEB exam paper JSON for correctness. Check:
1. totalMarks equals the sum of all questionTotal values
2. Each questionTotal equals the sum of its parts' marks
3. No question references a diagram or image not defined in the question text
4. For simultaneous equation questions involving circles, verify the discriminant produces rational solutions
5. Question numbering is sequential starting at 1

Paper JSON:
${JSON.stringify(paperJSON)}

Respond with ONLY valid JSON:
{"valid": true}
OR
{"valid": false, "issues": ["issue 1", "issue 2"]}`
    }]
  });

  const raw = response.content[0].text.trim();
  return JSON.parse(extractJSON(raw));
}

function buildSystemPrompt(subject, paper) {
  const rules = SUBJECT_RULES[subject]?.[paper] || '';
  return `You are an expert IEB (Independent Examinations Board) Grade 12 exam paper creator.

CRITICAL RULES:
- Return ONLY valid JSON. No markdown. No explanation. No code blocks.
- All mark allocations must follow IEB standards exactly.
- All mathematics must be correct and verifiable.
- Questions must be self-contained — no references to diagrams unless the diagram is fully described in text.
- Solutions must show full working step by step.
- Method marks must match IEB marking guidelines.
${rules}`;
}

const SUBJECT_RULES = {
  'Mathematics': {
    'Paper 1': `
MATHEMATICS PAPER 1 RULES:
- Factorisation questions: minimum 3 marks each
- Log equations: must include domain check (adds 1 mark)
- Quadratic formula use: award method mark even if arithmetic error
- Nature of roots: must include both discriminant calculation AND conclusion
- Financial mathematics: minimum 4 marks per question
- Probability: include at minimum one question on complementary events
- Total marks: 150, Duration: 3 hours
- Required topics: Algebra and equations, Patterns and sequences, Functions and graphs, Logarithms, Financial mathematics, Probability`,
    'Paper 2': `
MATHEMATICS PAPER 2 RULES:
- Statistics: must include scatter plot interpretation or regression line question
- Analytical geometry: include distance, gradient, midpoint and equation of line/circle
- Trigonometry: include both 2D and 3D problems
- Euclidean geometry: include formal proof question (minimum 1)
- Total marks: 150, Duration: 3 hours`
  },
  'Physical Sciences': {
    'Physics': 'Total marks: 150, Duration: 3 hours. Include Newton\'s laws, momentum, electricity, and waves.',
    'Chemistry': 'Total marks: 150, Duration: 3 hours. Include organic chemistry, equilibrium, acids/bases, electrochemistry.'
  },
  'English Home Language': {
    'Paper 1: Language': 'Total marks: 70, Duration: 2 hours. Include unseen comprehension, summary, and language questions.',
    'Paper 2: Literature': 'Total marks: 80, Duration: 2.5 hours.',
    'Paper 3: Writing': 'Total marks: 100, Duration: 2.5 hours. Include essay and transactional writing tasks.'
  },
  'Life Sciences': {
    'Paper 1': 'Total marks: 150, Duration: 2.5 hours.',
    'Paper 2': 'Total marks: 150, Duration: 2.5 hours.'
  },
  'Accounting': {
    'Paper 1': 'Total marks: 300, Duration: 3 hours. Include financial statements, analysis and interpretation.'
  }
};

function extractJSON(text) {
  // Strip markdown code fences if present
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  // Find first { to last }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1) return text.slice(start, end + 1);
  return text;
}
