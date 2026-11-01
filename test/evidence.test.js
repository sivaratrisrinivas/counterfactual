import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server.js';
import { parseSamOutput } from '../src/analysis.js';

async function withServer(run) {
  const server = await startServer({ port: 0 });
  try { return await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

async function jsonFetch(base, path, options) {
  const response = await fetch(`${base}${path}`, { headers: { 'content-type': 'application/json', ...(options?.headers ?? {}) }, ...options });
  return { response, body: await response.json() };
}

test('prepared analysis exposes provenance, explicit frame timing, rights and rejected calibration verdict', async () => {
  await withServer(async (base) => {
    const result = await jsonFetch(base, '/api/analysis/prepared');
    assert.equal(result.response.status, 200);
    const { analysis } = result.body;
    assert.equal(analysis.status, 'saved');
    assert.equal(analysis.provenance.models.segmentation, 'sam-3.1');
    assert.equal(analysis.provenance.models.interpretation, 'muse-wonder-1.0');
    assert.equal(analysis.provenance.processedFrameCount, 180);
    assert.equal(analysis.detections.at(-1).frameIndex, 179);
    assert.equal(analysis.detections.at(-1).timeSeconds, 35.8);
    assert.equal(analysis.qualification.calibrationEligible, false);
    assert.match(analysis.clip.licenseUrl, /pexels/);
    assert.equal(analysis.detections.some((frame) => frame.people.some((person) => person.role === 'staff' && person.membership === 'excluded')), true);
  });
});

test('evidence review keeps incomplete waits separate and corrected events trace to video', async () => {
  await withServer(async (base) => {
    const prepared = await jsonFetch(base, '/api/analysis/prepared');
    const analysisId = prepared.body.analysis.id;
    const review = await jsonFetch(base, `/api/analysis/${analysisId}/review`, { method: 'POST', body: JSON.stringify({ baselinePositions: 1, assumedArrivals: [{ id: 'synthetic-A', arrivalTime: 0, serviceDuration: 5 }], assumptions: ['Synthetic timings are assumptions, not measurements.'], observations: [{ type: 'queue-join', personId: 42, timeSeconds: 4, source: { kind: 'video', startSeconds: 4, endSeconds: 4 } }, { type: 'service-start', personId: 42, timeSeconds: 7, source: { kind: 'video', startSeconds: 7, endSeconds: 7 } }] }) });
    assert.equal(review.response.status, 200);
    assert.equal(review.body.review.completeWaitCount, 1);
    assert.equal(review.body.review.completeWaitMeanSeconds, 3);
    assert.equal(review.body.review.incompleteCases.length, 0);
    assert.equal(review.body.review.evidenceStatus, 'exploratory-assumptions-required');
    assert.equal(review.body.review.completeWaits[0].source.kind, 'video');
    assert.equal(review.body.review.proposedModelInputs.evidenceReview.analysisId, analysisId);
    const created = await jsonFetch(base, '/api/models', { method: 'POST', body: JSON.stringify(review.body.review.proposedModelInputs) });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.model.evidenceReview.evidenceStatus, 'exploratory-assumptions-required');
    const confirmed = await jsonFetch(base, `/api/models/${created.body.model.id}/review`, { method: 'POST', body: JSON.stringify({ expectedVersion: created.body.model.version }) });
    const comparison = await jsonFetch(base, `/api/models/${created.body.model.id}/compare`, { method: 'POST', body: JSON.stringify({ reviewedVersion: confirmed.body.model.version, interventionPositions: 2 }) });
    assert.equal(comparison.body.comparison.evidenceReview.analysisId, analysisId);
    assert.equal(comparison.body.comparison.evidenceStatus, 'exploratory-assumptions-required');
  });
});

test('SAM parser maps sparse explicit frame markers to processed time', () => {
  const frames = parseSamOutput('<0f>1<|box;x1=1;y1=2;x2=4;y2=8;w=10;h=10|>\n<2f>3<|box;x1=0;y1=0;x2=5;y2=5;w=10;h=10|>', { processedFps: 2, durationSeconds: 4 });
  assert.deepEqual(frames.map((frame) => [frame.frameIndex, frame.timeSeconds]), [[0, 0], [2, 1]]);
  assert.deepEqual(frames[1].people.map((person) => person.id), [3]);
});
