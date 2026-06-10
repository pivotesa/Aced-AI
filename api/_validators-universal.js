/**
 * Universal validator module — subject-agnostic checks driven by a subject
 * config (api/config/*.json). Every check returns:
 *     { name, passed, failures: [{ questionNumber, part?, reason }] }
 *
 * These run for ANY paper. Subject-specific checks live in
 * _validators-subjects.js and plug in on top of these.
 */

// ── 1. Schema ────────────────────────────────────────────────────────────────
// Required fields at every level. (Shared with the legacy schema check; kept
// here so the universal layer is self-contained.)

export function validateSchema(paper) {
  const failures = [];
  const top = ['subject', 'paper', 'totalMarks', 'questions'];
  for (const f of top) {
    if (paper[f] == null) failures.push({ questionNumber: null, reason: `Missing top-level field: ${f}` });
  }
  if (!Array.isArray(paper.questions) || paper.questions.length === 0) {
    failures.push({ questionNumber: null, reason: 'questions array is empty or missing' });
    return result('schema', failures);
  }
  for (const q of paper.questions) {
    const qn = q.questionNumber ?? '?';
    if (!q.topic) failures.push({ questionNumber: qn, reason: `Q${qn}: missing topic` });
    if (!Array.isArray(q.parts) || q.parts.length === 0) {
      failures.push({ questionNumber: qn, reason: `Q${qn}: missing or empty parts array` });
      continue;
    }
    for (const p of q.parts) {
      const loc = `Q${qn}(${p.part ?? '?'})`;
      if (!p.instruction) failures.push({ questionNumber: qn, part: p.part, reason: `${loc}: missing instruction` });
      if (p.marks == null) failures.push({ questionNumber: qn, part: p.part, reason: `${loc}: missing marks` });
      if (!p.solution) failures.push({ questionNumber: qn, part: p.part, reason: `${loc}: missing solution` });
    }
  }
  return result('schema', failures);
}

// ── 2. Mark arithmetic ───────────────────────────────────────────────────────
// Part marks sum to question marks; question marks sum to the paper total
// declared in config (paper_total). Also re-checks methodMarks sums to marks.

export function validateMarkArithmetic(paper, config) {
  const failures = [];
  let paperTotal = 0;

  for (const q of paper.questions) {
    const partsSum = (q.parts || []).reduce((s, p) => s + (p.marks || 0), 0);
    if (q.questionTotal != null && partsSum !== q.questionTotal) {
      failures.push({ questionNumber: q.questionNumber, reason: `Q${q.questionNumber}: parts sum to ${partsSum} but questionTotal is ${q.questionTotal}` });
    }
    paperTotal += partsSum;

    for (const p of (q.parts || [])) {
      if (!Array.isArray(p.solution?.methodMarks)) continue;
      const mmSum = p.solution.methodMarks.reduce((s, m) => s + (m.mark || 0), 0);
      if (mmSum !== p.marks) {
        failures.push({ questionNumber: q.questionNumber, part: p.part, reason: `Q${q.questionNumber}(${p.part}): methodMarks sum ${mmSum} ≠ part marks ${p.marks}` });
      }
    }
  }

  const target = config?.paper_total;
  if (target != null && paperTotal !== target) {
    failures.push({ questionNumber: null, reason: `Paper total is ${paperTotal} but the stated total for ${config.id} is ${target}` });
  }

  return result('mark_arithmetic', failures);
}

// ── 3. Sequential labelling ──────────────────────────────────────────────────
// Question numbers must be 1..n with no gaps; within each question, part labels
// must be consecutive (a, b, c, …) with no skipped letter.

export function validateSequentialLabels(paper) {
  const failures = [];

  const numbers = paper.questions.map(q => q.questionNumber).filter(n => typeof n === 'number');
  const sorted = [...numbers].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] !== i + 1) {
      failures.push({ questionNumber: sorted[i], reason: `Question numbering has a gap or does not start at 1: expected ${i + 1}, found ${sorted[i]} (numbers: ${sorted.join(', ')})` });
      break;
    }
  }

  for (const q of paper.questions) {
    const labels = (q.parts || []).map(p => String(p.part || '').toLowerCase());
    // Only validate single-letter alphabetical labelling (a, b, c …).
    if (!labels.every(l => /^[a-z]$/.test(l))) continue;
    for (let i = 0; i < labels.length; i++) {
      const expected = String.fromCharCode(97 + i); // 'a' + i
      if (labels[i] !== expected) {
        failures.push({ questionNumber: q.questionNumber, part: labels[i], reason: `Q${q.questionNumber}: part labels are not consecutive — expected "${expected}" at position ${i + 1}, found "${labels[i]}" (labels: ${labels.join(', ')})` });
        break;
      }
    }
  }

  return result('sequential_labels', failures);
}

// ── 4. Mark-band calibration ─────────────────────────────────────────────────
// Each part declares a difficulty tag; its marks must fall within the band for
// that tag in config.mark_bands. Parts with no difficulty tag are skipped (the
// tag is what makes calibration checkable). A band's upper bound of null means
// "no maximum" (extended responses).

export function validateMarkBands(paper, config) {
  const failures = [];
  const bands = config?.mark_bands;
  if (!bands) return result('mark_bands', failures);

  for (const q of paper.questions) {
    for (const p of (q.parts || [])) {
      const tag = p.difficulty;
      if (!tag) continue; // nothing declared → nothing to calibrate against
      const band = bands[tag];
      const loc = `Q${q.questionNumber}(${p.part})`;
      if (!band) {
        failures.push({ questionNumber: q.questionNumber, part: p.part, reason: `${loc}: unknown difficulty tag "${tag}" (expected one of ${Object.keys(bands).join(', ')})` });
        continue;
      }
      const [min, max] = band;
      if (p.marks < min || (max != null && p.marks > max)) {
        const range = max == null ? `${min}+` : `${min}–${max}`;
        failures.push({ questionNumber: q.questionNumber, part: p.part, reason: `${loc}: ${p.marks} marks for a "${tag}" part is outside the band ${range}. Re-tag the difficulty or adjust the marks.` });
      }
    }
  }

  return result('mark_bands', failures);
}

// ── 5. Duplicate / near-duplicate detection ──────────────────────────────────
// Flags two parts (in different questions) that share the same structural
// signature: the instruction skeleton (lowercased, numbers and symbols
// stripped) plus the expression skeleton (digits replaced with a placeholder).
// Catches e.g. the same exponential equation reused across two questions.

function instructionSkeleton(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[0-9]+(?:[.,][0-9]+)?/g, '#')   // numbers → #
    .replace(/[^a-z#\s]/g, ' ')               // drop punctuation/symbols
    .replace(/\s+/g, ' ')
    .trim();
}

function expressionSkeleton(expr) {
  if (!expr) return '';
  return String(expr)
    .replace(/[0-9]+(?:[.,][0-9]+)?/g, '#')   // constants → #
    .replace(/\s+/g, '')
    .toLowerCase();
}

export function validateNoDuplicates(paper) {
  const failures = [];
  const seen = new Map(); // signature → "Q1(a)"

  for (const q of paper.questions) {
    for (const p of (q.parts || [])) {
      const expr = expressionSkeleton(p.expression);
      // Use the structural expression as the duplicate fingerprint. A part with
      // no expression (e.g. a discursive/definition prompt) has no reliable
      // structural signature, so it is not compared — this keeps generic stems
      // ("Calculate the following.") from producing false positives while still
      // catching a reused equation across two questions.
      if (!expr) continue;
      const signature = `${instructionSkeleton(p.instruction)}::${expr}`;
      const loc = `Q${q.questionNumber}(${p.part})`;
      if (seen.has(signature)) {
        failures.push({ questionNumber: q.questionNumber, part: p.part, reason: `${loc} is a near-duplicate of ${seen.get(signature)} — same question structure and expression pattern "${expr}". Vary the question.` });
      } else {
        seen.set(signature, loc);
      }
    }
  }

  return result('no_duplicates', failures);
}

// ── 6. Topic coverage with mark ranges ───────────────────────────────────────
// Every config topic with min_marks > 0 must be covered; the marks attributed
// to each topic must fall within [min_marks, max_marks]. A question is
// attributed to a topic when the topic name matches (case-insensitive, either
// direction) the question's topic or subtopic, or any part's subtopic. The
// max_marks ceiling rejects papers that pad one topic to reach the total.

function matchesTopic(topicName, question) {
  const needle = norm(topicName);
  const haystacks = [
    norm(question.topic),
    norm(question.subtopic),
    ...(question.parts || []).map(p => norm(p.subtopic)),
  ];
  return haystacks.some(h => h && (h.includes(needle) || needle.includes(h)));
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function validateTopicCoverage(paper, config) {
  const failures = [];
  const topics = config?.topics;
  if (!Array.isArray(topics) || topics.length === 0) return result('topic_coverage', failures);

  for (const t of topics) {
    const marks = paper.questions
      .filter(q => matchesTopic(t.name, q))
      .reduce((s, q) => s + (q.parts || []).reduce((a, p) => a + (p.marks || 0), 0), 0);

    const min = t.min_marks ?? 0;
    const max = t.max_marks;

    if (min > 0 && marks === 0) {
      failures.push({ questionNumber: null, reason: `Required topic "${t.name}" is not covered (needs ${min}–${max ?? '∞'} marks).` });
    } else if (marks > 0 && marks < min) {
      failures.push({ questionNumber: null, reason: `Topic "${t.name}" carries only ${marks} marks; minimum is ${min}.` });
    } else if (max != null && marks > max) {
      failures.push({ questionNumber: null, reason: `Topic "${t.name}" carries ${marks} marks, above its ${max}-mark ceiling — the paper appears padded on this topic.` });
    }
  }

  return result('topic_coverage', failures);
}

// ── runner ────────────────────────────────────────────────────────────────────

export function runUniversalValidators(paper, config) {
  return [
    validateSchema(paper),
    validateMarkArithmetic(paper, config),
    validateSequentialLabels(paper),
    validateMarkBands(paper, config),
    validateNoDuplicates(paper),
    validateTopicCoverage(paper, config),
  ];
}

function result(name, failures) {
  return { name, passed: failures.length === 0, failures };
}
