import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { readFile, mkdir, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { inspectPlayback } from './playback-check.mjs';
import { readFileSync } from 'node:fs';
const skipCamera = process.argv.includes('--skip-camera');

await mkdir(".local/verification", { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const mock = await readFile("tests/fixtures/sdk-mock.js", "utf8");
  await page.route("**/node_modules/.vite/deps/@xmaxai_web-sdk.js*", (route) =>
    route.fulfill({ contentType: "text/javascript", body: mock }),
  );
  // 视频试穿走离线任务：用 ffmpeg 生成与原片等长的 24fps 假结果。
  const fakeResult = (seconds) => {
    const file = `.local/verification/fake-offline-${seconds}.mp4`;
    const made = spawnSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=24`, "-t", String(seconds), "-pix_fmt", "yuv420p", "-c:v", "libx264", file]);
    assert.equal(made.status, 0);
    return readFileSync(file);
  };
  let offlineSeconds = 1.6, offlineMode = "ok", offlinePosts = [];
  let active = false,
    starts = 0,
    finishes = 0,
    delay = 0,
    finishDelay = 0,
    sessionSeconds = 40;
  const img = `data:image/jpeg;base64,${(await readFile("public/demo/sweatshirt.jpg")).toString("base64")}`;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data;
    if (path === "/api/status")
      data = {
        configured: true,
        active,
        remaining: null,
        outputSeconds: 3,
        sessionSeconds,
        demoEnabled: true,
      };
    else if (path === "/api/catalog") {
      const response = await route.fetch();
      data = await response.json();
    } else if (path === "/api/start") {
      active = true;
      starts++;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      data = {
        lease: `test-${starts}`,
        temporaryApiKey: "tk-test-only",
        environment: "china",
        outputSeconds: route.request().postDataJSON().sourceSeconds,
        sessionSeconds,
      };
    } else if (path === "/api/finish") {
      if (finishDelay) await new Promise((resolve) => setTimeout(resolve, finishDelay));
      active = false;
      finishes++;
      data = { released: true, revoked: true };
    } else if (path === "/api/video/normalize") {
      return route.fulfill({ status: 501, json: { error: "未安装 FFmpeg" } });
    } else if (path === "/api/offline") {
      offlinePosts.push(route.request().postDataJSON());
      data = { uid: `task-${offlinePosts.length}`, status: "pending" };
    } else if (path === "/api/offline/status") {
      data = offlineMode === "error" ? { status: "error", error: "测试：模型生成失败" } : { status: "completed", ready: true };
    } else if (path === "/api/offline/result") {
      return route.fulfill({ status: 200, contentType: "video/mp4", body: fakeResult(offlineSeconds) });
    } else if (path === "/api/products/resolve") {
      if (route.request().postDataJSON().url.includes("blocked"))
        return route.fulfill({ status: 400, json: { error: "页面无法解析" } });
      data = {
        title: "测试商品 <img src=x onerror=alert(1)>",
        sourceUrl: "https://shop.example/item",
        dataUrl: img,
      };
    } else throw new Error(`Unhandled test API: ${path}`);
    await route.fulfill({ json: data });
  });
  await page.goto(process.env.TEST_BASE_URL || "http://127.0.0.1:5180", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() =>
    document.querySelector("#source-name")?.textContent.includes("Studio"),
  );
  const brokenImages = await page.evaluate(async () => {
    const { items } = await (await fetch("/api/catalog")).json();
    const broken = [];
    for (const item of items) {
      try {
        const response = await fetch(item.image);
        if (!response.ok) throw new Error(String(response.status));
        const bitmap = await createImageBitmap(await response.blob());
        bitmap.close();
      } catch {
        broken.push(item.image);
      }
    }
    return broken;
  });
  assert.deepEqual(brokenImages, []);
  assert.equal(await page.locator("#start").isDisabled(), true);
  assert.equal(starts, 0);
  assert.equal(await page.locator("#quota").textContent(), "测试次数不限");
  await page.locator("#person-video").waitFor({ state: "visible" });
  await page.waitForFunction(
    () =>
      !document.querySelector("#person-video").paused &&
      document.querySelector("#person-video").readyState >= 2,
  );
  assert.equal(await page.locator("#person-preview").isHidden(), true);
  assert.equal(
    await page.locator("#mode-video").getAttribute("aria-pressed"),
    "true",
  );
  const framesBefore = await page
    .locator("#person-video")
    .evaluate((v) => v.getVideoPlaybackQuality().totalVideoFrames);
  await page.waitForTimeout(500);
  assert.ok(
    (await page
      .locator("#person-video")
      .evaluate((v) => v.getVideoPlaybackQuality().totalVideoFrames)) >
      framesBefore,
  );
  await page.screenshot({
    path: ".local/verification/desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    (await page.evaluate(() => document.documentElement.scrollWidth)) <= 390,
  );
  await page.screenshot({
    path: ".local/verification/mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  assert.equal(await page.locator("#mode-photo").isDisabled(), true);
  await page.locator("#consent").check();
  await page.locator('[data-category="top"]').click();
  await page.getByRole('button', { name: '试穿条纹短款外套', exact: true }).click();
  finishDelay = 1500;
  await page.locator("#start").click();
  await page.locator("#result-video").waitFor({ state: "visible", timeout: 30000 }).catch(async error => {
    console.log(JSON.stringify({ status: await page.locator("#status").textContent(), errors }));
    throw error;
  });
  assert.equal(await page.locator("#person-video").isHidden(), true);
  await page.waitForFunction(() => !document.querySelector("#start").disabled);
  assert.equal(offlinePosts.length, 1);
  assert.equal(offlinePosts[0].videoPath, "https://example.invalid/test-only.mp4");
  assert.equal(offlinePosts[0].referencePath, "https://example.invalid/test-only.jpg");
  assert.equal(await page.locator("#remote video").count(), 0, "video try-on does not use the realtime remote view");
  assert.equal(await page.locator("#result-video").isVisible(), true);
  const playback = await page.locator("#result-video").evaluate(async (video) => {
    const { hasVisibleFrame } = await import("/src/media.ts");
    return { ready: video.readyState, playing: !video.paused, duration: video.duration, visiblePixels: hasVisibleFrame(video) };
  });
  assert.ok(playback.ready >= 2 && playback.visiblePixels);
  assert.ok(Math.abs(playback.duration - 1.6) < 0.15);
  assert.equal(await page.locator('#result-video').evaluate(video => video.loop), false);
  const sustained = await page.locator('#result-video').evaluate(inspectPlayback);
  assert.ok(Math.abs(sustained.elapsed - 1.6) < 0.5 && sustained.lastTime > 1.3, `GUI must present the complete clip: ${JSON.stringify(sustained)}`);
  assert.equal(await page.locator("#result-photo").isVisible(), false);
  assert.equal(await page.locator("#save-photo").isHidden(), true);
  assert.ok(finishes >= 1);
  finishDelay = 0;
  const clipEvent = page.waitForEvent("download");
  await page.locator("#save-video").click();
  await (await clipEvent).saveAs(".local/verification/test-only-studio.mp4");
  const studioProbe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,r_frame_rate:format=duration", "-of", "json", ".local/verification/test-only-studio.mp4"], {encoding:"utf8"});
  const studio = JSON.parse(studioProbe.stdout);
  assert.ok(Math.abs(Number(studio.format.duration)-1.6) < 0.15);
  assert.equal(studio.streams[0].codec_name, "h264");
  assert.equal(studio.streams[0].r_frame_rate, "24/1");
  await page.locator("#compare").click();
  assert.equal(await page.locator("#person-video").isVisible(), true);
  await page.locator("#compare").click();

  const referenceSize = await page.evaluate(async () => {
    const { imageFile } = await import("/src/media.ts");
    const file = await imageFile("/demo/jeans.jpg");
    const image = await createImageBitmap(file);
    const size = [image.width, image.height]; image.close(); return size;
  });
  assert.equal(Math.max(...referenceSize), 2048);
  assert.match(await page.locator("#garment-quality").textContent(), /\d+ × \d+/);

  // Link import renders user text safely; buying is an explicit link binding.
  await page.locator("#product-url").fill("https://shop.example/item");
  await page.locator("#resolve-link").click();
  await page.waitForFunction(() =>
    document.querySelector("#link-status").textContent.includes("商品已添加"),
  );
  assert.equal(await page.locator('#slots img[src="x"]').count(), 0);
  await page.locator("#product-url").fill("https://shop.example/blocked");
  await page.locator("#resolve-link").click();
  await page.waitForFunction(() =>
    document.querySelector("#link-status").textContent.includes("链接已保留"),
  );
  await page.locator("#garment-file").setInputFiles("public/demo/top.jpg");
  await page.waitForFunction(() =>
    document.querySelector("#slots").textContent.includes("top"),
  );

  await page.locator("#source-open").click();
  await page
    .locator("#model-file")
    .setInputFiles("ref_material/model/woman.mp4");
  await page.waitForFunction(() =>
    document
      .querySelector("#source-description")
      .textContent.includes("8.0 秒"),
  );
  assert.equal(await page.locator("#frame-picker").count(), 0, 'video has no sampled image input');
  assert.equal(await page.locator('#source-thumb-video').isVisible(), true);
  await page.locator("#coverage").selectOption("half");
  await page.locator("#source-done").click();
  await page.locator('[data-category="bottom"]').click();
  await page.locator(".wardrobe button").first().click();
  await page.locator("#start").click();
  assert.match(await page.locator("#status").textContent(), /腿部完整/);
  assert.equal(starts, 1);
  await page.getByRole("button", { name: "移除下装", exact: true }).click();
  await page.locator('[data-category="accessory"]').click();
  await page.getByRole('button', { name: '试穿白色棒球帽', exact: true }).click();
  assert.match(await page.locator('#outfit-count').textContent(), /已选 2 件.*同时试穿/);

  offlineSeconds = 8;
  await page.locator("#start").click();
  await page.waitForFunction(() => !document.querySelector("#start").disabled, null, { timeout: 60000 });
  assert.equal(offlinePosts.length, 2);
  assert.match(offlinePosts[1].prompt, /同时穿戴全部已选服饰（上衣、配饰：帽子）/);
  assert.equal(await page.locator("#save-video").isVisible(), true, await page.locator('#status').textContent());
  const videoEvent = page.waitForEvent("download");
  await page.locator("#save-video").click();
  const download = await videoEvent;
  await download.saveAs(".local/verification/test-only-video.mp4");
  const probe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-count_frames",
      "-show_entries",
      "stream=nb_read_frames:format=duration",
      "-of",
      "json",
      ".local/verification/test-only-video.mp4",
    ],
    { encoding: "utf8" },
  );
  assert.equal(probe.status, 0);
  const metadata = JSON.parse(probe.stdout);
  assert.ok(Number(metadata.streams[0].nb_read_frames) > 20);
  assert.ok(
    Math.abs(Number(metadata.format.duration) - 8) < 0.15,
  );
  const timeline = spawnSync("ffprobe", ["-v", "error", "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", ".local/verification/test-only-video.mp4"], {encoding:"utf8"});
  const frameTimes = JSON.parse(timeline.stdout).frames.map((f) => Number(f.best_effort_timestamp_time));
  assert.ok(Math.max(...frameTimes) > 7.7 && Math.max(...frameTimes) < 8.15, "encoded frames must span the real eight-second timeline");
  assert.ok(frameTimes.slice(1).every((t, i) => Math.abs(t - frameTimes[i] - 1 / 24) < 0.005), "result is constant 24fps with no dropped frames");
  assert.ok(frameTimes.every((t,i) => i === 0 || t >= frameTimes[i-1]));
  const fullPlayback = await page.locator('#result-video').evaluate(inspectPlayback);
  assert.ok(Math.abs(fullPlayback.elapsed - 8) < 1 && fullPlayback.lastTime > 7.7, 'GUI must play through all eight seconds');
  assert.equal(await page.locator("#shopping").isVisible(), true);
  assert.equal(
    await page.locator("#shopping-items a").getAttribute("href"),
    "https://shop.example/blocked",
  );

  delay = 1200;
  await page.locator("#start").click();
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("正在创建"),
  );
  await page.locator("#stop").click();
  await page.waitForFunction(() => !document.querySelector("#start").disabled);
  assert.equal(active, false);
  assert.ok(finishes >= 3);

  // Image input must yield only an image, even though the provider uses a live transport.
  await page.locator("#source-open").click();
  await page.locator("#model-file").setInputFiles("ref_material/materials/references/person.png");
  await page.waitForFunction(() => document.querySelector("#source-description").textContent.includes("照片"));
  await page.locator("#source-done").click();
  await page.locator("#start").click();
  await page.waitForFunction(() => !document.querySelector("#start").disabled);
  assert.equal(await page.locator("#result-photo").isVisible(), true);
  assert.equal(await page.locator("#save-video").isHidden(), true);
  assert.equal(await page.evaluate(() => globalThis.mockInput), 'photo');
  assert.equal(await page.evaluate(() => globalThis.mockImageFile.name), 'person.png', 'SDK must receive the original photo File');
  const photoEvent = page.waitForEvent("download");
  await page.locator("#save-photo").click();
  await (await photoEvent).saveAs(".local/verification/test-only-photo.jpg");
  assert.ok((await stat(".local/verification/test-only-photo.jpg")).size > 1000);

  // Native camera exercise: recorded WebM, measured duration, no image extraction.
  if (!skipCamera) {
  await page.locator("#source-open").click();
  await page.locator("#record-source").click();
  await page.locator("#camera-panel").waitFor({ state: "visible" });
  await page.locator("#record-toggle").click();
  await page.waitForTimeout(1600);
  await page.locator("#record-toggle").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#source-name").textContent.includes("我的录制"),
    null,
    { timeout: 15000 },
  ).catch(async error => {
    console.log(JSON.stringify({ cameraSource: await page.locator('#source-status').textContent(), status: await page.locator('#status').textContent(), errors }));
    throw error;
  });
  assert.equal(await page.locator("#frame-picker").count(), 0);
  await page.locator("#source-done").click();
  await page.waitForFunction(() => document.querySelector("#camera-preview").srcObject === null);
  assert.equal(
    await page.evaluate(
      () => document.querySelector("#camera-preview").srcObject,
    ),
    null,
  );
  } else {
    // Some headless environments cannot start the fake-camera recorder.
    // Continue video regressions with a real local file and report the skipped check.
    await page.locator('#source-open').click();
    await page.locator('#model-file').setInputFiles('public/demo/man.mp4');
    await page.waitForFunction(() => document.querySelector('#source-name').textContent === 'man.mp4');
    await page.locator('#source-done').click();
  }

  // Offline failure must not produce a result or fall back to an image.
  offlineMode = "error";
  await page.locator("#start").click();
  await page.waitForFunction(() => !document.querySelector("#start").disabled);
  assert.match(await page.locator("#status").textContent(), /生成失败：测试：模型生成失败/);
  assert.equal(await page.locator("#result-actions").isHidden(), true);
  assert.equal(await page.locator("#result-photo").isHidden(), true);
  assert.equal(await page.locator("#person-video").isVisible(), true);
  offlineMode = "ok";

  // Player rejection must remain a failure after end() updates status.
  offlineSeconds = 1.6;
  await page.evaluate(() => {
    globalThis.originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      return this.id === "result-video" ? Promise.reject(new Error("test playback rejection")) : globalThis.originalPlay.call(this);
    };
  });
  await page.locator("#start").click();
  await page.waitForFunction(() => !document.querySelector("#start").disabled);
  assert.match(await page.locator("#status").textContent(), /无法播放/);
  assert.equal(await page.locator("#stage-label").textContent(), "短片播放失败");
  assert.equal(await page.locator("#result-photo").isVisible(), true);
  await page.evaluate(() => { HTMLMediaElement.prototype.play = globalThis.originalPlay; });

  const long = ".local/verification/too-long.mp4";
  const made = spawnSync("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=black:s=160x240:r=10:d=11",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    long,
  ]);
  assert.equal(made.status, 0);
  await page.locator("#source-open").click();
  await page.locator("#model-file").setInputFiles(long);
  await page.waitForFunction(() =>
    document
      .querySelector("#source-status")
      .textContent.includes("最长支持 10 秒"),
  );
  await page.locator("#source-done").click();
  assert.deepEqual(errors, []);
  assert.equal(starts, 6);
  const report = {
    success: true,
    realApiCalls: 0,
    tested: [
      "desktop/mobile layout",
      "consent gating",
      "photo generation lifecycle",
      "playable short video download",
      "1.6s and 8s input/output duration match",
      "image input produces image only",
      "results visible before delayed revocation",
      "offline video try-on result is 24fps h264 mp4 matching source duration",
      "offline generation failure shows an error and no result",
      "encoded frame timestamps span 8 seconds, monotonic and constant fps",
      "2048px garment reference and dimension hints",
      "original comparison",
      "safe product import",
      "parse fallback and purchase link",
      "video duration limit",
      "original video previews without image extraction",
      "half-body lower garment validation",
      "pending-key cancellation",
      ...(!skipCamera ? ["native camera capture and cleanup"] : []),
    ],
    skipped: skipCamera ? ['native camera capture: headless fake recorder unavailable'] : [],
    pageErrors: errors,
  };
  await writeFile(
    ".local/verification/ui-report.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
