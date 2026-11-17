import { PARAM_MAP, COLOR_PARAMS, clampConfig } from "./faceParams.js";
import { isVisionModel } from "../config/aiConfig.js";

/* ------------------------------------------------------------------ *
 * 以图捏脸：图片 → 角色形象
 *
 * 两条生成路径：
 *  1) 多模态视觉大模型（配置了 Key 时）：图片 + System Prompt 一起发给
 *     OpenAI 兼容的 vision 接口，模型直接读出五官特征并输出捏脸参数。
 *  2) 本地 Canvas 图像分析（无 Key / 调用失败时）：纯浏览器端采样肤色、
 *     发色、明暗对比，按人像统计特征生成形象，完全离线、不上传图片。
 *
 * 两条路径产出的都是本工坊的 0~100 参数配置，可直接套用到现有精细骨骼
 * 角色；这样既复用了项目资产，也让图片生成的结果能继续手动微调、保存、
 * 进入游戏。
 * ------------------------------------------------------------------ */

const VISION_SYSTEM_PROMPT = `你是资深 3D 游戏捏脸美术师。用户会上传一张人物正面照片，你要仔细观察照片中人物的外貌特征，输出对应的捏脸参数。

可调参数（全部 0-100 整数，50 为出厂中性值）：
${describeConfigSchema()}

观察与映射规则：
1. 脸型：圆脸→faceWidth 偏高、chinPoint 偏低；长脸→faceLength 偏高；瓜子脸/尖脸→faceWidth 偏低、chinPoint 偏高；方脸/国字脸→jawWidth 偏高。
2. 眼睛：大眼→eyeSize 偏高；细眼→eyeSize 偏低；眼距宽→eyeSpacing 偏高；吊梢眼→eyeTilt 偏高，下垂眼→eyeTilt 偏低。
3. 眉毛：浓眉→browThickness 偏高；眉高→browHeight 偏高；剑眉→browArch 偏低。
4. 鼻子：高鼻梁→noseHeight 偏高；鼻翼宽→noseWidth 偏高。
5. 嘴巴：嘴宽→mouthWidth 偏高；厚唇→lipThickness 偏高；微笑表情→smile 偏高。
6. 肤色：白皙→skinTone 15-30；自然→40-60；小麦/健康深色→70-90。
7. 发色档位：0黑 1深棕 2棕 3浅棕 4金 5红 6蓝 7紫 8粉 9银，输出 skinTone/hairColor 时用 0-100 的档位值。

输出要求：
1. 只输出 JSON，不要解释文字、不要 markdown 代码块。
2. 格式：{"reply":"用中文简短描述你观察到的人物外貌（30字内）","changes":{"参数id":数值,...}}
3. changes 只包含能从照片可靠判断的参数，不确定的不要输出；数值控制在 18-88 之间，避免极端穿模。
4. 若照片不是清晰人脸，返回 {"reply":"照片中没有清晰人脸","changes":{}}。`;

function describeConfigSchema() {
  const ids = [
    ["faceWidth", "脸部宽窄"], ["cheekBone", "颧骨高低"], ["jawWidth", "下颌宽窄"],
    ["chinLength", "下巴长短"], ["faceLength", "脸部长短"], ["chinPoint", "下巴尖度"],
    ["eyeSize", "眼睛大小"], ["eyeSpacing", "眼睛间距"], ["eyeHeight", "眼睛高低"],
    ["eyeTilt", "眼睛倾斜"], ["eyelidOpen", "眼睑开合"],
    ["browHeight", "眉毛高低"], ["browSpacing", "眉毛间距"], ["browThickness", "眉毛粗细"], ["browArch", "眉峰弧度"],
    ["noseHeight", "鼻梁高低"], ["noseWidth", "鼻翼宽窄"], ["noseLength", "鼻子长短"],
    ["mouthWidth", "嘴巴宽窄"], ["lipThickness", "嘴唇厚薄"], ["smile", "嘴角上扬"],
    ["skinTone", "肤色档位"], ["hairColor", "发色档位"],
  ];
  return ids.map(([id, label]) => `${id}（${label}）`).join("；");
}

/** 把用户图片压到合适尺寸并转成 dataURL，避免请求体过大 */
export async function prepareImage(file, maxSize = 768) {
  if (!file || !file.type || !file.type.startsWith("image/")) throw new Error("请选择图片文件");
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, w, h);
    const dataUrl = c.toDataURL("image/jpeg", 0.82);
    return { dataUrl, base64: dataUrl.split(",")[1] || "", width: w, height: h, canvas: c };
  } finally {
    if (bitmap.close) bitmap.close();
  }
}

export class ImageAvatarGenerator {
  constructor(ai) {
    this.ai = ai;
  }

  /**
   * 图片生成角色。优先视觉大模型；无 Key 或失败时回落本地分析。
   * @returns {Promise<{ok, config, message, source, analysis}>}
   */
  async generate(file, currentConfig, { preferLocal = false, extraPrompt = "" } = {}) {
    const img = await prepareImage(file);
    if (!preferLocal && this.ai.configured && this._supportsVision()) {
      try {
        const r = await this._visionGenerate(img, currentConfig, extraPrompt);
        if (r) return r;
      } catch (e) {
        const local = this._localGenerate(img, currentConfig);
        return { ...local, message: `视觉模型调用失败（${e.message}），已用本地图像分析` };
      }
    }
    if (this.ai.configured && !this._supportsVision()) {
      const local = this._localGenerate(img, currentConfig);
      return { ...local, message: `当前模型 ${this.ai.config.model} 未标记支持图片，已用本地分析；可在 AI 设置中换用视觉模型` };
    }
    return this._localGenerate(img, currentConfig);
  }

  _supportsVision() {
    return isVisionModel(this.ai.config.visionModel) || isVisionModel(this.ai.config.model);
  }

  async _visionGenerate(img, currentConfig, extraPrompt) {
    const endpoint = String(this.ai.config.endpoint || "").replace(/\/+$/, "");
    const model = this.ai.config.visionModel || this.ai.config.model;
    const res = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.ai.config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: 500,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: VISION_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: `请分析这张照片并输出捏脸参数 JSON。${extraPrompt ? "用户补充要求：" + extraPrompt : ""}` },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${img.base64}` } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout ? AbortSignal.timeout(45000) : undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content || "";
    const parsed = this.ai._parse(content);
    if (!parsed || !parsed.changes || !Object.keys(parsed.changes).length) return null;

    const cfg = clampConfig(currentConfig);
    let count = 0;
    for (const [id, raw] of Object.entries(parsed.changes)) {
      const p = PARAM_MAP[id];
      if (!p) continue;
      const v = Number(raw);
      if (!Number.isFinite(v)) continue;
      cfg.params[id] = Math.min(p.max, Math.max(p.min, Math.round(v)));
      count++;
    }
    if (!count) return null;
    cfg.name = "照片形象";
    return {
      ok: true, source: "vision", config: cfg,
      message: parsed.reply || `已按照片调整 ${count} 项参数`,
      analysis: parsed.reply || "",
    };
  }

  /**
   * 本地图像分析：采样肤色、发色与整体明暗，生成一版可信的形象。
   * 完全在浏览器内完成，图片不会离开设备。
   */
  _localGenerate(img, currentConfig) {
    const ctx = img.canvas.getContext("2d", { willReadFrequently: true });
    const { width: w, height: h } = img;
    const pixels = ctx.getImageData(0, 0, w, h).data;

    const at = (x, y) => {
      const i = (Math.min(h - 1, Math.max(0, y | 0)) * w + Math.min(w - 1, Math.max(0, x | 0))) * 4;
      return [pixels[i], pixels[i + 1], pixels[i + 2]];
    };

    // 肤色：取画面中央区域里符合肤色色相的像素平均值（人脸通常在中部）
    let sr = 0, sg = 0, sb = 0, sc = 0;
    const x0 = Math.floor(w * 0.28), x1 = Math.ceil(w * 0.72);
    const y0 = Math.floor(h * 0.22), y1 = Math.ceil(h * 0.72);
    for (let y = y0; y < y1; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        const [r, g, b] = at(x, y);
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (r > 85 && g > 45 && b > 25 && r > g && g > b && mx - mn > 12 && mx - mn < 110) {
          sr += r; sg += g; sb += b; sc++;
        }
      }
    }
    const skin = sc > 30 ? [sr / sc, sg / sc, sb / sc] : [224, 184, 150];

    // 发色：取上方区域里偏暗像素平均值（排除背景高光）
    let hr = 0, hg = 0, hb = 0, hc = 0;
    const hy1 = Math.ceil(h * 0.34);
    for (let y = 0; y < hy1; y += 2) {
      for (let x = Math.floor(w * 0.2); x < Math.ceil(w * 0.8); x += 2) {
        const [r, g, b] = at(x, y);
        if (r < 150 && g < 150 && b < 150) { hr += r; hg += g; hb += b; hc++; }
      }
    }
    const hair = hc > 30 ? [hr / hc, hg / hc, hb / hc] : [40, 30, 25];

    // 肤色亮度 → 档位：亮度高偏白皙，低偏小麦。亮度用 Y = 0.299R+0.587G+0.114B
    const lum = 0.299 * skin[0] + 0.587 * skin[1] + 0.114 * skin[2];
    const skinTone = Math.min(95, Math.max(8, Math.round(170 - lum * 0.72)));

    // 发色 → 色板最近邻（感知加权距离）
    const sw = COLOR_PARAMS[1].swatches;
    const swRgb = sw.map((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)));
    let best = 0, bestD = Infinity;
    swRgb.forEach((c, i) => {
      const d = (c[0] - hair[0]) ** 2 * 0.35 + (c[1] - hair[1]) ** 2 * 0.45 + (c[2] - hair[2]) ** 2 * 0.2;
      if (d < bestD) { bestD = d; best = i; }
    });

    const cfg = clampConfig(currentConfig);
    cfg.params.skinTone = skinTone;
    cfg.params.hairColor = Math.round((best + 0.5) / sw.length * 100);
    // 无关键点时只做保守的整体风格推断，五官保持原模型中性与轻微优化
    cfg.params.faceWidth = Math.round(Math.min(80, Math.max(25, cfg.params.faceWidth - 4)));
    cfg.params.smile = Math.round(Math.min(80, cfg.params.smile + 8));
    cfg.name = "照片形象";

    return {
      ok: true, source: "local", config: cfg,
      message: `已从图片提取肤色与发色（肤色档位 ${skinTone} · ${sw[best]}）。配置视觉模型可精确匹配五官。`,
      analysis: `肤色 ${skin.map((v) => Math.round(v)).join(",")} · 发色 ${sw[best]}`,
    };
  }
}
