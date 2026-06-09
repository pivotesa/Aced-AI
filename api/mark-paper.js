import Anthropic from '@anthropic-ai/sdk';
import { verifyToken } from './_auth.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-6';

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

  const { paperJSON, answers } = req.body || {};
  if (!paperJSON || !answers) { res.status(400).json({ error: 'paperJSON and answers are required' }); return; }

  try {
    const markingJSON = await markAnswers(paperJSON, answers);
    res.status(200).json({ markingJSON });
  } catch (err) {
    console.error('Marking error:', err);
    res.status(500).json({ error: 'Marking failed. Please try again.' });
  }
}

async function markAnswers(paperJSON, answers) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 6000,
    system: `You are an IEB Grade 12 marking expert. Mark student answers strictly but fairly, following IEB marking guidelines. Award method marks where working is correct even if the final answer is wrong. Be specific in feedback — reference the actual error made.`,
    messages: [{
      role: 'user',
      content: `Mark these student answers for the following IEB ${paperJSON.subject} ${paperJSON.paper} paper.

PAPER (with solutions and marking criteria):
${JSON.stringify(paperJSON, null, 2)}

STUDENT ANSWERS (keyed by questionNumber_part, e.g. "q1_a"):
${JSON.stringify(answers, null, 2)}

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
}`
    }]
  });

  const raw = response.content[0].text.trim();
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
