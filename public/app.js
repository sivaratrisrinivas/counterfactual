import { renderPlayback } from './playback.js';

const state = { model: null, comparison: null, playback: null, evidenceReview: null, evidenceReviewStale: false };
const arrivalList = document.querySelector('#arrival-list');
const modelForm = document.querySelector('#model-form');
const reviewButton = document.querySelector('#review-button');
const compareForm = document.querySelector('#compare-form');
const resultSection = document.querySelector('#result-section');
const notice = document.querySelector('#notice');

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));

function showNotice(message, kind = 'info') {
  notice.textContent = message;
  notice.className = `notice ${kind}`;
  notice.hidden = false;
}

function clearNotice() {
  notice.hidden = true;
}

function addArrivalRow(values = {}) {
  const row = document.createElement('div');
  row.className = 'arrival-row';
  row.innerHTML = `<span class="arrival-person">${escapeHtml(values.id || `Person ${arrivalList.children.length + 1}`)}</span>
    <input class="arrival-time" aria-label="Arrival time in seconds" type="number" min="0" step="0.1" value="${values.arrivalTime ?? ''}" required>
    <span class="unit">sec</span>
    <input class="service-duration" aria-label="Service demand in seconds" type="number" min="0.1" step="0.1" value="${values.serviceDuration ?? ''}" required>
    <span class="unit">sec</span>
    <button class="remove-arrival" type="button" aria-label="Remove ${escapeHtml(values.id || 'arrival')}">×</button>`;
  row.querySelector('.remove-arrival').addEventListener('click', () => {
    if (arrivalList.children.length <= 1) {
      showNotice('Keep at least one arrival in the finite cohort.', 'error');
      return;
    }
    row.remove();
    renumberArrivals();
    markDraftChanged();
  });
  arrivalList.append(row);
}

function renumberArrivals() {
  [...arrivalList.children].forEach((row, index) => { row.querySelector('.arrival-person').textContent = `Person ${index + 1}`; });
}

function markDraftChanged() {
  if (state.model) {
    state.playback?.destroy();
    state.playback = null;
    state.model.reviewed = false;
    reviewButton.disabled = true;
    document.querySelector('#review-tag').textContent = 'Inputs changed';
    document.querySelector('#workflow-status').textContent = 'Unsaved edits';
    document.querySelector('.intervention-button').disabled = true;
    resultSection.hidden = true;
  }
}

function collectInputs() {
  const arrivals = [...arrivalList.children].map((row, index) => ({
    id: `customer-${index + 1}`,
    arrivalTime: Number(row.querySelector('.arrival-time').value),
    serviceDuration: Number(row.querySelector('.service-duration').value),
  }));
  return {
    baselinePositions: Number(document.querySelector('#baseline-positions').value),
    arrivals,
    initialState: { kind: document.querySelector('#initial-state').value },
    ...(state.evidenceReview ? { evidenceReview: state.evidenceReview } : {}),
  };
}

async function request(path, options = {}) {
  const response = await fetch(path, { headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'The request could not be completed.');
  return body;
}

function renderModel(model) {
  state.playback?.destroy();
  state.playback = null;
  state.model = model;
  state.comparison = null;
  window.dispatchEvent(new CustomEvent('counterfactual:model-updated', { detail: model }));
  document.querySelector('#fact-arrivals').textContent = `${model.arrivals.length} people`;
  document.querySelector('#fact-baseline').textContent = `${model.baselinePositions} ${model.baselinePositions === 1 ? 'position' : 'positions'}`;
  document.querySelector('#fact-initial').textContent = 'Explicitly empty';
  document.querySelector('#fact-version').textContent = `v${model.version}`;
  document.querySelector('#review-facts').hidden = false;
  document.querySelector('#assumptions').hidden = false;
  document.querySelector('#assumption-list').innerHTML = model.assumptions.map((assumption) => `<li>${escapeHtml(assumption)}</li>`).join('');
  reviewButton.disabled = false;
  reviewButton.textContent = model.reviewed ? 'Reviewed model confirmed' : 'Confirm reviewed model';
  document.querySelector('#review-tag').textContent = model.reviewed ? 'Reviewed' : 'Ready for review';
  document.querySelector('#workflow-status').textContent = model.reviewed ? `Reviewed model v${model.version}` : `Draft model v${model.version}`;
  document.querySelector('.intervention-button').disabled = !model.reviewed;
  document.querySelector('#review-copy').innerHTML = model.reviewed
    ? '<p class="reviewed-message">The inputs above are the reviewed model. Any edit will require a fresh review.</p>'
    : '<p>Check the cohort, staffing, and assumptions. Confirm when the setup matches the question you want to ask.</p>';
}

function fillForm(model) {
  document.querySelector('#baseline-positions').value = model.baselinePositions;
  document.querySelector('#initial-state').value = model.initialState.kind;
  arrivalList.innerHTML = '';
  model.arrivals.forEach(addArrivalRow);
}

modelForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearNotice();
  if (state.evidenceReviewStale) {
    showNotice('Evidence review changed. Re-review the evidence before saving model inputs again.', 'error');
    return;
  }
  try {
    const payload = collectInputs();
    const result = state.model
      ? await request(`/api/models/${state.model.id}`, { method: 'PUT', body: JSON.stringify(payload) })
      : await request('/api/models', { method: 'POST', body: JSON.stringify(payload) });
    renderModel(result.model);
    resultSection.hidden = true;
    showNotice('Inputs saved. Review this model before running a what-if.', 'success');
  } catch (error) {
    showNotice(error.message, 'error');
  }
});

reviewButton.addEventListener('click', async () => {
  if (!state.model) return;
  try {
    const result = await request(`/api/models/${state.model.id}/review`, { method: 'POST', body: JSON.stringify({ expectedVersion: state.model.version }) });
    renderModel(result.model);
    showNotice('Reviewed model confirmed. Choose an intervention position count.', 'success');
  } catch (error) { showNotice(error.message, 'error'); }
});

compareForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.model?.reviewed) {
    showNotice('Confirm the reviewed model before running a what-if.', 'error');
    return;
  }
  try {
    const result = await request(`/api/models/${state.model.id}/compare`, {
      method: 'POST',
      body: JSON.stringify({ reviewedVersion: state.model.version, interventionPositions: Number(document.querySelector('#intervention-positions').value) }),
    });
    state.comparison = result.comparison;
    renderComparison(result.comparison);
    window.dispatchEvent(new CustomEvent('counterfactual:comparison-updated', { detail: result.comparison }));
    showNotice('Comparison updated from the current reviewed model.', 'success');
  } catch (error) { showNotice(error.message, 'error'); }
});

document.querySelector('#add-arrival').addEventListener('click', () => { addArrivalRow(); markDraftChanged(); });
modelForm.addEventListener('input', markDraftChanged);

function formatSeconds(value) { return `${Number(value).toFixed(value % 1 ? 1 : 0)}s`; }

function renderComparison(comparison) {
  resultSection.hidden = false;
  state.playback?.destroy();
  state.playback = null;
  const reduction = comparison.baseline.meanWaitingTime - comparison.intervention.meanWaitingTime;
  const reductionLabel = reduction === 0 ? 'No change' : reduction > 0 ? `${formatSeconds(reduction)} less` : `${formatSeconds(Math.abs(reduction))} more`;
  document.querySelector('#metric-strip').innerHTML = `
    <div class="metric baseline-metric"><span>Baseline wait</span><strong>${formatSeconds(comparison.baseline.meanWaitingTime)}</strong><small>${comparison.baselinePositions} position${comparison.baselinePositions === 1 ? '' : 's'}</small></div>
    <div class="metric intervention-metric"><span>Intervention wait</span><strong>${formatSeconds(comparison.intervention.meanWaitingTime)}</strong><small>${comparison.interventionPositions} positions</small></div>
    <div class="metric delta-metric"><span>Difference</span><strong>${reductionLabel}</strong><small>absolute difference · model v${comparison.modelVersion}</small></div>`;
  const maxQueue = Math.max(1, ...comparison.queueLengthTimelines.baseline.map((point) => point.queueLength), ...comparison.queueLengthTimelines.intervention.map((point) => point.queueLength));
  const times = [...new Set([...comparison.queueLengthTimelines.baseline, ...comparison.queueLengthTimelines.intervention].map((point) => point.time))].sort((a, b) => a - b);
  const queueAt = (timeline, time) => timeline.find((point) => point.time === time)?.queueLength ?? timeline.filter((point) => point.time < time).at(-1)?.queueLength ?? 0;
  document.querySelector('#timeline').innerHTML = `<div class="timeline-axis"><span>0s</span><span>${formatSeconds(times.at(-1) || 0)}</span></div>${times.map((time) => `<div class="timeline-row"><span class="time-label">${formatSeconds(time)}</span><div class="tracks"><div class="track baseline-track"><i style="width:${(queueAt(comparison.queueLengthTimelines.baseline, time) / maxQueue) * 100}%"></i><b>${queueAt(comparison.queueLengthTimelines.baseline, time)}</b></div><div class="track intervention-track"><i style="width:${(queueAt(comparison.queueLengthTimelines.intervention, time) / maxQueue) * 100}%"></i><b>${queueAt(comparison.queueLengthTimelines.intervention, time)}</b></div></div></div>`).join('')}`;
  const serviceStarts = comparison.baseline.customers.map((customer, index) => `<div class="event-row"><span>${escapeHtml(customer.id)}</span><span class="event-baseline">${formatSeconds(customer.serviceStartTime)}</span><span class="event-intervention">${formatSeconds(comparison.intervention.customers[index].serviceStartTime)}</span></div>`).join('');
  document.querySelector('#event-table').innerHTML = `<div class="event-header"><span>Person</span><span>Base</span><span>What-if</span></div>${serviceStarts}`;
  document.querySelector('#result-assumption-list').innerHTML = comparison.assumptions.map((assumption) => `<span>${escapeHtml(assumption)}</span>`).join('');
  state.playback = renderPlayback(comparison);
}

window.addEventListener('counterfactual:staffing-comparison', (event) => {
  state.comparison = event.detail;
  renderComparison(event.detail);
  resultSection.hidden = false;
  showNotice('Confirmed staffing interpretation calculated from the reviewed model.', 'success');
});

addArrivalRow({ arrivalTime: 0, serviceDuration: 5 });
addArrivalRow({ arrivalTime: 1, serviceDuration: 5 });
addArrivalRow({ arrivalTime: 2, serviceDuration: 5 });

document.addEventListener('counterfactual:evidence-reviewed', (event) => {
  const inputs = event.detail.proposedModelInputs;
  state.evidenceReview = inputs.evidenceReview;
  state.evidenceReviewStale = false;
  state.comparison = null;
  state.playback?.destroy();
  state.playback = null;
  resultSection.hidden = true;
  if (state.model) {
    state.model.reviewed = false;
    state.model.reviewedAt = null;
    reviewButton.disabled = true;
    reviewButton.textContent = 'Save reviewed evidence first';
    document.querySelector('#review-tag').textContent = 'Evidence re-reviewed';
    document.querySelector('#workflow-status').textContent = 'Evidence re-reviewed · save model inputs';
    document.querySelector('.intervention-button').disabled = true;
    window.dispatchEvent(new CustomEvent('counterfactual:model-updated', { detail: state.model }));
  }
  document.querySelector('#baseline-positions').value = inputs.baselinePositions;
  arrivalList.innerHTML = '';
  for (const arrival of inputs.arrivals) addArrivalRow(arrival);
  document.querySelector('#initial-state').value = inputs.initialState.kind;
  document.querySelector('#workflow-status').textContent = 'Evidence reviewed · save model inputs';
  showNotice('Evidence review is ready. Save these explicit inputs before confirming the reviewed model.', 'success');
});

document.addEventListener('counterfactual:evidence-invalidated', () => {
  state.evidenceReview = null;
  state.evidenceReviewStale = true;
  state.comparison = null;
  state.playback?.destroy();
  state.playback = null;
  resultSection.hidden = true;
  if (state.model) {
    state.model.reviewed = false;
    state.model.reviewedAt = null;
    reviewButton.disabled = true;
    reviewButton.textContent = 'Save a fresh evidence review';
    document.querySelector('#review-tag').textContent = 'Evidence changed';
    document.querySelector('#workflow-status').textContent = 'Evidence review changed';
    document.querySelector('.intervention-button').disabled = true;
    window.dispatchEvent(new CustomEvent('counterfactual:model-updated', { detail: state.model }));
  }
  showNotice('Evidence review changed. Re-review the evidence before saving model inputs again.', 'error');
});
