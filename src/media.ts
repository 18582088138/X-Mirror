export type Source = {
  file: File;
  url: string;
  poster: string;
  duration: number;
  coverage: "full" | "half";
  isVideo: boolean;
};
export const categories = ["suit", "top", "bottom", "accessory"] as const;
export type Category = typeof categories[number];
export type Garment = {
  id: string;
  name: string;
  category: Category;
  image: string;
  detail?: string;
  width?: number;
  height?: number;
  accessory?: string;
  file?: File;
  purchaseUrl?: string;
};
export const labels: Record<Category, string> = {
  suit: "套装",
  top: "上衣",
  bottom: "下装",
  accessory: "配饰",
};
export const categoryHelp: Record<Category, string> = {
  suit: "完整上衣 + 下装、连衣裙或连体衣；请上传整套服装的清晰正面图。",
  top: "外套、衬衫、夹克、针织衫等；只更换上衣，保留原有裤裙。",
  bottom: "裤子、半身裙等；只更换下装，保留原有上衣。",
  accessory: "帽子、眼镜等；选择对应配饰类型，保留原有服装。",
};
export function applyGarment(slots: Partial<Record<Category, Garment>>, item: Garment) {
  if (item.category === "suit") { delete slots.top; delete slots.bottom; }
  if (item.category === "top" || item.category === "bottom") delete slots.suit;
  slots[item.category] = item;
}

export function waitMedia(
  target: HTMLMediaElement,
  event: string,
  timeout = 10000,
) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(event, ok);
      target.removeEventListener("error", fail);
    };
    const ok = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error("浏览器无法读取视频，请使用 H.264 MP4 或 WebM"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("读取视频超时，请换一段视频"));
    }, timeout);
    target.addEventListener(event, ok, { once: true });
    target.addEventListener("error", fail, { once: true });
  });
}
export function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    const timer = setTimeout(() => reject(new Error("读取图片超时")), 10000);
    image.onload = () => {
      clearTimeout(timer);
      resolve(image);
    };
    image.onerror = () => {
      clearTimeout(timer);
      reject(new Error("图片无法读取，请换一张 JPG、PNG 或 WebP"));
    };
    image.src = src;
  });
}
let frameSample: HTMLCanvasElement | undefined;
// A decoded track may initially contain a solid white/black placeholder.
// Check a tiny pixel sample before treating it as a generated picture.
export function hasVisibleFrame(video: HTMLVideoElement) {
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return false;
  frameSample ??= document.createElement("canvas");
  frameSample.width = 64; frameSample.height = 64;
  try {
    const ctx = frameSample.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(video, 0, 0, 64, 64);
    const pixels = ctx.getImageData(0, 0, 64, 64).data;
    let low = 255, high = 0, sum = 0, squared = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const value = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
      low = Math.min(low, value); high = Math.max(high, value);
      sum += value; squared += value * value;
    }
    return high - low > 20 && squared / 4096 - (sum / 4096) ** 2 > 12;
  } catch { return false; }
}
export async function validateOutputVideo(blob: Blob, expectedSeconds: number) {
  const video = document.createElement("video");
  const url = URL.createObjectURL(blob);
  video.muted = true; video.playsInline = true; video.preload = "auto";
  try {
    const ready = waitMedia(video, "loadeddata");
    video.src = url;
    await ready;
    if (!Number.isFinite(video.duration) || Math.abs(video.duration - expectedSeconds) > 0.15)
      throw new Error("生成短片时长不正确，已阻止显示为完成，请重新试穿");
    // Force the decoder to render the first picture; loadeddata with time=0
    // alone can still leave a paused video texture blank in embedded browsers.
    for (const time of [Math.min(0.01, video.duration / 2), video.duration / 2, Math.max(0, video.duration - 0.1)]) {
      if (Math.abs(video.currentTime - time) > 0.001) {
        const seek = waitMedia(video, "seeked");
        video.currentTime = time;
        await seek;
      }
      if (!hasVisibleFrame(video)) throw new Error("生成短片包含空白画面，已阻止显示为完成，请重新试穿");
    }
    const cover = document.createElement("canvas");
    cover.width = video.videoWidth; cover.height = video.videoHeight;
    cover.getContext("2d")!.drawImage(video, 0, 0);
    return { duration: video.duration, width: video.videoWidth, height: video.videoHeight, photo: cover.toDataURL("image/jpeg", 0.95) };
  } finally {
    video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url);
  }
}
export function canvasBlob(canvas: HTMLCanvasElement, quality = 0.9) {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("图片处理失败"))),
      "image/jpeg",
      quality,
    ),
  );
}
export async function imageFile(src: string, name = "image.jpg", max = 2048) {
  const image = await loadImage(src);
  const scale = Math.min(1, max / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new File([await canvasBlob(canvas, 0.95)], name, { type: "image/jpeg" });
}
export async function validateImage(file: File) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
    throw new Error("请选择 JPG、PNG 或 WebP 图片");
  if (file.size > 10 * 1024 * 1024) throw new Error("图片不能超过 10 MB");
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    if (Math.min(img.width, img.height) < 64)
      throw new Error("图片至少需要 64 × 64 像素");
    return { width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}
export async function readSource(
  file: File,
  coverage: Source["coverage"],
  recordedDuration?: number,
): Promise<Source> {
  const isVideo =
    file.type.startsWith("video/") || /\.(mp4|mov|webm)$/i.test(file.name);
  if (!isVideo) {
    await validateImage(file);
    const url = URL.createObjectURL(file);
    return {
      file,
      url,
      poster: url,
      duration: 0,
      coverage,
      isVideo: false,
    };
  }
  if (file.size > 30 * 1024 * 1024)
    throw new Error("视频不能超过 30 MB，请压缩后重新上传");
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  try {
    const ready = waitMedia(video, "loadeddata");
    video.src = url;
    await ready;
    const duration = Number.isFinite(video.duration)
      ? video.duration
      : recordedDuration;
    if (!duration || duration <= 0)
      throw new Error("视频时长无法读取，请上传普通 MP4 文件");
    if (duration > 10.15)
      throw new Error("视频最长支持 10 秒，请截取 5～10 秒后再上传");
    return {
      file,
      url,
      poster: "", // Video previews use the original video element, never JPEG samples.
      duration,
      coverage,
      isVideo: true,
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
}

export async function buildReference(garments: Garment[]) {
  if (garments.length === 1)
    return {
      file: await imageFile(garments[0].image, "garment.jpg"),
      layout: `参考图为${labels[garments[0].category]}${garments[0].accessory ? `（${garments[0].accessory}）` : ""}`,
    };
  const height = 2048;
  const width = 1024 * garments.length;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  const cell = width / garments.length;
  for (const [i, garment] of garments.entries()) {
    const image = await loadImage(garment.image);
    const scale = Math.min(
      (cell - 30) / image.width,
      (height - 110) / image.height,
    );
    ctx.drawImage(
      image,
      i * cell + (cell - image.width * scale) / 2,
      80 + (height - 110 - image.height * scale) / 2,
      image.width * scale,
      image.height * scale,
    );
    ctx.fillStyle = "#151515";
    ctx.font = "24px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(
      `${i + 1}. ${labels[garment.category]}${garment.accessory || ""}`,
      (i + 0.5) * cell,
      45,
    );
  }
  return {
    file: new File([await canvasBlob(canvas)], "outfit-reference.jpg", {
      type: "image/jpeg",
    }),
    layout: garments
      .map(
        (g, i) =>
          `第${i + 1}列为${labels[g.category]}${g.accessory ? `（${g.accessory}）` : ""}`,
      )
      .join("；"),
  };
}
export function buildPrompt(garments: Garment[], layout: string) {
  const selected = new Set(garments.map(g => g.category));
  if (selected.has("suit") && (selected.has("top") || selected.has("bottom")))
    throw new Error("套装不能与单独的上衣或下装同时试穿，请重新选择");
  const instructions = garments.map(g => {
    if (g.category === "suit") return "套装：完整穿上参考图中的整套上衣及下装，或完整的连衣裙、连体衣；保持整套服装的款式、上下搭配、裙摆或裤腿长度，不要仅替换上衣";
    if (g.category === "top") return `上衣：仅更换上身服装${selected.has("bottom") ? "，下装按其独立参考图处理" : "，保留原有裤子或裙子的款式、长度和覆盖范围，禁止把长裤改为裙子或短裤"}`;
    if (g.category === "bottom") return `下装：仅更换裤子或半身裙${selected.has("top") ? "，上衣按其独立参考图处理" : "，保留原有上衣及外套"}`;
    return `配饰：仅将参考图中的${g.accessory || "配饰"}佩戴到对应位置，不改变其他未选择的配饰`;
  }).join("；");
  const preserve = selected.has("accessory") ? "鞋袜及其他未选择的配饰" : "所有原有配饰及鞋袜";
  const combination = garments.length > 1
    ? `这是同一造型的 ${garments.length} 件单品组合：同时穿戴全部已选服饰（${garments.map(g => labels[g.category] + (g.accessory ? `：${g.accessory}` : "")).join("、")}），每个视频画面都保留这套组合，不能只替换其中一件。`
    : "";
  return `将参考图中的服饰穿戴到原始人物画面中，视频跟随人物原有动作，照片保持原有姿势。${layout}。${combination}${instructions}。保持人物面容、身份、发型、体型、姿势、背景、${preserve}和其他未选择的衣物不变。准确保留商品颜色、版型、纹理、图案与细节，呈现自然的布料和光影。只处理所选类别；参考图中的其他服装、展示人物、背景、文字标签与展示道具不要出现在生成画面中。`;
}
export async function normalizeRecording(
  blob: Blob,
  elapsedMs: number,
): Promise<Blob> {
  if (!blob.type.includes("webm")) return blob;
  try {
    const { default: fixWebmDuration } = await import("fix-webm-duration");
    return await fixWebmDuration(blob, elapsedMs, { logger: false });
  } catch {
    return blob;
  } // Preserve a playable recording even if metadata repair fails.
}
