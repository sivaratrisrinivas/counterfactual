import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server.js';

const syntheticInputs = {
  baselinePositions: 1,
  arrivals: [
    { id: 'A', arrivalTime: 0, serviceDuration: 5 },
    { id: 'B', arrivalTime: 1, serviceDuration: 5 },
    { id: 'C', arrivalTime: 2, serviceDuration: 5 },
  ],
  initialState: { kind: 'empty' },
};

async function withServer(run) {
  const server = await startServer({ port: 0 });
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function jsonFetch(base, path, options) {
  const response = await fetch(`${base}${path}`, {
    headers: { 'content-type': 'application/json', ...(options?.headers ?? {}) },
    ...options,
  });
  const body = await response.json();
  return { response, body };
}

test('reviewed synthetic model compares one and two service positions', async () => {
  await withServer(async (base) => {
    const created = await jsonFetch(base, '/api/models', {
      method: 'POST', body: JSON.stringify(syntheticInputs),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.model.baselinePositions, 1);
    assert.equal(created.body.model.reviewed, false);

    const reviewed = await jsonFetch(base, `/api/models/${created.body.model.id}/review`, {
      method: 'POST', body: JSON.stringify({ expectedVersion: created.body.model.version }),
    });
    assert.equal(reviewed.response.status, 200);
    assert.equal(reviewed.body.model.reviewed, true);
    assert.equal(reviewed.body.model.assumptions.length > 0, true);

    const comparison = await jsonFetch(base, `/api/models/${created.body.model.id}/compare`, {
      method: 'POST', body: JSON.stringify({
        reviewedVersion: reviewed.body.model.version,
        interventionPositions: 2,
      }),
    });
    assert.equal(comparison.response.status, 200);
    assert.deepEqual(comparison.body.comparison.baseline.waitingTimes, [0, 4, 8]);
    assert.deepEqual(comparison.body.comparison.intervention.waitingTimes, [0, 0, 3]);
    assert.equal(comparison.body.comparison.baseline.meanWaitingTime, 4);
    assert.equal(comparison.body.comparison.intervention.meanWaitingTime, 1);
    assert.equal(comparison.body.comparison.modelVersion, reviewed.body.model.version);
    assert.equal(comparison.body.comparison.queueLengthTimelines.baseline.some((point) => point.queueLength > 0), true);
    assert.equal(comparison.body.comparison.assumptions.length > 0, true);
    for (const scenario of [comparison.body.comparison.baseline, comparison.body.comparison.intervention]) {
      assert.equal(scenario.completedCustomers, scenario.cohortSize);
      for (const customer of scenario.customers) {
        assert.equal(customer.serviceStartTime >= customer.arrivalTime, true);
        assert.equal(customer.serviceStartTime + customer.serviceDuration, customer.serviceEndTime);
      }
      for (const position of new Set(scenario.customers.map((customer) => customer.position))) {
        const assigned = scenario.customers.filter((customer) => customer.position === position);
        for (let index = 1; index < assigned.length; index += 1) {
          assert.equal(assigned[index].serviceStartTime >= assigned[index - 1].serviceEndTime, true);
        }
      }
    }
  });
});

test('comparison rejects invalid inputs and stale review versions', async () => {
  await withServer(async (base) => {
    const created = await jsonFetch(base, '/api/models', {
      method: 'POST', body: JSON.stringify(syntheticInputs),
    });
    const id = created.body.model.id;

    const missingInitial = await jsonFetch(base, '/api/models', {
      method: 'POST', body: JSON.stringify({ ...syntheticInputs, initialState: undefined }),
    });
    assert.equal(missingInitial.response.status, 400);
    assert.match(missingInitial.body.error, /initial state/i);

    const invalid = await jsonFetch(base, `/api/models/${id}/review`, {
      method: 'POST', body: JSON.stringify({ expectedVersion: created.body.model.version }),
    });
    assert.equal(invalid.response.status, 200);

    const edited = await jsonFetch(base, `/api/models/${id}`, {
      method: 'PUT', body: JSON.stringify({
        ...syntheticInputs,
        arrivals: syntheticInputs.arrivals.map((arrival) => ({ ...arrival, serviceDuration: 6 })),
      }),
    });
    assert.equal(edited.response.status, 200);
    assert.equal(edited.body.model.reviewed, false);

    const stale = await jsonFetch(base, `/api/models/${id}/compare`, {
      method: 'POST', body: JSON.stringify({ reviewedVersion: invalid.body.model.version, interventionPositions: 2 }),
    });
    assert.equal(stale.response.status, 409);
    assert.match(stale.body.error, /review|stale/i);

    const unreviewed = await jsonFetch(base, `/api/models/${id}/compare`, {
      method: 'POST', body: JSON.stringify({ reviewedVersion: edited.body.model.version, interventionPositions: 2 }),
    });
    assert.equal(unreviewed.response.status, 409);

    const badPositions = await jsonFetch(base, `/api/models/${id}/compare`, {
      method: 'POST', body: JSON.stringify({ reviewedVersion: edited.body.model.version, interventionPositions: 0 }),
    });
    assert.equal(badPositions.response.status, 409);
  });
});

test('identical staffing and sparse arrivals report no improvement without a percentage', async () => {
  await withServer(async (base) => {
    const created = await jsonFetch(base, '/api/models', {
      method: 'POST', body: JSON.stringify({
        ...syntheticInputs,
        arrivals: [
          { id: 'A', arrivalTime: 0, serviceDuration: 2 },
          { id: 'B', arrivalTime: 5, serviceDuration: 2 },
        ],
      }),
    });
    const reviewed = await jsonFetch(base, `/api/models/${created.body.model.id}/review`, {
      method: 'POST', body: JSON.stringify({ expectedVersion: created.body.model.version }),
    });
    const comparison = await jsonFetch(base, `/api/models/${created.body.model.id}/compare`, {
      method: 'POST', body: JSON.stringify({ reviewedVersion: reviewed.body.model.version, interventionPositions: 1 }),
    });
    assert.equal(comparison.response.status, 200);
    assert.equal(comparison.body.comparison.baseline.meanWaitingTime, 0);
    assert.equal(comparison.body.comparison.intervention.meanWaitingTime, 0);
    assert.equal(comparison.body.comparison.absoluteWaitingTimeDifference, 0);
    assert.equal(comparison.body.comparison.relativeWaitingTimeChangePercent, null);
    assert.match(comparison.body.comparison.relativeChangeNote, /zero|not shown/i);
  });
});

test('the browser workflow exposes the computed playback surface', async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/`);
    const markup = await page.text();
    assert.equal(page.status, 200);
    assert.match(markup, /id="playback-section"/);
    assert.match(markup, /id="playback-time"/);
    assert.match(markup, /id="playback-toggle"/);

    const playback = await fetch(`${base}/playback.js`);
    const moduleSource = await playback.text();
    assert.equal(playback.status, 200);
    assert.match(moduleSource, /renderPlayback/);
    assert.match(moduleSource, /service-start/);
    assert.match(moduleSource, /queueLengthTimeline/);

    const app = await fetch(`${base}/app.js`);
    const appSource = await app.text();
    assert.equal(app.status, 200);
    assert.match(appSource, /counterfactual:evidence-invalidated/);
    assert.match(appSource, /evidenceReviewStale/);

    const evidence = await fetch(`${base}/evidence.js`);
    const evidenceSource = await evidence.text();
    assert.equal(evidence.status, 200);
    assert.match(evidenceSource, /counterfactual:evidence-invalidated/);
  });
});
