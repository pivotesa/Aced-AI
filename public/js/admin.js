// ── Admin question-review interface ──────────────────────────────────────────
// Reviewers step through `pending_review` questions and approve / reject /
// edit-then-approve them, and can review their past decisions in History.
// Every action is a STATUS CHANGE — documents are never deleted. Reuses the
// single Firebase app initialised in js/firebase.js.

import { db, auth, signOutUser, onAuth } from '/js/firebase.js';
// Firestore + Auth helpers from the SAME SDK version used by js/firebase.js
// (12.14.0). This reuses the single app — it does not create a second config.
import {
  collection, query, where, orderBy, limit, startAfter,
  getDocs, getCountFromServer, doc, updateDoc, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js';
import {
  GoogleAuthProvider, signInWithPopup, signInWithRedirect,
} from 'https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js';

const googleProvider = new GoogleAuthProvider();

// ─────────────────────────────────────────────────────────────────────────────
// EDIT THIS: Google account emails allowed to review questions. The list below
// gates the UI only — also enforce it in your Firestore security rules so it is
// a real security boundary, not just a client-side check.
// ─────────────────────────────────────────────────────────────────────────────
const ADMIN_EMAILS = [
  'ibudlender@gmail.com',
];

const PAGE_SIZE = 25;

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  user: null,
  view: 'review',     // 'review' | 'history'
  queue: [],          // loaded pending questions (in review order)
  position: 0,        // index into queue of the question on screen
  lastSnap: null,     // Firestore cursor for the next page
  hasMore: true,      // more pending docs beyond what's loaded?
  totalPending: 0,    // count at session start (for "X of N")
  approved: 0,
  rejected: 0,
  editing: false,
  busy: false,        // a Firestore write is in flight
  history: [],
};

// ── Helpers ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const STATES = ['state-loading', 'state-signin', 'state-denied', 'state-review', 'state-done', 'state-history'];
const TOPBAR_STATES = ['state-review', 'state-done', 'state-history'];
function show(stateId) {
  STATES.forEach(s => { const el = $(s); if (el) el.hidden = (s !== stateId); });
  $('admin-top').hidden = !TOPBAR_STATES.includes(stateId);
}
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// Make plain-text maths readable: turn caret/underscore notation into proper
// super/subscripts (the bank stores "2x^2", "3^(x+1)", "H_2O" — not $LaTeX$),
// plus a few common symbols. Input is escaped first, so the inserted tags are
// the only HTML. If the text already uses $…$ it's left for KaTeX instead.
function fmtMath(raw) {
  let s = esc(raw);
  s = s
    .replace(/\^\{([^}]*)\}/g, '<sup>$1</sup>')          // x^{n}
    .replace(/\^\(([^)]*)\)/g, '<sup>$1</sup>')          // 3^(x+1)  → drops the brackets
    .replace(/\^(-?\d+(?:\.\d+)?|[A-Za-z]+)/g, '<sup>$1</sup>') // x^2, 10^n
    .replace(/_\{([^}]*)\}/g, '<sub>$1</sub>')           // v_{max}
    .replace(/_(-?\d+|[A-Za-z]+)/g, '<sub>$1</sub>')     // H_2O, v_1
    .replace(/\bsqrt\s*\(([^)]*)\)/gi, '√($1)')
    .replace(/&lt;=/g, '≤').replace(/&gt;=/g, '≥').replace(/!=/g, '≠')
    .replace(/(?<=[\w)])\s*\*\s*(?=[\w(])/g, '·');        // 2*x → 2·x
  return s;
}
function renderText(raw) {
  const str = String(raw ?? '');
  return /\$/.test(str) ? esc(str) : fmtMath(str);        // $…$ → leave for KaTeX
}

// Turn machine values ("routine_procedures") into readable text ("Routine procedures").
function humanize(s) {
  if (s == null || s === '') return '';
  const t = String(s).replace(/_/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function paperLabel(p) {
  if (!p) return '';
  return String(p).toLowerCase().startsWith('paper') ? humanize(p) : 'Paper ' + p;
}
function msOf(ts) { return ts?.toMillis ? ts.toMillis() : (ts?.seconds ? ts.seconds * 1000 : 0); }
function fmtDate(ts) {
  const ms = msOf(ts);
  if (!ms) return '';
  try { return new Date(ms).toLocaleString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}
function typeset(el) {
  if (el && window.renderMathInElement) {
    try {
      window.renderMathInElement(el, {
        delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }],
        throwOnError: false,
      });
    } catch { /* leave raw text */ }
  }
}
let toastTimer;
function toast(msg, type = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

// ── Auth gate ────────────────────────────────────────────────────────────────
onAuth(async (user) => {
  state.user = user;
  if (!user) { show('state-signin'); return; }
  $('admin-email').textContent = user.email || '';
  const email = (user.email || '');
  if (!ADMIN_EMAILS.includes(email) && !ADMIN_EMAILS.includes(email.toLowerCase())) {
    show('state-denied');
    return;
  }
  show('state-loading');
  await startReview();
});

$('btn-google').addEventListener('click', signIn);

async function signIn() {
  const el = $('signin-error');
  el.classList.add('hidden');
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (err) {
    // Popups are frequently blocked — fall back to a full-page redirect.
    if (['auth/popup-blocked', 'auth/popup-closed-by-user', 'auth/cancelled-popup-request'].includes(err?.code)) {
      try { await signInWithRedirect(auth, googleProvider); return; }
      catch (err2) { err = err2; }
    }
    console.error('admin sign-in error:', err);
    el.textContent = friendlySignInError(err);
    el.classList.remove('hidden');
  }
}

function friendlySignInError(err) {
  const code = err?.code || '';
  const map = {
    'auth/unauthorized-domain': 'This site’s domain isn’t authorised in Firebase. Add it under Authentication → Settings → Authorized domains.',
    'auth/operation-not-allowed': 'Google sign-in isn’t enabled (Firebase → Authentication → Sign-in method → Google).',
    'auth/popup-blocked': 'Your browser blocked the popup. Allow popups for this site, then try again.',
    'auth/popup-closed-by-user': 'The sign-in window closed before finishing. Try again.',
    'auth/network-request-failed': 'Network error — check your connection and try again.',
  };
  return map[code] || `Sign-in failed${code ? ' (' + code + ')' : ''}. Please try again.`;
}
$('admin-signout').addEventListener('click', () => signOutUser());
$('denied-signout').addEventListener('click', () => signOutUser());
$('done-reload').addEventListener('click', () => startReview());
$('btn-history').addEventListener('click', openHistory);
$('history-back').addEventListener('click', () => { state.view = 'review'; show('state-review'); });

// ── Queue loading ────────────────────────────────────────────────────────────
async function startReview() {
  state.view = 'review';
  state.queue = []; state.position = 0; state.lastSnap = null; state.hasMore = true;
  state.approved = 0; state.rejected = 0; state.editing = false;
  show('state-loading');
  try {
    const countSnap = await getCountFromServer(
      query(collection(db, 'questions'), where('status', '==', 'pending_review'))
    );
    state.totalPending = countSnap.data().count;
    await loadNextPage();
    show('state-review');
    render();
  } catch (err) {
    console.error(err);
    show('state-review');
    $('q-container').innerHTML =
      `<div class="card"><h2 class="card-title">Couldn't load the queue</h2>
       <p class="card-desc pw">${esc(err.message || String(err))}</p>
       <p class="card-desc">If this mentions permissions, add the Firestore rule. If it mentions an index, open the link in the browser console to create it, then reload.</p></div>`;
    setActionsEnabled(false);
  }
}

async function loadNextPage() {
  const base = [collection(db, 'questions'), where('status', '==', 'pending_review'), orderBy('topic'), orderBy('subtopic')];
  const q = state.lastSnap
    ? query(...base, startAfter(state.lastSnap), limit(PAGE_SIZE))
    : query(...base, limit(PAGE_SIZE));
  const snap = await getDocs(q);
  snap.docs.forEach(d => state.queue.push({ id: d.id, ...d.data() }));
  state.lastSnap = snap.docs[snap.docs.length - 1] || state.lastSnap;
  state.hasMore = snap.docs.length === PAGE_SIZE;
}

// ── Question rendering (shared by review + history detail) ────────────────────
function renderQuestionBody(q, { includeWarnings = true } = {}) {
  const warnings = Array.isArray(q.validationWarnings) ? q.validationWarnings.filter(Boolean) : [];
  const warnHTML = (includeWarnings && warnings.length) ? `
    <div class="warn-box">
      <b>Validation warnings (${warnings.length})</b>
      <ul>${warnings.map(w => `<li class="pw">${esc(typeof w === 'string' ? w : JSON.stringify(w))}</li>`).join('')}</ul>
    </div>` : '';

  const titleHTML = `<div class="qtitle">${esc(humanize(q.subject))}${q.paper ? ' · ' + esc(paperLabel(q.paper)) : ''}</div>`;

  const headHTML = `
    <div class="qhead">
      <span class="chip accent"><em>Topic</em> ${esc(humanize(q.topic))}</span>
      ${q.subtopic ? `<span class="chip"><em>Subtopic</em> ${esc(humanize(q.subtopic))}</span>` : ''}
      <span class="chip"><em>Marks</em> ${esc(q.marks ?? '?')}</span>
      <span class="chip"><em>Cognitive level</em> ${esc(humanize(q.cognitiveLevel))}</span>
    </div>`;

  const contextHTML = (q.contextText && q.contextText.trim())
    ? `<div class="qcontext pw">${renderText(q.contextText)}</div>` : '';

  const subs = Array.isArray(q.subQuestions) ? q.subQuestions : [];
  const subsHTML = subs.map(sq => `
    <div class="subq">
      <div class="subq-label"><span>(${esc(sq.label ?? '')})</span><span class="m">${esc(sq.marks ?? 0)} mark${sq.marks === 1 ? '' : 's'}</span></div>
      <div class="subq-text pw">${renderText(sq.text ?? '')}</div>
      ${sq.solution != null && String(sq.solution).trim() ? `<div class="block-label">Solution</div><div class="sol pw">${renderText(sq.solution)}</div>` : ''}
      ${sq.markingNotes != null && String(sq.markingNotes).trim() ? `<div class="block-label">Marking notes</div><div class="notes pw">${renderText(sq.markingNotes)}</div>` : ''}
    </div>`).join('');

  return warnHTML + titleHTML + headHTML + contextHTML + subsHTML;
}

async function render() {
  state.editing = false;
  $('action-default').classList.remove('hidden');
  $('action-edit').classList.add('hidden');
  $('review-note').value = '';

  if (state.position >= state.queue.length && state.hasMore) {
    show('state-loading');
    try { await loadNextPage(); } catch { toast('Failed to load more.', 'error'); }
    show('state-review');
  }
  if (state.position >= state.queue.length) { finishDone(); return; }

  const q = state.queue[state.position];
  updateProgress();
  $('q-container').innerHTML = `<div class="card">${renderQuestionBody(q)}</div>`;
  typeset($('q-container'));
  setActionsEnabled(true);
}

function updateProgress() {
  const reviewed = state.approved + state.rejected;
  const remaining = Math.max(0, state.totalPending - reviewed);
  $('counter').textContent = `Question ${Math.min(state.position + 1, state.totalPending)} of ${state.totalPending} pending`;
  $('count-approved').textContent = `Approved ${state.approved}`;
  $('count-rejected').textContent = `Rejected ${state.rejected}`;
  $('count-remaining').textContent = `${remaining} pending remaining`;
}

function finishDone() {
  $('done-summary').textContent =
    `Approved ${state.approved} · rejected ${state.rejected} this session. ` +
    `${Math.max(0, state.totalPending - state.approved - state.rejected)} still pending.`;
  show('state-done');
}

// ── Edit mode ────────────────────────────────────────────────────────────────
function enterEdit() {
  const q = state.queue[state.position];
  const subs = Array.isArray(q.subQuestions) ? q.subQuestions : [];
  state.editing = true;
  $('action-default').classList.add('hidden');
  $('action-edit').classList.remove('hidden');

  const editHTML = subs.map((sq, i) => `
    <div class="subq">
      <div class="subq-label"><span>(${esc(sq.label ?? '')})</span></div>
      <div class="edit-grid">
        <div class="field"><label>Text</label><textarea data-i="${i}" data-f="text" rows="3">${esc(sq.text ?? '')}</textarea></div>
        <div class="field"><label>Solution</label><textarea data-i="${i}" data-f="solution" rows="3">${esc(sq.solution ?? '')}</textarea></div>
        <div class="field"><label>Marking notes</label><textarea data-i="${i}" data-f="markingNotes" rows="2">${esc(sq.markingNotes ?? '')}</textarea></div>
        <div class="field"><label>Marks</label><input class="marks" type="number" min="0" step="1" data-i="${i}" data-f="marks" value="${esc(sq.marks ?? 0)}"></div>
      </div>
    </div>`).join('');

  $('q-container').innerHTML =
    `<div class="card">${editHTML || '<p class="card-desc">This question has no sub-questions to edit.</p>'}</div>`;
}

function collectEdits() {
  const q = state.queue[state.position];
  const subs = (Array.isArray(q.subQuestions) ? q.subQuestions : []).map(s => ({ ...s }));
  $('q-container').querySelectorAll('[data-i]').forEach(el => {
    const i = Number(el.dataset.i), f = el.dataset.f;
    if (!subs[i]) return;
    subs[i][f] = (f === 'marks') ? Number(el.value || 0) : el.value;
  });
  return subs;
}

// ── Actions (status changes only; never delete) ──────────────────────────────
function reviewMeta() {
  return { reviewedBy: state.user?.email || null, reviewedAt: serverTimestamp() };
}
function setActionsEnabled(on) {
  ['btn-approve', 'btn-edit', 'btn-reject', 'btn-skip', 'btn-save-approve', 'btn-cancel-edit']
    .forEach(id => { const b = $(id); if (b) b.disabled = !on; });
}

async function writeAndAdvance(update, kind) {
  if (state.busy) return;
  const q = state.queue[state.position];
  if (!q) return;
  state.busy = true; setActionsEnabled(false);
  try {
    await updateDoc(doc(db, 'questions', q.id), update);     // confirm success…
    Object.assign(q, update);                                // keep local copy current
    if (kind === 'approve') state.approved++;
    else if (kind === 'reject') state.rejected++;
    state.position++;                                        // …before advancing
    await render();
  } catch (err) {
    console.error(err);
    toast('Save failed — your place is kept. ' + (err.message || ''), 'error');
    setActionsEnabled(true);
  } finally {
    state.busy = false;
  }
}

function approve() {
  const note = $('review-note').value.trim();
  const update = { status: 'approved', ...reviewMeta() };
  if (note) update.approvalNote = note;                      // optional note
  writeAndAdvance(update, 'approve');
}
function reject() {
  const note = $('review-note').value.trim();
  if (!note) {                                               // reason is REQUIRED
    toast('Add a reason before rejecting.', 'error');
    $('review-note').focus();
    return;
  }
  writeAndAdvance({ status: 'rejected', rejectionReason: note, ...reviewMeta() }, 'reject');
}
function saveAndApprove() {
  const note = $('review-note').value.trim();
  const update = { subQuestions: collectEdits(), status: 'approved', ...reviewMeta() };
  if (note) update.approvalNote = note;
  writeAndAdvance(update, 'approve');
}
function skip() { if (state.busy) return; state.position++; render(); }

$('btn-approve').addEventListener('click', approve);
$('btn-reject').addEventListener('click', reject);
$('btn-edit').addEventListener('click', enterEdit);
$('btn-skip').addEventListener('click', skip);
$('btn-save-approve').addEventListener('click', saveAndApprove);
$('btn-cancel-edit').addEventListener('click', render);

// ── History ──────────────────────────────────────────────────────────────────
async function openHistory() {
  state.view = 'history';
  show('state-history');
  $('history-list').innerHTML = '<div class="card"><p class="card-desc">Loading…</p></div>';
  try {
    // Filter by the current reviewer (single-field index is automatic — no
    // composite index needed); sort newest-first client-side.
    const snap = await getDocs(query(
      collection(db, 'questions'), where('reviewedBy', '==', state.user.email), limit(200)
    ));
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    items.sort((a, b) => msOf(b.reviewedAt) - msOf(a.reviewedAt));
    state.history = items;
    renderHistory();
  } catch (err) {
    console.error(err);
    $('history-list').innerHTML = `<div class="card"><p class="card-desc pw">${esc(err.message || String(err))}</p></div>`;
  }
}

function renderHistory() {
  const items = state.history;
  if (!items.length) {
    $('history-list').innerHTML = '<div class="card"><p class="card-desc">You haven\'t reviewed any questions yet.</p></div>';
    return;
  }
  $('history-list').innerHTML = items.map(q => {
    const badge = q.status === 'approved' ? '<span class="badge approved">Approved</span>'
      : q.status === 'rejected' ? '<span class="badge rejected">Rejected</span>'
        : `<span class="badge">${esc(q.status)}</span>`;
    const note = q.rejectionReason || q.approvalNote || '';
    const noteLabel = q.status === 'rejected' ? 'Reason' : 'Note';
    return `
      <div class="card hist-item">
        <div class="hist-top">
          ${badge}
          <span class="hist-meta">${esc(humanize(q.subject))} · ${esc(humanize(q.topic))}${q.subtopic ? ' · ' + esc(humanize(q.subtopic)) : ''} · ${esc(q.marks ?? '?')} marks</span>
          <span class="hist-date">${esc(fmtDate(q.reviewedAt))}</span>
        </div>
        ${note ? `<div class="hist-note pw"><em>${noteLabel}:</em> ${esc(note)}</div>` : ''}
        <details class="hist-details"><summary>View question</summary>${renderQuestionBody(q, { includeWarnings: false })}</details>
        <div class="hist-actions">
          ${q.status !== 'approved' ? `<button class="btn-ghost" data-id="${q.id}" data-to="approved">Set approved</button>` : ''}
          ${q.status !== 'rejected' ? `<button class="btn-danger" data-id="${q.id}" data-to="rejected">Set rejected</button>` : ''}
        </div>
      </div>`;
  }).join('');
  $('history-list').querySelectorAll('[data-to]').forEach(b =>
    b.addEventListener('click', () => changeDecision(b.dataset.id, b.dataset.to, b)));
  typeset($('history-list'));
}

async function changeDecision(id, to, btn) {
  if (state.busy) return;
  state.busy = true; if (btn) btn.disabled = true;
  try {
    await updateDoc(doc(db, 'questions', id), { status: to, ...reviewMeta() });
    const item = state.history.find(h => h.id === id);
    if (item) item.status = to;
    toast(`Changed to ${to}.`, 'success');
    renderHistory();
  } catch (err) {
    console.error(err);
    toast('Change failed. ' + (err.message || ''), 'error');
    if (btn) btn.disabled = false;
  } finally {
    state.busy = false;
  }
}

// ── Keyboard shortcuts (review view only, ignored while typing) ───────────────
document.addEventListener('keydown', (e) => {
  if (state.view !== 'review' || $('state-review').hidden) return;
  const t = e.target;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
  if (state.editing) {
    if (e.key === 'Escape') { e.preventDefault(); render(); }
    return;
  }
  if (typing) return; // let the reviewer type a note without triggering shortcuts
  if (e.key === 'a') { e.preventDefault(); approve(); }
  else if (e.key === 'r') { e.preventDefault(); reject(); }
  else if (e.key === 'e') { e.preventDefault(); enterEdit(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); skip(); }
});
