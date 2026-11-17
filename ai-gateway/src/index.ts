import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRuntime } from "./mastra/index.js";
import { getAbility, listAbilities, GatewayError } from "./mastra/abilities/registry.js";
import { modelConfigured } from "./config.js";

/* HTTP 层：只做路由 / JSON 解析 / CORS / 错误映射，不掺业务（设计文档第 2 节铁律）。
 * 阶段 1 无鉴权，仅限本机/内网开发使用；公网部署前必须补鉴权与 CORS 白名单。 */

const runtime = createRuntime();

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*", // TODO 阶段 1.5：改为开发/生产来源白名单
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS });
  res.end(payload);
}

function readBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new GatewayError(400, "INVALID_PAYLOAD", "请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function handleOptions(res: ServerResponse) {
  res.writeHead(204, CORS_HEADERS);
  res.end();
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") return handleOptions(res);

  // ---- GET ----
  if (req.method === "GET" && path === "/health") {
    return sendJson(res, 200, {
      ok: true,
      model: {
        configured: modelConfigured(runtime.config),
        baseURL: runtime.config.provider.baseURL || null,
        model: runtime.config.provider.model || null,
      },
      abilities: listAbilities().map((a) => a.id),
    });
  }
  if (req.method === "GET" && path === "/api/ai/abilities") {
    return sendJson(res, 200, { result: listAbilities() });
  }

  // ---- POST /api/ai/:ability/invoke ----
  const invokeMatch = path.match(/^\/api\/ai\/([^/]+)\/invoke$/);
  if (req.method === "POST" && invokeMatch) {
    const abilityId = decodeURIComponent(invokeMatch[1]);
    const ability = getAbility(abilityId);
    if (!ability) {
      return sendJson(res, 404, { error: { code: "ABILITY_NOT_FOUND", message: `未知能力：${abilityId}` } });
    }
    let body: any;
    try {
      // 图片类能力（image-avatar）的 base64 请求体较大，上限放到 8MB
      const raw = await readBody(req, 8_000_000);
      body = raw ? JSON.parse(raw) : {};
    } catch (e) {
      if (e instanceof GatewayError) {
        return sendJson(res, e.status, { error: { code: e.code, message: e.message } });
      }
      return sendJson(res, 400, { error: { code: "INVALID_PAYLOAD", message: "body 不是合法 JSON" } });
    }
    const invalid = ability.validate(body);
    if (invalid) {
      return sendJson(res, 400, { error: { code: "INVALID_PAYLOAD", message: invalid } });
    }
    const started = Date.now();
    try {
      const result = await ability.run(body, { runtime });
      // 可观测（阶段 1 打日志即可，阶段 1.5 落盘）
      console.log(`[ai] ${abilityId} ok ${Date.now() - started}ms`);
      return sendJson(res, 200, { result });
    } catch (e: any) {
      const ms = Date.now() - started;
      if (e instanceof GatewayError) {
        console.warn(`[ai] ${abilityId} fail ${ms}ms ${e.code}: ${e.message}`);
        return sendJson(res, e.status, { error: { code: e.code, message: e.message } });
      }
      console.error(`[ai] ${abilityId} error ${ms}ms`, e);
      const message = String(e?.message || "内部错误").slice(0, 200);
      return sendJson(res, 500, { error: { code: "INTERNAL", message } });
    }
  }

  return sendJson(res, 404, { error: { code: "NOT_FOUND", message: `路径不存在：${req.method} ${path}` } });
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((e) => {
    console.error("[http] unhandled:", e);
    if (!res.headersSent) {
      sendJson(res, 500, { error: { code: "INTERNAL", message: "服务内部错误" } });
    } else {
      res.end();
    }
  });
});

server.listen(runtime.config.port, "127.0.0.1", () => {
  const configured = modelConfigured(runtime.config);
  console.log(`[ai-gateway] listening on http://127.0.0.1:${runtime.config.port}`);
  console.log(`[ai-gateway] model: ${configured ? `${runtime.config.provider.model} @ ${runtime.config.provider.baseURL}` : "未配置（能力调用将返回 503）"}`);
  console.log(`[ai-gateway] abilities: ${listAbilities().map((a) => a.id).join(", ")}`);
});
