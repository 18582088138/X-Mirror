import "./style.css";
import { icon } from "./icons";
import demoCatalog from "./demo-catalog.json";
import {
  readSource,
  validateImage,
  buildReference,
  buildPrompt,
  normalizeRecording,
  loadImage,
  waitMedia,
  labels,
  categories,
  categoryHelp,
  applyGarment,
  type Category,
  type Source,
  type Garment,
} from "./media";
import type { TryOnSession, Ticket, Result } from "./provider";

type Config = {
  configured: boolean;
  active: boolean;
  remaining: number | null;
  outputSeconds: number;
  sessionSeconds: number;
  pointsPerSession: number;
  demoEnabled: boolean;
};
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const providerModule = import("./provider"); // Prefetch SDK only; no paid request.
let clickedAt = 0;
let clickToFirstFrameMs: number | undefined;
let config: Config | undefined;
let source: Source | undefined;
let catalog: Garment[] = [];
const slots: Partial<Record<Category, Garment>> = {};
let category: Category = "suit";
let mode: "photo" | "video" = "photo";
let busy = false,
  finishing = false,
  loadingSource = false,
  epoch = 0,
  comparing = false;
let ticket: Ticket | undefined,
  pendingTicket: Promise<Ticket> | undefined,
  session: TryOnSession | undefined;
let result: Result | undefined, resultURL: string | undefined;
let hardTimer: ReturnType<typeof setTimeout> | undefined;
let lastOutfit: Garment[] = [];
let linkBusy = false;
const createdURLs = new Set<string>();
const objectURL = (blob: Blob) => {
  const url = URL.createObjectURL(blob);
  createdURLs.add(url);
  return url;
};
function release(url?: string) {
  if (url?.startsWith("blob:")) {
    URL.revokeObjectURL(url);
    createdURLs.delete(url);
  }
}

$("app").innerHTML = `
<header class="topbar">
  <a class="brand" href="/" aria-label="X-Mirror 首页"><img src="/brand/logo.webp" alt="X-Mirror Logo"><span>X-Mirror<small>VIRTUAL FITTING ROOM</small></span></a>
  <nav aria-label="主导航"><a class="active" href="#fitting">试衣间</a><a href="#outfit">我的搭配</a><button id="guide-open">使用指南</button></nav>
  <span class="engine"><i id="engine-dot"></i>XMAX X2.1</span>
</header>
<main id="fitting" class="layout">
 <section class="stage" aria-label="人物与试穿预览">
   <div class="stage-heading"><span id="stage-label" class="pill">${icon("person")}人物预览</span><button id="expand" class="icon-button" aria-label="全屏预览" title="全屏预览">${icon("expand")}</button></div>
   <div class="empty-stage" id="empty-stage"><img src="/brand/logo.webp" alt=""><h2>你的风格，从这里开始。</h2><p>上传一段短视频，遇见新的自己。</p><button class="outline" id="empty-upload">${icon("upload")}添加人物素材</button></div>
   <img id="person-preview" class="hero-media" alt="人物原始画面" hidden>
   <video id="person-video" class="hero-media" muted autoplay loop playsinline aria-label="人物原始视频" hidden></video>
   <img id="result-photo" class="hero-media" alt="AI 生成的试穿照片" hidden>
   <video id="result-video" class="hero-media" muted playsinline controls preload="auto" hidden></video>
   <div id="remote" class="hero-media remote" hidden></div>
   <div class="loading" id="loading" hidden><span class="spinner"></span><strong id="loading-text">正在准备你的新造型</strong><p>一点灵感，换一种可能。</p></div>
   <button class="comparison" id="compare" disabled title="对比原始画面"><video id="original-thumb-video" muted playsinline hidden></video><img id="original-thumb" alt="原始人物缩略图"><span>${icon("person")}原始画面</span></button>
   <div class="stage-footer"><div><span class="eyebrow">YOUR NEXT LOOK</span><p id="stage-caption">一段视频，无限穿搭灵感。</p></div><span class="stage-edition">THE FITTING EDIT <b>01</b></span></div>
   <div id="result-actions" class="result-actions" hidden><button id="save-photo">${icon("download")}保存照片</button><button id="save-video" hidden>${icon("play")}保存短片</button><button id="back-original">${icon("person")}查看原图</button></div>
 </section>
 <section class="panel">
   <div class="panel-head"><span class="eyebrow">TRY IT ON. MAKE IT YOURS.</span><span class="edition">X-MIRROR / 01</span></div>
   <h1>下一套风格，<br>先穿上看看。</h1><p class="intro">带上真实的你，试试心动的衣服。</p>
   <fieldset id="input-controls">
    <div class="section-label"><span><b>01</b> 把你带进试衣间</span><span class="muted">全身 / 半身均可</span></div>
    <div class="source-card"><button id="source-open" class="source-choice"><video id="source-thumb-video" muted playsinline hidden></video><img id="source-thumb" alt="当前人物素材" hidden><span class="source-placeholder" id="source-placeholder">${icon("person")}</span><span><strong id="source-name">添加人物素材</strong><small id="source-description">上传短视频，或用摄像头录制</small></span><span class="source-change">更换 ${icon("arrow")}</span></button><button class="camera-shortcut" id="camera-open" aria-label="摄像头录制" title="摄像头录制">${icon("camera")}</button></div>
    <div class="mode-row"><div class="segmented" aria-label="根据人物素材自动选择输出类型"><button id="mode-photo" class="selected" aria-pressed="true">试穿照片</button><button id="mode-video" aria-pressed="false">动态短片</button></div><span id="mode-note">保存一张试穿照片</span></div>
    <div class="section-label" id="outfit"><span><b>02</b> 搭配你的下一套</span><span class="muted" id="outfit-count">选择心动的单品</span></div>
    <div id="slots" class="outfit-slots" aria-label="搭配槽位"></div>
    <div class="category-tabs" role="tablist" aria-label="服饰类别">${categories.map(key => `<button data-category="${key}" role="tab" aria-selected="${key === category}" class="${key === category ? "selected" : ""}">${labels[key]}</button>`).join("")}<span id="catalog-note">我的衣橱</span></div>
    <p id="category-help" class="field-note">${categoryHelp.suit}</p>
    <div class="wardrobe" id="wardrobe" aria-label="可选单品"></div>
    <p id="garment-quality" class="field-note" role="status" hidden></p>
    <div class="accessory-kind" id="accessory-kind" hidden><label for="accessory-select">配饰类型</label><select id="accessory-select"><option>帽子</option><option>眼镜</option></select><small>配饰与多件搭配为实验功能</small></div>
    <form id="link-form" class="product-link"><span>${icon("link")}</span><label class="sr-only" for="product-url">商品或服饰图片链接</label><input id="product-url" type="url" placeholder="粘贴商品链接或服饰图片链接" maxlength="2000"><button id="resolve-link" type="submit">添加 ${icon("plus")}</button></form>
    <p id="link-status" class="field-note" role="status" hidden></p><button id="bind-link" class="bind-link" hidden>将此购买链接绑定到当前单品 ↗</button>
    <label class="upload-zone" id="garment-drop" for="garment-file">${icon("upload")}<span><strong id="garment-upload-title">上传套装图片</strong><small>点击或拖入 · JPG / PNG / WebP，最大 10 MB</small></span>${icon("plus")}</label><input id="garment-file" type="file" accept="image/jpeg,image/png,image/webp" hidden>
    <label class="consent"><input id="consent" type="checkbox"><span>我已获素材使用授权，同意由 XMAX 处理人物画面和服饰图片。</span></label>
   </fieldset>
   <button id="start" class="primary" disabled>${icon("spark")}<span>一键试穿</span>${icon("arrow")}</button>
   <div class="generate-meta"><span id="generate-note">只在点击试穿后开始生成</span><button id="stop" hidden>停止生成</button><span id="quota"></span></div>
   <p class="status" id="status" role="status" aria-live="polite">正在准备试衣间…</p>
   <div id="shopping" class="shopping" hidden><span class="eyebrow">LOVE THE LOOK?</span><h2>喜欢这套，去看看实物。</h2><div id="shopping-items"></div><p>跳转原商品页面购买；价格和库存以商家为准。</p></div>
   <div class="perks"><div>${icon("camera")}<span>一段短视频<small>建议 5 秒 · 最长 10 秒</small></span></div><div>${icon("suit")}<span>自由搭配<small>套装 / 上衣 / 下装 / 配饰</small></span></div><div>${icon("shield")}<span>轻量试穿<small>生成结果留在本机</small></span></div></div>
   <p class="disclaimer">AI 生成效果供穿搭参考，无法判断真实尺码与合身程度。</p>
   <footer><span>X-MIRROR · MADE FOR YOUR NEXT LOOK</span><span>POWERED BY XMAX</span></footer>
 </section>
</main>
<dialog id="source-dialog" class="source-dialog"><div class="dialog-heading"><div><span class="eyebrow">YOUR PERSONAL MODEL</span><h2>把你带进试衣间。</h2></div><button class="icon-button" data-close="source-dialog" aria-label="关闭人物素材窗口">${icon("close")}</button></div>
 <div class="source-tools"><button id="upload-source" class="outline">${icon("upload")}上传视频 / 照片</button><button id="record-source" class="outline">${icon("camera")}摄像头录制</button></div><input id="model-file" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime" hidden>
 <p class="field-note">视频建议 5 秒，最长 10 秒、最大 30 MB。单人、光线充足、身体无遮挡。</p>
 <label class="coverage">人物入镜范围<select id="coverage"><option value="full">全身（腿部完整入镜）</option><option value="half">半身（主要试上衣 / 配饰）</option></select></label>
 <div id="camera-panel" class="camera-panel" hidden><video id="camera-preview" muted autoplay playsinline></video><div><span id="camera-clock">准备好后开始录制</span><button id="record-toggle" class="outline">开始录制</button><button id="camera-close" class="text-button">关闭摄像头</button></div></div>
 <div id="demo-models" class="demo-models" hidden><span class="eyebrow">或先用本地参考素材体验</span><div><button data-model="studio">${icon("play")}全身视频</button><button data-model="woman">${icon("play")}半身视频</button><button data-model="man">${icon("play")}男模视频</button></div></div>
 <p id="source-status" class="status" role="status"></p><button id="source-done" class="primary">使用这个人物 ${icon("check")}</button>
</dialog>
<dialog id="guide-dialog" class="guide-dialog"><div class="dialog-heading"><h2>让试穿效果更自然。</h2><button class="icon-button" data-close="guide-dialog" aria-label="关闭使用指南">${icon("close")}</button></div><ol><li><strong>拍一段真实的你。</strong><p>建议 5 秒，最长 10 秒。保持单人、明亮、无遮挡；试下装时让腿部完整入镜。</p></li><li><strong>上传原视频或照片。</strong><p>视频输入生成同长度视频，照片输入生成照片。视频连续输入，保留原片动作。</p></li><li><strong>添加想试的单品。</strong><p>粘贴商品链接或上传清晰正面图片。页面需要登录、验证码或无法读取时，补传图片即可。</p></li><li><strong>试好了，再去购买。</strong><p>保存照片或短片，点击商品入口前往商家。上传图片时也可以在链接栏补充购买链接。</p></li></ol><p class="guide-privacy">视频素材的画面会实时传给 XMAX，音频不发送；照片素材通过 SDK 原图输入处理。服饰参考图上传至 XMAX 存储，第三方保存规则见其隐私政策。本应用不保存人物和结果素材，刷新页面后需重新上传。</p><p id="demo-attribution" class="field-note" hidden>示例牛仔裤照片：A Continuous Lean，<a href="https://commons.wikimedia.org/wiki/File:Tellason_jeans,_front.jpg" target="_blank" rel="noopener noreferrer">原图</a> · <a href="https://creativecommons.org/licenses/by/2.0/" target="_blank" rel="noopener noreferrer">CC BY 2.0</a>，已缩小尺寸。</p><a href="https://22duck.cn/docs/resources/privacy/" target="_blank" rel="noopener noreferrer">查看 XMAX 隐私政策 ↗</a><p class="field-note">配饰与多件组合效果仍需逐款确认；试穿图片不能替代真实尺码判断。</p></dialog>`;

function status(message: string, error = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
}
function safeError(error: unknown) {
  return (error instanceof Error ? error.message : "处理失败，请重试").replace(
    /\b(?:uk|tk)-[A-Za-z0-9_-]+/g,
    "[redacted]",
  );
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(
    path,
    body === undefined
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "服务暂时不可用");
  return data;
}
function controls() {
  const locked = busy || finishing;
  $<HTMLFieldSetElement>("input-controls").disabled = locked || loadingSource;
  $<HTMLButtonElement>("start").disabled =
    locked ||
    loadingSource ||
    linkBusy ||
    !config?.configured ||
    !!config.active ||
    (config.remaining !== null && config.remaining <= 0) ||
    !source ||
    !Object.values(slots).length ||
    !$<HTMLInputElement>("consent").checked;
  $("stop").hidden = !busy || finishing;
  $<HTMLButtonElement>("compare").disabled = !result?.photo || locked;
  $<HTMLButtonElement>("source-done").disabled = !source || loadingSource;
  $<HTMLButtonElement>("mode-video").disabled = true;
  $<HTMLButtonElement>("mode-photo").disabled = true;
  $("quota").textContent = config?.configured
    ? config.remaining === null ? "测试次数不限" : `今日可试 ${config.remaining} 次`
    : "";
  $("engine-dot").classList.toggle("ready", !!config?.configured);
}
async function refreshConfig() {
  config = await api<Config>("/api/status");
  controls();
}
function clearResult() {
  result = undefined;
  release(resultURL);
  resultURL = undefined;
  comparing = false;
  $<HTMLVideoElement>("result-video").pause();
  $<HTMLVideoElement>("result-video").removeAttribute("src");
  $("result-video").hidden = true;
  $("result-photo").hidden = true;
  $("remote").hidden = true;
  $("result-actions").hidden = true;
  $("shopping").hidden = true;
  $("loading").hidden = true;
  showOriginal(!!source);
  $("empty-stage").hidden = !!source;
  $("stage-label").innerHTML = `${icon("person")}人物预览`;
  $("stage-caption").textContent = "一段视频，无限穿搭灵感。";
  $("compare").classList.remove("comparing");
  controls();
}
function showOriginal(visible: boolean) {
  $("person-preview").hidden = !visible || !!source?.isVideo;
  const video = $<HTMLVideoElement>("person-video");
  video.hidden = !visible || !source?.isVideo;
  if (!video.hidden) void video.play().catch(() => {});
  else video.pause();
}
function renderSource() {
  if (!source) return;
  for (const id of ["source-thumb", "person-preview", "original-thumb"]) {
    if (source.poster) $<HTMLImageElement>(id).src = source.poster;
    else $(id).removeAttribute("src");
    $(id).hidden = source.isVideo;
  }
  for (const id of ["source-thumb-video", "original-thumb-video"]) {
    const preview = $<HTMLVideoElement>(id);
    preview.hidden = !source.isVideo;
    if (source.isVideo) {
      preview.onloadeddata = () => { preview.currentTime = Math.min(0.01, source!.duration / 2); };
      preview.src = source.url;
    } else { preview.removeAttribute("src"); preview.load(); }
  }
  const video = $<HTMLVideoElement>("person-video");
  if (source.isVideo && video.getAttribute("src") !== source.url)
    video.src = source.url;
  if (!source.isVideo) {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
  showOriginal(true);
  $("source-placeholder").hidden = true;
  $("source-name").textContent = source.file.name;
  $("source-description").textContent =
    `${source.coverage === "full" ? "全身" : "半身"} · ${source.isVideo ? `${source.duration.toFixed(1)} 秒视频` : "照片"} · 本地素材`;
  $<HTMLSelectElement>("coverage").value = source.coverage;
  setMode();
  controls();
}
async function setSource(
  file: File,
  coverage = $<HTMLSelectElement>("coverage").value as Source["coverage"],
  recordedDuration?: number,
) {
  if (busy || finishing || loadingSource) return;
  loadingSource = true;
  $("source-status").textContent = "正在读取原始素材…";
  controls();
  try {
    const next = await readSource(file, coverage, recordedDuration);
    release(source?.url);
    source = next;
    createdURLs.add(next.url);
    clearResult();
    renderSource();
    $("source-status").textContent = source.isVideo ? `原视频已就绪 · ${source.duration.toFixed(2)} 秒，将输出同长度视频。` : "原照片已就绪，将输出试穿照片。";
    status("人物已就绪，搭配好后点击「一键试穿」。");
  } catch (error) {
    $("source-status").textContent = safeError(error);
    status(safeError(error), true);
  } finally {
    loadingSource = false;
    controls();
  }
}
function setMode() {
  if (busy || finishing) return;
  mode = source?.isVideo ? "video" : "photo";
  clearResult();
  for (const value of ["photo", "video"]) {
    const button = $(`mode-${value}`);
    button.classList.toggle("selected", mode === value);
    button.setAttribute("aria-pressed", String(mode === value));
  }
  $("mode-note").textContent =
    mode === "photo"
      ? "自动输出试穿照片"
      : `自动输出视频 · ${source?.duration.toFixed(2)} 秒`;
}
function renderSlots() {
  $("slots").replaceChildren();
  for (const key of categories) {
    const item = slots[key];
    const card = document.createElement("div");
    card.className = `outfit-slot ${category === key ? "active" : ""}`;
    const button = document.createElement("button");
    button.className = "slot-select";
    button.setAttribute("aria-label", `选择${labels[key]}`);
    const visual = document.createElement("span");
    visual.className = "slot-image";
    if (item) {
      const image = document.createElement("img");
      image.src = item.image;
      image.alt = item.name;
      visual.append(image);
    } else
      visual.innerHTML = icon(
        key === "suit" ? "suit" : key === "top" ? "shirt" : key === "bottom" ? "pants" : "hat",
      );
    const caption = document.createElement("span");
    const label = document.createElement("b");
    label.textContent = labels[key];
    const detail = document.createElement("small");
    detail.textContent = item?.name || "添加单品";
    caption.append(label, detail);
    button.append(visual, caption);
    button.onclick = () => selectCategory(key);
    card.append(button);
    if (item) {
      const remove = document.createElement("button");
      remove.className = "slot-remove";
      remove.setAttribute("aria-label", `移除${labels[key]}`);
      remove.innerHTML = icon("close");
      remove.onclick = () => {
        delete slots[key];
        clearResult();
        renderWardrobe();
        renderSlots();
      };
      card.append(remove);
    }
    $("slots").append(card);
  }
  const count = Object.values(slots).length;
  $("outfit-count").textContent = count
    ? `已选 ${count} 件${count > 1 ? " · 组合试穿为实验功能" : ""}`
    : "选择心动的单品";
  controls();
}
function selectCategory(next: Category) {
  if (busy || finishing) return;
  category = next;
  document
    .querySelectorAll<HTMLButtonElement>("[data-category]")
    .forEach((button) => {
      const selected = button.dataset.category === category;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-selected", String(selected));
    });
  $("accessory-kind").hidden = category !== "accessory";
  $("category-help").textContent = categoryHelp[category];
  $("garment-upload-title").textContent = `上传${labels[category]}图片`;
  renderSlots();
  renderWardrobe();
}
function choose(item: Garment) {
  if (busy || finishing) return;
  const replaced = item.category === "suit" ? !!(slots.top || slots.bottom) : (item.category === "top" || item.category === "bottom") && !!slots.suit;
  applyGarment(slots, item);
  category = item.category;
  clearResult();
  selectCategory(category);
  status(`已添加${item.name}${replaced ? item.category === "suit" ? "，已替换原先的上衣和下装，可继续添加配饰。" : "，已移除套装，可继续搭配其他单品。" : "，可以继续搭配。"}`);
}
function renderWardrobe() {
  $("wardrobe").replaceChildren();
  const items = catalog.filter((item) => item.category === category);
  if (!items.length) {
    const p = document.createElement("p");
    p.className = "wardrobe-empty";
    p.textContent = "添加商品链接，或上传一张服饰图片。";
    $("wardrobe").append(p);
  }
  items.forEach((item) => {
    const button = document.createElement("button");
    button.className = `garment ${slots[category]?.id === item.id ? "selected" : ""}`;
    button.setAttribute("aria-label", `试穿${item.name}`);
    button.setAttribute(
      "aria-pressed",
      String(slots[category]?.id === item.id),
    );
    const image = document.createElement("img");
    image.src = item.image;
    image.alt = item.name;
    image.loading = "lazy";
    const caption = document.createElement("span");
    caption.textContent = item.name;
    const check = document.createElement("i");
    check.innerHTML = icon("check");
    button.append(image, caption, check);
    button.onclick = () => choose(item);
    $("wardrobe").append(button);
  });
  const chosen = categories.flatMap(key => slots[key] ? [slots[key]!] : []);
  const low = chosen.filter((g) => g.width && g.height && Math.min(g.width, g.height) < 768);
  $("garment-quality").hidden = !chosen.length;
  $("garment-quality").textContent = chosen.map((g) => `${g.name} · ${g.width || "?"} × ${g.height || "?"}`).join("；")
    + (low.length ? "。部分图片细节不足，建议更换最长边 1500～2000px 的清晰商品正面原图。" : "。已保留原图细节，避免截图、拼图与大面积留白。");
  $("catalog-note").textContent = config?.demoEnabled
    ? "本地参考单品"
    : "我的衣橱";
}
function purchaseLink(): string | undefined {
  const value = $<HTMLInputElement>("product-url").value.trim();
  if (!value) return;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return;
    return url.href;
  } catch {
    return;
  }
}
async function uploadGarment(file: File) {
  if (busy || finishing || linkBusy) return;
  const selectedCategory = category;
  const accessory = $<HTMLSelectElement>("accessory-select").value;
  try {
    const dimensions = await validateImage(file);
    const item: Garment = {
      id: crypto.randomUUID(),
      name: file.name.replace(/\.[^.]+$/, ""),
      category: selectedCategory,
      image: objectURL(file),
      ...dimensions,
      file,
      purchaseUrl: purchaseLink(),
      accessory:
        selectedCategory === "accessory"
          ? accessory
          : undefined,
    };
    catalog.unshift(item);
    choose(item);
    $("link-status").hidden = true;
  } catch (error) {
    status(safeError(error), true);
  } finally {
    $<HTMLInputElement>("garment-file").value = "";
  }
}
$("link-form").onsubmit = async (event) => {
  event.preventDefault();
  if (busy || finishing || linkBusy) return;
  const url = purchaseLink();
  if (!url) {
    $("link-status").hidden = false;
    $("link-status").textContent = "请输入完整的 HTTP / HTTPS 链接";
    return;
  }
  const selectedCategory = category;
  const selectedAccessory = $<HTMLSelectElement>("accessory-select").value;
  linkBusy = true;
  $<HTMLButtonElement>("resolve-link").disabled = true;
  controls();
  $("link-status").hidden = false;
  $("link-status").textContent = "正在读取商品主图…";
  try {
    const product = await api<{
      title: string;
      sourceUrl: string;
      dataUrl: string;
    }>("/api/products/resolve", { url });
    const file = new File(
      [await (await fetch(product.dataUrl)).blob()],
      "product.jpg",
      { type: product.dataUrl.match(/^data:([^;]+)/)?.[1] || "image/jpeg" },
    );
    const dimensions = await validateImage(file);
    const item: Garment = {
      id: crypto.randomUUID(),
      name: product.title,
      image: objectURL(file),
      ...dimensions,
      file,
      category: selectedCategory,
      purchaseUrl: url,
      accessory:
        selectedCategory === "accessory"
          ? selectedAccessory
          : undefined,
    };
    catalog.unshift(item);
    choose(item);
    $("link-status").textContent = "商品已添加，请确认主图和类别是否正确。";
  } catch (error) {
    // Keep the URL even on parsing failure so an uploaded image can be purchased.
    $("link-status").textContent =
      `${safeError(error)}。链接已保留，可直接上传图片。`;
  } finally {
    linkBusy = false;
    $<HTMLButtonElement>("resolve-link").disabled = false;
    controls();
  }
};
$("product-url").oninput = () => {
  $("bind-link").hidden = !purchaseLink() || !slots[category];
};
$("bind-link").onclick = () => {
  const url = purchaseLink();
  if (url && slots[category]) {
    slots[category]!.purchaseUrl = url;
    clearResult();
    $("link-status").hidden = false;
    $("link-status").textContent =
      "购买链接已绑定到当前单品，生成后可前往购买。";
    $("bind-link").hidden = true;
  }
};
$("garment-file").onchange = () => {
  const file = $<HTMLInputElement>("garment-file").files?.[0];
  if (file) void uploadGarment(file);
};
for (const event of ["dragenter", "dragover"])
  $("garment-drop").addEventListener(event, (e) => {
    e.preventDefault();
    if (!busy && !finishing) $("garment-drop").classList.add("dragging");
  });
$("garment-drop").addEventListener("dragleave", () =>
  $("garment-drop").classList.remove("dragging"),
);
$("garment-drop").addEventListener("drop", (event) => {
  event.preventDefault();
  $("garment-drop").classList.remove("dragging");
  if (event.dataTransfer?.files[0])
    void uploadGarment(event.dataTransfer.files[0]);
});
document
  .querySelectorAll<HTMLButtonElement>("[data-category]")
  .forEach(
    (button) =>
      (button.onclick = () =>
        selectCategory(button.dataset.category as Category)),
  );
$("accessory-select").onchange = () => {
  if (slots.accessory) {
    slots.accessory.accessory = $<HTMLSelectElement>("accessory-select").value;
    clearResult();
  }
};
$("consent").onchange = controls;
function openSource() {
  if (busy || finishing) return;
  $<HTMLDialogElement>("source-dialog").showModal();
}
for (const id of ["source-open", "empty-upload"]) $(id).onclick = openSource;
$("guide-open").onclick = () =>
  $<HTMLDialogElement>("guide-dialog").showModal();
document
  .querySelectorAll<HTMLButtonElement>("[data-close]")
  .forEach(
    (button) =>
      (button.onclick = () =>
        $<HTMLDialogElement>(button.dataset.close!).close()),
  );
$("source-done").onclick = () => {
  if (source) $<HTMLDialogElement>("source-dialog").close();
};
$("upload-source").onclick = () => {
  if (!loadingSource) $("model-file").click();
};
$("model-file").onchange = () => {
  const input = $<HTMLInputElement>("model-file");
  const file = input.files?.[0];
  if (file) void setSource(file);
  input.value = "";
};
$("coverage").onchange = () => {
  if (source) {
    source.coverage = $<HTMLSelectElement>("coverage")
      .value as Source["coverage"];
    clearResult();
    renderSource();
  }
};
document.querySelectorAll<HTMLButtonElement>("[data-model]").forEach(
  (button) =>
    (button.onclick = async () => {
      if (loadingSource) return;
      const name = button.dataset.model!;
      try {
        const path = `/demo/${name}.mp4`;
        const res = await fetch(path);
        if (!res.ok) throw new Error("参考素材尚未准备，请上传自己的素材");
        await setSource(
          new File(
            [await res.blob()],
            name === "studio"
              ? "Studio 网站试衣服.mp4"
              : name === "man"
                ? "男模半身参考.mp4"
                : "半身参考视频.mp4",
            { type: "video/mp4" },
          ),
          name === "studio" ? "full" : "half",
        );
      } catch (error) {
        $("source-status").textContent = safeError(error);
      }
    }),
);

let camera: MediaStream | undefined, cameraRecorder: MediaRecorder | undefined;
let cameraTimer: ReturnType<typeof setTimeout> | undefined,
  cameraClock: ReturnType<typeof setInterval> | undefined;
let recordedChunks: Blob[] = [],
  cameraStarted = 0;
function closeCamera() {
  if (cameraRecorder?.state === "recording") cameraRecorder.stop();
  clearTimeout(cameraTimer);
  clearInterval(cameraClock);
  camera?.getTracks().forEach((track) => track.stop());
  camera = undefined;
  $<HTMLVideoElement>("camera-preview").srcObject = null;
  $("camera-panel").hidden = true;
}
async function openCamera() {
  openSource();
  if (camera || loadingSource) return;
  if (
    !window.isSecureContext ||
    !navigator.mediaDevices?.getUserMedia ||
    !("MediaRecorder" in window)
  ) {
    $("source-status").textContent =
      "当前浏览器无法录制。请使用 HTTPS 页面，或在手机相机录制后上传短视频。";
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 720 },
        height: { ideal: 1280 },
      },
      audio: false,
    });
    if (!$<HTMLDialogElement>("source-dialog").open) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    camera = stream;
    $<HTMLVideoElement>("camera-preview").srcObject = stream;
    $("camera-panel").hidden = false;
    $("camera-clock").textContent = "建议录制 5 秒，10 秒自动停止";
    $("record-toggle").textContent = "开始录制";
  } catch {
    $("source-status").textContent =
      "摄像头未获授权或被其他应用占用，可改为上传短视频。";
  }
}
for (const id of ["record-source", "camera-open"])
  $(id).onclick = () => void openCamera();
$("camera-close").onclick = closeCamera;
$<HTMLDialogElement>("source-dialog").addEventListener("close", closeCamera);
$("record-toggle").onclick = () => {
  if (!camera) return;
  if (cameraRecorder?.state === "recording") {
    cameraRecorder.stop();
    return;
  }
  const mime = ["video/webm;codecs=vp8", "video/webm", "video/mp4"].find(
    (type) => MediaRecorder.isTypeSupported(type),
  );
  if (!mime) {
    $("source-status").textContent = "当前浏览器不支持录制格式，请改用上传";
    return;
  }
  recordedChunks = [];
  const recorder = new MediaRecorder(camera, { mimeType: mime });
  cameraRecorder = recorder;
  recorder.ondataavailable = (event) => {
    if (event.data.size) recordedChunks.push(event.data);
  };
  recorder.onstop = async () => {
    clearTimeout(cameraTimer);
    clearInterval(cameraClock);
    $("record-toggle").textContent = "开始录制";
    cameraRecorder = undefined;
    const duration = Date.now() - cameraStarted;
    const blob = await normalizeRecording(
      new Blob(recordedChunks, { type: recorder.mimeType }),
      duration,
    );
    // WebM recordings may lack duration metadata; use the measured local recording
    // duration only for this trusted in-app capture, never for uploaded files.
    if (blob.size) {
      const file = new File(
        [blob],
        `我的录制.${mime.includes("mp4") ? "mp4" : "webm"}`,
        { type: mime.split(";")[0] },
      );
      await setSource(
        file,
        $<HTMLSelectElement>("coverage").value as Source["coverage"],
        duration / 1000,
      );
    }
  };
  recorder.onerror = () => {
    closeCamera();
    $("source-status").textContent = "录制失败，请改为上传短视频";
  };
  recorder.start(250);
  cameraStarted = Date.now();
  $("record-toggle").textContent = "停止并使用";
  cameraClock = setInterval(
    () =>
      ($("camera-clock").textContent =
        `录制中 ${Math.min(10, (Date.now() - cameraStarted) / 1000).toFixed(1)} / 10 秒`),
    100,
  );
  cameraTimer = setTimeout(() => {
    if (recorder.state === "recording") recorder.stop();
  }, 9500);
};

function renderShopping() {
  const items = lastOutfit.filter((item) => item.purchaseUrl);
  $("shopping").hidden = !items.length || !result?.photo;
  $("shopping-items").replaceChildren();
  items.forEach((item) => {
    const anchor = document.createElement("a");
    anchor.href = item.purchaseUrl!;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    const image = document.createElement("img");
    image.src = item.image;
    image.alt = item.name;
    const name = document.createElement("span");
    name.textContent = item.name;
    const action = document.createElement("b");
    action.textContent = "去购买 ↗";
    anchor.append(image, name, action);
    $("shopping-items").append(anchor);
  });
}
async function showResult() {
  if (!result?.photo) return false;
  showOriginal(comparing);
  $("remote").hidden = true;
  $<HTMLImageElement>("result-photo").src = result.photo;
  $("result-photo").hidden = comparing;
  const video = $<HTMLVideoElement>("result-video");
  video.hidden = true;
  if (resultURL && !comparing) {
    try {
      if (video.getAttribute("src") !== resultURL) {
        const loaded = waitMedia(video, "loadeddata");
        video.src = resultURL;
        await loaded;
        video.playbackRate = 1;
      }
      await video.play();
      video.hidden = false;
      $("result-photo").hidden = true;
    } catch {
      $("stage-label").textContent = "短片播放失败";
      status("短片无法播放，当前显示试穿封面。请刷新后重新试穿。", true);
      return false;
    }
  } else video.pause();
  if (result.video && !resultURL) {
    $("stage-label").textContent = "短片保存失败";
    return false;
  }
  $("stage-label").innerHTML = comparing
    ? `${icon("person")}原始画面`
    : `${icon("check")}${result.video && !result.complete ? "未完成的短片" : "试穿完成"}${result.video ? ` · ${result.duration?.toFixed(2)} 秒` : " · 照片"}`;
  $("stage-caption").textContent = comparing
    ? "真实的你。"
    : `${result.video ? `${result.duration?.toFixed(2)} 秒视频 · ` : "试穿照片 · "}${result.width} × ${result.height} · ${lastOutfit.map((item) => item.name).join(" + ")}`;
  $("compare").classList.toggle("comparing", comparing);
  $("result-actions").hidden = false;
  $("save-video").hidden = !result?.video;
  $("save-photo").hidden = !!source?.isVideo;
  renderShopping();
  controls();
  return true;
}
async function end(error?: string) {
  if (finishing || !busy) return;
  finishing = true;
  epoch++;
  clearTimeout(hardTimer);
  status("正在结束连接并保存结果…");
  $("loading-text").textContent = "正在保存结果";
  controls();
  let cleanupFailed = false;
  try {
    // Await pending issuance on cancellation, so even a late ticket gets revoked.
    if (pendingTicket && !ticket)
      try {
        ticket = await pendingTicket;
      } catch {}
    const current = session;
    session = undefined;
    const saved = await current?.stop();
    const revoke = ticket
      ? api<{ revoked?: boolean }>("/api/finish", { lease: ticket.lease })
          .then((value) => value.revoked !== false, () => false)
      : Promise.resolve(true);
    error ||= saved?.failure;
    if (saved?.photo && (!source?.isVideo || saved.video)) result = saved;
    if (result?.video) resultURL = objectURL(result.video);
    ticket = undefined;
    pendingTicket = undefined;
    busy = false;
    $("loading").hidden = true;
    if (result?.photo) {
      comparing = false;
      if (!(await showResult())) {
        result.complete = false;
        error ||= "生成短片无法播放，当前显示试穿封面，请重新试穿。";
      }
    } else {
      $("remote").hidden = true;
      showOriginal(!!source);
      $("stage-label").innerHTML = `${icon("person")}原始素材 · 未生成结果`;
      $("stage-caption").textContent = "当前显示原始素材，尚未生成可保存的试穿结果。";
    }
    const partial = !!result?.video && !result.complete;
    const dimensions = result ? `${result.width} × ${result.height}` : "";
    const startup = clickToFirstFrameMs ? ` · 首帧 ${(clickToFirstFrameMs/1000).toFixed(1)} 秒` : "";
    const transport = result?.transport?.endToEndDelayMs;
    const latency = transport === undefined ? "" : ` · RTC 媒体延迟约 ${Math.round(transport)}ms`;
    const fps = result?.playback ? ` · 接收 ${result.playback.fps.toFixed(1)}fps` : "";
    status(error || (result
      ? `${partial ? "已保存未完成的视频片段" : "试穿已完成"} · ${dimensions}${result.video ? ` · ${result.duration?.toFixed(2)} 秒` : ""}${startup}${latency}${fps}。`
      : "本次生成已停止，尚未收到可保存的结果。"), !!error || partial);
    window.dispatchEvent(new CustomEvent("xmirror:metrics", {detail: {
      width: result?.width, height: result?.height, duration: result?.duration,
      sourceDuration: source?.duration, complete: result?.complete,
      remoteUserID: result?.remoteUserID, clickToFirstFrameMs, startupMs: result?.startupMs, timing: result?.timing, transport: result?.transport,
      playback: result?.playback, recording: result?.recording,
    }}));
    // Present the saved media before network cleanup completes; keep new sessions locked.
    await current?.cleanup;
    cleanupFailed = !(await revoke);
    if (cleanupFailed)
      status(
        "结果已保留；会话撤销未确认，临时密钥将在额度或到期限制下停止。",
        true,
      );
    try {
      await refreshConfig();
    } catch {
      status("无法确认服务状态，请刷新页面后再试。", true);
    }
  } finally {
    busy = false;
    finishing = false;
    controls();
  }
}
$("start").onclick = async () => {
  if ($<HTMLButtonElement>("start").disabled || !source || busy || finishing)
    return;
  const outfit = categories.flatMap(key => slots[key] ? [slots[key]!] : []);
  if (source.coverage === "half" && (slots.bottom || slots.suit)) {
    status("试套装或下装需要腿部完整入镜，请更换全身素材，或仅选择上衣 / 配饰。", true);
    return;
  }
  clearResult();
  busy = true;
  controls();
  clickedAt = performance.now();
  clickToFirstFrameMs = undefined;
  const run = ++epoch;
  const valid = () => busy && !finishing && epoch === run;
  lastOutfit = outfit.map((item) => ({ ...item }));
  $("loading").hidden = false;
  $("loading-text").textContent = "正在准备你的新造型";
  status("正在整理搭配素材…");
  try {
    const [reference, { TryOnSession }] = await Promise.all([buildReference(outfit), providerModule]);
    if (!valid()) return;
    status("正在创建限额试穿会话…");
    pendingTicket = api<Ticket>("/api/start", {
      requestId: crypto.randomUUID(),
      sourceSeconds: source.isVideo ? source.duration : 1,
    });
    const next = await pendingTicket;
    if (!valid()) return;
    ticket = next;
    hardTimer = setTimeout(
      () => void end("生成等待超时，已停止连接。请检查网络后手动重试。"),
      Math.max(5, next.sessionSeconds - 3) * 1000,
    );
    session = new TryOnSession(
      $("remote"),
      (message) => {
        if (valid()) {
          status(message);
          $("loading-text").textContent = message;
        }
      },
      () => {
        if (!valid()) return;
        clickToFirstFrameMs = performance.now() - clickedAt;
        window.dispatchEvent(new CustomEvent("xmirror:first-frame", { detail: { clickToFirstFrameMs } }));
        $("loading").hidden = true;
        showOriginal(false);
        $("remote").hidden = false;
        $("remote").style.opacity = "1";
        $("stage-label").innerHTML = `<i class="live-dot"></i>正在试穿`;
        $("stage-caption").textContent = lastOutfit
          .map((item) => item.name)
          .join(" + ");
        status(
          `正在生成${mode === "photo" ? "试穿照片" : "动态短片"}，最多 ${mode === "photo" ? 1 : source!.duration.toFixed(2)} 秒后自动保存。`,
        );
      },
      (_result, error) => {
        if (valid()) void end(error);
      },
    );
    // Keep the RTC element rendered during warmup. display:none can suspend
    // video decoding in embedded/mobile browsers and prevent the first frame.
    $("remote").hidden = false;
    $("remote").style.opacity = "0";
    await session.start(
      next,
      source,
      reference.file,
      buildPrompt(outfit, reference.layout),
    );
  } catch (error) {
    if (valid())
      await end(`试穿未完成：${safeError(error)}。可以检查网络后手动重试。`);
  }
};
$("stop").onclick = () => void end();
for (const id of ["compare", "back-original"])
  $(id).onclick = () => {
    if (!result?.photo || busy || finishing) return;
    comparing = !comparing;
    showResult();
  };
function download(blob: Blob | string, name: string) {
  const a = document.createElement("a");
  const url = typeof blob === "string" ? blob : objectURL(blob);
  a.href = url;
  a.download = name;
  a.click();
  if (typeof blob !== "string") setTimeout(() => release(url), 1000);
}
$("save-photo").onclick = () => {
  if (result?.photo) download(result.photo, `X-Mirror-${Date.now()}.jpg`);
};
$("save-video").onclick = () => {
  if (result?.video)
    download(
      result.video,
      `X-Mirror-${Date.now()}.${result.video.type.includes("mp4") ? "mp4" : "webm"}`,
    );
};
$("expand").onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.querySelector(".stage")?.requestFullscreen();
  } catch {
    status("浏览器未允许全屏，可以直接保存结果查看。");
  }
};
window.addEventListener("pagehide", () => {
  closeCamera();
  if (ticket)
    void fetch("/api/finish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lease: ticket.lease }),
      keepalive: true,
    });
  void session?.stop();
  createdURLs.forEach(URL.revokeObjectURL);
});
renderSlots();
controls();
void (async () => {
  try {
    await refreshConfig();
    const data = await api<{ items: Garment[] }>("/api/catalog");
    catalog = config?.demoEnabled ? demoCatalog as Garment[] : data.items;
    await Promise.all(catalog.map(async (item) => {
      try {
        const image = await loadImage(item.image);
        item.width = image.naturalWidth; item.height = image.naturalHeight;
      } catch { /* Broken references remain visible for replacement. */ }
    }));
    $("demo-models").hidden = !config?.demoEnabled;
    $("demo-attribution").hidden = !config?.demoEnabled;
    renderWardrobe();
    if (config?.demoEnabled) {
      const response = await fetch("/demo/studio.mp4");
      if (response.ok)
        await setSource(
          new File([await response.blob()], "Studio 网站试衣服.mp4", {
            type: "video/mp4",
          }),
          "full",
        );
      const initial = catalog.find((item) => item.id === "suit");
      if (initial) {
        applyGarment(slots, initial);
        renderSlots();
        renderWardrobe();
      }
    }
    status(
      config?.configured
        ? config.active
          ? "试衣间正在使用中，请稍后刷新。"
          : "试衣间已就绪。选择素材并确认授权后，一键试穿。"
        : "请在服务端配置 XMAX_API_KEY 后重启。",
      !config?.configured,
    );
    controls();
  } catch (error) {
    status(`无法准备试衣间：${safeError(error)}`, true);
  }
})();
