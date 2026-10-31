import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { spawn } from 'node:child_process';

export const validId = id => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
export function seconds(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 3 || n > 10) throw new Error('录制时长必须为 3～10 秒的整数');
  return n;
}
export async function command(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { error = (error + data).slice(-1500); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('视频转换超时')); }, 60000);
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(error || '视频转换失败')); });
  });
}
export async function createStore({ root, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe' }) {
  root = resolve(root); await mkdir(root, { recursive: true });
  let transcode = true;
  try { await command(ffmpeg, ['-version']); await command(ffprobe, ['-version']); } catch { transcode = false; }
  const pathFor = id => { if (!validId(id)) throw new Error('无效短片编号'); return join(root, id); };
  const loadClip = async id => JSON.parse(await readFile(join(pathFor(id), 'clip.json'), 'utf8'));
  const runPath = (clipId, runId) => { if (!validId(runId)) throw new Error('无效结果编号'); return join(pathFor(clipId), 'runs', runId); };
  const readRun = async (clipId, runId) => JSON.parse(await readFile(join(runPath(clipId, runId), 'report.json'), 'utf8'));
  const writeRun = async report => writeFile(join(runPath(report.clipId, report.id), 'report.json'), JSON.stringify(report, null, 2));
  async function probe(path) {
    return JSON.parse(await command(ffprobe, ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_name,width,height,nb_read_frames:format=duration', '-of', 'json', path]));
  }
  async function saveVideo(dir, stem, buffer, type, duration) {
    if (!buffer.length || buffer.length < 500) throw new Error('视频为空，无法保存');
    const extension = type.startsWith('video/mp4') ? 'mp4' : type.startsWith('video/webm') ? 'webm' : undefined;
    if (!extension) throw new Error('仅支持 MP4 / WebM 视频');
    const raw = `${stem}-original.${extension}`; await writeFile(join(dir, raw), buffer);
    let file = raw, metadata;
    if (transcode) {
      metadata = await probe(join(dir, raw));
      if (!metadata.streams.some(stream => Number(stream.nb_read_frames) >= 10)) throw new Error('视频帧不足，未形成可播放片段');
      file = `${stem}.mp4`;
      await command(ffmpeg, ['-y', '-v', 'error', '-i', join(dir, raw), ...(duration ? ['-t', String(duration)] : []), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', join(dir, file)]);
      metadata = await probe(join(dir, file));
      await writeFile(join(dir, `${stem}-probe.json`), JSON.stringify(metadata, null, 2));
    }
    return { file, metadata };
  }
  return {
    root, transcode, loadClip, readRun,
    async saveClip(buffer, type, duration) {
      duration = seconds(duration); const id = randomUUID(), dir = pathFor(id); await mkdir(dir, { recursive: true });
      const result = await saveVideo(dir, 'input', buffer, type, duration);
      const clip = { id, seconds: duration, createdAt: new Date().toISOString(), input: result.file, inputUrl: `/media/${id}/${result.file}`, directory: dir };
      await writeFile(join(dir, 'clip.json'), JSON.stringify(clip, null, 2)); return clip;
    },
    async newRun(clipId, preset, prompt) {
      await loadClip(clipId);
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 2000) throw new Error('提示词不能为空，且不超过 2000 字');
      const id = randomUUID(), dir = runPath(clipId, id); await mkdir(dir, { recursive: true });
      const report = { id, clipId, presetId: preset.id, presetName: preset.name, prompt: prompt.trim(), reference: preset.image, model: 'Xmax X2.1', status: 'preparing', createdAt: new Date().toISOString(), directory: dir, verdict: 'pending_manual_review' };
      await writeFile(join(dir, 'prompt.txt'), report.prompt + '\n'); await writeRun(report); return report;
    },
    async update(clipId, runId, fields) {
      const report = await readRun(clipId, runId); const allowed = ['failed', 'cancelled', 'generating'];
      if (!allowed.includes(fields.status)) throw new Error('无效状态');
      if (report.status === 'saved') return report;
      report.status = fields.status; report.error = typeof fields.error === 'string' ? fields.error.slice(0, 1000).replace(/\b(?:uk|tk)-[A-Za-z0-9_-]+/g, '[redacted]') : undefined;
      await writeRun(report); return report;
    },
    async saveOutput(clipId, runId, buffer, type) {
      const report = await readRun(clipId, runId);
      if (report.status === 'saved') throw new Error('此结果已保存，不能覆盖');
      const dir = runPath(clipId, runId); const clip = await loadClip(clipId); const result = await saveVideo(dir, 'output', buffer, type, clip.seconds);
      Object.assign(report, { status: 'saved', savedAt: new Date().toISOString(), video: result.file, videoUrl: `/media/${clipId}/runs/${runId}/${result.file}`, duration: Number(result.metadata?.format?.duration) || undefined });
      if (transcode) {
        try { await command(ffmpeg, ['-y', '-v', 'error', '-i', join(dir, result.file), '-frames:v', '1', join(dir, 'preview.jpg')]); report.previewUrl = `/media/${clipId}/runs/${runId}/preview.jpg`; } catch { /* Video remains saved if preview is unavailable. */ }
      }
      await writeRun(report); return report;
    },
    async history() {
      const clips = [], runs = [];
      for (const id of await readdir(root)) {
        if (!validId(id)) continue;
        try {
          const clip = await loadClip(id); clips.push(clip);
          for (const runId of await readdir(join(pathFor(id), 'runs')).catch(() => [])) {
            if (validId(runId)) runs.push(await readRun(id, runId));
          }
        } catch { /* Incomplete uploads do not enter the library. */ }
      }
      return { clips: clips.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30), runs: runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30) };
    },
    async mediaPath(relative) {
      const path = resolve(root, relative);
      if (!path.startsWith(root + sep)) throw new Error('无效文件路径');
      if (!/\.(mp4|webm|jpg|json)$/.test(path)) throw new Error('无效文件类型');
      const info = await stat(path); if (!info.isFile()) throw new Error('不是媒体文件'); return { path, size: info.size };
    },
  };
}
