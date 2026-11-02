# X-Mirror toolkits

本目录提供可独立运行的本地工具，各自管理依赖、配置、素材及输出。

- [Camera Studio](camera-studio/README.md)：3～10 秒摄像头录制、预置素材及提示词、Xmax X2.1 生成、本地自动保存和历史回放。默认地址 `http://127.0.0.1:5190`。

在仓库根目录运行 `npm run toolkit:camera:setup` 安装依赖和准备素材，`npm run toolkit:camera` 启动，`npm run toolkit:camera:test` 执行不消耗模型额度的 UI 检查。配置与 X-Mirror 共用仓库根目录的 `.env`，只有端口不同。

密钥、依赖缓存、原始演示图片、摄像头录像和生成结果不提交到 Git。
