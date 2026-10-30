import { existsSync, mkdirSync, copyFileSync, unlinkSync } from "node:fs";
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
  "ref_material/GUI-reference.png",
  "public/demo/sweatshirt.jpg",
  "crop=113:90:715:465,scale=565:450",
);
image(
  "ref_material/GUI-reference.png",
  "public/demo/jeans.jpg",
  "crop=111:90:843:465,scale=555:450",
);
image(
  "ref_material/GUI-reference.png",
  "public/demo/skirt.jpg",
  "crop=111:90:1104:465,scale=555:450",
);
image(
  "ref_material/materials/references/top.png",
  "public/demo/top.jpg",
  "crop=1150:760:220:0,scale=690:456",
);
image(
  "ref_material/materials/references/hat.jpg",
  "public/demo/hat.jpg",
  "scale=600:-1",
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
for (const name of ["woman", "man", "athlete"])
  if (existsSync(`ref_material/materials/inputs/${name}.mp4`))
    copyFileSync(
      `ref_material/materials/inputs/${name}.mp4`,
      `public/demo/${name}.mp4`,
    );
console.log("已准备本地参考素材；public/demo 不进入 Git，公网默认禁用。");
