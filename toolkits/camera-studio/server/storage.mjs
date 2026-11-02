import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
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
// 流本身已是恒定帧率（标称与平均帧率一致，且在 10～60 之间）时返回该帧率，否则返回 0。
function constantFps({ r_frame_rate: nominal, avg_frame_rate: average }) {
  const rate = text => { const [n, d] = String(text).split('/').map(Number); return d ? n / d : 0; };
  const fps = rate(nominal);
  return fps >= 10 && fps <= 60 && Math.abs(fps - rate(average)) < 0.01 ? Math.round(fps * 1000) / 1000 : 0;
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
    return JSON.parse(await command(ffprobe, ['-v', 'error', '-count_packets', '-show_entries', 'stream=codec_name,width,height,r_frame_rate,avg_frame_rate,nb_read_packets:format=duration', '-of', 'json', path]));
  }
  async function saveVideo(dir, stem, buffer, type, duration) {
    if (!buffer.length || buffer.length < 500) throw new Error('视频为空，无法保存');
    const extension = type.startsWith('video/mp4') ? 'mp4' : type.startsWith('video/webm') ? 'webm' : type.startsWith('video/quicktime') ? 'mov' : undefined;
    if (!extension) throw new Error('仅支持 MP4 / WebM / MOV 视频');
    const raw = `${stem}-original.${extension}`; await writeFile(join(dir, raw), buffer);
    let file = raw, metadata;
    if (transcode) {
      metadata = await probe(join(dir, raw));
      const video = metadata.streams.find(stream => Number(stream.nb_read_packets) >= 3);
      if (!video) throw new Error('视频帧不足，未形成可播放片段');
      file = `${stem}.mp4`;
      const trim = duration ? ['-t', String(duration)] : [];
      // 摄像头 WebM 是可变帧率（时间戳抖动），直接转码会在播放时跳帧；统一成恒定帧率 MP4。
      // 模型输出若已是恒定帧率的 H.264，只重新封装，省去转码时间。
      const fps = constantFps(video);
      if (stem === 'output' && video.codec_name === 'h264' && fps) await command(ffmpeg, ['-y', '-v', 'error', '-i', join(dir, raw), ...trim, '-c:v', 'copy', '-an', '-movflags', '+faststart', join(dir, file)]);
      else await command(ffmpeg, ['-y', '-v', 'error', '-i', join(dir, raw), ...trim, '-fps_mode', 'cfr', '-r', String(stem === 'output' && fps || 30), ...(stem === 'input' ? ['-vf', "scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2"] : []), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-g', '30', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', join(dir, file)]);
      metadata = await probe(join(dir, file));
      if (stem === 'input' && Number(metadata.format?.duration) < 1) throw new Error('录制到的画面不足 1 秒，请重新录制（摄像头可能尚未就绪）');
      await writeFile(join(dir, `${stem}-probe.json`), JSON.stringify(metadata, null, 2));
    }
    return { file, metadata };
  }
  const materialsRoot = join(root, 'custom-materials');
  const imageTypes = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
  const loadMaterial = async id => {
    const meta = JSON.parse(await readFile(join(materialsRoot, id, 'material.json'), 'utf8'));
    return { ...meta, image: `/media/custom-materials/${id}/${meta.file}`, custom: true };
  };
  // 预置素材的修改保存在 material-edits/<id>/，不改动仓库里的原图和 presets.json；删除该目录即恢复默认。
  const editsRoot = join(root, 'material-edits');
  const editId = id => { if (typeof id !== 'string' || !/^[\w-]{1,40}$/.test(id)) throw new Error('无效素材编号'); return id; };
  const checkFields = ({ name, prompt }) => {
    name = String(name || '').trim(); prompt = String(prompt || '').trim();
    if (!name || name.length > 30) throw new Error('名称不能为空，且不超过 30 字');
    if (!prompt || [...prompt].length > 1024) throw new Error('提示词不能为空，且不超过 1024 字');
    return { name, prompt };
  };
  const imageExtension = type => {
    const extension = imageTypes[String(type).split(';')[0].trim()];
    if (!extension) throw new Error('素材图片仅支持 PNG / JPEG / WebP');
    return extension;
  };
  return {
    root, transcode, loadClip, readRun,
    // 预置素材的已保存修改：id -> { name, prompt, image? }
    async edits() {
      const result = {};
      for (const id of await readdir(editsRoot).catch(() => [])) {
        try {
          const edit = JSON.parse(await readFile(join(editsRoot, id, 'edit.json'), 'utf8'));
          result[id] = { name: edit.name, prompt: edit.prompt, ...(edit.file ? { image: `/media/material-edits/${id}/${edit.file}` } : {}) };
        } catch { /* Skip incomplete entries. */ }
      }
      return result;
    },
    async editBuiltin(id, fields, buffer, type) {
      const dir = join(editsRoot, editId(id)); const clean = checkFields(fields);
      let previous = {}; try { previous = JSON.parse(await readFile(join(dir, 'edit.json'), 'utf8')); } catch { /* First edit. */ }
      await mkdir(dir, { recursive: true }); let file = previous.file;
      if (buffer.length) {
        if (buffer.length < 100) throw new Error('图片为空');
        file = `image-${Date.now()}.${imageExtension(type)}`; await writeFile(join(dir, file), buffer);
        if (previous.file && previous.file !== file) await rm(join(dir, previous.file), { force: true });
      }
      await writeFile(join(dir, 'edit.json'), JSON.stringify({ ...clean, ...(file ? { file } : {}), updatedAt: new Date().toISOString() }, null, 2));
      return { ...clean, ...(file ? { image: `/media/material-edits/${id}/${file}` } : {}) };
    },
    async resetBuiltin(id) { await rm(join(editsRoot, editId(id)), { recursive: true, force: true }); },
    async editCustom(id, fields, buffer, type) {
      if (!validId(id)) throw new Error('无效素材编号');
      const dir = join(materialsRoot, id), meta = JSON.parse(await readFile(join(dir, 'material.json'), 'utf8')); const clean = checkFields(fields);
      let category = String(fields.category ?? meta.category).trim() || '我的素材';
      if (category.length > 12) throw new Error('分类不超过 12 字');
      if (buffer.length) {
        if (buffer.length < 100) throw new Error('图片为空');
        const file = `image-${Date.now()}.${imageExtension(type)}`; await writeFile(join(dir, file), buffer);
        await rm(join(dir, meta.file), { force: true }); meta.file = file;
      }
      await writeFile(join(dir, 'material.json'), JSON.stringify({ ...meta, ...clean, category }, null, 2));
      return loadMaterial(id);
    },
    async materials() {
      const list = [];
      for (const id of await readdir(materialsRoot).catch(() => [])) {
        if (!validId(id)) continue;
        try { list.push(await loadMaterial(id)); } catch { /* Skip incomplete entries. */ }
      }
      return list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async saveMaterial(buffer, type, { name, category, prompt }) {
      const extension = imageTypes[String(type).split(';')[0].trim()];
      if (!extension) throw new Error('素材图片仅支持 PNG / JPEG / WebP');
      if (buffer.length < 100) throw new Error('图片为空');
      name = String(name || '').trim(); category = String(category || '').trim() || '我的素材'; prompt = String(prompt || '').trim();
      if (!name || name.length > 30) throw new Error('名称不能为空，且不超过 30 字');
      if (category.length > 12) throw new Error('分类不超过 12 字');
      if (!prompt || prompt.length > 2000) throw new Error('提示词不能为空，且不超过 2000 字');
      const id = randomUUID(), dir = join(materialsRoot, id); await mkdir(dir, { recursive: true });
      const file = `image.${extension}`; await writeFile(join(dir, file), buffer);
      await writeFile(join(dir, 'material.json'), JSON.stringify({ id, name, category, prompt, file, referenceUrl: null, source: '自定义素材', createdAt: new Date().toISOString() }, null, 2));
      return loadMaterial(id);
    },
    async deleteMaterial(id) {
      if (!validId(id)) throw new Error('无效素材编号');
      await rm(join(materialsRoot, id), { recursive: true, force: true });
    },
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
    async progress(clipId, runId, fields) {
      const report = await readRun(clipId, runId);
      if (report.status === 'saved') return report;
      for (const key of ['status', 'taskUid', 'taskStatus', 'requestedFps', 'resolvedFps', 'resultFps', 'resultFrames', 'droppedFrames']) if (fields[key] !== undefined) report[key] = String(fields[key]).slice(0, 200);
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
      if (!/\.(mp4|webm|mov|jpg|png|webp|json)$/.test(path)) throw new Error('无效文件类型');
      const info = await stat(path); if (!info.isFile()) throw new Error('不是媒体文件'); return { path, size: info.size };
    },
  };
}
