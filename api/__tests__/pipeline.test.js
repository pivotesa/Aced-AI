/**
 * Integration tests for the orchestration flow (generateValidatedPaper) using
 * mocked API responses — no network calls.
 *
 * Covers: sequential section generation, prompt-caching structure of every
 * call, config-driven verification (universal + subject validators), targeted
 * per-question repair with Haiku→Sonnet escalation, question-bank fallback,
 * the quality-verification pass, and the verification_report.
 */

import { describe, it, expect, vi } from 'vitest';
import { generateValidatedPaper, rebalanceMethodMarks, normalizeMarks } from '../_pipeline.js';

// ── Fixture builders ─────────────────────────────────────────────────────────

function makePart(label, marks, cognitive, overrides = {}) {
  return {
    part: label,
    instruction: `Determine the value of the expression in part ${label}.`,
    expression: null,
    marks,
    cognitive_level: cognitive,
    solution: {
      steps: ['Step 1: apply the standard method', 'Step 2: simplify'],
      answer: '42',
      methodMarks: [{ mark: marks, criterion: 'Correct method and answer' }],
    },
    ...overrides,
  };
}

/** Clean question: 4 parts of 5/9/7/4 at cognitive levels 1–4 (25 marks). */
function makeQuestion(qNum, topic, markSpec = [[5, 1], [9, 2], [7, 3], [4, 4]]) {
  const letters = ['a', 'b', 'c', 'd', 'e'];
  const parts = markSpec.map(([marks, level], i) => makePart(letters[i], marks, level));
  return {
    questionNumber: qNum, topic, subtopic: 'General', context: null,
    parts, questionTotal: parts.reduce((s, p) => s + p.marks, 0),
  };
}

/** Calculus question that genuinely spans ≥2 strands (first principles + optimisation). */
function makeCalculusQuestion(qNum) {
  const parts = [
    makePart('a', 5, 1, {
      instruction: 'Determine the derivative of f(x) = x² from first principles.',
      solution: { steps: ['Using first principles: f\'(x) = lim (f(x+h)−f(x))/h', '= 2x'], answer: "f'(x) = 2x", methodMarks: [{ mark: 5, criterion: 'first principles' }] },
    }),
    makePart('b', 9, 2, {
      instruction: 'Use the differentiation rules (power rule) to find g\'(x).',
      solution: { steps: ['Apply the power rule', 'g\'(x) = 3x² − 4'], answer: "g'(x) = 3x² − 4", methodMarks: [{ mark: 9, criterion: 'differentiation rules' }] },
    }),
    makePart('c', 7, 3, {
      instruction: 'Sketch the cubic graph and identify its turning points.',
      solution: { steps: ['Find turning points', 'Sketch the cubic graph'], answer: 'turning points at x=1 and x=3', methodMarks: [{ mark: 7, criterion: 'cubic graph' }] },
    }),
    makePart('d', 4, 4, {
      instruction: 'Determine the value of x that gives the maximum area (optimisation).',
      solution: { steps: ['Optimisation: set derivative to zero', 'x = 15 gives the maximum'], answer: 'x = 15', methodMarks: [{ mark: 4, criterion: 'optimisation' }] },
    }),
  ];
  return { questionNumber: qNum, topic: 'Calculus', subtopic: 'Differential calculus', context: null, parts, questionTotal: 25 };
}

function textMessage(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    usage: { input_tokens: 1000, output_tokens: 800, cache_creation_input_tokens: 0, cache_read_input_tokens: 4200 },
  };
}

/** Mock callModel that routes on the telemetry label and records system blocks. */
function makeCallModel(routes) {
  const labels = [];
  const systems = [];
  const models = [];
  const fn = vi.fn(async (params, telemetry, { label } = {}) => {
    labels.push(label);
    systems.push(params.system);
    models.push(params.model);
    for (const [prefix, responder] of routes) {
      if (label.startsWith(prefix)) {
        const r = typeof responder === 'function' ? responder(params, label) : responder;
        if (r instanceof Error) throw r;
        return r;
      }
    }
    throw new Error(`No mock route for label: ${label}`);
  });
  return { fn, labels, systems, models };
}

const mathsSections = () => ({
  'generate:section1': [makeQuestion(1, 'Algebra'), makeQuestion(2, 'Sequences')],
  'generate:section2': [makeQuestion(3, 'Functions'), makeCalculusQuestion(4)],
  'generate:section3': [makeQuestion(5, 'Financial Mathematics'), makeQuestion(6, 'Probability')],
});

// ── Mathematics Paper 1 ──────────────────────────────────────────────────────

describe('generateValidatedPaper — Mathematics Paper 1', () => {
  it('produces a 150-mark paper passing all validators, generated sequentially, with a verification_report', async () => {
    const sections = mathsSections();
    const { fn, labels, systems } = makeCallModel([
      ['generate:', (params, label) => textMessage(sections[label])],
      ['correction', textMessage([])],
    ]);

    const telemetry = {};
    const statuses = [];
    const { paperJSON, finalValidation, verification_report } = await generateValidatedPaper({
      subject: 'Mathematics', paper: 'Paper 1', mode: 'full', telemetry,
      deps: { callModel: fn, onStatus: async (s) => statuses.push(s) },
    });

    expect(paperJSON.totalMarks).toBe(150);
    expect(paperJSON.questions).toHaveLength(6);
    expect(finalValidation.passed).toBe(true);
    expect(telemetry.repairIterations ?? 0).toBe(0);
    expect(paperJSON.questions.some(q => /calculus/i.test(q.topic))).toBe(true);

    // Strictly sequential: sections in order, then the correction pass
    expect(labels).toEqual(['generate:section1', 'generate:section2', 'generate:section3', 'correction']);
    expect(statuses).toEqual(['generating', 'validating']);

    // Prompt caching on EVERY call: identical static system block + ephemeral breakpoint
    for (const system of systems) expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(new Set(systems.map(s => s[0].text)).size).toBe(1);

    // verification_report lists universal + subject checks, all passing
    expect(verification_report.config_id).toBe('mathematics_p1');
    expect(verification_report.summary.failed).toBe(0);
    expect(verification_report.checks.some(c => c.check === 'topic_coverage' && c.layer === 'universal')).toBe(true);
    expect(verification_report.checks.some(c => c.check === 'maths_calculus_coverage' && c.layer === 'subject')).toBe(true);
    expect(verification_report.fixes_applied).toEqual([]);
  });

  it('repairs a flagged question on Haiku first, recording the fix in the report', async () => {
    const sections = mathsSections();
    const broken = makeQuestion(1, 'Algebra');
    broken.parts[0].variables_used = [{ name: 'rate', symbol: 'r', value: '12%', consumed_in: 'Step 1' }];
    sections['generate:section1'] = [broken, makeQuestion(2, 'Sequences')];
    const fixed = makeQuestion(1, 'Algebra'); // no unused variable

    const { fn, labels, models } = makeCallModel([
      ['repair:Q1', textMessage(fixed)],
      ['generate:', (params, label) => textMessage(sections[label])],
      ['correction', textMessage([])],
    ]);

    const telemetry = {};
    const { paperJSON, finalValidation, verification_report } = await generateValidatedPaper({
      subject: 'Mathematics', paper: 'Paper 1', mode: 'full', telemetry,
      deps: { callModel: fn, onStatus: async () => {} },
    });

    expect(telemetry.repairIterations).toBe(1);
    expect(labels).toContain('repair:Q1.1');
    // First repair attempt is on Haiku
    const repairModel = models[labels.indexOf('repair:Q1.1')];
    expect(repairModel).toMatch(/haiku/);
    expect(paperJSON.questions[0].parts[0].variables_used).toBeUndefined();
    expect(finalValidation.passed).toBe(true);
    expect(paperJSON.totalMarks).toBe(150);
    expect(verification_report.fixes_applied).toEqual([
      expect.objectContaining({ question: 1, action: 'regenerated', attempt: 1 }),
    ]);
  });

  it('escalates to Sonnet on the second repair attempt when Haiku fails, then falls back to the bank', async () => {
    const sections = mathsSections();
    const broken = makeQuestion(1, 'Algebra');
    broken.parts[0].variables_used = [{ name: 'rate', symbol: 'r', value: '12%', consumed_in: 'Step 1' }];
    sections['generate:section1'] = [broken, makeQuestion(2, 'Sequences')];

    const { fn, labels, models } = makeCallModel([
      ['repair:Q1', new Error('model unavailable')], // both attempts throw
      ['generate:', (params, label) => textMessage(sections[label])],
      ['correction', textMessage([])],
    ]);

    const bankQuestion = makeQuestion(1, 'Algebra');
    const getBankQuestion = vi.fn(() => bankQuestion);

    const telemetry = {};
    const { paperJSON, verification_report } = await generateValidatedPaper({
      subject: 'Mathematics', paper: 'Paper 1', mode: 'full', telemetry,
      deps: { callModel: fn, getBankQuestion, onStatus: async () => {} },
    });

    expect(telemetry.repairIterations).toBe(2); // MAX_REPAIR_ATTEMPTS
    expect(telemetry.bankFallbacksUsed).toBe(1);
    // Attempt 1 Haiku, attempt 2 Sonnet
    expect(models[labels.indexOf('repair:Q1.1')]).toMatch(/haiku/);
    expect(models[labels.indexOf('repair:Q1.2')]).toMatch(/sonnet/);
    expect(getBankQuestion).toHaveBeenCalledWith('Mathematics', 'Paper 1', 'Algebra', 25);
    expect(paperJSON.totalMarks).toBe(150);
    expect(verification_report.fixes_applied.some(f => f.action === 'bank_fallback')).toBe(true);
  });
});

// ── English HL quality verification ──────────────────────────────────────────

describe('generateValidatedPaper — English Home Language Paper 1', () => {
  // A config-valid English P1 paper: one summary section, a visual-text
  // question, an editing part with one error per mark, topics in range, 70 marks.
  function englishPaper() {
    const comp = (n) => ({
      questionNumber: n, topic: 'Comprehension', subtopic: 'Inferential reading',
      context: 'Read the following passage about urban renewal in Johannesburg...',
      parts: [
        makePart('a', 2, 1, { instruction: 'Identify two details that show the change is permanent.' }),
        makePart('b', 4, 2, { instruction: 'Explain the writer\'s attitude towards the development.' }),
        makePart('c', 4, 3, { instruction: 'Comment critically on the tone of paragraph 3.' }),
        makePart('d', 2, 2, { instruction: 'Give the meaning of the word "resilient" in context.' }),
      ],
      questionTotal: 12,
    });
    const summary = {
      questionNumber: 3, topic: 'Summary', subtopic: 'Summary writing',
      context: 'Summarise the following passage in no more than 90 words...',
      parts: [makePart('a', 10, 3, { instruction: 'Summarise the seven main points in your own words.' })],
      questionTotal: 10,
    };
    const visual = {
      questionNumber: 4, topic: 'Language use and conventions', subtopic: 'Visual and advertising text',
      context: 'Study the advertisement below for a local bank...',
      parts: [
        makePart('a', 3, 2, { instruction: 'Discuss how the advertisement uses persuasion.' }),
        makePart('b', 3, 3, { instruction: 'Comment on the visual layout of the advertisement.' }),
        makePart('c', 6, 3, { instruction: 'Critically evaluate the slogan in the advertisement.' }),
      ],
      questionTotal: 12,
    };
    const editing = {
      questionNumber: 5, topic: 'Language use and conventions', subtopic: 'Editing',
      context: null,
      parts: [{
        part: 'a',
        instruction: 'Correct the four errors in the following sentence.',
        expression: null, marks: 4, cognitive_level: 2,
        solution: {
          steps: ['who\'s → whose', 'have became → has become', 'towns\' → town\'s', 'add comma'],
          answer: 'corrected sentence',
          methodMarks: [
            { mark: 1, criterion: 'whose' }, { mark: 1, criterion: 'has become' },
            { mark: 1, criterion: 'town\'s' }, { mark: 1, criterion: 'comma' },
          ],
        },
      }],
      questionTotal: 4,
    };
    const language = {
      questionNumber: 6, topic: 'Language use and conventions', subtopic: 'Figures of speech',
      context: null,
      parts: [
        makePart('a', 10, 2, { instruction: 'Identify and explain the figures of speech in the given lines.' }),
        makePart('b', 10, 3, { instruction: 'Rewrite the passage in reported speech.' }),
      ],
      questionTotal: 20,
    };
    return {
      'generate:section1': [comp(1), comp(2)],     // Comprehension 24
      'generate:section2': [summary, visual],       // Summary 10 + Language 12
      'generate:section3': [editing, language],      // Language 4 + 20  → language total 36
    };
  }

  it('passes universal+subject validators, then runs one quality regeneration on the flagged question', async () => {
    const sections = englishPaper();
    const replacement = sections['generate:section1'][0]; // a clean comprehension question

    const { fn, labels, models } = makeCallModel([
      ['quality-repair:Q1', textMessage(replacement)],
      ['quality', textMessage({ quality_pass: false, issues: [{ questionNumber: 1, issue: 'Passage is ambiguous' }] })],
      ['generate:', (params, label) => textMessage(sections[label])],
    ]);

    const telemetry = {};
    const { paperJSON, quality, verification_report } = await generateValidatedPaper({
      subject: 'English Home Language', paper: 'Paper 1: Language', mode: 'full', telemetry,
      deps: { callModel: fn, onStatus: async () => {} },
    });

    expect(quality.quality_pass).toBe(false);
    expect(telemetry.qualityPass).toBe(false);
    expect(labels).toContain('quality');
    expect(labels).toContain('quality-repair:Q1');
    expect(labels).not.toContain('correction'); // qualitative papers skip the answer-correction pass
    expect(labels).not.toContain('repair:Q1.1'); // deterministic layer passed → no deterministic repair
    expect(models[labels.indexOf('quality-repair:Q1')]).toMatch(/haiku/);
    expect(paperJSON.totalMarks).toBe(70);
    expect(verification_report.config_id).toBe('english_hl_p1');
    expect(verification_report.fixes_applied.some(f => f.action === 'quality_regenerated')).toBe(true);
  });
});

// ── mark normalisation ───────────────────────────────────────────────────────

describe('mark normalisation keeps memos consistent', () => {
  it('rebalanceMethodMarks makes methodMarks sum to the part marks', () => {
    const p = { part: 'a', marks: 5, solution: { steps: [], answer: 'x', methodMarks: [{ mark: 2, criterion: 'a' }, { mark: 1, criterion: 'b' }] } };
    expect(rebalanceMethodMarks(p).solution.methodMarks.reduce((s, m) => s + m.mark, 0)).toBe(5);
    expect(rebalanceMethodMarks({ ...p, marks: 2 }).solution.methodMarks.reduce((s, m) => s + m.mark, 0)).toBe(2);
  });

  it('normalizeMarks hits the target and keeps every methodMark sum equal to its part marks', () => {
    const paper = { questions: [makeQuestion(1, 'Algebra'), makeCalculusQuestion(2)], totalMarks: 50 };
    const normalised = normalizeMarks(paper, 150);
    expect(normalised.totalMarks).toBe(150);
    for (const q of normalised.questions) {
      for (const p of q.parts) {
        expect(p.solution.methodMarks.reduce((s, m) => s + m.mark, 0)).toBe(p.marks);
      }
    }
  });
});
