import { XmaxClient, XmaxConfiguration, XmaxEnvironment, RealtimeConfiguration, RealtimeModel, RealtimeContext,
  RealtimeConnectionState, XmaxRealtimeVideoView, VideoContentMode, defaultCameraVideoFormat,
  type RemoteMediaTracks, type XmaxRealtimeManaging } from '@xmaxai/web-sdk';
import './style.css';

type Preset = { id: string; name: string; category: string; image: string; prompt: string; referenceUrl?: string | null };
type Clip = { id: string; seconds: number; inputUrl: string; directory: string; createdAt: string };
type Run = { id: string; clipId: string; presetId: string; presetName: string; prompt: string; status: string; videoUrl?: string; previewUrl?: string; directory: string; duration?: number; error?: string };
type Ticket = { lease: string; temporaryApiKey: string; environment: 'china' | 'global'; sessionSeconds: number };
type Job = { run: Run; clip: Clip; manager?: XmaxRealtimeManaging; lease?: string; keyRequest?: Promise<Ticket>; generating: boolean;
  tracks?: RemoteMediaTracks; recorder?: MediaRecorder; recording?: Promise<Blob>; timers: ReturnType<typeof setTimeout>[];
  poll?: ReturnType<typeof setInterval>; finishing?: Promise<void>; recordingTracks?: MediaStreamTrack[]; done: boolean };
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
$('app').innerHTML = `
<header class="topbar"><a class="brand" href="/">X<span>MAX</span><i></i><small>CAMERA STUDIO</small></a><span id="connection" class="connection">读取配置…</span></header>
<main class="workspace"><div class="intro"><span class="eyebrow">拍一小段，换一种效果</span><h1>你的镜头，新的可能。</h1><p>录制 3–10 秒视频，点击右侧素材，用 Xmax X2.1 生成新的画面。</p></div>
<section class="capture-bar"><div class="camera-controls"><button id="camera" class="button secondary">打开摄像头</button><select id="camera-device" aria-label="摄像头"><option value="">默认摄像头</option></select></div><label class="duration-control">录制时长 <input id="duration" type="range" min="3" max="10" value="5"><b id="duration-label">5 秒</b></label><button id="record" class="button record" disabled><span class="record-dot"></span>录制短片</button><button id="close-camera" class="text-button" disabled>关闭摄像头</button></section>
<section class="stage"><article class="video-card"><div class="card-heading"><h2>原始视频</h2><span id="input-badge" class="badge">未录制</span></div><div class="video-box"><video id="camera-video" autoplay muted playsinline hidden></video><video id="input-video" controls muted playsinline loop hidden></video><div id="camera-empty" class="empty"><div class="empty-icon">◉</div><strong>先录下你的动作</strong><span>打开摄像头，保持光线明亮、主体清晰</span></div><div id="countdown" class="countdown" hidden></div></div><div class="video-footer"><span id="input-info">录制后自动保存原视频</span><a id="input-download" hidden download>下载原片 ↓</a></div></article>
<article class="video-card"><div class="card-heading"><h2>生成视频</h2><span id="output-badge" class="badge">等待素材</span></div><div class="video-box"><div id="remote" hidden></div><video id="output-video" controls playsinline loop hidden></video><div id="output-empty" class="empty"><div class="empty-icon">✦</div><strong>点击右侧素材试试</strong><span>人脸、帽子、服装、背景，都准备好了</span></div><div id="working" class="working" hidden><span class="spinner"></span><b id="working-text">连接 XMAX…</b></div></div><div class="video-footer"><span id="output-info">生成后自动保存至本地</span><a id="output-download" hidden download>下载结果 ↓</a></div></article></section>
<section class="prompt-card"><div class="prompt-heading"><div><span class="eyebrow">当前效果</span><h2 id="effect-name">选择素材</h2></div><div class="prompt-actions"><button id="generate" class="button primary" disabled>生成当前效果</button><button id="cancel" class="button secondary" disabled>停止处理</button></div></div><textarea id="prompt" rows="2" aria-label="提示词" maxlength="2000"></textarea><p id="status" role="status">打开摄像头开始录制，录制和浏览素材不会消耗生成额度。</p></section>
<section class="history-section"><div class="history-heading"><h2>最近保存</h2><button id="folder" class="text-button">打开本地保存目录 ↗</button></div><div id="history" class="history"><span class="history-empty">生成的短片会出现在这里，刷新页面也会保留。</span></div><p class="save-path" id="save-path"></p></section></main>
<aside class="material-dock" aria-label="预置素材悬浮窗"><div class="dock-heading"><div><span class="eyebrow">准备好的素材</span><h2>换个效果</h2></div><span id="material-count"></span></div><p class="dock-hint">录制后，点击素材直接生成</p><div id="filters" class="filters"></div><div id="materials" class="materials"></div><div class="dock-footer">图片与提示词已配对<br>同一段视频可以反复尝试</div></aside>
<dialog id="preview-dialog"><button id="preview-close" class="preview-close" aria-label="关闭预览">×</button><img id="preview-image" alt="素材大图"><p id="preview-name"></p></dialog>`;

let presets: Preset[] = [], selected: Preset | undefined, clip: Clip | undefined, cameraStream: MediaStream | undefined;
let capturing = false, opening = false, configured = false, savingCapture = false;
let currentJob: Job | undefined, generationStarting = false, filter = '全部';
let outputUrl: string | undefined;
const remoteView = new XmaxRealtimeVideoView({ videoContentMode: VideoContentMode.fit, isInteractionEnabled: false });
remoteView.attach($('remote'));
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
  $<HTMLInputElement>('duration').disabled = locked;
  $<HTMLSelectElement>('camera-device').disabled = locked || opening;
  $<HTMLTextAreaElement>('prompt').disabled = locked;
  $<HTMLButtonElement>('generate').disabled = locked || !clip || !selected || !configured;
  $<HTMLButtonElement>('cancel').disabled = !currentJob || currentJob.done || !!currentJob.finishing;
  for (const button of document.querySelectorAll<HTMLButtonElement>('.material-use')) button.disabled = locked;
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
    const use = document.createElement('button'); use.className = 'material-use'; use.title = `${preset.name}：录制后点击生成`;
    const image = document.createElement('img'); image.src = preset.image; image.alt = preset.name; image.loading = 'lazy';
    const label = document.createElement('div'); label.className = 'material-label'; const name = document.createElement('strong'); name.textContent = preset.name;
    const hint = document.createElement('span'); hint.textContent = '点击使用 →'; label.append(name, hint); use.append(image, label);
    use.onclick = () => { if (capturing || savingCapture || processing()) return; select(preset); if (clip) void generate(); else status(`已选择「${preset.name}」，请先录制一段视频。`); };
    const preview = document.createElement('button'); preview.className = 'material-preview'; preview.textContent = '↗'; preview.title = '查看素材大图'; preview.setAttribute('aria-label', `预览${preset.name}`);
    preview.onclick = () => { $<HTMLImageElement>('preview-image').src = preset.image; $('preview-name').textContent = preset.name; $<HTMLDialogElement>('preview-dialog').showModal(); };
    card.append(use, preview); $('materials').append(card);
  }
  for (const card of document.querySelectorAll<HTMLElement>('.material-card')) card.classList.toggle('selected', card.dataset.id === selected?.id);
  controls();
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
  $('remote').hidden = true; $('output-empty').hidden = true; $('working').hidden = true;
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
    const stream = await navigator.mediaDevices.getUserMedia({ video: { ...(device ? { deviceId: { exact: device } } : {}), width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24 } }, audio: false });
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
    const recorder = new MediaRecorder(cameraStream, { mimeType: type, videoBitsPerSecond: 5000000 });
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
    status(`已录制并保存 ${duration} 秒原片。点击右侧素材即可生成。`);
  } catch (error) { status(`录制或保存失败：${String(error)}`); }
  finally { capturing = false; savingCapture = false; $('countdown').hidden = true; controls(); }
}
async function fileAt(url: string): Promise<File> {
  const response = await fetch(url); if (!response.ok) throw new Error('无法读取已保存素材'); const blob = await response.blob();
  return new File([blob], url.split('/').pop()!, { type: blob.type });
}
function working(message: string) { $('working').hidden = false; $('working-text').textContent = message; status(message); }
async function finish(job: Job, reason: 'complete' | 'cancelled' | 'failed', error?: string) {
  if (job.finishing) return job.finishing;
  job.finishing = (async () => {
    job.done = true; job.timers.forEach(clearTimeout); clearInterval(job.poll); controls();
    if (reason === 'cancelled') working('正在停止并释放会话…');
    const release = async () => {
      const request = job.keyRequest; job.keyRequest = undefined;
      const lateTicket = request ? await request.catch(() => undefined) : undefined;
      const lease = job.lease || lateTicket?.lease, manager = job.manager; job.lease = undefined; job.manager = undefined;
      await Promise.allSettled([manager?.close(), lease ? api('/api/finish', { lease }) : Promise.resolve()]);
      job.recordingTracks?.forEach(track => track.stop()); remoteView.track = undefined; $('remote').hidden = true;
    };
    try {
      let blob: Blob | undefined;
      if (job.recorder?.state === 'recording') job.recorder.stop();
      if (job.recording) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { blob = await Promise.race([job.recording, new Promise<Blob>((_, reject) => { timer = setTimeout(() => reject(new Error('结果录制停止超时')), 8000); })]); }
        finally { clearTimeout(timer); }
      }
      await release();
      if (blob?.size && reason !== 'failed') {
        working('生成结束，正在保存视频到本地…');
        const saved = await upload<Run>(`/api/clips/${job.clip.id}/runs/${job.run.id}/output`, blob);
        showOutput(saved); status(reason === 'cancelled' ? '已停止处理，已收到的片段已保存。' : '生成视频已保存。可以点击另一张素材，继续处理同一段原片。');
        await history();
      } else {
        await api(`/api/clips/${job.clip.id}/runs/${job.run.id}`, { status: reason === 'cancelled' ? 'cancelled' : 'failed', error: redact(error || '没有收到可保存的生成视频') });
        $('working').hidden = true; $('output-badge').textContent = reason === 'cancelled' ? '已停止' : '生成失败';
        if (outputUrl) { $<HTMLVideoElement>('output-video').src = outputUrl; $('output-video').hidden = false; } else $('output-empty').hidden = false;
        status(reason === 'cancelled' ? '已停止。原视频仍可继续使用。' : `本次处理失败：${error || '未收到视频'}。没有自动重试，原片已保留。`);
      }
    } catch (failure) {
      await release();
      $('working').hidden = true; $('output-badge').textContent = '保存失败';
      status(`处理已停止，但保存失败：${redact(String(failure))}`);
      await api(`/api/clips/${job.clip.id}/runs/${job.run.id}`, { status: 'failed', error: redact(String(failure)) }).catch(() => {});
    } finally { if (currentJob === job) currentJob = undefined; controls(); }
  })();
  return job.finishing;
}
function maybeRecord(job: Job) {
  if (job.done || job.recorder || !job.generating || !job.tracks) return;
  const rendered = $('remote').querySelector('video');
  if (!rendered || rendered.readyState < 2 || !rendered.videoWidth) return;
  const type = ['video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find(t => MediaRecorder.isTypeSupported(t));
  if (!type) { void finish(job, 'failed', '浏览器不支持结果录制'); return; }
  try {
    const clones = [job.tracks.videoTrack.clone()]; job.recordingTracks = clones;
    const recorder = new MediaRecorder(new MediaStream(clones), { mimeType: type, videoBitsPerSecond: 6000000 }); job.recorder = recorder;
    job.recording = new Promise<Blob>(resolve => {
      const chunks: Blob[] = [];
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = () => { clones.forEach(t => t.stop()); resolve(new Blob(chunks, { type })); };
      recorder.onerror = () => { void finish(job, 'failed', '结果录制失败'); };
    });
    recorder.start(250); clearInterval(job.poll); $('working').hidden = true; $('output-badge').textContent = '正在生成';
    status(`正在录制 ${job.clip.seconds} 秒生成结果，结束后自动保存。`);
    job.timers.push(setTimeout(() => void finish(job, 'complete'), job.clip.seconds * 1000));
  } catch (error) { void finish(job, 'failed', String(error)); }
}
async function generate() {
  if (!clip || !selected || processing() || capturing || savingCapture) return;
  if (!configured) { status('请在工具目录的 .env 中配置 XMAX_API_KEY，然后重启工具'); return; }
  const inputClip = clip, preset = selected, prompt = $<HTMLTextAreaElement>('prompt').value.trim();
  if (!prompt) { status('请填写提示词'); return; }
  generationStarting = true; controls();
  $('output-badge').textContent = '准备中'; $('output-video').hidden = true; $('output-empty').hidden = true; $('output-download').hidden = true;
  working('准备读取录制视频…');
  let job: Job | undefined;
  try {
    const input = await fileAt(inputClip.inputUrl);
    const run = await api<Run>('/api/runs', { clipId: inputClip.id, presetId: preset.id, prompt });
    job = { run, clip: inputClip, generating: false, timers: [], done: false }; currentJob = job; generationStarting = false; controls();
    $('output-video').hidden = true; $('output-empty').hidden = true; $('output-download').hidden = true; $('output-badge').textContent = preset.name;
    const check = () => !job!.done && currentJob === job;
    const acquire = async () => {
      job!.keyRequest = api<Ticket>('/api/start', { clipId: inputClip.id, runId: run.id });
      const ticket = await job!.keyRequest;
      if (!check()) { if (job!.finishing) await job!.finishing; else await api('/api/finish', { lease: ticket.lease }); return undefined; }
      job!.lease = ticket.lease;
      job!.timers.push(setTimeout(() => void finish(job!, 'failed', '达到会话时长上限'), ticket.sessionSeconds * 1000));
      return ticket;
    };
    working('准备 XMAX 连接…'); let ticket = await acquire(); if (!ticket) return;
    let client = new XmaxClient(new XmaxConfiguration({ apiKey: ticket.temporaryApiKey, environment: XmaxEnvironment[ticket.environment] }));
    let referencePath = preset.referenceUrl || undefined;
    if (!referencePath) {
      working('上传参考图…'); const reference = await fileAt(preset.image);
      referencePath = (await client.createStorageService().uploadImage({ data: reference, fileName: reference.name, contentType: reference.type })).url;
      if (!check()) return;
      job.timers.forEach(clearTimeout); job.timers = [];
      await api('/api/finish', { lease: ticket.lease }); job.lease = undefined;
      if (!check()) return;
      ticket = await acquire(); if (!ticket) return;
      client = new XmaxClient(new XmaxConfiguration({ apiKey: ticket.temporaryApiKey, environment: XmaxEnvironment[ticket.environment] }));
    }
    if (!check()) return;
    const manager = client.createRealtimeManager(new RealtimeConfiguration({ model: RealtimeModel.x2_1, isAdaptiveQualityEnabled: true })); job.manager = manager;
    await manager.setStateListener(state => {
      if (!check()) return;
      if (state.reason?.kind === 'failure') void finish(job!, 'failed', redact(state.reason.error.message));
      if (state.connectionState === RealtimeConnectionState.generating) { job!.generating = true; maybeRecord(job!); }
    });
    manager.setRemoteMediaTracksListener(tracks => { if (check()) { job!.tracks = tracks; maybeRecord(job!); } });
    const stream = await manager.createLocalVideoStream({ file: input, videoFormat: defaultCameraVideoFormat(RealtimeModel.x2_1), loop: true, includeAudio: false });
    if (!check()) { await manager.close(); return; }
    working(`正在处理「${preset.name}」，等待生成画面…`);
    await api(`/api/clips/${inputClip.id}/runs/${run.id}`, { status: 'generating' });
    const remote = await manager.startGeneration({ localStream: stream, context: new RealtimeContext({ prompt, referencePath }), faceRestoration: false });
    if (!check()) { await manager.close(); return; }
    remoteView.track = remote.videoTrack; $('remote').hidden = false;
    job.poll = setInterval(() => maybeRecord(job!), 50); maybeRecord(job);
  } catch (error) {
    if (job && !job.done) await finish(job, 'failed', redact(error instanceof Error ? error.message : String(error)));
    else if (!job) {
      $('working').hidden = true; $('output-badge').textContent = '启动失败';
      if (outputUrl) $('output-video').hidden = false; else $('output-empty').hidden = false;
      status(`无法启动处理：${redact(String(error))}`);
    }
  } finally { generationStarting = false; controls(); }
}
$('camera').onclick = () => void openCamera(); $('close-camera').onclick = closeCamera;
$('camera-device').onchange = () => void openCamera(); $('record').onclick = () => void record();
$('duration').oninput = () => { $('duration-label').textContent = `${$<HTMLInputElement>('duration').value} 秒`; };
$('generate').onclick = () => void generate(); $('cancel').onclick = () => { if (currentJob) void finish(currentJob, 'cancelled'); };
$('folder').onclick = () => void api<{ path: string }>('/api/open-folder', {}).then(result => status(`保存目录：${result.path}`)).catch(error => status(String(error)));
$('preview-close').onclick = () => $<HTMLDialogElement>('preview-dialog').close();
window.addEventListener('pagehide', () => {
  cameraStream?.getTracks().forEach(t => t.stop());
  const lease = currentJob?.lease;
  if (lease) void fetch('/api/finish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lease }), keepalive: true });
  void currentJob?.manager?.close();
});
void api<{ configured: boolean; presets: Preset[]; outputDirectory: string }>('/api/status').then(async config => {
  configured = config.configured; presets = config.presets; $('connection').textContent = configured ? 'X2.1 已配置' : '请配置 API Key';
  $('connection').classList.toggle('ready', configured); $('material-count').textContent = `${presets.length} 款`;
  $('save-path').textContent = `保存位置：${config.outputDirectory}`;
  renderFilters(); renderMaterials(); if (presets[0]) select(presets[0]); await history(true); controls();
}).catch(error => status(`初始化失败：${String(error)}`));
