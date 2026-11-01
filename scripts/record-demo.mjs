import { mkdir, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const modulePath = process.env.COUNTERFACTUAL_PLAYWRIGHT || 'playwright';
const { chromium } = await import(modulePath);
const baseUrl = process.env.COUNTERFACTUAL_BASE_URL || 'http://127.0.0.1:3000';
const executablePath = process.env.COUNTERFACTUAL_CHROMIUM;
const rehearsal = process.argv.includes('--rehearse');
const outputDir = resolve('docs/demo');
const outputPath = resolve(outputDir, 'counterfactual-demo.webm');

await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  ...(rehearsal ? {} : { recordVideo: { dir: outputDir, size: { width: 1280, height: 720 } } }),
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });

async function pause(seconds) {
  await page.waitForTimeout((rehearsal ? 0.1 : seconds) * 1000);
}

async function subtitle(text) {
  await page.evaluate((value) => {
    let bar = document.querySelector('#demo-subtitle');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'demo-subtitle';
      bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:999999;padding:12px 24px;background:rgba(21,37,62,.9);color:#fff;text-align:center;font:600 16px system-ui,sans-serif;pointer-events:none;';
      document.body.append(bar);
    }
    bar.textContent = value;
    bar.style.opacity = value ? '1' : '0';
  }, text);
  await pause(text ? 1 : 0.2);
}

async function cursor() {
  await page.evaluate(() => {
    if (document.querySelector('#demo-cursor')) return;
    const cursor = document.createElement('div');
    cursor.id = 'demo-cursor';
    cursor.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M5 3l14 9-7 1-3 7L5 3Z" fill="white" stroke="#15253e" stroke-width="1.5"/></svg>';
    cursor.style.cssText = 'position:fixed;z-index:1000000;pointer-events:none;width:24px;height:24px;filter:drop-shadow(1px 1px 2px #0008);';
    document.body.append(cursor);
    document.addEventListener('mousemove', (event) => { cursor.style.left = `${event.clientX}px`; cursor.style.top = `${event.clientY}px`; });
  });
}

async function moveClick(locator, label) {
  const count = await locator.count();
  if (count !== 1) throw new Error(`${label}: expected one control, found ${count}`);
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await pause(0.4);
  await locator.click();
  await pause(1.5);
}

async function inspect(label, locator) {
  const count = await locator.count();
  if (count !== 1) throw new Error(`${label}: expected one control, found ${count}`);
  if (!(await locator.isVisible())) throw new Error(`${label}: control is not visible`);
}

try {
  await page.goto(baseUrl);
  await cursor();
  await subtitle('A video can show movement. The review decides what it supports.');
  const preparedStatus = page.getByText('Saved analysis · no fresh inference', { exact: true });
  await inspect('saved analysis label', preparedStatus);
  await page.screenshot({ path: resolve(outputDir, '01-prepared-analysis.png'), fullPage: false });
  await pause(18);
  await page.locator('#evidence-video').scrollIntoViewIfNeeded();
  await page.evaluate(() => { const video = document.querySelector('#evidence-video'); video.currentTime = 10; void video.play(); });
  await subtitle('SAM boxes people. Wonder describes the scene. Neither creates measured waits.');
  await pause(7);
  await page.evaluate(() => { const video = document.querySelector('#evidence-video'); video.pause(); });
  await page.screenshot({ path: resolve(outputDir, '02-evidence-limits.png'), fullPage: false });
  await pause(20);

  await page.getByRole('button', { name: 'Confirm evidence review', exact: true }).scrollIntoViewIfNeeded();
  await subtitle('The checkout clip has no formed queue or complete observed wait. Continue with explicit assumptions.');
  await moveClick(page.getByRole('button', { name: 'Confirm evidence review', exact: true }), 'confirm evidence review');
  await moveClick(page.getByRole('button', { name: 'Save model inputs', exact: false }), 'save model inputs');
  await moveClick(page.getByRole('button', { name: 'Confirm reviewed model', exact: true }), 'confirm reviewed model');
  await subtitle('The reviewed model fixes one shared queue, an explicit empty start, and unchanged service demands.');
  await pause(15);

  await page.locator('#intervention-positions').scrollIntoViewIfNeeded();
  await moveClick(page.getByRole('button', { name: 'Run the what-if', exact: false }), 'run explicit staffing what-if');
  await subtitle('Only staffing changes. The simulator computes both finite cohorts from the same arrivals and demands.');
  await pause(25);
  await page.locator('#playback-section').scrollIntoViewIfNeeded();
  await pause(4);
  await page.locator('#playback-time').fill('5');
  await pause(4);
  await page.locator('#playback-toggle').click();
  await pause(7);
  await page.locator('#playback-toggle').click();
  await subtitle('At service start, waiting ends. People in service are excluded from queue length.');
  await page.screenshot({ path: resolve(outputDir, '03-comparison.png'), fullPage: false });
  await pause(25);
  await subtitle('The result is an unvalidated model prediction, not intervention validation.');
  await pause(5);
  await subtitle('Fresh uploads are bounded and retryable. Prepared analysis keeps the presentation reproducible.');
  await page.locator('#fresh-upload-section').scrollIntoViewIfNeeded();
  await pause(20);
  await subtitle('Counterfactual · exploratory queue model');
  await pause(5);
  await subtitle('');
} finally {
  await context.close();
  const video = page.video();
  if (video && !rehearsal) await copyFile(await video.path(), outputPath);
  await browser.close();
}

if (errors.length) {
  console.error(`Browser errors: ${errors.join(' | ')}`);
  process.exitCode = 1;
}
console.log(`${rehearsal ? 'Rehearsal' : 'Recording'} complete${errors.length ? ' with browser errors' : ''}.`);
