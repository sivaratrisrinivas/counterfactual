const form = document.querySelector('#fresh-upload-form');
const fileInput = document.querySelector('#fresh-upload-file');
const status = document.querySelector('#fresh-upload-status');
const error = document.querySelector('#fresh-upload-error');
const preparedButton = document.querySelector('#prepared-demo-button');
let sourceGeneration = 0;

function setStatus(message) { status.textContent = message; error.hidden = true; }
function setError(message) { error.textContent = message; error.hidden = false; status.textContent = 'Fresh analysis failed'; }
function changeSource() {
  sourceGeneration += 1;
  document.dispatchEvent(new CustomEvent('counterfactual:analysis-source-changed'));
  return sourceGeneration;
}

async function pollUpload(id, generation) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (generation !== sourceGeneration) return null;
    const response = await fetch(`/api/analysis/uploads/${encodeURIComponent(id)}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Fresh analysis status was unavailable.');
    if (generation !== sourceGeneration) return null;
    if (body.upload.status === 'completed') return body.upload.analysis;
    if (body.upload.status === 'failed') throw new Error(body.upload.error || 'Fresh analysis failed.');
    setStatus(body.upload.status === 'running' ? 'Analyzing fresh clip · models are running' : 'Upload received · preparing clip');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Fresh analysis timed out. Return to the prepared demo or retry once.');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = fileInput.files?.[0];
  if (!file) return setError('Choose a video file first.');
  const generation = changeSource();
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  setStatus('Uploading fresh clip · checking bounds');
  try {
    const body = new FormData(); body.set('video', file);
    const response = await fetch('/api/analysis/upload', { method: 'POST', body });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The upload could not be started.');
    const analysis = await pollUpload(result.upload.id, generation);
    if (!analysis || generation !== sourceGeneration) return;
    if (typeof window.counterfactualLoadAnalysis !== 'function') throw new Error('Evidence review is not ready. Refresh and retry.');
    window.counterfactualLoadAnalysis(analysis);
    setStatus('Fresh analysis complete · review evidence below');
    document.querySelector('#evidence-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (uploadError) {
    if (generation === sourceGeneration) setError(uploadError.message);
  } finally { button.disabled = false; }
});

preparedButton.addEventListener('click', async () => {
  const generation = changeSource();
  preparedButton.disabled = true;
  setStatus('Loading prepared demo · saved analysis');
  try {
    const response = await fetch('/api/analysis/prepared'); const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'The prepared demo is unavailable.');
    if (generation !== sourceGeneration) return;
    window.counterfactualLoadAnalysis(body.analysis);
    setStatus('Prepared demo selected · saved analysis');
  } catch (loadError) { if (generation === sourceGeneration) setError(loadError.message); }
  finally { preparedButton.disabled = false; }
});
