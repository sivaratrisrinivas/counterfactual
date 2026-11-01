// Feasibility experiment, not the application's API client.
import { loadEnvFile } from 'node:process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

loadEnvFile('.env');
const key = process.env.MODEL_API_KEY;
if (!key) throw new Error('MODEL_API_KEY is missing');
const [mode = 'models', mediaPath] = process.argv.slice(2);
const outputDirectory = '.scratch/meta-spike';
await mkdir(outputDirectory, { recursive: true });
const redact = (value) => value.split(key).join('[REDACTED]');
const save = (name, value) => writeFile(`${outputDirectory}/${name}`, redact(JSON.stringify(value, null, 2)));

async function request(path, body) {
  const started = performance.now();
  const response = await fetch(`https://api.meta.ai/v1/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) {
    const detail = redact(await response.text()).slice(0, 1500);
    throw new Error(`Meta HTTP ${response.status}: ${detail}`);
  }
  return { response, started };
}

try {
  if (mode === 'models') {
    const { response } = await request('models');
    const data = await response.json();
    await save('models.json', data);
    console.log(JSON.stringify({ models: data.data?.map((model) => model.id) }, null, 2));
  } else if (mode === 'upload') {
    if (!mediaPath) throw new Error('Pass the path to an MP4 file');
    const data = await readFile(mediaPath);
    const form = new FormData();
    form.set('purpose', 'user_data');
    form.set('file', new Blob([data], { type: 'video/mp4' }), basename(mediaPath));
    const { response } = await request('files', form);
    const result = await response.json();
    await save('upload.json', result);
    console.log(JSON.stringify({ id: result.id, bytes: result.bytes, status: result.status }));
  } else if (mode === 'wonder' || mode === 'sam') {
    const uploaded = JSON.parse(await readFile(`${outputDirectory}/upload.json`, 'utf8'));
    const isSam = mode === 'sam';
    const prompt = isSam ? 'person' : `Inspect this short checkout video for a queue-simulation feasibility study.
Describe only visible evidence. Do not invent arrival rates, service times, waiting times, or queue discipline.
Return a concise JSON object with scene_description, camera_motion, visible_service_positions,
queue_topology_and_uncertainty, complete_observable_service_episodes (timestamps only when genuinely visible),
occlusion_problems, measurements_supported, measurements_not_supported, and suitability_verdict.
Distinguish a person waiting from a person already receiving service. If evidence is insufficient, say so.
The video is illustrative and must not be described as validation of any staffing intervention.`;
    const body = {
      model: isSam ? 'sam-3.1' : 'muse-wonder-1.0',
      input: [{ type: 'message', role: 'user', content: [
        { type: 'input_text', text: prompt },
        { type: 'input_video', file_id: uploaded.id },
      ] }],
      ...(isSam ? { stream: true } : { max_output_tokens: 1800, reasoning: { effort: 'low' } }),
    };
    const { response, started } = await request('responses', body);
    if (!isSam) {
      const result = await response.json();
      await save('wonder.json', result);
      console.log(JSON.stringify({ elapsed_seconds: (performance.now() - started) / 1000,
        status: result.status, usage: result.usage,
        text: result.output?.flatMap((item) => item.content ?? []).filter((item) => item.type === 'output_text').map((item) => item.text).join('\n'),
      }, null, 2));
    } else {
      const raw = await response.text();
      await writeFile(`${outputDirectory}/sam.sse`, redact(raw));
      const events = raw.split(/\r?\n/).filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6)).filter((line) => line !== '[DONE]').map((line) => JSON.parse(line));
      const completed = events.find((event) => event.type === 'response.completed');
      const failures = events.filter((event) => ['error', 'response.failed', 'response.incomplete'].includes(event.type));
      const text = events.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta).join('');
      await writeFile(`${outputDirectory}/sam.txt`, text);
      const frameMarkers = [...text.matchAll(/<(\d+)f>/g)].map((match) => Number(match[1]));
      const summary = { elapsed_seconds: (performance.now() - started) / 1000,
        completed: Boolean(completed), failures, frame_records: frameMarkers.length,
        first_frame: frameMarkers.at(0), last_frame: frameMarkers.at(-1),
        usage: completed?.response?.usage, output_characters: text.length };
      await save('sam-summary.json', summary);
      console.log(JSON.stringify(summary, null, 2));
      if (!completed || failures.length) process.exitCode = 1;
    }
  } else {
    throw new Error('Usage: node scripts/meta-spike.mjs models|upload <clip.mp4>|wonder|sam');
  }
} catch (error) {
  console.error(redact(JSON.stringify({ error: error.message, cause: error.cause?.code })));
  process.exitCode = 1;
}
