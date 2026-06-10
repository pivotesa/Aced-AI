/**
 * Central configuration — all model IDs, subject rules, and tuning parameters.
 * Override GENERATION_MODEL env var to bump a subject to Sonnet if Haiku quality is insufficient.
 */

export const MODELS = {
  generation:   process.env.GENERATION_MODEL   || 'claude-haiku-4-5-20251001',
  verification: process.env.VERIFICATION_MODEL || 'claude-haiku-4-5-20251001',
  correction:   process.env.CORRECTION_MODEL   || 'claude-haiku-4-5-20251001',
  marking:      process.env.MARKING_MODEL      || 'claude-sonnet-4-6',
  tutor:        process.env.TUTOR_MODEL        || 'claude-sonnet-4-6',
  // Repair escalation: first repair attempt on Haiku (cheap), escalate to
  // Sonnet only on the final attempt if Haiku's fix still fails validation.
  repair:           process.env.REPAIR_MODEL           || 'claude-haiku-4-5-20251001',
  repairEscalation: process.env.REPAIR_ESCALATION_MODEL || 'claude-sonnet-4-6',
};

/**
 * Model for repair attempt N (0-indexed): Haiku for the first attempt, Sonnet
 * for the last. The deterministic validators decide pass/fail either way.
 */
export function repairModelForAttempt(attempt) {
  return attempt >= MAX_REPAIR_ATTEMPTS - 1 ? MODELS.repairEscalation : MODELS.repair;
}

export const MAX_TOKENS = {
  generation:   8000,
  verification: 2000,
  repair:       3000,
  correction:   3000,
};

export const MAX_REPAIR_ATTEMPTS = 2;

// ── API pricing (USD per million tokens) ───────────────────────────────────
// Used for telemetry cost estimates only — not billing.
// cacheWrite is 1.25× input; cacheRead is 0.1× input (5-minute ephemeral TTL).

export const PRICING = {
  'claude-haiku-4-5':  { input: 1.00, output: 5.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  // Baseline used for the cost-comparison field in telemetry: what the same
  // token volume would have cost on the previous single-Sonnet-call pipeline.
  baselineModel: 'claude-sonnet-4-6',
};

// ── Retry / rate-limit handling ────────────────────────────────────────────
// The org is on a low API tier (10,000 output tokens/min on Haiku), so all
// calls are made strictly sequentially with pacing, and 429/529 responses are
// retried with backoff. On 429 the retry-after header is always honoured.

export const RETRY = {
  maxAttempts: 5,
  baseDelayMs: 2000,
  maxDelayMs:  60000,
};

export const PACING = {
  minInterCallMs:         1200,  // floor between sequential calls
  minOutputTokenHeadroom: 8000,  // ≈ one generation call's max_tokens
  lowHeadroomPauseMs:     15000, // pause when the OTPM bucket is nearly drained
  maxPauseMs:             60000,
};

// ── IEB cognitive level distribution ───────────────────────────────────────
// NSC/IEB taxonomy for Mathematics-style papers:
//   1 Knowledge ~20% · 2 Routine procedures ~35% · 3 Complex procedures ~30%
//   4 Problem solving ~15%
// toleranceFraction is the allowed deviation (in fraction of total marks) per
// level — generous because a 6-question paper is coarse-grained.

export const COGNITIVE_LEVELS = {
  distribution: { 1: 0.20, 2: 0.35, 3: 0.30, 4: 0.15 },
  toleranceFraction: 0.12,
  // Only validate the distribution when at least this fraction of marks carry
  // a cognitive_level label; unlabelled parts are flagged individually.
  minLabelledFraction: 0.8,
};

// ── Subject rules ──────────────────────────────────────────────────────────
// Single source of truth — imported by generate-paper.js and validators.
// topicGroups: instruction strings for each parallel generation batch.
// marks: prescribed IEB total for this paper.
// duration: exam duration string shown on the paper header.

export const SUBJECT_RULES = {
  'Mathematics': {
    'Paper 1': {
      marks: 150, duration: '3 hours',
      topicGroups: [
        'Generate questions 1–2 on Algebra and Sequences: solving equations/inequalities, arithmetic & geometric sequences, sigma notation. Target ~50 marks.',
        'Generate questions 3–4 on Functions, Logarithms AND Calculus: graph sketching, log equations, derivatives using rules (product/chain/quotient), rate of change, optimisation. CALCULUS IS COMPULSORY — at least one part must involve differentiation. Target ~50 marks.',
        'Generate questions 5–6 on Financial Mathematics and Probability: compound interest, annuities, present/future value, counting principles, probability rules. Target ~50 marks.',
      ],
    },
    'Paper 2': {
      marks: 150, duration: '3 hours',
      topicGroups: [
        'Generate questions 1–2 on Statistics: regression, standard deviation, variance, ogives, box-and-whisker, interpretation. Target ~50 marks.',
        'Generate questions 3–4 on Analytical Geometry and Trigonometry: circles, lines, midpoints, trig equations, compound angles, general solutions. Target ~50 marks.',
        'Generate questions 5–6 on Euclidean Geometry: circle theorems, proofs, similarity, congruence, riders. Target ~50 marks.',
      ],
    },
  },
  'Physical Sciences': {
    'Physics': {
      marks: 150, duration: '3 hours',
      topicGroups: [
        "Generate questions 1–2 on Newton's Laws and Momentum: free-body diagrams, impulse, conservation of momentum, elastic/inelastic collisions. Target ~50 marks.",
        'Generate questions 3–4 on Electricity: Ohm\'s law, series/parallel circuits, power, energy, internal resistance, emf. Target ~50 marks.',
        'Generate questions 5–6 on Waves, Sound and Light: Doppler effect, EM spectrum, photoelectric effect, diffraction, interference. Target ~50 marks.',
      ],
    },
    'Chemistry': {
      marks: 150, duration: '3 hours',
      topicGroups: [
        'Generate questions 1–2 on Organic Chemistry: IUPAC naming, structural formulas, reaction types (addition, substitution, elimination, esterification), polymers. Target ~50 marks.',
        'Generate questions 3–4 on Chemical Equilibrium and Acids & Bases: Le Chatelier\'s principle, Kc expressions, pH calculations, acid–base titrations. Target ~50 marks.',
        'Generate questions 5–6 on Electrochemistry: galvanic and electrolytic cells, standard electrode potentials, EMF calculations, half-reactions. Target ~50 marks.',
      ],
    },
  },
  'English Home Language': {
    'Paper 1: Language': {
      marks: 70, duration: '2 hours',
      topicGroups: [
        'Generate questions 1–2 on Comprehension: a short passage followed by questions testing literal, inferential, and critical reading. Target ~25 marks.',
        'Generate questions 3–4 on Summary writing: a passage with a specific summary task (e.g. list 5 key points in your own words). Target ~20 marks.',
        'Generate questions 5–6 on Language Structures and Conventions: grammar, vocabulary, figures of speech, editing. Target ~25 marks.',
      ],
      qualityVerified: true, // no deterministic answer check — use LLM quality pass
    },
    'Paper 2: Literature': {
      marks: 80, duration: '2.5 hours',
      topicGroups: [
        'Generate questions 1–2 on Poetry analysis: imagery, tone, structure, diction, themes. Target ~27 marks.',
        'Generate questions 3–4 on Drama: character, theme, dramatic devices, stage directions, quotes. Target ~27 marks.',
        'Generate questions 5–6 on Prose (novel/short story): plot, character development, context, author technique. Target ~26 marks.',
      ],
      qualityVerified: true,
    },
    'Paper 3: Writing': {
      marks: 100, duration: '2.5 hours',
      topicGroups: [
        'Generate questions 1–2 on Transactional Writing: formal letter, report, speech, advertisement. Target ~33 marks.',
        'Generate questions 3–4 on Essay Writing: discursive or argumentative essay topics with rubric. Target ~33 marks.',
        'Generate questions 5–6 on Creative Writing: narrative or descriptive prompts. Target ~34 marks.',
      ],
      qualityVerified: true,
    },
  },
  'Life Sciences': {
    'Paper 1': {
      marks: 150, duration: '2.5 hours',
      topicGroups: [
        'Generate questions 1–2 on Meiosis and Genetics: stages of meiosis, Mendelian inheritance, monohybrid/dihybrid crosses, Punnett squares, codominance. Target ~50 marks.',
        'Generate questions 3–4 on DNA, RNA and Protein Synthesis: DNA structure, transcription, translation, genetic code, mutations, genetic engineering. Target ~50 marks.',
        'Generate questions 5–6 on Evolution: natural selection, evidence for evolution, speciation, Hardy-Weinberg, extinction. Target ~50 marks.',
      ],
    },
    'Paper 2': {
      marks: 150, duration: '2.5 hours',
      topicGroups: [
        'Generate questions 1–2 on the Human Nervous System and Sense Organs: neurons, reflex arc, brain structure, eye, ear, drugs and the nervous system. Target ~50 marks.',
        'Generate questions 3–4 on Homeostasis: thermoregulation, osmoregulation, blood glucose regulation, negative feedback. Target ~50 marks.',
        'Generate questions 5–6 on Human Reproduction and Responding to the Environment: male/female systems, fertilisation, hormones, foetal development, plant responses. Target ~50 marks.',
      ],
    },
  },
  'Accounting': {
    'Paper 1': {
      marks: 300, duration: '3 hours',
      topicGroups: [
        'Generate questions 1–2 on Financial Statements: income statement, balance sheet, notes to financial statements, adjustments, closing entries. Target ~100 marks.',
        'Generate questions 3–4 on Reconciliations and Internal Control: bank reconciliation, debtors/creditors control accounts, internal control procedures. Target ~100 marks.',
        'Generate questions 5–6 on Analysis and Interpretation: financial ratios (liquidity, solvency, profitability), cash flow statements, comparative analysis, audit reports. Target ~100 marks.',
      ],
    },
  },
};

// ── Required topics ────────────────────────────────────────────────────────
// At least one question per paper must cover each listed topic (case-insensitive substring match).
// Failing this check triggers topic coverage validator failure.

export const REQUIRED_TOPICS = {
  'Mathematics': {
    'Paper 1': ['algebra', 'sequences', 'functions', 'calculus', 'financial'],
    'Paper 2': ['statistics', 'analytical geometry', 'trigonometry', 'euclidean geometry'],
  },
  'Physical Sciences': {
    'Physics':    ['newton', 'momentum', 'electricity', 'circuit', 'waves'],
    'Chemistry':  ['organic', 'equilibrium', 'acid', 'electrochemistry'],
  },
  'Life Sciences': {
    'Paper 1': ['genetics', 'meiosis', 'evolution'],
    'Paper 2': ['nervous', 'homeostasis'],
  },
  'Accounting': {
    'Paper 1': ['financial statement', 'reconciliation', 'analysis'],
  },
  // English HL: topic coverage checked qualitatively by LLM, not this list
};
