import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApi, settings } from "../server/api.mjs";

function setup(t, extra = {}, handler) {
  const folder = mkdtempSync(join(tmpdir(), "xmirror-test-"));
  const calls = [];
  const options = {
    env: { XMAX_API_KEY: "test-permanent-only", ...extra },
    ledgerPath: join(folder, "ledger.json"),
    request: async (url, init) => {
      calls.push({
        method: init.method,
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      if (handler) await handler(url, init);
      return new Response(
        JSON.stringify({
          success: true,
          data:
            init.method === "POST" ? { temporaryApiKey: "tk-test-only" } : {},
        }),
        { status: 200 },
      );
    },
  };
  const api = createApi(options);
  t.after(async () => {
    await api.close();
    rmSync(folder, { recursive: true, force: true });
  });
  return { api, calls, options };
}
test("configuration caps input env to bounded generation and temporary allowance", () => {
  const cfg = settings({
    XMAX_OUTPUT_SECONDS: "20",
    XMAX_SESSION_SECONDS: "120",
    XMAX_POINTS_PER_CASE: "500",
    XMAX_KEY_EXPIRE_SECONDS: "120",
  });
  assert.equal(cfg.outputSeconds, 8);
  assert.equal(cfg.sessionSeconds, 60);
  assert.equal(cfg.points, 100);
  assert.equal(cfg.expiry, 90);
  assert.throws(() =>
    settings({ XMAX_API_BASE_URL: "https://untrusted.example/api" }),
  );
});
test("no paid calls on status; issue once; isolate owner; revoke and prevent duplicate", async (t) => {
  const { api, calls, options } = setup(t);
  const id = randomUUID();
  assert.equal(api.status("visitor").configured, true);
  assert.equal(calls.length, 0);
  const ticket = await api.start("visitor", id);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, {
    expireSeconds: 90,
    pointsLimit: 100,
    temporaryApiKeySessionLimit: 1,
  });
  await assert.rejects(api.start("visitor", randomUUID()), /正在使用/);
  await assert.rejects(api.finish("another-visitor", ticket.lease), /无法操作/);
  assert.equal((await api.finish("visitor", ticket.lease)).revoked, true);
  assert.equal(api.status("visitor").active, false);
  await api.finish("visitor", ticket.lease);
  assert.equal(calls.length, 2);
  await assert.rejects(api.start("visitor", id), /重复/);
  const journal = readFileSync(options.ledgerPath, "utf8");
  assert.ok(!journal.includes("tk-test-only"));
  assert.ok(!journal.includes("test-permanent-only"));
});
test("reserved budget persists across restart and failed calls count conservatively", async (t) => {
  const { api, options } = setup(t, { XMAX_DAILY_POINTS_LIMIT: "100" });
  const ticket = await api.start("visitor", randomUUID());
  await api.finish("visitor", ticket.lease);
  const restarted = createApi(options);
  assert.equal(restarted.status("other").remaining, 0);
  await assert.rejects(restarted.start("other", randomUUID()), /额度/);
});
test("late key after cancellation is revoked before the slot is freed", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { api, options, calls } = setup(t, {}, async (_url, init) => {
    if (init.method === "POST") await gate;
  });
  const start = api.start("visitor", randomUUID());
  const lease = JSON.parse(readFileSync(options.ledgerPath, "utf8"))[0].id;
  const finish = api.finish("visitor", lease);
  assert.equal(api.status("visitor").active, true);
  release();
  await assert.rejects(start, /取消/);
  assert.equal((await finish).revoked, true);
  assert.equal(calls.filter((c) => c.method === "PUT").length, 1);
  assert.equal(api.status("visitor").active, false);
});
test("network failure does not expose upstream errors or refund uncertain attempts", async (t) => {
  const { api } = setup(t, { XMAX_DAILY_POINTS_LIMIT: "100" }, () => {
    throw new Error("network offline");
  });
  await assert.rejects(api.start("visitor", randomUUID()), /连接/);
  assert.equal(api.status("visitor").remaining, 0);
  assert.equal(api.status("visitor").active, false);
});
test("daily allowances reset at midnight in Asia/Shanghai", async (t) => {
  let clock = new Date("2026-10-30T15:59:00Z");
  const { options } = setup(t, { XMAX_DAILY_POINTS_LIMIT: "100" });
  const api = createApi({ ...options, now: () => clock });
  const ticket = await api.start("visitor", randomUUID());
  await api.finish("visitor", ticket.lease);
  assert.equal(api.status("visitor").remaining, 0);
  clock = new Date("2026-10-30T16:01:00Z");
  assert.equal(api.status("visitor").remaining, 1);
});
