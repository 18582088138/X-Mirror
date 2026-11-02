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
export class RealtimeVideoFormat { constructor(options) { Object.assign(this, options); } }
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
    this.videoElement.srcObject = value ? new MediaStream([value]) : null;
    if (value) void this.videoElement.play().catch(() => {});
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
  createRealtimeManager(configuration) {
    globalThis.mockConfiguration = configuration;
    let callback, stream, ticker, local, remoteListener;
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
      setRemoteMediaTracksListener: (listener) => { remoteListener = listener; },
      setTimingListener: async () => {},
      setDownlinkVideoStatisticsListener: async () => {},
      createExternalVideoStream: async (options) => {
        globalThis.mockFormat = options.videoFormat;
        globalThis.mockInput = "external";
        local = new MediaStream([options.videoTrack]);
        return { videoTrack: options.videoTrack };
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
        canvas.width = globalThis.mockFormat.width;
        canvas.height = globalThis.mockFormat.height;
        const context = canvas.getContext("2d");
        let frame = 0;
        const started = performance.now();
        const paint = () => {
          if (globalThis.mockBlankRemote || performance.now() - started < (globalThis.mockBlankWarmup || 0)) {
            context.fillStyle = "#fff";
            context.fillRect(0, 0, canvas.width, canvas.height);
            return;
          }
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
        if (!globalThis.mockNoRemote)
          remoteListener?.({bindingID:"test-result", userID:"bot-test", videoTrack:stream.getVideoTracks()[0]});
        return { videoTrack: local.getVideoTracks()[0] }; // Deliberately expose local preview; app must use the raw remote listener.
      },
      close: async () => {
        clearInterval(ticker);
        stream?.getTracks().forEach((track) => track.stop());
        local?.getTracks().forEach((track) => track.stop());
      },
    };
  }
}
