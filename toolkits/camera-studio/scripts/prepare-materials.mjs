import { readFile, writeFile, mkdir, stat, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { fetch, ProxyAgent } from 'undici';
import { loadSharedEnv } from '../server/env.mjs';
import { command } from '../server/storage.mjs';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const env = loadSharedEnv();
const presets = JSON.parse(await readFile('public/presets.json', 'utf8'));
const sources = JSON.parse(await readFile('public/materials/sources.json', 'utf8'));
const checkOnly = process.argv.includes('--check');
const dispatcher = env.XMAX_PROXY_URL ? new ProxyAgent(env.XMAX_PROXY_URL) : undefined;
await mkdir('public/materials', { recursive: true });
let missing = 0;
try {
  for (const preset of presets) {
    const name = preset.image.split('/').pop();
    if (!/^[\w-]+\.(png|jpe?g|webp)$/.test(name) || preset.image !== `/materials/${name}`) throw new Error('无效素材文件名');
    const target = resolve('public/materials', name);
    if ((await stat(target).catch(() => undefined))?.size > 1000) continue;
    if (checkOnly) { console.log(`缺少素材：${name}`); missing++; continue; }
    const source = sources[name];
    if (!source?.url || new URL(source.url).protocol !== 'https:') throw new Error(`缺少公开素材来源：${name}`);
    const response = await fetch(source.url, { dispatcher, signal: AbortSignal.timeout(60000), headers: { 'User-Agent': 'X-Mirror-Camera-Toolkit/1.0' } });
    if (!response.ok) throw new Error(`下载 ${name} 失败：HTTP ${response.status}；可以自行保存对应图片到 public/materials/`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 1000 || bytes.length > 25 * 1024 * 1024 || !response.headers.get('content-type')?.startsWith('image/')) throw new Error(`素材响应不是有效图片：${name}`);
    if (source.page?.startsWith('https://commons.wikimedia.org/')) {
      // Keep the locally prepared backgrounds small enough for reference uploads.
      const raw = resolve('public/materials', `${name}.source.jpg`);
      await writeFile(raw, bytes);
      try { await command(env.FFMPEG_PATH || 'ffmpeg', ['-y', '-v', 'error', '-i', raw, '-vf', 'scale=1280:1280:force_original_aspect_ratio=decrease', '-frames:v', '1', target]); }
      catch { await rename(raw, target); }
    } else await writeFile(target, bytes);
    console.log(`已准备 ${preset.name}：${name}`);
  }
  if (missing) { process.exitCode = 1; console.log('运行 npm run prepare:materials 下载素材，或加入自己的图片。'); }
  else console.log(`PASS：${presets.length} 款本地素材已就绪。此命令不会调用付费生成 API。`);
} finally { await dispatcher?.close(); }
