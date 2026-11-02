import { existsSync, mkdirSync, copyFileSync, unlinkSync } from "node:fs";
import { loadEnv } from "vite";
import { spawnSync } from "node:child_process";
mkdirSync("public/demo", { recursive: true });
mkdirSync("public/brand", { recursive: true });
function copy(input, output) {
  if (!existsSync(input)) throw new Error(`缺少参考素材：${input}`);
  copyFileSync(input, output);
}
function image(input, output, filter) {
  if (!existsSync(input)) throw new Error(`缺少参考素材：${input}`);
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
if (existsSync("xkd-x-mirror-logo.png"))
  image("xkd-x-mirror-logo.png", "public/brand/logo.webp", "scale=256:256");
copy("ref_material/model/studio.mp4", "public/demo/studio.mp4");
if (existsSync("public/demo/studio.jpg")) unlinkSync("public/demo/studio.jpg");
copy("ref_material/clothes/suit.jpg", "public/demo/suit.jpg");
copy("ref_material/clothes/sweatshirt.jpg", "public/demo/sweatshirt.jpg");
// Genuine original photograph, downloaded separately with its attribution.
if (!existsSync("ref_material/garments/tellason-jeans.jpg") && !existsSync("public/demo/jeans.jpg")) {
  mkdirSync("ref_material/garments", { recursive: true });
  const proxy = process.env.XMAX_PROXY_URL || loadEnv("development", process.cwd(), "").XMAX_PROXY_URL;
  const download = spawnSync(process.platform === "win32" ? "curl.exe" : "curl", ["-f", "-sS", "-L", "--max-time", "45",
    ...(proxy ? ["--proxy", proxy] : []),
    "https://upload.wikimedia.org/wikipedia/commons/c/c2/Tellason_jeans%2C_front.jpg",
    "-o", "ref_material/garments/tellason-jeans.jpg"], { encoding: "utf8" });
  if (download.status !== 0) throw new Error("高清牛仔裤素材下载失败，请检查网络后重新准备素材");
}
if (existsSync("ref_material/garments/tellason-jeans.jpg"))
  image("ref_material/garments/tellason-jeans.jpg", "public/demo/jeans.jpg", "scale=2048:-1");
image(
  "ref_material/clothes/outfit.png",
  "public/demo/skirt.jpg",
  "crop=650:270:680:950",
);
copy("ref_material/clothes/top.jpg", "public/demo/top.jpg");
copy("ref_material/clothes/hat.jpg", "public/demo/hat.jpg");
image(
  "ref_material/model/man.mp4",
  "public/demo/man.jpg",
  "scale=640:-1",
);
image(
  "ref_material/model/woman.mp4",
  "public/demo/woman.jpg",
  "scale=640:-1",
);
for (const name of ["jacket", "sweater", "coat"])
  copy(`ref_material/clothes/${name}.jpg`, `public/demo/${name}.jpg`);
for (const name of ["woman", "man", "athlete"])
  copy(`ref_material/model/${name}.mp4`, `public/demo/${name}.mp4`);
console.log("已准备本地参考素材；public/demo 不进入 Git，公网默认禁用。");
