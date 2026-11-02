// 非实时（离线）生成：浏览器只负责把视频和参考图上传到 Xmax 存储，
// 提交任务、轮询和下载结果都在本地后端用永久 Key 完成，Key 不会进入浏览器。
const redact = text => String(text).replace(/\b(?:uk|tk)-[A-Za-z0-9_-]+/g, '[redacted]');

// 默认复用实时接口的网关（cloud.xmax.22duck.cn 同样提供 /offline-task，公司代理可达）；可用 XMAX_OFFLINE_API_BASE_URL 覆盖。
export function createOffline({ env, store, base: defaultBase, request = fetch, intervalMs = 3000, timeoutMs = 10 * 60 * 1000 }) {
  const base = (env.XMAX_OFFLINE_API_BASE_URL?.trim() || defaultBase).replace(/\/$/, '');
  const model = env.XMAX_OFFLINE_MODEL?.trim() || 'x2.1';
  const quality = env.XMAX_OFFLINE_QUALITY?.trim() || 'hd';
  // 离线接口的处理帧率；不传时由服务端决定（官方示例传 24）。取值范围与官方 SDK 一致。
  const fps = Number(env.XMAX_OFFLINE_FPS?.trim() || 24);
  if (![8, 10, 12, 15, 16, 18, 20, 22, 24, 25, 30, 45, 48, 50, 60, 72, 90, 100, 120].includes(fps)) throw new Error('XMAX_OFFLINE_FPS 不是离线接口支持的帧率');
  const running = new Map();
  const call = async (method, path, body) => {
    const response = await request(`${base}${path}`, {
      method, headers: { 'X-Api-Key': env.XMAX_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    const text = await response.text(); let result;
    try { result = JSON.parse(text); } catch { throw new Error(`Xmax 返回了无法解析的内容（HTTP ${response.status}）`); }
    const ok = response.ok && (result.success === true || (result.success === undefined && result.code === 200));
    if (!ok || result.data == null) throw new Error(`Xmax 离线任务失败：${redact(result.message || `HTTP ${response.status}`)}（业务码 ${result.code ?? '未知'}）`);
    return result.data;
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function watch(clipId, runId, uid) {
    const deadline = Date.now() + timeoutMs; let failures = 0;
    try {
      while (Date.now() < deadline) {
        await sleep(intervalMs);
        let task;
        try { task = await call('GET', `/offline-task/${encodeURIComponent(uid)}`); failures = 0; }
        catch (error) { if (++failures > 5) throw error; continue; }
        await store.progress(clipId, runId, { taskStatus: task.status, requestedFps: task.requestedFps, resolvedFps: task.resolvedFps });
        if (task.status === 'error') throw new Error(`生成失败：${redact(task.errorMessage || task.error || task.failReason || task.message || '服务端返回 error')}`);
        if (task.status !== 'completed') continue;
        const url = task.result?.result_url;
        if (!url) throw new Error(`任务已完成但没有结果地址${task.result?.upload_error ? `：${redact(task.result.upload_error)}` : ''}`);
        await store.progress(clipId, runId, { resultFps: task.result.fps, resultFrames: task.result.frame_count, droppedFrames: task.result.dropped_frame_count });
        const download = await request(url, { signal: AbortSignal.timeout(120000) });
        if (!download.ok) throw new Error(`下载结果失败：HTTP ${download.status}`);
        const buffer = Buffer.from(await download.arrayBuffer());
        await store.saveOutput(clipId, runId, buffer, download.headers.get('content-type')?.startsWith('video/webm') ? 'video/webm' : 'video/mp4');
        return;
      }
      throw new Error('等待生成超时（10 分钟）。任务可能仍在服务端处理，可稍后在平台查询。');
    } catch (error) {
      await store.update(clipId, runId, { status: 'failed', error: redact(error.message) }).catch(() => {});
    } finally { running.delete(runId); }
  }
  return {
    config: { base, model, quality, fps },
    // 每个 run 只提交一次，避免重复扣费。
    async submit(clipId, runId, { videoPath, referencePath, prompt }) {
      if (!env.XMAX_API_KEY?.trim()) throw new Error('请先在 .env 配置 XMAX_API_KEY，然后重启');
      const run = await store.readRun(clipId, runId);
      if (run.taskUid || run.status !== 'preparing') throw new Error('该任务已提交，请新建一次处理');
      if ([...run.prompt].length > 1024) throw new Error('离线生成的提示词不能超过 1024 字');
      for (const url of [videoPath, referencePath]) if (url !== undefined && !/^https:\/\//.test(url)) throw new Error('上传地址无效');
      const task = await call('POST', '/offline-task', {
        model, prompt: run.prompt, refVideoPath: videoPath, ...(referencePath ? { refImagePath: referencePath } : {}), quality, fps,
      });
      if (!task?.uid) throw new Error('提交响应缺少任务编号');
      await store.progress(clipId, runId, { status: 'generating', taskUid: task.uid, taskStatus: task.status });
      running.set(runId, watch(clipId, runId, task.uid));
      return store.readRun(clipId, runId);
    },
    idle: () => Promise.allSettled([...running.values()]),
  };
}
