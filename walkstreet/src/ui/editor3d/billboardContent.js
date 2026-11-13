import { CONTENT_TYPES, FIT_MODES, AUDIO_MODES, defaultContent, normalizeContent, DEFAULT_TEXT } from "../../world/billboard/contentConfig.js";

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
      </div>
      <div class="bbc-toolhint">显示模式仅对图片 / 视频 / 直播生效；文字类自动按屏比排版不会裁切。过渡 0 = 硬切。</div>
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
        fields = `<label class="bbc-f">模型地址 GLB URL（留空 = 内置 3D 演示1；builtin://demo2 = 演示2 · builtin://calib = 几何校准）<input class="bbc-url" value="${esc(it.url || "")}" placeholder="https://… /model.glb 或 builtin://demo1" /></label>
                  <label class="bbc-f">出屏深度（米，0~10，模型中心到屏面距离）<input class="bbc-depth" type="number" min="0" max="10" step="0.5" value="${it.depth ?? 2.5}" /></label>
                  <span class="bbc-desc">经离轴投影呈现 3D 裸眼效果，仅 3D转角包柱屏生效；显示模式对本类型无效。遛眼参数 / 显示开关请在后台「屏位绑定 → 3D 配置」里调。</span>
                  ${warn ? `<span class="bbc-desc" style="color:#ffb86b">注意：${esc(warn)}</span>` : ""}`;
      } else if (meta.media) {
        fields = `<label class="bbc-f">地址 URL<input class="bbc-url" value="${esc(it.url || "")}" placeholder="https://… / .mp4 / .m3u8" /></label>
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
      overlay.querySelector("#bbc-fit").value = d.fit;
      overlay.querySelector("#bbc-audio").value = d.audio;
      overlay.querySelector("#bbc-transition").value = d.transition;
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
    if (act === "del") state.items.splice(i, 1);
    else if (act === "up" && i > 0) [state.items[i - 1], state.items[i]] = [state.items[i], state.items[i - 1]];
    else if (act === "down" && i < state.items.length - 1) [state.items[i + 1], state.items[i]] = [state.items[i], state.items[i + 1]];
    render();
  });

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
