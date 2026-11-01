import { randomUUID } from 'node:crypto';

const MAX_POSITIONS = 32;
const MAX_CUSTOMERS = 200;
const MAX_SECONDS = 24 * 60 * 60;

export const MODEL_ASSUMPTIONS = Object.freeze([
  'One shared queue feeds identical, independent service positions using first-come-first-served order.',
  'Each service position has equivalent capacity, and service demand stays unchanged when staffing changes.',
  'Customers do not abandon the queue or change their arrival or service behavior in response to waiting time.',
  'The model has no downstream bottleneck after service begins.',
  'The arrival schedule, service demands, and explicit initial state are assumptions for this exploratory comparison.',
]);

export class WorkflowError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'WorkflowError';
    this.status = status;
  }
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;
const isNonNegativeFinite = (value) => Number.isFinite(value) && value >= 0;

function ensureObject(value, message) {
  if (!isRecord(value)) throw new WorkflowError(message);
}

export function normalizeModelInput(input) {
  ensureObject(input, 'Model inputs must be a JSON object.');
  if (!isPositiveInteger(input.baselinePositions) || input.baselinePositions > MAX_POSITIONS) {
    throw new WorkflowError(`Baseline positions must be a positive integer from 1 to ${MAX_POSITIONS}.`);
  }
  if (!Array.isArray(input.arrivals) || input.arrivals.length === 0 || input.arrivals.length > MAX_CUSTOMERS) {
    throw new WorkflowError(`Provide between 1 and ${MAX_CUSTOMERS} finite arrivals.`);
  }
  ensureObject(input.initialState, 'Choose an explicit initial state before reviewing the model.');
  if (input.initialState.kind !== 'empty') {
    throw new WorkflowError('Only an explicitly empty initial state is supported in this first workflow.');
  }

  const arrivals = input.arrivals.map((arrival, index) => {
    ensureObject(arrival, `Arrival ${index + 1} must be an object.`);
    const id = typeof arrival.id === 'string' && arrival.id.trim() ? arrival.id.trim() : `customer-${index + 1}`;
    if (!isNonNegativeFinite(arrival.arrivalTime) || arrival.arrivalTime > MAX_SECONDS) {
      throw new WorkflowError(`Arrival ${id} must have a time from 0 to ${MAX_SECONDS} seconds.`);
    }
    if (!Number.isFinite(arrival.serviceDuration) || arrival.serviceDuration <= 0 || arrival.serviceDuration > MAX_SECONDS) {
      throw new WorkflowError(`Service duration for ${id} must be greater than 0 and no more than ${MAX_SECONDS} seconds.`);
    }
    return {
      id,
      arrivalTime: arrival.arrivalTime,
      serviceDuration: arrival.serviceDuration,
    };
  });
  const ids = new Set();
  for (const arrival of arrivals) {
    if (ids.has(arrival.id)) throw new WorkflowError(`Customer id "${arrival.id}" is repeated.`);
    ids.add(arrival.id);
  }
  arrivals.sort((a, b) => a.arrivalTime - b.arrivalTime || a.id.localeCompare(b.id));
  return {
    baselinePositions: input.baselinePositions,
    arrivals,
    initialState: { kind: 'empty' },
    evidenceReview: input.evidenceReview === undefined ? null : normalizeEvidenceReview(input.evidenceReview),
  };
}

function normalizeEvidenceReview(value) {
  ensureObject(value, 'Evidence review must be an object.');
  if (typeof value.analysisId !== 'string' || !value.analysisId.trim()) throw new WorkflowError('Evidence review needs an analysis id.');
  if (!Number.isInteger(value.reviewVersion) || value.reviewVersion < 1) throw new WorkflowError('Evidence review needs a review version.');
  const status = ['qualified-observations', 'exploratory-assumptions-required'].includes(value.evidenceStatus)
    ? value.evidenceStatus
    : 'exploratory-assumptions-required';
  if (value.inputFingerprint !== undefined && typeof value.inputFingerprint !== 'string') throw new WorkflowError('Evidence review input fingerprint is invalid.');
  return { analysisId: value.analysisId, reviewVersion: value.reviewVersion, evidenceStatus: status, inputFingerprint: value.inputFingerprint ?? null };
}

function modelInputFingerprint(input) {
  return JSON.stringify({ baselinePositions: input.baselinePositions, arrivals: input.arrivals, initialState: { kind: input.initialState.kind } });
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a - b);
}

export function simulate(modelInput, positions) {
  if (!isPositiveInteger(positions) || positions > MAX_POSITIONS) {
    throw new WorkflowError(`Service positions must be a positive integer from 1 to ${MAX_POSITIONS}.`);
  }
  const availability = Array.from({ length: positions }, () => 0);
  const customers = modelInput.arrivals.map((arrival) => {
    let position = 0;
    for (let index = 1; index < availability.length; index += 1) {
      if (availability[index] < availability[position]) position = index;
    }
    const serviceStartTime = Math.max(arrival.arrivalTime, availability[position]);
    const serviceEndTime = serviceStartTime + arrival.serviceDuration;
    availability[position] = serviceEndTime;
    return {
      id: arrival.id,
      arrivalTime: arrival.arrivalTime,
      serviceDuration: arrival.serviceDuration,
      serviceStartTime,
      serviceEndTime,
      waitingTime: serviceStartTime - arrival.arrivalTime,
      position: position + 1,
    };
  });

  const timelineTimes = uniqueSorted(customers.flatMap((customer) => [
    customer.arrivalTime,
    customer.serviceStartTime,
    customer.serviceEndTime,
  ]));
  const queueLengthTimeline = timelineTimes.map((time) => ({
    time,
    queueLength: customers.filter((customer) => customer.arrivalTime <= time && customer.serviceStartTime > time).length,
  }));
  const waitingTimes = customers.map((customer) => customer.waitingTime);
  const meanWaitingTime = waitingTimes.reduce((sum, value) => sum + value, 0) / waitingTimes.length;
  const events = customers.flatMap((customer) => [
    { type: 'arrival', customerId: customer.id, time: customer.arrivalTime },
    { type: 'service-start', customerId: customer.id, position: customer.position, time: customer.serviceStartTime },
    { type: 'departure', customerId: customer.id, position: customer.position, time: customer.serviceEndTime },
  ]).sort((a, b) => a.time - b.time || (a.type === 'arrival' ? -1 : 1));
  return {
    positions,
    customers,
    waitingTimes,
    meanWaitingTime,
    queueLengthTimeline,
    events,
    completedCustomers: customers.length,
    cohortSize: modelInput.arrivals.length,
  };
}

export class ModelWorkflow {
  #models = new Map();
  #evidenceReviews;

  constructor({ evidenceReviews = new Map() } = {}) { this.#evidenceReviews = evidenceReviews; }

  create(input) {
    const normalized = normalizeModelInput(input);
    normalized.evidenceReview = this.#trustedEvidence(normalized.evidenceReview, normalized);
    const model = {
      id: randomUUID(),
      version: 1,
      reviewed: false,
      reviewedAt: null,
      ...normalized,
      assumptions: [...MODEL_ASSUMPTIONS],
      lastComparison: null,
    };
    this.#models.set(model.id, model);
    return this.#view(model);
  }

  get(id) {
    return this.#view(this.#getMutable(id));
  }

  update(id, input) {
    const current = this.#getMutable(id);
    const normalized = normalizeModelInput(input);
    normalized.evidenceReview = this.#trustedEvidence(normalized.evidenceReview, normalized);
    const next = {
      ...current,
      ...normalized,
      version: current.version + 1,
      reviewed: false,
      reviewedAt: null,
      lastComparison: null,
    };
    this.#models.set(id, next);
    return this.#view(next);
  }

  review(id, expectedVersion) {
    const model = this.#getMutable(id);
    if (!Number.isInteger(expectedVersion) || expectedVersion !== model.version) {
      throw new WorkflowError('This model changed before review. Refresh the inputs and review the current version.', 409);
    }
    model.reviewed = true;
    model.reviewedAt = new Date().toISOString();
    return this.#view(model);
  }

  compare(id, reviewedVersion, interventionPositions) {
    const model = this.#getMutable(id);
    if (!model.reviewed || reviewedVersion !== model.version) {
      throw new WorkflowError('Review this current model before running a what-if. The previous review or comparison is stale.', 409);
    }
    if (!isPositiveInteger(interventionPositions) || interventionPositions > MAX_POSITIONS) {
      throw new WorkflowError(`Intervention positions must be a positive integer from 1 to ${MAX_POSITIONS}.`, 409);
    }
    const baseline = simulate(model, model.baselinePositions);
    const intervention = simulate(model, interventionPositions);
    const absoluteWaitingTimeDifference = Math.abs(intervention.meanWaitingTime - baseline.meanWaitingTime);
    const waitingTimeChange = intervention.meanWaitingTime - baseline.meanWaitingTime;
    const relativeWaitingTimeChangePercent = baseline.meanWaitingTime === 0
      ? null
      : (waitingTimeChange / baseline.meanWaitingTime) * 100;
    const comparison = {
      modelVersion: model.version,
      baselinePositions: model.baselinePositions,
      interventionPositions,
      baseline,
      intervention,
      queueLengthTimelines: {
        baseline: baseline.queueLengthTimeline,
        intervention: intervention.queueLengthTimeline,
      },
      absoluteWaitingTimeDifference,
      waitingTimeChange,
      relativeWaitingTimeChangePercent,
      relativeChangeNote: baseline.meanWaitingTime === 0
        ? 'Relative change is not shown because baseline waiting time is zero.'
        : null,
      assumptions: [...model.assumptions],
      evidenceReview: model.evidenceReview,
      evidenceStatus: model.evidenceReview?.evidenceStatus ?? 'exploratory-assumptions-required',
      predictionStatus: 'Unvalidated model prediction',
      createdAt: new Date().toISOString(),
    };
    model.lastComparison = comparison;
    return structuredClone(comparison);
  }

  #getMutable(id) {
    const model = this.#models.get(id);
    if (!model) throw new WorkflowError('Model was not found.', 404);
    return model;
  }

  #trustedEvidence(summary, normalized) {
    if (!summary) return null;
    const key = `${summary.analysisId}:${summary.reviewVersion}`;
    const trusted = this.#evidenceReviews.get(key);
    if (!trusted) throw new WorkflowError('Evidence review is not trusted by this server. Review the analysis before saving model inputs.', 409);
    const evidence = structuredClone(trusted);
    const trustedFingerprint = trusted.proposedModelInputs?.evidenceReview?.inputFingerprint;
    if (!trustedFingerprint || trustedFingerprint !== modelInputFingerprint(normalized)) {
      evidence.evidenceStatus = 'exploratory-assumptions-required';
      evidence.editedAfterEvidenceReview = true;
      evidence.assumptions = [...(evidence.assumptions ?? []), 'Model timings or arrivals were edited after evidence review and are treated as assumptions.'];
    }
    return evidence;
  }

  #view(model) {
    return structuredClone(model);
  }
}
