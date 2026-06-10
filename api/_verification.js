/**
 * Verification orchestrator.
 *
 * runVerification() loads the correct subject config (by subject + paper),
 * runs the universal validators then the subject-specific validators, and
 * returns both the repair-driving structures (byQuestion / failedQuestionNumbers)
 * and a verification_report JSON listing every check with pass/fail and the
 * failures it found.
 *
 * The repair loop in _pipeline.js records fixes applied back onto the report
 * via buildReport() / appendFixes().
 */

import { getSubjectConfig, resolveConfigId } from './_subject-config.js';
import { runUniversalValidators } from './_validators-universal.js';
import { getSubjectValidators } from './_validators-subjects.js';

/**
 * @param {object} paper            - the paper JSON
 * @param {object} opts
 * @param {string} opts.subject
 * @param {string} opts.paper       - the paper name (e.g. "Paper 1", "Physics")
 * @param {object} [opts.config]    - inject a config directly (tests)
 * @returns {{ passed, failures, byQuestion, failedQuestionNumbers, config, report }}
 */
export function runVerification(paper, { subject, paper: paperName, config: injected } = {}) {
  const config = injected || getSubjectConfig(subject, paperName);
  const configId = config?.id || resolveConfigId(subject, paperName);

  const checks = [
    ...runUniversalValidators(paper, config),
    ...getSubjectValidators(subject).map(fn => fn(paper, config)),
  ];

  const allFailures = checks.flatMap(c => c.failures.map(f => ({ ...f, check: c.name })));
  const passed = allFailures.length === 0;

  // questionNumber → [reasons]; null/paper-level failures bucketed under __paper__
  const byQuestion = {};
  for (const f of allFailures) {
    const key = f.questionNumber ?? '__paper__';
    (byQuestion[key] ||= []).push(f.reason);
  }
  const failedQuestionNumbers = Object.keys(byQuestion)
    .filter(k => k !== '__paper__')
    .map(Number);

  const report = buildReport({ subject, paperName, configId, config, checks });

  return { passed, failures: allFailures, byQuestion, failedQuestionNumbers, config, report };
}

/**
 * Build the verification_report JSON: one entry per check with pass/fail and
 * the failures it produced, plus a place to record fixes applied.
 */
export function buildReport({ subject, paperName, configId, config, checks }) {
  return {
    subject,
    paper: paperName,
    config_id: configId || null,
    config_loaded: !!config,
    generated_at: new Date().toISOString(),
    summary: {
      total_checks: checks.length,
      passed: checks.filter(c => c.passed).length,
      failed: checks.filter(c => !c.passed).length,
    },
    checks: checks.map(c => ({
      check: c.name,
      layer: UNIVERSAL_CHECKS.has(c.name) ? 'universal' : 'subject',
      passed: c.passed,
      failures: c.failures.map(f => ({
        question: f.questionNumber ?? null,
        part: f.part ?? null,
        reason: f.reason,
      })),
    })),
    fixes_applied: [],
    config_todos: config?._todo || [],
  };
}

const UNIVERSAL_CHECKS = new Set([
  'schema', 'mark_arithmetic', 'sequential_labels', 'mark_bands', 'no_duplicates', 'topic_coverage',
]);

/**
 * Record a repair/regeneration action on the report.
 */
export function appendFix(report, { questionNumber, action, model, attempt, reasons }) {
  report.fixes_applied.push({
    question: questionNumber,
    action,            // 'regenerated' | 'bank_fallback' | 'kept_original' | 'quality_regenerated'
    model: model || null,
    attempt: attempt ?? null,
    addressed: reasons || [],
  });
}
