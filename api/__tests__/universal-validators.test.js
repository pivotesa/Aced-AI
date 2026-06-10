/**
 * Unit tests for the universal validator module (subject-agnostic layer).
 *
 * Item 5 known failure cases, each with a fixture:
 *   - total ≠ stated total
 *   - skipped part label (a, b, [d])  → gap
 *   - 5 marks on a single-step factorisation (mark band)
 *   - duplicate exponential equation across two questions
 *   - missing calculus topic (topic coverage)
 * Plus the clean baseline that passes every universal check.
 */

import { describe, it, expect } from 'vitest';
import {
  validateSchema,
  validateMarkArithmetic,
  validateSequentialLabels,
  validateMarkBands,
  validateNoDuplicates,
  validateTopicCoverage,
  runUniversalValidators,
} from '../_validators-universal.js';
import { getConfigById } from '../_subject-config.js';

const MATHS = getConfigById('mathematics_p1');

function part(label, marks, extra = {}) {
  return {
    part: label,
    instruction: 'Determine the requested value.',
    expression: null,
    marks,
    solution: {
      steps: ['Step 1', 'Step 2'],
      answer: '42',
      methodMarks: [{ mark: marks, criterion: 'correct' }],
    },
    ...extra,
  };
}

function question(qNum, topic, parts) {
  return { questionNumber: qNum, topic, subtopic: '', parts, questionTotal: parts.reduce((s, p) => s + p.marks, 0) };
}

/** A clean 150-mark Maths P1 paper covering every compulsory topic. */
function cleanMathsPaper() {
  const q = (n, topic, perPart = [6, 7, 6, 6]) => question(n, topic, perPart.map((m, i) => part(String.fromCharCode(97 + i), m)));
  return {
    subject: 'Mathematics', paper: 'Paper 1', totalMarks: 150, duration: '3 hours',
    questions: [
      q(1, 'Algebra and equations', [6, 7, 6, 6]),       // 25
      q(2, 'Patterns and sequences', [6, 7, 6, 6]),      // 25
      q(3, 'Functions and graphs', [6, 7, 6, 6]),        // 25
      q(4, 'Calculus', [6, 7, 6, 6]),                    // 25
      q(5, 'Financial mathematics', [6, 7, 6, 6]),       // 25
      q(6, 'Probability', [6, 7, 6, 6]),                 // 25
    ],
  };
}

describe('universal validators — clean baseline', () => {
  it('passes every universal check for a well-formed 150-mark paper', () => {
    const checks = runUniversalValidators(cleanMathsPaper(), MATHS);
    const failed = checks.filter(c => !c.passed);
    expect(failed, JSON.stringify(failed, null, 2)).toHaveLength(0);
  });
});

describe('FIXTURE: total ≠ stated total', () => {
  it('mark_arithmetic fails when question marks do not sum to paper_total', () => {
    const paper = cleanMathsPaper();
    paper.questions[5].parts[0].marks = 1; // drops paper total to 145
    paper.questions[5].questionTotal = 20;
    const r = validateMarkArithmetic(paper, MATHS);
    expect(r.passed).toBe(false);
    expect(r.failures.some(f => /total is 145 but the stated total/.test(f.reason))).toBe(true);
  });
});

describe('FIXTURE: skipped part label', () => {
  it('sequential_labels fails when a part letter is skipped (a, b, d)', () => {
    const paper = cleanMathsPaper();
    paper.questions[0].parts[2].part = 'd'; // labels become a, b, d, d → gap at position 3
    const r = validateSequentialLabels(paper);
    expect(r.passed).toBe(false);
    expect(r.failures[0].reason).toMatch(/expected "c"/);
  });

  it('sequential_labels fails when a question number is skipped (1, 2, 4)', () => {
    const paper = cleanMathsPaper();
    paper.questions[2].questionNumber = 99;
    const r = validateSequentialLabels(paper);
    expect(r.passed).toBe(false);
    expect(r.failures[0].reason).toMatch(/numbering has a gap/);
  });
});

describe('FIXTURE: 5 marks on a single-step factorisation', () => {
  it('mark_bands rejects a single_step part worth 5 marks', () => {
    const paper = cleanMathsPaper();
    paper.questions[0].parts[0] = part('a', 5, {
      instruction: 'Factorise: x² − 5x + 6.',
      difficulty: 'single_step',
    });
    const r = validateMarkBands(paper, MATHS);
    expect(r.passed).toBe(false);
    expect(r.failures[0].reason).toMatch(/single_step.*outside the band 2–3/);
  });

  it('mark_bands passes the same factorisation at 3 marks', () => {
    const paper = cleanMathsPaper();
    paper.questions[0].parts[0] = part('a', 3, { instruction: 'Factorise: x² − 5x + 6.', difficulty: 'single_step' });
    expect(validateMarkBands(paper, MATHS).passed).toBe(true);
  });
});

describe('FIXTURE: duplicate exponential equation across two questions', () => {
  it('no_duplicates flags the reused question structure', () => {
    const paper = cleanMathsPaper();
    paper.questions[0].parts[0] = part('a', 6, { instruction: 'Solve for x: 2^x = 8', expression: '2^x = 8' });
    paper.questions[1].parts[0] = part('a', 6, { instruction: 'Solve for x: 3^x = 27', expression: '3^x = 27' });
    const r = validateNoDuplicates(paper);
    expect(r.passed).toBe(false);
    expect(r.failures[0].reason).toMatch(/near-duplicate/);
  });
});

describe('FIXTURE: missing calculus topic', () => {
  it('topic_coverage fails when no question covers Calculus', () => {
    const paper = cleanMathsPaper();
    paper.questions[3].topic = 'Algebra and equations'; // Calculus question repurposed → calculus absent
    const r = validateTopicCoverage(paper, MATHS);
    expect(r.passed).toBe(false);
    expect(r.failures.some(f => /Calculus.*not covered/.test(f.reason))).toBe(true);
  });

  it('topic_coverage rejects padding one topic past its ceiling', () => {
    const paper = cleanMathsPaper();
    // Pour 75 marks into Algebra (ceiling 45) by relabelling three questions.
    paper.questions[1].topic = 'Algebra and equations';
    paper.questions[3].topic = 'Algebra and equations';
    const r = validateTopicCoverage(paper, MATHS);
    expect(r.passed).toBe(false);
    expect(r.failures.some(f => /Algebra and equations.*above its 45-mark ceiling/.test(f.reason))).toBe(true);
  });
});

describe('schema', () => {
  it('fails when a required top-level field is missing', () => {
    const paper = cleanMathsPaper();
    delete paper.totalMarks;
    expect(validateSchema(paper).passed).toBe(false);
  });
});
