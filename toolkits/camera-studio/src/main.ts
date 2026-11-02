import { XmaxClient, XmaxConfiguration, XmaxEnvironment } from '@xmaxai/web-sdk';
import './style.css';

type Preset = { id: string; name: string; category: string; image: string; prompt: string; referenceUrl?: string | null; custom?: boolean; edited?: boolean };
type Clip = { id: string; seconds: number; inputUrl: string; directory: string; createdAt: string };
type Run = { id: string; clipId: string; presetId: string; presetName: string; prompt: string; status: string; videoUrl?: string; previewUrl?: string; directory: string; duration?: number; error?: string };
type Ticket = { lease: string; temporaryApiKey: string; environment: 'china' | 'global'; sessionSeconds: number };
type Job = { run: Run; clip: Clip; lease?: string; keyRequest?: Promise<Ticket>; submitted: boolean; done: boolean };
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
$('app').innerHTML = `
<header class="topbar"><a class="brand" href="/"><img class="brand-logo" src="/xkd-x-mirror-logo.png" alt="X-Mirror"><i></i>X<span>MAX</span><small>X2.1</small></a><span id="connection" class="connection">读取配置…</span></header>
<main class="workspace"><div class="intro"><span class="eyebrow">拍一小段，换一种效果</span><h1>你的镜头，新的可能。</h1><p>录制或上传 3–10 秒视频，点击右侧素材，用 Xmax X2.1 高清生成新的画面。</p></div>
<section class="capture-bar"><div class="camera-controls"><button id="camera" class="button secondary">打开摄像头</button><select id="camera-device" aria-label="摄像头"><option value="">默认摄像头</option></select></div><label class="duration-control">录制时长 <input id="duration" type="range" min="3" max="10" value="5"><b id="duration-label">5 秒</b></label><button id="record" class="button record" disabled><span class="record-dot"></span>录制短片</button><button id="upload" class="button secondary">上传视频片段</button><input id="upload-file" type="file" accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov" hidden><button id="close-camera" class="text-button" disabled>关闭摄像头</button></section>
<section class="stage"><article class="video-card"><div class="card-heading"><h2>原始视频</h2><span id="input-badge" class="badge">未录制</span></div><div class="video-box"><video id="camera-video" autoplay muted playsinline hidden></video><video id="input-video" controls muted playsinline loop hidden></video><div id="camera-empty" class="empty"><div class="empty-icon">◉</div><strong>先录下你的动作</strong><span>打开摄像头，保持光线明亮、主体清晰</span></div><div id="countdown" class="countdown" hidden></div></div><div class="video-footer"><span id="input-info">录制后自动保存原视频</span><a id="input-download" hidden download>下载原片 ↓</a></div></article>
<article class="video-card"><div class="card-heading"><h2>生成视频</h2><span id="output-badge" class="badge">等待素材</span></div><div class="video-box"><video id="output-video" controls playsinline loop hidden></video><div id="output-empty" class="empty"><div class="empty-icon">✦</div><strong>点击右侧素材试试</strong><span>人脸、帽子、服装、背景，都准备好了</span></div><div id="working" class="working" hidden><span class="spinner"></span><b id="working-text">连接 XMAX…</b></div></div><div class="video-footer"><span id="output-info">生成后自动保存至本地</span><a id="output-download" hidden download>下载结果 ↓</a></div></article></section>
<section class="prompt-card"><div class="prompt-heading"><div><span class="eyebrow">当前效果</span><h2 id="effect-name">选择素材</h2></div><div class="prompt-actions"><button id="generate" class="button primary" disabled>生成当前效果</button><button id="cancel" class="button secondary" disabled>停止处理</button></div></div><textarea id="prompt" rows="2" aria-label="提示词" maxlength="1024"></textarea><p id="status" role="status">打开摄像头开始录制，录制和浏览素材不会消耗生成额度。</p></section>
<section class="history-section"><div class="history-heading"><h2>最近保存</h2><button id="folder" class="text-button">打开本地保存目录 ↗</button></div><div id="history" class="history"><span class="history-empty">生成的短片会出现在这里，刷新页面也会保留。</span></div><p class="save-path" id="save-path"></p></section></main>
<aside class="material-dock" aria-label="预置素材悬浮窗"><div class="dock-heading"><div><span class="eyebrow">准备好的素材</span><h2>换个效果</h2></div><span id="material-count"></span></div><p class="dock-hint">录制或上传后，点击素材编辑图片和提示词，再点「使用生成」</p><button id="add-material" class="add-material">＋ 添加素材</button><div id="filters" class="filters"></div><div id="materials" class="materials"></div><div class="dock-footer">图片与提示词已配对<br>同一段视频可以反复尝试</div></aside>
<dialog id="material-dialog" class="form-dialog"><form id="material-form" method="dialog"><button type="button" id="material-close" class="preview-close" aria-label="关闭">×</button><h3>添加自定义素材</h3>
<label class="field">素材图片（PNG / JPEG / WebP，≤10 MB）<input id="material-image" type="file" accept="image/png,image/jpeg,image/webp" required></label><img id="material-preview" alt="素材预览" hidden>
<label class="field">名称<input id="material-name" maxlength="30" placeholder="例如：我的帽子" required></label>
<label class="field">分类<input id="material-category" maxlength="12" list="material-categories" placeholder="例如：人脸替换"><datalist id="material-categories"></datalist></label>
<div class="field">快捷提示词<div id="material-templates" class="templates"></div></div>
<label class="field">提示词<textarea id="material-prompt" rows="4" maxlength="1024" placeholder="描述如何使用参考图，例如：将视频中人物的脸换成参考图中的脸，其他保持不变" required></textarea></label>
<p id="material-error" class="form-error" role="alert"></p><div class="form-actions"><button type="button" id="material-cancel" class="button secondary">取消</button><button id="material-save" class="button primary">保存素材</button></div></form></dialog>
<dialog id="edit-dialog" class="form-dialog"><form id="edit-form" method="dialog"><button type="button" id="edit-close" class="preview-close" aria-label="关闭">×</button><h3>编辑素材</h3>
<div class="edit-image"><img id="edit-image" alt="素材大图"><label class="button secondary edit-replace">更换图片<input id="edit-file" type="file" accept="image/png,image/jpeg,image/webp" hidden></label></div>
<label class="field">名称<input id="edit-name" maxlength="30" required></label>
<label class="field">提示词<textarea id="edit-prompt" rows="5" maxlength="1024" required></textarea></label>
<p id="edit-error" class="form-error" role="alert"></p><div class="form-actions"><button type="button" id="edit-reset" class="button secondary" hidden>恢复默认</button><button type="button" id="edit-save" class="button secondary">保存修改</button></div>
<button type="button" id="edit-use" class="button primary edit-use">使用生成</button></form></dialog>`;

let presets: Preset[] = [], selected: Preset | undefined, clip: Clip | undefined, cameraStream: MediaStream | undefined;
let capturing = false, opening = false, configured = false, savingCapture = false;
let currentJob: Job | undefined, generationStarting = false, filter = '全部';
let outputUrl: string | undefined, canTranscode = false;

const redact = (s: string) => s.replace(/\b(?:uk|tk)-[A-Za-z0-9_-]+/g, '[redacted]');
function status(message: string) { $('status').textContent = redact(message); }
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`); return result;
}
async function upload<T>(path: string, blob: Blob): Promise<T> {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': blob.type || 'video/webm' }, body: blob });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '保存失败'); return data;
}
const processing = () => generationStarting || !!currentJob;
function controls() {
  const locked = capturing || savingCapture || processing();
  $<HTMLButtonElement>('camera').disabled = locked || opening;
  $<HTMLButtonElement>('record').disabled = locked || !cameraStream || opening;
  $<HTMLButtonElement>('close-camera').disabled = capturing || !cameraStream;
  $<HTMLButtonElement>('upload').disabled = locked || opening;
  $<HTMLInputElement>('duration').disabled = locked;
  $<HTMLSelectElement>('camera-device').disabled = locked || opening;
  $<HTMLTextAreaElement>('prompt').disabled = locked;
  $<HTMLButtonElement>('generate').disabled = locked || !clip || !selected || !configured;
  $<HTMLButtonElement>('cancel').disabled = !currentJob || currentJob.done;
  $<HTMLButtonElement>('edit-use').disabled = locked || !configured;
}
function select(preset: Preset) {
  selected = preset; $('effect-name').textContent = preset.name; $<HTMLTextAreaElement>('prompt').value = preset.prompt;
  for (const card of document.querySelectorAll<HTMLElement>('.material-card')) card.classList.toggle('selected', card.dataset.id === preset.id);
  controls();
}
function renderMaterials() {
  $('materials').replaceChildren();
  for (const preset of presets.filter(p => filter === '全部' || p.category === filter)) {
    const card = document.createElement('div'); card.className = 'material-card'; card.dataset.id = preset.id;
    const open = document.createElement('button'); open.className = 'material-open'; open.title = `${preset.name}：点击编辑素材和提示词`;
    const image = document.createElement('img'); image.src = preset.image; image.alt = preset.name; image.loading = 'lazy';
    const label = document.createElement('div'); label.className = 'material-label'; const name = document.createElement('strong'); name.textContent = preset.name;
    const hint = document.createElement('span'); hint.textContent = preset.edited ? '已修改 · 点击编辑 →' : '点击编辑 →'; label.append(name, hint); open.append(image, label);
    open.onclick = () => openEditor(preset);
    card.append(open);
    if (preset.custom) {
      const remove = document.createElement('button'); remove.className = 'material-remove'; remove.textContent = '×'; remove.title = '删除这个自定义素材'; remove.setAttribute('aria-label', `删除${preset.name}`);
      remove.onclick = () => void removeMaterial(preset); card.append(remove);
    }
    $('materials').append(card);
  }
  for (const card of document.querySelectorAll<HTMLElement>('.material-card')) card.classList.toggle('selected', card.dataset.id === selected?.id);
  controls();
}
async function removeMaterial(preset: Preset) {
  if (processing() || !confirm(`删除自定义素材「${preset.name}」？`)) return;
  try {
    await api(`/api/materials/${preset.id}/delete`, {}); presets = presets.filter(p => p.id !== preset.id);
    if (!presets.some(p => p.category === filter)) filter = '全部';
    if (selected?.id === preset.id) { selected = undefined; if (presets[0]) select(presets[0]); else controls(); }
    $('material-count').textContent = `${presets.length} 款`; renderFilters(); renderMaterials(); status('已删除自定义素材。');
  } catch (error) { status(`删除失败：${String(error)}`); }
}
function renderFilters() {
  $('filters').replaceChildren();
  for (const category of ['全部', ...new Set(presets.map(p => p.category))]) {
    const button = document.createElement('button'); button.textContent = category; button.className = filter === category ? 'active' : '';
    button.onclick = () => { filter = category; renderFilters(); renderMaterials(); }; $('filters').append(button);
  }
}
function showClip(value: Clip) {
  clip = value; $<HTMLVideoElement>('input-video').src = value.inputUrl; $('input-video').hidden = false;
  $('camera-video').hidden = true; $('camera-empty').hidden = true; $('input-badge').textContent = `已录制 ${value.seconds} 秒`;
  $('input-info').textContent = '原片已保存，可重复使用'; const link = $<HTMLAnchorElement>('input-download'); link.href = value.inputUrl; link.hidden = false;
  controls();
}
function showOutput(run: Run) {
  if (!run.videoUrl) return;
  outputUrl = run.videoUrl; const video = $<HTMLVideoElement>('output-video'); video.src = run.videoUrl; video.hidden = false;
  $('output-empty').hidden = true; $('working').hidden = true;
  $('output-badge').textContent = '已保存'; $('output-info').textContent = `${run.presetName} · 本地已保存`;
  const link = $<HTMLAnchorElement>('output-download'); link.href = run.videoUrl; link.hidden = false;
  void video.play().catch(() => {});
}
async function history(restore = false) {
  const data = await api<{ clips: Clip[]; runs: Run[] }>('/api/history');
  if (restore && data.clips[0]) showClip(data.clips[0]);
  const saved = data.runs.filter(r => r.status === 'saved' && r.videoUrl);
  if (restore && saved[0]) showOutput(saved[0]);
  if (!saved.length) return;
  $('history').replaceChildren();
  for (const run of saved.slice(0, 10)) {
    const button = document.createElement('button'); button.className = 'history-item'; button.title = '点击回放，不调用 API';
    if (run.previewUrl) { const image = document.createElement('img'); image.src = run.previewUrl; image.alt = run.presetName; button.append(image); }
    const label = document.createElement('span'); label.textContent = run.presetName; button.append(label); button.onclick = () => { if (!processing()) showOutput(run); }; $('history').append(button);
  }
}
async function openCamera() {
  if (opening || capturing || processing()) return;
  opening = true; controls();
  try {
    const device = $<HTMLSelectElement>('camera-device').value;
    const stream = await navigator.mediaDevices.getUserMedia({ video: { ...(device ? { deviceId: { exact: device } } : {}), width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }, audio: false });
    cameraStream?.getTracks().forEach(t => t.stop()); cameraStream = stream;
    const video = $<HTMLVideoElement>('camera-video'); video.srcObject = stream; video.hidden = false; await video.play();
    $('input-video').hidden = true; $('camera-empty').hidden = true; $('input-badge').textContent = '摄像头已打开';
    const actual = stream.getVideoTracks()[0]?.getSettings().deviceId;
    const selectDevice = $<HTMLSelectElement>('camera-device'); selectDevice.replaceChildren();
    for (const device of (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput')) {
      const option = document.createElement('option'); option.value = device.deviceId; option.textContent = device.label || '摄像头'; selectDevice.append(option);
    }
    if (actual) selectDevice.value = actual;
    status('摄像头已就绪。选择时长，点击「录制短片」。');
  } catch (error) { status(`无法打开摄像头：${error instanceof Error ? error.message : String(error)}。请检查浏览器权限与设备。`); }
  finally { opening = false; controls(); }
}
function closeCamera() {
  if (capturing) return; cameraStream?.getTracks().forEach(t => t.stop()); cameraStream = undefined;
  $<HTMLVideoElement>('camera-video').srcObject = null; $('camera-video').hidden = true;
  if (clip) showClip(clip); else { $('camera-empty').hidden = false; $('input-badge').textContent = '未录制'; }
  controls();
}
async function record() {
  if (!cameraStream || capturing || savingCapture || processing()) return;
  const duration = Number($<HTMLInputElement>('duration').value);
  if (!Number.isInteger(duration) || duration < 3 || duration > 10) { status('时长必须为 3～10 秒'); return; }
  const type = ['video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find(t => MediaRecorder.isTypeSupported(t));
  if (!type) { status('浏览器不支持录制，请使用 Chrome 或 Edge'); return; }
  capturing = true; controls(); $('camera-video').hidden = false; $('input-video').hidden = true;
  $('countdown').hidden = false; const chunks: Blob[] = [];
  try {
    const recorder = new MediaRecorder(cameraStream, { mimeType: type, videoBitsPerSecond: 16000000 });
    const blob = await new Promise<Blob>((resolve, reject) => {
      let progress: ReturnType<typeof setInterval> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      recorder.onerror = () => { clearInterval(progress); clearTimeout(deadline); if (recorder.state === 'recording') recorder.stop(); reject(new Error('摄像头录制失败')); };
      recorder.onstop = () => { clearInterval(progress); clearTimeout(deadline); resolve(new Blob(chunks, { type })); };
      recorder.onstart = () => {
        const start = performance.now();
        const update = () => { const elapsed = (performance.now() - start) / 1000; $('countdown').textContent = `${Math.min(elapsed, duration).toFixed(1)} / ${duration} 秒`; };
        update(); progress = setInterval(update, 100);
        deadline = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, duration * 1000);
      };
      recorder.start(250);
    });
    capturing = false; savingCapture = true; controls(); status('正在保存原视频到本地…');
    const saved = await upload<Clip>(`/api/clips?seconds=${duration}`, blob); showClip(saved);
    status(`已录制并保存 ${duration} 秒原片。点击右侧素材，编辑后点「使用生成」。`);
  } catch (error) { status(`录制或保存失败：${String(error)}`); }
  finally { capturing = false; savingCapture = false; $('countdown').hidden = true; controls(); }
}
const videoType = (file: File) => file.type.startsWith('video/') ? file.type : /\.mov$/i.test(file.name) ? 'video/quicktime' : /\.webm$/i.test(file.name) ? 'video/webm' : /\.mp4$/i.test(file.name) ? 'video/mp4' : '';
async function videoDuration(file: File): Promise<number> {
  const url = URL.createObjectURL(file), video = document.createElement('video');
  try {
    return await new Promise<number>((resolve, reject) => {
      video.preload = 'metadata'; video.muted = true;
      video.onloadedmetadata = () => resolve(video.duration); video.onerror = () => reject(new Error('浏览器无法读取这个视频，请换用 H.264 MP4 或 WebM'));
      video.src = url;
    });
  } finally { URL.revokeObjectURL(url); }
}
async function importClip(file: File) {
  if (capturing || savingCapture || processing()) return;
  const type = videoType(file);
  if (!type) { status('请选择 MP4 / WebM / MOV 视频文件'); return; }
  if (file.size > 100 * 1024 * 1024) { status('视频超过 100 MB，请压缩或截取后再上传'); return; }
  savingCapture = true; controls();
  try {
    const length = await videoDuration(file);
    if (!Number.isFinite(length) || length < 2.5) throw new Error('视频需要至少 3 秒');
    if (length > 10.5 && !canTranscode) throw new Error('视频超过 10 秒；未安装 FFmpeg，无法自动截取，请先剪辑到 10 秒内');
    const duration = Math.min(10, Math.round(length));
    status('正在保存上传的视频到本地…');
    const saved = await upload<Clip>(`/api/clips?seconds=${duration}`, new Blob([file], { type }));
    showClip(saved);
    status(length > 10.5 ? '视频超过 10 秒，已保留前 10 秒并保存。点击右侧素材，编辑后点「使用生成」。' : `已保存上传的 ${duration} 秒视频。点击右侧素材，编辑后点「使用生成」。`);
  } catch (error) { status(`上传失败：${error instanceof Error ? error.message : String(error)}`); }
  finally { savingCapture = false; controls(); }
}
async function fileAt(url: string): Promise<File> {
  const response = await fetch(url); if (!response.ok) throw new Error('无法读取已保存素材'); const blob = await response.blob();
  return new File([blob], url.split('/').pop()!, { type: blob.type });
}
function working(message: string) { $('working').hidden = false; $('working-text').textContent = message; status(message); }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// 上传完成后立即释放临时凭证；提交、轮询和保存结果由本地后端完成。
async function releaseLease(job: Job) {
  const request = job.keyRequest; job.keyRequest = undefined;
  const late = request ? await request.catch(() => undefined) : undefined;
  const lease = job.lease || late?.lease; job.lease = undefined;
  if (lease) await api('/api/finish', { lease }).catch(() => {});
}
function restoreOutput(badge: string) {
  $('working').hidden = true; $('output-badge').textContent = badge;
  if (outputUrl) $('output-video').hidden = false; else $('output-empty').hidden = false;
}
async function finishJob(job: Job, reason: 'complete' | 'cancelled' | 'failed', error?: string) {
  if (job.done) return; job.done = true;
  await releaseLease(job);
  try {
    if (reason === 'cancelled') {
      await api(`/api/clips/${job.clip.id}/runs/${job.run.id}`, { status: 'cancelled', error: '用户停止等待' }).catch(() => {});
      restoreOutput('已停止');
      status(job.submitted ? '已停止等待。服务端任务仍在处理，完成后结果会自动保存到本地，可在「最近保存」查看。' : '已停止。原视频仍可继续使用。');
    } else if (reason === 'failed') {
      await api(`/api/clips/${job.clip.id}/runs/${job.run.id}`, { status: 'failed', error: redact(error || '生成失败') }).catch(() => {});
      restoreOutput('生成失败'); status(`本次处理失败：${redact(error || '未知错误')}。没有自动重试，原片已保留。`);
    } else await history();
  } finally { if (currentJob === job) currentJob = undefined; controls(); }
}
async function generate() {
  if (!clip || !selected || processing() || capturing || savingCapture) return;
  if (!configured) { status('请在工具目录的 .env 中配置 XMAX_API_KEY，然后重启工具'); return; }
  const inputClip = clip, preset = selected, prompt = $<HTMLTextAreaElement>('prompt').value.trim();
  if (!prompt) { status('请填写提示词'); return; }
  generationStarting = true; controls();
  $('output-badge').textContent = '准备中'; $('output-video').hidden = true; $('output-empty').hidden = true; $('output-download').hidden = true;
  working('准备读取原视频…');
  let job: Job | undefined;
  try {
    const input = await fileAt(inputClip.inputUrl);
    const run = await api<Run>('/api/runs', { clipId: inputClip.id, presetId: preset.id, prompt });
    job = { run, clip: inputClip, done: false, submitted: false }; currentJob = job; generationStarting = false; controls();
    $('output-badge').textContent = preset.name;
    const active = () => !job!.done;
    working('申请上传凭证…');
    job.keyRequest = api<Ticket>('/api/start', { clipId: inputClip.id, runId: run.id });
    const ticket = await job.keyRequest; if (!active()) return; // 取消时由 finishJob 释放迟到的凭证
    job.keyRequest = undefined; job.lease = ticket.lease;
    const storage = new XmaxClient(new XmaxConfiguration({ apiKey: ticket.temporaryApiKey, environment: XmaxEnvironment[ticket.environment] })).createStorageService();
    working('上传原视频和参考图到 XMAX…');
    // 原视频与参考图并行上传，缩短提交前的等待。
    const [video, referencePath] = await Promise.all([
      storage.uploadVideo({ data: input, fileName: input.name, contentType: input.type || 'video/mp4' }),
      preset.referenceUrl ? Promise.resolve(preset.referenceUrl) : fileAt(preset.image).then(async reference => (await storage.uploadImage({ data: reference, fileName: reference.name, contentType: reference.type })).url),
    ]);
    if (!active()) return;
    await releaseLease(job);
    working('提交高清生成任务…');
    await api('/api/offline', { clipId: inputClip.id, runId: run.id, videoPath: video.url, referencePath });
    job.submitted = true;
    const started = Date.now();
    while (active()) {
      await sleep(1000); if (!active()) return;
      const latest = await api<Run & { taskStatus?: string }>(`/api/clips/${inputClip.id}/runs/${run.id}`);
      if (latest.status === 'saved') {
        showOutput(latest); status('高清生成视频已保存。可以点击另一张素材，继续处理同一段原片。');
        await finishJob(job, 'complete'); return;
      }
      if (latest.status === 'failed') { await finishJob(job, 'failed', latest.error); return; }
      working(`服务端高清生成中（${latest.taskStatus === 'processing' ? '处理中' : '排队中'}），已等待 ${Math.round((Date.now() - started) / 1000)} 秒…`);
    }
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error));
    if (job) await finishJob(job, 'failed', message);
    else { restoreOutput('启动失败'); status(`无法启动处理：${message}`); }
  } finally { generationStarting = false; controls(); }
}
// 点击任一视频，原视频与生成视频同步播放（同一速率、同一时间点）。
const inputVideo = $<HTMLVideoElement>('input-video'), outputVideo = $<HTMLVideoElement>('output-video');
let syncing = false;
const mirror = (from: HTMLVideoElement, to: HTMLVideoElement) => {
  if (syncing || to.hidden || !to.src) return;
  syncing = true;
  try {
    to.playbackRate = from.playbackRate = 1;
    if (Math.abs(to.currentTime - from.currentTime) > 0.05) to.currentTime = Math.min(from.currentTime, to.duration || from.currentTime);
    if (from.paused !== to.paused) { if (from.paused) to.pause(); else void to.play().catch(() => {}); }
  } finally { setTimeout(() => { syncing = false; }, 50); }
};
for (const [a, b] of [[inputVideo, outputVideo], [outputVideo, inputVideo]] as const) {
  for (const event of ['play', 'pause', 'seeked']) a.addEventListener(event, () => mirror(a, b));
  a.addEventListener('timeupdate', () => { if (!a.paused && !b.hidden && b.src && Math.abs(a.currentTime - b.currentTime) > 0.3) mirror(a, b); });
}
$('upload').onclick = () => $<HTMLInputElement>('upload-file').click();
$('upload-file').onchange = () => { const input = $<HTMLInputElement>('upload-file'), file = input.files?.[0]; input.value = ''; if (file) void importClip(file); };
$('camera').onclick = () => void openCamera(); $('close-camera').onclick = closeCamera;
$('camera-device').onchange = () => void openCamera(); $('record').onclick = () => void record();
$('duration').oninput = () => { $('duration-label').textContent = `${$<HTMLInputElement>('duration').value} 秒`; };
$('generate').onclick = () => void generate(); $('cancel').onclick = () => { if (currentJob) void finishJob(currentJob, 'cancelled'); };
$('folder').onclick = () => void api<{ path: string }>('/api/open-folder', {}).then(result => status(`保存目录：${result.path}`)).catch(error => status(String(error)));
const TEMPLATES: Record<string, { category: string; prompt: string }> = {
  '人脸替换': { category: '人物替换', prompt: '将视频中人物的脸换成参考图中的脸。只换参考图的脸，其他保持不变' },
  '服饰替换': { category: '虚拟试穿', prompt: '将参考图的服装穿戴到视频人物身上，跟随人物原有动作，面容和背景保持不变' },
  '帽子 / 配饰': { category: '虚拟试穿', prompt: '将参考图中的配饰戴到视频人物身上，其他保持不变' },
  '背景替换': { category: '场景', prompt: '将视频背景替换成参考图中的场景，人物保持不变' },
};
const materialDialog = $<HTMLDialogElement>('material-dialog');
function openMaterialDialog() {
  $<HTMLFormElement>('material-form').reset(); $('material-preview').hidden = true; $('material-error').textContent = '';
  $('material-categories').replaceChildren(...[...new Set(['人物替换', '虚拟试穿', '场景', ...presets.map(p => p.category)])].map(c => Object.assign(document.createElement('option'), { value: c })));
  materialDialog.showModal();
}
for (const [label, template] of Object.entries(TEMPLATES)) {
  const chip = document.createElement('button'); chip.type = 'button'; chip.textContent = label;
  chip.onclick = () => { $<HTMLTextAreaElement>('material-prompt').value = template.prompt; if (!$<HTMLInputElement>('material-category').value) $<HTMLInputElement>('material-category').value = template.category; if (!$<HTMLInputElement>('material-name').value) $<HTMLInputElement>('material-name').value = label; };
  $('material-templates').append(chip);
}
$('add-material').onclick = openMaterialDialog;
$('material-close').onclick = $('material-cancel').onclick = () => materialDialog.close();
$('material-image').onchange = () => {
  const file = $<HTMLInputElement>('material-image').files?.[0], image = $<HTMLImageElement>('material-preview');
  if (image.src.startsWith('blob:')) URL.revokeObjectURL(image.src);
  if (file) { image.src = URL.createObjectURL(file); image.hidden = false; } else image.hidden = true;
};
$<HTMLFormElement>('material-form').onsubmit = async event => {
  event.preventDefault();
  const file = $<HTMLInputElement>('material-image').files?.[0], error = $('material-error'), save = $<HTMLButtonElement>('material-save');
  if (!file) { error.textContent = '请选择素材图片'; return; }
  if (file.size > 10 * 1024 * 1024) { error.textContent = '图片超过 10 MB'; return; }
  const query = new URLSearchParams({ name: $<HTMLInputElement>('material-name').value, category: $<HTMLInputElement>('material-category').value, prompt: $<HTMLTextAreaElement>('material-prompt').value });
  save.disabled = true; error.textContent = '';
  try {
    const material = await upload<Preset>(`/api/materials?${query}`, file);
    presets.push(material); filter = '全部'; $('material-count').textContent = `${presets.length} 款`;
    materialDialog.close(); renderFilters(); renderMaterials(); select(material);
    status(`已添加素材「${material.name}」，点击即可用于生成。`);
  } catch (failure) { error.textContent = failure instanceof Error ? failure.message : String(failure); }
  finally { save.disabled = false; }
};
const editDialog = $<HTMLDialogElement>('edit-dialog');
let editing: Preset | undefined, editFile: File | undefined;
function openEditor(preset: Preset) {
  editing = preset; editFile = undefined; $<HTMLInputElement>('edit-file').value = '';
  $<HTMLImageElement>('edit-image').src = preset.image; $<HTMLInputElement>('edit-name').value = preset.name; $<HTMLTextAreaElement>('edit-prompt').value = preset.prompt;
  $('edit-error').textContent = ''; $('edit-reset').hidden = !preset.edited; controls(); editDialog.showModal();
}
function closeEditor() {
  const image = $<HTMLImageElement>('edit-image'); if (image.src.startsWith('blob:')) URL.revokeObjectURL(image.src);
  editing = undefined; editFile = undefined; editDialog.close();
}
$('edit-close').onclick = closeEditor;
$('edit-file').onchange = () => {
  const file = $<HTMLInputElement>('edit-file').files?.[0], image = $<HTMLImageElement>('edit-image'), error = $('edit-error');
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { error.textContent = '图片超过 10 MB'; return; }
  error.textContent = ''; if (image.src.startsWith('blob:')) URL.revokeObjectURL(image.src);
  editFile = file; image.src = URL.createObjectURL(file);
};
function replacePreset(updated: Preset) {
  presets = presets.map(p => p.id === updated.id ? updated : p);
  if (selected?.id === updated.id) { selected = updated; $('effect-name').textContent = updated.name; }
  renderMaterials();
}
// 保存名称、提示词和（可选的）新图片；没有改动时不发请求。
async function saveEdit(): Promise<Preset | undefined> {
  const preset = editing; if (!preset) return;
  const name = $<HTMLInputElement>('edit-name').value.trim(), prompt = $<HTMLTextAreaElement>('edit-prompt').value.trim(), error = $('edit-error');
  if (!name || !prompt) { error.textContent = '名称和提示词不能为空'; return; }
  if (name === preset.name && prompt === preset.prompt && !editFile) return preset;
  try {
    const updated = await upload<Preset>(`/api/materials/${preset.id}/update?${new URLSearchParams({ name, prompt })}`, editFile ?? new Blob([], { type: 'application/octet-stream' }));
    replacePreset(updated); return updated;
  } catch (failure) { error.textContent = failure instanceof Error ? failure.message : String(failure); }
}
$('edit-save').onclick = async () => {
  const updated = await saveEdit(); if (!updated) return;
  closeEditor(); status(`已保存素材「${updated.name}」。`);
};
$('edit-reset').onclick = async () => {
  const preset = editing; if (!preset || !confirm(`将「${preset.name}」恢复为默认的图片和提示词？`)) return;
  try { const restored = await upload<Preset>(`/api/materials/${preset.id}/reset`, new Blob([], { type: 'application/octet-stream' })); replacePreset(restored); closeEditor(); status(`已恢复「${restored.name}」的默认设置。`); }
  catch (failure) { $('edit-error').textContent = failure instanceof Error ? failure.message : String(failure); }
};
$('edit-use').onclick = async () => {
  if (capturing || savingCapture || processing()) return;
  if (!clip) { $('edit-error').textContent = '请先录制或上传一段视频，再点击「使用生成」'; return; }
  const updated = await saveEdit(); if (!updated) return;
  closeEditor(); select(updated); void generate();
};
window.addEventListener('pagehide', () => {
  cameraStream?.getTracks().forEach(t => t.stop());
  const lease = currentJob?.lease;
  if (lease) void fetch('/api/finish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lease }), keepalive: true });
});
void api<{ configured: boolean; transcode: boolean; presets: Preset[]; outputDirectory: string }>('/api/status').then(async config => {
  configured = config.configured; presets = config.presets; canTranscode = config.transcode; $('connection').textContent = configured ? 'X2.1 已配置' : '请配置 API Key';
  $('connection').classList.toggle('ready', configured); $('material-count').textContent = `${presets.length} 款`;
  $('save-path').textContent = `保存位置：${config.outputDirectory}`;
  renderFilters(); renderMaterials(); if (presets[0]) select(presets[0]); await history(true); controls();
}).catch(error => status(`初始化失败：${String(error)}`));
