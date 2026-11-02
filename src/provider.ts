import { ClipRecorder } from "./clip-recorder";
import {
  RealtimeConfiguration,
  RealtimeContext,
  RealtimeModel,
  RealtimeConnectionState,
  VideoContentMode,
  XmaxClient,
  XmaxConfiguration,
  XmaxEnvironment,
  XmaxRealtimeVideoView,
  RealtimeVideoFormat,
  type RealtimeTiming,
  type DownlinkVideoStatistics,
  type RemoteMediaTracks,
  type XmaxRealtimeManaging,
} from "@xmaxai/web-sdk";
import { loadImage, waitMedia, normalizeRecording, hasVisibleFrame, validateOutputVideo, type Source } from "./media";

export type Ticket = {
  lease: string;
  temporaryApiKey: string;
  environment: "china" | "global";
  outputSeconds: number;
  sessionSeconds: number;
};
export type Result = {
  photo?: string;
  video?: Blob;
  width: number;
  height: number;
  duration?: number;
  complete?: boolean;
  startupMs?: number;
  timing?: RealtimeTiming;
  transport?: DownlinkVideoStatistics;
  remoteUserID?: string;
  failure?: string;
};
export class TryOnSession {
  private manager?: XmaxRealtimeManaging;
  private view = new XmaxRealtimeVideoView({
    videoContentMode: VideoContentMode.fit,
    isInteractionEnabled: false,
  });
  private localView = new XmaxRealtimeVideoView({
    videoContentMode: VideoContentMode.fit,
    isInteractionEnabled: false,
  });
  private localContainer = document.createElement("div");
  private remoteVideo = document.createElement("video");
  private rawTrack?: MediaStreamTrack;
  private recorder?: MediaRecorder;
  private clipRecorder?: ClipRecorder;
  private recordTrack?: MediaStreamTrack;
  private recordTimer?: ReturnType<typeof setInterval>;
  private timer?: ReturnType<typeof setTimeout>;
  private frameTimer?: ReturnType<typeof setInterval>;
  private chunks: Blob[] = [];
  private stopped = false;
  private closing?: Promise<Result>;
  private result: Result = { width: 0, height: 0 };
  private startedFrames = false;
  private preparingRecording = false;
  private generating = false;
  private visibleFrames = 0;
  private recordedAt = 0;
  private inputVideo?: HTMLVideoElement;
  private inputStream?: MediaStream;
  private paintTimer?: ReturnType<typeof setInterval>;
  private targetSeconds = 0;
  cleanup: Promise<void> = Promise.resolve();
  constructor(
    private container: HTMLElement,
    private onStatus: (message: string) => void,
    private onReady: () => void,
    private onEnd: (result: Result, error?: string) => void,
  ) {
    this.remoteVideo.muted = true;
    this.remoteVideo.autoplay = true;
    this.remoteVideo.playsInline = true;
    this.remoteVideo.setAttribute("aria-label", "XMAX 远端试穿结果");
    this.remoteVideo.dataset.origin = "xmax-remote";
    container.append(this.remoteVideo);
    this.localContainer.setAttribute("aria-hidden", "true");
    Object.assign(this.localContainer.style, {
      position: "fixed",
      left: "-10000px",
      width: "16px",
      height: "16px",
      opacity: "0",
      pointerEvents: "none",
    });
    document.body.append(this.localContainer);
    this.localView.attach(this.localContainer);
    this.view.attach(this.localContainer); // SDK timing/preview warmup stays offscreen.
  }
  async start(
    ticket: Ticket,
    source: Source,
    reference: File,
    prompt: string,
  ) {
    const launched = performance.now();
    const mode = source.isVideo ? "video" : "photo";
    this.targetSeconds = source.isVideo ? source.duration : 0;
    if (source.isVideo && ticket.outputSeconds + 0.001 < source.duration)
      throw new Error("会话时长不足，已阻止生成被截短的视频");
    const client = new XmaxClient(
      new XmaxConfiguration({
        apiKey: ticket.temporaryApiKey,
        environment: XmaxEnvironment[ticket.environment],
      }),
    );
    const realtime = client.createRealtimeManager(
      new RealtimeConfiguration({
        model: RealtimeModel.x2_1,
        isAdaptiveQualityEnabled: false,
      }),
    );
    this.manager = realtime;
    realtime.setRemoteMediaTracksListener((tracks) => this.bindRemote(tracks));
    await realtime.setStateListener((state) => {
      if (this.stopped) return;
      window.dispatchEvent(
        new CustomEvent("xmirror:connection", {
          detail: {
            state: String(state.connectionState),
            failure: state.reason?.kind === "failure",
          },
        }),
      );
      if (state.reason?.kind === "failure")
        this.onEnd(this.result, "模型连接失败，请检查网络或余额后手动重试");
      if (state.connectionState === RealtimeConnectionState.generating) {
        this.generating = true;
        this.onStatus("正在接收试穿画面…");
      }
    });
    if (this.stopped) return;
    await realtime.setTimingListener((timing) => {
      this.result.timing = timing;
    });
    await realtime.setDownlinkVideoStatisticsListener((stats) => {
      if (stats) this.result.transport = stats;
    });
    this.onStatus("正在准备高清人物画面与服饰参考图…");
    // Prepare the source and upload the reference concurrently; neither depends on the other.
    const [stream, stored] = await Promise.all([
      this.prepareHDInput(realtime, source),
      client.createStorageService().uploadImage({
        data: reference, fileName: reference.name, contentType: reference.type,
      }),
    ]);
    if (this.stopped) return;
    this.localView.track = stream.videoTrack;
    this.onStatus("XMAX X2.1 正在为你试穿…");
    const remote = await realtime.startGeneration({
      localStream: stream,
      context: new RealtimeContext({ prompt, referencePath: stored.url }),
      faceRestoration: true,
    });
    if (this.stopped) return;
    this.view.track = remote.videoTrack;
    // Hold the original first frame through connection warmup. Never loop the source.
    this.frameTimer = setInterval(async () => {
      const video = this.remoteVideo;
      if (this.stopped || this.preparingRecording || !this.generating || !this.rawTrack || this.rawTrack.readyState !== "live") return;
      if (!hasVisibleFrame(video)) { this.visibleFrames = 0; return; }
      if (++this.visibleFrames < 3) return;
      this.result.width = video.videoWidth;
      this.result.height = video.videoHeight;
      if (!this.startedFrames) {
        this.preparingRecording = true;
        this.result.startupMs = performance.now() - launched;
        if (mode === "video") {
          try {
            await this.record(video);
            if (this.stopped) return;
            await this.inputVideo?.play();
            // The input starts first; let its first moving frames reach the
            // receiver before starting the fixed-length output timeline.
            const delay = Math.min(1500, Math.max(0, this.result.transport?.endToEndDelayMs ?? 250));
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
          catch (error) {
            this.onEnd(this.result, error instanceof Error ? error.message : "人物视频播放或录制失败");
            return;
          }
          if (this.stopped) return;
        }
        if (!hasVisibleFrame(video)) { this.onEnd(this.result, "远端试穿画面为空，请重新生成"); return; }
        this.recordedAt = performance.now();
        this.clipRecorder?.start(this.recordedAt);
        if (this.recorder) this.recorder.start(300);
        this.startedFrames = true;
        this.preparingRecording = false;
        this.onReady();
        this.timer = setTimeout(() => {
          this.result.complete = true;
          this.onEnd(this.result);
        }, (mode === "video" ? source.duration : 1) * 1000);
      }
      // For video, capture only a cover; do not repeatedly encode full-HD JPEGs.
      if (mode === "photo" || !this.result.photo) {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext("2d")!.drawImage(video, 0, 0);
        this.result.photo = canvas.toDataURL("image/jpeg", 0.95);
      }
    }, 50);
  }
  private bindRemote(tracks?: RemoteMediaTracks) {
    if (this.stopped) return;
    if (!tracks) {
      if (this.startedFrames) this.onEnd(this.result, "远端结果流已断开，未完成的短片已停止");
      this.rawTrack = undefined;
      this.remoteVideo.srcObject = null;
      return;
    }
    if (tracks.videoTrack === this.rawTrack) return;
    if (this.startedFrames) {
      this.onEnd(this.result, "远端结果流已更换，请重新生成完整短片");
      return;
    }
    this.rawTrack = tracks.videoTrack;
    this.result.remoteUserID = tracks.userID;
    this.remoteVideo.srcObject = new MediaStream([tracks.videoTrack]);
    tracks.videoTrack.addEventListener("ended", () => {
      if (!this.stopped) this.onEnd(this.result, "远端生成视频已中断");
    }, { once: true });
    void this.remoteVideo.play().catch(() =>
      this.onEnd(this.result, "浏览器无法播放远端试穿视频，请更换浏览器重试"));
  }
  private async prepareHDInput(realtime: XmaxRealtimeManaging, source: Source) {
    let media: HTMLVideoElement | HTMLImageElement;
    if (source.isVideo) {
      const video = document.createElement("video");
      this.inputVideo = video;
      video.muted = true;
      video.playsInline = true;
      video.loop = false;
      this.localContainer.append(video);
      const ready = waitMedia(video, "loadeddata");
      video.src = source.url;
      await ready;
      // Metadata/loadeddata alone can leave a paused video with blank pixels.
      // Seek into its first frame before drawing/publishing the HD canvas.
      const sought = waitMedia(video, "seeked");
      video.currentTime = Math.min(0.01, source.duration / 2);
      await sought;
      if (!hasVisibleFrame(video)) throw new Error("人物视频首帧为空，请更换视频或重新上传");
      media = video;
    } else media = await loadImage(source.url);
    if (this.stopped) throw new Error("会话已停止");
    const width = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
    const height = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
    const ratio = width / height;
    const sizes = [[1920,1080], [1080,1920], [1408,1408], [1152,1536], [1536,1152]];
    const [w,h] = sizes.sort((a,b) =>
      Math.abs(Math.log(ratio / (a[0]/a[1]))) - Math.abs(Math.log(ratio / (b[0]/b[1]))))[0];
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    const scale = Math.min(w/width, h/height);
    const draw = () => {
      ctx.fillStyle = "#fff"; ctx.fillRect(0,0,w,h);
      ctx.drawImage(media, (w-width*scale)/2, (h-height*scale)/2, width*scale, height*scale);
    };
    draw();
    this.paintTimer = setInterval(draw, 1000/30);
    this.inputStream = canvas.captureStream(30);
    return realtime.createExternalVideoStream({
      videoTrack: this.inputStream.getVideoTracks()[0],
      videoFormat: new RealtimeVideoFormat({
        width: w, height: h, fps: 30, minimumBitrate: 2000, maximumBitrate: 8000,
        encoderPreference: "maintainQuality" as RealtimeVideoFormat["encoderPreference"],
      }),
    });
  }
  private async record(video: HTMLVideoElement) {
    if (await ClipRecorder.supported(video.videoWidth, video.videoHeight)) {
      if (this.stopped) return;
      this.clipRecorder = new ClipRecorder(video, this.targetSeconds, () =>
        this.onEnd(this.result, "视频编码失败，请换用新版浏览器重试"));
      await this.clipRecorder.prepare();
      return;
    }
    if (!("MediaRecorder" in window)) throw new Error("浏览器不支持视频保存，请使用新版 Chrome、Edge 或 Safari");
    const stream = video.srcObject;
    if (!(stream instanceof MediaStream)) throw new Error("未收到可录制的视频流");
    const mime = ["video/webm;codecs=vp8", "video/webm", "video/mp4"].find(
      (type) => MediaRecorder.isTypeSupported(type),
    );
    if (!mime || !stream.getVideoTracks()[0]) throw new Error("浏览器不支持当前视频录制格式");
    try {
      // RTC tracks can contain discontinuous RTP timestamps. Re-sample displayed
      // remote pixels on the browser clock; preserve pauses without compressing time.
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d")!;
      this.localContainer.append(canvas);
      this.recordTrack = canvas.captureStream(30).getVideoTracks()[0];
      const paint = () => {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        (this.recordTrack as CanvasCaptureMediaStreamTrack).requestFrame?.();
      };
      paint();
      this.recordTimer = setInterval(paint, 1000 / 30);
      this.recorder = new MediaRecorder(new MediaStream([this.recordTrack]), {
        mimeType: mime,
        videoBitsPerSecond: 8_000_000,
      });
      this.recorder.ondataavailable = (event) => {
        if (event.data.size) this.chunks.push(event.data);
      };
      this.recorder.onerror = () => {
        this.result.complete = false;
        this.onEnd(this.result, "视频录制中断，未生成完整短片");
      };
    } catch {
      clearInterval(this.recordTimer);
      this.recordTrack?.stop();
      throw new Error("视频保存失败，请换用新版浏览器后重试");
    }
  }
  stop(): Promise<Result> {
    if (this.closing) return this.closing;
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.frameTimer);
    clearInterval(this.paintTimer);
    clearInterval(this.recordTimer);
    this.inputVideo?.pause();
    this.closing = (async () => {
      if (this.clipRecorder) {
        const elapsed = this.startedFrames ? Math.min(this.targetSeconds * 1000, performance.now() - this.recordedAt) : 0;
        this.result.duration = elapsed / 1000;
        if (elapsed < this.targetSeconds * 1000 - 100) this.result.complete = false;
        try {
          const blob = await this.clipRecorder.finish(elapsed);
          Object.assign(this.result, await validateOutputVideo(blob, elapsed / 1000));
          this.result.video = blob;
        }
        catch { this.result.failure = "视频保存失败，未生成可播放的完整短片"; this.result.complete = false; }
      }
      if (this.recorder && this.recorder.state !== "inactive") {
        const recorder = this.recorder;
        const elapsed = Math.min(this.targetSeconds * 1000, performance.now() - this.recordedAt);
        this.result.duration = elapsed / 1000;
        if (elapsed < this.targetSeconds * 1000 - 100) this.result.complete = false;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2500);
          recorder.addEventListener(
            "stop",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
          recorder.stop();
        });
        if (this.chunks.length) {
          const blob = await normalizeRecording(
            new Blob(this.chunks, { type: recorder.mimeType }),
            elapsed,
          );
          try {
            Object.assign(this.result, await validateOutputVideo(blob, elapsed / 1000));
            this.result.video = blob;
          } catch { this.result.failure = "视频保存失败，未生成时长正确且可播放的短片"; this.result.complete = false; }
        }
      }
      this.recordTrack?.stop();
      this.remoteVideo.pause();
      this.remoteVideo.srcObject = null;
      this.manager?.setRemoteMediaTracksListener(undefined);
      this.view.track = undefined;
      this.localView.track = undefined;
      this.cleanup = this.manager?.close().catch(() => {}) ?? Promise.resolve();
      this.inputStream?.getTracks().forEach((track) => track.stop());
      if (this.inputVideo) {
        this.inputVideo.removeAttribute("src"); this.inputVideo.load();
      }
      this.container.replaceChildren();
      this.localContainer.remove();
      return this.result;
    })();
    return this.closing;
  }
}
