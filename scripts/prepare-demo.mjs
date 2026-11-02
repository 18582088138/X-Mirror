import { existsSync, mkdirSync, copyFileSync, unlinkSync } from "node:fs";
import { loadEnv } from "vite";
import { spawnSync } from "node:child_process";
mkdirSync("public/demo", { recursive: true });
mkdirSync("public/brand", { recursive: true });
function image(input, output, filter) {
  if (!existsSync(input)) return;
  const result = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      input,
      "-vf",
      filter,
      "-frames:v",
      "1",
      "-update",
      "1",
      output,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0)
    throw new Error(result.stderr || "请安装 ffmpeg 以准备参考素材");
}
image("xkd-x-mirror-logo.png", "public/brand/logo.webp", "scale=256:256");
if (existsSync("ref_material/网站试衣服.mov")) {
  // The supplied clip contains a product page. Keep the moving model panel.
  const result = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "ref_material/网站试衣服.mov",
      "-vf",
      "crop=978:1028:0:52",
      "-t",
      "10",
      "-an",
      "-c:v",
      "libx264",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "public/demo/studio.mp4",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr || "参考视频处理失败");
}
if (existsSync("public/demo/studio.jpg")) unlinkSync("public/demo/studio.jpg");
image(
  "ref_material/materials/references/outfit.png",
  "public/demo/suit.jpg",
  "crop=900:1200:600:100",
);
image(
  "ref_material/materials/references/outfit.png",
  "public/demo/sweatshirt.jpg",
  "crop=700:850:650:110",
);
// Genuine original photograph, downloaded separately with its attribution.
if (!existsSync("ref_material/garments/tellason-jeans.jpg")) {
  mkdirSync("ref_material/garments", { recursive: true });
  const proxy = process.env.XMAX_PROXY_URL || loadEnv("development", process.cwd(), "").XMAX_PROXY_URL;
  const download = spawnSync(process.platform === "win32" ? "curl.exe" : "curl", ["-f", "-sS", "-L", "--max-time", "45",
    ...(proxy ? ["--proxy", proxy] : []),
    "https://upload.wikimedia.org/wikipedia/commons/c/c2/Tellason_jeans%2C_front.jpg",
    "-o", "ref_material/garments/tellason-jeans.jpg"], { encoding: "utf8" });
  if (download.status !== 0) throw new Error("高清牛仔裤素材下载失败，请检查网络后重新准备素材");
}
image("ref_material/garments/tellason-jeans.jpg", "public/demo/jeans.jpg", "scale=2048:-1");
image(
  "ref_material/materials/references/outfit.png",
  "public/demo/skirt.jpg",
  "crop=650:270:680:950",
);
image(
  "ref_material/materials/references/top.png",
  "public/demo/top.jpg",
  "crop=1150:760:220:0",
);
image(
  "ref_material/materials/references/hat.jpg",
  "public/demo/hat.jpg",
  "scale=iw:ih",
);
image(
  "ref_material/materials/references/person.png",
  "public/demo/man.jpg",
  "scale=640:-1",
);
image(
  "ref_material/materials/inputs/woman.mp4",
  "public/demo/woman.jpg",
  "scale=640:-1",
);
for (const name of ["jacket", "sweater", "coat"])
  if (existsSync(`ref_material/clothes/${name}.jpg`))
    copyFileSync(`ref_material/clothes/${name}.jpg`, `public/demo/${name}.jpg`);
for (const name of ["woman", "man", "athlete"])
  if (existsSync(`ref_material/materials/inputs/${name}.mp4`))
    copyFileSync(
      `ref_material/materials/inputs/${name}.mp4`,
      `public/demo/${name}.mp4`,
    );
console.log("已准备本地参考素材；public/demo 不进入 Git，公网默认禁用。");
