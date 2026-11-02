import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { createNetworkRequest } from "../server/network.mjs";

async function listen(t, handler, tunnel) {
  const server = http.createServer(handler);
  if (tunnel) server.on("connect", tunnel);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

function tunnel(req, client, head) {
  const [hostname, port] = req.url.split(":");
  const upstream = net.connect(Number(port), hostname, () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
}

test("backend requests support dedicated and standard proxies plus NO_PROXY", async (t) => {
  let dedicatedHits = 0;
  let standardHits = 0;
  const dedicated = await listen(t, undefined, (req, client, head) => {
    dedicatedHits++;
    tunnel(req, client, head);
  });
  const standard = await listen(t, undefined, (req, client, head) => {
    standardHits++;
    tunnel(req, client, head);
  });
  const target = await listen(t, (_req, res) => res.end("target"));

  const explicit = createNetworkRequest({
    XMAX_PROXY_URL: dedicated,
    HTTP_PROXY: standard,
  });
  t.after(() => explicit.close());
  assert.equal(
    await (await explicit.request(`${target}/resource`)).text(),
    "target",
  );
  assert.equal(dedicatedHits, 1);
  assert.equal(standardHits, 0);

  const fallback = createNetworkRequest({ HTTP_PROXY: standard });
  t.after(() => fallback.close());
  assert.equal(
    await (await fallback.request(`${target}/resource`)).text(),
    "target",
  );
  assert.equal(standardHits, 1);

  const bypass = createNetworkRequest({
    HTTP_PROXY: standard,
    NO_PROXY: "127.0.0.1",
  });
  t.after(() => bypass.close());
  assert.equal(await (await bypass.request(target)).text(), "target");
  assert.equal(standardHits, 1);
});
