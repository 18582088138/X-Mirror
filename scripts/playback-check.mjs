// Measure continuous playback of a saved result in the actual result player.
import { chromium } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

export async function inspectPlayback(video) {
  video.loop = false;
  video.pause();
  if (video.currentTime !== 0) {
    const seeked = new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }));
    video.currentTime = 0;
    await seeked;
  }
  const samples = [], events = [];
  const canvas = document.createElement('canvas');
  canvas.width = 32; canvas.height = 32;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let previous, changes = 0, maxGapMs = 0, lastAt, callback;
  const tick = (at, frame) => {
    if (lastAt !== undefined) maxGapMs = Math.max(maxGapMs, at - lastAt);
    lastAt = at;
    ctx.drawImage(video, 0, 0, 32, 32);
    const pixels = ctx.getImageData(0, 0, 32, 32).data;
    if (previous) {
      let difference = 0;
      for (let i = 0; i < pixels.length; i += 4) difference += Math.abs(pixels[i] - previous[i]);
      if (difference / 1024 > 0.5) changes++;
    }
    previous = pixels;
    samples.push({ time: frame.mediaTime, at });
    callback = video.requestVideoFrameCallback(tick);
  };
  const listeners = ['waiting', 'stalled', 'error'].map(name => {
    const listener = () => events.push({ event: name, time: video.currentTime });
    video.addEventListener(name, listener);
    return [name, listener];
  });
  callback = video.requestVideoFrameCallback(tick);
  const qualityAtStart = video.getVideoPlaybackQuality();
  const started = performance.now();
  await video.play();
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('playback failed to reach end')), (video.duration + 5) * 1000);
    video.addEventListener('ended', () => { clearTimeout(timeout); resolve(); }, { once: true });
  });
  video.cancelVideoFrameCallback(callback);
  listeners.forEach(([name, listener]) => video.removeEventListener(name, listener));
  const quality = video.getVideoPlaybackQuality();
  return {
    width: video.videoWidth, height: video.videoHeight, duration: video.duration,
    elapsed: (performance.now() - started) / 1000, reached: video.currentTime,
    frames: samples.length, changes, maxGapMs,
    droppedFrames: quality.droppedVideoFrames - qualityAtStart.droppedVideoFrames, totalFrames: quality.totalVideoFrames - qualityAtStart.totalVideoFrames,
    firstTime: samples[0]?.time, lastTime: samples.at(-1)?.time, events,
  };
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/playback-check.mjs')) {
  const path = process.argv[2] || '.local/verification/live/man.webm';
  const content = (await readFile(path)).toString('base64');
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.route('**/api/status', route => route.fulfill({ json: { configured: true, active: false, remaining: null, sessionSeconds: 60, demoEnabled: true } }));
    await page.route('**/api/start', route => route.fulfill({ json: { lease: 'offline-test', sessionSeconds: 60 } }));
    await page.route('**/api/finish', route => route.fulfill({ json: { revoked: true } }));
    await page.route('**/src/provider.ts*', route => route.fulfill({ contentType: 'text/javascript', body: `export class TryOnSession {
      constructor(container,status,ready,end) {this.end=end;}
      async start(ticket,source){ const blob=await (await fetch('data:video/webm;base64,${content}')).blob();
        const video=document.createElement('video');video.muted=true;video.src=URL.createObjectURL(blob);
        await new Promise(resolve=>video.onloadeddata=resolve);await video.play();video.pause();
        const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;
        canvas.getContext('2d').drawImage(video,0,0);const photo=canvas.toDataURL('image/jpeg');
        this.result={video:blob,photo,width:video.videoWidth,height:video.videoHeight,duration:video.duration,complete:true};this.end(this.result);}
      async stop(){return this.result;}
    }` }));
    await page.goto(process.env.TEST_BASE_URL || 'http://127.0.0.1:5182');
    await page.waitForFunction(() => document.querySelector('#source-name').textContent.includes('Studio'));
    await page.locator('#consent').check();
    await page.locator('#start').click();
    await page.locator('#result-video').waitFor({ state: 'visible' });
    const gui = await page.locator('#result-video').evaluate(inspectPlayback);
    await page.evaluate(() => {
      const gui = document.querySelector('#result-video');
      const plain = document.createElement('video');
      plain.id = 'plain-playback'; plain.src = gui.src; plain.muted = true;
      plain.style = 'position:fixed;inset:0;width:100%;height:100%;background:white;z-index:99999';
      document.body.append(plain);
    });
    await page.waitForFunction(() => document.querySelector('#plain-playback').readyState >= 2);
    const plain = await page.locator('#plain-playback').evaluate(inspectPlayback);
    assert.ok(Math.abs(gui.elapsed - gui.duration) < 1, 'GUI must play the full duration at normal speed');
    assert.ok(gui.lastTime > gui.duration - 0.2, 'GUI must present frames near the end');
    await mkdir('.local/verification', { recursive: true });
    await writeFile('.local/verification/playback.json', JSON.stringify({ path, gui, plain }, null, 2));
    console.log(JSON.stringify({ path, gui, plain }, null, 2));
  } finally { await browser.close(); }
}
