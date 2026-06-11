/**
 * Prompt construction for the generation / repair / verification pipeline.
 *
 * CACHING CONTRACT (do not break):
 *  - buildSystemBlocks(subject, paper) is a PURE function of (subject, paper).
 *    Its output is byte-identical across every call for the same paper, and it
 *    carries cache_control {type:"ephemeral"} on the final block. All dynamic,
 *    per-section / per-repair content goes in the USER message, after the
 *    cache breakpoint. Never interpolate timestamps, ids, or per-call state
 *    into the system block.
 *  - On claude-haiku-4-5 the minimum cacheable prefix is 4096 tokens — the
 *    block below is deliberately rich (taxonomy + schema + few-shot examples)
 *    partly to clear that floor. If telemetry shows cache_read_input_tokens=0
 *    on second and later section calls, check the prefix hasn't shrunk or
 *    picked up dynamic bytes.
 */

import { SUBJECT_RULES, REQUIRED_TOPICS, COGNITIVE_LEVELS } from './_config.js';

// ── Subject categories ───────────────────────────────────────────────────────

function categoryOf(subject) {
  if (subject === 'Mathematics') return 'maths';
  if (subject === 'Physical Sciences') return 'physics';
  if (subject === 'Accounting') return 'accounting';
  return 'qualitative'; // English HL, Life Sciences
}

// ── JSON schema (shared shape, with per-category extensions) ────────────────

function schemaText(category) {
  const numericCheck = category === 'physics'
    ? `
      "numeric_check": {                  // REQUIRED on every calculation part
        "expression": "(0.5)*(12)*(3.2)^2", // pure arithmetic recomputing the final answer from the given values — digits and + - * / ( ) ^ only, NO symbols or units
        "value": 61.44,                   // the numeric final answer
        "unit": "J"                       // SI unit of the answer
      },`
    : '';
  const balanceCheck = category === 'accounting'
    ? `
      "balance_check": {                  // REQUIRED on every part whose memo involves a ledger, trial balance, financial statement, reconciliation or budget
        "label": "Trial balance totals",
        "debits": 482300,                 // total of the debit side / left-hand total in the memo
        "credits": 482300                 // total of the credit side / right-hand total — MUST equal debits exactly
      },`
    : '';
  const variables = (category === 'maths' || category === 'physics' || category === 'accounting')
    ? `
      "variables_used": [                 // EVERY numeric quantity introduced in the instruction text
        { "name": "initial velocity", "symbol": "v", "value": "3.2 m/s", "consumed_in": "Step 2" }
      ],`
    : '';

  return `[
  {
    "questionNumber": 1,                  // sequential, as instructed per batch
    "topic": "<curriculum topic>",        // must name the curriculum topic exactly (e.g. "Calculus")
    "subtopic": "<specific subtopic>",
    "context": null,                      // or a shared scenario/passage string for all parts
    "parts": [
      {
        "part": "a",
        "instruction": "<the question text the student sees — LaTeX maths in $...$>",
        "given": null,                    // STUDENT-VISIBLE provided material ONLY (a supplied formula, constant or data) the student is entitled to, in LaTeX, e.g. "$$A = P(1 + i)^n$$". MUST NOT contain the answer or any derived/target result. Use null when nothing extra is provided.
        "expression": null,               // MEMO-ONLY scratch equation if useful, e.g. "$2x^2 - 7x + 3 = 0$". NEVER rely on this being shown to the student — anything the student must see goes in instruction or given.
        "marks": 3,                       // integer ≥ 1
        "cognitive_level": 2,             // IEB level 1–4 (see taxonomy above)${variables}${numericCheck}${balanceCheck}
        "solution": {
          "steps": ["Step 1: ...", "Step 2: ..."],   // concise memo working, one line per step
          "answer": "<final answer with unit if applicable>",
          "methodMarks": [                // mark allocation — the sum of mark fields MUST equal "marks"
            { "mark": 1, "criterion": "<what earns this mark>" }
          ]
        }
      }
    ],
    "questionTotal": 12                   // MUST equal the sum of parts[].marks
  }
]`;
}

// ── Few-shot examples per category ──────────────────────────────────────────

const EXAMPLE_MATHS = `[
  {
    "questionNumber": 1,
    "topic": "Algebra",
    "subtopic": "Quadratic equations",
    "context": null,
    "parts": [
      {
        "part": "a",
        "instruction": "Solve for x: 2x^2 - 7x + 3 = 0",
        "expression": "2x^2 - 7x + 3 = 0",
        "marks": 3,
        "cognitive_level": 1,
        "variables_used": [],
        "solution": {
          "steps": ["Step 1: Factorise: (2x - 1)(x - 3) = 0", "Step 2: 2x - 1 = 0 or x - 3 = 0", "Step 3: x = 1/2 or x = 3"],
          "answer": "x = 1/2 or x = 3",
          "methodMarks": [
            { "mark": 1, "criterion": "Correct factorisation" },
            { "mark": 1, "criterion": "x = 1/2" },
            { "mark": 1, "criterion": "x = 3" }
          ]
        }
      },
      {
        "part": "b",
        "instruction": "An investment of R5 000 grows at 8% p.a. compounded annually. Calculate its value after 6 years.",
        "expression": "A = P(1 + i)^n",
        "marks": 4,
        "cognitive_level": 2,
        "variables_used": [
          { "name": "principal", "symbol": "P", "value": "R5 000", "consumed_in": "Step 1" },
          { "name": "interest rate", "symbol": "i", "value": "8% p.a.", "consumed_in": "Step 1" },
          { "name": "term", "symbol": "n", "value": "6 years", "consumed_in": "Step 1" }
        ],
        "solution": {
          "steps": ["Step 1: A = 5000(1 + 0.08)^6", "Step 2: A = 5000(1.586874...)", "Step 3: A = R7 934.37"],
          "answer": "R7 934.37",
          "methodMarks": [
            { "mark": 1, "criterion": "Correct formula" },
            { "mark": 2, "criterion": "Correct substitution of P, i and n" },
            { "mark": 1, "criterion": "Correct final value" }
          ]
        }
      }
    ],
    "questionTotal": 7
  }
]`;

const EXAMPLE_PHYSICS = `[
  {
    "questionNumber": 1,
    "topic": "Newton's Laws",
    "subtopic": "Net force and acceleration",
    "context": "A 12 kg crate is pulled across a frictionless horizontal floor by a horizontal force of 30 N.",
    "parts": [
      {
        "part": "a",
        "instruction": "State Newton's Second Law of Motion in words.",
        "expression": null,
        "marks": 2,
        "cognitive_level": 1,
        "variables_used": [],
        "solution": {
          "steps": ["When a net force acts on an object, the object accelerates in the direction of the net force; the acceleration is directly proportional to the net force and inversely proportional to the mass."],
          "answer": "Fnet = ma stated in words (net force, direct proportionality to acceleration, inverse to mass).",
          "methodMarks": [
            { "mark": 1, "criterion": "Net/resultant force and direction" },
            { "mark": 1, "criterion": "Proportionality to acceleration / inverse to mass" }
          ]
        }
      },
      {
        "part": "b",
        "instruction": "Calculate the acceleration of the crate.",
        "expression": "Fnet = ma",
        "marks": 3,
        "cognitive_level": 2,
        "variables_used": [
          { "name": "mass", "symbol": "m", "value": "12 kg", "consumed_in": "Step 2" },
          { "name": "applied force", "symbol": "F", "value": "30 N", "consumed_in": "Step 2" }
        ],
        "numeric_check": { "expression": "30/12", "value": 2.5, "unit": "m/s^2" },
        "solution": {
          "steps": ["Step 1: Fnet = ma", "Step 2: 30 = 12 × a", "Step 3: a = 2.5 m/s² in the direction of the force"],
          "answer": "2.5 m/s²",
          "methodMarks": [
            { "mark": 1, "criterion": "Correct formula" },
            { "mark": 1, "criterion": "Correct substitution" },
            { "mark": 1, "criterion": "Correct answer with unit" }
          ]
        }
      }
    ],
    "questionTotal": 5
  }
]`;

const EXAMPLE_ACCOUNTING = `[
  {
    "questionNumber": 1,
    "topic": "Financial Statements",
    "subtopic": "Income Statement adjustments",
    "context": "Zenith Traders' pre-adjustment trial balance on 28 February shows Sales R820 000, Cost of sales R492 000, Rent income R66 000 and Salaries R148 000. Rent of R6 000 for March was received in February.",
    "parts": [
      {
        "part": "a",
        "instruction": "Calculate the correct rent income for the year.",
        "expression": null,
        "marks": 3,
        "cognitive_level": 2,
        "variables_used": [
          { "name": "rent received", "symbol": "rent", "value": "R66 000", "consumed_in": "Step 1" },
          { "name": "rent received in advance", "symbol": "prepaid", "value": "R6 000", "consumed_in": "Step 1" }
        ],
        "solution": {
          "steps": ["Step 1: 66 000 - 6 000 (received in advance for March)", "Step 2: Rent income = R60 000"],
          "answer": "R60 000",
          "methodMarks": [
            { "mark": 2, "criterion": "Deducting the R6 000 received in advance" },
            { "mark": 1, "criterion": "Correct final figure" }
          ]
        }
      },
      {
        "part": "b",
        "instruction": "Calculate the gross profit and the net profit for the year.",
        "expression": null,
        "marks": 5,
        "cognitive_level": 3,
        "variables_used": [
          { "name": "sales", "symbol": "sales", "value": "R820 000", "consumed_in": "Step 1" },
          { "name": "cost of sales", "symbol": "COS", "value": "R492 000", "consumed_in": "Step 1" },
          { "name": "salaries", "symbol": "salaries", "value": "R148 000", "consumed_in": "Step 2" }
        ],
        "balance_check": { "label": "Net profit articulation", "debits": 388000, "credits": 388000 },
        "solution": {
          "steps": ["Step 1: Gross profit = 820 000 - 492 000 = R328 000", "Step 2: Net profit = 328 000 + 60 000 (rent) - 148 000 (salaries) = R240 000", "Step 3: Check: income side 328 000 + 60 000 = 388 000; expenses + net profit 148 000 + 240 000 = 388 000 ✓"],
          "answer": "Gross profit R328 000; Net profit R240 000",
          "methodMarks": [
            { "mark": 2, "criterion": "Gross profit calculation" },
            { "mark": 2, "criterion": "Including adjusted rent income and salaries" },
            { "mark": 1, "criterion": "Correct net profit" }
          ]
        }
      }
    ],
    "questionTotal": 8
  }
]`;

const EXAMPLE_QUALITATIVE = `[
  {
    "questionNumber": 1,
    "topic": "Comprehension",
    "subtopic": "Inferential reading",
    "context": "Read the following extract: 'The city had learned to live with the water. Walkways arched over what were once streets, and children pointed at fish where taxis used to idle.'",
    "parts": [
      {
        "part": "a",
        "instruction": "Identify TWO details from the extract that show the flooding is permanent rather than temporary.",
        "expression": null,
        "marks": 2,
        "cognitive_level": 2,
        "solution": {
          "steps": ["Permanent infrastructure ('walkways arched over what were once streets') has been built.", "Daily life has adapted ('children pointed at fish where taxis used to idle') — the change is normalised."],
          "answer": "Built walkways over former streets; everyday life (children, fish) has replaced traffic — both indicate permanence.",
          "methodMarks": [
            { "mark": 1, "criterion": "First valid detail with link to permanence" },
            { "mark": 1, "criterion": "Second valid detail with link to permanence" }
          ]
        }
      },
      {
        "part": "b",
        "instruction": "Comment critically on the effect of the contrast between 'fish' and 'taxis' in the final sentence.",
        "expression": null,
        "marks": 3,
        "cognitive_level": 4,
        "solution": {
          "steps": ["Identifies the juxtaposition of natural and mechanical imagery.", "Explains that the swap of taxis for fish emphasises how completely nature has reclaimed urban space.", "Evaluates tone — the matter-of-fact phrasing makes the transformation feel ordinary, deepening the unease."],
          "answer": "The contrast juxtaposes nature (fish) with urban machinery (taxis), showing nature's total reclamation; the calm tone normalises the change, which unsettles the reader.",
          "methodMarks": [
            { "mark": 1, "criterion": "Identifying the contrast/juxtaposition" },
            { "mark": 1, "criterion": "Explaining the effect (reclamation/replacement)" },
            { "mark": 1, "criterion": "Critical comment on tone or reader impact" }
          ]
        }
      }
    ],
    "questionTotal": 5
  }
]`;

const EXAMPLE_MATHS_2 = `[
  {
    "questionNumber": 2,
    "topic": "Calculus",
    "subtopic": "Optimisation",
    "context": "A farmer has 60 m of fencing to enclose a rectangular camp against an existing straight wall. The wall forms one long side, so only three sides need fencing. Let the width be x metres.",
    "parts": [
      {
        "part": "a",
        "instruction": "Show that the area of the camp is given by A(x) = 60x - 2x^2.",
        "expression": "A(x) = x(60 - 2x)",
        "marks": 2,
        "cognitive_level": 3,
        "variables_used": [
          { "name": "total fencing", "symbol": "60", "value": "60 m", "consumed_in": "Step 1" },
          { "name": "width", "symbol": "x", "value": "x m", "consumed_in": "Step 1" }
        ],
        "solution": {
          "steps": ["Step 1: length = 60 - 2x (two widths of x leave 60 - 2x for the side parallel to the wall)", "Step 2: A(x) = x(60 - 2x) = 60x - 2x^2"],
          "answer": "A(x) = 60x - 2x^2 (shown)",
          "methodMarks": [
            { "mark": 1, "criterion": "Length expressed as 60 - 2x" },
            { "mark": 1, "criterion": "Area expanded correctly" }
          ]
        }
      },
      {
        "part": "b",
        "instruction": "Calculate the value of x for which the area is a maximum, and state the maximum area.",
        "expression": "A'(x) = 60 - 4x",
        "marks": 4,
        "cognitive_level": 3,
        "variables_used": [],
        "solution": {
          "steps": ["Step 1: A'(x) = 60 - 4x", "Step 2: At maximum, A'(x) = 0, so 60 - 4x = 0", "Step 3: x = 15 m", "Step 4: A(15) = 60(15) - 2(15)^2 = 900 - 450 = 450 m²"],
          "answer": "x = 15 m; maximum area = 450 m²",
          "methodMarks": [
            { "mark": 1, "criterion": "Correct derivative" },
            { "mark": 1, "criterion": "Setting derivative equal to zero" },
            { "mark": 1, "criterion": "x = 15" },
            { "mark": 1, "criterion": "Maximum area 450 m² with unit" }
          ]
        }
      }
    ],
    "questionTotal": 6
  }
]`;

const EXAMPLE_PHYSICS_2 = `[
  {
    "questionNumber": 2,
    "topic": "Momentum",
    "subtopic": "Conservation of linear momentum",
    "context": "Trolley A of mass 2 kg moving east at 3 m/s collides head-on with stationary trolley B of mass 4 kg. After the collision the trolleys move off together.",
    "parts": [
      {
        "part": "a",
        "instruction": "State the principle of conservation of linear momentum in words.",
        "expression": null,
        "marks": 2,
        "cognitive_level": 1,
        "variables_used": [],
        "solution": {
          "steps": ["The total linear momentum of an isolated system remains constant (is conserved) in both magnitude and direction."],
          "answer": "Total momentum of an isolated/closed system remains constant.",
          "methodMarks": [
            { "mark": 1, "criterion": "Total momentum constant/conserved" },
            { "mark": 1, "criterion": "Isolated/closed system (no external net force)" }
          ]
        }
      },
      {
        "part": "b",
        "instruction": "Calculate the velocity of the combined trolleys immediately after the collision.",
        "expression": "m1*v1 + m2*v2 = (m1 + m2)*v",
        "marks": 4,
        "cognitive_level": 2,
        "variables_used": [
          { "name": "mass of trolley A", "symbol": "m1", "value": "2 kg", "consumed_in": "Step 2" },
          { "name": "velocity of trolley A", "symbol": "v1", "value": "3 m/s east", "consumed_in": "Step 2" },
          { "name": "mass of trolley B", "symbol": "m2", "value": "4 kg", "consumed_in": "Step 2" }
        ],
        "numeric_check": { "expression": "(2*3 + 4*0)/(2 + 4)", "value": 1, "unit": "m/s" },
        "solution": {
          "steps": ["Step 1: Σp(before) = Σp(after)", "Step 2: (2)(3) + (4)(0) = (2 + 4)v", "Step 3: 6 = 6v", "Step 4: v = 1 m/s east"],
          "answer": "1 m/s east",
          "methodMarks": [
            { "mark": 1, "criterion": "Conservation of momentum stated/applied" },
            { "mark": 2, "criterion": "Correct substitution both sides" },
            { "mark": 1, "criterion": "Correct answer with unit and direction" }
          ]
        }
      }
    ],
    "questionTotal": 6
  }
]`;

const EXAMPLE_ACCOUNTING_2 = `[
  {
    "questionNumber": 2,
    "topic": "Reconciliations",
    "subtopic": "Bank reconciliation",
    "context": "Marang Stores' bank statement on 31 May shows a favourable balance of R18 400. Comparison with the records shows: outstanding deposit R7 200; cheque no. 412 for R3 950 not yet presented; bank charges of R310 not yet recorded in the CPJ; a debit order of R890 for insurance not yet recorded.",
    "parts": [
      {
        "part": "a",
        "instruction": "Calculate the correct bank balance in the books on 31 May, starting from the provisional bank account balance of R22 850.",
        "expression": null,
        "marks": 4,
        "cognitive_level": 2,
        "variables_used": [
          { "name": "provisional bank balance", "symbol": "balance", "value": "R22 850", "consumed_in": "Step 1" },
          { "name": "bank charges", "symbol": "charges", "value": "R310", "consumed_in": "Step 1" },
          { "name": "insurance debit order", "symbol": "insurance", "value": "R890", "consumed_in": "Step 1" }
        ],
        "balance_check": { "label": "Bank reconciliation statement", "debits": 21650, "credits": 21650 },
        "solution": {
          "steps": ["Step 1: 22 850 - 310 (bank charges) - 890 (insurance) = R21 650", "Step 2: Reconciliation: statement 18 400 + outstanding deposit 7 200 - outstanding cheque 3 950 = R21 650 ✓ (both sides equal)"],
          "answer": "R21 650",
          "methodMarks": [
            { "mark": 1, "criterion": "Bank charges deducted" },
            { "mark": 1, "criterion": "Debit order deducted" },
            { "mark": 1, "criterion": "Correct book balance R21 650" },
            { "mark": 1, "criterion": "Reconciliation to the bank statement side" }
          ]
        }
      }
    ],
    "questionTotal": 4
  }
]`;

const EXAMPLE_QUALITATIVE_2 = `[
  {
    "questionNumber": 2,
    "topic": "Language Structures and Conventions",
    "subtopic": "Editing and figures of speech",
    "context": "Study this sentence from a community newsletter: 'The clinic, who's queues snake around the block before dawn, have became a second home for the towns' pensioners.'",
    "parts": [
      {
        "part": "a",
        "instruction": "Rewrite the sentence, correcting ALL FOUR grammatical errors.",
        "expression": null,
        "marks": 4,
        "cognitive_level": 2,
        "solution": {
          "steps": ["who's → whose (possessive relative pronoun)", "have became → has become (concord with singular 'clinic' + correct past participle)", "towns' → town's (singular possessive)", "Corrected: 'The clinic, whose queues snake around the block before dawn, has become a second home for the town's pensioners.'"],
          "answer": "The clinic, whose queues snake around the block before dawn, has become a second home for the town's pensioners.",
          "methodMarks": [
            { "mark": 1, "criterion": "whose" },
            { "mark": 1, "criterion": "has (concord)" },
            { "mark": 1, "criterion": "become (participle)" },
            { "mark": 1, "criterion": "town's (apostrophe)" }
          ]
        }
      },
      {
        "part": "b",
        "instruction": "Identify the figure of speech in 'queues snake around the block' and comment on its effectiveness.",
        "expression": null,
        "marks": 3,
        "cognitive_level": 3,
        "solution": {
          "steps": ["Identifies metaphor (or personification accepted with justification).", "The queues are compared to a snake — long, winding, slow-moving.", "Effective: conveys the length and sluggishness of the queues and a sense of weary endurance."],
          "answer": "Metaphor — the queue is implicitly compared to a snake, suggesting its winding length and slow movement; effective in evoking the pensioners' long wait.",
          "methodMarks": [
            { "mark": 1, "criterion": "Correct identification" },
            { "mark": 1, "criterion": "Explaining the comparison" },
            { "mark": 1, "criterion": "Valid comment on effectiveness" }
          ]
        }
      }
    ],
    "questionTotal": 7
  }
]`;

const EXAMPLES = {
  maths: `${EXAMPLE_MATHS}\n\nA second correctly structured example:\n${EXAMPLE_MATHS_2}`,
  physics: `${EXAMPLE_PHYSICS}\n\nA second correctly structured example:\n${EXAMPLE_PHYSICS_2}`,
  accounting: `${EXAMPLE_ACCOUNTING}\n\nA second correctly structured example:\n${EXAMPLE_ACCOUNTING_2}`,
  qualitative: `${EXAMPLE_QUALITATIVE}\n\nA second correctly structured example:\n${EXAMPLE_QUALITATIVE_2}`,
};

// ── Curriculum taxonomy slices (static per subject) ─────────────────────────
// Embedded in the cached system block so every section call shares one large,
// byte-identical prefix. Keep this content static — never interpolate
// per-call values here.

const SUBJECT_TAXONOMY = {
  'Mathematics': `
Algebra and Equations: exponents and surds; quadratic equations (factorisation, completing the square, quadratic formula); quadratic inequalities; simultaneous equations (one linear, one quadratic); nature of roots and the discriminant; exponential equations; equations with fractions and restrictions.
Sequences and Series: arithmetic sequences and series (Tn, Sn); geometric sequences and series; sum to infinity and convergence (-1 < r < 1); sigma notation; combined/mixed sequence problems; quadratic (second-difference) patterns.
Functions and Graphs: the parabola y = a(x+p)² + q; the hyperbola y = a/(x+p) + q; exponential functions y = ab^(x+p) + q; logarithmic functions and the inverse relationship between y = b^x and y = log_b x; inverses of linear, quadratic (restricted domain) and exponential functions; transformations, axes of symmetry, asymptotes, domain and range; interpreting and sketching combined graphs; average gradient.
Financial Mathematics: simple and compound growth and decay; nominal vs effective interest rates; future value and present value annuities; sinking funds; loan amortisation, outstanding balance and final payments; timeline problems with deposits, withdrawals and interest-rate changes.
Differential Calculus: limits (intuitive); the derivative from first principles; rules of differentiation (power rule, sum/difference); equations of tangents to curves; cubic functions — sketching, turning points, points of inflection, x-intercepts and the factor/remainder theorem; optimisation (maxima/minima) in real contexts; rates of change including motion (s, v, a).
Probability: revision of rules — addition rule, complementary and mutually exclusive events; independent and dependent events; Venn diagrams (2 and 3 sets); tree diagrams and contingency tables; the fundamental counting principle (arrangements, codes, letters, digits, restrictions); probability problems using the counting principle.`,
  'Physical Sciences': `
Mechanics: Newton's first, second and third laws; types of forces (weight, normal, friction static and kinetic, tension, applied); free-body diagrams; Newton's law of universal gravitation; momentum and impulse (p = mv, FnetΔt = Δp); conservation of linear momentum in collisions and explosions; elastic vs inelastic collisions (kinetic energy check); vertical projectile motion (equations of motion, graphs of x/v/a vs t); work, energy and power (work-energy theorem, conservative and non-conservative forces, Wnc = ΔEk + ΔEp, power P = W/Δt = Fv).
Waves, Sound and Light: the Doppler effect with sound (moving source/listener, fD = v±vL / v∓vS × fS), applications (radar, medicine, red/blue shift); the photoelectric effect (work function, threshold frequency, E = hf, Ekmax = hf − W0); emission and absorption spectra.
Electricity and Magnetism: electrostatics (Coulomb's law, electric fields E = F/q = kQ/r²); electric circuits — Ohm's law, series and parallel resistors, internal resistance and emf (ε = I(R + r)), power and energy (P = VI = I²R = V²/R), cost of electricity; electrodynamics — generators (AC/DC), motors, alternating current, rms values (Vrms = Vmax/√2), average power.
Chemistry (where applicable): organic molecules — IUPAC nomenclature (alkanes to carboxylic acids and esters), isomers, physical properties and intermolecular forces, addition/elimination/substitution reactions, esterification; reaction rate and collision theory; chemical equilibrium and Le Chatelier's principle, Kc calculations; acids and bases (Arrhenius/Lowry-Brønsted, pH, Ka/Kb strength, titrations, hydrolysis of salts); electrochemistry — galvanic and electrolytic cells, standard electrode potentials, cell notation, EMF°cell = E°cathode − E°anode, electrolysis applications.`,
  'Accounting': `
Financial Statements of Companies: Income Statement (Statement of Comprehensive Income) with year-end adjustments (depreciation, bad debts, accruals, prepayments, trading stock deficit); Balance Sheet (Statement of Financial Position) and notes (share capital, retained income, fixed assets, trade and other receivables/payables); audit reports (unqualified, qualified, disclaimer) and corporate governance.
Fixed Assets: asset disposal at the beginning/during/end of the year; depreciation methods (cost/straight-line, diminishing balance); fixed asset note articulation.
Inventory Systems and Valuation: perpetual vs periodic systems; FIFO, weighted average and specific identification; effects of valuation method on profit; stock holding period.
Reconciliations and Internal Control: bank reconciliation statements (outstanding deposits, outstanding cheques, errors, post-dated cheques); debtors and creditors control account reconciliations; debtors age analysis; internal control and division of duties; ethics.
Manufacturing: production cost statements; direct/indirect costs; work-in-progress; unit costs and break-even analysis.
Budgeting: cash budgets vs projected income statements; debtors collection and creditors payment schedules; analysis of variances.
Cash Flow and Interpretation: Cash Flow Statement (operating, investing, financing activities); financial indicators — gross profit %, operating profit %, net profit %, current ratio, acid-test ratio, stock turnover rate, debt-equity ratio, return on shareholders' equity, earnings per share, dividends per share, net asset value; commenting on liquidity, solvency, profitability, gearing and dividend policy.`,
  'English Home Language': `
Comprehension: literal retrieval; inferential reading (implications, attitudes, motives); evaluative and critical reading (bias, assumptions, effectiveness of style); vocabulary in context; interpreting visual texts (cartoons, advertisements) — body language, irony, persuasive techniques.
Summary: extracting main ideas; writing within a word limit in own words; coherent point selection.
Language Structures and Conventions: parts of speech; sentence types and construction (simple, compound, complex); active and passive voice; direct and indirect speech; punctuation; concord; ambiguity and malapropisms; figures of speech (simile, metaphor, personification, hyperbole, euphemism, irony, sarcasm, oxymoron, paradox, pun, litotes); editing and error correction; critical language awareness (emotive language, bias, manipulation).
Literary Analysis (Paper 2): poetry — imagery, diction, tone, mood, rhythm, rhyme, enjambment, structure, themes, sound devices; drama — characterisation, dramatic irony, stage directions, conflict, themes, quotation-based analysis; prose — narrative voice, plot and subplot, character development, setting, symbolism, themes, authorial technique.
Writing (Paper 3): transactional texts — formal/informal letters, CVs and obituaries, reports, speeches, dialogues, reviews, advertisements (format, register, audience); essays — narrative, descriptive, discursive, argumentative, reflective (planning, structure, coherence, originality, register).`,
  'Life Sciences': `
DNA, RNA and Protein Synthesis: DNA structure (nucleotides, complementary base pairing) and replication; types and structure of RNA; transcription and translation; the triplet code and codons; mutations (gene and chromosomal) and their consequences; DNA profiling and genetic engineering applications.
Meiosis and Reproduction: stages of meiosis I and II; crossing over and non-disjunction (Down syndrome); importance of meiosis for variation; human reproductive systems; gametogenesis; menstrual cycle hormones (FSH, LH, oestrogen, progesterone); fertilisation and implantation; gestation and the placenta.
Genetics and Inheritance: Mendel's laws; monohybrid and dihybrid crosses; complete, incomplete and co-dominance; multiple alleles (blood groups); sex-linked inheritance (haemophilia, colour-blindness); pedigree diagrams; mutations as a source of variation; genetic counselling.
Responding to the Environment (Humans): structure and functioning of the nervous system (neurons, reflex arc, brain regions, autonomic nervous system); receptors — the eye (accommodation, pupillary mechanism, defects) and the ear (hearing and balance); effects of drugs; the endocrine system (glands and hormones); homeostasis — negative feedback control of glucose, temperature, water and salts (ADH, aldosterone, insulin, glucagon, thyroxin).
Evolution: sources of variation; Lamarck vs Darwin; natural selection and speciation (geographic isolation); punctuated equilibrium vs gradualism; evidence for evolution including fossil record; human evolution — anatomical comparisons (skull, pelvis, foramen magnum, bipedalism), out-of-Africa hypothesis.`,
};

// ── Paper assembly and style guidance (static, shared) ──────────────────────

const ASSEMBLY_GUIDANCE = `
Question and paper assembly:
- Parts within a question ramp in difficulty: open with an accessible part (level 1–2) and close with the most demanding part (level 3–4). The first question of a section is gentler than the last.
- Parts of one question may share a context/scenario, but each part must be independently answerable — a student who cannot do part (a) must still be able to attempt part (b) unless the part explicitly builds on a "show that" result (in which case the result to use is GIVEN in the part text).
- Never reference material from another question ("use your answer from Question 2") — sections are assembled independently.
- Scenario realism: numbers, prices, distances and quantities must be plausible for the South African context (e.g. realistic Rand prices, realistic municipal/household figures). Names should reflect South African diversity.
- Avoid cultural, regional or gender bias; avoid contexts requiring outside knowledge a Grade 12 learner may not have.
- Language: clear, formal examination register. One instruction per part. No double-barrelled questions unless mark allocation separates them. Define any symbol the first time it is used.
- Diagrams cannot be rendered: never set a question that REQUIRES an unseen diagram. Where a figure would normally appear, describe it fully and precisely in "context" (coordinates, labels, given measurements) so the question is answerable from text alone.
- Difficulty calibration for Grade 12 (matric final): level 2 parts should be solvable in 1–2 minutes per mark by a prepared candidate; level 4 parts may require insight but never content outside the taxonomy above.

Self-check before emitting JSON (do this mentally — output only the JSON):
1. Does every part's methodMarks sum equal its marks? 2. Does every questionTotal equal the sum of its part marks? 3. Does the batch hit its mark target exactly? 4. Is every given numeric value consumed in the memo? 5. Are all "solve" answers rational? 6. Is the JSON syntactically valid with no trailing commas?`;

// ── Notation conventions (static, shared) ────────────────────────────────────

const NOTATION_CONVENTIONS = `
Notation — ALL mathematics MUST be written as LaTeX wrapped in dollar delimiters so the frontend can render it with KaTeX. This applies to "instruction", "given", "context", solution "steps" and "answer".
- Inline maths: wrap in single dollars, e.g. $3^{x+1}$, $\\frac{2}{x-1}$, $\\sqrt{x+5}$, $\\log_2 x$, $\\sum_{k=1}^{10} k$, $x^2 - 7x + 3 = 0$, $f'(x)$, $\\frac{dy}{dx}$.
- Display maths (a centred equation on its own line): wrap in double dollars, e.g. $$A = P(1 + i)^n$$.
- Powers as ^{...}, fractions as \\frac{a}{b}, roots as \\sqrt{...}, subscripts as _{...}, Greek as \\theta \\pi \\Delta, degrees as ^\\circ, multiplication as \\times, plus/minus as \\pm. NEVER write a bare ^ or _ outside dollars, and never use plain "x^2" or unicode "²" — always LaTeX inside dollars.
- Escape every backslash for JSON: a single LaTeX backslash is written as \\\\ in the JSON string (so \\frac becomes \\\\frac in the raw JSON).
- NON-maths text stays plain (do not wrap whole sentences in dollars) — only wrap the mathematical fragments.
- Currency: Rand as plain text "R5 000" (capital R, space thousands separator) — NOT maths. Percentages as "8% p.a.".
- Units: render with LaTeX where attached to a value, e.g. $2.5 \\text{ m/s}^2$, $61.44 \\text{ J}$; units in numeric answers are mandatory.
- Scientific notation as $3 \\times 10^{8}$. Coordinates as $(x ; y)$; intervals as $x \\in [2 ; 5)$. General solutions include $k \\in \\mathbb{Z}$.
- Chemical formulas with subscripts as LaTeX, e.g. $H_2SO_4$, $CH_3COOH$; balance equations with state symbols where required.
- Question parts are lettered a, b, c…; sub-parts only where genuinely needed, numbered (i), (ii).`;

// ── IEB marking conventions (static, shared) ─────────────────────────────────

const MARKING_CONVENTIONS = `
Memoranda follow IEB marking conventions:
- Method (M) marks: awarded for a correct method/formula/approach even if arithmetic later fails.
- Accuracy (A) marks: awarded for correct values arising from a correct method.
- Continued Accuracy (CA) marks: a candidate who carries an earlier error forward correctly still earns subsequent marks — write memo steps so a marker can apply CA marking.
- One mark per creditable step: a part worth n marks must have exactly n creditable, independently identifiable steps/criteria in methodMarks.
- Units: final numeric answers carry units; the unit is typically bound to the answer mark.
- Rounding: final answers to two decimal places unless the question specifies otherwise; do not round intermediate values in the memo working.
- Answer-only: where a question says "write down", full marks for the correct answer without working; where it says "show that" or "calculate", working is required and the memo must show it.
- Positive marking: criteria are phrased for what EARNS the mark, not what loses it.
- Question phrasing verbs map to expectations: "write down" (no working), "calculate/determine" (working required), "show that" (full derivation toward a given result), "prove" (formal argument), "explain/comment" (linked reasoning, not a bare fact).`;

// ── Documented failure modes (static, shared) ────────────────────────────────

const FAILURE_MODES = `
The following failure modes are checked PROGRAMMATICALLY after you respond — a violation triggers a repair cycle, so avoid them outright:
1. Mark total mismatch: part marks must sum to questionTotal; questionTotals must sum to the prescribed paper total; methodMarks must sum to part marks. Plan the mark distribution BEFORE writing questions.
2. Missing compulsory topics: the listed required topics must each appear as a question "topic". Never silently substitute a different topic.
3. Irrational solutions where exact answers are implied: "solve" questions are validated symbolically — quadratics must have perfect-square discriminants. Always construct backwards from chosen rational roots.
4. Unused variables: any quantity given in the question but absent from the memo working fails validation. Every given value must be consumed in a named step.
5. Inconsistent numeric/balance checks: numeric_check expressions are re-evaluated and balance_check debits/credits are compared programmatically — they must match the memo exactly.
6. Invalid JSON: a single trailing comma, unescaped quote or markdown fence makes the whole response unusable. Output raw JSON only.
7. Solution leakage: the student sees ONLY "instruction" and "given". NEVER place the answer, a derived target equation, or worked steps in "instruction" or "given". If a question asks the student to derive an equation (e.g. "show that $n^2 + 2n = 168$"), that target belongs in the solution/steps, not pre-printed under the question. Keep all answers and working inside "solution".`;

// ── Category-specific construction rules ────────────────────────────────────

function categoryRules(category) {
  const common = [
    '- The sum of methodMarks[].mark in every part MUST equal that part\'s "marks" value exactly. Allocate one criterion per mark or group marks per criterion, but the arithmetic must balance.',
    '- "questionTotal" MUST equal the sum of the part marks in that question.',
    '- Every part MUST carry a "cognitive_level" of 1, 2, 3 or 4 following the IEB taxonomy above, and the batch as a whole should track the prescribed distribution.',
    '- Use South African context (Rand amounts, local names and places) where a scenario is needed.',
    '- Mark allocations follow IEB convention: 1 mark per distinct step of working/insight; method marks (M), accuracy marks (A) and continued-accuracy (CA) thinking applies — a part worth n marks needs n creditable steps in the memo.',
  ];

  if (category === 'maths') {
    return [
      ...common,
      '- EXACT-ANSWER CONSTRUCTION (critical): for any quadratic, simultaneous equations, or factorisation question where the student must "solve", construct the question BACKWARDS from chosen rational roots. Pick the roots first (integers or simple fractions, e.g. x = 2 and x = -3), expand to get the equation, and only then write the question. NEVER write a "solve" question whose discriminant is not a perfect square. Surd answers are only acceptable when the instruction explicitly says "leave your answer in surd/simplest surd form".',
      '- Every numeric quantity introduced in the instruction or context MUST be listed in "variables_used" and consumed in a named solution step. Never introduce a value the memo does not use.',
      '- Calculus questions must include genuine differentiation (first principles or rules) — not merely the word calculus.',
      '- Show working line by line; each step must follow algebraically from the previous one.',
    ];
  }
  if (category === 'physics') {
    return [
      ...common,
      '- Every calculation part MUST include a "numeric_check" object: a pure-arithmetic expression (digits and + - * / ( ) ^ only) that recomputes the final numeric answer from the given values, plus the numeric "value" and "unit". The expression is verified programmatically — it must evaluate to the answer.',
      '- Choose given values so answers come out to clean 2–4 significant-figure numbers with physically reasonable magnitudes (no 10^9 m/s velocities, no negative masses).',
      '- Every numeric quantity in the question MUST appear in "variables_used" and be consumed in the memo.',
      '- Use g = 9.8 m/s² and state formulas before substitution, per IEB marking convention (formula mark, substitution mark, answer-with-unit mark).',
    ];
  }
  if (category === 'accounting') {
    return [
      ...common,
      '- BALANCED CONSTRUCTION (critical): build every ledger / trial balance / financial statement / cash budget question BACKWARDS from a balanced set of figures. Decide the balanced totals first, derive the individual line items from them, then write the question. The memo must articulate (totals reconcile).',
      '- Every part whose memo involves a ledger account, trial balance, financial statement section, reconciliation or budget MUST include a "balance_check" object whose debits and credits are equal — these are verified programmatically.',
      '- Every figure given in the scenario MUST appear in "variables_used" and be consumed in the memo.',
    ];
  }
  // qualitative
  return [
    ...common,
    '- Passages/extracts go in "context" and must be original (never quote copyrighted literature verbatim — write in the style of the genre instead). Comprehension passages: 250–450 words, contemporary South African or universal subject matter, titled, with numbered paragraphs referred to as "paragraph 1", "paragraph 2" etc. in the questions.',
    '- Questions must be answerable purely from the provided context plus curriculum knowledge. Never ask about a specific prescribed setwork by name (students study different setworks) — for literature-style questions, provide the extract or poem in "context" and question it as an unseen text.',
    '- Memos for open-response questions list the creditable points; phrase criteria so a marker can apply them objectively. For interpretation questions, the memo must state the expected point AND acceptable alternative readings.',
    '- Question-verb conventions: "identify/name/list" (1 mark per item, no explanation); "explain/describe" (point + elaboration, typically 2 marks); "discuss/comment critically/evaluate" (point + evidence + effect/judgement, typically 3 marks); "compare" requires both sides plus the relationship.',
    '- Transactional writing tasks must specify: text type, audience, purpose, register and length, and the memo lists the format features markers credit (e.g. formal letter: addresses, date, salutation, subject line, paragraphed body, closing).',
    '- Essay prompts must be open enough for multiple valid approaches and the memo describes the assessment focus (content/planning, language/style, structure) rather than one "correct" essay.',
    '- For source-based/diagram-based science questions, describe the data table or experimental setup fully in "context" with actual numbers, so the question stands without an image, and ask for trends, explanations and conclusions in line with the verb conventions above.',
    '- Summary tasks: state the word limit, the focus of the summary, and provide a memo listing the 7 distinct points with acceptable paraphrases.',
  ];
}

// ── System block builder ────────────────────────────────────────────────────

/**
 * Returns the system blocks for ALL pipeline calls (generation, repair,
 * correction, quality verification) for a given subject+paper. The single
 * static block carries the cache breakpoint.
 */
export function buildSystemBlocks(subject, paper) {
  const category = categoryOf(subject);
  const rules = SUBJECT_RULES[subject]?.[paper] || {};
  const required = REQUIRED_TOPICS[subject]?.[paper] || [];
  const dist = COGNITIVE_LEVELS.distribution;

  const text = [
    `You are an expert IEB (Independent Examinations Board) Grade 12 ${subject} examiner and paper setter for South African matric students. You produce examination questions and marking memoranda of authentic IEB standard for: ${subject} — ${paper}.`,
    '',
    '════════ OUTPUT CONTRACT ════════',
    'You output ONLY valid JSON conforming exactly to the schema below.',
    '- No markdown fences. No preamble. No commentary before or after the JSON.',
    '- When asked for multiple questions: a JSON array of question objects.',
    '- When asked to fix a single question: a single JSON question object (no array wrapper).',
    '- All strings must be valid JSON strings (escape internal quotes).',
    '',
    '════════ PAPER STRUCTURE ════════',
    `Paper: ${subject} ${paper}` + (rules.marks ? ` — total ${rules.marks} marks, duration ${rules.duration}.` : '.'),
    'The full paper is generated section by section. The sections are:',
    ...(rules.topicGroups || []).map((g, i) => `  Section ${i + 1}: ${g}`),
    required.length
      ? `Compulsory topic coverage (validated programmatically): every one of [${required.join(', ')}] must appear as the "topic" of at least one question across the paper.`
      : 'Topic coverage for this paper is assessed qualitatively.',
    '',
    '════════ CURRICULUM TAXONOMY ════════',
    `The IEB Grade 12 ${subject} curriculum covers the following topics and subtopics. Set questions strictly inside this taxonomy and name the "topic" field from it:`,
    SUBJECT_TAXONOMY[subject] || 'Use the official IEB curriculum for this subject.',
    '',
    '════════ IEB COGNITIVE LEVEL TAXONOMY ════════',
    'Tag every part with "cognitive_level" and weight the paper as follows (validated within tolerance):',
    `  Level 1 — Knowledge / recall (straight recall, basic facts, definitions): ~${Math.round(dist[1] * 100)}% of marks`,
    `  Level 2 — Routine procedures (well-known algorithms and single-step applications): ~${Math.round(dist[2] * 100)}% of marks`,
    `  Level 3 — Complex procedures (multi-step problems, connections between topics, no obvious route): ~${Math.round(dist[3] * 100)}% of marks`,
    `  Level 4 — Problem solving / critical evaluation (unseen, non-routine, higher-order reasoning): ~${Math.round(dist[4] * 100)}% of marks`,
    '',
    '════════ IEB MARKING CONVENTIONS ════════',
    MARKING_CONVENTIONS,
    '',
    '════════ NOTATION ════════',
    NOTATION_CONVENTIONS,
    '',
    '════════ ASSEMBLY AND STYLE ════════',
    ASSEMBLY_GUIDANCE,
    '',
    '════════ CONSTRUCTION RULES ════════',
    ...categoryRules(category),
    '',
    '════════ VALIDATED FAILURE MODES ════════',
    FAILURE_MODES,
    '',
    '════════ JSON SCHEMA ════════',
    'Each question object must match this shape exactly (comments are explanatory — do not output them):',
    schemaText(category),
    '',
    '════════ EXAMPLE OF A CORRECTLY STRUCTURED QUESTION ════════',
    EXAMPLES[category],
    '',
    '════════ REPAIR MODE ════════',
    'When the user message contains "VALIDATION FAILURES TO FIX", you are repairing ONE question:',
    '- Fix ONLY the listed issues. Preserve the questionNumber, topic and overall mark value.',
    '- Irrational/surd answer flagged: choose new rational roots first, reconstruct the equation from them, and rewrite question + memo consistently.',
    '- Unused variable flagged: either consume the variable in the memo or remove it from the question text and variables_used.',
    '- Mark-sum mismatch flagged: adjust methodMarks so they sum exactly to the part marks.',
    '- numeric_check / balance_check mismatch flagged: recompute and make question, memo and check consistent.',
    '- Return the single corrected question object as JSON only.',
    '',
    '════════ QUALITY REVIEW MODE ════════',
    'When the user message contains "QUALITY REVIEW", you are reviewing (not writing) a paper:',
    'Return ONLY JSON of the form {"quality_pass": true|false, "issues": [{"questionNumber": <n>, "issue": "<specific, actionable problem>"}]}.',
    'Judge against IEB standard: clarity and unambiguity of instructions, authenticity of passages/scenarios, internal coherence of the scenario across parts, appropriate difficulty for Grade 12, memo answerable from the question as set. Minor stylistic issues do not fail a paper; ambiguity, unanswerable questions or factual errors do.',
  ].join('\n');

  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
}

/** Rough token estimate (chars/4) — used only for a startup cache-floor warning. */
export function estimateTokens(blocks) {
  const chars = blocks.reduce((s, b) => s + (b.text?.length || 0), 0);
  return Math.round(chars / 4);
}

// ── User message builders (dynamic content — after the cache breakpoint) ───

export function buildGenerationUserMessage(subject, paper, sectionInstruction, startQuestion, batchTargetMarks) {
  return [
    `Generate exactly 2 IEB Grade 12 ${subject} ${paper} questions, numbered starting from ${startQuestion}. Each question must have 3–5 parts.`,
    '',
    sectionInstruction,
    batchTargetMarks
      ? `\nMARK TARGET: this batch MUST total EXACTLY ${batchTargetMarks} marks across the 2 questions. Distribute part marks so they sum to exactly ${batchTargetMarks}.`
      : '',
    '',
    'Return ONLY the JSON array.',
  ].filter(Boolean).join('\n');
}

export function buildTopicUserMessage(subject, paper, topic) {
  return [
    `Generate exactly 3 varied IEB Grade 12 ${subject} ${paper} questions, numbered starting from 1, focused ONLY on the topic: "${topic}".`,
    'Each question must have 3–5 parts. Return ONLY the JSON array.',
  ].join('\n');
}

export function buildRepairUserMessage(question, reasons) {
  return [
    'VALIDATION FAILURES TO FIX:',
    reasons.map((r) => `  • ${r}`).join('\n'),
    '',
    'ORIGINAL QUESTION:',
    JSON.stringify(question, null, 2),
    '',
    'Return the single corrected question object as JSON only.',
  ].join('\n');
}

export function buildCorrectionUserMessage(subject, compactQuestions) {
  return [
    `You are checking the final answers of an IEB Grade 12 ${subject} paper for correctness.`,
    'For each part, verify the answer follows from the instruction/expression. If an answer is wrong, replace it with the correct one.',
    'Return ONLY a JSON array with the SAME structure as the input, with corrected "answer" fields where needed.',
    '',
    JSON.stringify(compactQuestions),
  ].join('\n');
}

export function buildQualityUserMessage(subject, paper, compactPaper) {
  return [
    `QUALITY REVIEW of an IEB Grade 12 ${subject} ${paper}.`,
    'Review every question below and return the QUALITY REVIEW JSON verdict.',
    '',
    JSON.stringify(compactPaper),
  ].join('\n');
}
