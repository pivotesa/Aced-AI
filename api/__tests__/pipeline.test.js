/**
 * Integration tests for the orchestration flow (generateValidatedPaper) using
 * mocked API responses — no network calls.
 *
 * Covers: sequential section generation, prompt-caching structure of every
 * call, deterministic validation, targeted per-question repair, question-bank
 * fallback, and the quality-verification pass.
 */

import { describe, it, expect, vi } from 'vitest';
import { generateValidatedPaper, rebalanceMethodMarks, normalizeMarks } from '../_pipeline.js';

// ── Fixture builders ─────────────────────────────────────────────────────────

/** A clean question: 4 parts of 5/9/7/4 marks at cognitive levels 1–4 (25 total). */
function makeQuestion(qNum, topic, markSpec = [[5, 1], [9, 2], [7, 3], [4, 4]]) {
  const letters = ['a', 'b', 'c', 'd', 'e'];
  const parts = markSpec.map(([marks, level], i) => ({
    part: letters[i],
    instruction: `Determine the value of the ${topic} expression in part ${letters[i]}.`,
    expression: null,
    marks,
    cognitive_level: level,
    solution: {
      steps: ['Step 1: apply the standard method', 'Step 2: simplify'],
      answer: '42',
      methodMarks: [{ mark: marks, criterion: 'Correct method and answer' }],
    },
  }));
  return {
    questionNumber: qNum,
    topic,
    subtopic: 'General',
    context: null,
    parts,
    questionTotal: parts.reduce((s, p) => s + p.marks, 0),
  };
}

function textMessage(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    usage: { input_tokens: 1000, output_tokens: 800, cache_creation_input_tokens: 0, cache_read_input_tokens: 4200 },
  };
}

/** Mock callModel that routes on the telemetry label. */
function makeCallModel(routes) {
  const labels = [];
  const systems = [];
  const fn = vi.fn(async (params, telemetry, { label } = {}) => {
    labels.push(label);
    systems.push(params.system);
    for (const [prefix, responder] of routes) {
      if (label.startsWith(prefix)) {
        const r = typeof responder === 'function' ? responder(params, label) : responder;
        if (r instanceof Error) throw r;
        return r;
      }
    }
    throw new Error(`No mock route for label: ${label}`);
  });
  return { fn, labels, systems };
}

const MATHS_SECTIONS = {
  'generate:section1': [makeQuestion(1, 'Algebra'), makeQuestion(2, 'Sequences')],
  'generate:section2': [makeQuestion(3, 'Functions'), makeQuestion(4, 'Calculus')],
  'generate:section3': [makeQuestion(5, 'Financial Mathematics'), makeQuestion(6, 'Probability')],
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('generateValidatedPaper — Mathematics Paper 1', () => {
  it('produces a 150-mark paper passing ALL deterministic validators, generated sequentially', async () => {
    const { fn, labels, systems } = makeCallModel([
      ['generate:', (params, label) => textMessage(MATHS_SECTIONS[label])],
      ['correction', textMessage([])],
    ]);

    const telemetry = {};
    const statuses = [];
    const { paperJSON, finalValidation } = await generateValidatedPaper({
      subject: 'Mathematics', paper: 'Paper 1', mode: 'full', telemetry,
      deps: { callModel: fn, onStatus: async (s) => statuses.push(s) },
    });

    // Acceptance criterion 1: 150 marks exactly, all validators green, no repairs needed
    expect(paperJSON.totalMarks).toBe(150);
    expect(paperJSON.questions).toHaveLength(6);
    expect(finalValidation.passed).toBe(true);
    expect(telemetry.repairIterations ?? 0).toBe(0);
    expect(paperJSON.questions.some(q => /calculus/i.test(q.topic))).toBe(true);

    // Strictly sequential: sections in order, then the correction pass
    expect(labels).toEqual(['generate:section1', 'generate:section2', 'generate:section3', 'correction']);
    expect(statuses).toEqual(['generating', 'validating']);

    // Prompt caching on EVERY call: identical static system block with an
    // ephemeral cache breakpoint (byte-identical prefix = cache hit)
    for (const system of systems) {
      expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
    }
    expect(new Set(systems.map(s => s[0].text)).size).toBe(1);
  });

  it('repairs a question flagged by the unused-variable validator (targeted, per-question)', async () => {
    const broken = makeQuestion(1, 'Algebra');
    broken.parts[0].variables_used = [{ name: 'rate', symbol: 'r', value: '12%', consumed_in: 'Step 1' }];

    const fixed = makeQuestion(1, 'Algebra'); // no variables_used

    const { fn, labels } = makeCallModel([
      ['generate:section1', textMessage([broken, makeQuestion(2, 'Sequences')])],
      ['generate:section2', textMessage([makeQuestion(3, 'Functions'), makeQuestion(4, 'Calculus')])],
      ['generate:section3', textMessage([makeQuestion(5, 'Financial Mathematics'), makeQuestion(6, 'Probability')])],
      ['repair:Q1', textMessage(fixed)],
      ['correction', textMessage([])],
    ]);

    const telemetry = {};
    const { paperJSON, finalValidation } = await generateValidatedPaper({
      subject: 'Mathematics', paper: 'Paper 1', mode: 'full', telemetry,
      deps: { callModel: fn, onStatus: async () => {} },
    });

    expect(telemetry.repairIterations).toBe(1);
    expect(labels).toContain('repair:Q1.1');
    expect(paperJSON.questions[0].parts[0].variables_used).toBeUndefined();
    expect(finalValidation.passed).toBe(true); // full layer re-runs after repair
    expect(paperJSON.totalMarks).toBe(150);
  });

  it('falls back to the question bank after repair retries are exhausted', async () => {
    const broken = makeQuestion(1, 'Algebra');
    broken.parts[0].variables_used = [{ name: 'rate', symbol: 'r', value: '12%', consumed_in: 'Step 1' }];

    const { fn } = makeCallModel([
      ['generate:section1', textMessage([broken, makeQuestion(2, 'Sequences')])],
      ['generate:section2', textMessage([makeQuestion(3, 'Functions'), makeQuestion(4, 'Calculus')])],
      ['generate:section3', textMessage([makeQuestion(5, 'Financial Mathematics'), makeQuestion(6, 'Probability')])],
      ['repair:Q1', new Error('model unavailable')],
      ['correction', textMessage([])],
    ]);

    const bankQuestion = makeQuestion(1, 'Algebra');
    const getBankQuestion = vi.fn(() => bankQuestion);

    const telemetry = {};
    const { paperJSON } = await generateValidatedPaper({
      subject: 'Mathematics', paper: 'Paper 1', mode: 'full', telemetry,
      deps: { callModel: fn, getBankQuestion, onStatus: async () => {} },
    });

    expect(telemetry.repairIterations).toBe(2); // MAX_REPAIR_ATTEMPTS
    expect(telemetry.bankFallbacksUsed).toBe(1);
    expect(getBankQuestion).toHaveBeenCalledWith('Mathematics', 'Paper 1', 'Algebra', 25);
    expect(paperJSON.totalMarks).toBe(150);
  });
});

describe('generateValidatedPaper — quality verification (English HL)', () => {
  function englishSection(q1Num, topics) {
    return [
      makeQuestion(q1Num, topics[0], [[2, 1], [4, 2], [4, 3], [2, 4]]),     // 12 marks
      makeQuestion(q1Num + 1, topics[1], [[3, 1], [4, 2], [3, 3], [1, 4]]), // 11 marks
    ];
  }

  it('runs one quality call and one regeneration attempt per flagged question', async () => {
    const replacement = makeQuestion(1, 'Comprehension', [[2, 1], [4, 2], [4, 3], [2, 4]]);

    const { fn, labels } = makeCallModel([
      ['generate:section1', textMessage(englishSection(1, ['Comprehension', 'Comprehension']))],
      ['generate:section2', textMessage(englishSection(3, ['Summary', 'Summary']))],
      ['generate:section3', textMessage(englishSection(5, ['Language Structures', 'Language Structures']))],
      ['quality-repair:Q1', textMessage(replacement)],
      ['quality', textMessage({ quality_pass: false, issues: [{ questionNumber: 1, issue: 'Passage is ambiguous' }] })],
    ]);

    const telemetry = {};
    const { paperJSON, quality } = await generateValidatedPaper({
      subject: 'English Home Language', paper: 'Paper 1: Language', mode: 'full', telemetry,
      deps: { callModel: fn, onStatus: async () => {} },
    });

    expect(quality.quality_pass).toBe(false);
    expect(telemetry.qualityPass).toBe(false);
    expect(labels).toContain('quality');
    expect(labels).toContain('quality-repair:Q1');
    expect(labels).not.toContain('correction'); // qualitative papers skip the answer-correction pass
    expect(paperJSON.totalMarks).toBe(70);      // normalised to the prescribed total
  });
});

describe('mark normalisation keeps memos consistent', () => {
  it('rebalanceMethodMarks makes methodMarks sum to the part marks', () => {
    const part = {
      part: 'a', marks: 5,
      solution: { steps: [], answer: 'x', methodMarks: [{ mark: 2, criterion: 'a' }, { mark: 1, criterion: 'b' }] },
    };
    const fixed = rebalanceMethodMarks(part);
    expect(fixed.solution.methodMarks.reduce((s, m) => s + m.mark, 0)).toBe(5);

    const shrunk = rebalanceMethodMarks({ ...part, marks: 2 });
    expect(shrunk.solution.methodMarks.reduce((s, m) => s + m.mark, 0)).toBe(2);
  });

  it('normalizeMarks hits the target AND keeps every methodMark sum equal to its part marks', () => {
    const paper = {
      questions: [makeQuestion(1, 'Algebra'), makeQuestion(2, 'Calculus')], // 50 marks
      totalMarks: 50,
    };
    const normalised = normalizeMarks(paper, 150);
    expect(normalised.totalMarks).toBe(150);
    const partsTotal = normalised.questions.reduce((s, q) => s + q.parts.reduce((t, p) => t + p.marks, 0), 0);
    expect(partsTotal).toBe(150);
    for (const q of normalised.questions) {
      for (const p of q.parts) {
        const mmSum = p.solution.methodMarks.reduce((s, m) => s + m.mark, 0);
        expect(mmSum).toBe(p.marks);
      }
    }
  });
});
