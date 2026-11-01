import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication, startServer } from '../src/server.js';
import { validateAnalysis } from '../src/analysis.js';

async function withServer(run, application) {
  const server = await startServer({ port: 0, application });
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
    assert.equal(analysis.candidateEvents.length, 0);
    assert.equal(analysis.candidateZones.find((zone) => zone.id === 'waiting-area-candidate').source.kind, 'assumption');
    assert.match(analysis.candidateZones.find((zone) => zone.id === 'waiting-area-candidate').source.reason, /formed shared queue|waiting boundary/i);
    assert.equal(analysis.candidateZones.find((zone) => zone.id === 'service-area-candidate').source.kind, 'video');
  });
});

test('evidence review keeps incomplete waits separate and corrected events trace to video', async () => {
  await withServer(async (base) => {
    const prepared = await jsonFetch(base, '/api/analysis/prepared');
    const analysisId = prepared.body.analysis.id;
    const review = await jsonFetch(base, `/api/analysis/${analysisId}/review`, { method: 'POST', body: JSON.stringify({ topology: 'single-shared-queue', baselinePositions: 1, initialState: { kind: 'empty' }, assumedArrivals: [{ id: 'synthetic-A', arrivalTime: 0, serviceDuration: 5 }], assumptions: ['Synthetic timings are assumptions, not measurements.'], observations: [{ type: 'queue-join', personId: 42, timeSeconds: 4, role: 'customer', membership: 'waiting', continuity: 'continuous', source: { kind: 'video', startSeconds: 4, endSeconds: 4 } }, { type: 'service-start', personId: 42, timeSeconds: 7, role: 'customer', membership: 'service', continuity: 'continuous', source: { kind: 'video', startSeconds: 7, endSeconds: 7 } }] }) });
    assert.equal(review.response.status, 200);
    assert.equal(review.body.review.completeWaitCount, 0);
    assert.equal(review.body.review.completeWaitMeanSeconds, null);
    assert.equal(review.body.review.incompleteCases.length, 1);
    assert.equal(review.body.review.evidenceStatus, 'exploratory-assumptions-required');
    assert.equal(review.body.review.proposedModelInputs.evidenceReview.analysisId, analysisId);
    const created = await jsonFetch(base, '/api/models', { method: 'POST', body: JSON.stringify(review.body.review.proposedModelInputs) });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.model.evidenceReview.evidenceStatus, 'exploratory-assumptions-required');
    const confirmed = await jsonFetch(base, `/api/models/${created.body.model.id}/review`, { method: 'POST', body: JSON.stringify({ expectedVersion: created.body.model.version }) });
    const comparison = await jsonFetch(base, `/api/models/${created.body.model.id}/compare`, { method: 'POST', body: JSON.stringify({ reviewedVersion: confirmed.body.model.version, interventionPositions: 2 }) });
    assert.equal(comparison.body.comparison.evidenceReview.analysisId, analysisId);
    assert.equal(comparison.body.comparison.evidenceStatus, 'exploratory-assumptions-required');
    const edited = await jsonFetch(base, `/api/models/${created.body.model.id}`, { method: 'PUT', body: JSON.stringify({ ...review.body.review.proposedModelInputs, arrivals: [{ id: 'edited', arrivalTime: 0, serviceDuration: 8 }] }) });
    assert.equal(edited.response.status, 200);
    assert.equal(edited.body.model.evidenceReview.editedAfterEvidenceReview, true);
    assert.equal(edited.body.model.evidenceReview.evidenceStatus, 'exploratory-assumptions-required');
    const omittedFingerprint = await jsonFetch(base, '/api/models', { method: 'POST', body: JSON.stringify({ ...review.body.review.proposedModelInputs, arrivals: [{ id: 'omitted-fingerprint-edit', arrivalTime: 0, serviceDuration: 9 }], evidenceReview: { analysisId, reviewVersion: review.body.review.reviewVersion, evidenceStatus: 'qualified-observations' } }) });
    assert.equal(omittedFingerprint.response.status, 201);
    assert.equal(omittedFingerprint.body.model.evidenceReview.editedAfterEvidenceReview, true);
    assert.equal(omittedFingerprint.body.model.evidenceReview.evidenceStatus, 'exploratory-assumptions-required');
  });
});

test('a newer evidence review invalidates older model comparisons and staffing proposals', async () => {
  const application = createApplication({
    staffingProvider: async () => ({ supported: true, targetPositions: 2, explanation: 'Add one independent service position.' }),
  });
  await withServer(async (base) => {
    const prepared = await jsonFetch(base, '/api/analysis/prepared');
    const analysisId = prepared.body.analysis.id;
    const reviewInput = {
      topology: 'single-shared-queue',
      baselinePositions: 1,
      initialState: { kind: 'empty' },
      assumedArrivals: [{ id: 'assumed-1', arrivalTime: 0, serviceDuration: 5 }],
      assumptions: ['The saved clip does not establish queue timings.'],
    };
    const firstReview = await jsonFetch(base, `/api/analysis/${analysisId}/review`, { method: 'POST', body: JSON.stringify(reviewInput) });
    assert.equal(firstReview.response.status, 200);
    assert.equal(firstReview.body.review.reviewVersion, 1);
    const created = await jsonFetch(base, '/api/models', { method: 'POST', body: JSON.stringify(firstReview.body.review.proposedModelInputs) });
    const reviewed = await jsonFetch(base, `/api/models/${created.body.model.id}/review`, { method: 'POST', body: JSON.stringify({ expectedVersion: created.body.model.version }) });
    const proposal = await jsonFetch(base, `/api/models/${created.body.model.id}/staffing/interpret`, { method: 'POST', body: JSON.stringify({ request: 'add another service position' }) });
    assert.equal(proposal.response.status, 200);
    const beforeCorrection = await jsonFetch(base, `/api/models/${created.body.model.id}/compare`, { method: 'POST', body: JSON.stringify({ reviewedVersion: reviewed.body.model.version, interventionPositions: 2 }) });
    assert.equal(beforeCorrection.response.status, 200);

    const secondReview = await jsonFetch(base, `/api/analysis/${analysisId}/review`, { method: 'POST', body: JSON.stringify({ ...reviewInput, assumptions: ['The user re-reviewed the saved limitations.'] }) });
    assert.equal(secondReview.response.status, 200);
    assert.equal(secondReview.body.review.reviewVersion, 2);
    assert.equal(secondReview.body.review.proposedModelInputs.evidenceReview.reviewVersion, 2);

    const staleCompare = await jsonFetch(base, `/api/models/${created.body.model.id}/compare`, { method: 'POST', body: JSON.stringify({ reviewedVersion: reviewed.body.model.version, interventionPositions: 2 }) });
    assert.equal(staleCompare.response.status, 409);
    assert.match(staleCompare.body.error, /evidence|review|stale/i);
    const staleInterpret = await jsonFetch(base, `/api/models/${created.body.model.id}/staffing/interpret`, { method: 'POST', body: JSON.stringify({ request: 'add another service position' }) });
    assert.equal(staleInterpret.response.status, 409);
    const staleConfirm = await jsonFetch(base, `/api/models/${created.body.model.id}/staffing/confirm`, { method: 'POST', body: JSON.stringify({ proposalId: proposal.body.proposal.id }) });
    assert.equal(staleConfirm.response.status, 409);
  }, application);
});

test('synthetic analysis source reviews continuous video events and preserves both endpoints', async () => {
  const synthetic = validateAnalysis({
    schemaVersion: 1, id: 'synthetic-qualified', status: 'synthetic',
    clip: { id: 'synthetic-clip', filename: 'synthetic.mp4', durationSeconds: 4, width: 10, height: 10, sourceUrl: 'https://example.test/synthetic', licenseUrl: 'https://example.test/license', attribution: 'Synthetic test fixture' },
    provenance: { analysisMode: 'synthetic-test-fixture', savedAt: '2026-11-01T00:00:00Z', processedFps: 1, processedFrameCount: 3, models: { segmentation: 'synthetic-sam', interpretation: 'synthetic-wonder' } },
    detections: [
      { frameIndex: 0, timeSeconds: 0, people: [{ id: 7, box: { x1: 0, y1: 0, x2: 2, y2: 2, width: 10, height: 10 }, role: 'customer', membership: 'waiting' }] },
      { frameIndex: 2, timeSeconds: 2, people: [{ id: 7, box: { x1: 1, y1: 1, x2: 3, y2: 3, width: 10, height: 10 }, role: 'customer', membership: 'service' }] },
    ], candidateZones: [], candidateEvents: [], limitations: [], assessment: {}, qualification: { verdict: 'qualified', calibrationEligible: true, rationale: 'Synthetic fixture only.' },
  });
  const application = createApplication({ analysisSource: async (id) => { if (id !== synthetic.id) throw new Error('missing'); return synthetic; } });
  await withServer(async (base) => {
    const review = await jsonFetch(base, `/api/analysis/${synthetic.id}/review`, { method: 'POST', body: JSON.stringify({ topology: 'single-shared-queue', baselinePositions: 1, initialState: { kind: 'empty' }, assumedArrivals: [{ id: 'assumed', arrivalTime: 0, serviceDuration: 2 }], observations: [{ type: 'queue-join', personId: 7, role: 'customer', membership: 'waiting', continuity: 'continuous', timeSeconds: 1, source: { kind: 'video', startSeconds: 1, endSeconds: 1 } }, { type: 'service-start', personId: 7, role: 'customer', membership: 'service', continuity: 'continuous', timeSeconds: 2, source: { kind: 'video', startSeconds: 2, endSeconds: 2 } }, { type: 'service-end', personId: 7, role: 'customer', membership: 'service', continuity: 'continuous', timeSeconds: 4, source: { kind: 'video', startSeconds: 4, endSeconds: 4 } }, { type: 'service-start', personId: 12, role: 'customer', membership: 'service', continuity: 'continuous', timeSeconds: 2, source: { kind: 'video', startSeconds: 2, endSeconds: 2 } }, { type: 'departure', personId: 12, role: 'customer', membership: 'service', continuity: 'continuous', timeSeconds: 4, source: { kind: 'video', startSeconds: 4, endSeconds: 4 } }, { type: 'queue-join', personId: 8, role: 'customer', membership: 'waiting', continuity: 'unknown', timeSeconds: 1, source: { kind: 'video', startSeconds: 1, endSeconds: 1 } }, { type: 'service-start', personId: 8, role: 'customer', membership: 'service', continuity: 'unknown', timeSeconds: 2, source: { kind: 'video', startSeconds: 2, endSeconds: 2 } }, { type: 'queue-join', personId: 9, role: 'staff', membership: 'excluded', continuity: 'continuous', timeSeconds: 1, source: { kind: 'video', startSeconds: 1, endSeconds: 1 } }, { type: 'service-start', personId: 9, role: 'staff', membership: 'excluded', continuity: 'continuous', timeSeconds: 2, source: { kind: 'video', startSeconds: 2, endSeconds: 2 } }, { type: 'queue-join', personId: 10, role: 'unknown', membership: 'waiting', continuity: 'continuous', timeSeconds: 1, source: { kind: 'video', startSeconds: 1, endSeconds: 1 } }, { type: 'service-start', personId: 10, role: 'unknown', membership: 'service', continuity: 'continuous', timeSeconds: 2, source: { kind: 'video', startSeconds: 2, endSeconds: 2 } }, { type: 'queue-join', personId: 11, role: 'customer', membership: 'waiting', continuity: 'continuous', timeSeconds: 1, source: { kind: 'assumption', reason: 'The queue join is not visible.' } }, { type: 'service-start', personId: 11, role: 'customer', membership: 'service', continuity: 'continuous', timeSeconds: 2, source: { kind: 'assumption', reason: 'The service start is not visible.' } }] }) });
    assert.equal(review.response.status, 200);
    assert.equal(review.body.review.completeWaitCount, 1);
    assert.equal(review.body.review.completeWaits[0].source.start.endSeconds, 1);
    assert.equal(review.body.review.completeWaits[0].source.end.endSeconds, 2);
    assert.equal(review.body.review.serviceDurations[0].serviceDurationSeconds, 2);
    assert.equal(review.body.review.completeWaitMeanSeconds, 1);
    assert.equal(review.body.review.incompleteCases.some((item) => item.personId === 8 && item.reason === 'identity-continuity-not-supported'), true);
    assert.equal(review.body.review.incompleteCases.some((item) => item.personId === 10 && item.reason === 'person-role-not-reviewed'), true);
    assert.equal(review.body.review.incompleteCases.some((item) => item.personId === 11 && item.reason === 'observation-not-video-supported'), true);
    assert.equal(review.body.review.excludedObservations.some((item) => item.personId === 9), true);
    assert.equal(review.body.review.serviceDurations.some((item) => item.personId === 12), false);
  }, application);
});

test('eligible analysis review stays exploratory with no usable or rejected waits', async () => {
  const eligible = validateAnalysis({
    schemaVersion: 1, id: 'eligible-without-waits', status: 'synthetic',
    clip: { id: 'eligible-clip', filename: 'eligible.mp4', durationSeconds: 4, width: 10, height: 10, sourceUrl: 'https://example.test/eligible', licenseUrl: 'https://example.test/license', attribution: 'Synthetic test fixture' },
    provenance: { analysisMode: 'synthetic-test-fixture', savedAt: '2026-11-01T00:00:00Z', processedFps: 1, processedFrameCount: 3, models: { segmentation: 'synthetic-sam', interpretation: 'synthetic-wonder' } },
    detections: [], candidateZones: [], candidateEvents: [], limitations: [], assessment: {}, qualification: { verdict: 'qualified', calibrationEligible: true, rationale: 'Synthetic source claims eligibility.' },
  });
  const application = createApplication({ analysisSource: async (id) => { if (id !== eligible.id) throw new Error('missing'); return eligible; } });
  await withServer(async (base) => {
    for (const observations of [undefined, [
      { type: 'queue-join', personId: 12, role: 'customer', membership: 'waiting', continuity: 'unknown', timeSeconds: 1, source: { kind: 'video', startSeconds: 1, endSeconds: 1 } },
      { type: 'service-start', personId: 12, role: 'customer', membership: 'service', continuity: 'unknown', timeSeconds: 2, source: { kind: 'video', startSeconds: 2, endSeconds: 2 } },
    ]]) {
      const body = { topology: 'single-shared-queue', baselinePositions: 1, initialState: { kind: 'empty' } };
      if (observations) body.observations = observations;
      const review = await jsonFetch(base, `/api/analysis/${eligible.id}/review`, { method: 'POST', body: JSON.stringify(body) });
      assert.equal(review.response.status, 200);
      assert.equal(review.body.review.completeWaitCount, 0);
      assert.equal(review.body.review.evidenceStatus, 'exploratory-assumptions-required');
      assert.equal(review.body.review.calibrationStatus, 'insufficient-for-calibration');
      assert.equal(review.body.review.qualification.calibrationEligible, true);
    }
  }, application);
});

test('review rejects video evidence outside the clip or outside its supporting interval', async () => {
  await withServer(async (base) => {
    const prepared = await jsonFetch(base, '/api/analysis/prepared');
    const id = prepared.body.analysis.id;
    const outsideInterval = await jsonFetch(base, `/api/analysis/${id}/review`, {
      method: 'POST',
      body: JSON.stringify({ topology: 'single-shared-queue', baselinePositions: 1, initialState: { kind: 'empty' }, observations: [{ type: 'queue-join', personId: 41, role: 'customer', membership: 'waiting', continuity: 'continuous', timeSeconds: 4, source: { kind: 'video', startSeconds: 5, endSeconds: 6 } }] }),
    });
    assert.equal(outsideInterval.response.status, 400);
    assert.match(outsideInterval.body.error, /supporting video interval/i);

    const outsideClip = await jsonFetch(base, `/api/analysis/${id}/review`, {
      method: 'POST',
      body: JSON.stringify({ topology: 'single-shared-queue', baselinePositions: 1, initialState: { kind: 'empty' }, zones: [{ id: 'bad-zone', label: 'Bad zone', kind: 'waiting', x: 0, y: 0, width: 0.2, height: 0.2, source: { kind: 'video', startSeconds: 35, endSeconds: 37 } }] }),
    });
    assert.equal(outsideClip.response.status, 400);
    assert.match(outsideClip.body.error, /clip duration/i);
  });
});

test('review rejects implicit initial state, unsupported topology, and untrusted evidence claims', async () => {
  await withServer(async (base) => {
    const prepared = await jsonFetch(base, '/api/analysis/prepared');
    const id = prepared.body.analysis.id;
    const noInitial = await jsonFetch(base, `/api/analysis/${id}/review`, { method: 'POST', body: JSON.stringify({ baselinePositions: 1 }) });
    assert.equal(noInitial.response.status, 400);
    assert.match(noInitial.body.error, /explicit empty/i);
    const topology = await jsonFetch(base, `/api/analysis/${id}/review`, { method: 'POST', body: JSON.stringify({ topology: 'separate-lines', baselinePositions: 1, initialState: { kind: 'empty' } }) });
    assert.equal(topology.response.status, 400);
    assert.match(topology.body.error, /shared queue/i);
    const fake = await jsonFetch(base, '/api/models', { method: 'POST', body: JSON.stringify({ baselinePositions: 1, arrivals: [{ id: 'A', arrivalTime: 0, serviceDuration: 1 }], initialState: { kind: 'empty' }, evidenceReview: { analysisId: 'fake', reviewVersion: 1, evidenceStatus: 'qualified-observations' } }) });
    assert.equal(fake.response.status, 409);
  });
});
