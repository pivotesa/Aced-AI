/**
 * Subject configuration loader.
 *
 * The per-subject JSON files in api/config/ are the source of truth for the
 * validation layer: paper_total, topics[] with mark ranges + required
 * subtopics, mark_bands, and format_rules. Generation prompts still use
 * SUBJECT_RULES in _config.js (section instructions, topicGroups); these two
 * must stay roughly consistent (paper_total here ↔ marks there).
 *
 * Configs are loaded by a paper ID. resolveConfigId() maps the UI's
 * (subject, paper) strings — and the user-facing aliases "Biology" (= Life
 * Sciences) and "Physical Sciences P1/P2" (= Physics/Chemistry) — onto those
 * IDs.
 *
 * Each `new URL('./config/<id>.json', import.meta.url)` is a static literal so
 * Vercel's node-file-trace bundles every JSON file with the function.
 */

import { readFileSync } from 'node:fs';

const LOADERS = {
  mathematics_p1:        () => load('mathematics_p1'),
  mathematics_p2:        () => load('mathematics_p2'),
  english_hl_p1:         () => load('english_hl_p1'),
  accounting_p1:         () => load('accounting_p1'),
  life_sciences_p1:      () => load('life_sciences_p1'),
  life_sciences_p2:      () => load('life_sciences_p2'),
  physical_sciences_p1:  () => load('physical_sciences_p1'),
  physical_sciences_p2:  () => load('physical_sciences_p2'),
};

// Static URL literals — one per file — so the bundler traces them.
const URLS = {
  mathematics_p1:       new URL('./config/mathematics_p1.json', import.meta.url),
  mathematics_p2:       new URL('./config/mathematics_p2.json', import.meta.url),
  english_hl_p1:        new URL('./config/english_hl_p1.json', import.meta.url),
  accounting_p1:        new URL('./config/accounting_p1.json', import.meta.url),
  life_sciences_p1:     new URL('./config/life_sciences_p1.json', import.meta.url),
  life_sciences_p2:     new URL('./config/life_sciences_p2.json', import.meta.url),
  physical_sciences_p1: new URL('./config/physical_sciences_p1.json', import.meta.url),
  physical_sciences_p2: new URL('./config/physical_sciences_p2.json', import.meta.url),
};

const _cache = {};
function load(id) {
  if (!_cache[id]) _cache[id] = JSON.parse(readFileSync(URLS[id], 'utf8'));
  return _cache[id];
}

/**
 * Normalise a string for matching (lowercase, trim, collapse whitespace).
 */
function norm(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Map a (subject, paper) pair to a config ID. Handles the IEB canonical names
 * used in the app (Life Sciences, Physical Sciences/Physics+Chemistry) and the
 * user-facing aliases "Biology" and "Physical Sciences P1/P2".
 *
 * @returns {string|null} the config ID, or null if no config exists.
 */
export function resolveConfigId(subject, paper) {
  const s = norm(subject);
  const p = norm(paper);

  // Biology is the IEB's Life Sciences.
  if (s === 'mathematics') {
    if (p.includes('1')) return 'mathematics_p1';
    if (p.includes('2')) return 'mathematics_p2';
  }
  if (s === 'english home language' || s === 'english') {
    if (p.includes('language') || p === 'paper 1' || p.includes('1')) return 'english_hl_p1';
  }
  if (s === 'accounting') {
    return 'accounting_p1';
  }
  if (s === 'life sciences' || s === 'biology') {
    if (p.includes('2')) return 'life_sciences_p2';
    if (p.includes('1')) return 'life_sciences_p1';
  }
  if (s === 'physical sciences' || s === 'physics' || s === 'chemistry') {
    if (p.includes('chem') || p.includes('2')) return 'physical_sciences_p2';
    if (p.includes('phys') || p.includes('1')) return 'physical_sciences_p1';
    if (s === 'physics') return 'physical_sciences_p1';
    if (s === 'chemistry') return 'physical_sciences_p2';
  }
  return null;
}

/**
 * Load the config object for a (subject, paper) pair, or by explicit ID.
 * @returns {object|null}
 */
export function getSubjectConfig(subject, paper) {
  const id = LOADERS[subject] ? subject : resolveConfigId(subject, paper);
  if (!id || !LOADERS[id]) return null;
  return LOADERS[id]();
}

export function getConfigById(id) {
  return LOADERS[id] ? LOADERS[id]() : null;
}

export function listConfigIds() {
  return Object.keys(LOADERS);
}
