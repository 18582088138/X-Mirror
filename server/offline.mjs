// 视频试穿走 Xmax 离线（非实时）高清任务：浏览器只把视频和参考图上传到 Xmax 存储，
// 提交、轮询和下载结果都在本地后端用永久 Key 完成，Key 不进入浏览器。
import { ApiError } from "./api.mjs";

const redact = (text) => String(text).replace(/\b(?:uk|tk)-[A-Za-z0-9_-]+/g, "[redacted]");
const FPS = [8, 10, 12, 15, 16, 18, 20, 22, 24, 25, 30, 45, 48, 50, 60, 72, 90, 100, 120];

export function createOffline({ env, base, request = fetch }) {
  const model = env.XMAX_OFFLINE_MODEL?.trim() || "x2.1";
  const quality = env.XMAX_OFFLINE_QUALITY?.trim() || "hd";
  // 与官方示例一致，默认 24fps。
  const fps = Number(env.XMAX_OFFLINE_FPS?.trim() || 24);
  if (!FPS.includes(fps)) throw new Error("XMAX_OFFLINE_FPS 不是离线接口支持的帧率");
  const root = (env.XMAX_OFFLINE_API_BASE_URL?.trim() || base).replace(/\/$/, "");
  const tasks = new Map(); // uid -> owner，只允许提交者查询和下载。
  const call = async (method, path, body) => {
    let response;
    try {
      response = await request(`${root}${path}`, {
        method,
        headers: { "X-Api-Key": env.XMAX_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new ApiError("生成服务连接超时或网络不可用，请检查代理后手动重试", 502);
    }
    let result;
    try { result = JSON.parse(await response.text()); }
    catch { throw new ApiError(`生成服务返回了无法解析的内容（HTTP ${response.status}）`, 502); }
    const ok = response.ok && (result.success === true || (result.success === undefined && result.code === 200));
    if (!ok || result.data == null)
      throw new ApiError(`生成任务失败：${redact(result.message || `HTTP ${response.status}`)}（业务码 ${result.code ?? "未知"}）`, 502);
    return result.data;
  };
  const own = (owner, uid) => {
    if (typeof uid !== "string" || tasks.get(uid) !== owner) throw new ApiError("无法操作此生成任务", 403);
    return uid;
  };
  return {
    config: { model, quality, fps },
    // 每次点击只提交一次，不自动重试，避免重复扣费。
    async submit(owner, { videoPath, referencePath, prompt }) {
      if (!env.XMAX_API_KEY?.trim()) throw new ApiError("服务尚未配置试穿 API");
      if (typeof prompt !== "string" || !prompt.trim() || [...prompt].length > 1024)
        throw new ApiError("提示词不能为空，且不能超过 1024 字");
      for (const url of [videoPath, referencePath])
        if (typeof url !== "string" || !/^https:\/\//.test(url)) throw new ApiError("上传地址无效");
      const task = await call("POST", "/offline-task", {
        model, prompt: prompt.trim(), refVideoPath: videoPath, refImagePath: referencePath, quality, fps,
      });
      if (!task?.uid) throw new ApiError("提交响应缺少任务编号", 502);
      tasks.set(task.uid, owner);
      if (tasks.size > 200) tasks.delete(tasks.keys().next().value);
      return { uid: task.uid, status: task.status };
    },
    async status(owner, uid) {
      const task = await call("GET", `/offline-task/${encodeURIComponent(own(owner, uid))}`);
      if (task.status === "error")
        return { status: "error", error: redact(task.errorMessage || task.error || task.failReason || task.message || "服务端返回 error") };
      return {
        status: task.status,
        ready: task.status === "completed" && Boolean(task.result?.result_url),
        resolvedFps: task.resolvedFps, resultFps: task.result?.fps, frames: task.result?.frame_count, dropped: task.result?.dropped_frame_count,
      };
    },
    async result(owner, uid) {
      const task = await call("GET", `/offline-task/${encodeURIComponent(own(owner, uid))}`);
      const url = task.result?.result_url;
      if (task.status !== "completed" || !url) throw new ApiError("生成结果尚未就绪", 409);
      let response;
      try { response = await request(url, { signal: AbortSignal.timeout(120000) }); }
      catch { throw new ApiError("下载生成结果超时，请手动重试", 502); }
      if (!response.ok) throw new ApiError(`下载生成结果失败：HTTP ${response.status}`, 502);
      return {
        data: Buffer.from(await response.arrayBuffer()),
        type: response.headers.get("content-type")?.startsWith("video/webm") ? "video/webm" : "video/mp4",
      };
    },
  };
}
