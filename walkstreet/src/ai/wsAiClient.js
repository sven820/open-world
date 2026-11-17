/* ------------------------------------------------------------------ *
 * wsAiClient —— AI 能力网关统一客户端（前端唯一入口）
 *
 * 设计文档：docs/design/ai-agent-gateway-design.md（第 8 节）
 * 原则：网关优先、失败永不阻塞业务（调用方自行回退）；前端不感知网关框架。
 *
 * 网关地址解析优先级：
 *   URL 参数 ?ai=<url>  >  localStorage["ws_ai_gateway_url"]  >  默认本机 8788
 *   ?ai=off 可强制禁用网关（直接走旧回退路径，便于排障）
 * ------------------------------------------------------------------ */

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8788";
const PROBE_CACHE_MS = 30_000; // 探测结果缓存 30 秒

let probeOk = false;
let probeAt = 0;

/** 解析网关地址；?ai=off 返回 null（禁用网关） */
export function getGatewayUrl() {
  try {
    const qs = new URLSearchParams(window.location.search).get("ai");
    if (qs === "off") return null;
    if (qs) return qs.replace(/\/+$/, "");
    const saved = localStorage.getItem("ws_ai_gateway_url");
    if (saved) return saved.replace(/\/+$/, "");
  } catch { /* 无痕模式/非浏览器环境忽略 */ }
  return DEFAULT_GATEWAY_URL;
}

/** 探测网关可用性（带 30s 缓存）。网关挂掉时应在 ~1.5s 内返回 false，让调用方走回退 */
export async function gatewayAvailable(timeoutMs = 1500) {
  const base = getGatewayUrl();
  if (!base) return false;
  const now = Date.now();
  if (now - probeAt < PROBE_CACHE_MS) return probeOk;
  try {
    const res = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    probeOk = res.ok;
  } catch {
    probeOk = false;
  }
  probeAt = now;
  return probeOk;
}

/** 调用能力：POST /api/ai/:ability/invoke。失败抛 Error（.code 为网关错误码，如 MODEL_NOT_CONFIGURED） */
export async function invokeAbility(ability, payload, { timeoutMs = 35_000 } = {}) {
  const base = getGatewayUrl();
  if (!base) throw Object.assign(new Error("AI 网关已禁用（?ai=off）"), { code: "GATEWAY_DISABLED" });

  const res = await fetch(`${base}/api/ai/${encodeURIComponent(ability)}/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
    signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
  });

  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON 响应按错误处理 */ }

  if (!res.ok) {
    const message = data?.error?.message || `网关 HTTP ${res.status}`;
    throw Object.assign(new Error(message), { code: data?.error?.code || "GATEWAY_ERROR", status: res.status });
  }
  return data?.result ?? data;
}

/** 能力清单（调试用） */
export async function listAbilities(timeoutMs = 1500) {
  const base = getGatewayUrl();
  if (!base) return [];
  try {
    const res = await fetch(`${base}/api/ai/abilities`, {
      signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    if (!res.ok) return [];
    const json = await res.json();
    return json?.result || [];
  } catch {
    return [];
  }
}
