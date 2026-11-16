import { CONTENT_TYPES, FIT_MODES, AUDIO_MODES, SOURCE_TYPES, defaultContent, normalizeContent, DEFAULT_TEXT } from "../../world/billboard/contentConfig.js";
import { SOURCE_KINDS, listSourceCatalog, setSourceCatalog, registerAssetSource } from "../../world/billboard/contentSources.js";
import { listAssets } from "../../data/assetStore.js";

/* ---------------- 广告大屏 · 内容配置页面 ----------------
 * 入口：3D 地图编辑器中选中广告牌 → 右侧属性面板「编辑显示内容」。
 * 配置写回 billboard.params.content，随地图保存；运行时按配置构建内容池。
 * 纯 DOM 模态，无第三方依赖；Esc / 点击遮罩关闭，保存才生效。
 */

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const typeOptions = (sel) => Object.entries(CONTENT_TYPES)
  .map(([id, m]) => `<option value="${id}"${id === sel ? " selected" : ""}>${m.label}</option>`).join("");

const fitOptions = (sel) => Object.entries(FIT_MODES)
  .map(([id, label]) => `<option value="${id}"${id === sel ? " selected" : ""}>${label}</option>`).join("");

const audioOptions = (sel) => Object.entries(AUDIO_MODES)
  .map(([id, label]) => `<option value="${id}"${id === sel ? " selected" : ""}>${label}</option>`).join("");

const SOURCE_TYPE_LABELS = {
  auto: "自动（按素材）", flat: "2D 平面渲染", "3d-static": "3D 静态渲染（离轴）",
};
const sourceTypeOptions = (sel) => SOURCE_TYPES
  .map((id) => `<option value="${id}"${id === sel ? " selected" : ""}>${SOURCE_TYPE_LABELS[id] || id}</option>`).join("");
const sourceKindOptions = (sel) => Object.entries(SOURCE_KINDS)
  .map(([id, m]) => `<option value="${id}"${id === sel ? " selected" : ""}>${m.label}</option>`).join("");

/** 每条素材的来源控件（解耦层 3：内容只引用来源 ID，不写死地址） */
const sourceFieldsHtml = (it) => {
  const kind = (it.source && it.source.kind) || "inline";
  return `<label class="bbc-f">素材来源<select class="bbc-source">${sourceKindOptions(kind)}</select></label>
    ${kind !== "inline" ? `<label class="bbc-f">素材 ID<input class="bbc-srcid" value="${esc((it.source && it.source.id) || "")}" placeholder="media_xxx / asset_xxx" /></label>` : ""}
    <button class="bbc-mini" data-act="pick" title="从后台素材库选素材">选素材</button>
    <span class="bbc-desc">来源非「直接地址」时，地址按素材 ID 自动解析；下方 URL 可作离线兜底。</span>`;
};

/** 后台地址：与 adminClient 同一优先级，供「从后台素材库选择」用 */
function adminEndpoint() {
  try {
    const v = new URLSearchParams(location.search).get("admin");
    if (v && v !== "off" && v !== "0") return v.replace(/\/+$/, "");
  } catch { /* 忽略 */ }
  let s = null;
  try { s = localStorage.getItem("ws_admin_url"); } catch { /* 忽略 */ }
  return s === "off" ? "" : (s || "http://127.0.0.1:8787").replace(/\/+$/, "");
}

const _assetUrls = new Map(); // assetId → objectURL（内容源Provider 用，避免重复创建）

/** 把资产库里带 GLB 的模型注册为「模型工坊资产」内容源 */
async function ensureAssetSources() {
  const assets = await listAssets();
  for (const a of assets) {
    if (!a.glb || _assetUrls.has(a.id)) continue;
    const url = URL.createObjectURL(a.glb);
    _assetUrls.set(a.id, url);
    registerAssetSource(a.id, url, { name: a.name, type: "model3d", is3d: true, depth: 2.5 });
  }
  return assets;
}

/** 素材目录：优先用运行时已缓存的，缺失时从后台拉一次（解耦层 4） */
async function loadMediaCatalog() {
  let list = listSourceCatalog("admin");
  if (list.length) return list;
  const ep = adminEndpoint();
  if (!ep) return [];
  try {
    const r = await fetch(ep + "/api/media", { signal: AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined });
    if (!r.ok) return [];
    const data = await r.json();
    list = Array.isArray(data) ? data : (data.media || []);
    setSourceCatalog("admin", list);
    return list;
  } catch { return []; }
}

/* 3D 内容地址的就地提示，规则与运行时 content3d.js 的 plan3dLoad 一致。
 * 只提示、不拦截保存；builtin:// 是内置内容标识，其余一律按 GLB 地址处理。 */
const model3dWarn = (url) => {
  const u = String(url || "").trim();
  if (!u || u === "builtin://demo1") return "";
  if (/^builtin:\/\/(demo2|calib)$/i.test(u)) return "";
  if (/^builtin:\/\//i.test(u)) return "未知内置 3D 内容：可用 builtin://demo1 / demo2 / calib，请检查拼写";
  if (!/^https?:\/\//i.test(u) && !u.startsWith("/")) return "地址无效：请填 http(s) 或 /media/ 的 GLB 地址，或 builtin:// 内置内容";
  return "";
};

/** @param {object|null} content 当前 params.content（null = 默认节目单）
 *  @param {(cfg: object) => void} onSave 保存回调 */
export function openBillboardContent(content, onSave) {
  const state = normalizeContent(content) || defaultContent();
  let resolveClose = null;

  const overlay = document.createElement("div");
  overlay.className = "bbc-overlay";
  overlay.innerHTML = `
    <div class="bbc-panel">
      <div class="bbc-head">
        <div><h3>广告大屏 · 显示内容</h3><small>CONTENT PLAYLIST</small></div>
        <span class="bbc-x" data-act="close">×</span>
      </div>
      <div class="bbc-toolbar">
        <label>显示模式<select id="bbc-fit">${fitOptions(state.fit)}</select></label>
        <label>过渡(秒)<input id="bbc-transition" type="number" min="0" max="2" step="0.1" value="${state.transition}" /></label>
        <label>音频<select id="bbc-audio">${audioOptions(state.audio)}</select></label>
        <label>内容源类型<select id="bbc-sourcetype" title="解耦内容渲染接口：3D 静态渲染需 3D转角包柱屏">${sourceTypeOptions(state.sourceType || "auto")}</select></label>
      </div>
      <div class="bbc-toolhint">显示模式仅对图片 / 视频 / 直播生效；文字类自动按屏比排版不会裁切。过渡 0 = 硬切。「内容渲染」选渲染接口，素材来源在每条内容里单独选。</div>
      <div class="bbc-list" id="bbc-list"></div>
      <div class="bbc-addbar" id="bbc-addbar"></div>
      <div class="bbc-foot">
        <button class="bbc-btn ghost" data-act="reset">恢复默认节目单</button>
        <span class="bbc-note" id="bbc-note"></span>
        <button class="bbc-btn ghost" data-act="close">取消</button>
        <button class="bbc-btn primary" data-act="save">保存配置</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const list = overlay.querySelector("#bbc-list");
  const note = overlay.querySelector("#bbc-note");
  const addbar = overlay.querySelector("#bbc-addbar");

  function collect() {
    state.fit = overlay.querySelector("#bbc-fit").value;
    state.audio = overlay.querySelector("#bbc-audio").value;
    state.sourceType = overlay.querySelector("#bbc-sourcetype").value;
    state.transition = Math.min(2, Math.max(0, +overlay.querySelector("#bbc-transition").value || 0));
    const rows = [...list.querySelectorAll(".bbc-row")];
    state.items = rows.map((row, i) => {
      const old = state.items[i] || {};
      const get = (cls) => { const el = row.querySelector(`.${cls}`); return el ? el.value : undefined; };
      return {
        type: get("bbc-type"),
        duration: +get("bbc-dur") || 9,
        seed: old.seed || i + 1,
        text: get("bbc-text") !== undefined ? get("bbc-text") : old.text,
        note: get("bbc-note") !== undefined ? get("bbc-note") : old.note,
        url: get("bbc-url") !== undefined ? get("bbc-url") : old.url,
        fallback: get("bbc-fallback") !== undefined ? get("bbc-fallback") : old.fallback,
        fit: get("bbc-rowfit") !== undefined ? get("bbc-rowfit") : old.fit,
        depth: get("bbc-depth") !== undefined ? +get("bbc-depth") : old.depth,
        // 素材内容源：只存 kind + id；具体地址由 contentSources provider 解析
        source: get("bbc-source") ? { kind: get("bbc-source"), id: String(get("bbc-srcid") || "").trim() } : old.source,
        is3d: old.is3d, flat: old.flat,
      };
    });
  }

  function render(noteText = "") {
    // 只读 state 渲染，绝不反向收集 —— 否则会从尚未更新的 DOM 覆盖掉刚做的增删排序。
    // 所有需要同步输入的地方由调用方先显式 collect()。
    list.innerHTML = state.items.map((it, i) => {
      const meta = CONTENT_TYPES[it.type] || CONTENT_TYPES.ad;
      let fields = "";
      if (it.type === "text") {
        fields = `<label class="bbc-f">字幕内容<textarea class="bbc-text" rows="2" placeholder="循环滚动的文字">${esc(it.text || DEFAULT_TEXT)}</textarea></label>`;
      } else if (it.type === "clock") {
        fields = `<label class="bbc-f">右侧文案<input class="bbc-note" value="${esc(it.note || "晴 24°C")}" placeholder="晴 24°C" /></label>`;
      } else if (it.type === "model3d") {
        // 兼容性警告紧跟输入框显示：保存前就能看到该地址在本渲染分支会退化成什么
        const warn = model3dWarn(it.url);
        fields = `${sourceFieldsHtml(it)}
                  <label class="bbc-f">模型地址 GLB URL（留空 = 内置 3D 演示1；builtin://demo2 = 演示2 · builtin://calib = 几何校准）<input class="bbc-url" value="${esc(it.url || "")}" placeholder="https://… /model.glb 或 builtin://demo1" /></label>
                  <label class="bbc-f">出屏深度（米，0~10，模型中心到屏面距离）<input class="bbc-depth" type="number" min="0" max="10" step="0.5" value="${it.depth ?? 2.5}" /></label>
                  <span class="bbc-desc">经离轴投影呈现 3D 裸眼效果，仅 3D转角包柱屏生效；显示模式对本类型无效。遛眼参数 / 显示开关请在后台「屏位绑定 → 3D 配置」里调。</span>
                  ${warn ? `<span class="bbc-desc" style="color:#ffb86b">注意：${esc(warn)}</span>` : ""}`;
      } else if (meta.media) {
        fields = `${sourceFieldsHtml(it)}
                  <label class="bbc-f">地址 URL<input class="bbc-url" value="${esc(it.url || "")}" placeholder="https://… / .mp4 / .m3u8" /></label>
                  <label class="bbc-f">备用海报（加载失败时显示）<input class="bbc-fallback" value="${esc(it.fallback || "")}" placeholder="https://… / 图片 URL" /></label>
                  <label class="bbc-f">显示模式<select class="bbc-rowfit">${fitOptions(it.fit || state.fit)}</select></label>`;
      } else {
        fields = `<span class="bbc-desc">${meta.hint}</span>`;
      }
      return `<div class="bbc-row" data-i="${i}">
        <div class="bbc-rowhead">
          <span class="bbc-idx">${String(i + 1).padStart(2, "0")}</span>
          <select class="bbc-type">${typeOptions(it.type)}</select>
          <label class="bbc-durwrap">时长(s)<input class="bbc-dur" type="number" min="2" max="300" step="1" value="${it.duration}" /></label>
          <button class="bbc-mini" data-act="up" title="上移">↑</button>
          <button class="bbc-mini" data-act="down" title="下移">↓</button>
          <button class="bbc-mini danger" data-act="del" title="删除">×</button>
        </div>
        <div class="bbc-fields">${fields}</div>
        <div class="bbc-hint">${meta.hint}</div>
      </div>`;
    }).join("");
    addbar.innerHTML = `<span>添加内容：</span>` + Object.entries(CONTENT_TYPES)
      .map(([id, m]) => `<button class="bbc-add" data-type="${id}">+ ${m.label}</button>`).join("");
    note.textContent = noteText;
  }

  // 事件委托：输入框 change 时收集 → 结构变化才重渲染
  overlay.addEventListener("change", (e) => {
    if (e.target.classList.contains("bbc-type")) { collect(); render(); }
    else if (e.target.classList.contains("bbc-source")) { collect(); render(); }
    else if (e.target.id === "bbc-fit") collect();
    else if (e.target.classList.contains("bbc-url")) {
      // model3d 的 URL 变了要重算兼容性警告；其它类型不重建 DOM，避免输入焦点丢失
      const i = +(e.target.closest(".bbc-row")?.dataset.i ?? -1);
      collect();
      if (state.items[i] && state.items[i].type === "model3d") render();
    }
    else collect();
  });
  overlay.addEventListener("input", () => collect());

  overlay.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act],[data-type]");
    if (!btn) { if (e.target === overlay) close(); return; }
    const act = btn.dataset.act;
    const type = btn.dataset.type;
    if (type) {
      collect();
      const item = { type, duration: 9, seed: state.items.length + 1 };
      if (type === "text") item.text = DEFAULT_TEXT;
      if (type === "clock") item.note = "晴 24°C";
      if (type === "model3d") item.depth = 2.5;
      if (CONTENT_TYPES[type].media) { item.url = ""; item.fallback = ""; item.fit = state.fit; }
      state.items.push(item);
      render();
      list.scrollTop = list.scrollHeight;
      return;
    }
    if (act === "close") { close(); return; }
    if (act === "reset") {
      const d = defaultContent();
      state.fit = d.fit; state.items = d.items; state.audio = d.audio; state.transition = d.transition;
      state.sourceType = d.sourceType;
      overlay.querySelector("#bbc-fit").value = d.fit;
      overlay.querySelector("#bbc-audio").value = d.audio;
      overlay.querySelector("#bbc-transition").value = d.transition;
      overlay.querySelector("#bbc-sourcetype").value = d.sourceType;
      render("已恢复默认节目单，尚未保存");
      return;
    }
    if (act === "save") {
      collect();
      const cfg = normalizeContent(state);
      if (!cfg) { render("节目单为空，请至少保留一项"); return; }
      onSave(cfg);
      close();
      return;
    }
    const row = btn.closest(".bbc-row");
    if (!row) return;
    const i = +row.dataset.i;
    collect();
    if (act === "pick") { openMediaPicker(i); return; }
    if (act === "del") state.items.splice(i, 1);
    else if (act === "up" && i > 0) [state.items[i - 1], state.items[i]] = [state.items[i], state.items[i - 1]];
    else if (act === "down" && i < state.items.length - 1) [state.items[i + 1], state.items[i]] = [state.items[i], state.items[i + 1]];
    render();
  });

  /** 素材内容源选择器：列出后台素材库，选中只写 sourceRef + URL 快照 */
  async function openMediaPicker(index) {
    const pick = document.createElement("div");
    pick.className = "bbc-overlay";
    pick.innerHTML = `<div class="bbc-panel" style="max-width:560px">
      <div class="bbc-head"><div><h3>选择素材 · 后台素材库</h3><small>CONTENT SOURCE</small></div><span class="bbc-x" data-act="pickclose">×</span></div>
      <div class="bbc-list" id="bbc-media-list"><div class="bbc-desc">正在读取素材目录…</div></div>
      <div class="bbc-foot"><button class="bbc-btn ghost" data-act="pickclose">取消</button></div>
    </div>`;
    document.body.appendChild(pick);
    const mediaList = pick.querySelector("#bbc-media-list");
    const closePick = () => pick.remove();
    pick.addEventListener("click", (e) => {
      if (e.target.dataset.act === "pickclose" || e.target === pick) closePick();
      const item = state.items[index];
      const mediaCard = e.target.closest("[data-media]");
      if (mediaCard) {
        const media = listSourceCatalog("admin").find((m) => m.id === mediaCard.dataset.media);
        if (!media) return;
        if (item) {
          item.source = { kind: "admin", id: media.id };
          item.url = media.url || "";
          if (media.type === "model3d") item.type = "model3d";
          if (media.is3d !== undefined) item.is3d = media.is3d;
          if (media.depth !== undefined) item.depth = media.depth;
          if (media.flat !== undefined) item.flat = media.flat;
        }
        closePick();
        render(`已引用后台素材「${media.name || media.id}」· 地址按 ID 自动解析`);
        return;
      }
      const assetCard = e.target.closest("[data-asset]");
      if (assetCard) {
        const id = assetCard.dataset.asset;
        if (item) {
          item.source = { kind: "asset", id };
          item.type = "model3d";
          item.url = _assetUrls.get(id) || "";
          item.is3d = true;
          if (item.depth === undefined) item.depth = 2.5;
        }
        closePick();
        render(`已引用模型工坊资产「${id}」· GLB 地址按 ID 自动解析`);
      }
    });
    const [list, assets] = await Promise.all([loadMediaCatalog(), ensureAssetSources()]);
    if (!pick.isConnected) return;
    const mediaHtml = list.map((m) => `
      <div class="bbc-row" data-media="${esc(m.id)}" style="cursor:pointer">
        <div class="bbc-rowhead"><span class="bbc-idx">${esc((m.type || "image").slice(0, 4).toUpperCase())}</span><b>${esc(m.name || m.id)}</b></div>
        <div class="bbc-desc">${esc(m.url || "")}${m.is3d ? " · 3D 素材" : ""}</div>
      </div>`).join("");
    const modelAssets = assets.filter((a) => _assetUrls.has(a.id));
    const assetHtml = modelAssets.length ? `<h4 style="border:none;padding-left:0">模型工坊资产（GLB）</h4>` + modelAssets.map((a) => `
      <div class="bbc-row" data-asset="${esc(a.id)}" style="cursor:pointer">
        <div class="bbc-rowhead"><span class="bbc-idx">GLB</span><b>${esc(a.name || a.id)}</b></div>
        <div class="bbc-desc">3D 裸眼素材 · 按资产 ID 解析</div>
      </div>`).join("") : "";
    mediaList.innerHTML = (mediaHtml || assetHtml)
      ? mediaHtml + assetHtml
      : `<div class="bbc-desc">后台素材库为空或后台未连接，资产库也没有 GLB 模型：请在后台「素材库」添加素材，或把「素材来源」切回「直接地址」。</div>`;
  }

  const onKey = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); close(); }
  };
  document.addEventListener("keydown", onKey, true);

  function close() {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    if (resolveClose) resolveClose();
  }

  render();
}
