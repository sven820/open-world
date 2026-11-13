/* WalkStreet 广告大屏后台 · 前端
 * 主流数字标牌 CMS 工作流：素材库 → 节目单 → 屏位绑定 → 预览 → 发布 → 终端拉取 / ACK。
 * 原生 ESM，零构建、零依赖；所有数据经 /api/* 与 server.js 交互。
 */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o));
const fmt = (t) => t ? new Date(t).toLocaleString("zh-CN", { hour12: false }) : "—";
const short = (s, n = 42) => { const v = String(s || ""); return v.length > n ? v.slice(0, n) + "…" : v; };

const TYPES = {
  ad: { label: "内置广告", media: false, hint: "程序化品牌广告，游戏端按屏比自动排版" },
  text: { label: "滚动字幕", media: false, hint: "文字按屏比自动缩放，循环滚动" },
  clock: { label: "时钟信息", media: false, hint: "时钟 / 日期按屏宽自适应，不会裁切" },
  image: { label: "图片", media: true, hint: "http(s) 或 /media/ 地址" },
  video: { label: "视频", media: true, hint: "mp4 / webm 直链，远离屏幕自动暂停解码" },
  stream: { label: "直播流", media: true, hint: "HLS(m3u8)，游戏端 hls.js 低延迟播放" },
  model3d: { label: "3D裸眼模型", media: true, hint: "GLB 经离轴投影呈现 3D 裸眼，仅 3D转角包柱屏生效；URL 填 builtin://demo1（内置 3D 演示1）、builtin://demo2（3D 演示2 · 12秒品牌广告）或 GLB 地址，留空 = 内置 3D 演示1" },
};
const FITS = { auto: "自适应（完整显示）", contain: "完整显示（留黑边）", cover: "铺满裁切", stretch: "拉伸铺满" };
const AUDIOS = { off: "静音（推荐）", nearest: "仅最近一块屏出声", on: "全部出声" };
const MOUNTS = { standalone: "独立广告牌", facade: "建筑立面屏", corner: "转角包柱屏", corner3d: "3D转角包柱屏" };
const VIEW_META = {
  dashboard: ["概览", "内容运营总览 · 发布状态 · 演示流程"],
  media: ["素材库", "图片 / 视频 / 直播流统一管理，支持 URL 与本地上传"],
  playlists: ["节目单", "编排轮播内容、显示模式、过渡与音频策略"],
  screens: ["屏位绑定", "把节目单指派到游戏世界中的每一块广告大屏"],
  publish: ["发布", "冻结当前工作区为版本快照，终端按版本拉取"],
  test: ["接入测试", "服务 / 素材连通性 / 终端拉取链路验证"],
};

let S = null;             // /api/state 的工作区全量数据
let snapshot = null;      // /api/publish 的已发布快照
let view = "dashboard";
let curPl = null;         // 当前编辑的节目单 id
let draft = null;         // 节目单编辑草稿（唯一数据源，DOM 只负责写入）
let mediaFilter = "all";
let mediaQuery = "";
let screenFilter = "active"; // 屏位列表：active = 仅当前地图 / all = 全部
let pv = null;            // 预览状态

/* ---------------- 基础工具 ---------------- */
async function api(path, { method = "GET", body } = {}) {
  const r = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
function toast(msg, kind = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $("#toast-root").appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
function openModal(html, onMount, wide = false) {
  const root = $("#modal-root");
  root.innerHTML = `<div class="overlay"><div class="card modal ${wide ? "wide" : ""}">${html}</div></div>`;
  const ov = $(".overlay", root);
  ov.addEventListener("click", (e) => { if (e.target === ov) closeModal(); });
  if (onMount) onMount(root);
}
function closeModal() {
  if (pv) {
    if (pv.timer) clearInterval(pv.timer);
    if (pv.loadTimer) clearTimeout(pv.loadTimer);
    if (pv.hls) { try { pv.hls.destroy(); } catch {} }
  }
  pv = null;
  $("#modal-root").innerHTML = "";
}
function gameUrl() {
  let base = "http://127.0.0.1:5173/";
  try { base = localStorage.getItem("ws_game_url") || base; } catch {}
  const admin = S ? S.endpoint : `http://${location.host}`;
  return base + (base.includes("?") ? "&" : "?") + "admin=" + encodeURIComponent(admin);
}
function typeTag(t) {
  const cls = t === "image" ? "img" : t === "video" ? "vid" : t === "stream" ? "live" : "";
  return `<span class="tag ${cls}">${esc(TYPES[t]?.label || t)}</span>`;
}
const plName = (id) => (S?.playlists || []).find((p) => p.id === id)?.name || "未绑定";
const opts = (obj, cur) => Object.entries(obj).map(([k, v]) => `<option value="${esc(k)}" ${k === cur ? "selected" : ""}>${esc(v)}</option>`).join("");
const mediaDatalist = () => `<datalist id="media-urls">${(S?.media || []).map((m) => `<option value="${esc(m.url)}"></option>`).join("")}</datalist>`;

/** 当前地图里真实存在的屏位（手动占位屏位始终显示） */
function visibleScreens() {
  const all = S?.screens || [];
  const active = S?.activeMap?.mapId;
  if (screenFilter === "all" || !active) return all;
  return all.filter((s) => !s.reported || s.mapId === active);
}

/** 游戏端新上报、但还没进入已发布快照的屏位：演示时最容易漏的一步 */
function freshScreens() {
  const pub = snapshot?.screens || {};
  const active = S?.activeMap?.mapId;
  return (S?.screens || []).filter((s) => s.reported && !pub[s.id] && (!active || s.mapId === active));
}
function freshBanner() {
  const n = freshScreens().length;
  if (!n) return "";
  return `<section class="card" style="margin-bottom:16px;border-color:rgba(255,210,63,.4);background:rgba(255,210,63,.06)">
    <div class="row"><b style="color:var(--warn)">⚠ ${n} 块游戏端新上报屏位尚未发布</b><div class="spacer"></div>
      <button class="btn primary" data-fresh-publish>发布并使新屏位生效</button></div>
    <p class="desc" style="margin:8px 0 0">游戏端启动 / 切换地图会自动上报屏位并绑定演示节目单；再发布一次，这些屏位就会在 5 秒内显示后台内容。</p>
  </section>`;
}
function bindFresh() { $$("[data-fresh-publish]").forEach((b) => b.onclick = doPublish); }

/* ---------------- 框架渲染 ---------------- */
function renderChrome() {
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  const [title, sub] = VIEW_META[view];
  $("#page-title").textContent = title;
  $("#page-sub").textContent = sub;
  const chip = $("#pending-chip");
  chip.textContent = S.pending ? "● 有未发布变更" : "✓ 已发布";
  chip.className = "chip " + (S.pending ? "warn" : "ok");
  $("#svc-dot").className = "dot on";
  $("#svc-text").textContent = "后台服务在线";
  $("#side-ack").textContent = "v" + (S.ack?.version ?? 0);
  $("#side-ver").textContent = S.published?.version ?? 0;
}
async function refresh() {
  S = await api("/api/state");
  snapshot = await api("/api/publish");
  renderChrome();
  renderView();
}
async function refreshStatus() {
  try {
    S = await api("/api/state");
    snapshot = await api("/api/publish");
    renderChrome();
  } catch {
    $("#svc-dot").className = "dot off";
    $("#svc-text").textContent = "后台服务不可达";
  }
}
function renderView() {
  if (!S) return;
  const fn = { dashboard: viewDashboard, media: viewMedia, playlists: viewPlaylists, screens: viewScreens, publish: viewPublish, test: viewTest }[view];
  fn();
  bindFresh();
}

/* ---------------- 概览 ---------------- */
function viewDashboard() {
  const reported = S.screens.filter((s) => s.reported).length;
  const active = S.activeMap;
  const currentCount = active ? S.screens.filter((s) => s.reported && s.mapId === active.mapId).length : 0;
  const liveCount = Object.keys(snapshot.screens || {}).length;
  const overview = visibleScreens();
  $("#view").innerHTML = `
    <section class="grid stats">
      <div class="card stat"><i class="bar"></i><div class="label">素材库</div><div class="value">${S.media.length}</div><div class="hint">图片 / 视频 / 直播流</div></div>
      <div class="card stat"><i class="bar"></i><div class="label">节目单</div><div class="value">${S.playlists.length}</div><div class="hint">默认 / 视频 / 直播 三套演示模板</div></div>
      <div class="card stat"><i class="bar"></i><div class="label">当前地图屏位</div><div class="value">${currentCount}</div><div class="hint">${active ? esc(active.mapName) : "等待游戏端接入"} · 共 ${reported} 条上报记录</div></div>
      <div class="card stat"><i class="bar"></i><div class="label">已发布版本</div><div class="value">v${S.published.version}</div><div class="hint">快照覆盖 ${liveCount} 块屏</div></div>
    </section>
    ${freshBanner()}
    <section class="grid two">
      <div class="card">
        <h2>发布状态 <span class="sub">终端按版本拉取，未发布的修改不会生效</span></h2>
        <div class="kv"><span>当前版本</span><b>v${S.published.version}</b></div>
        <div class="kv"><span>发布时间</span><b>${fmt(S.published.publishedAt)}</b></div>
        <div class="kv"><span>工作区状态</span><b style="color:${S.pending ? "var(--warn)" : "var(--ok)"}">${S.pending ? "有未发布变更" : "与已发布版本一致"}</b></div>
        <div class="kv"><span>终端已确认</span><b>v${S.ack?.version ?? 0} · ${fmt(S.ack?.at)}</b></div>
        <div class="row" style="margin-top:16px">
          <button id="dash-publish" class="btn primary">⇧ 发布当前工作区</button>
          <button id="dash-to-publish" class="btn ghost">查看发布页</button>
        </div>
        <p class="desc" style="margin:12px 0 0">发布后游戏端会在 5 秒内自动热更新屏面内容，无需重建世界或刷新页面。</p>
      </div>
      <div class="card">
        <h2>演示流程 <span class="sub">从配置到游戏内生效</span></h2>
        <ol class="steps">
          <li><b>启动两个服务</b>后台 <span class="mono">node server.js</span>；游戏 <span class="mono">npm run dev</span></li>
          <li><b>编辑节目单</b>选素材、设显示模式（自适应 / 铺满 / 拉伸）、过渡与音频</li>
          <li><b>绑定屏位并发布</b>游戏端启动时会把屏位自动上报到这里</li>
          <li><b>打开游戏验证</b>点右上角「打开游戏」，图片 / 视频 / 直播直接上屏</li>
        </ol>
        <div class="row" style="margin-top:16px">
          <button id="dash-game" class="btn">▶ 打开游戏（自动接入后台）</button>
          <button id="dash-test" class="btn ghost">接入内容测试</button>
        </div>
      </div>
    </section>
    <section class="card">
      <h2>屏位概览 <span class="sub">${overview.length} 块${active ? " · " + esc(active.mapName) : ""}</span></h2>
      <table class="tbl"><thead><tr><th>屏位</th><th>承载形式</th><th>尺寸</th><th>来源</th><th>绑定节目单</th><th>最近上报</th></tr></thead><tbody>
        ${overview.slice(0, 10).map((s) => `<tr>
          <td><b>${esc(s.name)}</b><div class="mono muted">${esc(short(s.id, 28))}</div></td>
          <td>${esc(MOUNTS[s.mount] || s.mount)}</td>
          <td class="mono">${s.w} × ${s.h}</td>
          <td>${s.reported ? '<span class="tag img">游戏端上报</span>' : '<span class="tag">手动占位</span>'}<div class="muted small">${esc(s.mapName || "-")}</div></td>
          <td>${esc(plName(s.playlistId))}</td>
          <td class="muted small">${fmt(s.lastSeen)}</td>
        </tr>`).join("") || '<tr><td colspan="6" class="empty">暂无屏位</td></tr>'}
      </tbody></table>
      ${overview.length > 10 ? `<p class="desc" style="margin:12px 0 0">仅显示前 10 块，完整列表见「屏位绑定」。</p>` : ""}
    </section>`;
  $("#dash-publish").onclick = doPublish;
  $("#dash-to-publish").onclick = () => go("publish");
  $("#dash-game").onclick = () => window.open(gameUrl(), "_blank");
  $("#dash-test").onclick = () => go("test");
}
async function doPublish() {
  try {
    const r = await api("/api/publish", { method: "POST", body: {} });
    toast(`已发布 v${r.version}，覆盖 ${Object.keys(r.screens).length} 块屏`);
    await refresh();
  } catch (e) { toast("发布失败：" + e.message, "err"); }
}

/* ---------------- 素材库 ---------------- */
function mediaThumb(m) {
  if (m.type === "image") return `<img src="${esc(m.url)}" alt="" loading="lazy">`;
  if (m.type === "video") return `<video src="${esc(m.url)}" muted loop autoplay playsinline preload="metadata"></video>`;
  if (m.type === "model3d") return `<div class="ph" style="font-size:13px;text-align:center;line-height:1.9;color:#37e6d5">✦ 3D<br><small>裸眼模型 · 离轴投影</small></div>`;
  return `<div class="ph" style="font-size:13px;text-align:center;line-height:1.9;color:#8fd8e8">● LIVE<br><small>点下方「预览」查看画面</small></div>`;
}
function viewMedia() {
  $("#view").innerHTML = `
    <section class="card" style="margin-bottom:16px">
      <div class="row">
        <h2 style="margin:0">素材库 <span class="sub">${S.media.length} 项</span></h2>
        <div class="spacer"></div>
        <select id="m-filter" class="inp" style="width:140px">
          <option value="all">全部类型</option>
          <option value="image">图片</option><option value="video">视频</option><option value="stream">直播流</option><option value="model3d">3D裸眼模型</option>
        </select>
        <input id="m-search" class="inp" placeholder="搜索名称或地址" style="width:220px" />
        <button id="m-add" class="btn primary">＋ 新增素材</button>
      </div>
      <p class="desc" style="margin:10px 0 0">本地上传的文件会落到 <span class="mono">data/media/</span> 并以 <span class="mono">/media/xxx</span> 提供（支持 Range，视频可拖动）。外链素材可用「探测」验证连通性。</p>
    </section>
    <div class="media-grid">
      ${S.media.map((m) => `<div class="card media-card" data-id="${esc(m.id)}" data-type="${esc(m.type)}" data-text="${esc((m.name + " " + m.url).toLowerCase())}">
        <div class="media-thumb">${mediaThumb(m)}<span class="badge">${typeTag(m.type)}</span></div>
        <div class="media-body">
          <b>${esc(m.name)}</b>
          <div class="url mono" title="${esc(m.url)}">${esc(m.url)}</div>
          <div class="media-actions">
            <button class="btn sm" data-act="probe">探测</button>
            <button class="btn sm" data-act="use">插入节目单</button>
            <button class="btn sm" data-act="preview">预览</button>
            <button class="btn sm danger" data-act="del">删除</button>
          </div>
          <div class="probe-result small muted" style="margin-top:8px"></div>
        </div>
      </div>`).join("") || '<div class="card empty">素材库为空，点「新增素材」开始</div>'}
    </div>`;
  $("#m-filter").value = mediaFilter;
  $("#m-search").value = mediaQuery;
  const applyFilter = () => $$(".media-card").forEach((c) => {
    const okType = mediaFilter === "all" || c.dataset.type === mediaFilter;
    const okText = !mediaQuery || c.dataset.text.includes(mediaQuery.toLowerCase());
    c.style.display = okType && okText ? "" : "none";
  });
  $("#m-filter").onchange = (e) => { mediaFilter = e.target.value; applyFilter(); };
  $("#m-search").oninput = (e) => { mediaQuery = e.target.value; applyFilter(); };
  $("#m-add").onclick = openMediaForm;
  $$(".media-card").forEach((card) => {
    const m = S.media.find((x) => x.id === card.dataset.id);
    $$("[data-act]", card).forEach((btn) => {
      btn.onclick = async () => {
        const act = btn.dataset.act;
        if (act === "probe") {
          const out = $(".probe-result", card);
          out.textContent = "探测中…";
          try {
            const r = await api("/api/probe", { method: "POST", body: { url: m.url } });
            out.innerHTML = `<span style="color:${r.ok ? "var(--ok)" : "var(--danger)"}">${r.ok ? "✓" : "✕"} ${esc(r.note)}${r.contentType ? " · " + esc(r.contentType) : ""}</span>`;
          } catch (e) { out.textContent = "探测失败：" + e.message; }
        } else if (act === "preview") {
          openPreview({ name: m.name, items: [{ type: m.type, url: m.url, fit: "contain", duration: 20 }] });
        } else if (act === "use") {
          openUseMedia(m);
        } else if (act === "del") {
          if (!confirm(`删除素材「${m.name}」？引用它的节目单不会自动更新。`)) return;
          await api(`/api/media/${encodeURIComponent(m.id)}`, { method: "DELETE" });
          toast("素材已删除"); await refresh();
        }
      };
    });
  });
}
function readDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error("文件读取失败"));
    r.readAsDataURL(file);
  });
}
function openMediaForm() {
  openModal(`
    <div class="modal-head"><h3>新增素材</h3><button class="btn sm" data-x>✕</button></div>
    <div class="form-grid">
      <label class="field"><span>素材名称</span><input id="f-name" class="inp" placeholder="例如：秋季新品主视觉" /></label>
      <label class="field"><span>类型</span><select id="f-type" class="inp">${opts({ image: "图片", video: "视频", stream: "直播流", model3d: "3D裸眼模型" }, "image")}</select></label>
      <label class="field full"><span>外链 URL（http(s)、/media/ 本地素材；3D裸眼模型填 builtin://demo1 / demo2 或 GLB 地址）</span><input id="f-url" class="inp" placeholder="https://.../ad.png 或 builtin://demo1 / demo2" /></label>
      <label class="field full"><span>或上传本地文件（图片 / mp4 / webm，≤32MB）</span><input id="f-file" type="file" class="inp" accept="image/*,video/mp4,video/webm" /></label>
    </div>
    <p class="desc" style="margin:12px 0 0">上传优先于 URL。视频与直播建议同时准备一张备用海报，节目单里可配置「备用海报」实现失败降级。</p>
    <div class="modal-foot"><button class="btn" data-x>取消</button><button id="f-save" class="btn primary">保存素材</button></div>
  `, (root) => {
    $$("[data-x]", root).forEach((b) => b.onclick = closeModal);
    $("#f-save", root).onclick = async () => {
      const btn = $("#f-save", root); btn.disabled = true; btn.textContent = "保存中…";
      try {
        const file = $("#f-file", root).files[0];
        const dataUrl = file ? await readDataUrl(file) : null;
        const name = $("#f-name", root).value.trim() || (file ? file.name.replace(/\.[^.]+$/, "") : "未命名素材");
        await api("/api/media", { method: "POST", body: {
          name, type: $("#f-type", root).value,
          url: $("#f-url", root).value.trim(), dataUrl,
        } });
        closeModal(); toast("素材已加入素材库"); await refresh();
      } catch (e) { btn.disabled = false; btn.textContent = "保存素材"; toast("保存失败：" + e.message, "err"); }
    };
  });
}
function openUseMedia(m) {
  const type = m.type === "stream" || m.type === "model3d" ? m.type : m.type === "video" ? "video" : "image";
  openModal(`
    <div class="modal-head"><h3>插入节目单</h3><button class="btn sm" data-x>✕</button></div>
    <p class="desc">把「${esc(m.name)}」作为一条 ${typeTag(type)} 内容追加到节目单，追加后仍需「发布」才会上屏。</p>
    <div class="form-grid">
      <label class="field full"><span>目标节目单</span><select id="u-pl" class="inp">${S.playlists.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select></label>
      <label class="field"><span>显示模式</span><select id="u-fit" class="inp">${opts(FITS, "auto")}</select></label>
      <label class="field"><span>时长（秒）</span><input id="u-dur" class="inp" type="number" min="2" max="300" value="10" /></label>
      <label class="field full"><span>备用海报 URL（视频/直播失败时显示，可留空）</span><input id="u-fb" class="inp" value="${type === "image" ? "" : "/media/demo-ad-2.svg"}" /></label>
    </div>
    <div class="modal-foot"><button class="btn" data-x>取消</button><button id="u-save" class="btn primary">追加并保存</button></div>
  `, (root) => {
    $$("[data-x]", root).forEach((b) => b.onclick = closeModal);
    $("#u-save", root).onclick = async () => {
      const pl = S.playlists.find((p) => p.id === $("#u-pl", root).value);
      if (!pl) return toast("请选择节目单", "err");
      const next = clone(pl);
      if (type === "model3d") {
        next.items.push({ type, url: m.url, depth: 2.5, duration: Number($("#u-dur", root).value) || 16 });
      } else {
        next.items.push({ type, url: m.url, fallback: $("#u-fb", root).value.trim(), fit: $("#u-fit", root).value, duration: Number($("#u-dur", root).value) || 10 });
      }
      try { await api("/api/playlists", { method: "POST", body: next }); closeModal(); toast("已追加到「" + pl.name + "」，记得发布"); await refresh(); }
      catch (e) { toast("保存失败：" + e.message, "err"); }
    };
  });
}

/* ---------------- 节目单 ---------------- */
function ensureDraft() {
  const pl = S.playlists.find((p) => p.id === curPl) || S.playlists[0] || null;
  curPl = pl ? pl.id : null;
  if (!draft || draft.id !== curPl) draft = pl ? clone(pl) : null;
}
function itemRow(it, i, total) {
  const f = (field, val, cls = "") => `data-i="${i}" data-f="${field}" class="inp mini ${cls}"`;
  const dur = `<input type="number" min="2" max="300" ${f("duration", it.duration)} value="${esc(it.duration ?? 9)}" />`;
  let fields = "";
  if (it.type === "text") {
    fields = `<label class="field full"><span>字幕内容</span><textarea ${f("text")} rows="2">${esc(it.text || "")}</textarea></label>`;
  } else if (it.type === "clock") {
    fields = `<label class="field"><span>右下角备注（天气等）</span><input ${f("note")} value="${esc(it.note || "")}" /></label>`;
  } else if (it.type === "ad") {
    fields = `<label class="field"><span>广告随机种子</span><input type="number" ${f("seed")} value="${esc(it.seed ?? 1)}" /></label>`;
  } else if (it.type === "model3d") {
    fields = `
      <label class="field full"><span>模型地址 GLB URL（builtin://demo1 = 3D 演示1 · builtin://demo2 = 3D 演示2 · 留空 = 演示1）</span><input ${f("url")} list="media-urls" value="${esc(it.url || "")}" placeholder="builtin://demo1 / builtin://demo2 / https://...glb" /></label>
      <label class="field"><span>出屏深度（米）</span><input type="number" min="0" max="10" step="0.5" ${f("depth")} value="${esc(it.depth ?? 2.5)}" /></label>`;
  } else {
    fields = `
      <label class="field full"><span>内容 URL（可从素材库复制）</span><input ${f("url")} list="media-urls" value="${esc(it.url || "")}" placeholder="https://... 或 /media/..." /></label>
      <label class="field"><span>显示模式</span><select ${f("fit")}>${opts(FITS, it.fit || "auto")}</select></label>
      <label class="field"><span>备用海报 URL（失败降级）</span><input ${f("fallback")} list="media-urls" value="${esc(it.fallback || "")}" placeholder="可留空" /></label>`;
  }
  return `<div class="pl-row">
    <div class="pl-row-head">
      <span class="idx">#${i + 1}</span>
      <select class="inp mini" data-i="${i}" data-f="type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${k === it.type ? "selected" : ""}>${esc(v.label)}</option>`).join("")}</select>
      <span class="small muted">时长</span>${dur}<span class="small muted">秒</span>
      <div class="spacer"></div>
      <button class="btn sm" data-act="up" data-i="${i}" ${i === 0 ? "disabled" : ""}>↑</button>
      <button class="btn sm" data-act="down" data-i="${i}" ${i === total - 1 ? "disabled" : ""}>↓</button>
      <button class="btn sm" data-act="dup" data-i="${i}">复制</button>
      <button class="btn sm danger" data-act="del" data-i="${i}">删除</button>
    </div>
    <div class="pl-fields">${fields}<div class="full small muted">${esc(TYPES[it.type]?.hint || "")}</div></div>
  </div>`;
}
function viewPlaylists() {
  ensureDraft();
  $("#view").innerHTML = `
    <div class="pl-layout">
      <div class="card">
        <div class="row"><h2 style="margin:0">节目单</h2><div class="spacer"></div><button id="pl-new" class="btn sm primary">＋ 新建</button></div>
        <div class="pl-list">
          ${S.playlists.map((p) => `<button class="pl-item ${p.id === curPl ? "active" : ""}" data-pl="${esc(p.id)}">
            <b>${esc(p.name)}</b><small>${p.items.length} 项 · ${p.items.reduce((a, b) => a + (Number(b.duration) || 0), 0)} 秒一轮</small>
          </button>`).join("") || '<div class="empty">还没有节目单</div>'}
        </div>
        <div class="hr"></div>
        <p class="desc" style="margin:0">节目单是「轮播序列」：每项按设定时长依次上屏，最后一项后回到第一项。相同节目单的多块屏在游戏端共享同一份纹理 / 视频资源。</p>
      </div>
      <div class="card">
        ${draft ? `
          <div class="row"><h2 style="margin:0">编辑：${esc(draft.name)}</h2><div class="spacer"></div>
            <button id="pl-preview" class="btn sm">▶ 预览</button>
            <button id="pl-del" class="btn sm danger">删除</button>
          </div>
          <div class="form-grid" style="margin-top:14px">
            <label class="field"><span>节目单名称</span><input class="inp" data-k="name" value="${esc(draft.name)}" /></label>
            <label class="field"><span>默认显示模式（图片 / 视频 / 直播）</span><select class="inp" data-k="fit">${opts(FITS, draft.fit)}</select></label>
            <label class="field"><span>切换过渡（秒，0 = 硬切）</span><input class="inp" type="number" min="0" max="2" step="0.1" data-k="transition" value="${esc(draft.transition ?? 0)}" /></label>
            <label class="field"><span>音频策略</span><select class="inp" data-k="audio">${opts(AUDIOS, draft.audio)}</select></label>
          </div>
          ${mediaDatalist()}
          <div class="hr"></div>
          <div class="row"><b style="font-size:13px">轮播内容（${draft.items.length} 项）</b><div class="spacer"></div><span class="small muted">拖动不可用，用 ↑ ↓ 调整顺序</span></div>
          <div class="pl-rows">${draft.items.map((it, i) => itemRow(it, i, draft.items.length)).join("") || '<div class="empty">还没有内容，从下方添加</div>'}</div>
          <div class="addbar">
            <select id="add-type" class="inp" style="width:150px">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join("")}</select>
            <button id="add-item" class="btn">＋ 添加内容</button>
            <span class="muted small">或</span>
            <select id="add-media" class="inp" style="width:190px">${S.media.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("")}</select>
            <button id="add-from-media" class="btn">＋ 从素材库添加</button>
          </div>
          <div class="hr"></div>
          <div class="row end"><span class="small muted">保存后只是修改工作区，需到「发布」页发布才会在游戏端生效</span><div class="spacer"></div><button id="pl-save" class="btn primary">保存节目单</button></div>
        ` : '<div class="empty">新建或选择一个节目单开始编辑</div>'}
      </div>
    </div>`;
  $$("[data-pl]").forEach((b) => b.onclick = () => { curPl = b.dataset.pl; draft = null; viewPlaylists(); });
  $("#pl-new").onclick = () => openModal(`
    <div class="modal-head"><h3>新建节目单</h3><button class="btn sm" data-x>✕</button></div>
    <label class="field"><span>名称</span><input id="n-name" class="inp" placeholder="例如：周末活动轮播" /></label>
    <div class="modal-foot"><button class="btn" data-x>取消</button><button id="n-save" class="btn primary">创建</button></div>
  `, (root) => {
    $$("[data-x]", root).forEach((b) => b.onclick = closeModal);
    $("#n-save", root).onclick = async () => {
      const r = await api("/api/playlists", { method: "POST", body: {
        name: $("#n-name", root).value.trim() || "新节目单", fit: "auto", transition: 0.6, audio: "off",
        items: [{ type: "ad", duration: 9, seed: 1 }, { type: "clock", duration: 8, note: "晴 24°C" }],
      } });
      closeModal(); curPl = r.id; draft = null; toast("节目单已创建"); await refresh();
    };
  });
  if (!draft) return;
  $$("[data-k]").forEach((el) => el.oninput = () => {
    draft[el.dataset.k] = el.dataset.k === "transition" ? Number(el.value) : el.value;
  });
  $$("[data-i][data-f]").forEach((el) => {
    const handler = () => {
      const i = Number(el.dataset.i), f = el.dataset.f;
      let v = el.value;
      if (f === "duration" || f === "seed") v = Number(v);
      draft.items[i][f] = v;
      if (f === "type") {
        const def = { type: v, duration: draft.items[i].duration || 9 };
        if (v === "text") def.text = "潮汇坊 · 中央大道商圈 今日营业至 22:00   ◆   新品上市 全场 8 折起   ◆   ";
        if (v === "clock") def.note = "晴 24°C";
        if (v === "ad") def.seed = 1;
        if (TYPES[v]?.media) { def.url = ""; def.fallback = ""; def.fit = draft.fit || "auto"; }
        draft.items[i] = def;
        viewPlaylists();
      }
    };
    el.addEventListener(el.tagName === "SELECT" ? "change" : "input", handler);
  });
  $$("[data-act]").forEach((b) => b.onclick = () => {
    const i = Number(b.dataset.i), a = b.dataset.act, arr = draft.items;
    if (a === "up" && i > 0) [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
    else if (a === "down" && i < arr.length - 1) [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]];
    else if (a === "dup") arr.splice(i + 1, 0, clone(arr[i]));
    else if (a === "del") { if (arr.length === 1) return toast("至少保留一项", "err"); arr.splice(i, 1); }
    viewPlaylists();
  });
  $("#add-item").onclick = () => {
    const t = $("#add-type").value;
    const it = { type: t, duration: 9 };
    if (t === "text") it.text = "潮汇坊 · 中央大道商圈 今日营业至 22:00   ◆   ";
    if (t === "clock") it.note = "晴 24°C";
    if (t === "ad") it.seed = Math.floor(Math.random() * 10) + 1;
    if (t === "model3d") { it.url = "builtin://demo1"; it.depth = 2.5; it.duration = 16; }
    else if (TYPES[t].media) { it.url = ""; it.fallback = ""; it.fit = draft.fit || "auto"; }
    draft.items.push(it); viewPlaylists();
  };
  $("#add-from-media").onclick = () => {
    const m = S.media.find((x) => x.id === $("#add-media").value);
    if (!m) return;
    if (m.type === "model3d") {
      draft.items.push({ type: "model3d", url: m.url, depth: 2.5, duration: 16 });
    } else {
      draft.items.push({ type: m.type, url: m.url, fallback: m.type === "image" ? "" : "/media/demo-ad-2.svg", fit: draft.fit || "auto", duration: 10 });
    }
    viewPlaylists();
  };
  $("#pl-save").onclick = async () => {
    try {
      const r = await api("/api/playlists", { method: "POST", body: draft });
      draft = clone(r); curPl = r.id; toast("节目单已保存（未发布）"); await refresh();
    } catch (e) { toast("保存失败：" + e.message, "err"); }
  };
  $("#pl-del").onclick = async () => {
    if (!confirm(`删除节目单「${draft.name}」？绑定它的屏位会变为未绑定。`)) return;
    await api(`/api/playlists/${encodeURIComponent(draft.id)}`, { method: "DELETE" });
    curPl = null; draft = null; toast("节目单已删除"); await refresh();
  };
  $("#pl-preview").onclick = () => openPreview(draft);
}

/* ---------------- 屏位绑定 ---------------- */
/* 转角包柱屏的两个面（id 带 ::A / ::B 后缀）来自同一根立柱（同一个 map.object），
   渲染时按基础 ID 归组：高亮分组头 + 左侧色条把两行连成一块，一眼看出「这是一块包柱屏」。 */
const FACE_RE = /^(.*)::([A-Z])$/;

function screenRowsHtml(list) {
  const groups = new Map();
  for (const s of list) {
    const m = s.mount === "corner" ? FACE_RE.exec(s.id) : null;
    if (m) {
      if (!groups.has(m[1])) groups.set(m[1], []);
      groups.get(m[1]).push(s.id);
    }
  }
  const emitted = new Set();
  const rows = [];
  for (const s of list) {
    const m = s.mount === "corner" ? FACE_RE.exec(s.id) : null;
    let head = "", cls = "", badge = "";
    if (m) {
      const g = groups.get(m[1]);
      if (!emitted.has(m[1])) {
        emitted.add(m[1]);
        head = `<tr class="sc-grp"><td colspan="6">◧ 同一块转角包柱屏 · 以下 ${g.length} 行是同一根立柱的两块屏面（基础 ID <span class="mono">${esc(m[1])}</span>），可分别绑定不同节目单</td></tr>`;
      }
      cls = ` class="sc-face${g[0] === s.id ? " sc-first" : ""}${g[g.length - 1] === s.id ? " sc-last" : ""}"`;
      badge = `<span class="tag corner">面 ${m[2]}</span>`;
    }
    rows.push(`${head}<tr${cls} data-sc="${esc(s.id)}">
          <td><input class="inp mini" data-f="name" value="${esc(s.name)}" />
            <div class="mono muted small" style="margin-top:3px">${esc(s.id)}
              <button class="btn sm" data-act="copy" style="padding:1px 6px;font-size:10px;margin-left:4px">复制 ID</button>
              ${badge}
            </div></td>
          <td>${esc(MOUNTS[s.mount] || s.mount)}<div class="mono muted small">${s.w} × ${s.h} m</div></td>
          <td>${esc(s.mapName || "-")}<div class="mono muted small">${s.x !== undefined ? `(${s.x}, ${s.z})` : "—"}</div></td>
          <td>${s.reported ? '<span class="tag img">游戏端上报</span>' : '<span class="tag">手动占位</span>'}<div class="muted small">${fmt(s.lastSeen)}</div></td>
          <td><select class="inp mini" data-f="playlistId"><option value="">未绑定</option>${S.playlists.map((p) => `<option value="${esc(p.id)}" ${p.id === s.playlistId ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></td>
          <td><div class="row" style="gap:4px">
            <button class="btn sm" data-act="preview">预览</button>
            <button class="btn sm" data-act="edit">编辑单</button>
            <button class="btn sm danger" data-act="del">删除</button>
          </div></td>
        </tr>`);
  }
  return rows.join("");
}

function viewScreens() {
  const list = visibleScreens();
  const active = S.activeMap;
  const activeCount = active ? S.screens.filter((s) => s.reported && s.mapId === active.mapId).length : 0;
  const flow = [
    ["① 手动放屏（唯一来源）", "3D 地图编辑器放置广告大屏 → 保存 → 进入游戏；默认街区不会自动生成屏"],
    ["② 登记屏位", "游戏端把该地图已有的屏上报到后台，只是登记，不会在游戏里造屏"],
    ["③ 绑定节目单", "在下面给屏位选节目单，未绑定的屏用地图内自带内容"],
    ["④ 发布生效", "点「发布」生成版本快照，游戏端 5 秒内热更新屏面"],
  ];
  $("#view").innerHTML = `
    ${freshBanner()}
    <section class="card" style="margin-bottom:16px">
      <h2>绑定流程 <span class="sub">屏位由游戏端上报，后台不预置游戏里不存在的屏</span></h2>
      <div class="flow">${flow.map(([t, d]) => `<div><b>${esc(t)}</b>${esc(d)}</div>`).join("")}</div>
      <p class="desc" style="margin:0">${active
        ? `当前在线地图：<b style="color:var(--text)">${esc(active.mapName)}</b> · ${activeCount} 块手动放置的屏 · 最近心跳 ${fmt(active.at)}。切到别的地图时旧屏位自动回收；没放屏的地图不会有任何屏位。`
        : "还没有游戏端接入。世界里的广告屏只来自 3D 地图编辑器手动放置，放好并进入游戏后屏位才会出现在这里。"}</p>
    </section>
    <section class="card" style="margin-bottom:16px">
      <div class="row"><h2 style="margin:0">屏位绑定 <span class="sub">显示 ${list.length} / 共 ${S.screens.length} 块</span></h2><div class="spacer"></div>
        <select id="sc-filter" class="inp mini" style="width:170px">
          <option value="active" ${screenFilter === "active" ? "selected" : ""}>仅当前地图</option>
          <option value="all" ${screenFilter === "all" ? "selected" : ""}>全部屏位</option>
        </select>
        <button id="sc-prune" class="btn sm">清理无效屏位</button>
        <button id="sc-add" class="btn sm">＋ 手动占位屏位</button>
      </div>
      <table class="tbl" style="margin-top:12px"><thead><tr>
        <th style="width:25%">屏位名称 / ID</th><th>承载形式 / 尺寸</th><th>地图 / 坐标</th><th>来源 / 心跳</th><th style="width:23%">绑定节目单</th><th>操作</th>
      </tr></thead><tbody>
        ${screenRowsHtml(list) || '<tr><td colspan="6" class="empty">当前筛选下没有屏位。打开游戏端让它自动上报，或切到「全部屏位」看看。</td></tr>'}
      </tbody></table>
    </section>
    <section class="card">
      <h2>屏位 ID 怎么对应到游戏里那块屏 <span class="sub">核对方法</span></h2>
      <p class="desc">屏位 ID 就是 3D 地图编辑器里那条 <span class="mono">map.objects[].id</span>。世界里只有你手动放置的广告屏，默认街区和空白地图都不会自动生成任何屏。承载形式、尺寸、坐标都来自游戏里那块屏本身。游戏端按 ID 从发布快照里取内容；ID 对不上就回退到地图内自带的「显示内容」或默认节目单 —— 所以给一个不存在的屏位绑节目单，游戏里不会有任何变化。</p>
      <div class="code">// 在游戏页 DevTools 控制台：列出这个世界里真实存在的大屏
window.__game.billboards.screens.map(s => ({
  id: s.id, mount: s.mount, x: s.x, z: s.z,
  content: s.pool.cfg.items.map(i =&gt; i.type)
}))

// 查看终端接入状态 / 已应用屏数
window.__adminSync.status()

// 发布快照（屏位 ID → 内容）
GET ${esc(S.endpoint)}/api/publish   →   v${snapshot.version}，${Object.keys(snapshot.screens || {}).length} 块屏</div>
    </section>`;
  $("#sc-filter").onchange = (e) => { screenFilter = e.target.value; viewScreens(); };
  $("#sc-prune").onclick = async () => {
    if (!confirm("清理手动占位屏位和已离线的旧地图屏位？节目单与发布版本不受影响。")) return;
    const r = await api("/api/screens/prune", { method: "POST", body: {} });
    toast(`已清理 ${r.removed} 块无效屏位，请重新发布`);
    await refresh();
  };
  $("#sc-add").onclick = () => openModal(`
    <div class="modal-head"><h3>手动占位屏位</h3><button class="btn sm" data-x>✕</button></div>
    <p class="desc">仅用于没有游戏端时演练配置流程。它<b>不会出现在游戏里</b>，只有 ID 与游戏端上报一致时才会生效。</p>
    <div class="form-grid">
      <label class="field"><span>屏位 ID（需与游戏端一致，否则无效）</span><input id="s-id" class="inp" placeholder="例如地图 objects[].id" /></label>
      <label class="field"><span>名称</span><input id="s-name" class="inp" placeholder="示例屏位" /></label>
      <label class="field"><span>承载形式</span><select id="s-mount" class="inp">${opts(MOUNTS, "standalone")}</select></label>
      <label class="field"><span>尺寸（宽 × 高，米）</span><div class="row"><input id="s-w" class="inp" type="number" value="14" /><input id="s-h" class="inp" type="number" value="8" /></div></label>
    </div>
    <div class="modal-foot"><button class="btn" data-x>取消</button><button id="s-save" class="btn primary">创建</button></div>
  `, (root) => {
    $$("[data-x]", root).forEach((b) => b.onclick = closeModal);
    $("#s-save", root).onclick = async () => {
      try {
        await api("/api/screens", { method: "POST", body: {
          id: $("#s-id", root).value.trim() || undefined, name: $("#s-name", root).value.trim() || "新屏位",
          mount: $("#s-mount", root).value, w: Number($("#s-w", root).value), h: Number($("#s-h", root).value),
        } });
        closeModal(); toast("占位屏位已创建"); await refresh();
      } catch (e) { toast("创建失败：" + e.message, "err"); }
    };
  });
  $$("[data-sc]").forEach((tr) => {
    const id = tr.dataset.sc;
    const sc = S.screens.find((x) => x.id === id);
    $$("[data-f]", tr).forEach((el) => el.onchange = async () => {
      const body = { [el.dataset.f]: el.value };
      try { await api(`/api/screens/${encodeURIComponent(id)}`, { method: "PUT", body }); refreshStatus(); toast("屏位已更新（未发布）"); }
      catch (e) { toast("保存失败：" + e.message, "err"); }
    });
    $$("[data-act]", tr).forEach((b) => b.onclick = async () => {
      const act = b.dataset.act;
      if (act === "copy") {
        try { await navigator.clipboard.writeText(id); toast("屏位 ID 已复制"); }
        catch { toast("请手动选中 ID 复制", "err"); }
      } else if (act === "preview") {
        const pl = S.playlists.find((p) => p.id === sc.playlistId);
        if (!pl) return toast("该屏位未绑定节目单", "err");
        openPreview(pl);
      } else if (act === "edit") {
        if (!sc.playlistId) return toast("请先绑定节目单", "err");
        curPl = sc.playlistId; draft = null; go("playlists");
      } else if (act === "del") {
        if (!confirm(`删除屏位「${sc.name}」？游戏端下次上报时会重新出现。`)) return;
        await api(`/api/screens/${encodeURIComponent(id)}`, { method: "DELETE" });
        toast("屏位已删除"); await refresh();
      }
    });
  });
}

/* ---------------- 发布 ---------------- */
function viewPublish() {
  const ids = Object.keys(snapshot.screens || {});
  $("#view").innerHTML = `
    ${freshBanner()}
    <section class="grid two">
      <div class="card">
        <h2>发布控制 <span class="sub">冻结工作区 → 生成终端可消费的版本快照</span></h2>
        <div class="kv"><span>工作区状态</span><b style="color:${S.pending ? "var(--warn)" : "var(--ok)"}">${S.pending ? "有未发布变更" : "与已发布版本一致"}</b></div>
        <div class="kv"><span>已发布版本</span><b>v${S.published.version}</b></div>
        <div class="kv"><span>发布时间</span><b>${fmt(S.published.publishedAt)}</b></div>
        <div class="kv"><span>快照屏位</span><b>${ids.length} 块</b></div>
        <div class="kv"><span>终端已确认</span><b>v${S.ack?.version ?? 0} · ${fmt(S.ack?.at)}</b></div>
        <div class="row" style="margin-top:16px">
          <button id="pub-do" class="btn primary">⇧ 发布当前工作区</button>
          <button id="pub-preview" class="btn">查看工作区预览</button>
        </div>
        <p class="desc" style="margin:12px 0 0">发布后版本号 +1。游戏端每 5 秒轮询一次，发现新版本即热更新屏面内容并回传 ACK。</p>
      </div>
      <div class="card">
        <h2>终端接入 <span class="sub">游戏端只需一个地址</span></h2>
        <label class="field"><span>发布接口（游戏端轮询）</span><input class="inp mono" readonly value="${esc(S.endpoint + "/api/publish")}" id="pub-url" /></label>
        <div class="row" style="margin-top:12px">
          <button id="pub-copy" class="btn sm">复制地址</button>
          <button id="pub-game" class="btn sm primary">▶ 打开游戏并自动接入</button>
        </div>
        <div class="hr"></div>
        <p class="desc" style="margin:0 0 8px">游戏端支持三种配置方式（优先级从高到低）：</p>
        <div class="code">① 地址参数（推荐演示）
${esc(gameUrl())}

② 控制台一次性设置
localStorage.setItem("ws_admin_url", "${esc(S.endpoint)}")

③ 默认值
http://127.0.0.1:8787</div>
        <p class="desc" style="margin:10px 0 0">如需关闭接入，地址参数用 <span class="mono">?admin=off</span>。</p>
      </div>
    </section>
    <section class="card">
      <div class="row"><h2 style="margin:0">已发布快照 <span class="sub">v${snapshot.version}</span></h2><div class="spacer"></div><button id="pub-json" class="btn sm">查看 JSON</button></div>
      <table class="tbl" style="margin-top:12px"><thead><tr><th>屏位</th><th>节目单</th><th>内容序列</th><th>显示模式</th><th>过渡 / 音频</th></tr></thead><tbody>
        ${ids.map((id) => {
          const cfg = snapshot.screens[id], sc = S.screens.find((x) => x.id === id);
          return `<tr>
            <td><b>${esc(sc?.name || id)}</b><div class="mono muted small">${esc(short(id, 30))}</div></td>
            <td>${esc(sc ? plName(sc.playlistId) : "—")}</td>
            <td>${cfg.items.map((it) => typeTag(it.type)).join(" ")} <span class="muted small">${cfg.items.length} 项</span></td>
            <td>${esc(FITS[cfg.fit] || cfg.fit)}</td>
            <td class="mono">${cfg.transition}s · ${esc(AUDIOS[cfg.audio] || cfg.audio)}</td>
          </tr>`;
        }).join("") || '<tr><td colspan="5" class="empty">尚未发布。点上方「发布当前工作区」生成第一版快照。</td></tr>'}
      </tbody></table>
    </section>`;
  $("#pub-do").onclick = doPublish;
  $("#pub-preview").onclick = async () => {
    const r = await api("/api/publish/preview");
    openModal(`<div class="modal-head"><h3>工作区发布预览（不会改变版本号）</h3><button class="btn sm" data-x>✕</button></div>
      <div class="code" style="max-height:60vh">${esc(JSON.stringify(r, null, 2))}</div>`, (root) => $$("[data-x]", root).forEach((b) => b.onclick = closeModal), true);
  };
  $("#pub-json").onclick = () => openModal(`<div class="modal-head"><h3>已发布快照 JSON · v${snapshot.version}</h3><button class="btn sm" data-x>✕</button></div>
    <div class="code" style="max-height:60vh">${esc(JSON.stringify(snapshot, null, 2))}</div>`, (root) => $$("[data-x]", root).forEach((b) => b.onclick = closeModal), true);
  $("#pub-copy").onclick = async () => {
    try { await navigator.clipboard.writeText($("#pub-url").value); toast("地址已复制"); }
    catch { toast("请手动复制输入框中的地址", "err"); }
  };
  $("#pub-game").onclick = () => window.open(gameUrl(), "_blank");
}

/* ---------------- 接入测试 ---------------- */
function viewTest() {
  const videos = S.media.filter((m) => m.type !== "image");
  $("#view").innerHTML = `
    <section class="grid two">
      <div class="card">
        <h2>服务与终端链路</h2>
        <p class="desc">按顺序验证：后台在线 → 发布快照 → 终端拉取并 ACK。</p>
        <div class="row"><button id="t-health" class="btn">① 健康检查</button><button id="t-pull" class="btn primary">② 模拟终端拉取并确认</button></div>
        <div id="t-out" class="code" style="margin-top:14px;min-height:96px">点上面的按钮开始测试…</div>
        <div class="hr"></div>
        <div class="kv"><span>后台服务</span><b>${esc(S.endpoint)}</b></div>
        <div class="kv"><span>终端最近确认</span><b>v${S.ack?.version ?? 0} · ${fmt(S.ack?.at)}</b></div>
        <div class="kv"><span>确认来源</span><b>${esc(S.ack?.client || "—")}</b></div>
      </div>
      <div class="card">
        <h2>素材连通性探测</h2>
        <p class="desc">服务端 HEAD / Range GET 探测，绕过浏览器 CORS 限制；视频与直播失败时游戏端会显示备用海报。</p>
        <label class="field"><span>URL</span><input id="t-url" class="inp mono" value="${esc(videos[0]?.url || S.media[0]?.url || "")}" /></label>
        <div class="row" style="margin-top:10px"><button id="t-probe" class="btn primary">探测 URL</button>
          <select id="t-quick" class="inp" style="width:200px"><option value="">从素材库选择…</option>${S.media.map((m) => `<option value="${esc(m.url)}">${esc(m.name)}</option>`).join("")}</select>
        </div>
        <div id="t-probe-out" class="code" style="margin-top:14px;min-height:96px">尚未探测</div>
      </div>
    </section>
    <section class="card" style="margin-bottom:16px">
      <h2>游戏端接入 <span class="sub">一次配置，之后自动热更新</span></h2>
      <div class="code"># 终端 1：启动后台（本服务）
cd admin &amp;&amp; node server.js          # http://127.0.0.1:8787

# 终端 2：启动游戏
cd walkstreet &amp;&amp; npm run dev         # http://127.0.0.1:5173

# 浏览器打开（自动带上后台地址参数）
${esc(gameUrl())}

# 游戏内验证（DevTools 控制台）
window.__adminSync.status()            // 在线状态 / 版本 / 已应用屏数
window.__adminSync.pollNow()           // 立即拉取一次
window.__game.billboards.screens       // 每块屏的 id / contentKey / pool</div>
      <div class="row" style="margin-top:14px"><button id="t-game" class="btn primary">▶ 打开游戏（自动接入）</button><button id="t-reset" class="btn danger">重置演示数据</button></div>
    </section>
    <section class="card">
      <h2>内容类型与显示模式 <span class="sub">后台配置 → 游戏端行为</span></h2>
      <table class="tbl"><thead><tr><th>类型</th><th>游戏端渲染</th><th>显示模式</th><th>失败处理</th></tr></thead><tbody>
        <tr><td>${typeTag("image")}</td><td>CanvasTexture，按屏比生成画布</td><td>自适应 / 完整 / 铺满 / 拉伸</td><td>提示海报（检查地址 / CORS）</td></tr>
        <tr><td>${typeTag("video")}</td><td>VideoTexture 零拷贝快路径 或 rVFC 逐帧绘制</td><td>铺满 / 拉伸走快路径；自适应 / 完整走画布</td><td>切换备用海报</td></tr>
        <tr><td>${typeTag("stream")}</td><td>hls.js 低延迟；Safari 原生 HLS</td><td>同上</td><td>直播中断自动切备用海报</td></tr>
        <tr><td>${typeTag("text")} ${typeTag("clock")} ${typeTag("ad")}</td><td>程序化画布，字号按可用宽度自适应</td><td>始终自动排版，不会裁切</td><td>—</td></tr>
      </tbody></table>
      <p class="desc" style="margin:12px 0 0"><b>演示素材已本地化</b>：<span class="mono">/media/demo-clip.mp4</span> 与 <span class="mono">/media/live/live.m3u8</span>（含 .ts 分片）由后台直接提供，支持 Range 与 CORS，断网也能演示视频与 HLS；素材库另保留两条外链示例，可用「探测」验证连通性。</p>
      <p class="desc" style="margin:8px 0 0">性能策略：全局最多 2 路视频同时解码，按玩家距离排序；离开 300m 的屏暂停轮播与解码。音频默认静音，可选「仅最近一块屏出声 / 全部出声」。</p>
    </section>`;
  const out = (sel, text) => { $(sel).textContent = text; };
  $("#t-health").onclick = async () => {
    try { const r = await api("/api/health"); out("#t-out", "健康检查 OK\n" + JSON.stringify(r, null, 2)); toast("后台服务在线"); }
    catch (e) { out("#t-out", "健康检查失败：" + e.message); }
  };
  $("#t-pull").onclick = async () => {
    try {
      const pub = await api("/api/publish");
      const types = {};
      for (const cfg of Object.values(pub.screens || {})) for (const it of cfg.items || []) types[it.type] = (types[it.type] || 0) + 1;
      const ack = await api("/api/ack", { method: "POST", body: { version: pub.version, screens: Object.keys(pub.screens || {}).length, client: "admin-simulator", mapName: "接入测试" } });
      out("#t-out", `模拟终端拉取成功\n版本      : v${pub.version}\n发布时间  : ${fmt(pub.publishedAt)}\n屏位数量  : ${Object.keys(pub.screens || {}).length}\n内容统计  : ${JSON.stringify(types)}\nACK       : ${JSON.stringify(ack)}`);
      toast("模拟终端已完成拉取与 ACK"); refreshStatus();
    } catch (e) { out("#t-out", "拉取失败：" + e.message); toast("拉取失败", "err"); }
  };
  const probe = async (url) => {
    if (!url) return;
    out("#t-probe-out", "探测中… " + url);
    try {
      const r = await api("/api/probe", { method: "POST", body: { url } });
      out("#t-probe-out", `${r.ok ? "✓ 可访问" : "✕ 不可达"}\nURL        : ${url}\nHTTP       : ${r.status ?? "—"}\nContent-Type: ${r.contentType || "—"}\n说明       : ${r.note}`);
    } catch (e) { out("#t-probe-out", "探测失败：" + e.message); }
  };
  $("#t-probe").onclick = () => probe($("#t-url").value.trim());
  $("#t-quick").onchange = (e) => { if (e.target.value) { $("#t-url").value = e.target.value; probe(e.target.value); } };
  $("#t-game").onclick = () => window.open(gameUrl(), "_blank");
  $("#t-reset").onclick = async () => {
    if (!confirm("重置演示数据？所有素材、节目单、屏位绑定与发布版本都会恢复默认。")) return;
    await api("/api/demo/reset", { method: "POST", body: {} });
    toast("演示数据已重置"); curPl = null; draft = null; await refresh();
  };
}

/* ---------------- 内容预览（不依赖游戏端） ---------------- */
function pvFallback(it, msg) {
  const fit = it.fit === "cover" ? "fit-cover" : it.fit === "stretch" ? "fit-fill" : "fit-contain";
  if (it.fallback) return `<img class="${fit}" src="${esc(it.fallback)}" alt=""><div class="pv-fallback">${esc(msg)} · 已显示备用海报</div>`;
  return `<div class="pv-canvas" style="background:#0b1018;color:#8fd8e8">${esc(msg)}<div class="small muted" style="margin-top:8px">配置「备用海报」可实现失败降级</div></div>`;
}
/** 预览降级：显示备用海报 + 明确的状态文案，不再是一片黑 */
function pvFail(it, msg) {
  if (!pv || !$("#pv-screen")) return;
  pv.failed = true;
  $("#pv-screen").innerHTML = pvFallback(it, msg) + `<div class="pv-status err" id="pv-status">⚠ ${esc(msg)}</div>`;
}

/** 预览里的 HLS：Chrome/Edge 必须用 hls.js；只有 Safari 走原生。
 *  本地 /vendor/hls.mjs 是随后台一起提供的离线构建，演示不依赖 CDN。 */
function pvAttachHls(v, url, it) {
  const ua = navigator.userAgent || "";
  const safariNative = /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|Edg|Android/i.test(ua);
  if (safariNative && v.canPlayType("application/vnd.apple.mpegurl")) {
    v.src = url;
    v.play().catch(() => {});
    return;
  }
  import("/vendor/hls.mjs").then(({ default: Hls }) => {
    if (!pv || !document.contains(v)) return;
    if (!Hls.isSupported()) return pvFail(it, "当前浏览器不支持 HLS 播放");
    const hls = new Hls({ lowLatencyMode: true, liveSyncDurationCount: 2, backBufferLength: 30 });
    pv.hls = hls;
    hls.loadSource(url);
    hls.attachMedia(v);
    hls.on(Hls.Events.MANIFEST_PARSED, () => v.play().catch(() => {}));
    hls.on(Hls.Events.ERROR, (_e, d) => { if (d && d.fatal) pvFail(it, "直播流中断 · 已切换备用内容"); });
  }).catch(() => pvFail(it, "hls.js 加载失败 · 已切换备用内容"));
  pv.loadTimer = setTimeout(() => {
    if (pv && !pv.failed && v.readyState < 2) pvFail(it, "媒体加载超时 · 已切换备用内容");
  }, 10000);
}

function updatePvStatus() {
  if (!pv) return;
  const el = $("#pv-status");
  if (!el) return;
  const it = pv.items[pv.i];
  if (pv.failed) return; // pvFail 已写入状态
  const v = $("#pv-screen video");
  if (!v) { el.textContent = TYPES[it.type]?.label || it.type; el.className = "pv-status"; return; }
  if (v.readyState >= 2 && !v.paused && v.currentTime > 0) {
    el.textContent = `▶ 播放中 ${v.currentTime.toFixed(1)}s${it.type === "stream" ? " · HLS / hls.js" : ""}`;
    el.className = "pv-status ok";
  } else if (v.readyState >= 2) {
    el.textContent = "⏸ 已缓冲，等待播放";
    el.className = "pv-status";
  } else {
    el.textContent = "◌ 媒体加载中…";
    el.className = "pv-status";
  }
}

function renderPvFrame() {
  if (!pv || !$("#pv-screen")) return;
  // 切换条目时销毁上一路 HLS，避免后台继续解码
  if (pv.hls) { try { pv.hls.destroy(); } catch {} pv.hls = null; }
  if (pv.loadTimer) { clearTimeout(pv.loadTimer); pv.loadTimer = null; }
  pv.failed = false;
  const it = pv.items[pv.i];
  const el = $("#pv-screen");
  const fit = it.fit === "cover" ? "fit-cover" : it.fit === "stretch" ? "fit-fill" : "fit-contain";
  let html = "";
  if (it.type === "image") {
    html = `<img class="${fit}" src="${esc(it.url)}" alt="">`;
  } else if (it.type === "video" || it.type === "stream") {
    if (it.url) {
      const src = it.type === "video" ? `src="${esc(it.url)}"` : "";
      html = `<video class="${fit}" ${src} autoplay muted loop playsinline></video>
        <div class="pv-loading" id="pv-loading">${it.type === "stream" ? "直播流连接中…" : "视频加载中…"}</div>` +
        (it.type === "stream" ? '<div class="pv-live">● LIVE</div>' : "");
    } else html = pvFallback(it, "未设置媒体地址");
  } else if (it.type === "text") {
    html = `<div class="pv-canvas" style="background:#0c1018;display:block;padding-top:14%">
      <div style="color:#fff;font-size:20px;font-weight:800">TIDE HUB 潮汇坊</div>
      <div class="pv-ticker" style="margin-top:20px"><span>${esc(it.text || "")}</span></div></div>`;
  } else if (it.type === "clock") {
    html = `<div class="pv-canvas" style="background:linear-gradient(180deg,#132a4a,#101828);display:block;padding-top:12%">
      <div class="pv-clock" id="pv-clock-time">--:--</div><div class="pv-note">${esc(it.note || "")}</div></div>`;
  } else if (it.type === "model3d") {
    html = `<div class="pv-canvas" style="background:radial-gradient(circle at 50% 40%,#12527a,#01040c);display:block;padding-top:16%">
      <div style="color:#37e6d5;font-size:30px;font-weight:900">✦ 3D 裸眼内容</div>
      <div class="small" style="margin-top:10px;opacity:.75">${esc(it.url && it.url !== "builtin://demo1" ? it.url : "内置 3D 演示1（环形装置）")}<br>3D 裸眼效果需在游戏内的 3D转角包柱屏上查看</div></div>`;
  } else {
    const hues = ["#132a4a,#2c5364", "#3b0d2e,#8a1f4d", "#0d2b1e,#1f6e4e", "#2b1206,#a34a17"];
    const [a, b] = hues[(Number(it.seed) || 1) % hues.length].split(",");
    html = `<div class="pv-canvas" style="background:linear-gradient(135deg,${a},${b})"><div><div style="font-size:34px;font-weight:900">内置广告 · 潮汇坊</div><div class="small" style="margin-top:10px;opacity:.7">程序化品牌广告 · seed ${esc(it.seed ?? 1)}</div></div></div>`;
  }
  el.innerHTML = html + '<div class="pv-status" id="pv-status"></div>';
  const v = $("video", el);
  if (v) {
    const clearLoading = () => { const l = $("#pv-loading"); if (l) l.remove(); };
    v.addEventListener("loadeddata", clearLoading, { once: true });
    v.addEventListener("playing", clearLoading, { once: true });
    v.addEventListener("error", () => pvFail(it, it.type === "stream" ? "直播流无法播放 · 已降级" : "视频无法加载 · 已降级"), { once: true });
    if (it.type === "stream") pvAttachHls(v, it.url, it);
    else v.play().catch(() => {});
  }
  const bar = $("#pv-progress i");
  if (bar) bar.style.width = "0%";
  $$(".pv-list button").forEach((b) => b.classList.toggle("active", Number(b.dataset.i) === pv.i));
  const label = $("#pv-now");
  if (label) label.textContent = `#${pv.i + 1} · ${TYPES[it.type]?.label || it.type} · ${it.duration || 9}s`;
  updatePvStatus();
}
function openPreview(pl) {
  const items = (pl.items || []).filter((x) => x && TYPES[x.type]);
  if (!items.length) return toast("没有可预览的内容", "err");
  if (pv) {
    if (pv.timer) clearInterval(pv.timer);
    if (pv.loadTimer) clearTimeout(pv.loadTimer);
    if (pv.hls) { try { pv.hls.destroy(); } catch {} }
  }
  pv = { items, i: 0, t: 0, playing: true, timer: null, hls: null, loadTimer: null, failed: false };
  openModal(`
    <div class="modal-head"><h3>内容预览 · ${esc(pl.name || "节目单")}</h3><button class="btn sm" data-x>✕</button></div>
    <div class="pv-wrap">
      <div>
        <div class="pv-stage">
          <div class="pv-bezel"><div class="pv-screen" id="pv-screen"></div></div>
          <div class="pv-progress"><i id="pv-progress-b"></i></div>
          <div class="row" style="margin-top:12px">
            <button class="btn sm" id="pv-prev">‹ 上一项</button>
            <button class="btn sm" id="pv-play">暂停</button>
            <button class="btn sm" id="pv-next">下一项 ›</button>
            <div class="spacer"></div>
            <select id="pv-aspect" class="inp mini" style="width:150px">
              <option value="16 / 9">16 : 9 横屏</option><option value="1 / 1">1 : 1 方屏</option>
              <option value="32 / 9">32 : 9 超宽屏</option><option value="9 / 16">9 : 16 竖屏</option>
            </select>
          </div>
        </div>
        <p class="desc" style="margin:10px 0 0">预览为浏览器近似渲染；直播流由后台内置的 hls.js 播放（离线可用），游戏端同样走 hls.js / VideoTexture。底部状态条会显示播放进度或降级原因。</p>
      </div>
      <div class="pv-side">
        <div class="card" style="padding:14px">
          <div class="small muted">当前内容</div><b id="pv-now" style="font-size:13px">—</b>
          <div class="hr"></div>
          <div class="small muted">轮播序列（点击跳转）</div>
          <div class="pv-list" style="margin-top:8px">${items.map((it, i) => `<button data-i="${i}" class="${i === 0 ? "active" : ""}">${i + 1}. ${esc(TYPES[it.type]?.label || it.type)} · ${esc(it.duration || 9)}s · ${esc(short(it.url || it.text || it.note || "", 22))}</button>`).join("")}</div>
        </div>
      </div>
    </div>
  `, (root) => {
    $$("[data-x]", root).forEach((b) => b.onclick = closeModal);
    $("#pv-aspect", root).onchange = (e) => { $("#pv-screen", root).style.aspectRatio = e.target.value; };
    $("#pv-play", root).onclick = () => { pv.playing = !pv.playing; $("#pv-play", root).textContent = pv.playing ? "暂停" : "播放"; };
    const jump = (d) => { pv.i = (pv.i + d + pv.items.length) % pv.items.length; pv.t = 0; renderPvFrame(); };
    $("#pv-prev", root).onclick = () => jump(-1);
    $("#pv-next", root).onclick = () => jump(1);
    $$(".pv-list button", root).forEach((b) => b.onclick = () => { pv.i = Number(b.dataset.i); pv.t = 0; renderPvFrame(); });
    renderPvFrame();
    pv.timer = setInterval(() => {
      if (!pv || !$("#pv-screen")) { if (pv?.timer) clearInterval(pv.timer); return; }
      const it = pv.items[pv.i];
      updatePvStatus();
      if (it.type === "clock") {
        const d = new Date(), c = $("#pv-clock-time");
        if (c) c.textContent = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      }
      if (!pv.playing) return;
      pv.t += 0.2;
      const dur = Number(it.duration) || 9;
      const bar = $("#pv-progress-b");
      if (bar) bar.style.width = Math.min(100, pv.t / dur * 100) + "%";
      if (pv.t >= dur) jump(1);
    }, 200);
  }, true);
}

/* ---------------- 启动 ---------------- */
function go(v) {
  view = v;
  renderChrome();
  renderView();
  $(".view").scrollTop = 0;
}
$("#nav").addEventListener("click", (e) => {
  const b = e.target.closest("[data-view]");
  if (b) go(b.dataset.view);
});
$("#btn-refresh").onclick = async () => { try { await refresh(); toast("数据已刷新"); } catch (e) { toast("刷新失败：" + e.message, "err"); } };
$("#btn-game").onclick = () => window.open(gameUrl(), "_blank");
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
setInterval(() => { if (!document.hidden) refreshStatus(); }, 10000);

try { await refresh(); }
catch (e) {
  $("#svc-dot").className = "dot off";
  $("#svc-text").textContent = "后台服务不可达";
  $("#view").innerHTML = `<div class="card empty">无法读取后台状态：${esc(e.message)}<br><br>请确认已运行 <span class="mono">node server.js</span></div>`;
}
