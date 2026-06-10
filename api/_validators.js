/**
 * Deterministic validation layer — no API calls, pure logic.
 *
 * Each validator returns:
 *   { passed: boolean, failures: [{ questionNumber, part?, reason }] }
 *
 * runAllValidators() aggregates results and returns structured failure info
 * that the repair pass uses to build targeted fix prompts.
 */

import { REQUIRED_TOPICS, COGNITIVE_LEVELS } from './_config.js';

// ── Schema validator ────────────────────────────────────────────────────────
// Checks that required fields are present at every level.

export function validateSchema(paperJSON) {
  const failures = [];

  const paperFields = ['subject', 'paper', 'grade', 'totalMarks', 'duration', 'questions'];
  for (const f of paperFields) {
    if (paperJSON[f] == null) {
      failures.push({ questionNumber: null, reason: `Missing top-level field: ${f}` });
    }
  }

  if (!Array.isArray(paperJSON.questions) || paperJSON.questions.length === 0) {
    failures.push({ questionNumber: null, reason: 'questions array is empty or missing' });
    return { passed: false, failures };
  }

  for (const q of paperJSON.questions) {
    const qn = q.questionNumber ?? '?';
    if (!q.topic)          failures.push({ questionNumber: qn, reason: 'Missing topic' });
    if (!Array.isArray(q.parts) || q.parts.length === 0)
      failures.push({ questionNumber: qn, reason: 'Missing or empty parts array' });

    for (const p of (q.parts || [])) {
      const loc = `Q${qn}(${p.part ?? '?'})`;
      if (!p.instruction)  failures.push({ questionNumber: qn, part: p.part, reason: `${loc}: missing instruction` });
      if (!p.marks)        failures.push({ questionNumber: qn, part: p.part, reason: `${loc}: missing marks` });
      if (!p.solution)     failures.push({ questionNumber: qn, part: p.part, reason: `${loc}: missing solution` });
      else {
        if (!p.solution.answer)                    failures.push({ questionNumber: qn, part: p.part, reason: `${loc}: missing solution.answer` });
        if (!Array.isArray(p.solution.steps) || p.solution.steps.length === 0)
          failures.push({ questionNumber: qn, part: p.part, reason: `${loc}: missing solution.steps` });
        if (!Array.isArray(p.solution.methodMarks) || p.solution.methodMarks.length === 0)
          failures.push({ questionNumber: qn, part: p.part, reason: `${loc}: missing solution.methodMarks` });
      }
    }
  }

  return { passed: failures.length === 0, failures };
}

// ── Mark totals validator ────────────────────────────────────────────────────
// Part marks must sum to questionTotal; questionTotals must sum to targetMarks.

export function validateMarkTotals(paperJSON, targetMarks) {
  const failures = [];

  let paperTotal = 0;
  for (const q of paperJSON.questions) {
    const partsSum = (q.parts || []).reduce((s, p) => s + (p.marks || 0), 0);
    if (partsSum !== q.questionTotal) {
      failures.push({
        questionNumber: q.questionNumber,
        reason: `Q${q.questionNumber}: parts sum to ${partsSum} but questionTotal is ${q.questionTotal}`,
      });
    }
    paperTotal += q.questionTotal || 0;
  }

  if (targetMarks && paperTotal !== targetMarks) {
    failures.push({
      questionNumber: null,
      reason: `Paper total is ${paperTotal} but target is ${targetMarks}`,
    });
  }

  return { passed: failures.length === 0, failures };
}

// ── Method-mark sum validator ────────────────────────────────────────────────
// Sum of methodMarks[].mark must equal part marks for each part.

export function validateMethodMarkSums(paperJSON) {
  const failures = [];

  for (const q of paperJSON.questions) {
    for (const p of (q.parts || [])) {
      if (!Array.isArray(p.solution?.methodMarks)) continue;
      const mmSum = p.solution.methodMarks.reduce((s, m) => s + (m.mark || 0), 0);
      if (mmSum !== p.marks) {
        failures.push({
          questionNumber: q.questionNumber,
          part: p.part,
          reason: `Q${q.questionNumber}(${p.part}): methodMarks sum ${mmSum} ≠ part marks ${p.marks}`,
        });
      }
    }
  }

  return { passed: failures.length === 0, failures };
}

// ── Topic coverage validator ─────────────────────────────────────────────────
// Every required topic must appear (case-insensitive) in at least one question's topic field.

export function validateTopicCoverage(paperJSON, subject, paper) {
  const required = REQUIRED_TOPICS[subject]?.[paper];
  if (!required || required.length === 0) return { passed: true, failures: [] };

  const allTopics = paperJSON.questions
    .map(q => (q.topic || '').toLowerCase())
    .join(' ');

  const failures = required
    .filter(t => !allTopics.includes(t.toLowerCase()))
    .map(t => ({ questionNumber: null, reason: `Required topic missing: "${t}"` }));

  return { passed: failures.length === 0, failures };
}

// ── Rational-answer validator ────────────────────────────────────────────────
// Flags parts where the answer contains surds/irrationals when the instruction
// implies an exact rational answer ("solve", "find x", "calculate x").
// We never flag geometry questions (π, sin, cos expected there).

const SURD_RE   = /[√∜]|±\s*√|\b\d*√\d+/;
const EXACT_RE  = /\b(solve|find\s+(?:the\s+value|x|y)|calculate\s+(?:x|y|the\s+value))\b/i;
const TRIG_RE   = /\b(sin|cos|tan|°|degrees?|triangle|circle|arc|sector|segment)\b/i;

export function validateRationalAnswers(paperJSON) {
  const failures = [];

  for (const q of paperJSON.questions) {
    for (const p of (q.parts || [])) {
      const answer = String(p.solution?.answer || '');
      const instr  = String(p.instruction || '');

      if (SURD_RE.test(answer) && EXACT_RE.test(instr) && !TRIG_RE.test(instr)) {
        failures.push({
          questionNumber: q.questionNumber,
          part: p.part,
          reason: `Q${q.questionNumber}(${p.part}): answer "${answer}" contains an irrational/surd in an exact-answer context. Reconstruct the equation from rational roots.`,
        });
      }
    }
  }

  return { passed: failures.length === 0, failures };
}

// ── Unused-variable validator ────────────────────────────────────────────────
// If a part has a variables_used array, every variable must appear in the solution steps.

export function validateVariables(paperJSON) {
  const failures = [];

  for (const q of paperJSON.questions) {
    for (const p of (q.parts || [])) {
      if (!Array.isArray(p.variables_used) || p.variables_used.length === 0) continue;

      const stepsText = (p.solution?.steps || []).join(' ').toLowerCase();

      for (const v of p.variables_used) {
        const name   = (v.name   || '').toLowerCase();
        const symbol = (v.symbol || '').toLowerCase();
        const value  = String(v.value || '').toLowerCase();

        // The variable is "used" if its name, symbol, or numeric value appears in the steps.
        // For single-character symbols we require a word boundary to avoid false positives
        // (e.g. symbol "r" spuriously matching "principal", "answer", etc.)
        const symbolMatch = symbol && (
          symbol.length === 1
            ? new RegExp(`\\b${symbol}\\b`, 'i').test(stepsText)
            : stepsText.includes(symbol)
        );
        const mentioned = (name && stepsText.includes(name))
          || symbolMatch
          || (value && value.replace(/[^0-9.]/g, '').length > 1 && stepsText.includes(value.replace(/[^0-9.]/g, '')));

        if (!mentioned) {
          failures.push({
            questionNumber: q.questionNumber,
            part: p.part,
            reason: `Q${q.questionNumber}(${p.part}): variable "${v.name || v.symbol}" is introduced but never used in the solution.`,
          });
        }
      }
    }
  }

  return { passed: failures.length === 0, failures };
}

// ── Discriminant validator ───────────────────────────────────────────────────
// For "solve" parts whose expression is a quadratic ax² + bx + c = 0 with
// integer coefficients, compute b² − 4ac symbolically and require a perfect
// square (rational roots). Catches surd answers the regex validator misses
// (e.g. the memo writes a decimal approximation of an irrational root).

function parseQuadratic(expression) {
  if (!expression) return null;
  // Normalise: unicode ², strip spaces, ** → ^
  let s = String(expression).replace(/²/g, '^2').replace(/\*\*/g, '^').replace(/\s+/g, '').toLowerCase();
  const m = s.match(/^([a-z()0-9+\-*/^.]*)=0$/);
  if (!m) return null;
  let lhs = m[1].replace(/\*/g, '');

  // Match a single-variable quadratic with integer coefficients.
  const variable = (lhs.match(/[a-z]/g) || []).filter((c, i, a) => a.indexOf(c) === i);
  if (variable.length !== 1) return null;
  const v = variable[0];

  const quadRe = new RegExp(
    `^([+-]?\\d*)${v}\\^2(?:([+-]\\d*)${v})?(?:([+-]\\d+))?$`
  );
  const q = lhs.match(quadRe);
  if (!q) return null;

  const coef = (str, dflt) => {
    if (str === undefined || str === null || str === '') return dflt;
    if (str === '+') return 1;
    if (str === '-') return -1;
    return Number(str);
  };
  const a = coef(q[1], 1);
  const b = coef(q[2], 0);
  const c = coef(q[3], 0);
  if (![a, b, c].every(Number.isInteger) || a === 0) return null;
  return { a, b, c };
}

export function validateDiscriminants(paperJSON) {
  const failures = [];

  for (const q of paperJSON.questions) {
    for (const p of (q.parts || [])) {
      const instr = String(p.instruction || '');
      if (!EXACT_RE.test(instr) || TRIG_RE.test(instr)) continue;
      if (/surd|simplest\s+form|two\s+decimal/i.test(instr)) continue; // surds explicitly allowed

      const quad = parseQuadratic(p.expression);
      if (!quad) continue;

      const disc = quad.b * quad.b - 4 * quad.a * quad.c;
      const root = Math.sqrt(Math.abs(disc));
      const perfectSquare = disc >= 0 && Number.isInteger(root);

      if (!perfectSquare) {
        failures.push({
          questionNumber: q.questionNumber,
          part: p.part,
          reason: `Q${q.questionNumber}(${p.part}): quadratic ${p.expression} has discriminant ${disc} (not a perfect square) — roots are irrational. Reconstruct the equation backwards from chosen rational roots.`,
        });
      }
    }
  }

  return { passed: failures.length === 0, failures };
}

// ── Cognitive level distribution validator ───────────────────────────────────
// Parts missing cognitive_level are flagged individually (repairable). When
// enough marks are labelled, the per-level mark distribution must be within
// tolerance of the prescribed IEB weighting. Distribution misses are
// paper-level (not per-question repairable).

export function validateCognitiveLevels(paperJSON) {
  const failures = [];
  const marksByLevel = { 1: 0, 2: 0, 3: 0, 4: 0 };
  let totalMarks = 0;
  let labelledMarks = 0;

  for (const q of paperJSON.questions) {
    for (const p of (q.parts || [])) {
      const marks = p.marks || 0;
      totalMarks += marks;
      const level = Number(p.cognitive_level);
      if ([1, 2, 3, 4].includes(level)) {
        marksByLevel[level] += marks;
        labelledMarks += marks;
      } else {
        failures.push({
          questionNumber: q.questionNumber,
          part: p.part,
          reason: `Q${q.questionNumber}(${p.part}): missing or invalid cognitive_level (must be 1–4)`,
        });
      }
    }
  }

  if (totalMarks > 0 && labelledMarks / totalMarks >= COGNITIVE_LEVELS.minLabelledFraction) {
    for (const [level, target] of Object.entries(COGNITIVE_LEVELS.distribution)) {
      const actual = marksByLevel[level] / labelledMarks;
      if (Math.abs(actual - target) > COGNITIVE_LEVELS.toleranceFraction) {
        failures.push({
          questionNumber: null,
          reason: `Cognitive level ${level} carries ${Math.round(actual * 100)}% of marks; prescribed ~${Math.round(target * 100)}% (tolerance ±${Math.round(COGNITIVE_LEVELS.toleranceFraction * 100)}pp)`,
        });
      }
    }
  }

  return { passed: failures.length === 0, failures };
}

// ── Accounting balance validator ─────────────────────────────────────────────
// Every provided balance_check must balance (debits === credits). Questions
// whose topic implies a ledger/statement/reconciliation/budget must carry at
// least one balance_check so the memo arithmetic is programmatically verified.

const BALANCE_TOPIC_RE = /statement|ledger|reconciliation|budget|balance/i;

export function validateAccountingBalance(paperJSON, subject) {
  if (subject !== 'Accounting') return { passed: true, failures: [] };
  const failures = [];

  for (const q of paperJSON.questions) {
    let hasCheck = false;

    for (const p of (q.parts || [])) {
      const bc = p.balance_check;
      if (!bc) continue;
      hasCheck = true;
      const debits = Number(bc.debits);
      const credits = Number(bc.credits);
      if (!Number.isFinite(debits) || !Number.isFinite(credits) || Math.abs(debits - credits) > 0.005) {
        failures.push({
          questionNumber: q.questionNumber,
          part: p.part,
          reason: `Q${q.questionNumber}(${p.part}): balance_check "${bc.label || ''}" does not balance — debits ${bc.debits} ≠ credits ${bc.credits}. Reconstruct the figures backwards from a balanced set.`,
        });
      }
    }

    if (!hasCheck && BALANCE_TOPIC_RE.test(q.topic || '')) {
      failures.push({
        questionNumber: q.questionNumber,
        reason: `Q${q.questionNumber}: topic "${q.topic}" requires at least one balance_check in the memo (debits = credits) but none is present.`,
      });
    }
  }

  return { passed: failures.length === 0, failures };
}

// ── Physics numeric validator ────────────────────────────────────────────────
// For Physical Sciences calculation parts carrying a numeric_check, re-evaluate
// the pure-arithmetic expression and confirm it matches the declared value and
// the numeric answer in the memo; flag unreasonable magnitudes.

const SAFE_EXPR_RE = /^[0-9+\-*/().^eE\s]+$/;

export function evaluateArithmetic(expression) {
  const s = String(expression || '').trim();
  if (!s || !SAFE_EXPR_RE.test(s)) return null;
  try {
    // Whitelisted charset above (digits + arithmetic operators only) makes
    // Function() safe here — no identifiers can be formed.
    const value = Function(`"use strict"; return (${s.replace(/\^/g, '**')});`)();
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function firstNumber(text) {
  const m = String(text || '').replace(/\s/g, '').match(/-?\d+(?:[.,]\d+)?(?:[eE]-?\d+)?/);
  return m ? Number(m[0].replace(',', '.')) : null;
}

function approxEqual(a, b, relTol = 0.01) {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-12);
  return Math.abs(a - b) / scale <= relTol;
}

export function validatePhysicsNumeric(paperJSON, subject) {
  if (subject !== 'Physical Sciences') return { passed: true, failures: [] };
  const failures = [];

  for (const q of paperJSON.questions) {
    for (const p of (q.parts || [])) {
      const nc = p.numeric_check;
      if (!nc) continue;
      const loc = `Q${q.questionNumber}(${p.part})`;

      const computed = evaluateArithmetic(nc.expression);
      const declared = Number(nc.value);

      if (computed == null) {
        failures.push({ questionNumber: q.questionNumber, part: p.part, reason: `${loc}: numeric_check.expression "${nc.expression}" is not a valid pure-arithmetic expression.` });
        continue;
      }
      if (!Number.isFinite(declared) || !approxEqual(computed, declared)) {
        failures.push({ questionNumber: q.questionNumber, part: p.part, reason: `${loc}: numeric_check expression evaluates to ${computed} but declared value is ${nc.value}. Recompute the memo answer from the given values.` });
        continue;
      }
      const answerNum = firstNumber(p.solution?.answer);
      if (answerNum != null && !approxEqual(answerNum, declared)) {
        failures.push({ questionNumber: q.questionNumber, part: p.part, reason: `${loc}: memo answer "${p.solution.answer}" does not match the verified value ${declared} ${nc.unit || ''}.` });
        continue;
      }
      if (Math.abs(declared) > 1e9) {
        failures.push({ questionNumber: q.questionNumber, part: p.part, reason: `${loc}: answer magnitude ${declared} is physically unreasonable — choose realistic given values.` });
      }
    }
  }

  return { passed: failures.length === 0, failures };
}

// ── Aggregate runner ─────────────────────────────────────────────────────────
// Returns { passed, failures, failedQuestionNumbers }
// failedQuestionNumbers is a de-duped list for the repair loop.

export function runAllValidators(paperJSON, subject, paper, targetMarks) {
  const results = [
    validateSchema(paperJSON),
    validateMarkTotals(paperJSON, targetMarks),
    validateMethodMarkSums(paperJSON),
    validateTopicCoverage(paperJSON, subject, paper),
    validateRationalAnswers(paperJSON),
    validateDiscriminants(paperJSON),
    validateVariables(paperJSON),
    validateCognitiveLevels(paperJSON),
    validateAccountingBalance(paperJSON, subject),
    validatePhysicsNumeric(paperJSON, subject),
  ];

  const allFailures = results.flatMap(r => r.failures);
  const passed = allFailures.length === 0;

  // Build a map: questionNumber → [reasons]  (null = paper-level failures)
  const byQuestion = {};
  for (const f of allFailures) {
    const key = f.questionNumber ?? '__paper__';
    if (!byQuestion[key]) byQuestion[key] = [];
    byQuestion[key].push(f.reason);
  }

  const failedQuestionNumbers = Object.keys(byQuestion)
    .filter(k => k !== '__paper__')
    .map(Number);

  return { passed, failures: allFailures, byQuestion, failedQuestionNumbers };
}
