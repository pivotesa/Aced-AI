// ── Admin question-review interface ──────────────────────────────────────────
// Reviewers step through `pending_review` questions and approve / reject /
// edit-then-approve them. Every action is a STATUS CHANGE — documents are never
// deleted. Reuses the single Firebase app initialised in js/firebase.js.

import { db, signInGoogle, signOutUser, onAuth } from '/js/firebase.js';
// Firestore query helpers from the SAME SDK version used by js/firebase.js
// (12.14.0). This does not create a second app — it reuses `db` above.
import {
  collection, query, where, orderBy, limit, startAfter,
  getDocs, getCountFromServer, doc, updateDoc, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js';

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
  queue: [],          // loaded question docs (in review order)
  position: 0,        // index into queue of the question on screen
  lastSnap: null,     // Firestore cursor for the next page
  hasMore: true,      // more pending docs beyond what's loaded?
  totalPending: 0,    // count at session start (for "X of N")
  approved: 0,
  rejected: 0,
  editing: false,
  busy: false,        // a Firestore write is in flight
};

// ── Element helpers ──────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const STATES = ['state-loading', 'state-signin', 'state-denied', 'state-review', 'state-done'];
function show(stateId) {
  STATES.forEach(s => { const el = $(s); if (el) el.hidden = (s !== stateId); });
  $('admin-top').hidden = !(stateId === 'state-review' || stateId === 'state-done');
}
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
  if (!ADMIN_EMAILS.includes((user.email || '').toLowerCase()) && !ADMIN_EMAILS.includes(user.email)) {
    show('state-denied');
    return;
  }
  show('state-loading');
  await startReview();
});

$('btn-google').addEventListener('click', async () => {
  $('signin-error').classList.add('hidden');
  try { await signInGoogle(); }
  catch (e) { const el = $('signin-error'); el.textContent = 'Sign-in failed. Please try again.'; el.classList.remove('hidden'); }
});
$('admin-signout').addEventListener('click', () => signOutUser());
$('denied-signout').addEventListener('click', () => signOutUser());
$('done-reload').addEventListener('click', () => startReview());

// ── Queue loading ────────────────────────────────────────────────────────────
async function startReview() {
  state.queue = []; state.position = 0; state.lastSnap = null; state.hasMore = true;
  state.approved = 0; state.rejected = 0; state.editing = false;
  show('state-loading');
  try {
    // Total pending (count query needs only the single-field status index).
    const countSnap = await getCountFromServer(
      query(collection(db, 'questions'), where('status', '==', 'pending_review'))
    );
    state.totalPending = countSnap.data().count;

    await loadNextPage();
    show('state-review');
    render();
  } catch (err) {
    console.error(err);
    // A composite-index error includes a console URL to create the index.
    show('state-review');
    $('q-container').innerHTML =
      `<div class="card"><h2 class="card-title">Couldn't load the queue</h2>
       <p class="card-desc">${esc(err.message || String(err))}</p>
       <p class="card-desc">If this mentions an index, open the link in the browser console to create it, then reload.</p></div>`;
    setActionsEnabled(false);
  }
}

async function loadNextPage() {
  let q;
  const base = [collection(db, 'questions'), where('status', '==', 'pending_review'), orderBy('topic'), orderBy('subtopic')];
  q = state.lastSnap
    ? query(...base, startAfter(state.lastSnap), limit(PAGE_SIZE))
    : query(...base, limit(PAGE_SIZE));
  const snap = await getDocs(q);
  snap.docs.forEach(d => state.queue.push({ id: d.id, ...d.data() }));
  state.lastSnap = snap.docs[snap.docs.length - 1] || state.lastSnap;
  state.hasMore = snap.docs.length === PAGE_SIZE;
}

// ── Rendering ────────────────────────────────────────────────────────────────
async function render() {
  state.editing = false;
  $('action-default').classList.remove('hidden');
  $('action-edit').classList.add('hidden');
  $('reject-reason').value = '';

  // Need another page?
  if (state.position >= state.queue.length) {
    if (state.hasMore) {
      show('state-loading');
      try { await loadNextPage(); } catch (e) { toast('Failed to load more.', 'error'); }
      show('state-review');
    }
  }
  if (state.position >= state.queue.length) { finishDone(); return; }

  const q = state.queue[state.position];
  updateProgress();

  const warnings = Array.isArray(q.validationWarnings) ? q.validationWarnings.filter(Boolean) : [];
  const warnHTML = warnings.length ? `
    <div class="warn-box">
      <b>Validation warnings (${warnings.length})</b>
      <ul>${warnings.map(w => `<li class="pw">${esc(typeof w === 'string' ? w : JSON.stringify(w))}</li>`).join('')}</ul>
    </div>` : '';

  const headHTML = `
    <div class="qhead">
      <span class="chip accent">${esc(q.topic || '—')}</span>
      ${q.subtopic ? `<span class="chip">${esc(q.subtopic)}</span>` : ''}
      <span class="chip">${esc(q.marks ?? '?')} marks</span>
      <span class="chip">Cognitive L${esc(q.cognitiveLevel ?? '?')}</span>
      ${q.subject ? `<span class="chip">${esc(q.subject)}${q.paper ? ' · ' + esc(q.paper) : ''}</span>` : ''}
    </div>`;

  const contextHTML = (q.contextText && q.contextText.trim())
    ? `<div class="qcontext pw">${esc(q.contextText)}</div>` : '';

  const subs = Array.isArray(q.subQuestions) ? q.subQuestions : [];
  const subsHTML = subs.map(sq => `
    <div class="subq">
      <div class="subq-label"><span>(${esc(sq.label ?? '')})</span><span class="m">${esc(sq.marks ?? 0)} mark${sq.marks === 1 ? '' : 's'}</span></div>
      <div class="subq-text pw">${esc(sq.text ?? '')}</div>
      ${sq.solution != null && String(sq.solution).trim() ? `<div class="block-label">Solution</div><div class="sol pw">${esc(sq.solution)}</div>` : ''}
      ${sq.markingNotes != null && String(sq.markingNotes).trim() ? `<div class="block-label">Marking notes</div><div class="notes pw">${esc(sq.markingNotes)}</div>` : ''}
    </div>`).join('');

  $('q-container').innerHTML = `<div class="card">${warnHTML}${headHTML}${contextHTML}${subsHTML}</div>`;
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
    if (kind === 'approve') state.approved++;
    else if (kind === 'reject') state.rejected++;
    state.position++;                                        // …before advancing
    await render();
  } catch (err) {
    console.error(err);
    toast('Save failed — your place is kept. ' + (err.message || ''), 'error');
    setActionsEnabled(true);                                // stay put, let them retry
  } finally {
    state.busy = false;
  }
}

function approve() { writeAndAdvance({ status: 'approved', ...reviewMeta() }, 'approve'); }
function reject() {
  const reason = $('reject-reason').value.trim();
  const update = { status: 'rejected', ...reviewMeta() };
  if (reason) update.rejectionReason = reason;
  writeAndAdvance(update, 'reject');
}
function saveAndApprove() {
  const subQuestions = collectEdits();
  writeAndAdvance({ subQuestions, status: 'approved', ...reviewMeta() }, 'approve');
}
function skip() { if (state.busy) return; state.position++; render(); }

$('btn-approve').addEventListener('click', approve);
$('btn-reject').addEventListener('click', reject);
$('btn-edit').addEventListener('click', enterEdit);
$('btn-skip').addEventListener('click', skip);
$('btn-save-approve').addEventListener('click', saveAndApprove);
$('btn-cancel-edit').addEventListener('click', render);

// ── Keyboard shortcuts (ignored while typing in a field) ─────────────────────
document.addEventListener('keydown', (e) => {
  if ($('state-review').hidden) return;
  const t = e.target;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
  if (state.editing) {
    if (e.key === 'Escape') { e.preventDefault(); render(); }
    return; // don't fire review shortcuts while editing
  }
  if (typing) return; // let the reviewer type a rejection reason without triggering
  if (e.key === 'a') { e.preventDefault(); approve(); }
  else if (e.key === 'r') { e.preventDefault(); reject(); }
  else if (e.key === 'e') { e.preventDefault(); enterEdit(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); skip(); }
});
