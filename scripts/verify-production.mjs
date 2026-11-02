import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const child = spawn(process.execPath, ["server.mjs", "--production"], {
  env: {
    ...process.env,
    PORT: "5181",
    ENABLE_LOCAL_DEMO: "0",
    PUBLIC_ORIGIN: "",
  },
  stdio: "ignore",
});
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch("http://127.0.0.1:5181/api/status");
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(ready, true);
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ||
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  let starts = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.url().endsWith("/api/start")) starts++;
  });
  await page.goto("http://127.0.0.1:5181", { waitUntil: "networkidle" });
  assert.equal(await page.locator("#empty-stage").isVisible(), true);
  assert.equal(await page.locator("#start").isDisabled(), true);
  const response = await page.request.get(
    "http://127.0.0.1:5181/demo/studio.mp4",
  );
  assert.equal(response.status(), 404);
  await page.locator("#source-open").click();
  await page
    .locator("#model-file")
    .setInputFiles("ref_material/materials/references/person.png");
  await page.waitForFunction(
    () => document.querySelector("#source-name").textContent === "person.png",
  );
  await page.locator("#source-done").click();
  await page.locator('[data-category="top"]').click();
  await page.locator("#garment-file").setInputFiles("public/demo/top.jpg");
  await page.waitForFunction(() =>
    document.querySelector("#slots").textContent.includes("top"),
  );
  await page.locator("#consent").check();
  assert.equal(await page.locator("#start").isEnabled(), true);
  assert.equal(starts, 0);
  assert.deepEqual(errors, []);
  assert.ok(
    (await page.evaluate(() => document.documentElement.scrollWidth)) <= 390,
  );
  console.log(
    "PASS: production assets, uploaded model/garment, mobile layout, disabled local demos, zero paid API calls.",
  );
} finally {
  await browser?.close();
  child.kill();
}
