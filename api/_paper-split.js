/**
 * Paper / memo separation and student-facing leak screening.
 *
 * The generation pipeline produces a FULL paper object where every part carries
 * its solution (steps, answer, methodMarks) plus working metadata
 * (variables_used, numeric_check, balance_check, expression). That object must
 * NEVER reach the student's browser — a student could read solutions straight
 * out of the network response or the Firestore session doc.
 *
 * splitPaperAndMemo() produces two objects:
 *   • paper — student-facing: question text, per-part mark totals, any GIVEN
 *     information (provided formulas/data), and answer-input scaffolding only.
 *   • memo  — the full marking memorandum (solutions + method-mark criteria),
 *     used server-side for marking and shown only after submission / in review.
 *
 * The per-part `expression` field is intentionally dropped from the student
 * paper: in this codebase it duplicates the equation already embedded in the
 * instruction (e.g. "Solve for x: 2x² − 7x + 3 = 0") and is the exact channel
 * through which answers leaked (e.g. "n^2+2n=168" printed under a question that
 * asks the student to derive it). Information the student is legitimately
 * entitled to (a provided formula, a data table) must be authored into the new
 * `given` field, which is screened below.
 *
 * screenStudentPaper() is the deterministic safety net: it scans the
 * student-facing object for any solution leakage (forbidden keys, or a memo
 * answer value appearing in question text) and strips what it safely can,
 * flagging the rest into the verification report.
 */

// Keys that belong ONLY in the memo and must be absent from a student part.
const MEMO_ONLY_KEYS = [
  'solution', 'methodMarks', 'variables_used', 'numeric_check',
  'balance_check', 'expression', 'cognitive_level', 'difficulty', 'answer', 'subtopic',
];

function studentPart(p) {
  return {
    part: p.part,
    instruction: p.instruction,
    marks: p.marks,
    // `given` is the sanctioned channel for student-visible provided material
    // (formulas, data). It is screened for leaks below.
    given: p.given ?? null,
  };
}

function studentQuestion(q) {
  return {
    questionNumber: q.questionNumber,
    topic: q.topic,
    context: q.context ?? null,
    questionTotal: q.questionTotal,
    parts: (q.parts || []).map(studentPart),
  };
}

/**
 * Split a full generated paper into { paper (student-facing), memo (full) }.
 */
export function splitPaperAndMemo(fullPaper) {
  const memo = fullPaper; // the full object IS the marking memo
  const paper = {
    subject: fullPaper.subject,
    paper: fullPaper.paper,
    grade: fullPaper.grade,
    totalMarks: fullPaper.totalMarks,
    duration: fullPaper.duration,
    questions: (fullPaper.questions || []).map(studentQuestion),
  };
  return { paper, memo };
}

// ── Leak screening ───────────────────────────────────────────────────────────

function norm(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Distinctive ANSWER-SIDE fragments to look for in question-visible text.
 * We deliberately use only final/answer values (the answer string, the
 * numeric_check value, balance_check totals) — NOT intermediate step numbers,
 * because a given value legitimately appears in both the question and the
 * working, and flagging those would produce false positives.
 */
function answerNeedles(memoPart) {
  const needles = [];
  const pushNumbers = (s) => {
    for (const m of String(s).matchAll(/-?\d[\d ,.]*\d|-?\d/g)) {
      const num = m[0].replace(/\s/g, '');
      if (num.replace(/[.,]/g, '').length >= 2) needles.push(num); // ≥2 significant digits only
    }
  };

  const ans = memoPart?.solution?.answer;
  if (ans) {
    const a = norm(ans);
    if (a.length >= 3) needles.push(a);
    pushNumbers(ans);
  }
  // numeric_check.value is, by definition, the computed answer value.
  if (memoPart?.numeric_check?.value != null) pushNumbers(memoPart.numeric_check.value);
  // balance_check totals are answer-side figures.
  if (memoPart?.balance_check) {
    pushNumbers(memoPart.balance_check.debits);
    pushNumbers(memoPart.balance_check.credits);
  }

  return [...new Set(needles)];
}

function textContains(haystack, needle) {
  if (!needle) return false;
  const h = norm(haystack).replace(/\s/g, '');
  const n = needle.replace(/\s/g, '');
  return n.length >= 2 && h.includes(n);
}

/**
 * Scan the student paper for solution leakage against the memo. Strips what it
 * can (forbidden keys, a leaking `given`) and returns a check result.
 *
 * @returns {{ name, passed, failures, stripped }}
 */
export function screenStudentPaper(paper, memo) {
  const failures = [];
  let stripped = 0;

  const memoByQ = new Map((memo.questions || []).map(q => [q.questionNumber, q]));

  for (const q of paper.questions || []) {
    const memoQ = memoByQ.get(q.questionNumber);
    const memoParts = new Map((memoQ?.parts || []).map(p => [p.part, p]));

    for (const p of q.parts || []) {
      const loc = `Q${q.questionNumber}(${p.part})`;

      // 1. Forbidden memo-only keys must not be present on a student part.
      for (const key of MEMO_ONLY_KEYS) {
        if (key in p) {
          delete p[key];
          stripped++;
          failures.push({ questionNumber: q.questionNumber, part: p.part, reason: `${loc}: stripped leaked memo field "${key}" from the student paper.` });
        }
      }

      // 2. A memo answer value appearing in the GIVEN field is a leak → strip it.
      const needles = answerNeedles(memoParts.get(p.part));
      if (p.given && needles.some(n => textContains(p.given, n))) {
        failures.push({ questionNumber: q.questionNumber, part: p.part, reason: `${loc}: "given" contained an answer value — stripped.` });
        p.given = null;
        stripped++;
      }

      // 3. A memo answer value appearing in the INSTRUCTION text can't be
      //    auto-stripped without breaking the question — flag for review.
      if (needles.some(n => textContains(p.instruction, n))) {
        failures.push({ questionNumber: q.questionNumber, part: p.part, reason: `${loc}: instruction text appears to contain an answer value — review for solution leakage.` });
      }
    }
  }

  return { name: 'student_paper_leak', passed: failures.length === 0, failures, stripped };
}
