import http from 'node:http';
import { readFileSync, createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer, loadEnv } from 'vite';
import { ProxyAgent, fetch as proxyFetch } from 'undici';
import { createApi } from './server/api.mjs';
import { createStore } from './server/storage.mjs';

process.chdir(fileURLToPath(new URL('.', import.meta.url)));
const env = { ...loadEnv('development', process.cwd(), ''), ...process.env };
const port = Number(env.PORT || 5190);
const presets = JSON.parse(readFileSync('public/presets.json', 'utf8'));
const agent = env.XMAX_PROXY_URL ? new ProxyAgent(env.XMAX_PROXY_URL) : undefined;
const request = agent ? (url, options) => proxyFetch(url, { ...options, dispatcher: agent }) : fetch;
const store = await createStore({ root: env.STUDIO_OUTPUT_DIR || 'outputs', ffmpeg: env.FFMPEG_PATH || 'ffmpeg', ffprobe: env.FFPROBE_PATH || 'ffprobe' });
const ids = presets.map(p => p.id);
const api = createApi({ env: { ...env, XMAX_OUTPUT_SECONDS: '10' }, caseIds: ids, repeatableCaseIds: ids, ledgerPath: '.local/attempts.json', request });
const vite = await createServer({ server: { middlewareMode: true, hmr: env.STUDIO_TEST ? false : { port: port + 10000 }, ...(env.STUDIO_TEST ? { watch: null } : {}) }, appType: 'spa' });
async function readBody(req, max) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw new Error('文件过大，视频上限 100 MB'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, `http://127.0.0.1:${port}`); } catch { res.writeHead(400); return res.end(); }
  if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/media/')) return vite.middlewares(req, res);
  const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  try {
    if (!allowed.has(req.headers.host) || (req.headers.origin && !allowed.has(new URL(req.headers.origin).host))) return reply(403, { error: '只允许本地同源请求' });
    if (url.pathname.startsWith('/media/')) {
      if (!['GET', 'HEAD'].includes(req.method)) return reply(405, { error: '只允许读取媒体' });
      const { path, size } = await store.mediaPath(decodeURIComponent(url.pathname.slice(7)));
      const type = path.endsWith('.mp4') ? 'video/mp4' : path.endsWith('.webm') ? 'video/webm' : path.endsWith('.jpg') ? 'image/jpeg' : 'application/json';
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      let start = 0, end = size - 1;
      if (req.headers.range && !range) return reply(416, { error: '无效 Range' });
      if (range) { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
      if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
      res.writeHead(range ? 206 : 200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
      if (req.method === 'HEAD') return res.end(); return createReadStream(path, { start, end }).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/api/status') return reply(200, { configured: api.status().configured, active: api.status().active, transcode: store.transcode, outputDirectory: store.root, presets });
    if (req.method === 'GET' && url.pathname === '/api/history') return reply(200, await store.history());
    if (req.method !== 'POST') return reply(405, { error: '需要 POST 请求' });
    if (url.pathname === '/api/clips') return reply(200, await store.saveClip(await readBody(req, 100 * 1024 * 1024), req.headers['content-type'] || '', url.searchParams.get('seconds')));
    const match = /^\/api\/clips\/([^/]+)\/runs\/([^/]+)(\/output)?$/.exec(url.pathname);
    if (match?.[3]) return reply(200, await store.saveOutput(match[1], match[2], await readBody(req, 100 * 1024 * 1024), req.headers['content-type'] || ''));
    if (!req.headers['content-type']?.startsWith('application/json')) return reply(400, { error: '需要 application/json' });
    const data = JSON.parse((await readBody(req, 16384)).toString('utf8'));
    if (match) return reply(200, await store.update(match[1], match[2], data));
    if (url.pathname === '/api/runs') {
      const preset = presets.find(p => p.id === data.presetId); if (!preset) throw new Error('未知素材');
      return reply(200, await store.newRun(data.clipId, preset, data.prompt));
    }
    if (url.pathname === '/api/start') {
      const run = await store.readRun(data.clipId, data.runId);
      if (['saved', 'failed', 'cancelled'].includes(run.status)) throw new Error('该任务已结束，请新建一次处理');
      return reply(200, await api.start(run.presetId));
    }
    if (url.pathname === '/api/finish') return reply(200, await api.finish(data.lease));
    if (url.pathname === '/api/open-folder') {
      const launcher = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      const child = spawn(launcher, [store.root], { windowsHide: true, stdio: 'ignore' }); child.on('error', () => {}); child.unref();
      return reply(200, { path: store.root });
    }
    return reply(404, { error: '未知接口' });
  } catch (error) { if (!res.headersSent) reply(400, { error: error.message.replace(/\b(?:uk|tk)-[A-Za-z0-9_-]+/g, '[redacted]') }); else res.destroy(); }
});
server.listen(port, '127.0.0.1', () => console.log(`XMAX Camera Studio: http://127.0.0.1:${port}\nLocal videos: ${store.root}\nStartup does not call the generation API.`));
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已占用，请修改 .env 中的 PORT` : error.message); process.exit(1); });
for (const event of ['SIGINT', 'SIGTERM']) process.on(event, async () => { await api.close(); await vite.close(); server.close(); await agent?.close(); process.exit(0); });
