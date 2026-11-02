import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';

// X-Mirror 与 Camera Studio 共用仓库根目录的 .env，只有端口不同：
// X-Mirror 用 PORT，Camera Studio 用 CAMERA_STUDIO_PORT（默认 5190）。
export const rootDir = fileURLToPath(new URL('../../..', import.meta.url));
export const loadSharedEnv = () => ({ ...loadEnv('development', rootDir, ''), ...process.env });
export const studioPort = env => Number(env.CAMERA_STUDIO_PORT || 5190);
