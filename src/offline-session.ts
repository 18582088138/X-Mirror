import { XmaxClient, XmaxConfiguration, XmaxEnvironment } from "@xmaxai/web-sdk";
import { validateOutputVideo, type Source } from "./media";
import type { Ticket, Result } from "./provider";

const WAIT_LIMIT_MS = 8 * 60 * 1000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const videoType = (file: File) =>
  file.type.startsWith("video/") ? file.type.split(";")[0]
    : /\.mov$/i.test(file.name) ? "video/quicktime"
    : /\.webm$/i.test(file.name) ? "video/webm" : "video/mp4";

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（HTTP ${response.status}）`);
  return data as T;
}

// 视频试穿走离线（非实时）高清任务：没有实时回传和录屏，因此不会掉帧或被会话时长截断。
// 接口与 TryOnSession 保持一致，主流程无需区分。
export class OfflineSession {
  cleanup: Promise<void> = Promise.resolve();
  private stopped = false;
  private result: Result = { width: 0, height: 0 };
  constructor(
    private onStatus: (message: string) => void,
    private onEnd: (result: Result, error?: string) => void,
  ) {}
  private alive() {
    if (this.stopped) throw new Error("已停止");
  }
  async start(ticket: Ticket, source: Source, reference: File, prompt: string) {
    try {
      this.onStatus("正在校准视频帧率…");
      const normalized = await this.normalize(source.file);
      this.alive();
      const client = new XmaxClient(new XmaxConfiguration({
        apiKey: ticket.temporaryApiKey,
        environment: XmaxEnvironment[ticket.environment],
      }));
      const storage = client.createStorageService();
      this.onStatus("正在上传视频和参考图…");
      const [video, image] = await Promise.all([
        storage.uploadVideo({ data: normalized.file, fileName: normalized.file.name, contentType: normalized.file.type }),
        storage.uploadImage({ data: reference, fileName: reference.name, contentType: reference.type }),
      ]);
      this.alive();
      // 上传完成后立即撤销临时凭证；提交、轮询和下载由本地后端完成。
      void fetch("/api/finish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lease: ticket.lease }) }).catch(() => {});
      this.onStatus("正在提交高清生成任务…");
      const task = await post<{ uid: string }>("/api/offline", { videoPath: video.url, referencePath: image.url, prompt });
      this.alive();
      await this.wait(task.uid);
      this.onStatus("正在下载生成结果…");
      const response = await fetch("/api/offline/result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uid: task.uid }) });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "下载生成结果失败");
      const blob = await response.blob();
      this.alive();
      const checked = await validateOutputVideo(blob, normalized.duration || source.duration);
      this.result = { ...checked, video: blob, complete: true };
      this.onEnd(this.result);
    } catch (error) {
      if (!this.stopped) this.onEnd(this.result, error instanceof Error ? error.message : String(error));
    }
  }
  // FFmpeg 可用时转成 30fps 恒定帧率 MP4；不可用则沿用原文件。
  private async normalize(file: File): Promise<{ file: File; duration: number }> {
    const type = videoType(file);
    const response = await fetch("/api/video/normalize", { method: "POST", headers: { "Content-Type": type }, body: file });
    if (response.status === 501) return { file: new File([file], file.name, { type }), duration: 0 };
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "视频转换失败");
    const blob = await response.blob();
    return { file: new File([blob], "source.mp4", { type: "video/mp4" }), duration: Number(response.headers.get("X-Video-Duration")) || 0 };
  }
  private async wait(uid: string) {
    const started = Date.now();
    let failures = 0;
    while (Date.now() - started < WAIT_LIMIT_MS) {
      await sleep(1000);
      this.alive();
      let task: { status: string; ready?: boolean; error?: string };
      try { task = await post("/api/offline/status", { uid }); failures = 0; }
      catch (error) { if (++failures > 5) throw error; continue; }
      if (task.status === "error") throw new Error(`生成失败：${task.error || "服务端返回 error"}`);
      if (task.ready) return;
      this.onStatus(`服务端高清生成中（${task.status === "processing" ? "处理中" : "排队中"}），已等待 ${Math.round((Date.now() - started) / 1000)} 秒…`);
    }
    throw new Error("等待生成超时（8 分钟）。任务可能仍在服务端处理，请稍后手动重试。");
  }
  async stop(): Promise<Result> {
    this.stopped = true;
    return this.result;
  }
}
