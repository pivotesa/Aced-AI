/**
 * Tests for paper/memo separation and student-facing leak screening.
 */

import { describe, it, expect } from 'vitest';
import { splitPaperAndMemo, screenStudentPaper } from '../_paper-split.js';

function fullPaper() {
  return {
    subject: 'Mathematics', paper: 'Paper 1', grade: 12, totalMarks: 7, duration: '3 hours',
    questions: [{
      questionNumber: 1, topic: 'Algebra', subtopic: 'Quadratics', context: null, questionTotal: 7,
      parts: [
        {
          part: 'a', instruction: 'Solve for $x$: $2x^2 - 7x + 3 = 0$.',
          given: '$$x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$$',
          expression: '$2x^2 - 7x + 3 = 0$', marks: 3, cognitive_level: 1, difficulty: 'single_step',
          variables_used: [],
          solution: { steps: ['Factorise: $(2x-1)(x-3)=0$'], answer: '$x = \\tfrac12$ or $x = 3$', methodMarks: [{ mark: 3, criterion: 'roots' }] },
        },
        {
          part: 'b', instruction: 'The consecutive integers satisfy a relationship; find them.',
          expression: null, marks: 4, cognitive_level: 2,
          numeric_check: { expression: '12*14', value: 168, unit: '' },
          solution: { steps: ['$n^2 + 2n = 168$', '$n = 12$'], answer: '$n = 12$ and $n = 14$', methodMarks: [{ mark: 4, criterion: 'solve' }] },
        },
      ],
    }],
  };
}

describe('splitPaperAndMemo', () => {
  it('produces a student paper with NO solution/working fields', () => {
    const { paper, memo } = splitPaperAndMemo(fullPaper());

    expect(memo.questions[0].parts[0].solution).toBeDefined(); // memo keeps everything

    for (const q of paper.questions) {
      for (const p of q.parts) {
        for (const k of ['solution', 'answer', 'methodMarks', 'variables_used', 'numeric_check', 'expression', 'cognitive_level', 'difficulty']) {
          expect(p, `student part should not expose "${k}"`).not.toHaveProperty(k);
        }
        // Student part keeps only question-visible fields.
        expect(Object.keys(p).sort()).toEqual(['given', 'instruction', 'marks', 'part']);
      }
    }
  });

  it('keeps a legitimately-provided formula in `given`', () => {
    const { paper } = splitPaperAndMemo(fullPaper());
    expect(paper.questions[0].parts[0].given).toMatch(/sqrt/); // quadratic-formula stays
  });
});

describe('screenStudentPaper', () => {
  it('passes a clean split with no leaks', () => {
    const { paper, memo } = splitPaperAndMemo(fullPaper());
    const r = screenStudentPaper(paper, memo);
    expect(r.passed).toBe(true);
    expect(r.stripped).toBe(0);
  });

  it('strips an answer value that leaked into `given`', () => {
    const { paper, memo } = splitPaperAndMemo(fullPaper());
    paper.questions[0].parts[1].given = 'Hint: $n^2 + 2n = 168$'; // 168 is the answer-derivation target
    const r = screenStudentPaper(paper, memo);
    expect(r.passed).toBe(false);
    expect(paper.questions[0].parts[1].given).toBeNull(); // stripped
    expect(r.stripped).toBeGreaterThan(0);
  });

  it('strips any forbidden memo key that slips onto a student part', () => {
    const { paper, memo } = splitPaperAndMemo(fullPaper());
    paper.questions[0].parts[0].solution = { answer: 'leak' }; // simulate a leak
    const r = screenStudentPaper(paper, memo);
    expect(r.passed).toBe(false);
    expect(paper.questions[0].parts[0]).not.toHaveProperty('solution');
  });

  it('flags an answer value appearing in instruction text (cannot auto-strip)', () => {
    const { paper, memo } = splitPaperAndMemo(fullPaper());
    paper.questions[0].parts[1].instruction = 'Show that $n^2 + 2n = 168$ and solve.';
    const r = screenStudentPaper(paper, memo);
    expect(r.passed).toBe(false);
    expect(r.failures.some(f => /instruction text appears to contain an answer/.test(f.reason))).toBe(true);
  });
});
