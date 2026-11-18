import type { Mastra } from "@mastra/core";
import type { MastraRuntime } from "../index.js";
import { validateFaceRefinePayload, buildFaceRefineUserMessage, normalizeFaceRefineOutput } from "./faceRefine.js";
import {
  validateImageAvatarPayload,
  buildImageUserMessage,
  normalizeImageAvatarOutput,
} from "./imageAvatar.js";
import {
  validateChatPayload,
  buildChatMessages,
  normalizeChatOutput,
} from "./chat.js";

/* 能力注册表：新增能力 = 在 ABILITIES 数组加一项（契约见设计文档第 4 节）。
 * 铁律：run 返回纯业务对象；异常一律转 GatewayError。 */

export class GatewayError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface AbilityContext {
  runtime: MastraRuntime;
}

export interface Ability {
  id: string;
  description: string;
  inputHint: Record<string, string>;
  validate(payload: any): string | null;
  run(payload: any, ctx: AbilityContext): Promise<unknown>;
}

const faceRefine: Ability = {
  id: "face-refine",
  description: "文本捏脸：自然语言描述 → 捏脸参数变更 JSON",
  inputHint: {
    prompt: "string，必填，用户的修改描述",
    currentConfig: "object，可选，当前捏脸配置 {avatar, params}",
  },
  validate: validateFaceRefinePayload,
  async run(payload, ctx) {
    const agent = ctx.runtime.faceStylist;
    if (!agent) {
      throw new GatewayError(503, "MODEL_NOT_CONFIGURED", "模型未配置，请在 ai-gateway/.env 填写模型信息");
    }
    const messages = [{ role: "user" as const, content: buildFaceRefineUserMessage(payload as any) }];

    // 仓库规范：maxSteps=25 已在 Agent 定义；此处必须检查结果有效性，禁止静默空成功
    const res = await agent.generate(messages, { maxSteps: 25 });
    const finishReason = (res as any)?.finishReason;
    const text = (res as any)?.text;

    if (finishReason === "error") {
      throw new GatewayError(502, "MODEL_ERROR", "模型返回错误状态（finishReason=error）");
    }
    if (!text || !String(text).trim()) {
      if (finishReason === "length") {
        throw new GatewayError(502, "MODEL_TRUNCATED", "模型输出被截断（finishReason=length），请重试");
      }
      throw new GatewayError(502, "MODEL_EMPTY", "模型返回空内容");
    }

    const result = normalizeFaceRefineOutput(text);
    if (!result) {
      // 业务失败（非协议失败）：模型给了内容但不是有效参数 JSON
      return { ok: false, reply: "模型未返回有效参数", changes: {}, source: "agent" };
    }
    return result;
  },
};

const imageAvatar: Ability = {
  id: "image-avatar",
  description: "以图捏脸：人物照片（vision 模型）→ 捏脸参数变更 JSON",
  inputHint: {
    imageBase64: "string，必填，JPEG base64（不含 data: 前缀），前端已压缩至 768px",
    extraPrompt: "string，可选，用户补充要求",
    currentConfig: "object，可选，当前捏脸配置 {avatar, params}",
  },
  validate: validateImageAvatarPayload,
  async run(payload, ctx) {
    const agent = ctx.runtime.imageStylist;
    if (!agent) {
      throw new GatewayError(503, "MODEL_NOT_CONFIGURED", "模型未配置，请在 ai-gateway/.env 填写模型信息");
    }
    const messages = buildImageUserMessage(payload as any) as any[];

    const res = await agent.generate(messages, { maxSteps: 25 });
    const finishReason = (res as any)?.finishReason;
    const text = (res as any)?.text;

    if (finishReason === "error") {
      throw new GatewayError(502, "MODEL_ERROR", "模型返回错误状态（finishReason=error）——若主模型不支持图片，请配置 AI_PROVIDER_VISION_MODEL");
    }
    if (!text || !String(text).trim()) {
      if (finishReason === "length") {
        throw new GatewayError(502, "MODEL_TRUNCATED", "模型输出被截断（finishReason=length），请重试");
      }
      throw new GatewayError(502, "MODEL_EMPTY", "模型返回空内容");
    }

    const result = normalizeImageAvatarOutput(text);
    if (!result) {
      return { ok: false, reply: "照片中未识别出有效特征", changes: {}, source: "agent" };
    }
    return result;
  },
};

const chat: Ability = {
  id: "chat",
  description: "频道聊天：玩家消息 + 最近上下文 + 游戏状态 → AI 向导「小漫」的回复文本",
  inputHint: {
    message: "string，必填，玩家当前这条消息",
    history: "Array<{role: 'user'|'assistant', content: string}>，可选，最近对话上下文",
    gameState: "object，可选，游戏状态摘要 {pos, district, gameTime, money, driving}",
    provider: "string，可选，聊天模型 provider id（如 deepseek / qwen），缺省用服务端默认",
  },
  validate: validateChatPayload,
  async run(payload, ctx) {
    const available = Object.keys(ctx.runtime.chatAgents || {});
    const requested = typeof (payload as any)?.provider === "string" ? (payload as any).provider.trim().toLowerCase() : "";
    // 显式指定 → 必须存在；未指定 → deepseek 优先，否则第一个可用 provider
    const providerId = requested
      ? requested
      : (available.includes("deepseek") ? "deepseek" : available[0] || "");
    const agent = providerId ? ctx.runtime.chatAgents[providerId] : undefined;
    if (!agent) {
      throw new GatewayError(503, "PROVIDER_NOT_CONFIGURED", `聊天模型 "${providerId || "无"}" 未在网关配置（.env AI_CHAT_PROVIDER_*）`);
    }
    const messages = buildChatMessages(payload as any);

    // 仓库规范：maxSteps=25 已在 Agent 定义；此处必须检查结果有效性，禁止静默空成功
    const res = await agent.generate(messages as any, { maxSteps: 25 });
    const finishReason = (res as any)?.finishReason;
    const text = (res as any)?.text;

    if (finishReason === "error") {
      throw new GatewayError(502, "MODEL_ERROR", "模型返回错误状态（finishReason=error）");
    }
    if (!text || !String(text).trim()) {
      if (finishReason === "length") {
        throw new GatewayError(502, "MODEL_TRUNCATED", "模型输出被截断（finishReason=length），请重试");
      }
      throw new GatewayError(502, "MODEL_EMPTY", "模型返回空内容");
    }

    const result = normalizeChatOutput(text);
    if (!result) {
      return { ok: false, reply: "模型未返回有效回复", source: "agent" };
    }
    return result;
  },
};

export const ABILITIES: Ability[] = [faceRefine, imageAvatar, chat];

export function getAbility(id: string): Ability | undefined {
  return ABILITIES.find((a) => a.id === id);
}

export function listAbilities() {
  return ABILITIES.map(({ id, description, inputHint }) => ({ id, description, inputHint }));
}

// 类型引用防抖（Mastra 类型在 ctx 中贯穿使用）
export type { Mastra };
