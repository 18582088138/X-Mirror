// Browser lifecycle fixture ONLY. Never loaded by the application outside tests.
export class XmaxConfiguration {
  constructor(options) {
    Object.assign(this, options);
  }
}
export const XmaxEnvironment = { china: "china", global: "global" };
export const RealtimeModel = { x2_1: "x2_1" };
export const RealtimeConnectionState = { generating: "generating" };
export const VideoContentMode = { fit: "fit" };
export const defaultCameraVideoFormat = () => ({});
export class RealtimeConfiguration {
  constructor(options) {
    Object.assign(this, options);
  }
}
export class RealtimeContext {
  constructor(options) {
    Object.assign(this, options);
  }
}
export class XmaxRealtimeVideoView {
  videoElement = document.createElement("video");
  constructor() {
    this.videoElement.muted = true;
    this.videoElement.autoplay = true;
    this.videoElement.playsInline = true;
  }
  attach(container) {
    container.append(this.videoElement);
  }
  set track(value) {
    this.videoElement.srcObject = new MediaStream([value]);
    void this.videoElement.play();
  }
}
export class XmaxClient {
  createStorageService() {
    return {
      uploadImage: async () => ({
        url: "https://example.invalid/test-only.jpg",
      }),
    };
  }
  createRealtimeManager() {
    let callback, stream, ticker, local;
    const localStream = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 16;
      canvas.height = 16;
      canvas.getContext("2d").fillRect(0, 0, 16, 16);
      local = canvas.captureStream(5);
      return { videoTrack: local.getVideoTracks()[0] };
    };
    return {
      setStateListener: async (listener) => {
        callback = listener;
      },
      createLocalImageStream: async () => {
        globalThis.mockInput = "photo";
        return localStream();
      },
      createLocalVideoStream: async () => {
        globalThis.mockInput = "video";
        return localStream();
      },
      startGeneration: async (options) => {
        globalThis.mockPrompt = options.context.prompt;
        const canvas = document.createElement("canvas");
        canvas.width = 360;
        canvas.height = 640;
        const context = canvas.getContext("2d");
        let frame = 0;
        const paint = () => {
          context.fillStyle = "#d4dacb";
          context.fillRect(0, 0, 360, 640);
          context.fillStyle = "#374936";
          context.font = "22px sans-serif";
          context.fillText("TEST FIXTURE ONLY", 55, 150);
          context.fillRect(80 + (frame++ % 15), 240, 200, 250);
        };
        paint();
        ticker = setInterval(paint, 50);
        stream = canvas.captureStream(20);
        callback?.({ connectionState: "generating" });
        return { videoTrack: stream.getVideoTracks()[0] };
      },
      close: async () => {
        clearInterval(ticker);
        stream?.getTracks().forEach((track) => track.stop());
        local?.getTracks().forEach((track) => track.stop());
      },
    };
  }
}
