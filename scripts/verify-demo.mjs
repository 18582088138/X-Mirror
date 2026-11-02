import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const origin = "http://127.0.0.1:5182";
const child = spawn(process.execPath, ["server.mjs", "--production"], {
  env: {
    ...process.env,
    PORT: "5182",
    ENABLE_LOCAL_DEMO: "1",
    PUBLIC_ORIGIN: "",
    XMAX_PROXY_URL: "",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
  },
  stdio: "ignore",
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${origin}/api/status`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(ready, true);
  const { items } = await (await fetch(`${origin}/api/catalog`)).json();
  assert.ok(items.length > 0);
  for (const item of items) {
    const response = await fetch(`${origin}${item.image}`);
    assert.equal(response.status, 200, item.image);
    assert.match(response.headers.get("content-type") || "", /^image\//, item.image);
    assert.ok((await response.arrayBuffer()).byteLength > 0, item.image);
  }
  for (const name of ["studio", "woman", "man"]) {
    const response = await fetch(`${origin}/demo/${name}.mp4`);
    assert.equal(response.status, 200, name);
    assert.match(response.headers.get("content-type") || "", /^video\/mp4/, name);
    assert.ok((await response.arrayBuffer()).byteLength > 0, name);
  }
  console.log(`PASS: ${items.length} catalog images and 3 model videos are available in production; zero paid API calls.`);
} finally {
  child.kill();
}
