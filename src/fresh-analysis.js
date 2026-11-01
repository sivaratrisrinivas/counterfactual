import { randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { promisify } from 'node:util';
import { AnalysisError, ANALYSIS_LIMITS, parseSamOutput, validateAnalysis } from './analysis.js';

const execFile = promisify(execFileCallback);
export const UPLOAD_LIMITS = Object.freeze({
  maxBytes: 25 * 1024 * 1024,
  maxDurationSeconds: ANALYSIS_LIMITS.maxDurationSeconds,
  maxProcessedFrames: ANALYSIS_LIMITS.maxProcessedFrames,
  processedFps: 5,
  width: 640,
  height: 360,
  timeoutMs: 180_000,
  allowedMimeTypes: ['video/mp4', 'video/webm', 'video/quicktime'],
  allowedExtensions: ['.mp4', '.webm', '.mov'],
});

export class FreshAnalysisError extends AnalysisError {
  constructor(message, status = 400) { super(message, status); this.name = 'FreshAnalysisError'; }
}

function assertUploadMetadata({ filename, mimeType, data }) {
  if (!Buffer.isBuffer(data) || data.length === 0) throw new FreshAnalysisError('Choose a non-empty video file.');
  if (data.length > UPLOAD_LIMITS.maxBytes) throw new FreshAnalysisError(`Video files must be ${Math.floor(UPLOAD_LIMITS.maxBytes / 1024 / 1024)} MB or smaller.`, 413);
  const extension = extname(filename || '').toLowerCase();
  if (!UPLOAD_LIMITS.allowedMimeTypes.includes(mimeType) || !UPLOAD_LIMITS.allowedExtensions.includes(extension)) throw new FreshAnalysisError('Upload an MP4, WebM, or QuickTime video.');
  if (data.length < 12 || data.subarray(4, 8).toString() !== 'ftyp') {
    if (mimeType === 'video/mp4' || mimeType === 'video/quicktime') throw new FreshAnalysisError('The uploaded file is not a readable MP4 or QuickTime video.');
  }
  return { filename: basename(filename).slice(0, 180), mimeType };
}

function assertVideoMetadata(metadata, message = 'The uploaded video metadata was invalid.') {
  if (!metadata || !Number.isFinite(metadata.durationSeconds) || metadata.durationSeconds <= 0 || metadata.durationSeconds > UPLOAD_LIMITS.maxDurationSeconds) throw new FreshAnalysisError(message.includes('prepared') ? message : `Video duration must be greater than 0 and no more than ${UPLOAD_LIMITS.maxDurationSeconds} seconds.`, 422);
  if (!Number.isInteger(metadata.width) || metadata.width < 2 || !Number.isInteger(metadata.height) || metadata.height < 2) throw new FreshAnalysisError(message.includes('prepared') ? message : 'The uploaded video has unsupported dimensions.', 422);
  if (!Number.isFinite(metadata.frameRate) || metadata.frameRate <= 0) throw new FreshAnalysisError(message.includes('prepared') ? message : 'The uploaded video has an invalid frame rate.', 422);
  if (!Number.isInteger(metadata.processedFrameCount) || metadata.processedFrameCount < 1 || metadata.processedFrameCount > UPLOAD_LIMITS.maxProcessedFrames || !Number.isFinite(metadata.processedFps) || metadata.processedFps <= 0 || metadata.processedFps > UPLOAD_LIMITS.processedFps) throw new FreshAnalysisError(message.includes('prepared') ? message : 'The uploaded video exceeds the processing frame budget.', 422);
  return metadata;
}

export async function inspectVideo(filePath, { exec = execFile } = {}) {
  let stdout;
  try {
    ({ stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_name,width,height,r_frame_rate', '-of', 'json', filePath], { timeout: 10_000, maxBuffer: 200_000 }));
  } catch {
    throw new FreshAnalysisError('The uploaded video could not be inspected.', 422);
  }
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { throw new FreshAnalysisError('The uploaded video metadata was malformed.', 422); }
  const stream = parsed.streams?.find((item) => item.codec_name && item.width && item.height);
  const durationSeconds = Number(parsed.format?.duration);
  if (!stream || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > UPLOAD_LIMITS.maxDurationSeconds) throw new FreshAnalysisError(`Video duration must be greater than 0 and no more than ${UPLOAD_LIMITS.maxDurationSeconds} seconds.`, 422);
  const width = Number(stream.width); const height = Number(stream.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) throw new FreshAnalysisError('The uploaded video has unsupported dimensions.', 422);
  const sourceFps = String(stream.r_frame_rate || '0');
  const [num, den] = sourceFps.split('/').map(Number);
  const frameRate = den > 0 ? num / den : Number(sourceFps);
  const processedFrameCount = Math.ceil(durationSeconds * UPLOAD_LIMITS.processedFps);
  if (!Number.isFinite(frameRate) || frameRate <= 0 || processedFrameCount > UPLOAD_LIMITS.maxProcessedFrames) throw new FreshAnalysisError('The uploaded video exceeds the processing frame budget.', 422);
  return { durationSeconds, width, height, frameRate, codec: stream.codec_name, processedFrameCount, processedFps: UPLOAD_LIMITS.processedFps };
}

export async function preprocessVideo(inputPath, outputPath, { exec = execFile, metadata } = {}) {
  try {
    await exec('ffmpeg', ['-y', '-i', inputPath, '-vf', `fps=${UPLOAD_LIMITS.processedFps},scale=${UPLOAD_LIMITS.width}:${UPLOAD_LIMITS.height}:force_original_aspect_ratio=decrease,pad=${UPLOAD_LIMITS.width}:${UPLOAD_LIMITS.height}:(ow-iw)/2:(oh-ih)/2`, '-an', '-frames:v', String(UPLOAD_LIMITS.maxProcessedFrames), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', outputPath], { timeout: UPLOAD_LIMITS.timeoutMs, maxBuffer: 500_000 });
  } catch {
    throw new FreshAnalysisError('The uploaded video could not be prepared for analysis.', 422);
  }
  const preparedMetadata = await inspectVideo(outputPath, { exec });
  return { ...metadata, ...preparedMetadata, width: UPLOAD_LIMITS.width, height: UPLOAD_LIMITS.height, processedFps: UPLOAD_LIMITS.processedFps };
}

function outputText(response) {
  return response?.output?.flatMap((item) => item?.content ?? []).filter((item) => item?.type === 'output_text').map((item) => item.text || (item.parsed ? JSON.stringify(item.parsed) : '')).join('').trim() || response?.output_text?.trim() || '';
}

const WONDER_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    scene_description: { type: 'string' }, camera_motion: { type: 'string' }, visible_service_positions: { type: 'array', items: { type: 'string' } }, queue_topology_and_uncertainty: { type: 'string' },
    complete_observable_service_episodes: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { start_seconds: { type: 'number' }, end_seconds: { type: 'number' } }, required: ['start_seconds', 'end_seconds'] } },
    occlusion_problems: { type: 'array', items: { type: 'string' } }, measurements_supported: { type: 'array', items: { type: 'string' } }, measurements_not_supported: { type: 'array', items: { type: 'string' } }, suitability_verdict: { type: 'string' },
    calibration_eligibility: { type: 'object', additionalProperties: false, properties: { eligible: { type: 'boolean' }, traceable_queue: { type: 'boolean' }, traceable_timings: { type: 'boolean' }, rationale: { type: 'string' } }, required: ['eligible', 'traceable_queue', 'traceable_timings', 'rationale'] },
  }, required: ['scene_description', 'camera_motion', 'visible_service_positions', 'queue_topology_and_uncertainty', 'complete_observable_service_episodes', 'occlusion_problems', 'measurements_supported', 'measurements_not_supported', 'suitability_verdict', 'calibration_eligibility'],
});

function parseWonderResult(value, metadata) {
  let result = value;
  if (typeof result === 'string') { try { result = JSON.parse(result); } catch { throw new FreshAnalysisError('Scene interpretation returned malformed structured output.', 502); } }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new FreshAnalysisError('Scene interpretation returned malformed structured output.', 502);
  const fields = ['scene_description', 'camera_motion', 'queue_topology_and_uncertainty', 'suitability_verdict'];
  for (const field of fields) if (typeof result[field] !== 'string' || !result[field].trim()) throw new FreshAnalysisError('Scene interpretation was incomplete.', 502);
  for (const field of ['visible_service_positions', 'occlusion_problems', 'measurements_supported', 'measurements_not_supported', 'complete_observable_service_episodes']) if (!Array.isArray(result[field])) throw new FreshAnalysisError('Scene interpretation was incomplete.', 502);
  for (const field of ['visible_service_positions', 'occlusion_problems', 'measurements_supported', 'measurements_not_supported']) {
    if (result[field].some((item) => typeof item !== 'string' || !item.trim())) throw new FreshAnalysisError('Scene interpretation contains malformed list values.', 502);
  }
  for (const episode of result.complete_observable_service_episodes) {
    if (!episode || typeof episode !== 'object' || Array.isArray(episode) || !Number.isFinite(episode.start_seconds) || !Number.isFinite(episode.end_seconds) || episode.start_seconds < 0 || episode.end_seconds <= episode.start_seconds || episode.end_seconds > metadata.durationSeconds) {
      throw new FreshAnalysisError('Scene interpretation contains malformed service timing evidence.', 502);
    }
  }
  const eligibility = result.calibration_eligibility;
  if (!eligibility || typeof eligibility !== 'object' || Array.isArray(eligibility) || typeof eligibility.eligible !== 'boolean' || typeof eligibility.traceable_queue !== 'boolean' || typeof eligibility.traceable_timings !== 'boolean' || typeof eligibility.rationale !== 'string' || !eligibility.rationale.trim()) {
    throw new FreshAnalysisError('Scene interpretation returned malformed calibration eligibility.', 502);
  }
  return result;
}

function parseSamStream(value, metadata) {
  if (!value || value.completed !== true || value.failures?.length) throw new FreshAnalysisError('Person segmentation did not complete.', 502);
  const text = String(value.text ?? '');
  if (!text.trim()) return [];
  if (!/<\d+f>/.test(text)) throw new FreshAnalysisError('Person segmentation returned malformed frame output.', 502);
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const markerIndexes = [];
  for (const line of lines) {
    const marker = line.match(/^\s*<(\d+)f>/);
    if (!marker) throw new FreshAnalysisError('Person segmentation returned a malformed frame stream.', 502);
    const frameIndex = Number(marker[1]);
    if (frameIndex >= metadata.processedFrameCount || frameIndex / metadata.processedFps > metadata.durationSeconds) throw new FreshAnalysisError('Person segmentation exceeded the processed frame budget.', 502);
    markerIndexes.push(frameIndex);
    if (!/\d+<\|box;x1=\d+;y1=\d+;x2=\d+;y2=\d+;w=\d+;h=\d+(?:;c=[\d.]+)?\|>/.test(line)) throw new FreshAnalysisError('Person segmentation returned malformed box output.', 502);
  }
  if (new Set(markerIndexes).size !== markerIndexes.length) throw new FreshAnalysisError('Person segmentation repeated a frame record.', 502);
  const frames = parseSamOutput(text, metadata);
  if (!frames.length) throw new FreshAnalysisError('Person segmentation returned no valid frame records.', 502);
  if (frames.length > UPLOAD_LIMITS.maxProcessedFrames) throw new FreshAnalysisError('Person segmentation exceeded the processed frame budget.', 502);
  return frames;
}

export function buildFreshAnalysis({ id, filename, metadata, sam, wonder, savedAt = new Date().toISOString() }) {
  const detections = parseSamStream(sam, metadata);
  const assessment = parseWonderResult(wonder, metadata);
  const episodes = assessment.complete_observable_service_episodes;
  const verdict = assessment.suitability_verdict;
  const eligibility = assessment.calibration_eligibility;
  const hasPersonLevelQueueEvidence = episodes.some((episode) => Number.isInteger(episode.person_id) && Number.isFinite(episode.queue_join_seconds) && Number.isFinite(episode.service_start_seconds));
  const calibrationEligible = eligibility.eligible === true && eligibility.traceable_queue === true && eligibility.traceable_timings === true && hasPersonLevelQueueEvidence && assessment.visible_service_positions.length > 0 && episodes.length > 0 && detections.length > 0;
  const candidateEvents = episodes.flatMap((episode) => [
    { type: 'service-start', personId: null, timeSeconds: episode.start_seconds, continuity: 'unknown', role: 'unknown', membership: 'service', source: { kind: 'video', startSeconds: episode.start_seconds, endSeconds: episode.start_seconds } },
    { type: 'service-end', personId: null, timeSeconds: episode.end_seconds, continuity: 'unknown', role: 'unknown', membership: 'service', source: { kind: 'video', startSeconds: episode.end_seconds, endSeconds: episode.end_seconds } },
  ]);
  const limitations = [assessment.camera_motion, assessment.queue_topology_and_uncertainty, ...assessment.occlusion_problems, ...assessment.measurements_not_supported, 'Provider service episodes have no person-level queue joins or machine-readable identity; review candidate proposals before using timings.', ...(!calibrationEligible ? ['Calibration eligibility is pending human review because traceable queue and timing evidence is incomplete.'] : [])].filter(Boolean);
  const analysis = {
    schemaVersion: 1, id, status: 'fresh',
    clip: { id, filename, durationSeconds: metadata.durationSeconds, width: metadata.width, height: metadata.height, sourceUrl: 'https://example.invalid/user-upload', licenseUrl: 'https://example.invalid/user-upload-rights', attribution: 'Uploaded by the user; media rights were not verified by Counterfactual.', videoUrl: `/api/analysis/uploads/${id}/video` },
    provenance: { analysisMode: 'fresh', savedAt, processedFps: metadata.processedFps, processedFrameCount: metadata.processedFrameCount, models: { segmentation: 'sam-3.1', interpretation: 'muse-wonder-1.0' } },
    detections, candidateZones: [], candidateEvents, limitations, assessment: { ...assessment, complete_observable_service_episodes: episodes },
    qualification: { verdict, calibrationEligible, rationale: calibrationEligible ? 'Structured evidence reports a visible queue and traceable timings; review every candidate event and identity before relying on it.' : `Calibration is not locally eligible: ${eligibility.rationale}` },
  };
  return validateAnalysis(analysis);
}

export function createMetaAnalysisProvider({ apiKey = process.env.MODEL_API_KEY, fetchImpl = globalThis.fetch } = {}) {
  return async ({ videoPath, metadata }) => {
    if (!apiKey) throw new FreshAnalysisError('Fresh analysis is unavailable because MODEL_API_KEY is not configured.', 503);
    const bytes = await readFile(videoPath);
    const form = new FormData(); form.set('purpose', 'user_data'); form.set('file', new Blob([bytes], { type: 'video/mp4' }), 'counterfactual-upload.mp4');
    const uploaded = await fetchImpl('https://api.meta.ai/v1/files', { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(UPLOAD_LIMITS.timeoutMs) });
    if (!uploaded.ok) throw new FreshAnalysisError('The analysis provider rejected this video.', 502);
    const file = await uploaded.json(); if (!file.id) throw new FreshAnalysisError('The analysis provider returned an invalid upload.', 502);
    const prompt = 'person';
    const samResponse = await fetchImpl('https://api.meta.ai/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify({ model: 'sam-3.1', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_video', file_id: file.id }] }], stream: true }), signal: AbortSignal.timeout(UPLOAD_LIMITS.timeoutMs) });
    if (!samResponse.ok) throw new FreshAnalysisError('Person segmentation failed.', 502);
    const rawSam = await samResponse.text(); const events = rawSam.split(/\r?\n/).filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).filter((line) => line !== '[DONE]').map((line) => { try { return JSON.parse(line); } catch { return { type: 'error' }; } });
    const sam = { completed: events.some((event) => event.type === 'response.completed'), failures: events.filter((event) => ['error', 'response.failed', 'response.incomplete'].includes(event.type)), text: events.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta || '').join('') };
    const wonderResponse = await fetchImpl('https://api.meta.ai/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'muse-wonder-1.0', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect this video for visible queue structure and evidence. Do not invent timings. Return only the requested JSON.' }, { type: 'input_video', file_id: file.id }] }], max_output_tokens: 1800, reasoning: { effort: 'low' }, text: { format: { type: 'json_schema', name: 'counterfactual_scene', strict: true, schema: WONDER_SCHEMA } } }), signal: AbortSignal.timeout(UPLOAD_LIMITS.timeoutMs) });
    if (!wonderResponse.ok) throw new FreshAnalysisError('Scene interpretation failed.', 502);
    const wonderPayload = await wonderResponse.json();
    if (wonderPayload.status !== 'completed') throw new FreshAnalysisError('Scene interpretation did not complete.', 502);
    return { sam, wonder: outputText(wonderPayload), usage: { sam: undefined, wonder: wonderPayload.usage } };
  };
}

export class FreshAnalysisWorkflow {
  #jobs = new Map(); #analyses; #provider; #inspect; #preprocess;
  constructor({ analyses = new Map(), provider = createMetaAnalysisProvider(), inspect = inspectVideo, preprocess = preprocessVideo } = {}) { this.#analyses = analyses; this.#provider = provider; this.#inspect = inspect; this.#preprocess = preprocess; }
  start({ filename, mimeType, data }) {
    const normalized = assertUploadMetadata({ filename, mimeType, data });
    const id = `fresh-${randomUUID()}`;
    const job = { id, status: 'pending', filename: normalized.filename, createdAt: new Date().toISOString(), error: null, analysis: null, videoData: null };
    this.#jobs.set(id, job);
    this.#run(job, data, normalized).catch((error) => { job.status = 'failed'; job.error = error instanceof FreshAnalysisError ? error.message : 'Fresh analysis failed.'; });
    return this.#view(job);
  }
  get(id) { const job = this.#jobs.get(id); if (!job) throw new FreshAnalysisError('Upload analysis was not found.', 404); return this.#view(job); }
  getVideo(id) { const job = this.#jobs.get(id); if (!job?.videoData) throw new FreshAnalysisError('Uploaded video was not found.', 404); return job.videoData; }
  #view(job) { return { id: job.id, status: job.status, filename: job.filename, createdAt: job.createdAt, error: job.error, analysis: job.analysis ? structuredClone(job.analysis) : null }; }
  async #run(job, data, normalized) {
    const scratch = await mkdtemp(join(tmpdir(), 'counterfactual-upload-')); const inputPath = join(scratch, normalized.filename); const preparedPath = join(scratch, 'prepared.mp4');
    try {
      job.status = 'running'; await writeFile(inputPath, data);
      const metadata = assertVideoMetadata(await this.#inspect(inputPath));
      const preparedResult = await this.#preprocess(inputPath, preparedPath, { metadata });
      const preparedMetadata = assertVideoMetadata(preparedResult?.metadata ?? preparedResult ?? metadata, 'The prepared video metadata was invalid.');
      const preparedData = Buffer.isBuffer(preparedResult?.data) ? preparedResult.data : await readFile(preparedPath);
      if (!preparedData.length) throw new FreshAnalysisError('The prepared video was empty.', 422);
      job.videoData = preparedData;
      const result = await this.#provider({ videoPath: preparedPath, metadata: preparedMetadata });
      const analysis = buildFreshAnalysis({ id: job.id, filename: normalized.filename, metadata: preparedMetadata, ...result });
      this.#analyses.set(analysis.id, analysis); job.analysis = analysis; job.status = 'completed';
    } catch (error) { throw error instanceof FreshAnalysisError ? error : new FreshAnalysisError('Fresh analysis failed.', 502); }
    finally { await rm(scratch, { recursive: true, force: true }).catch(() => {}); }
  }
}

export function parseMultipartVideo(buffer, contentType) {
  const match = /^multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) throw new FreshAnalysisError('Upload must use multipart/form-data.', 415);
  const boundary = `--${match[1] || match[2]}`; const source = buffer.toString('latin1'); const parts = source.split(boundary).slice(1, -1);
  for (const part of parts) {
    const separator = part.indexOf('\r\n\r\n'); if (separator < 0) continue;
    const headers = part.slice(0, separator); const body = part.slice(separator + 4).replace(/\r\n$/, '');
    const disposition = /name="([^"]+)"(?:;\s*filename="([^"]*)")?/i.exec(headers); if (!disposition || disposition[1] !== 'video' || !disposition[2]) continue;
    const type = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() || 'application/octet-stream';
    return { filename: disposition[2], mimeType: type, data: Buffer.from(body, 'latin1') };
  }
  throw new FreshAnalysisError('Choose one video file to upload.');
}
