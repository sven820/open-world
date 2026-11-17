/* ------------------------------------------------------------------ *
 * 捏脸参数镜像表
 *
 * 来源：walkstreet/src/creator/faceParams.js（前端权威定义）。
 * 同步维护约定：前端参数表变更时必须同步本文件；
 * 前端会以本地 PARAM_MAP 做最终 clamp，本镜像仅作防御性冗余。
 * ------------------------------------------------------------------ */

export interface FaceParamMeta {
  id: string;
  label: string;
  min: number;
  max: number;
  type?: "gradient" | "swatch"; // swatch = 色板索引（0-100，对应 10 档）
}

export const FACE_PARAMS: FaceParamMeta[] = [
  // 脸型
  { id: "faceWidth", label: "脸部宽窄", min: 0, max: 100 },
  { id: "cheekBone", label: "颧骨高低", min: 0, max: 100 },
  { id: "jawWidth", label: "下颌宽窄", min: 0, max: 100 },
  { id: "chinLength", label: "下巴长短", min: 0, max: 100 },
  { id: "faceLength", label: "脸部长短", min: 0, max: 100 },
  { id: "chinPoint", label: "下巴尖度", min: 0, max: 100 },
  // 眼睛
  { id: "eyeSize", label: "眼睛大小", min: 0, max: 100 },
  { id: "eyeSpacing", label: "眼睛间距", min: 0, max: 100 },
  { id: "eyeHeight", label: "眼睛高低", min: 0, max: 100 },
  { id: "eyeTilt", label: "眼睛倾斜", min: 0, max: 100 },
  { id: "eyelidOpen", label: "眼睑开合", min: 0, max: 100 },
  // 眉毛
  { id: "browHeight", label: "眉毛高低", min: 0, max: 100 },
  { id: "browSpacing", label: "眉毛间距", min: 0, max: 100 },
  { id: "browThickness", label: "眉毛粗细", min: 0, max: 100 },
  { id: "browArch", label: "眉峰弧度", min: 0, max: 100 },
  // 鼻子
  { id: "noseHeight", label: "鼻梁高低", min: 0, max: 100 },
  { id: "noseWidth", label: "鼻翼宽窄", min: 0, max: 100 },
  { id: "noseLength", label: "鼻子长短", min: 0, max: 100 },
  // 嘴部
  { id: "mouthWidth", label: "嘴巴宽窄", min: 0, max: 100 },
  { id: "lipThickness", label: "嘴唇厚薄", min: 0, max: 100 },
  { id: "mouthHeight", label: "嘴巴高低", min: 0, max: 100 },
  { id: "smile", label: "嘴角上扬", min: 0, max: 100 },
  // 颜色
  { id: "skinTone", label: "肤色", min: 0, max: 100, type: "gradient" },
  { id: "hairColor", label: "发色", min: 0, max: 100, type: "swatch" },
];

export const FACE_PARAM_MAP: Record<string, FaceParamMeta> = Object.fromEntries(
  FACE_PARAMS.map((p) => [p.id, p]),
);

export function clampParam(id: string, raw: unknown): number | null {
  const meta = FACE_PARAM_MAP[id];
  if (!meta) return null;
  const v = Number(raw);
  if (!Number.isFinite(v)) return null;
  return Math.min(meta.max, Math.max(meta.min, Math.round(v)));
}

/** 生成注入 Agent 指令的参数 schema 文本（与前端 AI_PARAM_SCHEMA 同构） */
export function paramSchemaText(): string {
  return FACE_PARAMS.map((p) => {
    if (p.type === "swatch") return `${p.id}（${p.label}，0-100 整数，色板索引：0黑 1深棕 2棕 3浅棕 4金 5红 6蓝 7紫 8粉 9银）`;
    return `${p.id}（${p.label}，0-100 整数，默认 50）`;
  }).join("；");
}

/** 把当前角色参数渲染成模型可读的文本（对齐前端 describeConfig 的用途） */
export function describeParams(params: Record<string, unknown> | undefined): string {
  if (!params || typeof params !== "object") return "（未提供，全部为默认值 50）";
  return FACE_PARAMS.map((p) => {
    const v = Number(params[p.id]);
    return `${p.id}（${p.label}）= ${Number.isFinite(v) ? v : 50}`;
  }).join("；");
}
