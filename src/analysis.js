import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ANALYSIS_SCHEMA_VERSION = 1;
export const ANALYSIS_LIMITS = Object.freeze({ maxDurationSeconds: 180, maxProcessedFrames: 900, maxDetections: 20_000, maxZones: 16, maxEvents: 1_000 });

export class AnalysisError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'AnalysisError'; this.status = status; }
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => Number.isFinite(value);
const requiredString = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new AnalysisError(`${name} must be a non-empty string.`);
  return value.trim();
};

function validReference(reference, name) {
  if (!isRecord(reference)) throw new AnalysisError(`${name} must retain its evidence reference.`);
  const kind = requiredString(reference.kind, `${name}.kind`);
  if (!['video', 'assumption', 'unsupported'].includes(kind)) throw new AnalysisError(`${name}.kind is not supported.`);
  if (kind === 'video' && (!finite(reference.startSeconds) || reference.startSeconds < 0 || (reference.endSeconds !== undefined && (!finite(reference.endSeconds) || reference.endSeconds < reference.startSeconds)))) throw new AnalysisError(`${name} has an invalid video interval.`);
  if (kind === 'assumption') requiredString(reference.reason, `${name}.reason`);
  return { ...reference, kind };
}

function normalizeBox(box, name) {
  if (!isRecord(box)) throw new AnalysisError(`${name} must be an object.`);
  for (const key of ['x1', 'y1', 'x2', 'y2', 'width', 'height']) if (!finite(box[key]) || box[key] < 0) throw new AnalysisError(`${name}.${key} must be non-negative.`);
  if (box.x2 < box.x1 || box.y2 < box.y1 || box.width <= 0 || box.height <= 0 || box.x2 > box.width || box.y2 > box.height) throw new AnalysisError(`${name} has invalid geometry.`);
  return { x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2, width: box.width, height: box.height };
}

function normalizeZone(zone, name) {
  if (!isRecord(zone)) throw new AnalysisError(`${name} must be an object.`);
  for (const key of ['x', 'y', 'width', 'height']) if (!finite(zone[key]) || zone[key] < 0 || zone[key] > 1) throw new AnalysisError(`${name}.${key} must be normalized from 0 to 1.`);
  if (!zone.width || !zone.height || zone.x + zone.width > 1 || zone.y + zone.height > 1) throw new AnalysisError(`${name} is outside the frame.`);
  return { ...zone, id: requiredString(zone.id, `${name}.id`), label: requiredString(zone.label, `${name}.label`), kind: ['waiting', 'service', 'unknown'].includes(zone.kind) ? zone.kind : 'unknown', source: validReference(zone.source, `${name}.source`) };
}

function normalizeDetectionFrame(frame, index, durationSeconds) {
  if (!isRecord(frame) || !Number.isInteger(frame.frameIndex) || frame.frameIndex < 0 || !finite(frame.timeSeconds) || frame.timeSeconds < 0 || frame.timeSeconds > durationSeconds || !Array.isArray(frame.people)) throw new AnalysisError(`Detection frame ${index + 1} is invalid.`);
  return { frameIndex: frame.frameIndex, timeSeconds: frame.timeSeconds, people: frame.people.map((person, personIndex) => ({ id: Number.isInteger(person.id) && person.id >= 0 ? person.id : null, box: normalizeBox({ ...person.box, width: person.box?.width ?? 640, height: person.box?.height ?? 360 }, `Detection frame ${index + 1} person ${personIndex + 1}.box`), role: ['staff', 'background', 'customer', 'unknown'].includes(person.role) ? person.role : 'unknown', membership: ['waiting', 'service', 'excluded', 'unknown'].includes(person.membership) ? person.membership : 'unknown' })) };
}

function normalizeEvent(event, index, durationSeconds) {
  if (!isRecord(event)) throw new AnalysisError(`Candidate event ${index + 1} must be an object.`);
  const type = requiredString(event.type, `Candidate event ${index + 1}.type`);
  if (!['queue-join', 'service-start', 'service-end', 'departure'].includes(type) || !finite(event.timeSeconds) || event.timeSeconds < 0 || event.timeSeconds > durationSeconds) throw new AnalysisError(`Candidate event ${index + 1} is invalid.`);
  return { ...event, type, personId: event.personId ?? null, continuity: event.continuity ?? 'unknown', role: event.role ?? 'unknown', membership: event.membership ?? 'unknown', source: validReference(event.source, `Candidate event ${index + 1}.source`) };
}

function normalizeDetectionFrames(frames, durationSeconds) {
  const normalized = Array.isArray(frames) ? frames.map((frame, index) => normalizeDetectionFrame(frame, index, durationSeconds)) : [];
  normalized.sort((left, right) => left.frameIndex - right.frameIndex);
  for (let index = 1; index < normalized.length; index += 1) if (normalized[index].frameIndex === normalized[index - 1].frameIndex) throw new AnalysisError(`Detection frame ${normalized[index].frameIndex} is duplicated.`);
  return normalized;
}

export function validateAnalysis(input) {
  if (!isRecord(input) || input.schemaVersion !== ANALYSIS_SCHEMA_VERSION || !isRecord(input.clip)) throw new AnalysisError('Analysis has an unsupported shape.');
  const durationSeconds = input.clip.durationSeconds;
  if (!finite(durationSeconds) || durationSeconds <= 0 || durationSeconds > ANALYSIS_LIMITS.maxDurationSeconds) throw new AnalysisError('Clip duration is outside the supported bound.');
  const analysis = {
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    id: requiredString(input.id, 'Analysis id'),
    status: ['saved', 'fresh', 'failed', 'synthetic'].includes(input.status) ? input.status : 'fresh',
    clip: { id: requiredString(input.clip.id, 'clip.id'), filename: requiredString(input.clip.filename, 'clip.filename'), durationSeconds, width: input.clip.width, height: input.clip.height, sourceUrl: requiredString(input.clip.sourceUrl, 'clip.sourceUrl'), licenseUrl: requiredString(input.clip.licenseUrl, 'clip.licenseUrl'), attribution: requiredString(input.clip.attribution, 'clip.attribution') },
    provenance: { analysisMode: requiredString(input.provenance?.analysisMode, 'provenance.analysisMode'), savedAt: requiredString(input.provenance?.savedAt, 'provenance.savedAt'), processedFps: input.provenance?.processedFps, processedFrameCount: input.provenance?.processedFrameCount, models: { segmentation: requiredString(input.provenance?.models?.segmentation, 'segmentation model'), interpretation: requiredString(input.provenance?.models?.interpretation, 'interpretation model') } },
    detections: normalizeDetectionFrames(input.detections, durationSeconds),
    candidateZones: Array.isArray(input.candidateZones) ? input.candidateZones.map((zone, index) => normalizeZone(zone, `candidateZones[${index}]`)) : [],
    candidateEvents: Array.isArray(input.candidateEvents) ? input.candidateEvents.map((event, index) => normalizeEvent(event, index, durationSeconds)) : [],
    limitations: Array.isArray(input.limitations) ? input.limitations.map((value, index) => requiredString(value, `limitations[${index}]`)) : [],
    assessment: isRecord(input.assessment) ? structuredClone(input.assessment) : {},
    qualification: { verdict: requiredString(input.qualification?.verdict, 'qualification.verdict'), calibrationEligible: input.qualification?.calibrationEligible === true, rationale: requiredString(input.qualification?.rationale, 'qualification.rationale') },
  };
  if (analysis.detections.length > ANALYSIS_LIMITS.maxProcessedFrames || analysis.detections.reduce((sum, frame) => sum + frame.people.length, 0) > ANALYSIS_LIMITS.maxDetections || analysis.candidateZones.length > ANALYSIS_LIMITS.maxZones || analysis.candidateEvents.length > ANALYSIS_LIMITS.maxEvents) throw new AnalysisError('Analysis exceeds a supported bound.');
  return analysis;
}

export function parseSamOutput(text, { processedFps, durationSeconds }) {
  if (typeof text !== 'string' || !finite(processedFps) || processedFps <= 0) throw new AnalysisError('SAM output and processed fps are required.');
  const frames = [];
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(/<(\d+)f>/); if (!marker) continue;
    const people = []; const pattern = /(\d+)<\|box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+);w=(\d+);h=(\d+)(?:;c=[\d.]+)?\|>/g;
    let match; while ((match = pattern.exec(line))) people.push({ id: Number(match[1]), box: { x1: Number(match[2]), y1: Number(match[3]), x2: Number(match[4]), y2: Number(match[5]), width: Number(match[6]), height: Number(match[7]) }, role: 'unknown', membership: 'unknown' });
    const frameIndex = Number(marker[1]); if (frameIndex / processedFps <= durationSeconds) frames.push({ frameIndex, timeSeconds: frameIndex / processedFps, people });
  }
  frames.sort((left, right) => left.frameIndex - right.frameIndex);
  return frames.filter((frame, index) => index === 0 || frame.frameIndex !== frames[index - 1].frameIndex);
}

export function reviewAnalysis(analysis, corrections = {}) {
  const normalized = validateAnalysis(analysis);
  if (!isRecord(corrections.initialState) || corrections.initialState.kind !== 'empty') throw new AnalysisError('Choose the explicit empty queue and idle positions initial state before reviewing.');
  if (corrections.topology !== 'single-shared-queue') throw new AnalysisError('Confirm the supported one shared queue topology before reviewing.');
  const baselinePositions = corrections.baselinePositions;
  if (!Number.isInteger(baselinePositions) || baselinePositions < 1 || baselinePositions > 32) throw new AnalysisError('Reviewed baseline positions must be a positive integer from 1 to 32.');
  const observations = Array.isArray(corrections.observations) ? corrections.observations.map((event, index) => normalizeEvent(event, index, normalized.clip.durationSeconds)) : normalized.candidateEvents;
  const isExcluded = (event) => ['staff', 'background'].includes(event.role) || event.membership === 'excluded';
  const excludedObservations = observations.filter(isExcluded).map((event) => ({ personId: event.personId, type: event.type, reason: 'staff-or-background-excluded', source: event.source }));
  const byPerson = new Map(); for (const event of observations) { if (event.personId === null || isExcluded(event)) continue; if (!byPerson.has(event.personId)) byPerson.set(event.personId, []); byPerson.get(event.personId).push(event); }
  const completeWaits = []; const incompleteCases = [];
  const serviceDurations = [];
  for (const [personId, events] of byPerson) {
    const join = events.find((event) => event.type === 'queue-join');
    const start = events.find((event) => event.type === 'service-start');
    const end = events.find((event) => event.type === 'service-end' || event.type === 'departure');
    const reviewedCustomer = join?.role === 'customer' && start?.role === 'customer';
    const videoSupported = join?.source.kind === 'video' && start?.source.kind === 'video';
    const traceable = reviewedCustomer && videoSupported && join.continuity === 'continuous' && start.continuity === 'continuous';
    const ordered = join && start && start.timeSeconds >= join.timeSeconds;
    if (!normalized.qualification.calibrationEligible) incompleteCases.push({ personId, reason: 'clip-insufficient-for-calibration', source: (join ?? start)?.source ?? { kind: 'unsupported' } });
    else if (traceable && ordered) completeWaits.push({ personId, queueJoinSeconds: join.timeSeconds, serviceStartSeconds: start.timeSeconds, waitingTimeSeconds: start.timeSeconds - join.timeSeconds, source: { start: join.source, end: start.source } });
    else incompleteCases.push({ personId, reason: !join ? 'queue-join-not-visible' : !start ? 'service-start-not-visible' : !ordered ? 'event-order-invalid' : !reviewedCustomer ? 'person-role-not-reviewed' : !videoSupported ? 'observation-not-video-supported' : 'identity-continuity-not-supported', source: (join ?? start)?.source ?? { kind: 'unsupported' } });
    if (start?.role === 'customer' && end?.role === 'customer' && start?.source.kind === 'video' && end?.source.kind === 'video' && start.continuity === 'continuous' && end.continuity === 'continuous' && end.timeSeconds > start.timeSeconds) serviceDurations.push({ personId, serviceStartSeconds: start.timeSeconds, serviceEndSeconds: end.timeSeconds, serviceDurationSeconds: end.timeSeconds - start.timeSeconds, source: { start: start.source, end: end.source } });
  }
  const evidenceStatus = normalized.qualification.calibrationEligible ? 'qualified-observations' : 'exploratory-assumptions-required';
  const assumptions = corrections.assumptions ?? [];
  const proposedArrivals = corrections.assumedArrivals ?? [];
  const inputFingerprint = JSON.stringify({ baselinePositions, arrivals: proposedArrivals, initialState: { kind: 'empty' } });
  return { analysisId: normalized.id, analysisStatus: normalized.status, reviewVersion: 1, reviewedAt: new Date().toISOString(), topology: corrections.topology ?? 'single-shared-queue', zones: Array.isArray(corrections.zones) && corrections.zones.length ? corrections.zones.map((zone, index) => normalizeZone(zone, `reviewed zones[${index}]`)) : normalized.candidateZones, observations, excludedObservations, roleExclusions: corrections.roleExclusions ?? ['staff', 'background pedestrians', 'people already receiving service'], completeWaits, incompleteCases, serviceDurations, completeWaitCount: completeWaits.length, completeWaitMeanSeconds: completeWaits.length ? completeWaits.reduce((sum, item) => sum + item.waitingTimeSeconds, 0) / completeWaits.length : null, limitations: [...normalized.limitations], assumptions, evidenceStatus, calibrationStatus: normalized.qualification.calibrationEligible ? 'calibration-eligible-pending-review' : 'insufficient-for-calibration', qualification: normalized.qualification, proposedModelInputs: { baselinePositions, arrivals: proposedArrivals, initialState: corrections.initialState, evidenceReview: { analysisId: normalized.id, reviewVersion: 1, evidenceStatus, inputFingerprint } } };
}

let preparedAnalysisPromise;
export async function loadPreparedAnalysis() { preparedAnalysisPromise ??= readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'prepared-analysis.json'), 'utf8').then((text) => validateAnalysis(JSON.parse(text))); return structuredClone(await preparedAnalysisPromise); }
