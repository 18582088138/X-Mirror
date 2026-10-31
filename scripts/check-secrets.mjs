import { execFileSync } from "node:child_process";
import { loadEnv } from "vite";
const keys = [
  loadEnv("development", process.cwd(), "").XMAX_API_KEY,
  loadEnv("development", `${process.cwd()}/toolkits/camera-studio`, "").XMAX_API_KEY,
].filter(Boolean);
const files = execFileSync("git", ["ls-files", "--cached", "-z"])
  .toString()
  .split("\0")
  .filter(Boolean);
for (const file of files) {
  if (/(^|\/)\.env(?:$|\.)/.test(file) && !/(^|\/)\.env\.example$/.test(file))
    throw new Error("禁止提交本地环境文件");
  const content = execFileSync("git", ["show", `:${file}`], {
    maxBuffer: 20 * 1024 * 1024,
  }).toString();
  if (
    keys.some((key) => content.includes(key)) ||
    /\b(?:uk|tk)-[A-Za-z0-9_-]{20,}/.test(content)
  )
    throw new Error(`发现凭据，请移除后重新暂存：${file}`);
}
console.log(`PASS: ${files.length} 个暂存文件未包含本地 API Key 或环境文件。`);
