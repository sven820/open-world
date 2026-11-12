// 会话式测距工具：单击地图依次加点，实时显示每段与总距离（局部米坐标直线距离，
// 与 lonLatAt 同一平面近似）。绿色胖线 + 屏幕空间恒定大小的距离标注（sprite 贴图缓存），
// 双击/Enter 结束后结果保留在图上，直到清除或重新开始。
// 全部以编辑器实例（ed）为第一参数。

import * as THREE from "three/webgpu";
import { fmtDist } from "./util.js";

export function startMeasure(ed) {
  ed._select(null);
  ed._discardDraft();
  ed._measureResult = null; // 开始新测距即移除上次结果
  renderMeasureResult(ed);
  ed.draft = { points: [], measure: true, redo: [] };
  ed._setTool("measure");
  ed._three.orbit.mouseButtons.LEFT = null; // 左键让位给加点，右键旋转 / 滚轮缩放不受影响
  ed._updateDraftPreview();
  renderMeasurePanel(ed);
  ed.status("测距：单击地图依次加点 —— 每段与总距离实时标注 · 双击/Enter 结束 · Esc 取消");
}

// 结束测距会话：清草稿、恢复左键视角控制、右侧面板回到默认
export function endMeasure(ed, msg) {
  ed.draft = null;
  ed._three.orbit.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
  if (ed.tool === "measure") ed._setTool("select");
  ed._updateDraftPreview();
  ed._renderProps();
  if (msg) ed.status(msg);
}

export function clearMeasure(ed) {
  ed._measureResult = null;
  renderMeasureResult(ed);
}

// 加点：双击结束产生的重复点击按 <0.8m 去重；Shift 锁 45° 方向
export function measureAddPoint(ed, pt, e) {
  const d = ed.draft;
  if (!d || !d.measure) return;
  if (e && e.shiftKey) pt = ed._snap45(pt);
  const last = d.points[d.points.length - 1];
  if (last && Math.hypot(pt.x - last.x, pt.z - last.z) < 0.8) return;
  d.points.push(pt);
  d.redo = [];
  ed._updateDraftPreview();
  renderMeasurePanel(ed);
}

export function finishMeasure(ed) {
  const d = ed.draft;
  if (!d || !d.measure) return;
  if (d.points.length < 2) { ed.status("测距：至少需要 2 个点（继续单击加点）"); return; }
  const pts = d.points.map((p) => ({ x: Math.round(p.x * 10) / 10, z: Math.round(p.z * 10) / 10 }));
  const length = ed._polylineLen(pts.map((p) => [p.x, p.z]));
  endMeasure(ed);
  ed._measureResult = { points: pts, length };
  renderMeasureResult(ed);
  ed.status(`测距完成：总距离 ${fmtDist(length)} · ${pts.length} 个点（设置面板可清除 / 重新测距）`);
}

// 测距会话右侧面板：实时距离 + 完成/撤销/恢复/取消
export function renderMeasurePanel(ed) {
  const d = ed.draft;
  if (!d || !d.measure) return;
  const path = d.cursor ? [...d.points, d.cursor] : [...d.points];
  const total = ed._polylineLen(path.map((p) => [p.x, p.z]));
  const el = document.getElementById("e3-props");
  el.innerHTML = `
    <h4>测距 · 进行中</h4>
    <div class="me-stat">总距离 <b id="ep-ms-total">${fmtDist(total)}</b> · 节点 <b id="ep-ms-n">${d.points.length}</b></div>
    <div class="me-stat">上一段 <b id="ep-ms-last">—</b></div>
    <button class="me-btn" id="ep-ms-done">完成测距（Enter / 双击）</button>
    <button class="me-btn" id="ep-ms-undo">撤销上一节点（Ctrl+Z）</button>
    <button class="me-btn" id="ep-ms-redo">恢复节点（Ctrl+Y）</button>
    <button class="me-del" id="ep-ms-cancel">取消测距（Esc）</button>
    <p class="me-hint">单击地图依次加点（Shift 锁 45° 直线）· 每段距离标注在图上，总距离在末端 · 双击结束，结果保留到下次测距</p>`;
  const bind = (id, fn, disabled) => {
    const btn = el.querySelector(id);
    btn.disabled = !!disabled;
    btn.addEventListener("click", (e) => { e.currentTarget.blur(); fn(); });
  };
  bind("#ep-ms-done", () => finishMeasure(ed), d.points.length < 2);
  bind("#ep-ms-undo", () => ed._undoDraftPoint(), !d.points.length);
  bind("#ep-ms-redo", () => ed._redoDraftPoint(), !d.redo.length);
  bind("#ep-ms-cancel", () => endMeasure(ed, "已取消测距"));
}

// 轻量刷新：鼠标移动只更新数字（拖动频繁，不能整面板重绘）
export function updateMeasureLive(ed) {
  const d = ed.draft;
  if (!d || !d.measure) return;
  const path = d.cursor ? [...d.points, d.cursor] : [...d.points];
  const total = ed._polylineLen(path.map((p) => [p.x, p.z]));
  ed.status(`测距中：总距离 ${fmtDist(total)} · ${d.points.length} 点 · 双击/Enter 结束 · Esc 取消`);
  const el = document.getElementById("e3-props");
  const t = el.querySelector("#ep-ms-total"), n = el.querySelector("#ep-ms-n"), last = el.querySelector("#ep-ms-last");
  if (t) t.textContent = fmtDist(total);
  if (n) n.textContent = d.points.length;
  if (last && path.length >= 2) {
    const a = path[path.length - 2], b = path[path.length - 1];
    last.textContent = fmtDist(Math.hypot(b.x - a.x, b.z - a.z));
  }
}

// 已完成测距结果的常驻显示（不参与草稿预览/重建清理，直到清除）
export function renderMeasureResult(ed) {
  if (ed._measureGroup) {
    ed._three.scene.remove(ed._measureGroup);
    ed._measureGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    ed._measureGroup = null;
  }
  if (!ed._measureResult) return;
  ed._measureGroup = buildMeasureGroup(ed, ed._measureResult.points, null);
  ed._three.scene.add(ed._measureGroup);
  ed._measureGroup.visible = ed._layerVis.measure !== false; // 保持面板里的显隐状态
}

// 测距绘制组：绿色胖线（深色衬底）+ 节点圆点 + 每段中点距离标注 + 末端总距离标注，
// 全部跟随曲率下沉；cursor 为橡皮筋预览段
export function buildMeasureGroup(ed, points, cursor) {
  const g = new THREE.Group();
  const path = cursor ? [...points, cursor] : [...points];
  const yAt = (p) => 0.16 - ed._curveOffset(p.x, p.z);
  if (path.length >= 2) {
    const casing = ed._fatLine(path, 8, 0x0b1220, 0.85, 0.14);
    casing.renderOrder = 3;
    const main = ed._fatLine(path, 4, 0x4ade80, 1, 0.16);
    main.renderOrder = 4;
    g.add(casing, main);
  }
  for (const p of path) {
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(1.1, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0x4ade80, depthWrite: false }),
    );
    dot.position.set(p.x, yAt(p), p.z);
    dot.renderOrder = 5;
    g.add(dot);
  }
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const sp = measureLabel(ed, fmtDist(Math.hypot(b.x - a.x, b.z - a.z)), false);
    sp.position.set((a.x + b.x) / 2, yAt(a) + 5, (a.z + b.z) / 2);
    g.add(sp);
  }
  if (path.length >= 2) {
    const end = path[path.length - 1];
    const total = ed._polylineLen(path.map((p) => [p.x, p.z]));
    const sp = measureLabel(ed, `总 ${fmtDist(total)}`, true);
    sp.position.set(end.x, yAt(end) + 14, end.z);
    g.add(sp);
  }
  return g;
}

// 屏幕空间恒定大小的距离标注（sprite，sizeAttenuation=false）：
// 文字贴图按文本缓存（材质可随组丢弃，贴图保留复用，避免逐帧重建 canvas）
export function measureLabel(ed, text, accent) {
  const cache = (ed._labelTex ||= new Map());
  const key = (accent ? "!" : "") + text;
  if (cache.size > 80) { for (const t of cache.values()) t.dispose(); cache.clear(); }
  let tex = cache.get(key);
  if (!tex) {
    const fs = 44, pad = 16;
    const cnv = document.createElement("canvas");
    let ctx = cnv.getContext("2d");
    ctx.font = `600 ${fs}px sans-serif`;
    cnv.width = Math.ceil(ctx.measureText(text).width) + pad * 2;
    cnv.height = fs + pad * 2;
    ctx = cnv.getContext("2d");
    ctx.font = `600 ${fs}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const r = cnv.height / 2, w = cnv.width;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(1.5, 1.5, w - 3, cnv.height - 3, r); else ctx.rect(1.5, 1.5, w - 3, cnv.height - 3);
    ctx.fillStyle = accent ? "rgba(6,26,16,.92)" : "rgba(11,18,32,.88)";
    ctx.fill();
    ctx.strokeStyle = accent ? "#4ade80" : "rgba(255,255,255,.4)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = accent ? "#8df0b6" : "#e8f2ff";
    ctx.fillText(text, w / 2, cnv.height / 2 + 2);
    tex = new THREE.CanvasTexture(cnv);
    tex.colorSpace = THREE.SRGBColorSpace;
    cache.set(key, tex);
  }
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false,
  }));
  const h = accent ? 0.052 : 0.04; // 屏幕高度占比（远近视角下标注大小恒定可读）
  sp.scale.set(h * (tex.image.width / tex.image.height), h, 1);
  sp.renderOrder = 10; // 恒在胖线/网格之上
  return sp;
}
