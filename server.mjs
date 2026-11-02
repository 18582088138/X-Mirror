import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import { resolve, extname, sep } from "node:path";
import { createServer, loadEnv } from "vite";
import { ProxyAgent, fetch as proxyFetch } from "undici";
import { ApiError, createApi } from "./server/api.mjs";
import { createProducts } from "./server/products.mjs";

const production = process.argv.includes("--production");
const env = {
  ...loadEnv(production ? "production" : "development", process.cwd(), ""),
  ...process.env,
};
const port = Number(env.PORT || 5180);
const publicOrigin = env.PUBLIC_ORIGIN
  ? new URL(env.PUBLIC_ORIGIN).origin
  : undefined;
const demoEnabled =
  env.ENABLE_LOCAL_DEMO === "1" ||
  (!publicOrigin && !production && env.ENABLE_LOCAL_DEMO !== "0");
const proxy = env.XMAX_PROXY_URL
  ? new ProxyAgent(env.XMAX_PROXY_URL)
  : undefined;
const request = proxy
  ? (url, options) => proxyFetch(url, { ...options, dispatcher: proxy })
  : fetch;
const api = createApi({ env, request, ledgerPath: ".local/sessions.json" });
const products = createProducts({ proxyRequest: proxy ? request : undefined });
const hosts = new Set([
  `localhost:${port}`,
  `127.0.0.1:${port}`,
  ...(publicOrigin ? [new URL(publicOrigin).host] : []),
]);
if (!publicOrigin)
  for (const values of Object.values(networkInterfaces()))
    for (const net of values || [])
      if (net.family === "IPv4" && !net.internal)
        hosts.add(`${net.address}:${port}`);
const vite = production
  ? undefined
  : await createServer({
      server: {
        middlewareMode: true,
        hmr: { port: port + 10000 },
        fs: { allow: [process.cwd()] },
      },
      appType: "spa",
    });
const rates = new Map();
const demoCatalog = [
  {
    id: "sweatshirt",
    name: "学院风西装外套",
    category: "top",
    image: "/demo/sweatshirt.jpg",
    detail: "清晰参考 · 黑色",
  },
  {
    id: "shirt",
    name: "条纹短款外套",
    category: "top",
    image: "/demo/top.jpg",
    detail: "轻盈廓形 · 米白",
  },
  {
    id: "jeans",
    name: "直筒原色牛仔裤",
    category: "bottom",
    image: "/demo/jeans.jpg",
    detail: "丹宁纹理 · 深蓝",
  },
  {
    id: "skirt",
    name: "学院风百褶短裙",
    category: "bottom",
    image: "/demo/skirt.jpg",
    detail: "运动学院 · 墨黑",
  },
  {
    id: "hat",
    name: "白色棒球帽",
    category: "accessory",
    image: "/demo/hat.jpg",
    detail: "点睛配饰 · 奶白",
    accessory: "帽子",
  },
];
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  const reply = (status, body) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  };
  let path;
  try {
    path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    return reply(400, { error: "无效地址" });
  }
  if (!hosts.has(req.headers.host))
    return reply(403, { error: "此访问地址尚未配置" });
  // Vite development serves source files; explicitly keep server and reference
  // files unavailable, including encoded and /@fs variants. Permanent key never leaves Node.
  if (
    /(?:^|\/)(?:\.env[^/]*|\.git|\.local|ref_material|server|research|tests|scripts)(?:\/|$)/i.test(
      path,
    ) ||
    path === "/server.mjs"
  )
    return reply(404, { error: "不存在" });
  if (path.startsWith("/demo/") && !demoEnabled)
    return reply(404, { error: "演示素材未启用" });
  if (path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store");
    if (
      req.headers.origin &&
      req.headers.origin !== (publicOrigin || `http://${req.headers.host}`)
    )
      return reply(403, { error: "需要从本站发起请求" });
    if (req.headers["sec-fetch-site"] === "cross-site")
      return reply(403, { error: "需要从本站发起请求" });
    let owner = req.headers.cookie?.match(
      /(?:^|;\s*)xm_session=([a-f0-9]{48})(?:;|$)/,
    )?.[1];
    if (!owner) {
      owner = randomBytes(24).toString("hex");
      res.setHeader(
        "Set-Cookie",
        `xm_session=${owner}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${publicOrigin?.startsWith("https:") ? "; Secure" : ""}`,
      );
    }
    try {
      if (req.method === "GET" && path === "/api/status")
        return reply(200, { ...api.status(owner), demoEnabled });
      if (req.method === "GET" && path === "/api/catalog")
        return reply(200, { items: demoEnabled ? demoCatalog : [] });
      if (
        req.method !== "POST" ||
        !req.headers["content-type"]?.startsWith("application/json")
      )
        throw new ApiError("需要 POST JSON 请求");
      const currentRate = rates.get(owner) || { count: 0, since: Date.now() };
      if (Date.now() - currentRate.since > 60000) {
        currentRate.count = 0;
        currentRate.since = Date.now();
      }
      currentRate.count++;
      rates.set(owner, currentRate);
      if (currentRate.count > 20 && path !== "/api/finish")
        throw new ApiError("操作过于频繁，请稍后再试", 429);
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 8192) throw new ApiError("请求过大", 413);
      }
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        throw new ApiError("请求格式无效");
      }
      if (path === "/api/start")
        return reply(200, await api.start(owner, data.requestId, data.sourceSeconds));
      if (path === "/api/finish")
        return reply(200, await api.finish(owner, data.lease));
      if (path === "/api/products/resolve")
        return reply(200, await products.resolve(data.url));
      if (path === "/api/products/image")
        return reply(200, await products.image(data.url));
      return reply(404, { error: "未知接口" });
    } catch (error) {
      return reply(error instanceof ApiError ? error.status : 502, {
        error:
          error instanceof ApiError
            ? error.message
            : "网络或服务暂时不可用，请稍后手动重试",
      });
    }
  }
  if (vite) return vite.middlewares(req, res);
  try {
    if (!["GET", "HEAD"].includes(req.method))
      return reply(405, { error: "不支持此请求" });
    const root = resolve("dist");
    let file = resolve(root, `.${path}`);
    if (!file.startsWith(root + sep) && file !== root)
      return reply(404, { error: "不存在" });
    try {
      if (!(await stat(file)).isFile()) file = resolve(root, "index.html");
    } catch {
      if (extname(path)) return reply(404, { error: "不存在" });
      file = resolve(root, "index.html");
    }
    const content = await readFile(file);
    res.setHeader(
      "Content-Type",
      mime[extname(file)] || "application/octet-stream",
    );
    res.setHeader(
      "Cache-Control",
      path.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    );
    res.end(req.method === "HEAD" ? undefined : content);
  } catch {
    reply(503, { error: "请先运行 npm run build" });
  }
});
const cleanup = setInterval(() => {
  for (const [id, value] of rates)
    if (Date.now() - value.since > 120000) rates.delete(id);
}, 120000);
cleanup.unref();
server.listen(port, "0.0.0.0", () =>
  console.log(
    `X-Mirror: http://localhost:${port} · 视频按输入时长生成（最长 10s） · 启动不调用模型`,
  ),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await api.close();
    await vite?.close();
    server.close();
    await proxy?.close();
    process.exit(0);
  });
