import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

const source = (await readFile(new URL("../src/clip-recorder.ts", import.meta.url), "utf8"))
  .replace("export class ClipRecorder", "class ClipRecorder")
  .replace('new URL("./clip-encoder.worker.ts", import.meta.url)', '"test-worker"');
const script = ts.transpile(source, { target: ts.ScriptTarget.ES2022 }) + "\nglobalThis.ClipRecorder = ClipRecorder;";

for (const setupDelay of [0, 18000]) test(`eight-second clip excludes ${setupDelay}ms setup and a late stop`, async () => {
  let now = 0, tick;
  const frames = [];
  const context = {
    Worker: class {
      postMessage(data) {
        if (data.type === "init") queueMicrotask(() => { now += setupDelay; this.onmessage({ data: { type: "ready" } }); });
        if (data.type === "frame") { frames.push(data.frame); this.onmessage({ data: { type: "ack" } }); }
        if (data.type === "finish") queueMicrotask(() => this.onmessage({ data: { type: "done", buffer: new ArrayBuffer(1) } }));
      }
      terminate() {}
    },
    VideoFrame: class { constructor(video, options) { Object.assign(this, options); } },
    performance: { now: () => now }, Blob, setTimeout, clearTimeout,
    setInterval(callback) { tick = callback; return 1; }, clearInterval() {},
  };
  vm.createContext(context); vm.runInContext(script, context);
  const recorder = new context.ClipRecorder({ videoWidth: 1920, videoHeight: 1080 }, 8, () => assert.fail("unexpected encoder error"));
  await recorder.prepare();
  assert.equal(frames.length, 0, "no recording during codec setup");
  const origin = now;
  recorder.start(origin);
  for (const time of [100, 4000, 7900, 26000]) { now = origin + time; tick(); }
  await recorder.finish(26000);
  assert.equal(frames[0].timestamp, 0);
  assert.equal(frames.at(-1).timestamp + frames.at(-1).duration, 8_000_000);
  assert.equal(frames.at(-1).duration, 0, "endpoint adds no extra recorded time");
  assert.ok(frames.every((frame, i) => frame.timestamp + frame.duration <= 8_000_000 && (!i || frame.timestamp > frames[i - 1].timestamp)));
});
