import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = (executable, args, timeoutMs = 60000) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { error = (error + data).slice(-800); });
    const timer = setTimeout(() => { child.kill(); reject(new Error("视频转换超时")); }, timeoutMs);
    child.once("error", (e) => { clearTimeout(timer); reject(e); });
    child.once("close", (code) => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(error || "视频转换失败")); });
  });

// 摄像头 WebM 是可变帧率（时间戳抖动），直接送入模型会掉帧；统一成 30fps 恒定帧率 H.264 MP4，
// 并限制最长边 1920。未安装 FFmpeg 时 normalize 返回 undefined，调用方改用原文件。
export function createVideo({ env }) {
  const ffmpeg = env.FFMPEG_PATH?.trim() || "ffmpeg";
  const ffprobe = env.FFPROBE_PATH?.trim() || "ffprobe";
  let available;
  const check = () => (available ??= run(ffmpeg, ["-version"], 8000).then(() => true, () => false));
  return {
    available: check,
    async normalize(buffer, extension) {
      if (!(await check())) return undefined;
      const dir = await mkdtemp(join(tmpdir(), "xmirror-"));
      try {
        const input = join(dir, `in.${extension}`), output = join(dir, "out.mp4");
        await writeFile(input, buffer);
        await run(ffmpeg, ["-y", "-v", "error", "-i", input, "-fps_mode", "cfr", "-r", "30",
          "-vf", "scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-g", "30", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", output]);
        const probe = JSON.parse(await run(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "json", output], 15000));
        return { data: await readFile(output), duration: Number(probe.format?.duration) || 0 };
      } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
    },
  };
}
