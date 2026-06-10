/**
 * Subject-specific validators that plug into the universal layer.
 *
 * Each exported validator returns { name, passed, failures } so it composes
 * with the universal validators in _verification.js. Existing single-purpose
 * checks (discriminant, accounting balance, physics numeric, rational answers,
 * unused variables, cognitive levels) are imported from _validators.js and
 * wrapped here — this module is the one place that knows which checks apply to
 * which subject (SUBJECT_VALIDATORS registry at the bottom).
 *
 * Import direction is one-way (_validators-subjects → _validators) to avoid a
 * cycle; the aggregator/runner lives in _verification.js.
 */

import {
  validateDiscriminants,
  validateRationalAnswers,
  validateVariables,
  validateCognitiveLevels,
  validateAccountingBalance,
  validatePhysicsNumeric,
  evaluateArithmetic,
} from './_validators.js';

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const result = (name, failures) => ({ name, passed: failures.length === 0, failures });

/** Wrap a legacy validator (returns {passed,failures}) with a stable name. */
function named(name, fn) {
  return (paper, config, ctx) => {
    const r = fn(paper, config, ctx);
    return { name, passed: r.passed, failures: r.failures };
  };
}

// ── Mathematics: calculus strand coverage ────────────────────────────────────
// The calculus topic must genuinely span ≥ format_rules.calculus_min_strands of
// the listed strands (first principles, differentiation rules, cubic graphs,
// optimisation) — not just be tagged "Calculus".

const STRAND_PATTERNS = {
  'first principles': /first principles|from first principles|f\s*\(\s*x\s*\+\s*h\s*\)/i,
  'differentiation rules': /power rule|chain rule|product rule|quotient rule|differentiat|d\/dx|derivative/i,
  'cubic graphs': /cubic|turning point|point of inflection|stationary point|sketch the graph of f/i,
  'optimisation': /optimis|maximum|minimum|maximise|minimise|greatest|least|rate of change/i,
};

export function validateCalculusCoverage(paper, config) {
  const rules = config?.format_rules || {};
  const minStrands = rules.calculus_min_strands;
  if (!minStrands) return result('maths_calculus_coverage', []);
  const strands = rules.calculus_strands || Object.keys(STRAND_PATTERNS);

  const calcText = paper.questions
    .filter(q => /calculus|differentiat|derivative/i.test(`${q.topic} ${q.subtopic || ''}`))
    .flatMap(q => (q.parts || []).map(p => `${p.instruction || ''} ${p.expression || ''} ${(p.solution?.steps || []).join(' ')} ${p.subtopic || ''}`))
    .join(' ');

  if (!calcText.trim()) {
    return result('maths_calculus_coverage', [{ questionNumber: null, reason: 'No calculus question found — calculus is compulsory in Mathematics Paper 1.' }]);
  }

  const found = strands.filter(strand => (STRAND_PATTERNS[strand] || new RegExp(strand, 'i')).test(calcText));
  if (found.length < minStrands) {
    return result('maths_calculus_coverage', [{
      questionNumber: null,
      reason: `Calculus covers only ${found.length} strand(s) [${found.join(', ') || 'none'}]; at least ${minStrands} of [${strands.join(', ')}] are required.`,
    }]);
  }
  return result('maths_calculus_coverage', []);
}

// ── English: editing errors, summary count, visual text ──────────────────────

export function validateEnglishStructure(paper, config) {
  const failures = [];
  const rules = config?.format_rules || {};

  const isSummary = (q) => /summary/i.test(`${q.topic} ${q.subtopic || ''}`);
  const isVisual = (text) => /visual|advert|cartoon|image|poster|caption|illustration/i.test(text);
  const isEditing = (text) => /editing|edit the|correct the|proofread/i.test(text);

  // Exactly N summary sections.
  if (rules.summary_sections_required != null) {
    const summaryCount = paper.questions.filter(isSummary).length;
    if (summaryCount !== rules.summary_sections_required) {
      failures.push({ questionNumber: null, reason: `Expected exactly ${rules.summary_sections_required} summary section(s); found ${summaryCount}.` });
    }
  }

  // At least one visual / advertising text question.
  if (rules.require_visual_text_question) {
    const hasVisual = paper.questions.some(q => {
      const text = `${q.topic} ${q.subtopic || ''} ${q.context || ''} ${(q.parts || []).map(p => p.instruction).join(' ')}`;
      return isVisual(text);
    });
    if (!hasVisual) {
      failures.push({ questionNumber: null, reason: 'Paper must include a visual / advertising text question (none found).' });
    }
  }

  // Editing passages: exactly one identifiable error per mark.
  if (rules.editing_one_error_per_mark) {
    for (const q of paper.questions) {
      for (const p of (q.parts || [])) {
        const text = `${p.instruction || ''} ${p.subtopic || ''} ${q.subtopic || ''}`;
        if (!isEditing(text)) continue;
        const declared = Array.isArray(p.errors)
          ? p.errors.length
          : (Array.isArray(p.solution?.methodMarks) ? p.solution.methodMarks.length : null);
        if (declared == null) {
          failures.push({ questionNumber: q.questionNumber, part: p.part, reason: `Q${q.questionNumber}(${p.part}): editing question must declare its errors (an "errors" list or one methodMark per error) so error count can be checked against the ${p.marks} marks.` });
        } else if (declared !== p.marks) {
          failures.push({ questionNumber: q.questionNumber, part: p.part, reason: `Q${q.questionNumber}(${p.part}): editing question has ${declared} error(s) for ${p.marks} marks — must be exactly one error per mark.` });
        }
      }
    }
  }

  return result('english_structure', failures);
}

// ── Accounting: ratios computable from given figures ─────────────────────────
// For parts asking for a financial indicator/ratio, the memo working must
// actually contain numbers (i.e. the ratio is computed from given figures, not
// asserted). Heuristic — see TODO.

const RATIO_RE = /\bratio\b|acid[- ]test|current ratio|solvency|liquidity|return on|earnings per share|net asset value|debt[- ]equity|% ?(?:gross|net|operating)|stock turnover/i;

export function validateAccountingRatios(paper, config) {
  if (!config?.format_rules?.ratios_must_be_computable) return result('accounting_ratios', []);
  const failures = [];

  for (const q of paper.questions) {
    for (const p of (q.parts || [])) {
      if (!RATIO_RE.test(`${p.instruction || ''} ${p.subtopic || ''}`)) continue;
      const steps = (p.solution?.steps || []).join(' ');
      const numbersInSteps = (steps.match(/\d[\d ,.]*\d|\d/g) || []).length;
      // A computable ratio shows at least two figures combined in the working.
      // TODO: tighten by parsing the actual figures referenced against the
      // scenario's given values once questions carry a structured figures list.
      if (numbersInSteps < 2) {
        failures.push({ questionNumber: q.questionNumber, part: p.part, reason: `Q${q.questionNumber}(${p.part}): ratio/indicator answer is not shown to be computed from given figures (memo working has too few numeric values).` });
      }
    }
  }

  return result('accounting_ratios', failures);
}

// ── Physics: units on numeric answers + plausibility ─────────────────────────

const UNIT_RE = /[a-zµΩ°%]/i; // any letter/unit symbol following the number
const SPEED_RE = /speed|velocity|\bv\b/i;

export function validatePhysicsUnitsAndPlausibility(paper, config) {
  const failures = [];
  const rules = config?.format_rules || {};
  const requireUnits = rules.require_units_on_numeric_answers;
  const plaus = rules.plausibility || {};
  const maxSpeed = plaus.max_speed_m_s;
  const nonNeg = (plaus.non_negative_quantities || []).map(norm);

  for (const q of paper.questions) {
    for (const p of (q.parts || [])) {
      const answer = String(p.solution?.answer || '');
      const isNumeric = !!p.numeric_check || /-?\d/.test(answer);
      const loc = `Q${q.questionNumber}(${p.part})`;

      // Skip definition/statement/explanation parts — those have no numeric answer.
      if (!isNumeric) continue;

      // Units: a number must be followed somewhere by a unit symbol/word.
      if (requireUnits) {
        const unitFromCheck = p.numeric_check?.unit;
        const hasUnitInAnswer = /-?\d[\d.,]*\s*[a-zµΩ°%/·^0-9-]*[a-zµΩ°%]/i.test(answer) || UNIT_RE.test(answer.replace(/-?\d[\d.,]*/g, ''));
        if (!unitFromCheck && !hasUnitInAnswer) {
          failures.push({ questionNumber: q.questionNumber, part: p.part, reason: `${loc}: numerical answer "${answer}" carries no unit.` });
        }
      }

      // Plausibility.
      const val = p.numeric_check ? Number(p.numeric_check.value) : firstNumber(answer);
      if (Number.isFinite(val)) {
        const label = norm(`${p.numeric_check?.unit || ''} ${p.instruction || ''} ${p.subtopic || ''}`);
        if (maxSpeed && SPEED_RE.test(label) && Math.abs(val) > maxSpeed) {
          failures.push({ questionNumber: q.questionNumber, part: p.part, reason: `${loc}: speed ${val} m/s exceeds the speed of light — physically impossible.` });
        }
        if (val < 0 && nonNeg.some(qty => label.includes(qty))) {
          failures.push({ questionNumber: q.questionNumber, part: p.part, reason: `${loc}: a non-negative quantity has a negative value (${val}).` });
        }
      }
    }
  }

  return result('physics_units_plausibility', failures);
}

function firstNumber(text) {
  const m = String(text || '').replace(/\s/g, '').match(/-?\d+(?:[.,]\d+)?(?:[eE]-?\d+)?/);
  return m ? Number(m[0].replace(',', '.')) : null;
}

// ── Biology / Life Sciences: diagram questions need a text description ────────

export function validateBiologyDiagrams(paper, config) {
  if (!config?.format_rules?.diagram_questions_need_text) return result('biology_diagrams', []);
  const failures = [];
  const DIAGRAM_RE = /diagram|figure|sketch|the graph (?:below|above|shown)|micrograph|illustration|image (?:below|above)/i;

  for (const q of paper.questions) {
    const refsDiagram = (q.parts || []).some(p => DIAGRAM_RE.test(p.instruction || '')) || DIAGRAM_RE.test(q.context || '');
    if (!refsDiagram) continue;
    // The diagram must be described in text (no image rendering possible) so the
    // question is markable: require a context of reasonable length.
    const desc = String(q.context || '').trim();
    if (desc.length < 40) {
      failures.push({ questionNumber: q.questionNumber, reason: `Q${q.questionNumber}: refers to a diagram/figure but provides no adequate text description in "context" — describe the diagram fully so it is answerable and markable without an image.` });
    }
  }

  return result('biology_diagrams', failures);
}

// ── Subject → validator registry ─────────────────────────────────────────────
// Universal validators always run first (see _verification.js); these add the
// subject layer on top.

export const SUBJECT_VALIDATORS = {
  'Mathematics': [
    validateCalculusCoverage,
    named('discriminant', validateDiscriminants),
    named('rational_answers', validateRationalAnswers),
    named('unused_variables', validateVariables),
    named('cognitive_levels', validateCognitiveLevels),
  ],
  'Physical Sciences': [
    validatePhysicsUnitsAndPlausibility,
    named('physics_numeric', (paper) => validatePhysicsNumeric(paper, 'Physical Sciences')),
    named('unused_variables', validateVariables),
    named('cognitive_levels', validateCognitiveLevels),
  ],
  'Accounting': [
    named('accounting_balance', (paper) => validateAccountingBalance(paper, 'Accounting')),
    validateAccountingRatios,
    named('cognitive_levels', validateCognitiveLevels),
  ],
  'English Home Language': [
    validateEnglishStructure,
  ],
  'Life Sciences': [
    validateBiologyDiagrams,
    named('cognitive_levels', validateCognitiveLevels),
  ],
};

export function getSubjectValidators(subject) {
  return SUBJECT_VALIDATORS[subject] || [];
}
