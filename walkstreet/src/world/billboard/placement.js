// 广告大屏摆放约束：占位包络 / 道路走廊 / 路缘吸附 / 自动纠偏。
// 3D 编辑器（预览边界）与建城（实际落点 + 建筑排除区）共用同一份计算，
// 保证「编辑器里看到的边界 = 进游戏后真正占的边界」。

import { corridorHalf, extRoadSpec, EXT_STEP_X, EXT_STEP_Z } from "../../data/cityData.js";
import { areaPoly, footprintAABB, pointInPoly, worldBounds } from "../customMap.js";
import { normalizeSpec } from "./mounts.js";

export const ROAD_GAP = 0.8;    // 屏体外缘距人行道外沿的最小净距（米）
// 路缘吸附触发半径（米，按落点算）。转角塔体半宽约 8m，宽主干道含人行道约 18m，
// 合法路缘落点距路心约 26m，路口转角候选是斜向的 —— 半径太小会永远吸不上。
export const SNAP_RADIUS = 20;
const r1 = (v) => Math.round(v * 10) / 10;
// 候选落点比走廊边界多让出一点：既避开浮点误差，也覆盖 0.1m 取整的回退量
const EDGE_EPS = 0.3;

/* ---------------- 占位包络（局部坐标，group 原点 = 地面落点） ----------------
 * 与 mounts.js 的几何一一对应：
 *   standalone 屏框 w+1.0 / 底座 2.0 深；facade 屏面悬挑到 z≈1.2；
 *   corner / corner3d 塔体边长 w+1.4（整块落地）。
 * ox/oz 为包络中心相对 group 原点的偏移，top 为包络顶面高度。
 --------------------------------------------------------------------------- */
export function footprintOf(item) {
  const s = normalizeSpec(item && item.params);
  if (s.mount === "corner" || s.mount === "corner3d") {
    const half = (s.w + 1.4) / 2;
    return { mount: s.mount, spec: s, hx: half, hz: half, ox: 0, oz: 0, top: s.y + s.h / 2 + 0.6 };
  }
  if (s.mount === "facade") {
    return { mount: s.mount, spec: s, hx: (s.w + 0.7) / 2, hz: 0.8, ox: 0, oz: 0.7, top: s.y + s.h / 2 };
  }
  return { mount: "standalone", spec: s, hx: (s.w + 1.0) / 2, hz: 1.1, ox: 0, oz: 0, top: s.y + s.h / 2 + 0.5 };
}

/** 旋转后的包络：中心 (cx,cz)、AABB 半宽 (ex,ez)、四角，供碰撞 / 绘制共用 */
export function footprintBox(item, pos = item.pos, rot = item.rot || 0) {
  const f = footprintOf(item);
  const cs = Math.cos(rot), sn = Math.sin(rot);
  const cx = pos[0] + f.ox * cs + f.oz * sn;
  const cz = pos[1] - f.ox * sn + f.oz * cs;
  const ex = f.hx * Math.abs(cs) + f.hz * Math.abs(sn);
  const ez = f.hx * Math.abs(sn) + f.hz * Math.abs(cs);
  return { f, pos, rot, cs, sn, cx, cz, ex, ez, x0: cx - ex, x1: cx + ex, z0: cz - ez, z1: cz + ez };
}

export function footprintCorners(b) {
  const { f, pos, cs, sn } = b;
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => {
    const lx = f.ox + sx * f.hx, lz = f.oz + sz * f.hz;
    return { x: pos[0] + lx * cs + lz * sn, z: pos[1] - lx * sn + lz * cs };
  });
}

/* ---------------- 描边路 / 拼接路走廊 ----------------
 * 与 city.js 构造函数原逻辑逐字一致（含 index / samples / keepHalf），
 * 编辑器与运行时都通过它取道路约束，避免两边各写一套导致预览与实机不符。 */
export function buildTraceCorridors(data) {
  const out = [];
  const roadDefs = (data && data.features && data.features.roads) || [];
  for (let ri = 0; ri < roadDefs.length; ri++) {
    const r = roadDefs[ri];
    const ptsRaw = r.points || [];
    if (ptsRaw.length < 2) continue;
    const pts = ptsRaw.map(([x, z]) => ({ x, z }));
    const roadHalf = (r.width || 12) / 2;
    const sw = Math.min(Math.max(r.sidewalk ?? 3, 0), 12);
    const segs = [], samples = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      segs.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z });
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const n = Math.max(1, Math.ceil(len / 3));
      for (let k = 0; k < n; k++) samples.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
    }
    if (r.closed && pts.length > 2) {
      const a = pts[pts.length - 1], b = pts[0];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const n = Math.max(1, Math.ceil(len / 3));
      for (let k = 0; k < n; k++) samples.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
    }
    samples.push(pts[pts.length - 1]);
    out.push({
      index: ri, pts: ptsRaw, closed: !!r.closed, segs, samples,
      roadHalf, edgeHalf: roadHalf + sw, keepHalf: roadHalf + sw + 1.5,
    });
  }
  const tileDefs = (data && data.features && data.features.roadTiles) || [];
  for (let ri = 0; ri < tileDefs.length; ri++) {
    const t = tileDefs[ri];
    const hl = (t.len || 3) / 2, hw = (t.w || 2) / 2;
    const s = Math.sin(t.rot || 0), c = Math.cos(t.rot || 0);
    const pts = [
      [t.x + hw * c + hl * s, t.z - hw * s + hl * c],
      [t.x - hw * c + hl * s, t.z + hw * s + hl * c],
      [t.x - hw * c - hl * s, t.z + hw * s - hl * c],
      [t.x + hw * c - hl * s, t.z - hw * s - hl * c],
    ];
    const samples = [];
    const n = Math.max(1, Math.ceil((hl * 2) / 6));
    for (let k = 0; k <= n; k++) {
      const lz = -hl + (2 * hl * k) / n;
      samples.push({ x: t.x + lz * s, z: t.z + lz * c });
    }
    out.push({
      index: 1e6 + ri, tile: t, pts, closed: true,
      segs: pts.map((p, i) => {
        const q = pts[(i + 1) % 4];
        return { ax: p[0], az: p[1], bx: q[0], bz: q[1] };
      }),
      samples, roadHalf: hw, edgeHalf: hw + 2, keepHalf: hw + 3.5,
    });
  }
  return out;
}

/* ---------------- 程序化横纵路网 ----------------
 * 运行时传 city（roadsX/Z 已含延伸路 / 虚拟边界路），编辑器从地图数据推算，
 * 两者半宽统一 = corridorHalf(lanes+median+sidewalk) + ROAD_GAP。 */
export function axisRoads(data, city = null) {
  const out = [];
  const push = (axis, r) => {
    if (!r || !Number.isFinite(r.at)) return;
    out.push({ axis, at: r.at, half: corridorHalf(r) + ROAD_GAP, obj: r });
  };
  if (city) {
    for (const r of city.roadsX || []) push("x", r);
    for (const r of city.roadsZ || []) push("z", r);
    return out;
  }
  const d = data || {};
  for (const r of d.roadsX || []) push("x", r);
  for (const r of d.roadsZ || []) push("z", r);
  if (d.extRoads) {
    const b = worldBounds(d);
    const xs = (d.roadsX || []).map((r) => r.at), zs = (d.roadsZ || []).map((r) => r.at);
    if (xs.length) {
      let x = Math.max(...xs);
      while (x + EXT_STEP_X <= b.maxX) { x += EXT_STEP_X; push("x", { at: x, ...extRoadSpec(x, EXT_STEP_X) }); }
      x = Math.min(...xs);
      while (x - EXT_STEP_X >= b.minX) { x -= EXT_STEP_X; push("x", { at: x, ...extRoadSpec(x, EXT_STEP_X) }); }
    }
    if (zs.length) {
      let z = Math.max(...zs);
      while (z + EXT_STEP_Z <= b.maxZ) { z += EXT_STEP_Z; push("z", { at: z, ...extRoadSpec(z, EXT_STEP_Z) }); }
      z = Math.min(...zs);
      while (z - EXT_STEP_Z >= b.minZ) { z -= EXT_STEP_Z; push("z", { at: z, ...extRoadSpec(z, EXT_STEP_Z) }); }
    }
  }
  return out;
}

/* ---------------- 约束集合 ----------------
 * buildings(x0,z0,x1,z1,minTop) → 相交的 [x0,z0,x1,z1,top] 数组（可带 .id）。
 * includeBuildings=false：只用地图里手绘建筑 / 其它大屏，不查 city.colliders
 * （建城阶段程序化楼还没生成，改为把屏体占位登记成建筑排除区）。 */
function buildingsFromData(data) {
  const rects = [];
  for (const o of (data && data.objects) || []) {
    if (!o) continue;
    let r = null;
    if (o.type === "building") {
      const b = footprintAABB(o);
      if (b) r = [b.minX, b.minZ, b.maxX, b.maxZ, Infinity];
    } else if (o.type === "billboard") {
      const f = footprintOf(o);
      if (f.mount === "facade") continue;
      const b = footprintBox(o);
      r = [b.x0, b.z0, b.x1, b.z1, f.top];
    }
    if (!r) continue;
    r.id = o.id;
    rects.push(r);
  }
  return (x0, z0, x1, z1, minTop) => rects.filter((r) =>
    r[4] >= minTop && r[0] < x1 && r[2] > x0 && r[1] < z1 && r[3] > z0);
}

export function collectConstraints({ data, city = null, includeBuildings = true, boundary = true } = {}) {
  const d = data || {};
  const raw = (city ? city.traceCorridors : buildTraceCorridors(d)) || [];
  const corridors = raw.map((c) => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of c.samples || []) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    }
    return {
      samples: c.samples || [], pts: c.pts || [], closed: !!c.closed,
      keepHalf: (c.keepHalf ?? c.roadHalf ?? 0) + ROAD_GAP,
      minX, maxX, minZ, maxZ,
    };
  });
  const dataFn = buildingsFromData(d);
  let buildings = dataFn;
  if (city && city.colliders && includeBuildings) {
    buildings = (x0, z0, x1, z1, minTop) =>
      city.colliders.overlaps(x0, z0, x1, z1, minTop).concat(dataFn(x0, z0, x1, z1, minTop));
  }
  return {
    axis: axisRoads(d, city),
    corridors,
    buildings,
    boundary: boundary ? areaPoly(d) : null,
  };
}

/* ---------------- 合法性校验 ----------------
 * reasons: building / road / area。立面屏贴墙，天然不参与道路与建筑避让。 */
export const REASON_ZH = { building: "建筑", road: "道路/人行道", area: "地图范围" };
export function reasonText(reasons = []) {
  return [...new Set(reasons)].map((r) => REASON_ZH[r] || r).join("、");
}

export function validatePlacement(item, ctx, pos = item.pos, rot = item.rot || 0) {
  const b = footprintBox(item, pos, rot);
  const f = b.f;
  const corners = footprintCorners(b);
  if (f.mount === "facade") return { ok: true, reasons: [], box: b, corners, buildings: [] };
  const reasons = [];

  const minTop = f.mount === "corner" || f.mount === "corner3d" ? 7 : Math.max(4, f.spec.y - f.spec.h / 2 - 0.5);
  const hits = ctx.buildings(b.x0, b.z0, b.x1, b.z1, minTop).filter((r) => !item.id || r.id !== item.id);
  if (hits.length) reasons.push("building");

  if (ctx.boundary && corners.some((p) => !pointInPoly(p.x, p.z, ctx.boundary))) reasons.push("area");

  let road = false;
  for (const a of ctx.axis) {
    const d = (a.axis === "x" ? Math.abs(a.at - b.cx) - b.ex : Math.abs(a.at - b.cz) - b.ez);
    if (d < a.half) { road = true; break; }
  }
  if (!road) {
    for (const c of ctx.corridors) {
      const k = c.keepHalf;
      if (b.x0 > c.maxX + k || b.x1 < c.minX - k || b.z0 > c.maxZ + k || b.z1 < c.minZ - k) continue;
      let hit = false;
      const k2 = k * k;
      for (const p of c.samples) {
        const dx = p.x - b.cx, dz = p.z - b.cz;
        const lx = dx * b.cs - dz * b.sn, lz = dx * b.sn + dz * b.cs;
        const qx = Math.max(Math.abs(lx) - f.hx, 0), qz = Math.max(Math.abs(lz) - f.hz, 0);
        if (qx * qx + qz * qz < k2) { hit = true; break; }
      }
      if (!hit && c.closed && c.pts.length >= 3) hit = corners.some((p) => pointInPoly(p.x, p.z, c.pts));
      if (hit) { road = true; break; }
    }
  }
  if (road) reasons.push("road");
  return { ok: !reasons.length, reasons, box: b, corners, buildings: hits };
}

/* ---------------- 候选落点 ----------------
 * 优先「路缘 / 路口转角」，再螺旋兜底；按距原落点由近到远排序。 */
export function placementCandidates(item, ctx, origin, { includeSpiral = true, maxDist = 90 } = {}) {
  const b = footprintBox(item, origin, item.rot || 0);
  const out = [];
  const xEdges = [], zEdges = [];
  for (const a of ctx.axis) {
    const d = (a.axis === "x" ? origin[0] : origin[1]) - a.at;
    if (Math.abs(d) > maxDist) continue;
    for (const sign of [d >= 0 ? 1 : -1, d >= 0 ? -1 : 1]) {
      if (a.axis === "x") {
        const x = a.at + sign * (a.half + b.ex + EDGE_EPS);
        xEdges.push(x); out.push([x, origin[1]]);
      } else {
        const z = a.at + sign * (a.half + b.ez + EDGE_EPS);
        zEdges.push(z); out.push([origin[0], z]);
      }
    }
  }
  for (const x of xEdges) for (const z of zEdges) {
    if (Math.hypot(x - origin[0], z - origin[1]) <= maxDist) out.push([x, z]);
  }
  const rMax = Math.max(b.ex, b.ez);
  for (const c of ctx.corridors) {
    let best = null, bd = Infinity;
    for (const p of c.samples) {
      const d2 = (p.x - origin[0]) ** 2 + (p.z - origin[1]) ** 2;
      if (d2 < bd) { bd = d2; best = p; }
    }
    if (!best || bd > maxDist * maxDist) continue;
    let nx = origin[0] - best.x, nz = origin[1] - best.z;
    const len = Math.hypot(nx, nz);
    if (len < 0.5) { nx = 1; nz = 0; } else { nx /= len; nz /= len; }
    const k = c.keepHalf + rMax + EDGE_EPS;
    out.push([best.x + nx * k, best.z + nz * k]);
    out.push([best.x - nx * k, best.z - nz * k]);
  }
  if (includeSpiral) {
    for (let r = 2; r <= 44; r += 2) {
      for (let i = 0; i < 16; i++) {
        const a = (2 * Math.PI * i) / 16 + (r % 4) * 0.07;
        out.push([origin[0] + r * Math.cos(a), origin[1] + r * Math.sin(a)]);
      }
    }
  }
  const d2 = (p) => (p[0] - origin[0]) ** 2 + (p[1] - origin[1]) ** 2;
  out.sort((p, q) => d2(p) - d2(q));
  return out;
}

/** 运行时纠偏：压到建筑 / 道路 / 范围外时挪到最近合法路缘，ID / 朝向 / 内容不变。 */
export function resolvePlacement(item, ctx) {
  const f = footprintOf(item);
  if (f.mount === "facade") return { item, ok: true, moved: false, box: footprintBox(item) };
  const v = validatePlacement(item, ctx);
  if (v.ok) return { item, ok: true, moved: false, box: v.box };
  for (const p of placementCandidates(item, ctx, item.pos)) {
    if (!validatePlacement(item, ctx, p).ok) continue;
    const pos = [r1(p[0]), r1(p[1])];
    if (!validatePlacement(item, ctx, pos).ok) continue; // 取整后仍须合法
    const moved = { ...item, pos };
    return { item: moved, ok: true, moved: true, box: footprintBox(moved, pos, moved.rot || 0), reasons: v.reasons };
  }
  return { item, ok: false, moved: false, box: v.box, reasons: v.reasons };
}

/** 编辑器吸附：优先吸附到最近合法路缘（含路口转角），否则按网格取整。 */
export function snapPlacement(pt, item, ctx, { snapStep = 5, roadSnap = true } = {}) {
  const grid = snapStep > 0
    ? [Math.round(pt.x / snapStep) * snapStep, Math.round(pt.z / snapStep) * snapStep]
    : [r1(pt.x), r1(pt.z)];
  if (!roadSnap || footprintOf(item).mount === "facade") return { pos: grid, onRoad: false };
  for (const p of placementCandidates(item, ctx, [pt.x, pt.z], { includeSpiral: false })) {
    if (Math.hypot(p[0] - pt.x, p[1] - pt.z) > SNAP_RADIUS) continue;
    const pos = [r1(p[0]), r1(p[1])];
    if (validatePlacement(item, ctx, p).ok && validatePlacement(item, ctx, pos).ok) return { pos, onRoad: true };
  }
  return { pos: grid, onRoad: false };
}
