import { randomUUID, createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { dirname } from "node:path";

export class ApiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
export function settings(env) {
  const integer = (name, fallback, min, max) => {
    const value = Number(env[name] || fallback);
    if (!Number.isFinite(value) || value < min)
      throw new Error(`${name} 配置无效`);
    return Math.min(max, Math.floor(value));
  };
  const environment = env.XMAX_ENVIRONMENT || "china";
  if (!["china", "global"].includes(environment))
    throw new Error("XMAX_ENVIRONMENT 必须为 china/global");
  const base =
    environment === "china"
      ? "https://cloud.xmax.22duck.cn/open/api/v1"
      : "https://api.xmax.ai/open/api/v1";
  if (
    env.XMAX_API_BASE_URL?.trim() &&
    env.XMAX_API_BASE_URL.replace(/\/$/, "") !== base
  )
    throw new Error("API 地址必须为所选环境的官方地址");
  return {
    environment,
    base,
    disableDailyLimits: env.XMAX_DISABLE_DAILY_LIMITS === "1",
    outputSeconds: integer("XMAX_OUTPUT_SECONDS", 5, 3, 8),
    sessionSeconds: integer("XMAX_SESSION_SECONDS", 60, 15, 60),
    points: integer("XMAX_POINTS_PER_CASE", 100, 1, 100),
    expiry: integer("XMAX_KEY_EXPIRE_SECONDS", 90, 30, 90),
    dailyPoints: integer("XMAX_DAILY_POINTS_LIMIT", 1000, 1, 10000),
    visitorLimit: integer("XMAX_VISITOR_DAILY_LIMIT", 5, 1, 50),
  };
}

// Reserve a full per-session allowance BEFORE any upstream call; uncertain failures
// still count. The durable journal never contains a credential or image.
export function createApi({
  env,
  ledgerPath,
  request = fetch,
  now = () => new Date(),
}) {
  const config = settings(env);
  let ledger = existsSync(ledgerPath)
    ? JSON.parse(readFileSync(ledgerPath, "utf8"))
    : [];
  let active;
  const dayFormat = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const today = () => dayFormat.format(now());
  const ownerId = (owner) => createHash("sha256").update(owner).digest("hex");
  const entries = () => ledger.filter((e) => e.day === today());
  const save = () => {
    ledger = ledger.filter(
      (e) => now().getTime() - new Date(e.startedAt).getTime() < 7 * 86400000,
    );
    mkdirSync(dirname(ledgerPath), { recursive: true });
    writeFileSync(`${ledgerPath}.tmp`, JSON.stringify(ledger, null, 2));
    renameSync(`${ledgerPath}.tmp`, ledgerPath);
  };
  const official = async (path, method, body) => {
    let response;
    try {
      response = await request(`${config.base}${path}`, {
        method,
        headers: {
          "X-Api-Key": env.XMAX_API_KEY,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(method === "POST" ? 20000 : 12000),
      });
    } catch {
      throw new ApiError(
        "试穿服务连接超时或网络不可用，请检查代理后手动重试",
        502,
      );
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw new ApiError("试穿服务响应异常，请稍后手动重试", 502);
    }
    if (!response.ok || result.success !== true)
      throw new ApiError(
        `试穿服务请求失败（HTTP ${response.status}，业务码 ${Number(result.code) || "未知"}）`,
        502,
      );
    return result.data;
  };
  const revoke = async (key) => {
    if (!key) return true;
    try {
      await official(
        `/temporary-api-key/${encodeURIComponent(key)}/inactive`,
        "PUT",
      );
      return true;
    } catch {
      return false;
    } // Official expiration and points limit are the fallback.
  };
  const finish = async (owner, lease, reason = "finished") => {
    if (!active || active.lease !== lease) return { released: true };
    const current = active;
    if (current.owner !== owner) throw new ApiError("无法操作此试穿会话", 403);
    if (current.closing) return current.closing;
    current.cancelled = true;
    clearTimeout(current.timer);
    current.closing = (async () => {
      // Keep the slot occupied until pending issuance settles. A late key is revoked.
      await current.issuance.catch(() => {});
      const revoked = await revoke(current.key);
      current.entry.status = reason;
      current.entry.revoked = revoked;
      current.entry.endedAt = now().toISOString();
      save();
      if (active === current) active = undefined;
      return { released: true, revoked };
    })();
    return current.closing;
  };
  return {
    config,
    status(owner) {
      const used = entries();
      return {
        configured: Boolean(env.XMAX_API_KEY?.trim()),
        environment: config.environment,
        outputSeconds: config.outputSeconds,
        sessionSeconds: config.sessionSeconds,
        pointsPerSession: config.points,
        active: Boolean(active),
        remaining: config.disableDailyLimits ? null : Math.max(
          0,
          Math.min(
            config.visitorLimit -
              used.filter((e) => e.owner === ownerId(owner)).length,
            Math.floor(
              (config.dailyPoints -
                used.reduce((sum, e) => sum + e.reservedPoints, 0)) /
                config.points,
            ),
          ),
        ),
      };
    },
    async start(owner, requestId, sourceSeconds) {
      const outputSeconds = sourceSeconds === undefined ? config.outputSeconds : sourceSeconds;
      if (typeof outputSeconds !== "number" || !Number.isFinite(outputSeconds) || outputSeconds <= 0 || outputSeconds > 10.15)
        throw new ApiError("视频时长必须在 0～10 秒以内");
      if (!/^[a-zA-Z0-9-]{16,64}$/.test(requestId || ""))
        throw new ApiError("无效的提交标识");
      if (!env.XMAX_API_KEY?.trim()) throw new ApiError("服务尚未配置试穿 API");
      const ownerHash = ownerId(owner);
      if (
        ledger.some((e) => e.owner === ownerHash && e.requestId === requestId)
      )
        throw new ApiError("此提交已处理，请勿重复生成", 409);
      if (active) throw new ApiError("试衣间正在使用中，请稍后再试", 409);
      if (!config.disableDailyLimits && this.status(owner).remaining <= 0)
        throw new ApiError("今天的试穿额度已用完，请明天再来", 429);
      const entry = {
        id: randomUUID(),
        owner: ownerHash,
        requestId,
        day: today(),
        startedAt: now().toISOString(),
        reservedPoints: config.points,
        status: "reserved",
      };
      const current = {
        lease: entry.id,
        owner,
        entry,
        key: undefined,
        cancelled: false,
      };
      active = current;
      ledger.push(entry);
      try {
        save();
      } catch {
        active = undefined;
        ledger.pop();
        throw new ApiError("无法记录额度，已阻止创建付费会话", 503);
      }
      current.issuance = official("/temporary-api-key", "POST", {
        expireSeconds: config.expiry,
        pointsLimit: config.points,
        temporaryApiKeySessionLimit: 1,
      }).then((data) => {
        if (!data?.temporaryApiKey || typeof data.temporaryApiKey !== "string")
          throw new ApiError("试穿服务未返回临时凭据", 502);
        current.key = data.temporaryApiKey;
      });
      current.timer = setTimeout(
        () => void finish(owner, current.lease, "expired").catch(() => {}),
        config.sessionSeconds * 1000,
      );
      current.timer.unref?.();
      try {
        await current.issuance;
        if (current.cancelled) throw new ApiError("会话已取消", 409);
        entry.status = "issued";
        save();
        const remainingSeconds = Math.max(
          1,
          Math.floor(
            config.sessionSeconds -
              (now().getTime() - new Date(entry.startedAt).getTime()) / 1000,
          ),
        );
        return {
          lease: current.lease,
          temporaryApiKey: current.key,
          environment: config.environment,
          outputSeconds,
          sessionSeconds: remainingSeconds,
        };
      } catch (error) {
        await finish(owner, current.lease, "failed");
        throw error;
      }
    },
    finish,
    close: () =>
      active
        ? finish(active.owner, active.lease, "server_closed")
        : Promise.resolve(),
  };
}
