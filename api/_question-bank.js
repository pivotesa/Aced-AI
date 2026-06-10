/**
 * Fallback question bank — used when a question fails all repair attempts.
 * Each entry is a fully validated question object matching the paper JSON schema.
 *
 * Start with a stub per subject. Expand over time as curated questions are added.
 * getQuestion(subject, paper, topic, marks) returns the closest match or null.
 */

const BANK = [
  // ── Mathematics Paper 1 ──────────────────────────────────────────────────
  {
    subject: 'Mathematics', paper: 'Paper 1',
    topic: 'Calculus',
    questionNumber: 0, // renumbered at insertion
    parts: [
      {
        part: 'a',
        instruction: 'Determine f\'(x) if f(x) = 3x² − 5x + 2.',
        expression: 'f(x) = 3x^2 - 5x + 2',
        marks: 3,
        solution: {
          steps: ['Apply power rule: d/dx[xⁿ] = nxⁿ⁻¹', 'f\'(x) = 6x − 5'],
          answer: "f'(x) = 6x − 5",
          methodMarks: [
            { mark: 1, criterion: 'Differentiating 3x² correctly to 6x' },
            { mark: 1, criterion: 'Differentiating −5x correctly to −5' },
            { mark: 1, criterion: 'Correct final answer' },
          ],
        },
      },
      {
        part: 'b',
        instruction: 'Find the x-coordinate of the turning point of f.',
        expression: null,
        marks: 3,
        solution: {
          steps: ['At turning point, f\'(x) = 0', '6x − 5 = 0', 'x = 5/6'],
          answer: 'x = 5/6',
          methodMarks: [
            { mark: 1, criterion: 'Setting f\'(x) = 0' },
            { mark: 1, criterion: 'Correct equation 6x − 5 = 0' },
            { mark: 1, criterion: 'Correct solution x = 5/6' },
          ],
        },
      },
    ],
    questionTotal: 6,
  },

  // ── Mathematics Paper 1 — Algebra fallback ───────────────────────────────
  {
    subject: 'Mathematics', paper: 'Paper 1',
    topic: 'Algebra and equations',
    questionNumber: 0,
    parts: [
      {
        part: 'a',
        instruction: 'Solve for x: (x − 3)(x + 2) = 0',
        expression: '(x - 3)(x + 2) = 0',
        marks: 2,
        solution: {
          steps: ['x − 3 = 0  or  x + 2 = 0', 'x = 3  or  x = −2'],
          answer: 'x = 3 or x = −2',
          methodMarks: [
            { mark: 1, criterion: 'Both factors equated to zero' },
            { mark: 1, criterion: 'Both solutions correct' },
          ],
        },
      },
      {
        part: 'b',
        instruction: 'Solve for x: 2x² − 7x + 3 = 0',
        expression: '2x^2 - 7x + 3 = 0',
        marks: 3,
        solution: {
          steps: ['Factorise: (2x − 1)(x − 3) = 0', '2x − 1 = 0  or  x − 3 = 0', 'x = 1/2  or  x = 3'],
          answer: 'x = 1/2 or x = 3',
          methodMarks: [
            { mark: 1, criterion: 'Correct factorisation' },
            { mark: 1, criterion: 'x = 1/2' },
            { mark: 1, criterion: 'x = 3' },
          ],
        },
      },
    ],
    questionTotal: 5,
  },

  // ── Physical Sciences Physics fallback ───────────────────────────────────
  {
    subject: 'Physical Sciences', paper: 'Physics',
    topic: "Newton's Laws",
    questionNumber: 0,
    parts: [
      {
        part: 'a',
        instruction: 'State Newton\'s Second Law of Motion in words.',
        expression: null,
        marks: 2,
        solution: {
          steps: ['The net force acting on an object is directly proportional to the rate of change of momentum of the object and takes place in the direction of the net force.'],
          answer: 'The resultant/net force on an object equals the rate of change of momentum (Fnet = ma).',
          methodMarks: [
            { mark: 1, criterion: '"Net/resultant force" mentioned' },
            { mark: 1, criterion: '"Rate of change of momentum" or "F = ma" mentioned' },
          ],
        },
      },
    ],
    questionTotal: 2,
  },
];

/**
 * Returns the best matching fallback question for the given parameters,
 * or null if no suitable question exists.
 *
 * @param {string} subject
 * @param {string} paper
 * @param {string} topic - the topic that needs covering
 * @param {number} marks - desired mark value (best-effort match)
 */
export function getQuestion(subject, paper, topic, marks) {
  const topicLower = (topic || '').toLowerCase();
  const candidates = BANK.filter(q =>
    q.subject === subject &&
    q.paper === paper &&
    q.topic.toLowerCase().includes(topicLower)
  );

  if (candidates.length === 0) return null;

  // Pick the one whose total is closest to the desired mark count
  candidates.sort((a, b) =>
    Math.abs(a.questionTotal - marks) - Math.abs(b.questionTotal - marks)
  );

  return { ...candidates[0] }; // shallow clone so caller can renumber
}
