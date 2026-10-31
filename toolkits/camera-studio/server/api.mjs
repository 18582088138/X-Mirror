import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export function settings(env) {
  const number = (name, fallback, min, max) => {
    const v = Number(env[name] || fallback);
    if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${name} 必须为 ${min}～${max} 的整数`);
    return v;
  };
  const environment = env.XMAX_ENVIRONMENT || 'china';
  if (!['china', 'global'].includes(environment)) throw new Error('XMAX_ENVIRONMENT 必须为 china/global');
  const fallbackBase = environment === 'china' ? 'https://cloud.xmax.22duck.cn/open/api/v1' : 'https://api.xmax.ai/open/api/v1';
  const suppliedBase = env.XMAX_API_BASE_URL?.trim();
  // An accidentally pasted credential must never become a request URL or error message.
  const base = suppliedBase && /^https?:\/\//.test(suppliedBase) ? suppliedBase : fallbackBase;
  return {
    environment,
    base: base.replace(/\/$/, ''),
    outputSeconds: number('XMAX_OUTPUT_SECONDS', 8, 3, 30),
    sessionSeconds: number('XMAX_SESSION_SECONDS', 20, 5, 60),
    points: number('XMAX_POINTS_PER_CASE', 25, 1, 120),
    expiry: number('XMAX_KEY_EXPIRE_SECONDS', 45, 30, 120),
  };
}

// The ledger contains case IDs and statuses only, never API keys.
export function createApi({ env, caseIds, ledgerPath, request = fetch, repeatableCaseIds = [] }) {
  const config = settings(env);
  let ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : {};
  let active;
  const save = () => {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    writeFileSync(`${ledgerPath}.tmp`, JSON.stringify(ledger, null, 2));
    renameSync(`${ledgerPath}.tmp`, ledgerPath);
  };
  const official = async (path, method, body) => {
    const response = await request(`${config.base}${path}`, {
      method, headers: { 'X-Api-Key': env.XMAX_API_KEY, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(12000),
    });
    const result = await response.json();
    // Do not forward full upstream responses: they may contain credentials.
    if (!response.ok || result.success !== true) throw new Error(`Xmax API 失败：HTTP ${response.status}，业务码 ${result.code ?? '未知'}`);
    return result.data;
  };
  const finish = async (lease, reason = 'finished') => {
    if (!active || active.lease !== lease) return { released: true };
    const current = active;
    if (current.closing) return current.closing;
    current.closing = (async () => {
      clearTimeout(current.timer);
      let revoked = false;
      try {
        if (current.key) {
          await official(`/temporary-api-key/${encodeURIComponent(current.key)}/inactive`, 'PUT');
          revoked = true;
        }
      } catch { /* Expiration and quota remain the server-side fallback. */ }
      ledger[current.caseId] = { ...ledger[current.caseId], status: reason, revoked, endedAt: new Date().toISOString() };
      save();
      if (active === current) active = undefined;
      return { released: true, revoked };
    })();
    return current.closing;
  };
  return {
    config,
    status: () => ({ configured: Boolean(env.XMAX_API_KEY?.trim()), ...config, base: undefined, ledger, active: Boolean(active) }),
    async start(caseId) {
      if (!caseIds.includes(caseId)) throw new Error('未知测试项');
      if (!env.XMAX_API_KEY?.trim()) throw new Error('请先在 .env 配置 XMAX_API_KEY，然后重启 npm run dev');
      if (active) throw new Error('已有测试正在运行，请先停止');
      if (ledger[caseId] && !repeatableCaseIds.includes(caseId)) throw new Error('此项已尝试过，已阻止重复调用；确需重试请使用 reset-case 命令');
      const ledgerId = repeatableCaseIds.includes(caseId) ? `${caseId}-${randomUUID()}` : caseId;
      const current = { lease: randomUUID(), caseId: ledgerId, key: undefined, timer: undefined };
      active = current;
      ledger[ledgerId] = { status: 'attempted', startedAt: new Date().toISOString() };
      save(); // Reserve before the asynchronous POST, including uncertain network outcomes.
      try {
        const data = await official('/temporary-api-key', 'POST', {
          expireSeconds: config.expiry, pointsLimit: config.points, temporaryApiKeySessionLimit: 1,
        });
        if (!data?.temporaryApiKey) throw new Error('签发响应缺少临时 API Key');
        current.key = data.temporaryApiKey;
        current.timer = setTimeout(() => void finish(current.lease, 'expired'), config.sessionSeconds * 1000);
        current.timer.unref?.();
        return { lease: current.lease, temporaryApiKey: current.key, environment: config.environment, outputSeconds: config.outputSeconds, sessionSeconds: config.sessionSeconds };
      } catch (error) {
        await finish(current.lease, 'key_failed');
        throw error;
      }
    },
    finish,
    close: () => active ? finish(active.lease, 'server_closed') : Promise.resolve(),
  };
}
