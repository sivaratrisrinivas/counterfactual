import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication, startServer } from '../src/server.js';
import { createWonderStaffingProvider } from '../src/staffing.js';

const syntheticInputs = {
  baselinePositions: 1,
  arrivals: [
    { id: 'A', arrivalTime: 0, serviceDuration: 5 },
    { id: 'B', arrivalTime: 1, serviceDuration: 5 },
    { id: 'C', arrivalTime: 2, serviceDuration: 5 },
  ],
  initialState: { kind: 'empty' },
};

async function withServer(application, run) {
  const server = await startServer({ port: 0, application });
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

async function reviewedModel(base) {
  const created = await jsonFetch(base, '/api/models', {
    method: 'POST', body: JSON.stringify(syntheticInputs),
  });
  const reviewed = await jsonFetch(base, `/api/models/${created.body.model.id}/review`, {
    method: 'POST', body: JSON.stringify({ expectedVersion: created.body.model.version }),
  });
  return { id: created.body.model.id, model: reviewed.body.model };
}

test('a supported language request is proposed before confirmation and matches explicit staffing', async () => {
  const application = createApplication({
    staffingProvider: async ({ request, baselinePositions }) => {
      assert.match(request, /another service position/i);
      assert.equal(baselinePositions, 1);
      return { supported: true, targetPositions: 2, explanation: 'Add one independent service position.' };
    },
  });
  await withServer(application, async (base) => {
    const { id, model } = await reviewedModel(base);
    const proposed = await jsonFetch(base, `/api/models/${id}/staffing/interpret`, {
      method: 'POST', body: JSON.stringify({ request: 'add another service position' }),
    });
    assert.equal(proposed.response.status, 200);
    assert.equal(proposed.body.proposal.status, 'pending');
    assert.equal(proposed.body.proposal.baselinePositions, 1);
    assert.equal(proposed.body.proposal.proposedInterventionPositions, 2);
    assert.equal(proposed.body.proposal.modelVersion, model.version);

    const explicit = await jsonFetch(base, `/api/models/${id}/compare`, {
      method: 'POST', body: JSON.stringify({ reviewedVersion: model.version, interventionPositions: 2 }),
    });
    const confirmed = await jsonFetch(base, `/api/models/${id}/staffing/confirm`, {
      method: 'POST', body: JSON.stringify({ proposalId: proposed.body.proposal.id }),
    });
    assert.equal(confirmed.response.status, 200);
    assert.equal(confirmed.body.proposal.status, 'confirmed');
    assert.deepEqual(confirmed.body.comparison.baseline.waitingTimes, explicit.body.comparison.baseline.waitingTimes);
    assert.deepEqual(confirmed.body.comparison.intervention.waitingTimes, explicit.body.comparison.intervention.waitingTimes);
    assert.equal(confirmed.body.comparison.interventionPositions, explicit.body.comparison.interventionPositions);
  });
});

test('absolute and relative requests retain the reviewed model version in their proposals', async () => {
  const application = createApplication({
    staffingProvider: async ({ request }) => request.includes('three')
      ? { supported: true, targetPositions: 3, explanation: 'Use three positions.' }
      : { supported: true, targetPositions: 2, explanation: 'Add one position.' },
  });
  await withServer(application, async (base) => {
    const { id, model } = await reviewedModel(base);
    const relative = await jsonFetch(base, `/api/models/${id}/staffing/interpret`, {
      method: 'POST', body: JSON.stringify({ request: 'add another service position' }),
    });
    const absolute = await jsonFetch(base, `/api/models/${id}/staffing/interpret`, {
      method: 'POST', body: JSON.stringify({ request: 'use three service positions' }),
    });
    assert.equal(relative.body.proposal.proposedInterventionPositions, 2);
    assert.equal(absolute.body.proposal.proposedInterventionPositions, 3);
    assert.equal(relative.body.proposal.modelVersion, model.version);
    assert.equal(absolute.body.proposal.modelVersion, model.version);
  });
});

test('stale proposals cannot run after model inputs change', async () => {
  let providerCalls = 0;
  const application = createApplication({
    staffingProvider: async () => {
      providerCalls += 1;
      return { supported: true, targetPositions: 2, explanation: 'Add one position.' };
    },
  });
  await withServer(application, async (base) => {
    const { id, model } = await reviewedModel(base);
    const proposed = await jsonFetch(base, `/api/models/${id}/staffing/interpret`, {
      method: 'POST', body: JSON.stringify({ request: 'add another service position' }),
    });
    const edited = await jsonFetch(base, `/api/models/${id}`, {
      method: 'PUT', body: JSON.stringify({
        ...syntheticInputs,
        arrivals: syntheticInputs.arrivals.map((arrival) => ({ ...arrival, serviceDuration: 6 })),
      }),
    });
    const confirmed = await jsonFetch(base, `/api/models/${id}/staffing/confirm`, {
      method: 'POST', body: JSON.stringify({ proposalId: proposed.body.proposal.id }),
    });
    assert.equal(providerCalls, 1);
    assert.equal(edited.body.model.version, model.version + 1);
    assert.equal(confirmed.response.status, 409);
    assert.match(confirmed.body.error, /stale|review/i);
    const current = await jsonFetch(base, `/api/models/${id}`);
    assert.equal(current.body.model.reviewed, false);
    assert.equal(current.body.model.lastComparison, null);
  });
});

test('unsupported requests explain the boundary and cannot be confirmed', async () => {
  const application = createApplication({
    staffingProvider: async () => ({
      supported: false,
      targetPositions: 0,
      explanation: 'Layout, service-speed, and customer-behavior changes are outside this staffing-only what-if.',
    }),
  });
  await withServer(application, async (base) => {
    const { id } = await reviewedModel(base);
    const proposed = await jsonFetch(base, `/api/models/${id}/staffing/interpret`, {
      method: 'POST', body: JSON.stringify({ request: 'move the counter and make service faster' }),
    });
    assert.equal(proposed.response.status, 200);
    assert.equal(proposed.body.proposal.status, 'unsupported');
    assert.equal(proposed.body.proposal.proposedInterventionPositions, null);
    const confirmed = await jsonFetch(base, `/api/models/${id}/staffing/confirm`, {
      method: 'POST', body: JSON.stringify({ proposalId: proposed.body.proposal.id }),
    });
    assert.equal(confirmed.response.status, 422);
    assert.match(confirmed.body.error, /unsupported/i);
  });
});

test('malformed or failed provider responses do not change the reviewed model', async () => {
  for (const staffingProvider of [
    async () => ({ supported: true, targetPositions: 'two', explanation: 'Malformed.' }),
    async () => { throw new Error('provider unavailable'); },
  ]) {
    const application = createApplication({ staffingProvider });
    await withServer(application, async (base) => {
      const { id, model } = await reviewedModel(base);
      const interpreted = await jsonFetch(base, `/api/models/${id}/staffing/interpret`, {
        method: 'POST', body: JSON.stringify({ request: 'add another service position' }),
      });
      assert.equal(interpreted.response.status, 502);
      assert.match(interpreted.body.error, /interpret|provider|invalid/i);
      const current = await jsonFetch(base, `/api/models/${id}`);
      assert.equal(current.body.model.version, model.version);
      assert.equal(current.body.model.reviewed, true);
      assert.equal(current.body.model.lastComparison, null);
    });
  }
});

test('external staffing adapter rejects valid JSON in failed or incomplete Responses payloads', async () => {
  const fixture = { supported: true, targetPositions: 2, explanation: 'Add one independent service position.' };
  for (const status of ['failed', 'incomplete']) {
    const provider = createWonderStaffingProvider({
      apiKey: 'test-key',
      fetchImpl: async () => new Response(JSON.stringify({ status, output_text: JSON.stringify(fixture) }), { status: 200 }),
    });
    await assert.rejects(provider({ request: 'add another service position', baselinePositions: 1 }), /did not complete/i);
  }
});

test('staffing interpretation requires a reviewed model and a bounded request', async () => {
  const application = createApplication({
    staffingProvider: async () => { throw new Error('provider must not be called'); },
  });
  await withServer(application, async (base) => {
    const created = await jsonFetch(base, '/api/models', {
      method: 'POST', body: JSON.stringify(syntheticInputs),
    });
    const unreviewed = await jsonFetch(base, `/api/models/${created.body.model.id}/staffing/interpret`, {
      method: 'POST', body: JSON.stringify({ request: 'add another service position' }),
    });
    assert.equal(unreviewed.response.status, 409);
    const reviewed = await reviewedModel(base);
    const tooLong = await jsonFetch(base, `/api/models/${reviewed.id}/staffing/interpret`, {
      method: 'POST', body: JSON.stringify({ request: 'x'.repeat(2001) }),
    });
    assert.equal(tooLong.response.status, 400);
    assert.match(tooLong.body.error, /short|long|characters/i);
  });
});
