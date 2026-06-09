import Anthropic from '@anthropic-ai/sdk';
import { verifyToken, getUserDoc, jsonResponse } from './_auth.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL  = 'claude-sonnet-4-6';
const FREE_MSG_LIMIT = 10;

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
  const { messages, paperJSON, subject, paper } = JSON.parse(event.body || '{}');

  // Free tier message cap (enforced server-side)
  if (userDoc?.tier === 'free' && messages.filter(m => m.role === 'user').length > FREE_MSG_LIMIT) {
    return jsonResponse(403, { error: 'Free tutor message limit reached', code: 'LIMIT_REACHED' });
  }

  const systemPrompt = buildTutorSystem(subject, paper, paperJSON);

  // Truncate paper context to keep tokens manageable
  const apiMessages = messages.slice(-10).map(m => ({ role: m.role, content: m.content }));

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 600,
      system: systemPrompt,
      messages: apiMessages
    });

    const reply = response.content[0].text.trim();
    return jsonResponse(200, { reply });
  } catch (err) {
    console.error('Tutor error:', err);
    return jsonResponse(500, { error: 'Tutor unavailable. Please try again.' });
  }
};

function buildTutorSystem(subject, paper, paperJSON) {
  let paperContext = '';
  if (paperJSON) {
    // Include a summary of the paper topics to keep context lean
    const topics = paperJSON.questions?.map(q => `Q${q.questionNumber}: ${q.topic}`).join(', ') || '';
    paperContext = `\n\nCURRENT PRACTICE PAPER: ${paperJSON.subject} ${paperJSON.paper} (${paperJSON.totalMarks} marks)\nTopics covered: ${topics}`;
  }

  return `You are an expert IEB Grade 12 exam tutor specialising in ${subject || 'all subjects'}.${paperContext}

Your approach:
- Guide students to the answer — do not give it directly. Ask leading questions.
- Show full working when explaining a method, referencing IEB instruction words (calculate, determine, describe, explain, discuss).
- Keep responses concise and exam-focused. Align to IEB curriculum and examiner expectations.
- If the student asks about a specific question from their practice paper, reference it directly.
- Use simple, clear language. Format maths clearly using plain text or LaTeX.
- Maximum response length: 4 paragraphs or a clear step-by-step list.`;
}
