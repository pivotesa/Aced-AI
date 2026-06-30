import { onAuth, signInEmail, signUpEmail, signInGoogle, signOutUser, getUserDoc, incrementPapersGenerated, getRecentSessions, saveSession, updateSession, getTopicPerformance, updateTopicPerformance, uploadSubmissionPhoto, deleteSubmissionPhoto } from './firebase.js';
import { generatePaper, markPaper, sendTutorMessage, createSubscription } from './api.js';
import { renderPaper, renderResults, typesetMath } from './render.js';
import { getPapers, getTopics } from './subjects.js';

// ── STATE ───────────────────────────────────────────────────
let currentUser = null;
let userDoc = null;
let currentPaper = null;      // { paper, memo, sessionId }
let currentMarking = null;
let partPhotos = {};          // partId -> { url, path } uploaded working photos
let tutorMessages = [];
let tutorMsgCount = 0;

// ── INIT ────────────────────────────────────────────────────
onAuth(async user => {
  if (user) {
    currentUser = user;
    userDoc = await getUserDoc(user.uid);
    showApp();
    navigate('dashboard');
    loadDashboard();
  } else {
    currentUser = null;
    userDoc = null;
    hideApp();
  }
});

function showApp() {
  document.getElementById('nav').classList.remove('hidden');
  updateNavTier();
}

function hideApp() {
  document.getElementById('nav').classList.add('hidden');
  navigate('auth');
}

function updateNavTier() {
  const badge = document.getElementById('nav-tier-badge');
  const tier = userDoc?.tier ?? 'free';
  badge.textContent = tier.toUpperCase();
  badge.className = tier;
}

// ── NAVIGATION ──────────────────────────────────────────────
export function navigate(viewId) {
  document.querySelectorAll('.view').forEach(v => {
    v.classList.remove('active');
    v.classList.add('hidden');
  });
  const target = document.getElementById(`view-${viewId}`);
  if (target) {
    target.classList.remove('hidden');
    target.classList.add('active');
  }
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === viewId);
  });
}

// Make navigate available to inline handlers
window.navigate = navigate;

// ── AUTH HANDLERS ────────────────────────────────────────────
document.getElementById('form-signin').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  const errEl = document.getElementById('signin-error');
  errEl.classList.add('hidden');
  btn.disabled = true;
  try {
    await signInEmail(
      document.getElementById('signin-email').value,
      document.getElementById('signin-password').value
    );
  } catch (err) {
    errEl.textContent = friendlyAuthError(err.code);
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('form-signup').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  const errEl = document.getElementById('signup-error');
  errEl.classList.add('hidden');
  btn.disabled = true;
  try {
    await signUpEmail(
      document.getElementById('signup-email').value,
      document.getElementById('signup-password').value,
      document.getElementById('signup-name').value
    );
  } catch (err) {
    errEl.textContent = friendlyAuthError(err.code);
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btn-google').addEventListener('click', async () => {
  try {
    await signInGoogle();
  } catch (err) {
    toast('Google sign-in failed. Try again.', 'error');
  }
});

document.getElementById('nav-signout').addEventListener('click', () => signOutUser());
document.getElementById('settings-signout').addEventListener('click', () => signOutUser());

// Auth tab switching
document.querySelectorAll('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const which = tab.dataset.tab;
    document.getElementById('form-signin').classList.toggle('hidden', which !== 'signin');
    document.getElementById('form-signup').classList.toggle('hidden', which !== 'signup');
  });
});

// Nav buttons
document.querySelectorAll('[data-view]').forEach(el => {
  el.addEventListener('click', () => {
    const view = el.dataset.view;
    if (!view) return;
    navigate(view);
    if (view === 'dashboard') loadDashboard();
    if (view === 'settings') loadSettings();
  });
});

// ── DASHBOARD ────────────────────────────────────────────────
async function loadDashboard() {
  if (!currentUser) return;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  // Personalise with the first name — fall back to the Google display name,
  // then the part of the email before "@", so it greets the user by name.
  let name = (userDoc?.name || currentUser?.displayName || (currentUser?.email || '').split('@')[0] || '').split(' ')[0];
  if (name) name = name.charAt(0).toUpperCase() + name.slice(1);
  document.getElementById('dashboard-greeting').textContent = `${greeting}${name ? ', ' + name : ''}`;

  const usageBadge = document.getElementById('dashboard-usage');
  if (userDoc?.tier === 'free') {
    const used = userDoc.papersGenerated || 0;
    usageBadge.textContent = `${used}/5 free papers used`;
  } else {
    usageBadge.textContent = 'Pro — unlimited papers';
    usageBadge.style.background = 'var(--teal-lt)';
  }

  // Load recent sessions + topic performance, then build the route hub.
  let sessions = [], perf = [];
  try { sessions = await getRecentSessions(currentUser.uid); renderRecentSessions(sessions); }
  catch (e) { /* Firestore not configured yet */ }
  try { perf = await getTopicPerformance(currentUser.uid); renderTopicPerformance(perf); }
  catch (e) { /* Firestore not configured yet */ }
  buildHub(sessions, perf);
}

function renderRecentSessions(sessions) {
  const el = document.getElementById('recent-sessions');
  if (!sessions.length) {
    el.innerHTML = '<p class="empty-state">No sessions yet — tap “Generate a paper” to start.</p>';
    return;
  }
  el.innerHTML = sessions.map(s => {
    const pct = s.marking?.percentage;
    const pctClass = pct == null ? '' : pct >= 70 ? 'green' : pct >= 50 ? 'orange' : 'red';
    const scoreText = pct != null ? `${pct}%` : 'Not marked';
    const date = s.generatedAt?.toDate?.()?.toLocaleDateString('en-ZA') ?? '—';
    return `
      <div class="session-card" data-session-id="${s.id}">
        <div class="session-subject">${s.subject}</div>
        <div class="session-paper">${s.paper}</div>
        <div class="session-meta">
          <span>${date}</span>
          <span class="session-score ${pctClass}">${scoreText}</span>
        </div>
      </div>`;
  }).join('');

  el.querySelectorAll('.session-card').forEach(card => {
    card.addEventListener('click', () => openSession(card.dataset.sessionId));
  });
}

// Open a saved session into the paper view (shared by recent-session cards and
// the "Continue last paper" hub tile).
async function openSession(sid) {
  const { getSession } = await import('./firebase.js');
  const session = await getSession(sid);
  if (!session) return;
  // New sessions store the student `paper` + a `generationId`; the `memo` is
  // saved only after marking. Old sessions stored a full `paperJSON`.
  const paper = session.paper || session.paperJSON;
  const memo  = session.memo || null;
  currentPaper = { paper, memo, generationId: session.generationId || null, sessionId: sid };
  renderPaperView(paper, session.subject, session.paper);
  navigate('paper');
}

// ── Route hub ────────────────────────────────────────────────
// Turns the dashboard into a "where to next" page: quick routes plus a
// suggestion drawn from the most recent session and weakest topic.
function buildHub(sessions, perf) {
  document.getElementById('hub-generate').onclick = goGenerate;
  document.getElementById('hub-tutor').onclick = () => navigate('tutor');

  // Continue last paper
  const last = sessions && sessions[0];
  const cont = document.getElementById('hub-continue');
  if (last) {
    cont.querySelector('.hub-d').textContent = `${last.subject} · ${last.paper}`;
    cont.onclick = () => openSession(last.id);
    cont.classList.remove('hidden');
  } else {
    cont.classList.add('hidden');
  }

  // Drill a weak topic (lowest-scoring topic under 60%)
  const weak = (perf || []).find(p => p.averageScore != null && p.averageScore < 60);
  const weakCard = document.getElementById('hub-weak');
  if (weak) {
    weakCard.querySelector('.hub-d').textContent = `${weak.topicName} · ${Math.round(weak.averageScore)}%`;
    weakCard.onclick = () => startTopicDrill(weak.subject, weak.topicName);
    weakCard.classList.remove('hidden');
  } else {
    weakCard.classList.add('hidden');
  }

  // Personalised suggestion
  const sug = document.getElementById('dashboard-suggestion');
  let msg = '';
  if (weak) msg = `You're at ${Math.round(weak.averageScore)}% on ${weak.topicName} — a focused drill could lift that fast.`;
  else if (last) msg = `Last time you did ${last.subject} ${last.paper}. Ready for the next one?`;
  if (msg) { sug.textContent = msg; sug.classList.remove('hidden'); }
  else sug.classList.add('hidden');
}

// Open the separate generator page, focusing the subject select.
function goGenerate() {
  navigate('generate');
  setTimeout(() => genSubject.focus(), 60);
}

// Pre-set the generator to a topic drill for a subject, then open the page.
function startTopicDrill(subject, topicName) {
  genSubject.value = subject;
  genSubject.dispatchEvent(new Event('change')); // populate papers + topics
  genMode.value = 'topic';
  genMode.dispatchEvent(new Event('change'));    // reveal the topic field
  goGenerate();
  toast(`Set to a ${subject} topic drill — pick the paper, then choose ${topicName}.`);
}

function renderTopicPerformance(perf) {
  const el = document.getElementById('topic-performance');
  if (!perf.length) {
    el.innerHTML = '<p class="empty-state">Complete a paper to see your performance breakdown.</p>';
    return;
  }
  el.innerHTML = perf.slice(0, 8).map(t => {
    const pct = Math.round(t.averageScore);
    const barColor = pct >= 70 ? 'var(--green)' : pct >= 50 ? 'var(--orange)' : 'var(--red)';
    return `
      <div class="topic-row">
        <span class="topic-name">${t.topicName}</span>
        <div class="topic-bar-wrap"><div class="topic-bar" style="width:${pct}%;background:${barColor}"></div></div>
        <span class="topic-pct" style="color:${barColor}">${pct}%</span>
      </div>`;
  }).join('');
}

// ── PAPER GENERATION ─────────────────────────────────────────
const genSubject = document.getElementById('gen-subject');
const genPaper   = document.getElementById('gen-paper');
const genMode    = document.getElementById('gen-mode');
const genTopic   = document.getElementById('gen-topic');
const topicField = document.getElementById('topic-field');

genSubject.addEventListener('change', () => {
  const papers = getPapers(genSubject.value);
  genPaper.innerHTML = '<option value="">Select paper…</option>' +
    papers.map(p => `<option value="${p}">${p}</option>`).join('');
  genPaper.disabled = !papers.length;
  updateTopicOptions();
});

genPaper.addEventListener('change', updateTopicOptions);
genMode.addEventListener('change', () => {
  topicField.classList.toggle('hidden', genMode.value !== 'topic');
});

function updateTopicOptions() {
  const topics = getTopics(genSubject.value, genPaper.value);
  genTopic.innerHTML = '<option value="">Select topic…</option>' +
    topics.map(t => `<option value="${t}">${t}</option>`).join('');
}

document.getElementById('form-generate').addEventListener('submit', async e => {
  e.preventDefault();
  if (!currentUser) return;

  // Free tier gate temporarily disabled
  // if (userDoc?.tier === 'free' && (userDoc.papersGenerated || 0) >= 5) {
  //   showUpgradeModal();
  //   return;
  // }

  const subject = genSubject.value;
  const paper   = genPaper.value;
  const mode    = genMode.value;
  const topic   = genTopic.value;

  if (!subject || !paper) return;

  const btn      = document.getElementById('btn-generate');
  const progress = document.getElementById('gen-progress');
  const genStatus = document.getElementById('gen-status');
  btn.disabled = true;

  // Show progress overlay
  progress.classList.remove('hidden');
  setGenStep(1);

  // Cycle status messages while waiting
  const messages = [
    'Generating questions…',
    'Building exam questions…',
    'Writing solutions…',
    'Structuring the paper…',
    'Verifying answers…',
    'Almost ready…'
  ];
  let msgIdx = 0;
  const msgTimer = setInterval(() => {
    msgIdx = (msgIdx + 1) % messages.length;
    genStatus.textContent = messages[msgIdx];
    // Advance step indicators based on time elapsed
    if (msgIdx === 2) setGenStep(2);
    if (msgIdx === 4) setGenStep(3);
  }, 12000);

  try {
    // Only the student paper + a generationId come back — the memo stays
    // server-side until the student submits for marking.
    const { paper: studentPaper, generationId } = await generatePaper(subject, paper, mode, topic);

    clearInterval(msgTimer);
    setGenStepDone();

    const sessionId = await saveSession(currentUser.uid, { subject, paper, mode, topic, paper: studentPaper, generationId, marking: null });
    await incrementPapersGenerated(currentUser.uid);
    userDoc = { ...userDoc, papersGenerated: (userDoc.papersGenerated || 0) + 1 };

    currentPaper = { paper: studentPaper, memo: null, generationId, sessionId };
    renderPaperView(studentPaper, subject, paper);
    navigate('paper');

  } catch (err) {
    clearInterval(msgTimer);
    if (err.code === 'LIMIT_REACHED') {
      showUpgradeModal();
    } else {
      toast(err.message || 'Generation failed — please try again.', 'error');
    }
  } finally {
    btn.disabled = false;
    progress.classList.add('hidden');
    resetGenSteps();
  }
});

// ── PAPER VIEW ───────────────────────────────────────────────
function renderPaperView(paperJSON, subject, paper) {
  document.getElementById('paper-meta').textContent = `${subject} — ${paper} · ${paperJSON.totalMarks} marks · ${paperJSON.duration}`;
  const contentEl = document.getElementById('paper-content');
  contentEl.innerHTML = renderPaper(paperJSON);

  partPhotos = {}; // fresh paper → clear any previously uploaded photos
  wirePhotoUploads(contentEl);

  // Render LaTeX maths (KaTeX), with raw-text fallback on parse failure.
  typesetMath(contentEl);
}

// Attach per-part photo-of-working upload handlers.
function wirePhotoUploads(rootEl) {
  rootEl.querySelectorAll('.photo-input').forEach(input => {
    const partId = input.id.replace(/^photo-/, '');
    input.addEventListener('change', () => handlePhotoSelected(input, partId));
  });
}

async function handlePhotoSelected(input, partId) {
  const file = input.files?.[0];
  if (!file) return;

  const statusEl = document.getElementById(`photostatus-${partId}`);
  const thumbWrap = document.getElementById(`thumb-${partId}`);
  statusEl.textContent = 'Uploading…';

  try {
    // Replace any existing photo for this part.
    if (partPhotos[partId]?.path) {
      await deleteSubmissionPhoto(partPhotos[partId].path).catch(() => {});
    }

    const blob = await compressImage(file, 1_000_000); // ~1MB cap
    const paperId = currentPaper?.sessionId || 'unsaved';
    const { url, path } = await uploadSubmissionPhoto(currentUser.uid, paperId, partId, blob);
    partPhotos[partId] = { url, path };

    thumbWrap.hidden = false;
    thumbWrap.innerHTML = `
      <img class="photo-thumb" src="${url}" alt="Working for ${partId}">
      <button type="button" class="photo-remove" data-part="${partId}">Remove</button>`;
    thumbWrap.querySelector('.photo-remove').addEventListener('click', () => removePhoto(partId));
    statusEl.textContent = '';
  } catch (err) {
    console.error('Photo upload failed:', err);
    statusEl.textContent = 'Upload failed — try again.';
    statusEl.classList.add('error');
    input.value = '';
  }
}

async function removePhoto(partId) {
  if (partPhotos[partId]?.path) {
    await deleteSubmissionPhoto(partPhotos[partId].path).catch(() => {});
  }
  delete partPhotos[partId];
  const thumbWrap = document.getElementById(`thumb-${partId}`);
  if (thumbWrap) { thumbWrap.hidden = true; thumbWrap.innerHTML = ''; }
  const input = document.getElementById(`photo-${partId}`);
  if (input) input.value = '';
}

document.getElementById('btn-back-dashboard').addEventListener('click', () => navigate('dashboard'));
document.getElementById('btn-gen-back').addEventListener('click', () => { navigate('dashboard'); loadDashboard(); });
document.getElementById('btn-print').addEventListener('click', () => window.print());

document.getElementById('btn-submit-paper').addEventListener('click', async () => {
  if (!currentPaper) return;
  const { paper, generationId, sessionId } = currentPaper;

  // Collect per-part answers: typed text and/or an uploaded working photo.
  const answers = [];
  document.querySelectorAll('.answer-block').forEach(block => {
    const partId = block.dataset.answerFor;
    const qNum = Number(block.dataset.q);
    const part = block.dataset.part;
    const text = block.querySelector('.answer-input')?.value?.trim() || '';
    const photoURL = partPhotos[partId]?.url || null;
    if (text || photoURL) {
      answers.push({ questionId: partId, questionNumber: qNum, part, text, photoURL });
    }
  });

  if (!answers.length) {
    toast('Type an answer or upload a photo of your working for at least one question.', 'error');
    return;
  }

  const btn = document.getElementById('btn-submit-paper');
  btn.disabled = true;
  btn.textContent = 'Marking…';

  try {
    // The server loads the memo by generationId and marks (photos sent as
    // image inputs); it returns the memo now that the student has submitted.
    const { markingJSON, memo } = await markPaper({ generationId, answers });
    currentMarking = markingJSON;
    currentPaper.memo = memo;

    // Persist marking, the submitted answers, and the memo for later review.
    await updateSession(sessionId, { marking: markingJSON, answers, memo: memo ?? null });

    // Update topic performance (topic lives on the student paper).
    const topicScores = {};
    markingJSON.questionMarking?.forEach(qm => {
      const q = paper.questions.find(q => q.questionNumber === qm.questionNumber);
      if (q?.topic) {
        if (!topicScores[q.topic]) topicScores[q.topic] = { total: 0, available: 0 };
        topicScores[q.topic].total += qm.marksAwarded;
        topicScores[q.topic].available += qm.marksAvailable;
      }
    });
    const topicPcts = {};
    Object.entries(topicScores).forEach(([t, v]) => {
      topicPcts[t] = v.available > 0 ? Math.round((v.total / v.available) * 100) : 0;
    });
    await updateTopicPerformance(currentUser.uid, paper.subject, markingJSON.weakTopics || [], markingJSON.strongTopics || [], topicPcts);

    renderResultsView(markingJSON, paper, memo);
    navigate('results');

  } catch (err) {
    toast(err.message || 'Marking failed — please try again.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Submit for Marking';
  }
});

// ── RESULTS VIEW ─────────────────────────────────────────────
function renderResultsView(markingJSON, paperJSON, memo) {
  const el = document.getElementById('results-content');
  el.innerHTML = renderResults(markingJSON, paperJSON, memo);
  typesetMath(el); // render maths in feedback + the memorandum

  document.getElementById('btn-results-back-paper')?.addEventListener('click', () => navigate('paper'));
  document.getElementById('btn-results-new')?.addEventListener('click', () => {
    currentPaper = null; currentMarking = null;
    navigate('dashboard');
  });
}

document.getElementById('btn-back-paper').addEventListener('click', () => navigate('paper'));
document.getElementById('btn-new-paper').addEventListener('click', () => {
  currentPaper = null; currentMarking = null;
  navigate('dashboard');
});

// ── TUTOR ────────────────────────────────────────────────────
document.getElementById('btn-tutor-send').addEventListener('click', sendTutorMsg);
document.getElementById('tutor-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTutorMsg(); }
});

// Auto-resize textarea
document.getElementById('tutor-input').addEventListener('input', function () {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 160) + 'px';
});

async function sendTutorMsg() {
  if (!currentUser) return;

  const FREE_LIMIT = 10;
  if (userDoc?.tier === 'free' && tutorMsgCount >= FREE_LIMIT) {
    showUpgradeModal();
    return;
  }

  const input = document.getElementById('tutor-input');
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  input.style.height = 'auto';

  appendTutorMessage('user', text);
  tutorMessages.push({ role: 'user', content: text });
  tutorMsgCount++;

  updateTutorLimitWarning();

  const loadingEl = appendTutorLoading();

  try {
    const { reply } = await sendTutorMessage(
      tutorMessages.slice(-10),
      currentPaper?.paperJSON ?? null,
      currentPaper?.paperJSON?.subject ?? '',
      currentPaper?.paperJSON?.paper ?? ''
    );
    loadingEl.remove();
    appendTutorMessage('ai', reply);
    tutorMessages.push({ role: 'assistant', content: reply });
  } catch (err) {
    loadingEl.remove();
    appendTutorMessage('ai', 'Sorry, something went wrong. Please try again.');
  }
}

function appendTutorMessage(role, text) {
  const container = document.getElementById('tutor-messages');
  const div = document.createElement('div');
  div.className = `tutor-msg-${role}`;
  div.innerHTML = `
    <div class="tutor-avatar ${role === 'user' ? 'user' : ''}">${role === 'user' ? 'You' : 'AI'}</div>
    <div class="tutor-bubble">${escapeHTML(text)}</div>`;
  container.appendChild(div);
  // Render any LaTeX maths in the tutor's reply.
  typesetMath(div.querySelector('.tutor-bubble'));
  container.scrollTop = container.scrollHeight;
  return div;
}

function appendTutorLoading() {
  const container = document.getElementById('tutor-messages');
  const div = document.createElement('div');
  div.className = 'tutor-msg-ai';
  div.innerHTML = `
    <div class="tutor-avatar">AI</div>
    <div class="tutor-bubble tutor-bubble-loading"><span class="dot">•</span><span class="dot">•</span><span class="dot">•</span></div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

function updateTutorLimitWarning() {
  if (userDoc?.tier !== 'free') return;
  const remaining = Math.max(0, 10 - tutorMsgCount);
  const warn = document.getElementById('tutor-limit-warning');
  const leftEl = document.getElementById('tutor-msgs-left');
  if (remaining <= 3) {
    warn.classList.remove('hidden');
    leftEl.textContent = remaining;
  }
}

// Update tutor context sidebar when paper changes
function updateTutorSidebar() {
  const el = document.getElementById('tutor-paper-context');
  if (currentPaper?.paperJSON) {
    const { subject, paper, totalMarks } = currentPaper.paperJSON;
    el.textContent = `${subject} — ${paper}\n${totalMarks} marks`;
  } else {
    el.textContent = 'No paper loaded. Generate one from the dashboard.';
  }
}

// ── SETTINGS ─────────────────────────────────────────────────
function loadSettings() {
  if (!userDoc) return;
  document.getElementById('settings-email').textContent = userDoc.email || currentUser?.email || '—';
  document.getElementById('settings-plan').textContent = userDoc.tier === 'pro' ? 'Pro' : 'Free';
  document.getElementById('settings-papers').textContent = userDoc.papersGenerated ?? 0;

  const upgradeCard = document.getElementById('upgrade-card');
  upgradeCard.classList.toggle('hidden', userDoc.tier === 'pro');
}

document.getElementById('btn-upgrade')?.addEventListener('click', initiateUpgrade);
document.getElementById('modal-upgrade-btn')?.addEventListener('click', initiateUpgrade);

async function initiateUpgrade() {
  try {
    const { payfastUrl } = await createSubscription();
    window.location.href = payfastUrl;
  } catch (err) {
    toast('Could not start upgrade. Please try again.', 'error');
  }
}

// ── UPGRADE MODAL ─────────────────────────────────────────────
function showUpgradeModal() {
  document.getElementById('modal-upgrade').classList.remove('hidden');
}
document.getElementById('modal-upgrade-close').addEventListener('click', () => {
  document.getElementById('modal-upgrade').classList.add('hidden');
});
document.getElementById('modal-upgrade-cancel').addEventListener('click', () => {
  document.getElementById('modal-upgrade').classList.add('hidden');
});
document.getElementById('modal-upgrade').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
});

// ── TOAST ─────────────────────────────────────────────────────
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  el.classList.remove('hidden');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), 3500);
}

// ── HELPERS ───────────────────────────────────────────────────
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Compress an image to roughly maxBytes by downscaling + lowering JPEG quality.
// Falls back to the original file if the browser can't decode it (e.g. some
// HEIC images have no canvas decoder).
async function compressImage(file, maxBytes = 1_000_000) {
  if (file.size <= maxBytes && file.type !== 'image/heic' && file.type !== 'image/heif') return file;

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    console.warn('[photo] could not decode for compression, uploading original');
    return file; // HEIC without decoder, etc.
  }

  const MAX_DIM = 2000;
  let { width, height } = bitmap;
  const scale = Math.min(1, MAX_DIM / Math.max(width, height));
  width = Math.round(width * scale);
  height = Math.round(height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);

  // Step quality down until under the size cap (or quality floor reached).
  for (let q = 0.85; q >= 0.4; q -= 0.15) {
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', q));
    if (blob && (blob.size <= maxBytes || q <= 0.4)) return blob;
  }
  return file;
}

function escapeHTML(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function setGenStep(n) {
  [1, 2, 3].forEach(i => {
    const el = document.getElementById(`gstep-${i}`);
    el.classList.toggle('active', i === n);
    el.classList.remove('done');
  });
}

function setGenStepDone() {
  [1, 2, 3].forEach(i => {
    const el = document.getElementById(`gstep-${i}`);
    el.classList.remove('active');
    el.classList.add('done');
  });
}

function resetGenSteps() {
  [1, 2, 3].forEach(i => {
    const el = document.getElementById(`gstep-${i}`);
    el.classList.remove('active', 'done');
  });
  document.getElementById('gstep-1').classList.add('active');
  document.getElementById('gen-status').textContent = 'Generating questions…';
}

function friendlyAuthError(code) {
  const map = {
    'auth/invalid-credential': 'Incorrect email or password.',
    'auth/user-not-found': 'No account found with that email.',
    'auth/wrong-password': 'Incorrect password.',
    'auth/email-already-in-use': 'An account with that email already exists.',
    'auth/weak-password': 'Password must be at least 8 characters.',
    'auth/invalid-email': 'Please enter a valid email address.',
    'auth/too-many-requests': 'Too many attempts. Please try again later.'
  };
  return map[code] || 'Something went wrong. Please try again.';
}
