# X-Mirror

XMAX X2.1 驱动的轻量网页虚拟试衣间。手机与电脑通过浏览器打开，上传或录制短视频，选择服饰，生成试穿照片或短片，再前往原商品页面购买。

## 独立 toolkits

[Camera Studio](toolkits/camera-studio/README.md) 支持摄像头录制 3～10 秒短片、右侧素材与提示词、Xmax X2.1 生成、本地自动保存及历史回放。位于 `toolkits/camera-studio`，使用独立配置和输出目录，默认端口 5190。

```powershell
# 首次配置，已有文件时不要覆盖
Copy-Item toolkits/camera-studio/.env.example toolkits/camera-studio/.env
# 填写 toolkit 的 XMAX_API_KEY，按需配置代理
npm run toolkit:camera:setup
npm run toolkit:camera
```

更多说明见 [toolkits](toolkits/README.md)。素材由准备脚本下载到本地；演示图片、密钥、录像和生成结果不进入仓库。

## 本地启动

需要 Node.js 22.12+，推荐 Node.js 24。

```sh
npm ci
# 没有 .env 时，将 .env.example 复制为 .env 并填写 XMAX_API_KEY
npm run dev
```

默认地址为 `http://localhost:5180`。启动、选素材、选帧及商品解析不会调用付费试穿模型。点击“一键试穿”才创建 XMAX 会话。

当前开发目录已提供 `.env` 和参考素材；`.env`、原始参考素材及生成结果均不会进入 Git。此前 5173 端口被另一项目占用，因此本项目使用 5180。

准备本地参考素材需要系统安装 `ffmpeg`：

```sh
npm run prepare:demo
```

该脚本从 `ref_material` 和根目录 Logo 提取本地预览与参考单品。`public/demo` 不进入 Git；克隆仓库后没有原始参考素材也可以上传自己的素材使用。优化后的应用 Logo 位于 `public/brand/logo.webp`。

## 已实现的流程

默认模特使用 `ref_material/网站试衣服.mov` 的动态视频，裁剪左侧模特区域后转换为兼容浏览器的 MP4，保留原片 1.6 秒动作。人物预览和原图对比直接循环播放。有视频的模特始终以视频流送入试穿模型；视频默认选择动态短片，选择试穿照片时只改变保存结果的形式。小缩略图使用视频封面，不作为视频模特的替代输入。

- 上传视频或照片；视频最长 10 秒、最大 30 MB，图片最大 10 MB。
- 在浏览器本地提取五张候选封面；人物预览和试穿输入使用原视频。
- 摄像头录制，无音频，约 9.5 秒自动停止，为浏览器停止录制留出余量。
- 上衣、下装、配饰三个搭配槽位，支持替换、移除和拖入图片。
- 读取公开商品页面的 Open Graph、Twitter 图片及 JSON-LD 商品元数据；支持直接图片链接。解析失败时保留链接，允许补传图片或显式绑定到当前单品。
- 照片模式收到真实远端画面后最多再运行 3 秒；动态模式生成最多 8 秒。
- 保存照片、下载短片、对比原图、跳转购买。
- 停止、取消、超时和离开页面时关闭 SDK；后端主动撤销临时密钥。

半身素材不能试下装。入镜范围由用户确认，首版没有自动人体检测。帽子、眼镜以及多件参考图组合属于实验功能，不承诺任意商品均可精准试穿。AI 也可能改变未选中的服饰细节，不适合作为尺码或真实合身程度判断。

## API 与费用控制

使用官方 `@xmaxai/web-sdk` 的 `RealtimeModel.x2_1`，将选定照片转为静态视频流，或把本地短视频转为实时视频流。服饰图通过 SDK 的存储服务上传，然后使用 `RealtimeContext` 开始生成。浏览器只收到受限临时密钥。

后端通过官方接口 `POST /temporary-api-key` 签发密钥，通过 `PUT /temporary-api-key/:key/inactive` 撤销。国内接口基址为 `https://cloud.xmax.22duck.cn/open/api/v1`，海外为 `https://api.xmax.ai/open/api/v1`。

实际运行上限由 `.env` 配置，并由服务端进一步限制：

- 有效生成最长 8 秒；含签发和连接初始化的任务等待最长 60 秒。
- 单个临时密钥只允许一个连接，积分额度最多 100，最长 90 秒到期。
- 默认每位访客每日最多五次，全站每日最多预留 1000 积分，按北京时间午夜重置；全站同时只运行一个任务。
- 在调用之前持久记录预算预留。失败和不确定的网络结果也占用预留预算，不自动退款或重试。
- `.local/sessions.json` 只保存任务标识、匿名会话摘要、时间、预留积分和撤销状态；不保存密钥或图片。

**预留积分是预算上限，不等于实际账单。** XMAX 按连接时间收费，连接初始化和等待也可能计费；实际余额、扣费及第三方素材保留时间以供应商控制台和政策为准。

`XMAX_PROXY_URL` 只配置 Node 后端 HTTP 请求。浏览器的 SDK 请求与 WebRTC 仍需要可工作的网络；只配置后端代理不保证实时媒体能连接。

## 手机访问与正式运行

同一局域网可打开 `http://电脑局域网IP:5180`，使用视频文件上传。手机摄像头录制需要 HTTPS；HTTP 页面会提供相机录制后上传的降级提示。

```sh
npm run build
npm start
```

公开部署时使用 HTTPS 反向代理，并将 `PUBLIC_ORIGIN` 配置为实际站点的完整来源，例如 `https://mirror.example.com`。该值用于访问主机和跨来源请求校验。

生产模式默认禁用本地演示素材。确需在私人测试实例展示参考素材时设置 `ENABLE_LOCAL_DEMO=1`。官方演示素材未声明开放授权，不要将它们作为可公开分发的商品或模特素材。

服务端额度日志需要持久磁盘，首版只支持一个 Node 进程。多进程部署需要共享预算和会话锁。不要为增加额度而删除当日额度日志。

## 验证

```sh
npm test
npm run test:ui
npm run build
npm run test:production
```

`test:ui` 需要先启动开发服务器和安装桌面 Chrome；它使用明确标为测试用途的 SDK 替身，不调用付费模型，验证照片与视频生命周期、摄像头、选帧、下载、取消、布局和商品流程。验证产物在 `.local/verification`。

真实验证需要已配置 API Key，会消耗额度：

```sh
npm run test:live
# 可选单独验证的类别；失败不会自动重复付费调用
node scripts/verify-live.mjs --real-api --cases=bottom,hat,video
```

默认测试地址为 `http://127.0.0.1:5180`。真实输出位于 `.local/verification/live`，不会提交到 Git。

## 接口与项目结构

- `GET /api/status`：公开运行配置及当前访客剩余额度，不返回密钥或其他访客记录。
- `GET /api/catalog`：返回当前实例启用的本地参考单品。
- `POST /api/start`：通过提交标识去重、检查预算、签发临时密钥。
- `POST /api/finish`：检查会话归属并撤销临时密钥。
- `POST /api/products/resolve`：尝试解析商品页面，返回一张已下载的主图与商品名称。
- `POST /api/products/image`：校验并下载公开服饰图片。

前端位于 `src/`，模型适配位于 `src/provider.ts`，会话和费用控制位于 `server/api.mjs`，商品解析位于 `server/products.mjs`。服务端校验图片来源的 DNS 和每次重定向，拒绝内网与本机地址；直接连接会固定已校验的 IP，代理环境则仅支持内置零售与图片域名名单。

项目采用 Vite + TypeScript + 单个 Node 服务。根据提供的现有 XMAX 调用方式，使用原生浏览器页面和 SDK 比引入额外 React/Next.js 框架更直接；仍保持在一个项目内开发和部署。

## 官方资料

- [XMAX Quick Start](https://22duck.cn/docs/quick-start/)
- [官方实时视频能力及计费](https://platform.ducktracks.fun/docs/capabilities/realtime-video)
- [官方隐私政策](https://22duck.cn/docs/resources/privacy/)
- [初始开发需求与计划](docs/X-Mirror-MVP开发需求与计划.md)
