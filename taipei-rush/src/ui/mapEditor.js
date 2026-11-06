// 2D 俯视地图编辑器：编辑路网（增/删/拖动/改属性）、放置地标、拖动出生点。
// 数据结构与 src/data/cityData.js 同构，保存通过 opts.onSave(data) 回调。

import { corridorHalf, genConfig, mapBounds } from "../data/cityData.js";
import { genParamsHtml, bindGenParams } from "./genParams.js";
import { drawMap2d, editorGrid, LM_ZH } from "./mapView2d.js";

const KINDS = ["street", "arterial", "boulevard"];
const KIND_ZH = { street: "街道", arterial: "干道", boulevard: "大道" };
const LM_TYPES = ["tower", "taipei101", "temple", "redhouse", "cks", "station", "mrt", "gate"];

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

    // 编辑器面板用的是 index.html 里的单例 DOM（按钮/画布/名称输入框）。
    // 所有监听都挂到本实例的 controller 上，close() 时一次性摘除：
    // 否则上一次打开的编辑器实例仍绑在同一个「保存」按钮上，点保存会把
    // 旧地图也按当前名称输入框的内容再存一遍（表现为另一张地图被改名）。
    this._ac = new AbortController();
    this._sig = { signal: this._ac.signal };
    this._sigNP = { signal: this._ac.signal, passive: false };

    this.nameEl.value = this.map.name || "";
    this._buildLmTypes();

    this._onResize = () => { this._resize(); this._draw(); };
    this._onKey = (e) => this._key(e);
    window.addEventListener("resize", this._onResize, this._sig);
    window.addEventListener("keydown", this._onKey, this._sig);

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
    // 摘除本实例注册的全部监听（单例 DOM 上不能残留旧编辑器实例的回调）
    if (this._ac) { this._ac.abort(); this._ac = null; }
    window.removeEventListener("resize", this._onResize);
    window.removeEventListener("keydown", this._onKey);
    this.root.classList.add("hidden");
  }

  status(t) { this.statusEl.textContent = t; }

  /* ---------- data ---------- */
  _collect() {
    const d = {
      name: this.nameEl.value.trim() || "未命名地图",
      roadsX: this.map.roadsX,
      roadsZ: this.map.roadsZ,
      districts: this.map.districts,
      landmarks: this.map.landmarks,
      spawn: this.map.spawn,
      extRoads: !!this.map.extRoads,
      // 程序化生成参数（楼间距 / 绿植 / 路灯），随地图一起保存
      ...genConfig(this.map),
    };
    // 3D 描边内容原样带回：2D 里对描边道路的平移/删除/改属性才能保存生效
    if (this.map.features) d.features = this.map.features;
    if (this.map.objects) d.objects = this.map.objects;
    return d;
  }

  _save() {
    // 允许任意规模路网（含 1+1 十字路、纯地标/纯 3D 描边的 0 路网地图）
    if (!this.map.spawn) {
      this.status("保存失败：缺少出生点");
      return false;
    }
    const ok = this.opts.onSave(this._collect());
    if (!ok) { this.status("保存失败"); return false; }
    this._dirty = false;
    const warn = this._spawnOffRoad();
    const tips = [];
    if (!this.map.roadsX.length || !this.map.roadsZ.length) tips.push("当前无完整路网，程序化街道/街廓不会生成，可搭配 3D 编辑手绘道路");
    if (warn) tips.push("出生点不在马路上，进入游戏会自动吸附到最近道路");
    this.status(`已保存 · ${new Date().toLocaleTimeString()}${tips.length ? " · " + tips.join(" · ") : ""}`);
    return true;
  }

  // 出生点到最近道路走廊的距离；> 0 表示落在街区/建筑区（含延伸路）
  _spawnOffRoad() {
    const sp = this.map.spawn;
    if (!sp) return 0;
    const { xs, zs } = editorGrid(this.map);
    let best = Infinity;
    for (const r of xs) best = Math.min(best, Math.abs(sp.x - r.at) - corridorHalf(r));
    for (const r of zs) best = Math.min(best, Math.abs(sp.z - r.at) - corridorHalf(r));
    return best;
  }

  /* ---------- DOM wiring ---------- */
  _buildLmTypes() {
    this.lmSel.innerHTML = LM_TYPES.map((t) => `<option value="${t}">${LM_ZH[t]}</option>`).join("");
    this.lmSel.value = this.lmType;
    this.lmSel.addEventListener("change", () => { this.lmType = this.lmSel.value; }, this._sig);
  }

  _bindTools() {
    this.root.querySelectorAll(".me-tool[data-tool]").forEach((b) => {
      b.addEventListener("click", () => {
        const t = b.dataset.tool;
        if (t === "fit") { this._fit(); this._draw(); return; }
        this.tool = t;
        this.root.querySelectorAll(".me-tool[data-tool]").forEach((x) => x.classList.toggle("active", x === b));
        this.cv.style.cursor = t === "select" ? "default" : "crosshair";
      }, this._sig);
    });
  }

  _bindButtons() {
    document.getElementById("me-save").addEventListener("click", () => this._save(), this._sig);
    document.getElementById("me-play").addEventListener("click", () => { if (this._save()) this.opts.onPlay(); }, this._sig);
    document.getElementById("me-exit").addEventListener("click", () => this.opts.onClose(), this._sig);
  }

  _bindCanvas() {
    this.cv.addEventListener("contextmenu", (e) => e.preventDefault(), this._sig);

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
          if (hit.kind === "troad") {
            // 描边道路整体平移：快照按下时的点集与指针位置，拖动按差值平移
            this.drag.wx = w.x; this.drag.wz = w.z;
            this.drag.orig = hit.obj.points.map((p) => [...p]);
          }
          this.status(hit.kind === "spawn" ? "拖动出生点位置"
            : hit.kind === "troad" ? "拖动整体平移 · 右侧编辑属性 · Delete 删除"
            : "拖动调整位置 · Delete 删除");
        } else {
          this.status("点击道路 / 描边道路 / 地标 / 出生点以选中");
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
    }, this._sig);

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
        else if (kind === "troad") {
          const dx = round(w.x - this.drag.wx), dz = round(w.z - this.drag.wz);
          obj.points = this.drag.orig.map(([x, z]) => [x + dx, z + dz]);
        }
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
    }, this._sig);

    this.cv.addEventListener("pointerup", () => { this.drag = null; }, this._sig);
    this.cv.addEventListener("pointercancel", () => { this.drag = null; }, this._sig);

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
    }, this._sigNP);
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
    else if (kind === "troad" && this.map.features) this.map.features.roads = this.map.features.roads.filter((r) => r !== obj);
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
    // 3D 描边道路：点到折线距离 ≤ 半宽 + 屏幕容差；取面道路用点在多边形内判断
    const f = this.map.features;
    if (f) {
      const w = this._s2w(px, py);
      const tol = 6 / this.cam.scale; // 屏幕 6px 容差换算成世界米
      for (let i = (f.roads || []).length - 1; i >= 0; i--) {
        const r = f.roads[i];
        if (r.closed && r.points.length >= 3) {
          if (this._pointInPoly(w.x, w.z, r.points)) return { kind: "troad", obj: r };
          continue;
        }
        if (this._distToPolyline(w.x, w.z, r.points) <= (r.width || 12) / 2 + tol) return { kind: "troad", obj: r };
      }
    }
    return null;
  }

  // 点到折线的最近距离（世界米）
  _distToPolyline(x, z, pts) {
    let best = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x1, z1] = pts[i], [x2, z2] = pts[i + 1];
      const dx = x2 - x1, dz = z2 - z1;
      const len2 = dx * dx + dz * dz;
      const t = clamp(len2 ? ((x - x1) * dx + (z - z1) * dz) / len2 : 0, 0, 1);
      best = Math.min(best, Math.hypot(x - (x1 + dx * t), z - (z1 + dz * t)));
    }
    return best;
  }

  // 点是否在多边形内（射线法）
  _pointInPoly(x, z, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, zi] = pts[i], [xj, zj] = pts[j];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  }

  // 多边形面积（鞋带公式，有符号）
  _polyArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % pts.length];
      a += x1 * z2 - x2 * z1;
    }
    return a / 2;
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
        <label class="me-check"><input id="mp-ext" type="checkbox" ${this.map.extRoads ? "checked" : ""} /> 程序化延伸街道</label>
        <p class="me-hint">勾选后按固定间距自动补满世界边缘的默认街道（游戏内与预览同步）；不勾选则只保留手工道路。</p>
        <h4>程序化城市</h4>
        ${genParamsHtml(this.map, "mp")}
        <p class="me-hint">勾选后才会自动生成程序化街区；不勾选则只保留手工路网与 3D 描边内容。楼间距越大楼越散；绿植 / 路灯密度 0 表示不生成。保存后进入游戏生效。</p>`;
      el.querySelector("#mp-ext").addEventListener("change", (e) => {
        this.map.extRoads = !!e.target.checked;
        this._dirty = true;
        this._draw();
      });
      bindGenParams(el, this.map, "mp", () => { this._dirty = true; });
      return;
    }
    const { kind, obj } = this.sel;
    if (kind === "roadX" || kind === "roadZ") {
      el.innerHTML = `
        <h4>${kind === "roadX" ? "纵向路" : "横向路"} · 属性</h4>
        <label>名称<input id="mp-zh" value="${obj.zh || ""}" maxlength="10" /></label>
        <label>英文名<input id="mp-en" value="${obj.en || ""}" maxlength="24" /></label>
        <label>类型<select id="mp-kind">${KINDS.map((k) => `<option value="${k}" ${k === (obj.kind || "street") ? "selected" : ""}>${KIND_ZH[k]}</option>`).join("")}</select></label>
        <label>车道（每条宽3.4m）<select id="mp-lanes">${[1, 2, 3, 4].map((n) => `<option ${n === (obj.lanes || 1) ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        <label>人行道宽（m）<input id="mp-sw" type="number" min="0" max="12" value="${obj.sidewalk ?? 3}" /></label>
        <label>分隔带宽（m）<input id="mp-md" type="number" min="0" max="14" value="${obj.median ?? 0}" /></label>
        <div class="me-pos">${kind === "roadX" ? `X ${obj.at}` : `Z ${obj.at}`}</div>
        <button class="me-del" id="mp-del">删除道路</button>`;
      el.querySelector("#mp-zh").addEventListener("change", (e) => { obj.zh = e.target.value; this._dirty = true; this._draw(); });
      el.querySelector("#mp-en").addEventListener("change", (e) => { obj.en = e.target.value; this._dirty = true; });
      el.querySelector("#mp-kind").addEventListener("change", (e) => { obj.kind = e.target.value; this._dirty = true; this._draw(); });
      el.querySelector("#mp-lanes").addEventListener("change", (e) => { obj.lanes = +e.target.value || 1; this._dirty = true; this._draw(); });
      el.querySelector("#mp-sw").addEventListener("change", (e) => { obj.sidewalk = clamp(+e.target.value || 0, 0, 12); this._dirty = true; this._draw(); });
      el.querySelector("#mp-md").addEventListener("change", (e) => { obj.median = clamp(+e.target.value || 0, 0, 14); this._dirty = true; this._draw(); });
      el.querySelector("#mp-del").addEventListener("click", () => this._deleteSel());
    } else if (kind === "troad") {
      // 3D 描边道路：与 3D 编辑器同套属性（无车道数，宽度即路幅）；顶点编辑在 3D 编辑器
      const poly = !!obj.closed;
      el.innerHTML = `
        <h4>${poly ? "面道路" : "描边道路"} · 属性</h4>
        <label>名称<input id="mp-zh" value="${(obj.zh ?? obj.name) || ""}" maxlength="10" /></label>
        <label>英文名<input id="mp-en" value="${obj.en || ""}" maxlength="24" /></label>
        <label>类型<select id="mp-kind">${KINDS.map((k) => `<option value="${k}" ${k === (obj.kind || "street") ? "selected" : ""}>${KIND_ZH[k]}</option>`).join("")}</select></label>
        <label>车道（每方向）<select id="mp-lanes">${[1, 2, 3, 4].map((n) => `<option ${n === (obj.lanes || 2) ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        ${poly ? "" : `<label>宽度(m)<input id="mp-w" type="number" min="4" max="80" value="${obj.width}" /></label>`}
        <label>人行道宽（m）<input id="mp-sw" type="number" min="0" max="12" value="${obj.sidewalk ?? 3}" /></label>
        <label>分隔带宽（m）<input id="mp-md" type="number" min="0" max="14" value="${obj.median ?? 0}" /></label>
        <div class="me-pos">${obj.points.length} 个点${poly ? ` · 约 ${Math.round(Math.abs(this._polyArea(obj.points)))}㎡` : ""}</div>
        <p class="me-hint">画布上拖动 = 整体平移；顶点级调整请在 3D 编辑器中进行。</p>
        <button class="me-del" id="mp-del">删除道路</button>`;
      el.querySelector("#mp-zh").addEventListener("change", (e) => { obj.zh = e.target.value; this._dirty = true; this._draw(); });
      el.querySelector("#mp-en").addEventListener("change", (e) => { obj.en = e.target.value; this._dirty = true; });
      el.querySelector("#mp-kind").addEventListener("change", (e) => { obj.kind = e.target.value; this._dirty = true; this._draw(); });
      el.querySelector("#mp-lanes").addEventListener("change", (e) => { obj.lanes = +e.target.value || 2; this._dirty = true; });
      el.querySelector("#mp-sw").addEventListener("change", (e) => { obj.sidewalk = clamp(+e.target.value || 0, 0, 12); this._dirty = true; });
      el.querySelector("#mp-md").addEventListener("change", (e) => { obj.median = clamp(+e.target.value || 0, 0, 14); this._dirty = true; });
      const wIn = el.querySelector("#mp-w");
      if (wIn) wIn.addEventListener("change", (e) => { obj.width = clamp(+e.target.value || 12, 4, 80); this._dirty = true; this._draw(); });
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
    // 绘制逻辑抽到 mapView2d.js：编辑器与游戏内大地图（只读预览）共用同一套 2D 显示
    drawMap2d(this.ctx, this.cv.width, this.cv.height, this.map, this.cam, { selected: this.sel });
  }
}
