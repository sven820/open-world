import { clampParam, describeParams } from "../faceParams.js";

/* face-refine 能力实现。
 * 设计要点：纯函数部分（prompt 构建 / JSON 解析 / changes 校验）不依赖任何
 * 框架类型，便于将来迁移框架或复用（接缝原则，见 ADR-0001）。
 */

export interface FaceRefinePayload {
  prompt: string;
  currentConfig?: { avatar?: string; params?: Record<string, unknown> };
}

export interface FaceRefineResult {
  ok: boolean;
  reply: string;
  changes: Record<string, number>;
  source: "agent";
}

export function validateFaceRefinePayload(payload: any): string | null {
  if (!payload || typeof payload !== "object") return "body 必须为 JSON 对象";
  if (typeof payload.prompt !== "string" || !payload.prompt.trim()) return "prompt 必须为非空字符串";
  if (payload.currentConfig !== undefined && typeof payload.currentConfig !== "object") {
    return "currentConfig 必须为对象";
  }
  if (payload.currentConfig?.params !== undefined && typeof payload.currentConfig.params !== "object") {
    return "currentConfig.params 必须为对象";
  }
  return null;
}

/** 构建 Agent 消息（system 指令在 Agent 上，此处只补 user 消息） */
export function buildFaceRefineUserMessage(payload: FaceRefinePayload): string {
  const params = payload.currentConfig?.params;
  return `用户要求：${payload.prompt.trim()}\n\n当前角色参数：\n${describeParams(params)}\n\n请输出 JSON。`;
}

/** 宽容 JSON 解析：剥离 markdown 围栏、截取首尾大括号（与前端 _parse 策略一致） */
export function parseModelJson(content: unknown): { reply?: string; changes?: Record<string, unknown> } | null {
  if (!content) return null;
  let s = String(content).trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const obj = JSON.parse(s.slice(a, b + 1));
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

/** 把模型输出规范化为安全的结果对象；无效输出返回 null（业务失败） */
export function normalizeFaceRefineOutput(raw: unknown): FaceRefineResult | null {
  const parsed = parseModelJson(raw);
  const changesRaw = parsed?.changes;
  if (!changesRaw || typeof changesRaw !== "object") return null;

  const changes: Record<string, number> = {};
  for (const [id, value] of Object.entries(changesRaw)) {
    const v = clampParam(id, value);
    if (v !== null) changes[id] = v;
  }
  if (!Object.keys(changes).length) return null;

  return {
    ok: true,
    reply: typeof parsed?.reply === "string" && parsed.reply ? parsed.reply : "已完成调整",
    changes,
    source: "agent",
  };
}
