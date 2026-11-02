import { Muxer, ArrayBufferTarget } from "webm-muxer";

// Explicit timestamps keep encoder startup and RTC timestamp discontinuities out
// of the clip timeline. Repeated pixels preserve a pause; they do not add motion.
export class ClipRecorder {
  private target = new ArrayBufferTarget();
  private muxer: Muxer<ArrayBufferTarget>;
  private encoder: VideoEncoder;
  private canvas = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D;
  private started = performance.now();
  private lastTimestamp = -1;
  private timer?: ReturnType<typeof setInterval>;
  private failure?: Error;
  static async supported(width: number, height: number) {
    if (typeof VideoEncoder === "undefined") return false;
    try {
      return (await VideoEncoder.isConfigSupported({codec:"vp8", width, height})).supported;
    } catch { return false; }
  }
  constructor(private video: HTMLVideoElement, onError: () => void) {
    const width = video.videoWidth, height = video.videoHeight;
    this.canvas.width = width; this.canvas.height = height;
    this.ctx = this.canvas.getContext("2d")!;
    this.muxer = new Muxer({
      target: this.target,
      video: {codec:"V_VP8", width, height, frameRate:30},
      firstTimestampBehavior:"strict",
    });
    this.encoder = new VideoEncoder({
      output: (chunk, metadata) => this.muxer.addVideoChunk(chunk, metadata),
      error: (error) => { this.failure = error; onError(); },
    });
    this.encoder.configure({codec:"vp8", width, height, bitrate:8_000_000,
      framerate:30, latencyMode:"realtime"});
    this.frame(0, true);
    this.timer = setInterval(() => {
      if (this.encoder.state === "configured" && this.encoder.encodeQueueSize < 3)
        this.frame(Math.round((performance.now() - this.started) * 1000));
    }, 1000/30);
  }
  private frame(timestamp: number, keyFrame = false) {
    timestamp = Math.max(this.lastTimestamp + 1, timestamp);
    this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
    const frame = new VideoFrame(this.canvas, {timestamp, duration:33333});
    try { this.encoder.encode(frame, {keyFrame}); this.lastTimestamp = timestamp; }
    finally { frame.close(); }
  }
  async finish(elapsedMs: number) {
    clearInterval(this.timer);
    try {
      if (this.failure) throw this.failure;
      // Snapshot the final pixels before awaiting encoding: the result track may
      // end while the backend revokes the session. Allow one final queued frame.
      this.frame(Math.max(0, Math.round(elapsedMs*1000)-33333), true);
      await this.encoder.flush();
      this.muxer.finalize();
      return new Blob([this.target.buffer], {type:"video/webm"});
    } finally { if (this.encoder.state !== "closed") this.encoder.close(); }
  }
}
