import { Muxer, ArrayBufferTarget } from "webm-muxer";

const port = globalThis as unknown as {
  onmessage: (event: MessageEvent) => void;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};
let encoder: VideoEncoder;
let muxer: Muxer<ArrayBufferTarget>;
let target: ArrayBufferTarget;
let frames = 0;
let warming = true;
let initialMetadata: EncodedVideoChunkMetadata | undefined;
const fail = (error: unknown) => port.postMessage({ type: "error", message: error instanceof Error ? error.message : "视频编码失败" });
port.onmessage = async ({ data }) => {
  try {
    if (data.type === "init") {
      target = new ArrayBufferTarget();
      muxer = new Muxer({ target, video: { codec: "V_VP8", width: data.width, height: data.height, frameRate: 30 }, firstTimestampBehavior: "strict" });
      encoder = new VideoEncoder({
        output: (chunk, metadata) => {
          if (warming) {
            warming = false; initialMetadata = metadata;
            port.postMessage({ type: "ready" });
          } else muxer.addVideoChunk(chunk, metadata ?? initialMetadata);
        },
        error: fail,
      });
      encoder.configure({ codec: "vp8", width: data.width, height: data.height, bitrate: 8_000_000, framerate: 30, latencyMode: "realtime" });
      // Wait for a real encoded warmup frame, not merely configure(). Discard it
      // so codec startup cannot stall or occupy the user's recorded timeline.
      try { encoder.encode(data.frame, { keyFrame: true }); }
      finally { data.frame.close(); }
    } else if (data.type === "frame") {
      try {
        if (encoder.encodeQueueSize < 3 || data.keyFrame) { encoder.encode(data.frame, { keyFrame: data.keyFrame }); frames++; }
      } finally { data.frame.close(); port.postMessage({ type: "ack" }); }
    } else if (data.type === "finish") {
      await encoder.flush();
      if (frames < 2) throw new Error("未收到足够的视频画面");
      muxer.finalize();
      encoder.close();
      port.postMessage({ type: "done", buffer: target.buffer }, [target.buffer]);
    }
  } catch (error) { fail(error); }
};
