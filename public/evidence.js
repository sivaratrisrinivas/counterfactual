const video = document.querySelector('#evidence-video');
const overlay = document.querySelector('#evidence-overlay');
const overlayContext = overlay.getContext('2d');
const reviewForm = document.querySelector('#evidence-review-form');
const analysisState = { analysis: null, review: null };

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));

function nearestFrame(timeSeconds) {
  const frames = analysisState.analysis?.detections ?? [];
  return frames.reduce((closest, frame) => Math.abs(frame.timeSeconds - timeSeconds) < Math.abs(closest.timeSeconds - timeSeconds) ? frame : closest, frames[0] ?? { timeSeconds: 0, people: [] });
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
  document.querySelector('#video-time').textContent = `${video.currentTime.toFixed(1)}s · frame ${frame.frameIndex ?? 0}`;
}

function renderAnalysis(analysis) {
  analysisState.analysis = analysis;
  video.src = '/media/prepared-checkout.mp4';
  document.querySelector('#analysis-status').textContent = 'Saved analysis · no fresh inference';
  document.querySelector('#analysis-facts').innerHTML = `<div><span>Clip</span><strong>${escapeHtml(analysis.clip.filename)}</strong></div><div><span>Duration</span><strong>${analysis.clip.durationSeconds}s</strong></div><div><span>Segmentation</span><strong>${escapeHtml(analysis.provenance.models.segmentation)}</strong></div><div><span>Interpretation</span><strong>${escapeHtml(analysis.provenance.models.interpretation)}</strong></div><div><span>Processed</span><strong>${analysis.provenance.processedFrameCount} frames at ${analysis.provenance.processedFps} fps</strong></div>`;
  document.querySelector('#analysis-verdict').innerHTML = `<span class="verdict-label">Qualification</span><strong>Insufficient for calibration</strong><p>${escapeHtml(analysis.qualification.rationale)}</p>`;
  document.querySelector('#analysis-limitations').innerHTML = analysis.limitations.map((limitation) => `<li>${escapeHtml(limitation)}</li>`).join('');
  document.querySelector('#analysis-source').innerHTML = `Source: <a href="${escapeHtml(analysis.clip.sourceUrl)}" target="_blank" rel="noreferrer">Pexels footage</a> · <a href="${escapeHtml(analysis.clip.licenseUrl)}" target="_blank" rel="noreferrer">license</a>`;
  document.querySelector('#evidence-zones').value = JSON.stringify(analysis.candidateZones, null, 2);
  document.querySelector('#evidence-events').value = JSON.stringify(analysis.candidateEvents, null, 2);
  drawOverlay();
}

function showReview(review) {
  analysisState.review = review;
  const result = document.querySelector('#evidence-review-result');
  result.hidden = false;
  result.innerHTML = `<strong>Review v${review.reviewVersion} saved.</strong><span>${review.completeWaitCount} complete observed waits; ${review.incompleteCases.length} incomplete or unobservable cases.</span><span>${escapeHtml(review.calibrationStatus.replaceAll('-', ' '))}. Assumed timings remain assumptions.</span>`;
  document.dispatchEvent(new CustomEvent('counterfactual:evidence-reviewed', { detail: review }));
}

reviewForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = reviewForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const zones = JSON.parse(document.querySelector('#evidence-zones').value);
    const observations = JSON.parse(document.querySelector('#evidence-events').value);
    const assumptions = document.querySelector('#evidence-assumptions').value.split('\n').map((value) => value.trim()).filter(Boolean);
    const response = await fetch(`/api/analysis/${analysisState.analysis.id}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topology: document.querySelector('#evidence-topology').value, baselinePositions: Number(document.querySelector('#evidence-baseline').value), zones, observations, assumptions, assumedArrivals: [{ id: 'assumed-1', arrivalTime: 0, serviceDuration: 5 }, { id: 'assumed-2', arrivalTime: 1, serviceDuration: 5 }, { id: 'assumed-3', arrivalTime: 2, serviceDuration: 5 }] }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Evidence review could not be saved.');
    showReview(body.review);
  } catch (error) {
    document.querySelector('#evidence-review-result').hidden = false;
    document.querySelector('#evidence-review-result').textContent = error.message;
  } finally { button.disabled = false; }
});

video.addEventListener('timeupdate', drawOverlay);
video.addEventListener('loadedmetadata', drawOverlay);
window.addEventListener('resize', drawOverlay);

fetch('/api/analysis/prepared').then((response) => response.json()).then(({ analysis }) => renderAnalysis(analysis)).catch((error) => {
  document.querySelector('#analysis-status').textContent = 'Saved analysis unavailable';
  document.querySelector('#analysis-verdict').textContent = error.message;
});
