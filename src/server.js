import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelWorkflow, WorkflowError } from './domain.js';
import { StaffingWorkflow } from './staffing.js';
import { AnalysisError, loadPreparedAnalysis, reviewAnalysis } from './analysis.js';
import { FreshAnalysisError, FreshAnalysisWorkflow, parseMultipartVideo, UPLOAD_LIMITS } from './fresh-analysis.js';

const publicDirectory = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public');
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mp4': 'video/mp4' };
const staticFiles = new Set(['index.html', 'app.js', 'evidence.js', 'staffing.js', 'playback.js', 'styles.css', 'media/prepared-checkout.mp4']);

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(payload);
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) throw new WorkflowError('Request body is too large.', 413);
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new WorkflowError('Request body must be valid JSON.');
  }
}

async function readBody(request, limit = UPLOAD_LIMITS.maxBytes + 1_000_000) {
  const contentLength = Number(request.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > limit) throw new FreshAnalysisError('Upload request is too large.', 413);
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new FreshAnalysisError('Upload request is too large.', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function serveStatic(response, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!staticFiles.has(relative)) return false;
  try {
    const content = await readFile(join(publicDirectory, relative));
    response.writeHead(200, { 'content-type': contentTypes[extname(relative)] });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
  return true;
}

export function createApplication({ staffingProvider, analysisSource, analysisProvider, inspectVideo, preprocessVideo } = {}) {
  const evidenceReviews = new Map();
  const freshAnalyses = new Map();
  const preparedSource = analysisSource ?? (async (analysisId) => {
    const analysis = await loadPreparedAnalysis();
    if (analysis.id !== analysisId) throw new AnalysisError('Analysis was not found.', 404);
    return analysis;
  });
  const latestEvidenceReviewVersions = new Map();
  const source = async (analysisId) => freshAnalyses.get(analysisId) ?? preparedSource(analysisId);
  const workflow = new ModelWorkflow({ evidenceReviews, latestEvidenceReviewVersions });
  const staffing = new StaffingWorkflow(workflow, { provider: staffingProvider });
  const uploads = new FreshAnalysisWorkflow({ analyses: freshAnalyses, provider: analysisProvider, inspect: inspectVideo, preprocess: preprocessVideo });
  return { workflow, staffing, analysisSource: source, evidenceReviews, latestEvidenceReviewVersions, freshAnalyses, uploads };
}

export function createRequestHandler(application = createApplication()) {
  return async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    try {
      if (request.method === 'GET' && await serveStatic(response, url.pathname)) return;
      if (request.method === 'GET' && url.pathname === '/api/analysis/prepared') {
        sendJson(response, 200, { analysis: await application.analysisSource('prepared-pexels-checkout-36s') });
        return;
      }
      if (request.method === 'POST' && (url.pathname === '/api/analysis/upload' || url.pathname === '/api/analysis/uploads')) {
        const upload = parseMultipartVideo(await readBody(request), request.headers['content-type']);
        sendJson(response, 202, { upload: application.uploads.start(upload) });
        return;
      }
      const uploadStatus = url.pathname.match(/^\/api\/analysis\/uploads?\/([^/]+)$/);
      if (request.method === 'GET' && uploadStatus) {
        sendJson(response, 200, { upload: application.uploads.get(uploadStatus[1]) });
        return;
      }
      const uploadVideo = url.pathname.match(/^\/api\/analysis\/uploads?\/([^/]+)\/video$/);
      if (request.method === 'GET' && uploadVideo) {
        const data = application.uploads.getVideo(uploadVideo[1]);
        response.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': 'no-store', 'content-length': data.length });
        response.end(data);
        return;
      }
      const analysisReview = url.pathname.match(/^\/api\/analysis\/([^/]+)\/review$/);
      if (request.method === 'POST' && analysisReview) {
        const analysis = await application.analysisSource(analysisReview[1]);
        const review = reviewAnalysis(analysis, await readJson(request));
        const reviewVersion = (application.latestEvidenceReviewVersions.get(review.analysisId) ?? 0) + 1;
        review.reviewVersion = reviewVersion;
        review.proposedModelInputs.evidenceReview.reviewVersion = reviewVersion;
        application.latestEvidenceReviewVersions.set(review.analysisId, reviewVersion);
        application.evidenceReviews.set(`${review.analysisId}:${review.reviewVersion}`, review);
        sendJson(response, 200, { review });
        return;
      }
      const match = url.pathname.match(/^\/api\/models(?:\/([^/]+)(?:\/(review|compare|staffing\/interpret|staffing\/confirm))?)?$/);
      if (!match) {
        sendJson(response, 404, { error: 'Not found.' });
        return;
      }
      const id = match[1];
      const action = match[2];
      if (request.method === 'POST' && !id) {
        sendJson(response, 201, { model: application.workflow.create(await readJson(request)) });
      } else if (request.method === 'GET' && id && !action) {
        sendJson(response, 200, { model: application.workflow.get(id) });
      } else if (request.method === 'PUT' && id && !action) {
        sendJson(response, 200, { model: application.workflow.update(id, await readJson(request)) });
      } else if (request.method === 'POST' && id && action === 'review') {
        const body = await readJson(request);
        sendJson(response, 200, { model: application.workflow.review(id, body.expectedVersion) });
      } else if (request.method === 'POST' && id && action === 'compare') {
        const body = await readJson(request);
        sendJson(response, 200, { comparison: application.workflow.compare(id, body.reviewedVersion, body.interventionPositions) });
      } else if (request.method === 'POST' && id && action === 'staffing/interpret') {
        const body = await readJson(request);
        sendJson(response, 200, { proposal: await application.staffing.interpret(id, body.request) });
      } else if (request.method === 'POST' && id && action === 'staffing/confirm') {
        const body = await readJson(request);
        sendJson(response, 200, await application.staffing.confirm(id, body.proposalId));
      } else {
        sendJson(response, 405, { error: 'Method not allowed.' });
      }
    } catch (error) {
      const status = error instanceof WorkflowError || error instanceof AnalysisError || error instanceof FreshAnalysisError ? error.status : 500;
      sendJson(response, status, { error: status === 500 ? 'The server could not complete that request.' : error.message });
    }
  };
}

export function startServer({ port = 3000, host = '127.0.0.1', application } = {}) {
  const server = createHttpServer(createRequestHandler(application));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer().then((server) => {
    console.log(`Counterfactual running at http://${server.address().address}:${server.address().port}`);
  });
}
