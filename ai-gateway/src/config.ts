import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

/* 环境变量读取与模型 provider 构造（单 provider，阶段 1 约定见设计文档第 6 节） */

/** 极简 .env 加载（不覆盖已存在的环境变量；文件不存在时静默跳过） */
function loadDotEnv(): void {
  try {
    const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
    const raw = readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      let value = m[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch { /* 无 .env 时静默跳过 */ }
}

loadDotEnv();

export interface GatewayConfig {
  port: number;
  provider: {
    baseURL: string;
    apiKey: string;
    model: string;
    /** 视觉模型（可选；未配置时 image-avatar 回退主模型，主模型非 vision 会 502 → 前端走旧回退） */
    visionModel: string;
  };
  /** 聊天频道可选模型 provider（chat 能力用），id 小写；
   * 由 AI_CHAT_PROVIDER_<ID>_BASE_URL / _API_KEY / _MODEL 三件套定义，缺一不收 */
  chatProviders: Record<string, ProviderConfig>;
}

export interface ProviderConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

/** 解析 AI_CHAT_PROVIDER_<ID>_* 环境变量为 provider 映射 */
function loadChatProviders(): Record<string, ProviderConfig> {
  const map: Record<string, ProviderConfig> = {};
  for (const key of Object.keys(process.env)) {
    const m = key.match(/^AI_CHAT_PROVIDER_([A-Z0-9_]+)_BASE_URL$/);
    if (!m) continue;
    const id = m[1].toLowerCase();
    const baseURL = (process.env[key] || "").replace(/\/+$/, "");
    const apiKey = process.env[`AI_CHAT_PROVIDER_${m[1]}_API_KEY`] || "";
    const model = process.env[`AI_CHAT_PROVIDER_${m[1]}_MODEL`] || "";
    if (baseURL && apiKey && model) map[id] = { baseURL, apiKey, model };
  }
  return map;
}

export function loadConfig(): GatewayConfig {
  const port = Number(process.env.AI_GATEWAY_PORT || 8788);
  const baseURL = (process.env.AI_PROVIDER_BASE_URL || "").replace(/\/+$/, "");
  const apiKey = process.env.AI_PROVIDER_API_KEY || "";
  const model = process.env.AI_PROVIDER_MODEL || "";
  const visionModel = process.env.AI_PROVIDER_VISION_MODEL || "";
  return { port, provider: { baseURL, apiKey, model, visionModel }, chatProviders: loadChatProviders() };
}

export function modelConfigured(cfg: GatewayConfig): boolean {
  return !!(cfg.provider.apiKey && cfg.provider.baseURL && cfg.provider.model);
}

/** 构造 OpenAI 兼容模型实例（模型未配置时抛出结构化错误，由 HTTP 层映射 503） */
export function createModel(cfg: GatewayConfig, opts: { vision?: boolean } = {}) {
  if (!modelConfigured(cfg)) {
    const err = new Error("模型未配置：请在 ai-gateway/.env 填写 AI_PROVIDER_BASE_URL / AI_PROVIDER_API_KEY / AI_PROVIDER_MODEL");
    (err as any).code = "MODEL_NOT_CONFIGURED";
    (err as any).status = 503;
    throw err;
  }
  // 视觉模型未配置时回退主模型（如主模型不支持 vision，调用会 502，前端走旧回退）
  if (opts.vision && cfg.provider.visionModel) {
    return createModelFromProvider({ ...cfg.provider, model: cfg.provider.visionModel });
  }
  return createModelFromProvider(cfg.provider);
}

/** 由任意 provider 配置构造模型实例（chat 多 provider 复用） */
export function createModelFromProvider(p: ProviderConfig) {
  const provider = createOpenAICompatible({
    name: "gateway-provider",
    baseURL: p.baseURL,
    apiKey: p.apiKey,
  });
  return provider(p.model);
}
