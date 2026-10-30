import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isPublicIPv4,
  validateURL,
  createProducts,
} from "../server/products.mjs";
test("reject loopback, private, mapped IPv6, non-HTTP, credentials and alternate ports", async () => {
  for (const url of [
    "http://localhost/x",
    "http://127.1/x",
    "http://2130706433",
    "http://10.0.0.1",
    "http://192.168.0.1",
    "http://169.254.169.254",
    "http://[::ffff:127.0.0.1]",
    "file:///etc/hosts",
    "http://user:pass@example.com",
    "https://example.com:444",
  ])
    await assert.rejects(validateURL(url));
  for (const ip of [
    "100.64.1.1",
    "172.31.1.1",
    "198.19.0.1",
    "224.0.0.1",
    "0.0.0.0",
  ])
    assert.equal(isPublicIPv4(ip), false);
});
test("reject hostname resolving to private or mixed public/private addresses", async () => {
  await assert.rejects(
    validateURL("https://shop.example/item", async () => [
      { address: "127.0.0.1", family: 4 },
    ]),
  );
  await assert.rejects(
    validateURL("https://shop.example/item", async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]),
  );
});
test("a public IPv4 address is pinned for subsequent connection", async () => {
  const result = await validateURL("https://shop.example/item", async () => [
    { address: "8.8.8.8", family: 4 },
  ]);
  assert.equal(result.address, "8.8.8.8");
  assert.equal(result.url.pathname, "/item");
});
test("parse public HTML metadata and fetch its image through validated URLs", async () => {
  const visited = [];
  const products = createProducts({
    resolve: async () => [{ address: "8.8.8.8", family: 4 }],
    proxyRequest: async (url) => {
      visited.push(String(url));
      return String(url).endsWith("/shirt.jpg")
        ? new Response(Buffer.from("image-fixture"), {
            headers: { "Content-Type": "image/jpeg" },
          })
        : new Response(
            '<html><meta property="og:title" content="Cotton &amp; Linen"><meta property="og:image" content="/shirt.jpg"></html>',
            { headers: { "Content-Type": "text/html" } },
          );
    },
  });
  const result = await products.resolve("https://www.uniqlo.com/test-product");
  assert.equal(result.title, "Cotton & Linen");
  assert.match(result.dataUrl, /^data:image\/jpeg;base64,/);
  assert.deepEqual(visited, [
    "https://www.uniqlo.com/test-product",
    "https://www.uniqlo.com/shirt.jpg",
  ]);
});
test("redirects cannot route a public product request into the internal network", async () => {
  let requests = 0;
  const products = createProducts({
    resolve: async () => [{ address: "8.8.8.8", family: 4 }],
    proxyRequest: async () => {
      requests++;
      return new Response(null, {
        status: 302,
        headers: { Location: "http://169.254.169.254/metadata" },
      });
    },
  });
  await assert.rejects(
    products.resolve("https://www.uniqlo.com/test-product"),
    /内网/,
  );
  assert.equal(requests, 1);
});
