const video = document.querySelector('#evidence-video');
const overlay = document.querySelector('#evidence-overlay');
const overlayContext = overlay.getContext('2d');
const reviewForm = document.querySelector('#evidence-review-form');
const analysisState = { analysis: null, review: null };

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));

function nearestFrame(timeSeconds) {
  const frames = analysisState.analysis?.detections ?? [];
  const fps = analysisState.analysis?.provenance?.processedFps ?? 1;
  const targetFrame = Math.floor(timeSeconds * fps);
  const frame = frames.find((candidate) => candidate.frameIndex === targetFrame);
  return frame && Math.abs(frame.timeSeconds - timeSeconds) <= (1 / fps) ? frame : { frameIndex: targetFrame, timeSeconds, people: [] };
}

function drawOverlay() {
  if (!analysisState.analysis || !video.videoWidth || !video.videoHeight) return;
  const width = video.clientWidth;
  const height = video.clientHeight;
  overlay.width = Math.max(1, Math.round(width * devicePixelRatio));
  overlay.height = Math.max(1, Math.round(height * devicePixelRatio));
  overlay.style.width = `${width}px`;
  overlay.style.height = `${height}px`;
  overlayContext.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  overlayContext.clearRect(0, 0, width, height);
  const frame = nearestFrame(video.currentTime);
  for (const person of frame.people) {
    const box = person.box;
    const x = (box.x1 / box.width) * width;
    const y = (box.y1 / box.height) * height;
    const w = ((box.x2 - box.x1) / box.width) * width;
    const h = ((box.y2 - box.y1) / box.height) * height;
    const color = person.role === 'staff' ? '#f28f3b' : person.role === 'background' ? '#9ca3af' : '#1677ff';
    overlayContext.strokeStyle = color;
    overlayContext.lineWidth = 2;
    overlayContext.strokeRect(x, y, w, h);
    overlayContext.fillStyle = color;
    overlayContext.font = '11px system-ui, sans-serif';
    overlayContext.fillText(`${person.id ?? '?'} · ${person.membership}`, x + 3, Math.max(12, y - 4));
  }
  for (const zone of analysisState.analysis.candidateZones ?? []) {
    overlayContext.strokeStyle = zone.kind === 'service' ? '#f28f3b' : '#54b98b';
    overlayContext.setLineDash([6, 4]);
    overlayContext.lineWidth = 2;
    overlayContext.strokeRect(zone.x * width, zone.y * height, zone.width * width, zone.height * height);
    overlayContext.fillStyle = overlayContext.strokeStyle;
    overlayContext.font = '11px system-ui, sans-serif';
    overlayContext.fillText(zone.label, zone.x * width + 4, zone.y * height + 14);
    overlayContext.setLineDash([]);
  }
  document.querySelector('#video-time').textContent = `${video.currentTime.toFixed(1)}s · frame ${frame.frameIndex ?? 0}`;
}

function renderAnalysis(analysis) {
  analysisState.analysis = analysis;
  video.src = analysis.status === 'fresh' ? (analysis.clip.videoUrl || `/api/analysis/uploads/${analysis.id}/video`) : '/media/prepared-checkout.mp4';
  document.querySelector('#analysis-status').textContent = analysis.status === 'fresh' ? 'Fresh analysis · computed now' : 'Saved analysis · no fresh inference';
  document.querySelector('#analysis-facts').innerHTML = `<div><span>Clip</span><strong>${escapeHtml(analysis.clip.filename)}</strong></div><div><span>Duration</span><strong>${analysis.clip.durationSeconds}s</strong></div><div><span>Segmentation</span><strong>${escapeHtml(analysis.provenance.models.segmentation)}</strong></div><div><span>Interpretation</span><strong>${escapeHtml(analysis.provenance.models.interpretation)}</strong></div><div><span>Processed</span><strong>${analysis.provenance.processedFrameCount} frames at ${analysis.provenance.processedFps} fps</strong></div>`;
  const qualificationLabel = analysis.qualification.calibrationEligible ? 'Potentially eligible · human review required' : 'Insufficient for calibration';
  document.querySelector('#analysis-verdict').innerHTML = `<span class="verdict-label">Qualification</span><strong>${qualificationLabel}</strong><p>${escapeHtml(analysis.qualification.rationale)}</p>`;
  document.querySelector('#analysis-limitations').innerHTML = analysis.limitations.map((limitation) => `<li>${escapeHtml(limitation)}</li>`).join('');
  const sourceLabel = analysis.status === 'fresh' ? 'user upload · rights unverified' : 'prepared footage';
  document.querySelector('#analysis-source').innerHTML = `Source: <a href="${escapeHtml(analysis.clip.sourceUrl)}" target="_blank" rel="noreferrer">${sourceLabel}</a> · <a href="${escapeHtml(analysis.clip.licenseUrl)}" target="_blank" rel="noreferrer">rights note</a>`;
  document.querySelector('#evidence-zones').value = JSON.stringify(analysis.candidateZones, null, 2);
  document.querySelector('#evidence-events').value = JSON.stringify(analysis.candidateEvents, null, 2);
  const people = [...new Map(analysis.detections.flatMap((frame) => frame.people.map((person) => [person.id, person]))).values()].slice(0, 8);
  document.querySelector('#detection-role-editor').innerHTML = `<p class="field-label">Review representative person roles and continuity</p><div class="role-editor-grid">${people.map((person) => `<label>Person ${escapeHtml(person.id)}<select data-person-id="${escapeHtml(person.id)}" class="role-correction"><option value="customer" ${person.role === 'customer' ? 'selected' : ''}>Customer</option><option value="staff" ${person.role === 'staff' ? 'selected' : ''}>Staff</option><option value="background" ${person.role === 'background' ? 'selected' : ''}>Background</option><option value="unknown" ${person.role === 'unknown' ? 'selected' : ''}>Unknown</option></select><select data-person-id="${escapeHtml(person.id)}" class="continuity-correction"><option value="continuous">Continuous</option><option value="unknown" selected>Unknown / review</option><option value="discontinuous">Discontinuous</option></select></label>`).join('')}</div>`;
  drawOverlay();
}

window.counterfactualLoadAnalysis = renderAnalysis;

function showReview(review) {
  analysisState.review = review;
  const result = document.querySelector('#evidence-review-result');
  result.hidden = false;
  result.innerHTML = `<strong>Review v${review.reviewVersion} saved.</strong><span>${review.completeWaitCount} complete observed waits; ${review.incompleteCases.length} incomplete or unobservable cases.</span><span>${escapeHtml(review.calibrationStatus.replaceAll('-', ' '))}. Assumed timings remain assumptions.</span>`;
  document.dispatchEvent(new CustomEvent('counterfactual:evidence-reviewed', { detail: review }));
}

function markReviewEdited() {
  if (!analysisState.review) return;
  analysisState.review = null;
  const result = document.querySelector('#evidence-review-result');
  result.hidden = false;
  result.innerHTML = '<strong>Evidence review changed.</strong><span>Re-review these evidence inputs before saving the model again.</span>';
  document.dispatchEvent(new CustomEvent('counterfactual:evidence-invalidated'));
}

reviewForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = reviewForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const zones = JSON.parse(document.querySelector('#evidence-zones').value);
    const observations = JSON.parse(document.querySelector('#evidence-events').value);
    const roleByPerson = new Map([...document.querySelectorAll('.role-correction')].map((select) => [Number(select.dataset.personId), select.value]));
    const continuityByPerson = new Map([...document.querySelectorAll('.continuity-correction')].map((select) => [Number(select.dataset.personId), select.value]));
    for (const observation of observations) {
      if (roleByPerson.has(Number(observation.personId))) observation.role = roleByPerson.get(Number(observation.personId));
      if (continuityByPerson.has(Number(observation.personId))) observation.continuity = continuityByPerson.get(Number(observation.personId));
    }
    const assumptions = document.querySelector('#evidence-assumptions').value.split('\n').map((value) => value.trim()).filter(Boolean);
    const response = await fetch(`/api/analysis/${analysisState.analysis.id}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topology: document.querySelector('#evidence-topology').value, baselinePositions: Number(document.querySelector('#evidence-baseline').value), initialState: { kind: 'empty', source: { kind: 'assumption', reason: 'The clip does not show the queue at the start.' } }, zones, observations, assumptions, assumedArrivals: [{ id: 'assumed-1', arrivalTime: 0, serviceDuration: 5 }, { id: 'assumed-2', arrivalTime: 1, serviceDuration: 5 }, { id: 'assumed-3', arrivalTime: 2, serviceDuration: 5 }] }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Evidence review could not be saved.');
    showReview(body.review);
  } catch (error) {
    document.querySelector('#evidence-review-result').hidden = false;
    document.querySelector('#evidence-review-result').textContent = error.message;
  } finally { button.disabled = false; }
});

reviewForm.addEventListener('input', markReviewEdited);
reviewForm.addEventListener('change', markReviewEdited);

video.addEventListener('timeupdate', drawOverlay);
video.addEventListener('loadedmetadata', drawOverlay);
window.addEventListener('resize', drawOverlay);

fetch('/api/analysis/prepared').then((response) => response.json()).then(({ analysis }) => renderAnalysis(analysis)).catch((error) => {
  document.querySelector('#analysis-status').textContent = 'Saved analysis unavailable';
  document.querySelector('#analysis-verdict').textContent = error.message;
});
