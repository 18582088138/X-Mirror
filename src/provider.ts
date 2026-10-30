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
  defaultCameraVideoFormat,
  type XmaxRealtimeManaging,
} from "@xmaxai/web-sdk";
import { imageFile, normalizeRecording, type Source } from "./media";

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
  private recorder?: MediaRecorder;
  private recordTrack?: MediaStreamTrack;
  private timer?: ReturnType<typeof setTimeout>;
  private frameTimer?: ReturnType<typeof setInterval>;
  private chunks: Blob[] = [];
  private stopped = false;
  private closing?: Promise<Result>;
  private result: Result = { width: 0, height: 0 };
  private startedFrames = false;
  private recordedAt = 0;
  constructor(
    private container: HTMLElement,
    private onStatus: (message: string) => void,
    private onReady: () => void,
    private onEnd: (result: Result, error?: string) => void,
  ) {
    this.view.attach(container);
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
  }
  async start(
    ticket: Ticket,
    source: Source,
    mode: "photo" | "video",
    reference: File,
    prompt: string,
  ) {
    const client = new XmaxClient(
      new XmaxConfiguration({
        apiKey: ticket.temporaryApiKey,
        environment: XmaxEnvironment[ticket.environment],
      }),
    );
    const realtime = client.createRealtimeManager(
      new RealtimeConfiguration({
        model: RealtimeModel.x2_1,
        isAdaptiveQualityEnabled: true,
      }),
    );
    this.manager = realtime;
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
      if (state.connectionState === RealtimeConnectionState.generating)
        this.onStatus("正在接收试穿画面…");
    });
    if (this.stopped) return;
    this.onStatus("正在准备人物画面…");
    const stream = source.isVideo
      ? await realtime.createLocalVideoStream({
          file: source.file,
          loop: true,
          includeAudio: false,
          videoFormat: defaultCameraVideoFormat(RealtimeModel.x2_1),
        })
      : await realtime.createLocalImageStream({
          file: await imageFile(source.poster, "person.jpg"),
          videoFormat: defaultCameraVideoFormat(RealtimeModel.x2_1),
        });
    if (this.stopped) return;
    this.localView.track = stream.videoTrack;
    this.onStatus("正在上传服饰参考图…");
    const stored = await client.createStorageService().uploadImage({
      data: reference,
      fileName: reference.name,
      contentType: reference.type,
    });
    if (this.stopped) return;
    this.onStatus("XMAX X2.1 正在为你试穿…");
    const remote = await realtime.startGeneration({
      localStream: stream,
      context: new RealtimeContext({ prompt, referencePath: stored.url }),
      faceRestoration: true,
    });
    if (this.stopped) return;
    this.view.track = remote.videoTrack;
    // Start output timing only when a decoded remote frame is actually displayed.
    this.frameTimer = setInterval(() => {
      const video = this.view.videoElement;
      if (this.stopped || video.readyState < 2 || !video.videoWidth) return;
      if (!this.startedFrames) {
        this.startedFrames = true;
        this.onReady();
        if (mode === "video") this.record(video);
        this.timer = setTimeout(
          () => this.onEnd(this.result),
          (mode === "photo"
            ? Math.min(3, ticket.outputSeconds)
            : ticket.outputSeconds) * 1000,
        );
      }
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")!.drawImage(video, 0, 0);
      this.result = {
        ...this.result,
        photo: canvas.toDataURL("image/jpeg", 0.95),
        width: canvas.width,
        height: canvas.height,
      };
    }, 300);
  }
  private record(video: HTMLVideoElement) {
    if (!("MediaRecorder" in window)) return;
    const stream = video.srcObject;
    if (!(stream instanceof MediaStream)) return;
    const mime = ["video/webm;codecs=vp8", "video/webm", "video/mp4"].find(
      (type) => MediaRecorder.isTypeSupported(type),
    );
    if (!mime || !stream.getVideoTracks()[0]) return;
    try {
      this.recordTrack = stream.getVideoTracks()[0].clone();
      this.recorder = new MediaRecorder(new MediaStream([this.recordTrack]), {
        mimeType: mime,
      });
      this.recorder.ondataavailable = (event) => {
        if (event.data.size) this.chunks.push(event.data);
      };
      this.recorder.start(300);
      this.recordedAt = Date.now();
    } catch {
      this.recordTrack?.stop();
      this.onStatus("当前浏览器无法保存视频，仍可保存试穿照片");
    }
  }
  stop(): Promise<Result> {
    if (this.closing) return this.closing;
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.frameTimer);
    this.closing = (async () => {
      if (this.recorder && this.recorder.state !== "inactive") {
        const recorder = this.recorder;
        const elapsed = Date.now() - this.recordedAt;
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
        if (this.chunks.length)
          this.result.video = await normalizeRecording(
            new Blob(this.chunks, { type: recorder.mimeType }),
            elapsed,
          );
      }
      this.recordTrack?.stop();
      try {
        await this.manager?.close();
      } catch {
        /* Backend revocation also runs. */
      }
      this.container.replaceChildren();
      this.localContainer.remove();
      return this.result;
    })();
    return this.closing;
  }
}
