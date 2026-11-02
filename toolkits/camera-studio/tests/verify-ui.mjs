import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSharedEnv } from '../server/env.mjs';
import assert from 'node:assert/strict';
import { command } from '../server/storage.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const real = process.argv.includes('--real-api');
const env = loadSharedEnv();
if (real && !env.XMAX_API_KEY?.trim()) throw new Error('真实验证需要在仓库根目录 .env 中配置 XMAX_API_KEY');
const cameraFile = env.STUDIO_TEST_CAMERA_FILE ? resolve(env.STUDIO_TEST_CAMERA_FILE) : resolve('tests/camera.y4m');
if (!(await stat(cameraFile).catch(() => undefined))) {
  if (real) throw new Error('真实验证请用 STUDIO_TEST_CAMERA_FILE 提供人物 Y4M 视频；普通 UI 检查会自动生成合成摄像头输入');
  await command(env.FFMPEG_PATH || 'ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-t', '3', '-pix_fmt', 'yuv420p', cameraFile]);
}
const port = real ? 5197 : 5196, base = `http://127.0.0.1:${port}`;
const outputDir = real ? '.local/live-output' : '.local/ui-output';
await mkdir('.local', { recursive: true });
// 模拟离线任务服务：第一次查询处于 processing，之后 completed 并返回一段合成视频。
let offlinePosts = 0, offlinePolls = 0;
const fakeResult = resolve('.local/fake-offline-result.mp4');
if (!real) await command(env.FFMPEG_PATH || 'ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', fakeResult]);
const fake = http.createServer((req, res) => {
  const json = data => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true, code: 200, data })); };
  if (req.method === 'POST' && req.url.endsWith('/offline-task')) { offlinePosts++; req.resume(); return json({ uid: 'task-' + offlinePosts, status: 'submitted' }); }
  if (req.method === 'GET' && req.url.includes('/offline-task/')) { offlinePolls++; return json({ uid: req.url.split('/').pop(), status: offlinePolls % 2 ? 'processing' : 'completed', result: offlinePolls % 2 ? undefined : { result_url: 'http://127.0.0.1:5198/result.mp4' } }); }
  if (req.url === '/result.mp4') { res.writeHead(200, { 'Content-Type': 'video/mp4' }); return createReadStream(fakeResult).pipe(res); }
  res.writeHead(404); res.end();
});
if (!real) await new Promise(done => fake.listen(5198, '127.0.0.1', done));
const server = spawn(process.execPath, ['server.mjs'], { windowsHide: true, env: { ...process.env, ...(real ? {} : { XMAX_PROXY_URL: '', XMAX_OFFLINE_API_BASE_URL: 'http://127.0.0.1:5198/open/api/v1', XMAX_OFFLINE_POLL_MS: '300' }), XMAX_API_KEY: real ? env.XMAX_API_KEY : 'uk-ui-test-only', STUDIO_TEST: '1', STUDIO_OUTPUT_DIR: outputDir, CAMERA_STUDIO_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverError = ''; server.stderr.on('data', data => { serverError += data; });
let browser;
const pause = ms => new Promise(r => setTimeout(r, ms));
try {
  let ready = false;
  for (let i = 0; i < 60; i++) { if (server.exitCode !== null) throw new Error(serverError); try { if ((await fetch(`${base}/api/status`)).ok) { ready = true; break; } } catch {} await pause(250); }
  assert.ok(ready, 'test server ready');
  browser = await chromium.launch({ executablePath: env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : chromium.executablePath()), headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${cameraFile}`, '--autoplay-policy=no-user-gesture-required'],
    ...(real && env.XMAX_PROXY_URL ? { proxy: { server: env.XMAX_PROXY_URL, bypass: '127.0.0.1,localhost' } } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let starts = 0, finishes = 0, delay = 0;
  if (!real) {
    const sdk = await readFile('tests/sdk-mock.js', 'utf8');
    await page.route('**/node_modules/.vite/deps/@xmaxai_web-sdk.js*', route => route.fulfill({ contentType: 'text/javascript', body: sdk }));
    await page.route('**/api/start', async route => { starts++; if (delay) await pause(delay); await route.fulfill({ json: { lease: `mock-${starts}`, temporaryApiKey: 'tk-mock-only', environment: 'china', sessionSeconds: 15 } }); });
    await page.route('**/api/finish', route => { finishes++; return route.fulfill({ json: { revoked: true } }); });
  }
  await page.goto(base); await page.waitForFunction(() => document.querySelectorAll('.material-card').length === 12);
  assert.equal(await page.locator('.material-dock').evaluate(e => getComputedStyle(e).position), 'fixed');
  assert.equal(await page.locator('#record').isDisabled(), true);
  await page.locator('[data-id="hat"] .material-preview').click(); assert.equal(await page.locator('#preview-dialog').isVisible(), true);
  await page.locator('#preview-close').click(); assert.equal(starts, 0);
  await page.locator('#camera').click(); await page.waitForFunction(() => !document.querySelector('#record').disabled);
  await page.locator('#duration').fill('3'); await page.locator('#duration').dispatchEvent('input');
  await page.locator('#record').click(); await page.waitForFunction(() => document.querySelector('#input-badge').textContent === '已录制 3 秒', undefined, { timeout: 20000 });
  assert.equal(starts, 0, 'camera capture never starts a model session');
  const sourceUrl = await page.locator('#input-download').getAttribute('href');
  const currentClipId = sourceUrl.split('/')[2];
  const sourceProbe = JSON.parse(await readFile(resolve(outputDir, currentClipId, 'input-probe.json'), 'utf8'));
  assert.ok(Number(sourceProbe.format.duration) <= 3.1, 'saved input respects requested 3-second bound');
  const range = await fetch(base + sourceUrl, { headers: { Range: 'bytes=0-99' } }); assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 100);
  await page.locator('[data-id="hat"] .material-use').click();
  await page.waitForFunction(id => document.querySelector('#output-badge').textContent === '已保存' && document.querySelector('#output-download').getAttribute('href')?.startsWith(`/media/${id}/runs/`), currentClipId, { timeout: real ? 540000 : 30000 });
  const output = await page.locator('#output-download').getAttribute('href'); assert.ok(output.includes('/runs/')); assert.notEqual(output, sourceUrl);
  await page.waitForFunction(() => document.querySelector('#output-video').readyState >= 2);
  assert.ok(await page.locator('#output-video').evaluate(video => video.videoWidth > 0));
  await page.screenshot({ path: '.local/studio-desktop.png', fullPage: true });
  const history = await (await fetch(`${base}/api/history`)).json(); const latest = history.runs.find(r => r.videoUrl === output);
  assert.equal(latest.status, 'saved'); assert.equal(latest.presetId, 'hat'); assert.ok((await stat(resolve(latest.directory, latest.video))).size > 1000);
  if (!real) {
    // The same persisted source can be edited again without recapturing.
    await page.locator('[data-id="top"] .material-use').click();
    await page.waitForFunction(() => document.querySelector('#output-badge').textContent === '已保存' && document.querySelector('#output-info').textContent.includes('单品'), undefined, { timeout: 30000 });
    assert.equal(await page.locator('#input-download').getAttribute('href'), sourceUrl);
    await page.reload(); await page.waitForFunction(() => document.querySelectorAll('.history-item').length >= 2);
    assert.equal(await page.locator('#input-download').getAttribute('href'), sourceUrl);
    await page.locator('.history-item').last().click(); assert.ok(await page.locator('#output-download').getAttribute('href'));
    // Cancel while key issuance is pending; the late lease must be released.
    delay = 1500; await page.locator('[data-id="face"] .material-use').click();
    await page.waitForFunction(() => !document.querySelector('#cancel').disabled); await page.locator('#cancel').click(); await pause(2300);
    assert.equal(starts, 3); assert.equal(finishes, 3); assert.equal(offlinePosts, 2, 'cancelled run never submits a paid task');
    // Verify the upper capture limit and device shutdown.
    await page.locator('#camera').click(); await page.waitForFunction(() => !document.querySelector('#record').disabled);
    await page.locator('#duration').fill('10'); await page.locator('#duration').dispatchEvent('input'); await page.locator('#record').click();
    await page.waitForFunction(() => document.querySelector('#input-badge').textContent === '已录制 10 秒', undefined, { timeout: 25000 });
    const tenId = (await page.locator('#input-download').getAttribute('href')).split('/')[2];
    const tenProbe = JSON.parse(await readFile(resolve(outputDir, tenId, 'input-probe.json'), 'utf8')); assert.ok(Number(tenProbe.format.duration) <= 10.1);
    await page.locator('#close-camera').click(); assert.equal(await page.locator('#record').isDisabled(), true);
    await page.setViewportSize({ width: 390, height: 844 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= 390);
    await page.screenshot({ path: '.local/studio-mobile.png', fullPage: true });
  }
  assert.deepEqual(errors, []);
  const report = { mode: real ? 'real' : 'mock', verifiedAt: new Date().toISOString(), sourceUrl, output, latest, starts, finishes, errors };
  await writeFile(`.local/${real ? 'live' : 'ui'}-verification.json`, JSON.stringify(report, null, 2));
  console.log(`PASS ${real ? 'real X2.1' : 'mock'}: camera capture, preset click, on-disk input/output, playable replay${real ? '' : ', repeated edits, persistence, late-key cancellation, 3/10-second bounds, mobile layout'}.`);
} finally { await browser?.close(); server.kill(); fake.close(); }
