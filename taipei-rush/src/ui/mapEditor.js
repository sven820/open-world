// 2D 俯视地图编辑器：编辑路网（增/删/拖动/改属性）、放置地标、拖动出生点。
// 数据结构与 src/data/cityData.js 同构，保存通过 opts.onSave(data) 回调。

import { asphaltHalf, corridorHalf, EXT_STEP_X, EXT_STEP_Z, mapBounds } from "../data/cityData.js";

const KINDS = ["street", "arterial", "boulevard"];
const KIND_ZH = { street: "街道", arterial: "干道", boulevard: "大道" };
const LM_TYPES = ["tower", "taipei101", "temple", "redhouse", "cks", "station", "mrt", "gate"];
const LM_ZH = {
  tower: "摩天楼", taipei101: "台北101", temple: "庙宇", redhouse: "红楼",
  cks: "纪念堂", station: "车站", mrt: "捷运站", gate: "城门",
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uid = () => "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const round = (v) => Math.round(v);

export class MapEditor {
  // opts: { map, onSave(data) => bool, onPlay(), onClose() }
  constructor(opts) {
    this.opts = opts;
    this.map = opts.map; // 直接引用（面板传入的完整地图对象，保存时可变）
    this.tool = "select";
    this.lmType = "tower";
    this.sel = null;   // { kind: "roadX"|"roadZ"|"land"|"spawn", obj }
    this.drag = null;  // { mode: "pan"|"obj", ... }
    this.cam = { x: 195, z: -10, scale: 0.5 };
    this._dirty = false;

    this.root = document.getElementById("map-editor");
    this.cv = document.getElementById("me-canvas");
    this.ctx = this.cv.getContext("2d");
    this.nameEl = document.getElementById("me-name");
    this.propsEl = document.getElementById("me-props");
    this.statusEl = document.getElementById("me-status");
    this.lmSel = document.getElementById("me-lm-type");

    this.nameEl.value = this.map.name || "";
    this._buildLmTypes();

    this._onResize = () => { this._resize(); this._draw(); };
    this._onKey = (e) => this._key(e);
    window.addEventListener("resize", this._onResize);
    window.addEventListener("keydown", this._onKey);

    this._bindCanvas();
    this._bindTools();
    this._bindButtons();
    this._resize();
    this._fit();
    this._renderProps();
  }

  /* ---------- lifecycle ---------- */
  open() {
    this.root.classList.remove("hidden");
    this._resize();
    this._fit();
    this._draw();
  }
  close() {
    window.removeEventListener("resize", this._onResize);
    window.removeEventListener("keydown", this._onKey);
    this.root.classList.add("hidden");
  }

  status(t) { this.statusEl.textContent = t; }

  /* ---------- data ---------- */
  _collect() {
    return {
      name: this.nameEl.value.trim() || "未命名地图",
      roadsX: this.map.roadsX,
      roadsZ: this.map.roadsZ,
      districts: this.map.districts,
      landmarks: this.map.landmarks,
      spawn: this.map.spawn,
    };
  }

  _save() {
    if (this.map.roadsX.length < 2 || this.map.roadsZ.length < 2) {
      this.status("保存失败：至少需要 2 条纵向路和 2 条横向路");
      return false;
    }
    if (!this.map.spawn) {
      this.status("保存失败：缺少出生点");
      return false;
    }
    const ok = this.opts.onSave(this._collect());
    if (!ok) { this.status("保存失败"); return false; }
    this._dirty = false;
    const warn = this._spawnOffRoad();
    this.status(warn
      ? `已保存 · ${new Date().toLocaleTimeString()} · 提示：出生点不在马路上，进入游戏会自动吸附到最近道路`
      : `已保存 · ${new Date().toLocaleTimeString()}`);
    return true;
  }

  // 出生点到最近道路走廊的距离；> 0 表示落在街区/建筑区（含延伸路）
  _spawnOffRoad() {
    const sp = this.map.spawn;
    if (!sp) return 0;
    const { xs, zs } = this._grid();
    let best = Infinity;
    for (const r of xs) best = Math.min(best, Math.abs(sp.x - r.at) - corridorHalf(r));
    for (const r of zs) best = Math.min(best, Math.abs(sp.z - r.at) - corridorHalf(r));
    return best;
  }

  /* ---------- DOM wiring ---------- */
  _buildLmTypes() {
    this.lmSel.innerHTML = LM_TYPES.map((t) => `<option value="${t}">${LM_ZH[t]}</option>`).join("");
    this.lmSel.value = this.lmType;
    this.lmSel.addEventListener("change", () => { this.lmType = this.lmSel.value; });
  }

  _bindTools() {
    this.root.querySelectorAll(".me-tool[data-tool]").forEach((b) => {
      b.addEventListener("click", () => {
        const t = b.dataset.tool;
        if (t === "fit") { this._fit(); this._draw(); return; }
        this.tool = t;
        this.root.querySelectorAll(".me-tool[data-tool]").forEach((x) => x.classList.toggle("active", x === b));
        this.cv.style.cursor = t === "select" ? "default" : "crosshair";
      });
    });
  }

  _bindButtons() {
    document.getElementById("me-save").addEventListener("click", () => this._save());
    document.getElementById("me-play").addEventListener("click", () => { if (this._save()) this.opts.onPlay(); });
    document.getElementById("me-exit").addEventListener("click", () => this.opts.onClose());
  }

  _bindCanvas() {
    this.cv.addEventListener("contextmenu", (e) => e.preventDefault());

    this.cv.addEventListener("pointerdown", (e) => {
      this.cv.setPointerCapture(e.pointerId);
      const rect = this.cv.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      if (e.button === 2 || e.button === 1) {
        this.drag = { mode: "pan", px, py };
        return;
      }
      if (e.button !== 0) return;
      const w = this._s2w(px, py);
      if (this.tool === "select") {
        const hit = this._pick(px, py);
        this.sel = hit;
        if (hit) {
          this.drag = { mode: "obj", hit };
          this.status(hit.kind === "spawn" ? "拖动出生点位置" : "拖动调整位置 · Delete 删除");
        } else {
          this.status("点击道路 / 地标 / 出生点以选中");
        }
        this._renderProps();
        this._draw();
      } else if (this.tool === "roadX") {
        const r = { id: uid(), zh: "新纵路", en: "New Rd", at: round(w.x), kind: "street", lanes: 1, median: 0, sidewalk: 3 };
        this.map.roadsX.push(r);
        this.sel = { kind: "roadX", obj: r };
        this._afterEdit("已添加纵向路 · 可在右侧调整");
      } else if (this.tool === "roadZ") {
        const r = { id: uid(), zh: "新横路", en: "New Rd", at: round(w.z), kind: "street", lanes: 1, median: 0, sidewalk: 3 };
        this.map.roadsZ.push(r);
        this.sel = { kind: "roadZ", obj: r };
        this._afterEdit("已添加横向路 · 可在右侧调整");
      } else if (this.tool === "landmark") {
        const l = { id: uid(), type: this.lmType, x: round(w.x), z: round(w.z), rot: 0 };
        if (this.lmType === "tower") l.h = 96;
        this.map.landmarks.push(l);
        this.sel = { kind: "land", obj: l };
        this._afterEdit(`已放置${LM_ZH[this.lmType]}`);
      } else if (this.tool === "spawn") {
        this.map.spawn.x = round(w.x);
        this.map.spawn.z = round(w.z);
        this.sel = { kind: "spawn", obj: this.map.spawn };
        this._afterEdit("出生点已移动");
      }
    });

    this.cv.addEventListener("pointermove", (e) => {
      const rect = this.cv.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      if (this.drag && this.drag.mode === "pan") {
        this.cam.x -= (px - this.drag.px) / this.cam.scale;
        this.cam.z -= (py - this.drag.py) / this.cam.scale;
        this.drag.px = px; this.drag.py = py;
        this._draw();
        return;
      }
      if (this.drag && this.drag.mode === "obj") {
        const w = this._s2w(px, py);
        const { kind, obj } = this.drag.hit;
        if (kind === "roadX") obj.at = round(w.x);
        else if (kind === "roadZ") obj.at = round(w.z);
        else if (kind === "land") { obj.x = round(w.x); obj.z = round(w.z); }
        else if (kind === "spawn") { obj.x = round(w.x); obj.z = round(w.z); }
        this._dirty = true;
        this._renderProps();
        this._draw();
        return;
      }
      // hover 反馈只切换光标：重绘高亮会整条路变亮变粗，视觉上像地图乱跳
      const h = this._pick(px, py);
      const cursor = this.tool === "select" ? (h ? "pointer" : "default") : "crosshair";
      if (this.cv.style.cursor !== cursor) this.cv.style.cursor = cursor;
    });

    this.cv.addEventListener("pointerup", () => { this.drag = null; });
    this.cv.addEventListener("pointercancel", () => { this.drag = null; });

    this.cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = this.cv.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      const w0 = this._s2w(px, py);
      this.cam.scale = clamp(this.cam.scale * (e.deltaY < 0 ? 1.15 : 0.87), 0.04, 4);
      const w1 = this._s2w(px, py);
      this.cam.x += w0.x - w1.x;
      this.cam.z += w0.z - w1.z;
      this._draw();
    }, { passive: false });
  }

  _afterEdit(msg) {
    this._dirty = true;
    this._setSelectTool();
    this._renderProps();
    this._draw();
    this.status(msg);
  }
  _setSelectTool() {
    this.tool = "select";
    this.root.querySelectorAll(".me-tool[data-tool]").forEach((x) => x.classList.toggle("active", x.dataset.tool === "select"));
    this.cv.style.cursor = "default";
  }

  _key(e) {
    if (this.root.classList.contains("hidden")) return;
    if (document.activeElement && ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
    if (e.key === "Escape") {
      this.sel = null;
      this._renderProps();
      this._draw();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      this._deleteSel();
    } else if (e.key === "s" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this._save();
    }
  }

  _deleteSel() {
    if (!this.sel) return;
    const { kind, obj } = this.sel;
    if (kind === "roadX") this.map.roadsX = this.map.roadsX.filter((r) => r !== obj);
    else if (kind === "roadZ") this.map.roadsZ = this.map.roadsZ.filter((r) => r !== obj);
    else if (kind === "land") this.map.landmarks = this.map.landmarks.filter((l) => l !== obj);
    else if (kind === "spawn") return; // 出生点不可删除
    this.sel = null;
    this._dirty = true;
    this._renderProps();
    this._draw();
    this.status("已删除");
  }

  /* ---------- coordinate transforms ---------- */
  _w2sX(x) { return (x - this.cam.x) * this.cam.scale + this.cv.width / 2; }
  _w2sY(z) { return (z - this.cam.z) * this.cam.scale + this.cv.height / 2; }
  _s2w(px, py) {
    return {
      x: (px - this.cv.width / 2) / this.cam.scale + this.cam.x,
      z: (py - this.cv.height / 2) / this.cam.scale + this.cam.z,
    };
  }

  _resize() {
    const w = this.cv.clientWidth || 800, h = this.cv.clientHeight || 500;
    if (this.cv.width !== w || this.cv.height !== h) { this.cv.width = w; this.cv.height = h; }
  }

  // 世界实际路网 = 用户路 + 边缘自动延伸路（与 city.js _buildRoads 同规则）。
  // ext 标记的路仅用于预览，不属于地图数据。
  _grid() {
    const b = mapBounds(this.map.roadsX, this.map.roadsZ);
    const xs = [...this.map.roadsX].sort((a, b2) => a.at - b2.at);
    const zs = [...this.map.roadsZ].sort((a, b2) => a.at - b2.at);
    let n = 0;
    const ext = (at) => ({ id: "ext" + (n++), at, kind: "street", lanes: 1, median: 0, sidewalk: 3, _ext: true });
    while (xs[xs.length - 1].at < b.maxX) xs.push(ext(xs[xs.length - 1].at + EXT_STEP_X));
    while (xs[0].at > b.minX) xs.unshift(ext(xs[0].at - EXT_STEP_X));
    while (zs[zs.length - 1].at < b.maxZ) zs.push(ext(zs[zs.length - 1].at + EXT_STEP_Z));
    while (zs[0].at > b.minZ) zs.unshift(ext(zs[0].at - EXT_STEP_Z));
    return { xs, zs, bounds: b };
  }

  _fit() {
    if (!this.map.roadsX.length || !this.map.roadsZ.length) return;
    const b = mapBounds(this.map.roadsX, this.map.roadsZ);
    const pad = 80;
    const minX = b.minX - pad, maxX = b.maxX + pad;
    const minZ = b.minZ - pad, maxZ = b.maxZ + pad;
    this.cam.x = (minX + maxX) / 2;
    this.cam.z = (minZ + maxZ) / 2;
    this.cam.scale = clamp(Math.min(this.cv.width / (maxX - minX), this.cv.height / (maxZ - minZ)), 0.04, 4);
  }

  /* ---------- picking ---------- */
  _pick(px, py) {
    for (const l of this.map.landmarks) {
      if (Math.hypot(this._w2sX(l.x) - px, this._w2sY(l.z) - py) < 14) return { kind: "land", obj: l };
    }
    const sp = this.map.spawn;
    if (sp && Math.hypot(this._w2sX(sp.x) - px, this._w2sY(sp.z) - py) < 14) return { kind: "spawn", obj: sp };
    for (const r of this.map.roadsX) {
      if (Math.abs(this._w2sX(r.at) - px) < 7) return { kind: "roadX", obj: r };
    }
    for (const r of this.map.roadsZ) {
      if (Math.abs(this._w2sY(r.at) - py) < 7) return { kind: "roadZ", obj: r };
    }
    return null;
  }

  /* ---------- properties panel ---------- */
  _renderProps() {
    const el = this.propsEl;
    if (!this.sel) {
      el.innerHTML = `
        <h4>地图概览</h4>
        <div class="me-stat">纵向路 <b>${this.map.roadsX.length}</b></div>
        <div class="me-stat">横向路 <b>${this.map.roadsZ.length}</b></div>
        <div class="me-stat">地标 <b>${this.map.landmarks.length}</b></div>
        <div class="me-stat">城区 <b>${this.map.districts.length}</b>（只读）</div>
        <p class="me-hint">道路之间的街廓会按程序化规则自动生成建筑；移动道路即可重塑城市布局。</p>`;
      return;
    }
    const { kind, obj } = this.sel;
    if (kind === "roadX" || kind === "roadZ") {
      el.innerHTML = `
        <h4>${kind === "roadX" ? "纵向路" : "横向路"} · 属性</h4>
        <label>名称<input id="mp-zh" value="${obj.zh || ""}" maxlength="10" /></label>
        <label>英文名<input id="mp-en" value="${obj.en || ""}" maxlength="24" /></label>
        <label>类型<select id="mp-kind">${KINDS.map((k) => `<option value="${k}" ${k === (obj.kind || "street") ? "selected" : ""}>${KIND_ZH[k]}</option>`).join("")}</select></label>
        <label>车道<select id="mp-lanes">${[1, 2, 3, 4].map((n) => `<option ${n === (obj.lanes || 1) ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        <label>人行道宽<input id="mp-sw" type="number" min="0" max="12" value="${obj.sidewalk ?? 3}" /></label>
        <label>分隔带宽<input id="mp-md" type="number" min="0" max="14" value="${obj.median ?? 0}" /></label>
        <div class="me-pos">${kind === "roadX" ? `X ${obj.at}` : `Z ${obj.at}`}</div>
        <button class="me-del" id="mp-del">删除道路</button>`;
      el.querySelector("#mp-zh").addEventListener("change", (e) => { obj.zh = e.target.value; this._dirty = true; this._draw(); });
      el.querySelector("#mp-en").addEventListener("change", (e) => { obj.en = e.target.value; this._dirty = true; });
      el.querySelector("#mp-kind").addEventListener("change", (e) => { obj.kind = e.target.value; this._dirty = true; this._draw(); });
      el.querySelector("#mp-lanes").addEventListener("change", (e) => { obj.lanes = +e.target.value || 1; this._dirty = true; this._draw(); });
      el.querySelector("#mp-sw").addEventListener("change", (e) => { obj.sidewalk = clamp(+e.target.value || 0, 0, 12); this._dirty = true; this._draw(); });
      el.querySelector("#mp-md").addEventListener("change", (e) => { obj.median = clamp(+e.target.value || 0, 0, 14); this._dirty = true; this._draw(); });
      el.querySelector("#mp-del").addEventListener("click", () => this._deleteSel());
    } else if (kind === "land") {
      el.innerHTML = `
        <h4>地标 · 属性</h4>
        <label>类型<select id="mp-lm">${LM_TYPES.map((t) => `<option value="${t}" ${t === obj.type ? "selected" : ""}>${LM_ZH[t]}</option>`).join("")}</select></label>
        ${obj.type === "tower" ? `<label>高度<input id="mp-h" type="number" min="30" max="240" value="${obj.h ?? 96}" /></label>` : ""}
        <div class="me-pos">X ${obj.x} · Z ${obj.z}</div>
        <button class="me-del" id="mp-del">删除地标</button>`;
      el.querySelector("#mp-lm").addEventListener("change", (e) => { obj.type = e.target.value; this._dirty = true; this._renderProps(); this._draw(); });
      const hIn = el.querySelector("#mp-h");
      if (hIn) hIn.addEventListener("change", (e) => { obj.h = clamp(+e.target.value || 96, 30, 240); this._dirty = true; });
      el.querySelector("#mp-del").addEventListener("click", () => this._deleteSel());
    } else if (kind === "spawn") {
      el.innerHTML = `
        <h4>出生点</h4>
        <div class="me-pos">X ${obj.x} · Z ${obj.z}</div>
        <p class="me-hint">直接在画布上拖动，或使用「出生点」工具点击新位置。</p>`;
    }
  }

  /* ---------- rendering ---------- */
  _draw() {
    this._resize();
    const c = this.ctx, W = this.cv.width, H = this.cv.height, s = this.cam.scale;
    c.fillStyle = "#0b1014";
    c.fillRect(0, 0, W, H);

    // background grid (100 m)
    c.strokeStyle = "rgba(255,255,255,0.045)";
    c.lineWidth = 1;
    const g = 100, wx0 = Math.floor(this._s2w(0, 0).x / g) * g, wz0 = Math.floor(this._s2w(0, 0).z / g) * g;
    for (let x = wx0; this._w2sX(x) < W + 2; x += g) { c.beginPath(); c.moveTo(this._w2sX(x), 0); c.lineTo(this._w2sX(x), H); c.stroke(); }
    for (let z = wz0; this._w2sY(z) < H + 2; z += g) { c.beginPath(); c.moveTo(0, this._w2sY(z)); c.lineTo(W, this._w2sY(z)); c.stroke(); }

    const grid = this._grid();
    const xs = grid.xs, zs = grid.zs;

    // districts (read-only outline)
    c.save();
    for (const d of this.map.districts) {
      const x0 = this._w2sX(d.minX), z0 = this._w2sY(d.minZ);
      const w = (d.maxX - d.minX) * s, h = (d.maxZ - d.minZ) * s;
      c.strokeStyle = "rgba(120,160,220,0.22)";
      c.setLineDash([6, 5]);
      c.strokeRect(x0, z0, w, h);
      c.setLineDash([]);
      if (s > 0.14) {
        c.fillStyle = "rgba(150,180,225,0.4)";
        c.font = "600 11px Rajdhani, sans-serif";
        c.fillText(d.zh, x0 + 6, z0 + 14);
      }
    }
    c.restore();

    // blocks derived between roads (含延伸区的程序化街廓)
    for (let i = 0; i < xs.length - 1; i++) {
      for (let j = 0; j < zs.length - 1; j++) {
        const px0 = xs[i].at + asphaltHalf(xs[i]), px1 = xs[i + 1].at - asphaltHalf(xs[i + 1]);
        const pz0 = zs[j].at + asphaltHalf(zs[j]), pz1 = zs[j + 1].at - asphaltHalf(zs[j + 1]);
        if (px1 - px0 < 12 || pz1 - pz0 < 12) continue;
        const extBlock = xs[i]._ext || xs[i + 1]._ext || zs[j]._ext || zs[j + 1]._ext;
        c.fillStyle = extBlock ? "#10151c" : "#161d26";
        c.fillRect(this._w2sX(px0), this._w2sY(pz0), (px1 - px0) * s, (pz1 - pz0) * s);
      }
    }

    // roads：用户编辑的路（亮色 + 路名）与自动延伸路（暗色）
    for (const r of xs) {
      const selHl = this.sel && this.sel.obj === r;
      const isExt = r._ext;
      c.strokeStyle = selHl ? "#f2c14e" : isExt ? "#232c37" : "#3d4a58";
      c.lineWidth = Math.max(isExt ? 1.5 : 2, asphaltHalf(r) * 2 * s);
      c.beginPath(); c.moveTo(this._w2sX(r.at), 0); c.lineTo(this._w2sX(r.at), H); c.stroke();
      if (!isExt && s > 0.18) {
        c.strokeStyle = "rgba(255,255,255,0.28)";
        c.lineWidth = 1;
        c.setLineDash([8, 10]);
        c.beginPath(); c.moveTo(this._w2sX(r.at), 0); c.lineTo(this._w2sX(r.at), H); c.stroke();
        c.setLineDash([]);
        c.fillStyle = "rgba(244,242,238,0.65)";
        c.font = "500 10px sans-serif";
        c.fillText(r.zh || r.id, this._w2sX(r.at) + 4, 14);
      }
    }
    for (const r of zs) {
      const selHl = this.sel && this.sel.obj === r;
      const isExt = r._ext;
      c.strokeStyle = selHl ? "#f2c14e" : isExt ? "#232c37" : "#3d4a58";
      c.lineWidth = Math.max(isExt ? 1.5 : 2, asphaltHalf(r) * 2 * s);
      c.beginPath(); c.moveTo(0, this._w2sY(r.at)); c.lineTo(W, this._w2sY(r.at)); c.stroke();
      if (!isExt && s > 0.18) {
        c.strokeStyle = "rgba(255,255,255,0.28)";
        c.lineWidth = 1;
        c.setLineDash([8, 10]);
        c.beginPath(); c.moveTo(0, this._w2sY(r.at)); c.lineTo(W, this._w2sY(r.at)); c.stroke();
        c.setLineDash([]);
        c.fillStyle = "rgba(244,242,238,0.65)";
        c.font = "500 10px sans-serif";
        c.fillText(r.zh || r.id, 6, this._w2sY(r.at) - 4);
      }
    }

    // legend
    c.fillStyle = "rgba(244,242,238,0.42)";
    c.font = "500 11px sans-serif";
    c.fillText("淡色道路与暗色街区 = 世界边缘自动延伸（程序化填充，随路网保存自动调整）", 14, H - 14);

    // landmarks
    for (const l of this.map.landmarks) {
      const selHl = this.sel && this.sel.obj === l;
      const x = this._w2sX(l.x), y = this._w2sY(l.z);
      c.beginPath();
      c.arc(x, y, selHl ? 9 : 6, 0, 7);
      c.fillStyle = selHl ? "#f2c14e" : l.type === "taipei101" ? "#ff6b6b" : "#c46bd6";
      c.fill();
      c.strokeStyle = "rgba(0,0,0,0.5)";
      c.lineWidth = 1.5;
      c.stroke();
      if (s > 0.18) {
        c.fillStyle = "rgba(244,242,238,0.75)";
        c.font = "500 10px sans-serif";
        c.fillText(LM_ZH[l.type] || l.type, x + 8, y - 6);
      }
    }

    // spawn point
    const sp = this.map.spawn;
    if (sp) {
      const selHl = this.sel && this.sel.obj === sp;
      const x = this._w2sX(sp.x), y = this._w2sY(sp.z);
      c.save();
      c.translate(x, y);
      c.beginPath();
      c.moveTo(0, -12); c.lineTo(9, 8); c.lineTo(0, 3); c.lineTo(-9, 8);
      c.closePath();
      c.fillStyle = selHl ? "#f2c14e" : "#4ade80";
      c.fill();
      c.strokeStyle = "rgba(0,0,0,0.55)";
      c.lineWidth = 1.5;
      c.stroke();
      c.restore();
      c.fillStyle = "rgba(74,222,128,0.85)";
      c.font = "600 10px sans-serif";
      c.fillText("出生点", x + 10, y + 12);
    }
  }
}
