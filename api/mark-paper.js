import { verifyToken } from './_auth.js';
import { MODELS } from './_config.js';
import { callClaude } from './_anthropic-client.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    await verifyToken(req);
  } catch {
    res.status(401).json({ error: 'Unauthorised' }); return;
  }

  const { paperJSON, bulkAnswers, answerImage } = req.body || {};
  if (!paperJSON || (!bulkAnswers && !answerImage)) {
    res.status(400).json({ error: 'paperJSON and answers are required' }); return;
  }

  try {
    const markingJSON = await markAnswers(paperJSON, bulkAnswers, answerImage);
    res.status(200).json({ markingJSON });
  } catch (err) {
    console.error('Marking error:', err);
    res.status(500).json({ error: 'Marking failed. Please try again.' });
  }
}

async function markAnswers(paperJSON, bulkAnswers, answerImage) {
  const systemPrompt = `You are an IEB Grade 12 marking expert. Mark student answers strictly but fairly, following IEB marking guidelines. Award method marks where working is correct even if the final answer is wrong. Be specific in feedback — reference the actual error made.`;

  const instruction = `Mark these student answers for the following IEB ${paperJSON.subject} ${paperJSON.paper} paper.

PAPER (with solutions and marking criteria):
${JSON.stringify(paperJSON, null, 2)}

${bulkAnswers
  ? `STUDENT ANSWERS:\n${bulkAnswers}`
  : `STUDENT ANSWERS: (see attached image — read the student's handwritten or typed answers from it)`}

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

  const userContent = answerImage
    ? [
        { type: 'image', source: { type: 'base64', media_type: answerImage.mediaType, data: answerImage.data } },
        { type: 'text', text: instruction }
      ]
    : instruction;

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
