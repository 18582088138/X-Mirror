import { execFileSync } from "node:child_process";
import { loadEnv } from "vite";
const key = loadEnv("development", process.cwd(), "").XMAX_API_KEY;
const files = execFileSync("git", ["ls-files", "--cached", "-z"])
  .toString()
  .split("\0")
  .filter(Boolean);
for (const file of files) {
  if (/(^|\/)\.env(?:$|\.)/.test(file) && file !== ".env.example")
    throw new Error("禁止提交本地环境文件");
  const content = execFileSync("git", ["show", `:${file}`], {
    maxBuffer: 20 * 1024 * 1024,
  }).toString();
  if (
    (key && content.includes(key)) ||
    /\b(?:uk|tk)-[A-Za-z0-9_-]{20,}/.test(content)
  )
    throw new Error(`发现凭据，请移除后重新暂存：${file}`);
}
console.log(`PASS: ${files.length} 个暂存文件未包含本地 API Key 或环境文件。`);
