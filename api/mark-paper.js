import { verifyToken } from './_auth.js';
import { MODELS } from './_config.js';
import { callClaude } from './_anthropic-client.js';
import { getGenerationDoc } from './_state.js';

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

  // Answers arrive as:
  //   - answers[]: per-part { questionNumber, part, text, photoURL } (new flow)
  //   - bulkAnswers / answerImage: legacy single-textarea / single-image flow
  // The memo is resolved SERVER-SIDE from generationId (preferred) so solutions
  // are never sent to the browser before marking. `paperJSON` is a legacy
  // fallback for old clients that still post the memo directly.
  const { generationId, paperJSON, answers, bulkAnswers, answerImage } = req.body || {};
  const hasStructured = Array.isArray(answers) && answers.length > 0;
  if (!hasStructured && !bulkAnswers && !answerImage) {
    res.status(400).json({ error: 'answers are required' }); return;
  }

  // Resolve the memo: by generationId (ownership-checked) or legacy paperJSON.
  let memo = null;
  if (generationId) {
    const doc = await getGenerationDoc(generationId);
    if (!doc || !doc.memo) { res.status(404).json({ error: 'Generation not found' }); return; }
    if (doc.uid && doc.uid !== uid) { res.status(403).json({ error: 'Not your paper' }); return; }
    memo = doc.memo;
  } else if (paperJSON) {
    memo = paperJSON;
  }
  if (!memo) { res.status(400).json({ error: 'generationId or paperJSON is required' }); return; }

  try {
    const markingJSON = await markAnswers(memo, { answers, bulkAnswers, answerImage });
    // The student has now submitted — returning the memo for review is allowed.
    res.status(200).json({ markingJSON, memo });
  } catch (err) {
    console.error('Marking error:', err);
    res.status(500).json({ error: 'Marking failed. Please try again.' });
  }
}

async function markAnswers(memo, { answers, bulkAnswers, answerImage }) {
  const systemPrompt = `You are an IEB Grade 12 marking expert. Mark student answers strictly but fairly, following IEB marking guidelines. Award method marks where working is correct even if the final answer is wrong. Be specific in feedback — reference the actual error made. Some answers are supplied as photographs of handwritten working — read them carefully and mark the working shown.`;

  // Assemble the typed answers and collect any per-part working photos as image
  // blocks so the marker can read handwritten working.
  const imageBlocks = [];
  let typedAnswers = '';

  if (Array.isArray(answers) && answers.length) {
    const lines = [];
    for (const a of answers) {
      const tag = `Q${a.questionNumber}(${a.part})`;
      if (a.text && a.text.trim()) lines.push(`${tag}: ${a.text.trim()}`);
      if (a.photoURL) {
        imageBlocks.push({ type: 'text', text: `Photo of working for ${tag}:` });
        imageBlocks.push({ type: 'image', source: { type: 'url', url: a.photoURL } });
        if (!a.text || !a.text.trim()) lines.push(`${tag}: (see attached photo of working)`);
      }
    }
    typedAnswers = lines.join('\n');
  } else if (bulkAnswers) {
    typedAnswers = bulkAnswers;
  } else {
    typedAnswers = '(see attached image — read the student\'s handwritten or typed answers from it)';
  }

  const instruction = `Mark these student answers for the following IEB ${memo.subject} ${memo.paper} paper.

PAPER MEMORANDUM (questions, solutions and marking criteria):
${JSON.stringify(memo, null, 2)}

STUDENT ANSWERS:
${typedAnswers}

Return ONLY valid JSON (no markdown):
{
  "questionMarking": [
    {
      "questionNumber": <number>,
      "part": "<letter>",
      "marksAwarded": <number>,
      "marksAvailable": <number>,
      "feedback": "<specific feedback on what was correct/incorrect>",
      "methodMarksBreakdown": [
        {"criterion": "<criterion text>", "awarded": <true|false>}
      ]
    }
  ],
  "totalAwarded": <number>,
  "totalAvailable": <number>,
  "percentage": <integer 0-100>,
  "generalFeedback": "<2-3 sentence overall feedback>",
  "weakTopics": ["<topic>"],
  "strongTopics": ["<topic>"]
}`;

  let userContent;
  if (answerImage) {
    // Legacy single-image flow (base64).
    userContent = [
      { type: 'image', source: { type: 'base64', media_type: answerImage.mediaType, data: answerImage.data } },
      { type: 'text', text: instruction },
    ];
  } else if (imageBlocks.length) {
    userContent = [{ type: 'text', text: instruction }, ...imageBlocks];
  } else {
    userContent = instruction;
  }

  const response = await callClaude({
    model: MODELS.marking,
    max_tokens: 8000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }]
  }, null, { label: 'mark-paper' });

  const raw = response.content.find(b => b.type === 'text')?.text?.trim() || '';
  return JSON.parse(extractJSON(raw));
}

function extractJSON(text) {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1) return text.slice(start, end + 1);
  return text;
}
