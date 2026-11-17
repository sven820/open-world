/* ------------------------------------------------------------------ *
 * AI 设置面板组件
 *
 * 只负责「配置 UI」：渲染表单、读写 aiConfig 单例、测试连接。
 * 任何入口都可以 new AISettingsPanel(container) 把配置界面挂到自己的
 * DOM 位置；当前用于设置面板的「AI 设置」tab，将来其他功能也能复用。
 * ------------------------------------------------------------------ */
import { AI_PRESETS, getAIConfig, updateAIConfig, onAIConfigChange, configured } from "../config/aiConfig.js";

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export class AISettingsPanel {
  constructor(container) {
    this.root = typeof container === "string" ? document.querySelector(container) : container;
    if (!this.root) throw new Error("AISettingsPanel: 找不到容器");
    this._unsub = null;
    this._build();
    this.sync();
    this._unsub = onAIConfigChange(() => this.sync());
  }

  _build() {
    this.root.innerHTML = `
      <div class="ai-set-body">
        <div class="ai-set-row">
          <label for="ai-set-preset">服务商预设</label>
          <select id="ai-set-preset" class="ai-set-select">
            ${AI_PRESETS.map((p) => `<option value="${p.id}">${escapeHtml(p.label)}</option>`).join("")}
          </select>
        </div>
        <div class="ai-set-row">
          <label for="ai-set-endpoint">接口地址（OpenAI 兼容，形如 https://api.xxx.com/v1）</label>
          <input id="ai-set-endpoint" type="text" placeholder="https://api.openai.com/v1" autocomplete="off" />
        </div>
        <div class="ai-set-row">
          <label for="ai-set-model">文本模型名称</label>
          <input id="ai-set-model" type="text" placeholder="gpt-4o-mini" autocomplete="off" />
        </div>
        <div class="ai-set-row">
          <label for="ai-set-vision">视觉模型名称（用于「以图生成」，留空则用文本模型；如 gpt-4o-mini / qwen-vl-max）</label>
          <input id="ai-set-vision" type="text" placeholder="gpt-4o-mini" autocomplete="off" />
        </div>
        <div class="ai-set-row">
          <label for="ai-set-key">API Key（仅保存在本机浏览器，不会上传到本项目服务器）</label>
          <input id="ai-set-key" type="password" placeholder="sk-..." autocomplete="off" />
        </div>
        <p class="ai-set-note">未配置 Key 时，AI 助手使用本地规则引擎，「以图生成」使用浏览器端图像分析（仅提取肤色发色）。配置支持图片的视觉模型后，可从照片精确匹配五官。图片仅发送给你在设置中填写的服务商，本项目服务器不参与。</p>
        <div class="ai-set-status" id="ai-set-status">—</div>
        <div class="ai-set-actions">
          <button type="button" class="bm-btn" id="ai-set-test">测试连接</button>
          <button type="button" class="bm-btn ai-set-save" id="ai-set-save">保存设置</button>
        </div>
      </div>`;

    const $ = (id) => this.root.querySelector(id);
    this.preset = $("#ai-set-preset");
    this.endpoint = $("#ai-set-endpoint");
    this.model = $("#ai-set-model");
    this.vision = $("#ai-set-vision");
    this.key = $("#ai-set-key");
    this.status = $("#ai-set-status");

    this.preset.addEventListener("change", () => {
      const pre = AI_PRESETS.find((p) => p.id === this.preset.value);
      if (!pre) return;
      this.endpoint.value = pre.endpoint;
      this.model.value = pre.model;
      this.vision.value = pre.visionModel || "";
    });

    const save = () => {
      updateAIConfig({
        endpoint: this.endpoint.value.trim(),
        model: this.model.value.trim(),
        visionModel: this.vision.value.trim(),
        apiKey: this.key.value.trim(),
      });
      this._setStatus("已保存到本机浏览器", true);
    };
    $("#ai-set-save").addEventListener("click", save);

    $("#ai-set-test").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      save();
      btn.disabled = true;
      btn.textContent = "测试中…";
      this._setStatus("正在连接…");
      try {
        const r = await this._test();
        this._setStatus(r.message, r.ok);
      } catch (err) {
        this._setStatus(`连接失败：${err.message}`, false);
      } finally {
        btn.disabled = false;
        btn.textContent = "测试连接";
      }
    });
  }

  async _test() {
    if (!configured()) return { ok: false, message: "请先填写 API Key、接口地址与模型名" };
    const c = getAIConfig();
    const res = await fetch(`${String(c.endpoint).replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.apiKey}` },
      body: JSON.stringify({
        model: c.model,
        messages: [{ role: "user", content: '请只回复 JSON：{"reply":"连接成功"}' }],
        temperature: 0.3,
        max_tokens: 120,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 100)}`);
    const json = await res.json();
    return { ok: !!json?.choices?.[0]?.message?.content, message: json?.choices?.[0]?.message?.content ? "连接成功" : "返回内容为空" };
  }

  _setStatus(text, ok) {
    this.status.textContent = text;
    this.status.classList.toggle("ok", !!ok);
    this.status.classList.toggle("err", ok === false);
  }

  /** 从配置中心刷新表单（配置被其他入口修改时也会自动调用） */
  sync() {
    const c = getAIConfig();
    this.endpoint.value = c.endpoint || "";
    this.model.value = c.model || "";
    this.vision.value = c.visionModel || "";
    this.key.value = c.apiKey || "";
    const pre = AI_PRESETS.find((p) => p.endpoint === c.endpoint);
    this.preset.value = pre ? pre.id : "custom";
    if (!this.status.classList.contains("ok") && !this.status.classList.contains("err")) {
      this._setStatus(configured() ? "已配置 AI 服务" : "未配置 · 使用本地方案");
    }
  }

  dispose() {
    if (this._unsub) this._unsub();
  }
}
