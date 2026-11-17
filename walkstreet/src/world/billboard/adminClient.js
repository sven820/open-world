/* ---------------- 后台内容接入客户端 ----------------
 * 主流数字标牌终端模型：上报屏位 → 轮询发布快照 → 按版本热更新 → 回传 ACK。
 *
 * 地址优先级：URL 参数 ?admin=… > localStorage.ws_admin_url > 默认 127.0.0.1:8787。
 * 后台不可达时静默降级：完全使用地图内自带的内容配置，不影响游戏运行。
 */
import { setSourceCatalog } from "./contentSources.js";

const DEFAULT_ENDPOINT = "http://127.0.0.1:8787";
const POLL_MS = 5000;
const REPORT_MS = 30000;

function stored(key) { try { return localStorage.getItem(key); } catch { return null; } }
function store(key, val) { try { localStorage.setItem(key, val); } catch { /* 隐私模式下忽略 */ } }

function resolveEndpoint() {
  let v = "";
  try { v = new URLSearchParams(location.search).get("admin") || ""; } catch { /* 忽略 */ }
  if (v) {
    if (v === "off" || v === "0" || v === "false") return "";
    const url = v.replace(/\/+$/, "");
    store("ws_admin_url", url);
    return url;
  }
  const saved = stored("ws_admin_url");
  return saved === "off" ? "" : (saved || DEFAULT_ENDPOINT).replace(/\/+$/, "");
}

export class AdminSync {
  constructor(endpoint = resolveEndpoint(), pollMs = POLL_MS) {
    this.endpoint = endpoint;
    this.pollMs = pollMs;
    // 一次上报 = 本标签当前世界的完整屏位列表；后台据此回收本终端旧地图的屏位
    this.sessionId = `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.version = -1;
    this.online = false;
    this.lastError = null;
    this.lastPoll = null;
    this.applied = null;
    this.lastPublished = null;
    this.billboards = null;
    this.meta = {};
    this._timer = null;
    this._busy = false;
    this._warned = false;
    this._lastReport = 0;
    this._retryAfter = 0;
  }

  /** 世界构建完成后接入；切换地图只换引用，轮询器保持单例 */
  attach(billboards, meta = {}) {
    this.billboards = billboards;
    this.meta = meta;
    if (!this.endpoint) return;
    if (!this._timer) this._timer = setInterval(() => this.poll(), this.pollMs);
    // 重建世界后立即恢复上一次已发布内容，无需等下一轮轮询
    if (this.lastPublished && billboards) {
      this.applied = billboards.applyExternal(this.lastPublished.screens || {});
    }
    this.report();
    this.poll();
    this.fetchMedia();
  }

  /** 拉取后台素材目录 → 注入素材内容源注册表（解耦层 4：后台内容源管理）。
   *  失败静默：素材 ID 解析不到时内容配置保留原 url，不影响播放。 */
  async fetchMedia() {
    if (!this.endpoint) return [];
    try {
      const data = await this._fetch("/api/media");
      const list = Array.isArray(data) ? data : (data.media || []);
      setSourceCatalog("admin", list);
      this.media = list;
      // 素材目录刚到：强制重建内容池，让按素材 ID 引用的条目拿到真实地址
      if (this.billboards) {
        this.billboards.applyExternal(this.lastPublished ? (this.lastPublished.screens || {}) : {}, true);
      }
      return list;
    } catch {
      return [];
    }
  }

  detach() { this.billboards = null; }

  setEndpoint(url) {
    const v = String(url || "").replace(/\/+$/, "");
    this.endpoint = (v === "off" || v === "0") ? "" : v;
    store("ws_admin_url", this.endpoint || "off");
    this.version = -1;
    this._warned = false;
    this._retryAfter = 0;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this.endpoint) {
      this._timer = setInterval(() => this.poll(), this.pollMs);
      this.poll();
      this.fetchMedia();
    } else {
      this.online = false;
      if (this.billboards) this.applied = this.billboards.applyExternal({});
    }
    return this.endpoint;
  }

  async _fetch(path, opts = {}) {
    const signal = (typeof AbortSignal !== "undefined" && AbortSignal.timeout)
      ? AbortSignal.timeout(4000) : undefined;
    const r = await fetch(this.endpoint + path, {
      ...opts,
      signal,
      headers: opts.body ? { "Content-Type": "application/json" } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }

  /** 上报当前地图的全部屏位：后台据此知道「有多少屏、分别在哪、什么规格」，
   *  再按 id 在发布快照里绑定内容。组合资产里的屏也在清单里（source=composite）。 */
  async report() {
    if (!this.endpoint || !this.billboards) return null;
    const slots = typeof this.billboards.getSlotManifest === "function"
      ? this.billboards.getSlotManifest()
      : this.billboards.screens.map((s, i) => ({
        id: s.id, name: s.name || `${i + 1} 号屏`, mount: s.mount, w: s.w, h: s.h,
        x: Math.round(s.x * 10) / 10, z: Math.round(s.z * 10) / 10,
        assetId: s.assetId || null, hostId: s.hostId || null,
      }));
    const screens = slots.map((s) => ({
      ...s,
      mapId: this.meta.mapId || "default",
      mapName: this.meta.mapName || "默认街区",
    }));
    this._lastReport = Date.now();
    try {
      const r = await this._fetch("/api/screens/report", {
        method: "POST", body: {
          screens, slotCount: screens.length,
          mapId: this.meta.mapId, mapName: this.meta.mapName,
          sessionId: this.sessionId, client: "walkstreet-web",
        },
      });
      this.online = true;
      return r;
    } catch (e) {
      this.lastError = String(e.message || e);
      return null;
    }
  }

  /** 拉取发布快照；版本变化才热更新，并回传 ACK */
  async poll() {
    if (!this.endpoint || this._busy) return null;
    if (this._retryAfter && Date.now() < this._retryAfter) return null; // 后台离线时退避，避免每 5 秒一次失败请求
    this._busy = true;
    try {
      const pub = await this._fetch("/api/publish");
      this.online = true;
      this.lastError = null;
      this._warned = false;
      this._retryAfter = 0;
      this.lastPoll = new Date().toISOString();
      this.lastPublished = pub;
      if (pub.version !== this.version) {
        this.version = pub.version;
        this.applied = this.billboards
          ? this.billboards.applyExternal(pub.screens || {})
          : { applied: 0, changed: 0, screens: 0 };
        await this._fetch("/api/ack", {
          method: "POST",
          body: {
            version: pub.version,
            screens: this.applied.applied,
            client: "walkstreet-web",
            mapName: this.meta.mapName || "默认街区",
          },
        });
        console.info(`[admin] 已应用发布内容 v${pub.version} · 屏位 ${this.applied.applied}/${this.applied.screens}`);
      }
      if (Date.now() - this._lastReport > REPORT_MS) this.report();
      return pub;
    } catch (e) {
      this.online = false;
      this.lastError = String(e.message || e);
      this._retryAfter = Date.now() + 20000;
      if (!this._warned) {
        console.warn("[admin] 后台未连接，广告大屏使用地图内配置：", this.lastError);
        this._warned = true;
      }
      return null;
    } finally {
      this._busy = false;
    }
  }

  pollNow() { this._retryAfter = 0; return this.poll(); }

  status() {
    return {
      endpoint: this.endpoint || "(已关闭)",
      online: this.online,
      version: this.version,
      lastPoll: this.lastPoll,
      lastError: this.lastError,
      applied: this.applied,
      screenCount: this.billboards ? this.billboards.screens.length : 0,
      slots: this.billboards && typeof this.billboards.getSlotManifest === "function"
        ? this.billboards.getSlotManifest() : [],
      screens: this.billboards
        ? this.billboards.screens.map((s) => ({ id: s.id, mount: s.mount, aspect: Number(s.aspect.toFixed(2)), contentKey: s.contentKey }))
        : [],
    };
  }
}
