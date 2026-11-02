# Camera Studio toolkit

X-Mirror 的独立本地 GUI 工具：录制 3～10 秒摄像头视频，点击右侧素材窗，用准备好的图片及提示词调用 Xmax X2.1，自动保存生成视频并支持历史回放。

工具拥有自己的依赖、配置、素材和输出目录，不依赖主应用的服务或配置，也可单独拷贝使用。默认端口 **5190**，仅监听本机。

## 安装与启动

需要 Node.js 22.12+，推荐 Node.js 24、Chrome / Edge。安装 FFmpeg、FFprobe 并加入 PATH，可以自动保存 H.264 MP4；缺少时保存 WebM。

在仓库根目录执行：

```powershell
# 配置使用仓库根目录的 .env（填写 XMAX_API_KEY；需要代理时填写 XMAX_PROXY_URL）
npm run toolkit:camera:setup
npm run toolkit:camera
```

也可在本目录运行：

```powershell
npm ci
npm run prepare:materials
npm start
```

打开 [http://127.0.0.1:5190](http://127.0.0.1:5190)，首次打开摄像头时允许浏览器访问设备。不采集麦克风音频。Windows 用户也可运行 `start.ps1`，它会检查依赖并准备缺少的素材。

## 使用

1. 打开摄像头，选择设备和 3～10 秒录制时长。
2. 或点击「上传视频片段」选择 MP4 / WebM / MOV（至少 3 秒，超过 10 秒自动截取前 10 秒，需 FFmpeg；上限 100 MB）。
2. 点击「录制短片」，到时自动停止并保存原视频。
3. 点击右侧素材直接生成；同一段原片可连续尝试不同素材，每次点击创建一次新的付费任务。
4. 修改提示词后点击「生成当前效果」。素材右上角的预览按钮只查看大图，不调用模型。
5. 生成画面就绪后录制对应时长，随后关闭会话并保存；「停止处理」可提前结束并保存已有片段。
6. 「最近保存」可回放历史，刷新页面后仍保留；「打开本地保存目录」可查看文件。

摄像头录制、浏览素材和回放不会启动模型。失败不自动重试，使用完可以单独关闭摄像头。

## 高清离线生成

生成使用 Xmax **离线（非实时）高清任务**（quality=hd）：浏览器只上传原视频和参考图，提交任务、轮询、下载结果由本地后端用永久 Key 完成。结果不再依赖实时回传和录屏，帧率和时长与原片一致，清晰度明显更高。一次生成通常需要数十秒到数分钟，页面显示等待进度；「停止处理」只停止等待，已提交的任务仍会在服务端完成并自动保存。离线任务按平台规则计费，每次点击只提交一次、不自动重试。可在 `.env` 用 `XMAX_OFFLINE_*` 调整，见 `.env.example`。

## 素材与提示词

右侧栏点击「＋ 添加素材」可上传图片并填写名称、分类、提示词（含「人脸替换」「服饰替换」等快捷提示词），保存在 `outputs/custom-materials/`，无需重启；自定义素材可删除。提示词上限 1024 字。

`public/presets.json` 已配置 12 款：人物、角色、人脸、头部、套装、上衣、帽子、背景、动作迁移、伙伴、天空山景、水下世界。

原始演示图片不随 Git 仓库分发。`npm run prepare:materials` 根据 `public/materials/sources.json` 下载缺少的图片，不调用付费生成接口，已有图片不会覆盖。下载失败时可以自行补齐图片，再运行 `npm run check:materials`。

新增自己的图片：放进 `public/materials/`，在 `public/presets.json` 增加唯一编号、名称、类别、路径和提示词，然后重启：

```json
{
  "id": "my-hat",
  "name": "我的帽子",
  "category": "虚拟试穿",
  "image": "/materials/my-hat.jpg",
  "prompt": "将参考图中的帽子戴到人物头上，面容、服装和背景保持不变。",
  "referenceUrl": null
}
```

`referenceUrl: null` 的图片先经 SDK 上传；官方示例直接使用公开原地址。上传准备与生成分别使用限时凭证，避免上传等待挤占生成时间。图片来源和许可保存在 `sources.json`；官方演示素材未声明开放授权，按本地测试用途使用。公开使用 Commons 素材时遵循相应署名及许可。

## 本地保存

默认目录为本 toolkit 的 `outputs/`，可在 `.env` 设置 `STUDIO_OUTPUT_DIR`：

```text
outputs/<短片编号>/
  clip.json
  input-original.webm
  input.mp4
  input-probe.json
  runs/<生成编号>/
    prompt.txt
    report.json
    output-original.webm
    output.mp4
    output-probe.json
    preview.jpg
```

缺少 FFmpeg 时保留 WebM。启用 FFmpeg 时按配置时长裁切保存的 MP4，避免编码尾帧超过设定时长。失败仍保留原片和报告。`saved` 表示已落盘，不等于模型效果通过；面容、服装和非目标区域可能漂移。

## 配置与费用

配置与 X-Mirror 共用仓库根目录的 `.env`（字段见根目录 `.env.example`），只有端口不同：Camera Studio 使用 `CAMERA_STUDIO_PORT`（默认 5190），X-Mirror 使用 `PORT`。永久 Key 仅由本地后端使用，浏览器获得限额、单连接、会到期的临时凭证。默认每个准备／生成阶段最多 60 秒、100 积分、120 秒到期。停止或退出时尝试关闭 SDK 并撤销凭证，后端时限与平台额度兜底。实际消费以平台账单为准。

`XMAX_PROXY_URL` 配置后端 HTTP 代理，浏览器也要能访问 XMAX 存储与 RTC 网络。`CAMERA_STUDIO_PORT` 修改端口，`FFMPEG_PATH` / `FFPROBE_PATH` 指定可执行文件。修改配置后重启。

## 验证

```powershell
npm test
npm run build
npm run check:materials
npm run test:ui
```

UI 检查使用 Chrome 虚拟摄像头，不读取物理摄像头，不调用付费模型。缺少 `tests/camera.y4m` 时自动用 FFmpeg 生成合成测试画面，也可通过 `STUDIO_TEST_CAMERA_FILE` 指定自己的 Y4M。Linux 运行前执行 `npx playwright install chromium`，或通过 `CHROME_PATH` 指定浏览器。

检查覆盖 3／10 秒录制、素材预览、重复处理、本地保存、回放、刷新恢复、启动中停止、迟到凭证释放和手机布局，产物保存在 `.local/`。物理摄像头权限和实际画面由使用者在 GUI 中验证。

真实验证会消耗额度，必须明确运行 `npm run test:live`，配置 Key，并用 `STUDIO_TEST_CAMERA_FILE` 或本地 `tests/camera.y4m` 提供包含可辨认人物的视频。只进行一次帽子试穿。工具开发时已用人物视频模拟摄像头完成真实 X2.1 验证，真实输出不提交到仓库。
