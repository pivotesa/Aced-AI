// Renders a paper JSON into HTML and collects answer inputs

export function renderPaper(paperJSON) {
  const { subject, paper, grade, totalMarks, duration, questions } = paperJSON;

  const headerHTML = `
    <div class="paper-header">
      <h1>${subject} — ${paper}</h1>
      <p class="paper-subtitle">Grade ${grade} | IEB</p>
      <div class="paper-header-meta">
        <span><strong>Total marks:</strong> ${totalMarks}</span>
        <span><strong>Duration:</strong> ${duration}</span>
        <span><strong>Date:</strong> ${new Date().toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' })}</span>
      </div>
    </div>
    <div class="paper-instructions">
      <h4>Instructions</h4>
      Answer ALL questions. Show ALL working clearly. Write neatly and legibly. Number answers as per question numbers. Non-programmable calculators may be used unless otherwise stated.
    </div>`;

  const questionsHTML = questions.map(q => renderQuestion(q)).join('');
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
      ${q.context ? `<p class="part-text">${q.context}</p>` : ''}
      ${parts}
    </div>`;
}

function renderPart(qNum, p) {
  const partId = `q${qNum}_${p.part}`;
  const exprHTML = p.expression
    ? `<div class="part-expression">${escapeHTML(p.expression)}</div>`
    : '';

  return `
    <div class="question-part" data-part-id="${partId}">
      <div class="part-label">
        <span>(${p.part})</span>
        <span class="part-marks">(${p.marks} mark${p.marks !== 1 ? 's' : ''})</span>
      </div>
      <p class="part-text">${p.instruction}</p>
      ${exprHTML}
    </div>`;
}

export function renderAnswerSection() {
  return `
    <div class="answer-section" id="answer-section">
      <h3 class="answer-section-title">Submit Your Answers</h3>
      <p class="answer-section-hint">Type all your answers below, or upload a photo/document of your written work. Label each answer clearly, e.g. <strong>Q1(a):</strong> your answer here.</p>
      <textarea id="bulk-answer-input" class="bulk-answer-input" placeholder="Q1(a): …&#10;Q1(b): …&#10;Q2(a): …" rows="12"></textarea>
      <div class="answer-upload-row">
        <label class="answer-upload-label" for="answer-file-input">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          Upload photo or PDF
        </label>
        <input type="file" id="answer-file-input" accept="image/*,.pdf" style="display:none">
        <span id="answer-file-name" class="answer-file-name"></span>
      </div>
    </div>`;
}

export function renderResults(markingJSON, paperJSON) {
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
