import { onAuth, signInEmail, signUpEmail, signInGoogle, signOutUser, getUserDoc, incrementPapersGenerated, getRecentSessions, saveSession, updateSession, getTopicPerformance, updateTopicPerformance } from './firebase.js';
import { generatePaper, markPaper, sendTutorMessage, createSubscription } from './api.js';
import { renderPaper, collectAnswers, renderResults } from './render.js';
import { getPapers, getTopics } from './subjects.js';

// ── STATE ───────────────────────────────────────────────────
let currentUser = null;
let userDoc = null;
let currentPaper = null;      // { paperJSON, sessionId }
let currentMarking = null;
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
window.toggleSolution = toggleSolution;

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
  const name = userDoc?.name?.split(' ')[0] || '';
  document.getElementById('dashboard-greeting').textContent = `${greeting}${name ? ', ' + name : ''}`;

  const usageBadge = document.getElementById('dashboard-usage');
  if (userDoc?.tier === 'free') {
    const used = userDoc.papersGenerated || 0;
    usageBadge.textContent = `${used}/5 free papers used`;
  } else {
    usageBadge.textContent = 'Pro — unlimited papers';
    usageBadge.style.background = 'var(--teal-lt)';
  }

  // Load recent sessions
  try {
    const sessions = await getRecentSessions(currentUser.uid);
    renderRecentSessions(sessions);
  } catch (e) { /* Firestore not configured yet */ }

  // Load topic performance
  try {
    const perf = await getTopicPerformance(currentUser.uid);
    renderTopicPerformance(perf);
  } catch (e) { /* Firestore not configured yet */ }
}

function renderRecentSessions(sessions) {
  const el = document.getElementById('recent-sessions');
  if (!sessions.length) {
    el.innerHTML = '<p class="empty-state">No sessions yet — generate your first paper above.</p>';
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
    card.addEventListener('click', async () => {
      const sid = card.dataset.sessionId;
      const { getSession } = await import('./firebase.js');
      const session = await getSession(sid);
      if (!session) return;
      currentPaper = { paperJSON: session.paperJSON, sessionId: sid };
      renderPaperView(session.paperJSON, session.subject, session.paper);
      navigate('paper');
    });
  });
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

  // Free tier gate
  if (userDoc?.tier === 'free' && (userDoc.papersGenerated || 0) >= 5) {
    showUpgradeModal();
    return;
  }

  const subject = genSubject.value;
  const paper   = genPaper.value;
  const mode    = genMode.value;
  const topic   = genTopic.value;

  if (!subject || !paper) return;

  const btn     = document.getElementById('btn-generate');
  const btnText = btn.querySelector('.btn-text');
  const loader  = btn.querySelector('.btn-loader');
  btn.disabled = true;
  btnText.classList.add('hidden');
  loader.classList.remove('hidden');

  try {
    const { paperJSON } = await generatePaper(subject, paper, mode, topic);

    // Save to Firestore and increment counter
    const sessionId = await saveSession(currentUser.uid, { subject, paper, mode, topic, paperJSON, marking: null });
    await incrementPapersGenerated(currentUser.uid);
    userDoc = { ...userDoc, papersGenerated: (userDoc.papersGenerated || 0) + 1 };

    currentPaper = { paperJSON, sessionId };
    renderPaperView(paperJSON, subject, paper);
    navigate('paper');

  } catch (err) {
    if (err.code === 'LIMIT_REACHED') {
      showUpgradeModal();
    } else {
      toast(err.message || 'Generation failed — please try again.', 'error');
    }
  } finally {
    btn.disabled = false;
    btnText.classList.remove('hidden');
    loader.classList.add('hidden');
  }
});

// ── PAPER VIEW ───────────────────────────────────────────────
function renderPaperView(paperJSON, subject, paper) {
  document.getElementById('paper-meta').textContent = `${subject} — ${paper} · ${paperJSON.totalMarks} marks · ${paperJSON.duration}`;
  document.getElementById('paper-content').innerHTML = renderPaper(paperJSON);

  // Re-render KaTeX after DOM update
  if (window.renderMathInElement) {
    window.renderMathInElement(document.getElementById('paper-content'), {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false }
      ]
    });
  }
}

document.getElementById('btn-back-dashboard').addEventListener('click', () => navigate('dashboard'));
document.getElementById('btn-print').addEventListener('click', () => window.print());

document.getElementById('btn-submit-paper').addEventListener('click', async () => {
  if (!currentPaper) return;
  const { paperJSON, sessionId } = currentPaper;
  const answers = collectAnswers(paperJSON);
  const hasAny = Object.values(answers).some(v => v.length > 0);
  if (!hasAny) {
    toast('Write at least one answer before submitting.', 'error');
    return;
  }

  const btn = document.getElementById('btn-submit-paper');
  btn.disabled = true;
  btn.textContent = 'Marking…';

  try {
    const { markingJSON } = await markPaper(paperJSON, answers);
    currentMarking = markingJSON;

    // Persist marking
    await updateSession(sessionId, { marking: markingJSON });

    // Update topic performance
    const topicScores = {};
    markingJSON.questionMarking?.forEach(qm => {
      // Map question to topic from paperJSON
      const q = paperJSON.questions.find(q => q.questionNumber === qm.questionNumber);
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
    await updateTopicPerformance(currentUser.uid, paperJSON.subject, markingJSON.weakTopics || [], markingJSON.strongTopics || [], topicPcts);

    renderResultsView(markingJSON, paperJSON);
    navigate('results');

  } catch (err) {
    toast(err.message || 'Marking failed — please try again.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Submit for Marking';
  }
});

// ── RESULTS VIEW ─────────────────────────────────────────────
function renderResultsView(markingJSON, paperJSON) {
  document.getElementById('results-content').innerHTML = renderResults(markingJSON, paperJSON);

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

// ── SOLUTION TOGGLE ──────────────────────────────────────────
function toggleSolution(partId) {
  const block = document.getElementById(`sol_${partId}`);
  const btn = document.querySelector(`[data-sol="${partId}"]`);
  if (!block || !btn) return;
  const isHidden = block.classList.contains('hidden');
  block.classList.toggle('hidden', !isHidden);
  btn.textContent = isHidden ? '▼ Hide solution' : '▶ Show solution';
  if (isHidden && window.renderMathInElement) {
    window.renderMathInElement(block, {
      delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }]
    });
  }
}

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
function escapeHTML(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
