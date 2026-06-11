// Renders the STUDENT-FACING paper (no solutions) and the post-submission memo.
//
// The paper object passed here has already had solutions stripped server-side
// (see api/_paper-split.js). We render only question text, any provided `given`
// material, mark totals, and per-part answer inputs. Solutions are rendered
// ONLY in the results/review view, from the separate `memo` object.

// ── KaTeX math typesetting ─────────────────────────────────────────────────
// Renders $...$ / $$...$$ fragments in a DOM subtree. Never throws: on a parse
// failure KaTeX leaves the raw source text in place and we log it.
export function typesetMath(rootEl) {
  if (!rootEl || !window.renderMathInElement) return;
  try {
    window.renderMathInElement(rootEl, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
      ],
      throwOnError: false,
      errorCallback: (msg, err) => console.warn('[katex] parse failed, showing raw text:', msg, err),
    });
  } catch (e) {
    console.warn('[katex] typeset failed:', e);
  }
}

// ── Student paper ───────────────────────────────────────────────────────────

export function renderPaper(paperJSON) {
  const { subject, paper, grade, totalMarks, duration, questions } = paperJSON;

  const headerHTML = `
    <div class="paper-header">
      <h1>${escapeHTML(subject)} — ${escapeHTML(paper)}</h1>
      <p class="paper-subtitle">Grade ${escapeHTML(grade)} | IEB</p>
      <div class="paper-header-meta">
        <span><strong>Total marks:</strong> ${escapeHTML(totalMarks)}</span>
        <span><strong>Duration:</strong> ${escapeHTML(duration)}</span>
        <span><strong>Date:</strong> ${new Date().toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' })}</span>
      </div>
    </div>
    <div class="paper-instructions">
      <h4>Instructions</h4>
      Answer ALL questions in the boxes provided, or upload a photo of your written working for each part. Show ALL working clearly. Non-programmable calculators may be used unless otherwise stated.
    </div>`;

  const questionsHTML = questions.map(renderQuestion).join('');
  return headerHTML + questionsHTML;
}

function renderQuestion(q) {
  const parts = q.parts.map(p => renderPart(q.questionNumber, p)).join('');
  return `
    <div class="question-block" data-q="${q.questionNumber}">
      <div class="question-number">
        Question ${q.questionNumber}
        <span class="question-total">[${q.questionTotal} marks]</span>
      </div>
      ${q.context ? `<p class="part-text">${escapeHTML(q.context)}</p>` : ''}
      ${parts}
    </div>`;
}

function renderPart(qNum, p) {
  const partId = `q${qNum}_${p.part}`;
  // `given` is sanctioned student-visible material (a provided formula/data).
  // NOTE: we never render `expression` or any solution field here.
  const givenHTML = p.given
    ? `<div class="part-given" title="Provided">${escapeHTML(p.given)}</div>`
    : '';

  return `
    <div class="question-part" data-part-id="${partId}">
      <div class="part-label">
        <span>(${escapeHTML(p.part)})</span>
        <span class="part-marks">(${p.marks} mark${p.marks !== 1 ? 's' : ''})</span>
      </div>
      <p class="part-text">${escapeHTML(p.instruction)}</p>
      ${givenHTML}
      ${renderAnswerControl(qNum, p.part, partId)}
    </div>`;
}

// Per-part answer input + photo-of-working upload.
function renderAnswerControl(qNum, part, partId) {
  return `
    <div class="answer-block" data-answer-for="${partId}" data-q="${qNum}" data-part="${escapeAttr(part)}">
      <textarea class="answer-input" id="ans-${partId}"
        placeholder="Type your answer for Q${qNum}(${escapeAttr(part)})… or upload a photo of your working below"
        rows="3"></textarea>
      <div class="answer-tools">
        <label class="photo-upload-btn" for="photo-${partId}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
          Upload photo of working
        </label>
        <input type="file" id="photo-${partId}" class="photo-input"
          accept="image/jpeg,image/png,image/heic,image/heif" capture="environment" hidden>
        <span class="photo-status" id="photostatus-${partId}"></span>
      </div>
      <div class="photo-thumb-wrap" id="thumb-${partId}" hidden></div>
    </div>`;
}

// ── Post-submission memo (solutions) ────────────────────────────────────────
// Rendered ONLY in the results view, after the student has submitted.
export function renderMemo(memo) {
  if (!memo?.questions?.length) return '';
  const qs = memo.questions.map(q => {
    const parts = (q.parts || []).map(p => {
      const sol = p.solution || {};
      const steps = (sol.steps || []).map(s => `<li>${escapeHTML(s)}</li>`).join('');
      const mm = (sol.methodMarks || []).map(m => `<span class="memo-mm">${m.mark}✓ ${escapeHTML(m.criterion)}</span>`).join('');
      return `
        <div class="memo-part">
          <div class="memo-part-label">(${escapeHTML(p.part)}) <span class="part-marks">(${p.marks})</span></div>
          ${steps ? `<ol class="memo-steps">${steps}</ol>` : ''}
          ${sol.answer ? `<div class="memo-answer"><strong>Answer:</strong> ${escapeHTML(sol.answer)}</div>` : ''}
          ${mm ? `<div class="memo-marks">${mm}</div>` : ''}
        </div>`;
    }).join('');
    return `
      <details class="memo-question">
        <summary>Question ${q.questionNumber} — ${escapeHTML(q.topic || '')} memorandum</summary>
        ${parts}
      </details>`;
  }).join('');
  return `<div class="memo-section"><h3 class="memo-title">Memorandum</h3>${qs}</div>`;
}

// ── Results ─────────────────────────────────────────────────────────────────

export function renderResults(markingJSON, paperJSON, memo) {
  const { totalAwarded, totalAvailable, percentage, generalFeedback, weakTopics, strongTopics, questionMarking } = markingJSON;
  const pctClass = percentage >= 70 ? 'green' : percentage >= 50 ? 'orange' : 'red';

  const scoreCard = `
    <div class="results-score-card">
      <div class="score-fraction">${totalAwarded} / ${totalAvailable}</div>
      <div class="score-pct ${pctClass}">${percentage}%</div>
      <div class="score-label">${scoreLabel(percentage)}</div>
    </div>`;

  const generalCard = generalFeedback ? `
    <div class="general-feedback-card">
      <p>${escapeHTML(generalFeedback)}</p>
    </div>` : '';

  const questionsHTML = questionMarking.map(qm => renderQuestionResult(qm, paperJSON)).join('');

  const sideCards = `
    <div>
      ${weakTopics?.length ? `
        <div class="weak-topics-card card" style="margin-bottom:16px">
          <div class="card-title">Topics to revise</div>
          <div class="topics-list">${weakTopics.map(t => `<span class="topic-chip weak">${escapeHTML(t)}</span>`).join('')}</div>
        </div>` : ''}
      ${strongTopics?.length ? `
        <div class="strong-topics-card card">
          <div class="card-title">Strong topics</div>
          <div class="topics-list">${strongTopics.map(t => `<span class="topic-chip strong">${escapeHTML(t)}</span>`).join('')}</div>
        </div>` : ''}
    </div>`;

  return `
    ${scoreCard}
    ${generalCard}
    <div class="results-grid">
      <div>${questionsHTML}</div>
      ${sideCards}
    </div>
    ${memo ? renderMemo(memo) : ''}
    <div class="results-cta">
      <button class="btn-ghost" id="btn-results-back-paper">Review paper</button>
      <button class="btn-primary" id="btn-results-new">New paper</button>
    </div>`;
}

function renderQuestionResult(qm, paperJSON) {
  const { questionNumber, part, marksAwarded, marksAvailable, feedback, methodMarksBreakdown } = qm;
  const ratio = marksAvailable > 0 ? marksAwarded / marksAvailable : 0;
  const cls = ratio === 1 ? 'full' : ratio >= 0.5 ? 'partial' : 'low';

  const mmHTML = methodMarksBreakdown?.length ? `
    <div class="method-marks">
      ${methodMarksBreakdown.map(mm => `
        <div class="method-mark">
          <span class="${mm.awarded ? 'tick' : 'cross'}">${mm.awarded ? '✓' : '✗'}</span>
          <span>${escapeHTML(mm.criterion)}</span>
        </div>`).join('')}
    </div>` : '';

  return `
    <div class="result-question-card">
      <div class="result-q-header">
        <span class="result-q-label">Q${questionNumber}(${part})</span>
        <span class="result-q-score ${cls}">${marksAwarded}/${marksAvailable}</span>
      </div>
      ${feedback ? `<p class="result-feedback">${escapeHTML(feedback)}</p>` : ''}
      ${mmHTML}
    </div>`;
}

function scoreLabel(pct) {
  if (pct >= 80) return 'Outstanding — distinction level';
  if (pct >= 70) return 'Merit — above average';
  if (pct >= 60) return 'Satisfactory';
  if (pct >= 50) return 'Adequate — just passing';
  return 'Below pass — review weak topics';
}

function escapeHTML(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  return escapeHTML(str).replace(/'/g, '&#39;');
}
