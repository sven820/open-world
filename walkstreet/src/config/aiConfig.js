/* ------------------------------------------------------------------ *
 * AI 配置中心（单例）
 *
 * 所有需要调用大模型的功能（文本捏脸、以图生成、后续其他入口）共享同一份
 * 配置。任何入口修改配置，其他入口立即生效；配置只存本机浏览器。
 *
 * 注意（阶段 1 起）：优先走 AI 网关（src/ai/wsAiClient.js → ai-gateway/），
 * Key 托管在服务端 .env；本配置仅在网关不可用时的"直连回退"路径使用。
 * 见 docs/design/ai-agent-gateway-design.md
 * ------------------------------------------------------------------ */

const STORAGE_KEY = "ws_creator_ai_config"; // 沿用旧 key，保留用户已填的 Key

export const AI_PRESETS = [
  { id: "openai", label: "OpenAI", endpoint: "https://api.openai.com/v1", model: "gpt-4o-mini", visionModel: "gpt-4o-mini" },
  { id: "deepseek", label: "DeepSeek", endpoint: "https://api.deepseek.com/v1", model: "deepseek-chat", visionModel: "" },
  { id: "qwen", label: "通义千问", endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", visionModel: "qwen-vl-max" },
  { id: "moonshot", label: "Moonshot", endpoint: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k", visionModel: "moonshot-v1-8k-vision-preview" },
  { id: "custom", label: "自定义", endpoint: "", model: "", visionModel: "" },
];

const defaults = () => ({
  endpoint: AI_PRESETS[0].endpoint,
  apiKey: "",
  model: AI_PRESETS[0].model,
  visionModel: AI_PRESETS[0].visionModel,
});

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...defaults(), ...JSON.parse(raw) } : defaults();
  } catch {
    return defaults();
  }
}

let state = load();
const listeners = new Set();

export function getAIConfig() {
  return state;
}

export function configured() {
  return !!(state.apiKey && state.endpoint && state.model);
}

export function isVisionModel(model) {
  const m = String(model || "").toLowerCase();
  return /gpt-4|vision|vl|qvq|4v|gemini|claude|moonshot-v1-.*-vision/i.test(m);
}

/** 更新配置并广播；patch 为部分字段 */
export function updateAIConfig(patch) {
  state = { ...state, ...patch };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* 无痕模式忽略 */ }
  for (const fn of [...listeners]) {
    try { fn(state); } catch (e) { console.warn("[aiConfig] listener failed:", e); }
  }
  return state;
}

/** 订阅配置变化，返回取消订阅函数 */
export function onAIConfigChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
