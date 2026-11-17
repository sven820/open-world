import { PARAM_MAP, ALL_PARAMS, PRESETS, presetConfig, randomConfig, defaultConfig, describeConfig, AI_PARAM_SCHEMA, clampConfig } from "./faceParams.js";
import { getAIConfig, configured, updateAIConfig } from "../config/aiConfig.js";
import { gatewayAvailable, invokeAbility } from "../ai/wsAiClient.js";

export { AI_PRESETS } from "../config/aiConfig.js";

const SYSTEM_PROMPT = `你是资深 3D 游戏捏脸美术师。用户会用自然语言描述想修改的角色外貌，你要输出捏脸参数调整。

可调参数（全部为 0-100 整数，50 为出厂中性值）：
${AI_PARAM_SCHEMA}

工作规则：
1. 只输出 JSON，不要解释文字、不要 markdown 代码块。
2. 格式：{"reply":"用中文简短说明你做了什么（40字内）","changes":{"参数id":数值,...}}
3. changes 只包含需要修改的参数，未提及的不要输出。
4. 数值必须在参数允许范围内，避免极端值造成穿模：五官类建议 18-85，体型类 25-75。
5. 用户说"优化/好看/顺眼"时，按现代审美微调：脸型收窄、眼睛适度放大、鼻梁挺、嘴角微扬，幅度控制在 8-18 之间。
6. 肤色档位 0=白皙, 50=自然, 100=小麦深色；发色档位对应 10 个色板（0黑 1深棕 2棕 3浅棕 4金 5红 6蓝 7紫 8粉 9银）。
7. 用户要求整体风格（如"动漫风""甜美""英俊"）时，可给出多个参数组合。`;

export class AIStylist {
  constructor() {
    // 配置统一由 aiConfig 单例维护；用 getter 实时读取，避免配置被替换后拿到旧对象
  }

  get config() { return getAIConfig(); }

  loadConfig() { return getAIConfig(); }

  saveConfig(cfg) {
    updateAIConfig(cfg);
  }

  get configured() {
    return configured();
  }

  async testConnection() {
    if (!this.configured) return { ok: false, message: "请先填写 API Key、接口地址与模型名" };
    try {
      const data = await this._chat([
        { role: "user", content: '请只回复 JSON：{"reply":"连接成功"}' },
      ], 120);
      return { ok: !!data, message: data ? "连接成功" : "返回内容为空" };
    } catch (e) {
      return { ok: false, message: `连接失败：${e.message}` };
    }
  }

  /**
   * 用自然语言修改角色。优先走 AI 网关（Key 在服务端，docs/design/ai-agent-gateway-design.md）；
   * 网关不可用时回退直连大模型；仍未配置或失败时回落本地规则引擎，保证无网络/无 Key 环境可用。
   */
  async refine(prompt, currentConfig) {
    const text = String(prompt || "").trim();
    if (!text) return { ok: false, message: "请输入修改描述", config: currentConfig };

    // 1) 网关优先（AI 能力平台化：Key 在服务端，见 docs/design/ai-agent-gateway-design.md）
    try {
      if (await gatewayAvailable()) {
        const data = await invokeAbility("face-refine", { prompt: text, currentConfig });
        const changes = data && data.changes && typeof data.changes === "object" ? data.changes : null;
        if (data && data.ok !== false && changes && Object.keys(changes).length) {
          // 前端本地 PARAM_MAP 做最终 clamp（前端是参数权威）
          const cfg = clampConfig(currentConfig);
          let count = 0;
          for (const [id, raw] of Object.entries(changes)) {
            const p = PARAM_MAP[id];
            if (!p) continue;
            const v = Number(raw);
            if (!Number.isFinite(v)) continue;
            cfg.params[id] = Math.min(p.max, Math.max(p.min, Math.round(v)));
            count++;
          }
          if (count) {
            return { ok: true, source: "gateway", message: data.reply || `已调整 ${count} 项参数`, config: cfg };
          }
        }
        // 网关返回无效结果 → 继续走本地路径
      }
    } catch (e) {
      // 网关不可用/调用失败 → 回退旧路径，永不阻塞业务
    }

    // 2) 旧直连路径（保留作为回退；阶段 1.5 网关稳定后降级为高级模式）
    if (this.configured) {
      try {
        const data = await this._chat([
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `用户要求：${text}\n\n当前角色参数：\n${describeConfig(currentConfig)}\n\n请输出 JSON。` },
        ], 420);
        const parsed = this._parse(data);
        if (parsed && parsed.changes && Object.keys(parsed.changes).length) {
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
          if (count) {
            return { ok: true, source: "ai", message: parsed.reply || `已调整 ${count} 项参数`, config: cfg };
          }
        }
        return { ok: false, message: "模型未返回有效参数，已尝试本地方案", config: currentConfig };
      } catch (e) {
        return { ...this.localRefine(text, currentConfig), message: `大模型调用失败（${e.message}），已用本地方案` };
      }
    }
    return { ...this.localRefine(text, currentConfig), source: "local" };
  }

  async _chat(messages, maxTokens) {
    const endpoint = this.config.endpoint.replace(/\/+$/, "");
    const res = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        temperature: 0.6,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout ? AbortSignal.timeout(30000) : undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
    const json = await res.json();
    return json?.choices?.[0]?.message?.content || "";
  }

  _parse(content) {
    if (!content) return null;
    let s = String(content).trim();
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  }

  /** 离线规则引擎：覆盖高频中文捏脸指令 */
  localRefine(prompt, currentConfig) {
    const p = String(prompt).toLowerCase();
    const cfg = clampConfig(currentConfig);
    const set = (id, v) => { if (PARAM_MAP[id]) cfg.params[id] = Math.min(PARAM_MAP[id].max, Math.max(PARAM_MAP[id].min, Math.round(v))); };
    const shift = (id, d) => set(id, cfg.params[id] + d);
    const notes = [];
    const has = (...words) => words.some((w) => p.includes(w));

    const style = PRESETS.find((s) => s.id !== "default" && has(s.label, s.id));
    if (style) {
      Object.assign(cfg.params, presetConfig(style, cfg.avatar).params);
      cfg.name = style.label;
      return { ok: true, source: "local", message: `已切换为「${style.label}」风格`, config: cfg };
    }
    if (has("随机", "随便", "来个")) {
      const r = randomConfig(cfg.avatar);
      return { ok: true, source: "local", message: "已随机生成一张新脸", config: r };
    }

    if (has("大眼", "眼睛大", "眼睛放大", "水汪汪")) { shift("eyeSize", 22); shift("eyelidOpen", 10); notes.push("放大眼睛"); }
    if (has("小眼", "眼睛小", "眯眯眼", "细眼")) { shift("eyeSize", -20); shift("eyelidOpen", -12); notes.push("收窄眼睛"); }
    if (has("眼距", "间距大")) shift("eyeSpacing", 14);
    if (has("眼距近", "间距小")) shift("eyeSpacing", -14);
    if (has("吊梢", "上挑", "丹凤眼")) shift("eyeTilt", 22);
    if (has("下垂眼", "狗狗眼", "无辜")) shift("eyeTilt", -20);

    if (has("瓜子脸", "瘦脸", "脸小", "尖脸", "小v脸", "v脸")) { shift("faceWidth", -20); shift("chinPoint", 20); notes.push("收窄脸型"); }
    if (has("圆脸", "脸宽", "包子脸", "脸大")) { shift("faceWidth", 20); shift("chinPoint", -14); notes.push("加宽脸型"); }
    if (has("下巴长", "尖下巴")) shift("chinLength", 22);
    if (has("下巴短", "圆下巴")) shift("chinLength", -20);
    if (has("颧骨高", "立体")) shift("cheekBone", 18);
    if (has("下颌", "国字脸", "方脸")) shift("jawWidth", 18);
    if (has("脸长", "长脸")) shift("faceLength", 16);
    if (has("脸短", "短脸")) shift("faceLength", -16);

    if (has("高鼻梁", "挺鼻", "鼻子挺", "鼻梁高")) { shift("noseHeight", 24); notes.push("挺高鼻梁"); }
    if (has("塌鼻", "鼻梁低")) shift("noseHeight", -20);
    if (has("鼻翼宽", "大鼻子")) shift("noseWidth", 18);
    if (has("鼻翼窄", "小鼻子")) shift("noseWidth", -16);
    if (has("长鼻子", "鼻子长")) shift("noseLength", 16);

    if (has("厚唇", "嘴唇厚", "嘟嘟唇")) shift("lipThickness", 22);
    if (has("薄唇", "嘴唇薄")) shift("lipThickness", -20);
    if (has("大嘴", "嘴宽")) shift("mouthWidth", 18);
    if (has("小嘴", "嘴窄", "樱桃嘴")) shift("mouthWidth", -18);
    if (has("微笑", "笑意", "笑脸", "开心", "嘴角上扬")) { shift("smile", 24); notes.push("带上笑意"); }
    if (has("冷淡", "面无表情", "严肃")) shift("smile", -24);

    if (has("眉毛浓", "浓眉")) shift("browThickness", 22);
    if (has("眉毛淡", "淡眉")) shift("browThickness", -20);
    if (has("高眉", "眉毛高")) shift("browHeight", 18);
    if (has("剑眉", "英气")) { shift("browThickness", 16); shift("browArch", -12); }

    if (has("白皙", "皮肤白", "白皮", "白一点")) { set("skinTone", 18); notes.push("调白肤色"); }
    if (has("小麦", "晒黑", "健康肤色", "深色皮肤", "黑一点")) { set("skinTone", 78); notes.push("调深肤色"); }
    if (has("自然肤色", "正常肤色")) set("skinTone", 50);

    const hairWords = ["红发", "蓝发", "紫发", "粉发", "金发", "银发", "白发", "棕发", "黑发"];
    const hairIdx = hairWords.findIndex((w) => has(w));
    if (hairIdx >= 0) {
      const map = { 黑发: 0, 棕发: 2, 金发: 4, 红发: 5, 蓝发: 6, 紫发: 7, 粉发: 8, 银发: 9, 白发: 9 };
      set("hairColor", map[hairWords[hairIdx]] * 10 + 5);
      notes.push("更换发色");
    }

    if (has("优化", "好看", "顺眼", "精致", "美化")) {
      shift("faceWidth", -6); shift("eyeSize", 8); shift("noseHeight", 8); shift("smile", 10);
      notes.push("按大众审美微调");
    }

    if (!notes.length) {
      return { ok: false, source: "local", message: "没听懂这个描述，试试「大眼睛」「瓜子脸」「高鼻梁」「微笑」「优化一下」", config: currentConfig };
    }
    cfg.name = "AI 调整";
    return { ok: true, source: "local", message: `已${notes.join("、")}`, config: cfg };
  }
}

export { defaultConfig };
