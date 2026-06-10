/**
 * Paper-generation pipeline — cheap-generator / verifier architecture.
 *
 * Pass 1 (generation): Haiku generates the paper SECTION BY SECTION, STRICTLY
 *   SEQUENTIALLY. Never fire section calls in parallel — the org is on a
 *   10,000 output-tokens/min tier and parallel calls trigger 429s. Pacing
 *   between calls lives in the shared client wrapper (_anthropic-client.js).
 *
 * Deterministic validation layer (_validators.js): zero API cost.
 *
 * Pass 2 (repair): targeted per-question regeneration — never whole-paper.
 *   Max MAX_REPAIR_ATTEMPTS per question, then question-bank fallback.
 *   The full deterministic layer re-runs after repairs.
 *
 * Quality pass: for papers without deterministic answer checks (English HL),
 *   one rubric-based Haiku review per paper; flagged questions get one
 *   regeneration attempt.
 *
 * All calls share one cached system block per subject+paper (prompt caching —
 * see _prompts.js), so the 2nd call onward reads the prefix at 10% input cost.
 *
 * Dependencies are injectable for integration tests with a mocked API.
 */

import { MODELS, MAX_TOKENS, MAX_REPAIR_ATTEMPTS, SUBJECT_RULES, repairModelForAttempt } from './_config.js';
import { runVerification, appendFix } from './_verification.js';
import { callClaude } from './_anthropic-client.js';
import { getQuestion } from './_question-bank.js';
import {
  buildSystemBlocks, estimateTokens,
  buildGenerationUserMessage, buildTopicUserMessage,
  buildRepairUserMessage, buildCorrectionUserMessage, buildQualityUserMessage,
} from './_prompts.js';

const noop = async () => {};

/**
 * Generate, validate and repair a full paper.
 *
 * @returns {Promise<{paperJSON, finalValidation, quality, verification_report}>}
 */
export async function generateValidatedPaper({ subject, paper, mode, topic, telemetry, deps = {} }) {
  const {
    callModel = callClaude,
    getBankQuestion = getQuestion,
    onStatus = noop,
  } = deps;

  const rules = SUBJECT_RULES[subject][paper];
  const targetMarks = (mode !== 'topic' && rules.marks) ? rules.marks : null;
  const system = buildSystemBlocks(subject, paper);
  const fixes = []; // accumulated across repair passes, attached to the final report

  // claude-haiku-4-5 silently skips caching below a 4096-token prefix.
  if (estimateTokens(system) < 4200) {
    console.warn(`[pipeline] static system block for ${subject}/${paper} may be under the 4096-token cache floor — check cache_read_input_tokens in telemetry`);
  }

  // ── Pass 1: sequential generation ─────────────────────────────────────────
  await onStatus('generating');
  let draft = await generateDraft({ subject, paper, mode, topic, rules, system, telemetry, callModel });

  // Deterministic normalisation (pure arithmetic, no API cost)
  draft = fixMarkTotals(draft);
  if (targetMarks) draft = normalizeMarks(draft, targetMarks);

  // ── Verification pass: universal validators then subject validators ───────
  await onStatus('validating');
  let verification = runVerification(draft, { subject, paper });
  telemetry.validatorFailures = verification.failures.map((f) => f.reason);

  // ── Repair: targeted per-question, Haiku then Sonnet escalation ──────────
  if (!verification.passed && mode !== 'topic') {
    await onStatus('repairing');
    draft = await repairDraft({ draft, verification, system, telemetry, callModel, getBankQuestion, subject, paper, fixes });
    draft = fixMarkTotals(draft);
    if (targetMarks) draft = normalizeMarks(draft, targetMarks);
    // Re-run the FULL verification layer (universal + subject) after repairs.
    verification = runVerification(draft, { subject, paper });
  }

  // ── Quality verification (non-deterministically-checkable subjects) ──────
  let quality = null;
  if (rules.qualityVerified && mode !== 'topic') {
    await onStatus('quality_check');
    quality = await runQualityPass({ draft, subject, paper, system, telemetry, callModel });
    if (quality && !quality.quality_pass && Array.isArray(quality.issues) && quality.issues.length) {
      draft = await repairFlaggedQuestions({ draft, issues: quality.issues, system, telemetry, callModel, fixes });
      draft = fixMarkTotals(draft);
      if (targetMarks) draft = normalizeMarks(draft, targetMarks);
      verification = runVerification(draft, { subject, paper });
    }
    telemetry.qualityPass = quality?.quality_pass ?? null;
  }

  // ── Final answer-correctness pass (quantitative subjects) ────────────────
  const paperJSON = rules.qualityVerified
    ? draft
    : await correctSolutions({ draft, subject, system, telemetry, callModel });

  // Attach the accumulated fixes to the final report.
  verification.report.fixes_applied = fixes;
  verification.report.final_passed = verification.passed;

  telemetry.finalValidationPassed = verification.passed;
  telemetry.finalValidationFailures = verification.failures.map((f) => f.reason);
  telemetry.verificationReportSummary = verification.report.summary;

  return { paperJSON, finalValidation: verification, quality, verification_report: verification.report };
}

// ── Pass 1: draft generation (STRICTLY SEQUENTIAL) ───────────────────────────

async function generateDraft({ subject, paper, mode, topic, rules, system, telemetry, callModel }) {
  const duration = rules.duration || '3 hours';

  if (mode === 'topic' && topic) {
    const questions = await generateSection({
      subject, paper, system, telemetry, callModel,
      userMessage: buildTopicUserMessage(subject, paper, topic),
      label: 'generate:topic',
    });
    const totalMarks = questions.reduce((s, q) => s + (q.questionTotal || 0), 0);
    return { subject, paper, grade: 12, totalMarks, duration, questions };
  }

  const sections = rules.topicGroups || [
    'Generate questions 1–2 on the first third of topics for this paper.',
    'Generate questions 3–4 on the middle third of topics for this paper.',
    'Generate questions 5–6 on the final third of topics for this paper.',
  ];
  const batchTarget = rules.marks ? Math.round(rules.marks / sections.length) : null;

  // Sequential on purpose — do NOT convert to Promise.all (429s on low tier).
  const questions = [];
  for (let i = 0; i < sections.length; i++) {
    const startQuestion = i * 2 + 1;
    const batch = await generateSection({
      subject, paper, system, telemetry, callModel,
      userMessage: buildGenerationUserMessage(subject, paper, sections[i], startQuestion, batchTarget),
      label: `generate:section${i + 1}`,
    });
    questions.push(...batch);
  }

  const renumbered = questions.map((q, i) => ({ ...q, questionNumber: i + 1 }));
  const totalMarks = renumbered.reduce((s, q) => s + (q.questionTotal || 0), 0);
  return { subject, paper, grade: 12, totalMarks, duration, questions: renumbered };
}

async function generateSection({ subject, paper, system, userMessage, telemetry, callModel, label }) {
  const response = await callModel({
    model: MODELS.generation,
    max_tokens: MAX_TOKENS.generation,
    system,
    messages: [{ role: 'user', content: userMessage }],
  }, telemetry, { label });

  const raw = response.content.find((b) => b.type === 'text')?.text?.trim() || '';
  const parsed = JSON.parse(extractJSONArray(raw));
  return Array.isArray(parsed) ? parsed : parsed.questions || [];
}

// ── Pass 2: targeted repair (sequential, per-question) ───────────────────────

async function repairDraft({ draft, verification, system, telemetry, callModel, getBankQuestion, subject, paper, fixes }) {
  const questions = [...draft.questions];
  const byQuestion = { ...verification.byQuestion };
  const failedNumbers = [...verification.failedQuestionNumbers];

  // Paper-level "required topic missing/not covered" failures aren't tied to a
  // question — assign each to a question to regenerate (prefer a duplicate-topic
  // question, else the last question), keeping repair per-question.
  for (const reason of (byQuestion.__paper__ || [])) {
    const m = reason.match(/topic "([^"]+)" is not covered|Required topic missing: "([^"]+)"/i);
    if (!m) continue;
    const missingTopic = m[1] || m[2];
    const seen = new Set();
    let target = questions[questions.length - 1];
    for (const q of questions) {
      const t = (q.topic || '').toLowerCase();
      if (seen.has(t)) { target = q; break; }
      seen.add(t);
    }
    if (!target) continue;
    const qn = target.questionNumber;
    if (!byQuestion[qn]) byQuestion[qn] = [];
    byQuestion[qn].push(`Replace this question with one on the topic "${missingTopic}" (compulsory for this paper), keeping the same question number and total marks.`);
    if (!failedNumbers.includes(qn)) failedNumbers.push(qn);
  }

  // Sequential — repair calls share the same OTPM budget as generation.
  for (const qNum of failedNumbers) {
    const reasons = byQuestion[qNum];
    const qIdx = questions.findIndex((q) => q.questionNumber === qNum);
    if (qIdx === -1 || !reasons?.length) continue;

    let repaired = null;
    let usedModel = null;
    for (let attempt = 0; attempt < MAX_REPAIR_ATTEMPTS; attempt++) {
      telemetry.repairIterations = (telemetry.repairIterations || 0) + 1;
      const model = repairModelForAttempt(attempt); // Haiku first, Sonnet on the last attempt
      try {
        repaired = await repairQuestion({ question: questions[qIdx], reasons, system, telemetry, callModel, model, label: `repair:Q${qNum}.${attempt + 1}` });
        usedModel = model;
        appendFix(verification.report, { questionNumber: qNum, action: 'regenerated', model, attempt: attempt + 1, reasons });
        if (fixes) fixes.push({ question: qNum, action: 'regenerated', model, attempt: attempt + 1, addressed: reasons });
        break;
      } catch (err) {
        console.warn(`Repair attempt ${attempt + 1} (${model}) failed for Q${qNum}:`, err.message);
      }
    }

    if (!repaired) {
      const bankQ = getBankQuestion(subject, paper, questions[qIdx].topic, questions[qIdx].questionTotal);
      if (bankQ) {
        bankQ.questionNumber = qNum;
        repaired = bankQ;
        telemetry.bankFallbacksUsed = (telemetry.bankFallbacksUsed || 0) + 1;
        if (fixes) fixes.push({ question: qNum, action: 'bank_fallback', model: null, addressed: reasons });
        console.log(`Q${qNum}: using question-bank fallback`);
      } else {
        console.warn(`Q${qNum}: no bank fallback available, keeping original`);
        repaired = questions[qIdx];
        if (fixes) fixes.push({ question: qNum, action: 'kept_original', model: null, addressed: reasons });
      }
    }

    questions[qIdx] = repaired;
  }

  return { ...draft, questions };
}

async function repairQuestion({ question, reasons, system, telemetry, callModel, model, label }) {
  const response = await callModel({
    model: model || MODELS.repair,
    max_tokens: MAX_TOKENS.repair,
    system, // same cached block — repair instructions live in the system prompt's REPAIR MODE section
    messages: [{ role: 'user', content: buildRepairUserMessage(question, reasons) }],
  }, telemetry, { label });

  const raw = response.content.find((b) => b.type === 'text')?.text?.trim() || '';
  return JSON.parse(extractJSON(raw));
}

// ── Quality verification pass (English HL etc.) ──────────────────────────────

async function runQualityPass({ draft, subject, paper, system, telemetry, callModel }) {
  const compact = draft.questions.map((q) => ({
    questionNumber: q.questionNumber,
    topic: q.topic,
    context: q.context,
    parts: (q.parts || []).map((p) => ({
      part: p.part, instruction: p.instruction, marks: p.marks, answer: p.solution?.answer,
    })),
  }));

  try {
    const response = await callModel({
      model: MODELS.verification,
      max_tokens: MAX_TOKENS.verification,
      system,
      messages: [{ role: 'user', content: buildQualityUserMessage(subject, paper, compact) }],
    }, telemetry, { label: 'quality' });

    const raw = response.content.find((b) => b.type === 'text')?.text?.trim() || '';
    const verdict = JSON.parse(extractJSON(raw));
    if (typeof verdict.quality_pass !== 'boolean') return null;
    return verdict;
  } catch (err) {
    console.warn('Quality pass failed (paper accepted without quality verdict):', err.message);
    return null;
  }
}

async function repairFlaggedQuestions({ draft, issues, system, telemetry, callModel, fixes }) {
  const questions = [...draft.questions];
  const byQ = {};
  for (const issue of issues) {
    if (issue?.questionNumber == null) continue;
    (byQ[issue.questionNumber] ||= []).push(String(issue.issue || 'quality issue'));
  }

  for (const [qNum, reasons] of Object.entries(byQ)) {
    const qIdx = questions.findIndex((q) => q.questionNumber === Number(qNum));
    if (qIdx === -1) continue;
    telemetry.repairIterations = (telemetry.repairIterations || 0) + 1;
    const model = MODELS.repair; // quality regeneration: one attempt on Haiku
    try {
      // One regeneration attempt per quality-flagged question.
      questions[qIdx] = await repairQuestion({
        question: questions[qIdx], reasons, system, telemetry, callModel, model,
        label: `quality-repair:Q${qNum}`,
      });
      if (fixes) fixes.push({ question: Number(qNum), action: 'quality_regenerated', model, attempt: 1, addressed: reasons });
    } catch (err) {
      console.warn(`Quality repair failed for Q${qNum}, keeping original:`, err.message);
      if (fixes) fixes.push({ question: Number(qNum), action: 'kept_original', model: null, addressed: reasons });
    }
  }

  return { ...draft, questions };
}

// ── Final answer-correctness pass ────────────────────────────────────────────

async function correctSolutions({ draft, subject, system, telemetry, callModel }) {
  const compact = draft.questions.map((q) => ({
    questionNumber: q.questionNumber,
    topic: q.topic,
    parts: (q.parts || []).map((p) => ({
      part: p.part, instruction: p.instruction, expression: p.expression || null,
      marks: p.marks, answer: p.solution?.answer,
    })),
  }));

  let corrected;
  try {
    const response = await callModel({
      model: MODELS.correction,
      max_tokens: MAX_TOKENS.correction,
      system,
      messages: [{ role: 'user', content: buildCorrectionUserMessage(subject, compact) }],
    }, telemetry, { label: 'correction' });

    const raw = response.content.find((b) => b.type === 'text')?.text?.trim() || '';
    corrected = JSON.parse(extractJSONArray(raw));
  } catch {
    return draft; // correction is best-effort — never fail the paper on it
  }
  if (!Array.isArray(corrected)) return draft;

  const questions = draft.questions.map((q) => {
    const cq = corrected.find((c) => c.questionNumber === q.questionNumber);
    if (!cq) return q;
    const parts = q.parts.map((p) => {
      const cp = cq.parts?.find((c) => c.part === p.part);
      if (!cp || cp.answer === p.solution?.answer) return p;
      return { ...p, solution: { ...p.solution, answer: cp.answer } };
    });
    return { ...q, parts };
  });

  return { ...draft, questions };
}

// ── Deterministic mark normalisation ─────────────────────────────────────────

export function fixMarkTotals(paperJSON) {
  const questions = paperJSON.questions.map((q) => {
    const questionTotal = q.parts.reduce((sum, p) => sum + (p.marks || 0), 0);
    return { ...q, questionTotal };
  });
  const totalMarks = questions.reduce((sum, q) => sum + q.questionTotal, 0);
  return { ...paperJSON, questions, totalMarks };
}

/**
 * Rebuilds a part's methodMarks so they sum exactly to part.marks.
 * Needed after mark scaling — otherwise every normalised part would fail the
 * method-mark validator and trigger pointless repair calls.
 */
export function rebalanceMethodMarks(part) {
  const target = part.marks || 0;
  let mm = Array.isArray(part.solution?.methodMarks) ? part.solution.methodMarks.map((m) => ({ ...m })) : [];
  if (target <= 0 || mm.length === 0) return part;

  const current = mm.reduce((s, m) => s + (m.mark || 0), 0);
  if (current === target) return part;

  if (current < target) {
    // Add the shortfall to the final (answer) criterion.
    mm[mm.length - 1].mark = (mm[mm.length - 1].mark || 0) + (target - current);
  } else {
    // Trim from the end until we fit, adjusting the boundary entry.
    let remaining = target;
    const trimmed = [];
    for (const m of mm) {
      if (remaining <= 0) break;
      const take = Math.min(m.mark || 0, remaining);
      if (take > 0) trimmed.push({ ...m, mark: take });
      remaining -= take;
    }
    mm = trimmed;
  }

  return { ...part, solution: { ...part.solution, methodMarks: mm } };
}

export function normalizeMarks(paperJSON, targetMarks) {
  const currentTotal = paperJSON.questions.reduce((s, q) => s + q.questionTotal, 0);
  if (currentTotal === targetMarks || currentTotal === 0) return paperJSON;

  let scaledTotal = 0;
  let questions = paperJSON.questions.map((q) => {
    const parts = q.parts.map((p) => {
      const scaled = Math.max(1, Math.round((p.marks / currentTotal) * targetMarks));
      scaledTotal += scaled;
      return { ...p, marks: scaled };
    });
    const questionTotal = parts.reduce((s, p) => s + p.marks, 0);
    return { ...q, parts, questionTotal };
  });

  const remainder = targetMarks - scaledTotal;
  if (remainder !== 0) {
    let maxMark = 0, maxQIdx = 0, maxPIdx = 0;
    questions.forEach((q, qi) => q.parts.forEach((p, pi) => {
      if (p.marks > maxMark) { maxMark = p.marks; maxQIdx = qi; maxPIdx = pi; }
    }));
    questions[maxQIdx].parts[maxPIdx].marks += remainder;
    questions[maxQIdx].questionTotal += remainder;
  }

  // Keep memo mark allocations consistent with the scaled part marks.
  questions = questions.map((q) => ({ ...q, parts: q.parts.map(rebalanceMethodMarks) }));

  return { ...paperJSON, questions, totalMarks: targetMarks };
}

// ── JSON extraction helpers ──────────────────────────────────────────────────

export function extractJSON(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1) return text.slice(start, end + 1);
  return text;
}

export function extractJSONArray(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const arrStart = text.indexOf('['), arrEnd = text.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd !== -1) return text.slice(arrStart, arrEnd + 1);
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1) return text.slice(start, end + 1);
  return text;
}
