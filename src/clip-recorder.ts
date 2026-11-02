// Full-HD encoding stays off the main thread. All captured frames use one
// clock with an explicit end, including when timers are delayed by browser load.
export class ClipRecorder {
  private worker = new Worker(new URL("./clip-encoder.worker.ts", import.meta.url), { type: "module" });
  private started = 0;
  private lastTimestamp = -1;
  private pending = 0;
  private timer?: ReturnType<typeof setInterval>;
  private failure?: Error;
  private done?: (buffer: ArrayBuffer) => void;
  private reject?: (error: Error) => void;
  private ready: Promise<void>;
  private readonly durationUs: number;
  private readonly step = 33333;
  static async supported(width: number, height: number) {
    if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") return false;
    try { return !!(await VideoEncoder.isConfigSupported({ codec: "vp8", width, height })).supported; }
    catch { return false; }
  }
  constructor(private video: HTMLVideoElement, seconds: number, onError: () => void) {
    this.durationUs = Math.round(seconds * 1_000_000);
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => this.fail(new Error("视频编码器启动超时")), 10000);
      this.reject = reject;
      this.worker.onmessage = ({ data }) => {
        if (data.type === "ready") { clearTimeout(timeout); resolve(); }
        if (data.type === "ack") this.pending--;
        if (data.type === "done") this.done?.(data.buffer);
        if (data.type === "error") { clearTimeout(timeout); this.fail(new Error(data.message)); onError(); }
      };
      this.worker.onerror = () => { clearTimeout(timeout); this.fail(new Error("视频编码失败")); onError(); };
      const frame = new VideoFrame(video, { timestamp: 0, duration: this.step });
      this.worker.postMessage({ type: "init", width: video.videoWidth, height: video.videoHeight, frame }, [frame]);
    });
  }
  async prepare() { await this.ready; }
  start(origin: number) {
    this.started = origin;
    this.frame(0, true);
    this.timer = setInterval(() => {
      const timestamp = Math.round((performance.now() - this.started) * 1000);
      if (timestamp < this.durationUs - this.step && this.pending < 3) this.frame(timestamp);
      else if (timestamp >= this.durationUs - this.step) clearInterval(this.timer);
    }, 1000 / 30);
  }
  private frame(timestamp: number, keyFrame = false, end = this.durationUs, terminal = false) {
    timestamp = Math.max(0, Math.min(timestamp, terminal ? end : end - Math.min(this.step, end)));
    if (timestamp <= this.lastTimestamp || this.failure) return;
    const frame = new VideoFrame(this.video, { timestamp, duration: terminal ? 0 : Math.min(this.step, end - timestamp) });
    this.lastTimestamp = timestamp;
    this.pending++;
    this.worker.postMessage({ type: "frame", frame, keyFrame }, [frame]);
  }
  private fail(error: Error) { this.failure = error; clearInterval(this.timer); this.reject?.(error); }
  async finish(elapsedMs: number) {
    clearInterval(this.timer);
    try {
      if (this.failure) throw this.failure;
      const end = Math.min(this.durationUs, Math.max(this.step, Math.round(elapsedMs * 1000)));
      // webm-muxer uses the final PTS for container Duration. A zero-duration
      // endpoint at the clip boundary gives an exact duration without extra time.
      this.frame(end, true, end, true);
      return await new Promise<Blob>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("视频保存超时")), 10000);
        this.reject = (error) => { clearTimeout(timeout); reject(error); };
        this.done = (buffer) => { clearTimeout(timeout); resolve(new Blob([buffer], { type: "video/webm" })); };
        this.worker.postMessage({ type: "finish" });
      });
    } finally { this.worker.terminate(); }
  }
}
