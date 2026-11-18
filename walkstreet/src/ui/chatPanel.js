/* ------------------------------------------------------------------ *
 * ChatPanel —— 右下角频道聊天面板（主界面 = AI 聊天框）
 *
 * 设计文档：docs/design/chat-channel-design.md
 * 频道模型：ai（交互式，走网关→本地兜底回退链）/ world / system（只读日志流）。
 * 消息统一缓冲 + 按频道过滤渲染；对外推送约定：
 *   window.dispatchEvent(new CustomEvent("ws:chat", { detail: { channel, from, text, kind } }))
 * ------------------------------------------------------------------ */
import { gatewayAvailable, invokeAbility, getGatewayUrl } from "../ai/wsAiClient.js";
import { localReply } from "./chatFallback.js";

const CHANNELS = [
  { id: "ai", name: "AI 助手", type: "interactive" },
  { id: "world", name: "世界", type: "log" },
  { id: "system", name: "系统", type: "log" },
];

/* 聊天模型预设：网关不可达时的回退清单；实际清单以网关 /api/ai/chat/providers 为准 */
const CHAT_MODEL_PRESETS = [
  { id: "deepseek", name: "DeepSeek", model: "deepseek-chat" },
  { id: "qwen", name: "通义千问", model: "qwen-plus" },
];
const CHAT_PROVIDER_NAMES = { deepseek: "DeepSeek", qwen: "通义千问" }; // 未收录的 id 直接展示 id
const PROVIDERS_CACHE_MS = 30_000;

const LS_CHAT_MODEL = "ws_chat_model";   // {type:"gateway",provider} | {type:"custom"}
const LS_CHAT_CUSTOM = "ws_chat_custom"; // {endpoint, model, apiKey}（自定义直连，仅存本机浏览器）

const HISTORY_LIMIT = 10;   // 发给 AI 的最近上下文条数
const AI_TIMEOUT_MS = 30_000;

/* 自定义直连时的系统指令（网关版的精简拷贝，见 ai-gateway CHAT_INSTRUCTIONS） */
const CHAT_SYSTEM_PROMPT = `你是开放世界游戏《步行街》的 AI 向导「小漫」，在游戏聊天面板里回答玩家的问题。
背景：浏览器端 3D 虚拟街区，玩家可自由探索，有夜市、商铺、广告牌、车流和行人；操作有 WASD 移动、F 上下车、M 大地图、C 重置镜头，另有捏脸工坊与地图编辑器。
规则：简体中文、口语化、80 字以内；优先结合游戏状态给具体可行的建议；不编造不存在的功能或地点。`;

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const nowTime = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export class ChatPanel {
  constructor(hudRoot) {
    this.root = hudRoot.querySelector("#chat-panel");
    this.toggle = hudRoot.querySelector("#chat-toggle");
    if (!this.root || !this.toggle) throw new Error("ChatPanel: 找不到 #chat-panel / #chat-toggle");

    this.messages = [];                       // 统一缓冲 {channel, from, text, kind, time, source}
    this.unread = Object.fromEntries(CHANNELS.map((c) => [c.id, 0]));
    this.active = "ai";
    this.busy = false;                        // AI 回复中（防并发发送）
    this.modelSel = this._loadModelSel();     // 当前选中的聊天模型
    this.customCfg = this._loadCustomCfg();   // 自定义直连配置（null = 未配置）
    this.gatewayProviders = null;             // 网关真实聊天模型清单（懒加载，30s 缓存）
    this._providersAt = 0;
    this._onWsChat = null;
    this._onDocClick = null;
    this._speedoObserver = null;

    this._build();
    this._bind();
    this._renderTabs();
    this._renderModelButton();
    this._render();
    this._loadGatewayProviders(); // 预热网关模型清单（fire-and-forget）
  }

  _build() {
    // 系统频道欢迎语
    this.messages.push(
      { channel: "system", from: "系统", text: "欢迎来到步行街！按 Enter 呼出聊天，AI 助手小漫随时为你导航。", kind: "system", time: nowTime() },
      { channel: "ai", from: "小漫", text: "你好呀，我是小漫～想去哪、想吃什么、怎么玩，直接问我就行！", kind: "ai", time: nowTime() },
    );
  }

  _bind() {
    const $ = (id) => this.root.querySelector(id);
    this.listEl = $("#chat-list");
    this.tabsEl = $("#chat-tabs");
    this.typingEl = $("#chat-typing");
    this.inputEl = $("#chat-input");
    this.sendBtn = $("#chat-send");
    this.badgeEl = this.toggle.querySelector("#chat-badge");
    this.modelBtn = $("#chat-model-btn");
    this.modelNameEl = $("#chat-model-name");
    this.modelMenu = $("#chat-model-menu");

    // 开关
    this.toggle.addEventListener("click", () => this.toggleOpen());
    $("#chat-close").addEventListener("click", () => this.close());

    // 模型选择器
    this.modelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.modelMenu.classList.toggle("hidden");
      if (!this.modelMenu.classList.contains("hidden")) this._openModelMenu();
    });
    this.modelMenu.addEventListener("click", (e) => {
      const item = e.target.closest(".chat-model-item");
      if (!item) return;
      e.stopPropagation();
      if (item.dataset.action === "config") { this._openModelForm(); return; }
      if (item.dataset.type === "gateway") {
        this._setModel({ type: "gateway", provider: item.dataset.provider });
      } else if (item.dataset.type === "custom") {
        if (this.customCfg) this._setModel({ type: "custom" });
        else this._openModelForm();
      }
    });
    // 点击面板其他区域收起模型菜单
    this._onDocClick = (e) => {
      if (!e.target.closest || !e.target.closest(".chat-model")) this.modelMenu.classList.add("hidden");
    };
    document.addEventListener("click", this._onDocClick);

    // Tab 切换（事件委托）
    this.tabsEl.addEventListener("click", (e) => {
      const tab = e.target.closest(".chat-tab");
      if (tab) this.switchChannel(tab.dataset.channel);
    });

    // 输入框：Enter 发送 / Shift+Enter 换行 / Esc 关闭
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this._send();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
      e.stopPropagation(); // 不让按键漏进游戏输入系统
    });

    this.sendBtn.addEventListener("click", () => this._send());

    // 对外推送约定：其他系统往频道发消息
    this._onWsChat = (e) => {
      const d = e.detail || {};
      if (d.channel && d.text) this.push(d.channel, d.from || "系统", String(d.text), d.kind || "system");
    };
    window.addEventListener("ws:chat", this._onWsChat);

    // 驾驶时面板降透明度（不与速度表争视野）：观察 #speedo 显隐
    const speedo = document.getElementById("speedo");
    if (speedo && typeof MutationObserver === "function") {
      this._speedoObserver = new MutationObserver(() => {
        this.root.classList.toggle("driving", !speedo.classList.contains("hidden"));
      });
      this._speedoObserver.observe(speedo, { attributes: true, attributeFilter: ["class"] });
    }
  }

  /* ---------- 显隐 ---------- */
  get open() { return !this.root.classList.contains("hidden"); }

  toggleOpen() { this.open ? this.close() : this.show(); }

  show() {
    const wasHidden = this.root.classList.contains("hidden");
    this.root.classList.remove("hidden");
    this._markRead(this.active);
    if (wasHidden) this._render(); // 收起期间可能已攒下未渲染的消息
    setTimeout(() => this.inputEl.focus(), 0);
    this._scrollBottom();
  }

  close() {
    this.root.classList.add("hidden");
    this.inputEl.blur();
    const canvas = document.getElementById("game-canvas");
    if (canvas) canvas.focus();
  }

  /* ---------- 频道 ---------- */
  switchChannel(id) {
    if (this.active === id) return;
    this.active = id;
    this._renderTabs();
    this._markRead(id);
    this._render();
    if (this.open && id === "ai") setTimeout(() => this.inputEl.focus(), 0);
  }

  _markRead(id) {
    this.unread[id] = 0;
    this._updateBadge();
    this._renderTabs();
  }

  _updateBadge() {
    const total = CHANNELS.reduce((s, c) => s + (c.id === this.active ? 0 : this.unread[c.id]), 0);
    this.badgeEl.textContent = String(total);
    this.badgeEl.classList.toggle("hidden", total === 0);
  }

  /* ---------- 消息 ---------- */
  /** 对内推送入口（也供 hud/世界逻辑直接调用实例方法） */
  push(channel, from, text, kind) {
    if (!CHANNELS.some((c) => c.id === channel)) return;
    this.messages.push({ channel, from: String(from), text: String(text), kind: kind || "system", time: nowTime() });
    if (this.messages.length > 400) this.messages.splice(0, this.messages.length - 400);
    if (channel === this.active && this.open) {
      this._render();
    } else {
      this.unread[channel] = (this.unread[channel] || 0) + 1;
      this._updateBadge();
      this._renderTabs();
      // 收起时收到 AI 消息则自动展开（主界面是 AI 聊天）
      if (channel === "ai" && !this.open) this.show();
    }
  }

  _append(msg) {
    this.push(msg.channel, msg.from, msg.text, msg.kind);
    const last = this.messages[this.messages.length - 1];
    if (last && msg.source) last.source = msg.source;
    if (msg.channel === this.active && this.open) this._render();
  }

  /* ---------- 发送 / AI 链路 ---------- */
  async _send() {
    const text = this.inputEl.value.trim();
    if (!text || this.busy) return;
    this.inputEl.value = "";
    this._append({ channel: "ai", from: "你", text, kind: "user", time: nowTime() });
    await this._askAI(text);
  }

  async _askAI(message) {
    this.busy = true;
    this.sendBtn.disabled = true;
    this.typingEl.classList.remove("hidden");
    this._scrollBottom();

    let reply = "";
    let source = "local";
    let note = "";
    try {
      const sel = this.modelSel;
      if (sel.type === "gateway") {
        // 网关预设：key 在服务端，按 provider 选择聊天模型
        if (!(await gatewayAvailable())) {
          throw Object.assign(new Error("网关不可用，走本地兜底"), { code: "GATEWAY_UNAVAILABLE" });
        }
        const result = await invokeAbility(
          "chat",
          { message, history: this._aiHistory(), gameState: this._gameState(), provider: sel.provider },
          { timeoutMs: AI_TIMEOUT_MS },
        );
        reply = typeof result?.reply === "string" ? result.reply.trim() : "";
        if (!reply) throw Object.assign(new Error("网关返回空内容"), { code: "MODEL_EMPTY" });
        source = "agent";
      } else {
        // 自定义模型：前端直连 OpenAI 兼容端点（配置仅存本机浏览器）
        if (!this.customCfg) throw Object.assign(new Error("自定义模型未配置"), { code: "CUSTOM_NOT_CONFIGURED" });
        reply = await this._invokeCustom(this.customCfg, message, this._aiHistory(), this._gameState());
        if (!reply) throw Object.assign(new Error("自定义模型返回空内容"), { code: "MODEL_EMPTY" });
        source = "agent";
      }
    } catch (e) {
      // 回退链最后一环：本地规则引擎（永不阻塞业务）
      reply = localReply(message);
      source = "local";
      if (e && e.code === "PROVIDER_NOT_CONFIGURED") {
        note = "该模型未在网关配置，本次由本地知识库回复";
      }
    }

    this.busy = false;
    this.sendBtn.disabled = false;
    this.typingEl.classList.add("hidden");
    if (note) this.push("system", "系统", note, "system");
    this._append({ channel: "ai", from: "小漫", text: reply, kind: "ai", time: nowTime(), source });
    if (this.open) setTimeout(() => this.inputEl.focus(), 0);
  }

  /** 自定义直连：POST <endpoint>/chat/completions（OpenAI 兼容），返回回复文本（失败抛错） */
  async _invokeCustom(cfg, message, history, gameState) {
    const stateText = this._gameStateText(gameState);
    const content = stateText ? `${message}\n\n[当前游戏状态] ${stateText}` : message;
    const res = await fetch(`${String(cfg.endpoint).replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: CHAT_SYSTEM_PROMPT },
          ...history,
          { role: "user", content },
        ],
        temperature: 0.8,
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout ? AbortSignal.timeout(AI_TIMEOUT_MS) : undefined,
    });
    if (!res.ok) throw Object.assign(new Error(`自定义模型 HTTP ${res.status}`), { code: "CUSTOM_HTTP_ERROR" });
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content;
    return typeof text === "string" ? text.trim() : "";
  }

  /** 游戏状态对象 → 一行摘要文本（网关端 summarizeGameState 的前端镜像） */
  _gameStateText(state) {
    if (!state || typeof state !== "object") return "";
    const parts = [];
    if (state.pos && typeof state.pos.x === "number" && typeof state.pos.z === "number") {
      parts.push(`位置(${state.pos.x}, ${state.pos.z})`);
    }
    if (state.district) parts.push(`所在区「${state.district}」`);
    if (state.gameTime) parts.push(`游戏时间 ${state.gameTime}`);
    if (state.money) parts.push(`金钱 ¥${state.money}`);
    if (state.driving === true) parts.push("正在驾驶");
    return parts.join(" · ");
  }

  /* ---------- 模型选择器 ---------- */
  _loadModelSel() {
    try {
      const sel = JSON.parse(localStorage.getItem(LS_CHAT_MODEL) || "null");
      if (sel && (sel.type === "gateway" || sel.type === "custom")) return sel;
    } catch { /* 损坏数据按默认处理 */ }
    return { type: "gateway", provider: CHAT_MODEL_PRESETS[0].id };
  }

  _loadCustomCfg() {
    try {
      const cfg = JSON.parse(localStorage.getItem(LS_CHAT_CUSTOM) || "null");
      if (cfg && cfg.endpoint && cfg.model && cfg.apiKey) {
        return { endpoint: String(cfg.endpoint), model: String(cfg.model), apiKey: String(cfg.apiKey) };
      }
    } catch { /* 损坏数据按未配置处理 */ }
    return null;
  }

  _setModel(sel) {
    this.modelSel = sel;
    try { localStorage.setItem(LS_CHAT_MODEL, JSON.stringify(sel)); } catch { /* 无痕模式忽略 */ }
    this._renderModelButton();
    this.modelMenu.classList.add("hidden");
  }

  _providerName(id) { return CHAT_PROVIDER_NAMES[id] || id; }

  /** 当前可选的网关模型清单：优先真实配置，网关不可达时回退本地预设 */
  _modelList() {
    return this.gatewayProviders || CHAT_MODEL_PRESETS;
  }

  /** 打开菜单：先用现有数据渲染，再异步拉网关真实清单，到达后刷新（模型名以服务端 .env 为准） */
  async _openModelMenu() {
    this._renderModelMenu();
    const prev = this.gatewayProviders;
    await this._loadGatewayProviders();
    if (this.gatewayProviders !== prev && !this.modelMenu.classList.contains("hidden")) {
      this._renderModelMenu();
    }
  }

  async _loadGatewayProviders() {
    if (this._providersAt && Date.now() - this._providersAt < PROVIDERS_CACHE_MS) return;
    this._providersAt = Date.now();
    try {
      const base = getGatewayUrl();
      if (!base) throw new Error("gateway disabled");
      const res = await fetch(`${base}/api/ai/chat/providers`, {
        signal: AbortSignal.timeout ? AbortSignal.timeout(1500) : undefined,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const list = (Array.isArray(json?.result) ? json.result : [])
        .filter((p) => p && typeof p.id === "string" && typeof p.model === "string" && p.model)
        .map((p) => ({ id: p.id, name: this._providerName(p.id), model: p.model }));
      this.gatewayProviders = list.length ? list : null;
    } catch {
      this.gatewayProviders = null; // 网关不可达 → 用本地预设
    }
    this._renderModelButton();
  }

  _modelLabel() {
    if (this.modelSel.type === "custom") return this.customCfg ? this.customCfg.model : "自定义";
    const preset = this._modelList().find((p) => p.id === this.modelSel.provider);
    return preset ? preset.name : "DeepSeek";
  }

  _renderModelButton() {
    if (this.modelNameEl) this.modelNameEl.textContent = this._modelLabel();
  }

  _renderModelMenu() {
    const sel = this.modelSel;
    let html = this._modelList().map((p) =>
      `<button class="chat-model-item ${sel.type === "gateway" && sel.provider === p.id ? "on" : ""}" data-type="gateway" data-provider="${p.id}">` +
      `<span class="mi-name">✦ ${escapeHtml(p.name)}</span><small>${escapeHtml(p.model)}</small></button>`
    ).join("");
    if (this.customCfg) {
      html += `<button class="chat-model-item ${sel.type === "custom" ? "on" : ""}" data-type="custom">` +
        `<span class="mi-name">✦ 自定义模型</span><small>${escapeHtml(this.customCfg.model)}</small></button>`;
    }
    html += `<div class="chat-model-sep"></div>` +
      `<button class="chat-model-item config" data-action="config"><span class="mi-name">⚙ 配置自定义模型…</span></button>`;
    this.modelMenu.innerHTML = html;
  }

  /** 「配置自定义模型」内联表单（覆盖菜单内容，保存后回到列表） */
  _openModelForm() {
    const c = this.customCfg || { endpoint: "", model: "", apiKey: "" };
    this.modelMenu.innerHTML = `<div class="chat-model-form">
      <label for="chat-cf-endpoint">接口地址（OpenAI 兼容，形如 https://api.xxx.com/v1）</label>
      <input id="chat-cf-endpoint" placeholder="https://api.openai.com/v1" value="${escapeHtml(c.endpoint)}" autocomplete="off" />
      <label for="chat-cf-model">模型名称</label>
      <input id="chat-cf-model" placeholder="gpt-4o-mini / qwen-plus / deepseek-chat" value="${escapeHtml(c.model)}" autocomplete="off" />
      <label for="chat-cf-key">API Key（仅保存在本机浏览器）</label>
      <input id="chat-cf-key" type="password" placeholder="sk-..." value="${escapeHtml(c.apiKey)}" autocomplete="off" />
      <div class="cf-actions">
        <button type="button" id="chat-cf-save">保存并使用</button>
        <button type="button" id="chat-cf-cancel">取消</button>
      </div>
    </div>`;
    const $ = (id) => this.modelMenu.querySelector(id);
    $("#chat-cf-cancel").addEventListener("click", (e) => {
      e.stopPropagation();
      this._renderModelMenu();
    });
    $("#chat-cf-save").addEventListener("click", (e) => {
      e.stopPropagation();
      const endpoint = $("#chat-cf-endpoint").value.trim();
      const model = $("#chat-cf-model").value.trim();
      const apiKey = $("#chat-cf-key").value.trim();
      if (!endpoint || !model || !apiKey) return;
      this.customCfg = { endpoint, model, apiKey };
      try { localStorage.setItem(LS_CHAT_CUSTOM, JSON.stringify(this.customCfg)); } catch { /* 无痕模式忽略 */ }
      this._setModel({ type: "custom" });
    });
  }

  /** 最近 10 条 AI 频道消息 → 网关 history（user/assistant） */
  _aiHistory() {
    return this.messages
      .filter((m) => m.channel === "ai" && (m.kind === "user" || m.kind === "ai"))
      .slice(-HISTORY_LIMIT - 1, -1) // 排除刚追加的当前这条
      .map((m) => ({ role: m.kind === "user" ? "user" : "assistant", content: m.text }));
  }

  /** 轻量游戏状态摘要：位置 / 区名 / 游戏时间 / 金钱（全部读不到也不影响回复） */
  _gameState() {
    try {
      const g = window.__game;
      const state = {};
      if (g && g.player && g.player.pos) {
        state.pos = { x: Math.round(g.player.pos.x), z: Math.round(g.player.pos.z) };
        state.driving = !!g.player.driving;
      }
      const district = document.getElementById("hud-district-zh");
      if (district) state.district = district.textContent.trim();
      const time = document.getElementById("hud-time");
      if (time) state.gameTime = time.textContent.trim();
      const money = document.getElementById("hud-money");
      if (money) state.money = money.textContent.trim();
      return state;
    } catch {
      return {};
    }
  }

  /* ---------- 渲染 ---------- */
  _renderTabs() {
    this.tabsEl.innerHTML = CHANNELS.map((c) => {
      const n = c.id === this.active ? 0 : this.unread[c.id];
      return `<button class="chat-tab ${c.id === this.active ? "on" : ""}" data-channel="${c.id}">${c.name}` +
        (n > 0 ? `<i class="tab-badge">${n > 99 ? "99+" : n}</i>` : "") + `</button>`;
    }).join("");
  }

  _render() {
    const msgs = this.messages.filter((m) => m.channel === this.active);
    this.listEl.innerHTML = msgs.map((m) => {
      const cls = m.kind === "user" ? "me" : m.kind;
      const offline = m.source === "local" && m.kind === "ai" ? `<span class="cm-offline">离线</span>` : "";
      return `<div class="chat-msg ${cls}">` +
        (m.kind === "system" ? "" : `<div class="cm-from">${escapeHtml(m.from)}${offline}</div>`) +
        `<div class="cm-bubble">${escapeHtml(m.text)}</div>` +
        `<div class="cm-time">${escapeHtml(m.time)}</div>` +
        `</div>`;
    }).join("");
    this._scrollBottom();
  }

  _scrollBottom() {
    if (this.listEl) this.listEl.scrollTop = this.listEl.scrollHeight;
  }

  dispose() {
    if (this._onWsChat) window.removeEventListener("ws:chat", this._onWsChat);
    if (this._onDocClick) document.removeEventListener("click", this._onDocClick);
    if (this._speedoObserver) this._speedoObserver.disconnect();
  }
}
