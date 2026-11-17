import { describeParams } from "../faceParams.js";
import { parseModelJson } from "./faceRefine.js";

/* image-avatar 能力实现：图片 → 捏脸参数（vision 模型）。
 * 纯函数部分与框架解耦（接缝原则）。 */

export interface ImageAvatarPayload {
  /** JPEG base64（不含 data: 前缀），前端 prepareImage 已压缩 */
  imageBase64: string;
  /** 用户补充要求（可空） */
  extraPrompt?: string;
  currentConfig?: { avatar?: string; params?: Record<string, unknown> };
}

export function validateImageAvatarPayload(payload: any): string | null {
  if (!payload || typeof payload !== "object") return "body 必须为 JSON 对象";
  if (typeof payload.imageBase64 !== "string" || !payload.imageBase64.trim()) {
    return "imageBase64 必须为非空字符串";
  }
  // base64 ≤ 5MB 图片压缩后一般 < 1.4MB；上限 7MB base64（约 5.2MB 原图）
  if (payload.imageBase64.length > 7_000_000) return "图片过大（base64 超 7MB），请压缩后重试";
  if (payload.extraPrompt !== undefined && typeof payload.extraPrompt !== "string") {
    return "extraPrompt 必须为字符串";
  }
  if (payload.currentConfig !== undefined && typeof payload.currentConfig !== "object") {
    return "currentConfig 必须为对象";
  }
  return null;
}

/** 构建多模态 user 消息（AI SDK v5 ModelMessage 形态） */
export function buildImageUserMessage(payload: ImageAvatarPayload): unknown[] {
  const params = payload.currentConfig?.params;
  const text = `请分析这张照片并输出捏脸参数 JSON。当前角色参数（供参考）：\n${describeParams(params)}${
    payload.extraPrompt?.trim() ? `\n\n用户补充要求：${payload.extraPrompt.trim()}` : ""
  }`;
  return [
    {
      role: "user",
      content: [
        { type: "text", text },
        { type: "image", image: `data:image/jpeg;base64,${payload.imageBase64}` },
      ],
    },
  ];
}

/** 复用文本能力的输出规范化（同一 JSON 契约） */
export { normalizeFaceRefineOutput as normalizeImageAvatarOutput } from "./faceRefine.js";
export { parseModelJson };
