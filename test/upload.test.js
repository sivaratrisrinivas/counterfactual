import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication, startServer } from '../src/server.js';

function multipartVideo(bytes, { filename = 'fresh.mp4', type = 'video/mp4' } = {}) {
  const boundary = 'counterfactual-test-boundary';
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`, 'latin1');
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'latin1');
  return { body: Buffer.concat([head, bytes, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function withServer(run, application) {
  const server = await startServer({ port: 0, application });
  try { return await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

async function json(response) { return response.json(); }

function fakeAnalysisProvider() {
  return async () => ({
    sam: { completed: true, failures: [], text: '<0f>7<|box;x1=1;y1=2;x2=4;y2=8;w=640;h=360|>\n<2f>7<|box;x1=2;y1=3;x2=5;y2=9;w=640;h=360|>' },
    wonder: JSON.stringify({ scene_description: 'Synthetic queue test', camera_motion: 'fixed', visible_service_positions: ['one'], queue_topology_and_uncertainty: 'shared queue is uncertain', complete_observable_service_episodes: [], occlusion_problems: [], measurements_supported: ['detections'], measurements_not_supported: ['waiting times'], suitability_verdict: 'Insufficient for calibration.', calibration_eligibility: { eligible: false, traceable_queue: false, traceable_timings: false, rationale: 'The synthetic clip has no complete queue timings.' } }),
  });
}

function fakeMetadata() { return { durationSeconds: 4, width: 640, height: 360, frameRate: 5, codec: 'h264', processedFrameCount: 20, processedFps: 5 }; }
function fakePreprocess(_input, _output, { metadata }) { return { ...metadata, data: Buffer.from('....ftypisomprocessed-video') }; }

test('fresh upload returns bounded job status and enters the shared analysis review workflow', async () => {
  const application = createApplication({ analysisProvider: fakeAnalysisProvider(), inspectVideo: async () => fakeMetadata(), preprocessVideo: fakePreprocess });
  await withServer(async (base) => {
    const fixture = multipartVideo(Buffer.from('....ftypisomsynthetic-video'));
    const started = await fetch(`${base}/api/analysis/upload`, { method: 'POST', headers: { 'content-type': fixture.contentType }, body: fixture.body });
    assert.equal(started.status, 202);
    const { upload } = await json(started);
    assert.match(upload.id, /^fresh-/);
    let completed;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await fetch(`${base}/api/analysis/uploads/${upload.id}`);
      completed = await json(response);
      if (completed.upload.status === 'completed' || completed.upload.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(completed.upload.status, 'completed');
    assert.equal(completed.upload.analysis.status, 'fresh');
    assert.equal(completed.upload.analysis.provenance.analysisMode, 'fresh');
    assert.deepEqual(completed.upload.analysis.detections.map((frame) => [frame.frameIndex, frame.timeSeconds]), [[0, 0], [2, 0.4]]);
    const reviewResponse = await fetch(`${base}/api/analysis/${upload.id}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topology: 'single-shared-queue', baselinePositions: 1, initialState: { kind: 'empty' }, assumedArrivals: [{ id: 'assumed', arrivalTime: 0, serviceDuration: 2 }], assumptions: ['Fresh test timings are assumptions.'] }) });
    const review = await json(reviewResponse);
    assert.equal(reviewResponse.status, 200);
    assert.equal(review.review.analysisStatus, 'fresh');
    assert.equal(review.review.proposedModelInputs.evidenceReview.analysisId, upload.id);
    const modelResponse = await fetch(`${base}/api/models`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(review.review.proposedModelInputs) });
    assert.equal(modelResponse.status, 201);
    const model = (await json(modelResponse)).model;
    const reviewedModelResponse = await fetch(`${base}/api/models/${model.id}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: model.version }) });
    assert.equal(reviewedModelResponse.status, 200);
    const reviewedModel = (await json(reviewedModelResponse)).model;
    const comparisonResponse = await fetch(`${base}/api/models/${model.id}/compare`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reviewedVersion: reviewedModel.version, interventionPositions: 2 }) });
    assert.equal(comparisonResponse.status, 200);
    assert.equal((await json(comparisonResponse)).comparison.interventionPositions, 2);
    const video = await fetch(`${base}/api/analysis/uploads/${upload.id}/video`);
    assert.equal(video.status, 200);
    assert.match(video.headers.get('content-type'), /video\/mp4/);
    assert.equal(Buffer.from(await video.arrayBuffer()).toString(), '....ftypisomprocessed-video');
  }, application);
});

test('completed empty SAM output is a valid zero-detection fresh analysis', async () => {
  const application = createApplication({ analysisProvider: async () => ({ sam: { completed: true, failures: [], text: '' }, wonder: JSON.stringify({ scene_description: 'No people visible', camera_motion: 'fixed', visible_service_positions: [], queue_topology_and_uncertainty: 'No queue can be established.', complete_observable_service_episodes: [], occlusion_problems: [], measurements_supported: [], measurements_not_supported: ['all queue timings'], suitability_verdict: 'Insufficient.', calibration_eligibility: { eligible: false, traceable_queue: false, traceable_timings: false, rationale: 'No visible people or queue timings.' } }) }), inspectVideo: async () => fakeMetadata(), preprocessVideo: fakePreprocess });
  await withServer(async (base) => {
    const fixture = multipartVideo(Buffer.from('....ftypisomsynthetic-video'));
    const started = await fetch(`${base}/api/analysis/upload`, { method: 'POST', headers: { 'content-type': fixture.contentType }, body: fixture.body });
    const { upload } = await json(started);
    let result;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      result = await json(await fetch(`${base}/api/analysis/uploads/${upload.id}`));
      if (result.upload.status === 'completed' || result.upload.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(result.upload.status, 'completed');
    assert.deepEqual(result.upload.analysis.detections, []);
    assert.equal(result.upload.analysis.qualification.calibrationEligible, false);
  }, application);
});

test('structured qualifying evidence preserves identity-unknown service proposals for review', async () => {
  const application = createApplication({ analysisProvider: async () => ({ sam: { completed: true, failures: [], text: '<1f>4<|box;x1=8;y1=10;x2=30;y2=80;w=640;h=360|>' }, wonder: JSON.stringify({ scene_description: 'Visible service lane', camera_motion: 'fixed', visible_service_positions: ['desk'], queue_topology_and_uncertainty: 'One shared queue is visible.', complete_observable_service_episodes: [{ start_seconds: 1, end_seconds: 2 }], occlusion_problems: [], measurements_supported: ['service episode timing'], measurements_not_supported: ['queue join identity'], suitability_verdict: 'Suitable pending human review.', calibration_eligibility: { eligible: true, traceable_queue: true, traceable_timings: true, rationale: 'A visible queue and bounded episode are traceable in the clip.' } }) }), inspectVideo: async () => fakeMetadata(), preprocessVideo: fakePreprocess });
  await withServer(async (base) => {
    const fixture = multipartVideo(Buffer.from('....ftypisomsynthetic-video'));
    const started = await fetch(`${base}/api/analysis/upload`, { method: 'POST', headers: { 'content-type': fixture.contentType }, body: fixture.body });
    const { upload } = await json(started);
    let result;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      result = await json(await fetch(`${base}/api/analysis/uploads/${upload.id}`));
      if (result.upload.status === 'completed' || result.upload.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(result.upload.status, 'completed');
    assert.equal(result.upload.analysis.qualification.calibrationEligible, true);
    assert.deepEqual(result.upload.analysis.candidateEvents.map((event) => [event.type, event.timeSeconds, event.personId]), [['service-start', 1, null], ['service-end', 2, null]]);
  }, application);
});

test('fresh upload rejects invalid media before starting provider work', async () => {
  let providerCalled = false;
  const application = createApplication({ analysisProvider: async () => { providerCalled = true; throw new Error('must not run'); }, inspectVideo: async () => fakeMetadata(), preprocessVideo: async () => fakeMetadata() });
  await withServer(async (base) => {
    const fixture = multipartVideo(Buffer.from('not-video'));
    const response = await fetch(`${base}/api/analysis/upload`, { method: 'POST', headers: { 'content-type': fixture.contentType }, body: fixture.body });
    const body = await json(response);
    assert.equal(response.status, 400);
    assert.match(body.error, /readable MP4/i);
    assert.equal(providerCalled, false);
  }, application);
});

test('malformed or incomplete provider output fails the fresh job without prepared fallback', async () => {
  const application = createApplication({ analysisProvider: async () => ({ sam: { completed: false, failures: [], text: '<0f>bad' }, wonder: '{}' }), inspectVideo: async () => fakeMetadata(), preprocessVideo: fakePreprocess });
  await withServer(async (base) => {
    const fixture = multipartVideo(Buffer.from('....ftypisomsynthetic-video'));
    const started = await fetch(`${base}/api/analysis/uploads`, { method: 'POST', headers: { 'content-type': fixture.contentType }, body: fixture.body });
    const { upload } = await json(started);
    let result;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      result = await json(await fetch(`${base}/api/analysis/uploads/${upload.id}`));
      if (result.upload.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(result.upload.status, 'failed');
    assert.match(result.upload.error, /segmentation/i);
    const prepared = await fetch(`${base}/api/analysis/prepared`);
    assert.equal(prepared.status, 200);
  }, application);
});

test('non-empty SAM text without valid frame records fails instead of becoming empty analysis', async () => {
  const application = createApplication({ analysisProvider: async () => ({ sam: { completed: true, failures: [], text: '<0f>not-a-box' }, wonder: '{}' }), inspectVideo: async () => fakeMetadata(), preprocessVideo: fakePreprocess });
  await withServer(async (base) => {
    const fixture = multipartVideo(Buffer.from('....ftypisomsynthetic-video'));
    const started = await fetch(`${base}/api/analysis/upload`, { method: 'POST', headers: { 'content-type': fixture.contentType }, body: fixture.body });
    const { upload } = await json(started);
    let result;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      result = await json(await fetch(`${base}/api/analysis/uploads/${upload.id}`));
      if (result.upload.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(result.upload.status, 'failed');
    assert.match(result.upload.error, /malformed/i);
  }, application);
});

test('duration, size, and format bounds reject uploads before provider work', async () => {
  let providerCalls = 0;
  const application = createApplication({ analysisProvider: async () => { providerCalls += 1; throw new Error('must not run'); }, inspectVideo: async () => ({ ...fakeMetadata(), durationSeconds: 181 }), preprocessVideo: fakePreprocess });
  await withServer(async (base) => {
    const invalidFormat = multipartVideo(Buffer.from('not-video'), { filename: 'fresh.txt', type: 'text/plain' });
    const formatResponse = await fetch(`${base}/api/analysis/upload`, { method: 'POST', headers: { 'content-type': invalidFormat.contentType }, body: invalidFormat.body });
    assert.equal(formatResponse.status, 400);
    const tooLarge = multipartVideo(Buffer.from('....ftypisomsynthetic-video'));
    const oversizedBody = Buffer.concat([tooLarge.body, Buffer.alloc(26 * 1024 * 1024)]);
    const sizeResponse = await fetch(`${base}/api/analysis/upload`, { method: 'POST', headers: { 'content-type': tooLarge.contentType }, body: oversizedBody });
    assert.equal(sizeResponse.status, 413);
    const durationFixture = multipartVideo(Buffer.from('....ftypisomsynthetic-video'));
    const durationStart = await fetch(`${base}/api/analysis/upload`, { method: 'POST', headers: { 'content-type': durationFixture.contentType }, body: durationFixture.body });
    const { upload } = await json(durationStart);
    let result;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      result = await json(await fetch(`${base}/api/analysis/uploads/${upload.id}`));
      if (result.upload.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(result.upload.status, 'failed');
    assert.match(result.upload.error, /duration/i);
    assert.equal(providerCalls, 0);
  }, application);
});

test('provider exceptions and malformed Wonder evidence fail without a prepared fallback', async () => {
  for (const provider of [
    async () => { throw new Error('provider unavailable'); },
    async () => ({ sam: { completed: true, failures: [], text: '' }, wonder: JSON.stringify({ scene_description: 'Malformed', camera_motion: 'fixed', visible_service_positions: ['one'], queue_topology_and_uncertainty: 'uncertain', complete_observable_service_episodes: [{ start_seconds: 'later', end_seconds: 2 }], occlusion_problems: [], measurements_supported: [], measurements_not_supported: [], suitability_verdict: 'suitable', calibration_eligibility: { eligible: true, traceable_queue: true, traceable_timings: true, rationale: 'bad timing type' } }) }),
  ]) {
    const application = createApplication({ analysisProvider: provider, inspectVideo: async () => fakeMetadata(), preprocessVideo: fakePreprocess });
    await withServer(async (base) => {
      const fixture = multipartVideo(Buffer.from('....ftypisomsynthetic-video'));
      const started = await fetch(`${base}/api/analysis/upload`, { method: 'POST', headers: { 'content-type': fixture.contentType }, body: fixture.body });
      const { upload } = await json(started);
      let result;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        result = await json(await fetch(`${base}/api/analysis/uploads/${upload.id}`));
        if (result.upload.status === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(result.upload.status, 'failed');
      assert.doesNotMatch(result.upload.error, /provider unavailable|stack|prepared/i);
    }, application);
  }
});
