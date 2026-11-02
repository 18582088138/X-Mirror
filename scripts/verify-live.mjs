import { chromium } from "@playwright/test";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { loadEnv } from "vite";
import assert from "node:assert/strict";
if (!process.argv.includes("--real-api"))
  throw new Error("真实 API 验证会产生费用，请运行 npm run test:live");
const env = { ...loadEnv("development", process.cwd(), ""), ...process.env };
const cases = (
  process.argv.find((arg) => arg.startsWith("--cases="))?.split("=")[1] || "top"
).split(",");
if (
  cases.some(
    (name) => !["top", "bottom", "hat", "combo", "video", "image"].includes(name),
  )
)
  throw new Error("未知验证类别");
await mkdir(".local/verification/live", { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"],
  ...(env.XMAX_PROXY_URL
    ? { proxy: { server: env.XMAX_PROXY_URL, bypass: "127.0.0.1,localhost" } }
    : {}),
});
const report = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  const connections = [];
  const metrics = [];
  await page.exposeFunction("recordMetrics", (detail) => metrics.push(detail));
  await page.addInitScript(() => {
    window.addEventListener("xmirror:metrics", (e) => window.recordMetrics(e.detail));
    window.addEventListener("xmirror:first-frame", (e) => window.recordMetrics(e.detail));
  });
  await page.exposeFunction("recordConnection", (event) =>
    connections.push(event),
  );
  await page.addInitScript(() =>
    window.addEventListener("xmirror:connection", (event) =>
      window.recordConnection(event.detail),
    ),
  );
  const errors = [];
  page.on("pageerror", () => errors.push("browser runtime error"));
  await page.goto("http://127.0.0.1:5180", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() =>
    document.querySelector("#source-name")?.textContent.includes("Studio"),
  );
  await page.locator("#consent").check();
  for (const name of cases) {
    for (const category of ["上衣", "下装", "配饰"]) {
      const remove = page.getByRole("button", {
        name: `移除${category}`,
        exact: true,
      });
      if (await remove.count()) await remove.click();
    }
    if (name === "hat" || name === "video") {
      await page.locator("#source-open").click();
      await page.locator('[data-model="woman"]').click();
      await page.waitForFunction(() =>
        document
          .querySelector("#source-name")
          .textContent.includes("半身参考视频"),
      );
      await page.locator("#source-done").click();
    } else {
      await page.locator("#source-open").click();
      await page.locator('[data-model="studio"]').click();
      await page.waitForFunction(() =>
        document.querySelector("#source-name").textContent.includes("Studio"),
      );
      await page.locator("#source-done").click();
    }
    if (name === "image") {
      await page.locator("#source-open").click();
      await page.locator("#model-file").setInputFiles("ref_material/materials/references/person.png");
      await page.waitForFunction(() => document.querySelector("#source-description").textContent.includes("照片"));
      await page.locator("#source-done").click();
    }
    if (["top", "combo", "video", "image"].includes(name)) {
      await page.locator('[data-category="top"]').click();
      await page
        .getByRole("button", { name: "试穿条纹短款外套", exact: true })
        .click();
    }
    if (["bottom", "combo"].includes(name)) {
      await page.locator('[data-category="bottom"]').click();
      await page
        .getByRole("button", { name: "试穿直筒阔腿牛仔裤", exact: true })
        .click();
    }
    if (name === "hat" || name === "combo") {
      await page.locator('[data-category="accessory"]').click();
      await page
        .getByRole("button", { name: "试穿白色棒球帽", exact: true })
        .click();
    }
    await page.locator("#start").waitFor({ state: "visible" });
    assert.equal(
      await page.locator("#start").isEnabled(),
      true,
      "API 未就绪或额度不足",
    );
    const states = [];
    let previous = "";
    await page.locator("#start").click();
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(1000);
      const state = await page.locator("#status").textContent();
      if (state !== previous) {
        previous = state;
        states.push(state);
        console.log(`${name}: ${state}`);
      }
      if (
        (await page.locator("#stop").isHidden()) &&
        !state?.includes("正在结束")
      )
        break;
    }
    await page.waitForFunction(
      () => !document.querySelector("#input-controls").disabled,
      null,
      { timeout: 20000 },
    );
    const success = await page.locator("#result-actions").isVisible();
    const record = {
      case: name,
      at: new Date().toISOString(),
      success,
      states,
      connections: [...connections],
      metrics: [...metrics],
      outputFile: undefined,
      bytes: 0,
    };
    if (success) {
      const event = page.waitForEvent("download");
      await page.locator(name === "image" ? "#save-photo" : "#save-video").click();
      const file = await event;
      const path = `.local/verification/live/${name}.${file.suggestedFilename().split(".").at(-1)}`;
      await file.saveAs(path);
      record.outputFile = path;
      record.bytes = (await stat(path)).size;
      await page.screenshot({
        path: `.local/verification/live/${name}-page.png`,
        fullPage: true,
      });
    }
    report.push(record);
    await writeFile(
      ".local/verification/live/report.json",
      JSON.stringify({ cases: report, runtimeErrors: errors }, null, 2),
    );
    if (!success) break; // Never automatically repeat a failed paid call.
  }
  console.log(
    JSON.stringify({ cases: report, runtimeErrors: errors }, null, 2),
  );
  if (report.some((item) => !item.success) || errors.length)
    process.exitCode = 1;
} finally {
  await browser.close();
}
