/* chat 能力实现：频道聊天面板的 AI 回复。
 * 纯函数部分（入参校验 / 消息构建）不依赖任何框架类型，便于将来迁移框架
 * （接缝原则，见 ADR-0001）。Agent 指令在 agent.ts 的 CHAT_INSTRUCTIONS 上。
 */

export interface ChatHistoryItem {
  role: "user" | "assistant";
  content: string;
}

export interface ChatPayload {
  message: string;
  history?: ChatHistoryItem[];
  gameState?: Record<string, unknown>;
  /** 聊天模型 provider id（网关 .env AI_CHAT_PROVIDER_<ID>_*），缺省由服务端选默认 */
  provider?: string;
}

export interface ChatResult {
  ok: boolean;
  reply: string;
  source: "agent";
}

const MAX_HISTORY = 20; // 双保险：前端传 10 条，网关再截一次防滥用

export function validateChatPayload(payload: any): string | null {
  if (!payload || typeof payload !== "object") return "body 必须为 JSON 对象";
  if (typeof payload.message !== "string" || !payload.message.trim()) return "message 必须为非空字符串";
  if (payload.history !== undefined) {
    if (!Array.isArray(payload.history)) return "history 必须为数组";
    for (const item of payload.history) {
      if (!item || typeof item !== "object") return "history 项必须为对象";
      if (item.role !== "user" && item.role !== "assistant") return "history[].role 只能为 user 或 assistant";
      if (typeof item.content !== "string") return "history[].content 必须为字符串";
    }
  }
  if (payload.gameState !== undefined && (payload.gameState === null || typeof payload.gameState !== "object")) {
    return "gameState 必须为对象";
  }
  if (payload.provider !== undefined && (typeof payload.provider !== "string" || !/^[a-z0-9_-]{1,32}$/i.test(payload.provider))) {
    return "provider 必须为 1-32 位字母/数字/中划线/下划线";
  }
  return null;
}

/** 构建 Agent 消息：历史对话 + 附带游戏状态摘要的当前问题（system 指令在 Agent 上） */
export function buildChatMessages(payload: ChatPayload): Array<{ role: "user" | "assistant"; content: string }> {
  const history = (payload.history || []).slice(-MAX_HISTORY);
  const stateText = summarizeGameState(payload.gameState);
  const userContent = stateText
    ? `${payload.message.trim()}\n\n[当前游戏状态] ${stateText}`
    : payload.message.trim();
  return [...history, { role: "user" as const, content: userContent }];
}

/** 游戏状态摘要 → 一行文本；无有效字段返回空串 */
export function summarizeGameState(state?: Record<string, unknown>): string {
  if (!state || typeof state !== "object") return "";
  const parts: string[] = [];
  const pos = state.pos as { x?: unknown; z?: unknown } | undefined;
  if (pos && typeof pos.x === "number" && typeof pos.z === "number") parts.push(`位置(${pos.x}, ${pos.z})`);
  if (typeof state.district === "string" && state.district) parts.push(`所在区「${state.district}」`);
  if (typeof state.gameTime === "string" && state.gameTime) parts.push(`游戏时间 ${state.gameTime}`);
  if (typeof state.money === "string" && state.money) parts.push(`金钱 ¥${state.money}`);
  if (state.driving === true) parts.push("正在驾驶");
  return parts.join(" · ");
}

/** 规范化输出：回复文本截断到 500 字（聊天面板展示不需要长文） */
export function normalizeChatOutput(raw: unknown): ChatResult | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return null;
  return { ok: true, reply: text.slice(0, 500), source: "agent" };
}
