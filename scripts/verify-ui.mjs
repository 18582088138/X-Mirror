import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { readFile, mkdir, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

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
  let active = false,
    starts = 0,
    finishes = 0,
    delay = 0;
  const img = `data:image/jpeg;base64,${(await readFile("public/demo/sweatshirt.jpg")).toString("base64")}`;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data;
    if (path === "/api/status")
      data = {
        configured: true,
        active,
        remaining: 5,
        outputSeconds: 3,
        sessionSeconds: 15,
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
        outputSeconds: 3,
        sessionSeconds: 15,
      };
    } else if (path === "/api/finish") {
      active = false;
      finishes++;
      data = { released: true, revoked: true };
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
  await page.goto("http://127.0.0.1:5180", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() =>
    document.querySelector("#source-name")?.textContent.includes("Studio"),
  );
  assert.equal(await page.locator("#start").isDisabled(), true);
  assert.equal(starts, 0);
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
  await page.locator("#mode-photo").click();
  await page.locator("#consent").check();
  await page.locator("#start").click();
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("正在生成试穿照片"),
  );
  await page.waitForFunction(() => !document.querySelector("#start").disabled);
  assert.equal(await page.locator("#result-photo").isVisible(), true);
  assert.equal(finishes, 1);
  assert.equal(await page.evaluate(() => globalThis.mockInput), "video");
  const photoEvent = page.waitForEvent("download");
  await page.locator("#save-photo").click();
  const photo = await photoEvent;
  await photo.saveAs(".local/verification/test-only-photo.jpg");
  assert.ok(
    (await stat(".local/verification/test-only-photo.jpg")).size > 1000,
  );
  await page.locator("#compare").click();
  assert.equal(await page.locator("#person-video").isVisible(), true);
  await page.locator("#compare").click();

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
    .setInputFiles("ref_material/materials/inputs/woman.mp4");
  await page.waitForFunction(() =>
    document
      .querySelector("#source-description")
      .textContent.includes("8.0 秒"),
  );
  assert.equal(await page.locator("#frames button").count(), 5);
  await page.locator("#frames button").nth(3).click();
  assert.equal(
    await page.locator("#frames button").nth(3).getAttribute("aria-pressed"),
    "true",
  );
  await page.locator("#coverage").selectOption("half");
  await page.locator("#source-done").click();
  await page.locator('[data-category="bottom"]').click();
  await page.locator(".wardrobe button").first().click();
  await page.locator("#start").click();
  assert.match(await page.locator("#status").textContent(), /腿部完整/);
  assert.equal(starts, 1);
  await page.getByRole("button", { name: "移除下装", exact: true }).click();
  await page.locator("#mode-video").click();
  await page.locator("#start").click();
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("正在生成动态短片"),
  );
  await page.waitForFunction(() => !document.querySelector("#start").disabled);
  assert.equal(await page.evaluate(() => globalThis.mockInput), "video");
  assert.equal(await page.locator("#save-video").isVisible(), true);
  const videoEvent = page.waitForEvent("download");
  await page.locator("#save-video").click();
  const download = await videoEvent;
  await download.saveAs(".local/verification/test-only-video.webm");
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
      ".local/verification/test-only-video.webm",
    ],
    { encoding: "utf8" },
  );
  assert.equal(probe.status, 0);
  const metadata = JSON.parse(probe.stdout);
  assert.ok(Number(metadata.streams[0].nb_read_frames) > 20);
  assert.ok(
    Number(metadata.format.duration) > 2 &&
      Number(metadata.format.duration) < 4,
  );
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
  assert.equal(finishes, 3);

  // Native camera exercise: recorded WebM, measured duration and frame extraction.
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
  );
  assert.equal(await page.locator("#frames button").count(), 5);
  await page.locator("#source-done").click();
  assert.equal(
    await page.evaluate(
      () => document.querySelector("#camera-preview").srcObject,
    ),
    null,
  );

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
  assert.equal(starts, 3);
  const report = {
    success: true,
    realApiCalls: 0,
    tested: [
      "desktop/mobile layout",
      "consent gating",
      "photo generation lifecycle",
      "playable short video download",
      "original comparison",
      "safe product import",
      "parse fallback and purchase link",
      "video duration limit",
      "five-frame selection",
      "half-body lower garment validation",
      "pending-key cancellation",
      "native camera capture and cleanup",
    ],
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
