import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelWorkflow, WorkflowError } from './domain.js';
import { StaffingWorkflow } from './staffing.js';

const publicDirectory = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public');
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

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

async function serveStatic(response, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'app.js', 'staffing.js', 'styles.css'].includes(relative)) return false;
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

export function createApplication({ staffingProvider } = {}) {
  const workflow = new ModelWorkflow();
  const staffing = new StaffingWorkflow(workflow, { provider: staffingProvider });
  return { workflow, staffing };
}

export function createRequestHandler(application = createApplication()) {
  return async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    try {
      if (request.method === 'GET' && await serveStatic(response, url.pathname)) return;
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
      const status = error instanceof WorkflowError ? error.status : 500;
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
