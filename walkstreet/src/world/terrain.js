// 地形高度场（heightfield）—— 3D 编辑器与游戏运行时共用的高度权威。
// 设计（对齐专业地图/关卡编辑器的通用做法）：
// - 地图数据只存一张规则网格的高度值 heights[]（默认 40m 步距，覆盖地图范围
//   的包围盒），任意点高度用双线性插值实时求出，不逐对象存 y；
// - 建筑/树/路灯/道路等所有静态内容：数据里只有 pos(x,z)，渲染高度一律现场
//   采样高度场（terrainHeightAt / displaceGroup）—— 改地形后重建即全部重新
//   落地，不会出现陷入地下或飘在空中；
// - 两种生成模式（旧版 random 随机地形已并入 custom：随机生成只是给 custom
//   高度场填初始值的一种手段，生成后可继续笔刷雕刻）：
//   1. real 真实地形高：Cesium 高程源网格采样（ArcGIS 全球地形优先、Ion 兜底，
//      实现在 ui/editor3d/terrain.js），heights 存椭球高（与 Cesium 地形渲染同
//      基准，编辑器底图挂同一 provider 保证影像贴合）；
//   2. custom 自定义地形高：随机生成（种子化分形值噪声，fbm，边缘向 0 衰减，
//      与世界边界外的平地自然衔接）或笔刷在网格上抬升/下压/抹平/平滑。
// heights 为「绝对米制高度」：真实模式 = 椭球高；自定义 = 相对局部 y=0 面。
// 地图无 terrain 字段 = 平面（所有 API 返回 0），旧地图零改动兼容。

import * as THREE from "three";
import { EXT_STEP_X, EXT_STEP_Z, extRoadSpec } from "../data/cityData.js";

export const TERRAIN_STEP_DEFAULT = 40; // 高度场默认步距（米）
const GRID_MAX = 220;                    // 单边网格上限（超出自动放大步距）
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// 可见地面与路基补丁的统一目标步长（米）。
// 关键（ADR-0005）：可见地面若在道路附近用比路基补丁更粗的网格，凹曲面处
// 粗三角形线性插值会系统性地高于真实 design 高程，从下方顶穿精细路面，
// 表现为「深绿底板盖住道路 / 路面断断续续 / 路边突然隆起」。让所有可见
// 地面层与补丁共用这一格点步长（同相位），顶穿即消失（实测 ≤0）。
export const GROUND_STEP = 8;

// 道路走廊场地平整（road corridor grading）参数。与建筑地基 pad 同一思路：
// 高度场网格（40m）远窄于道路，必须在采样层叠加一层「沿路的解析表面」。
export const ROAD_GRADE_STEP = 8;     // 纵剖面采样 / 道路几何重采样步距（米）
// 道路要「随地形起伏」：限坡只挡极端陡坎，不把山地削成缓坡（否则路会变成
// 高出地面十几米的堤坝）。默认 35%，编辑器可调 5~50%。
export const ROAD_MAX_GRADE = 0.35;
export const ROAD_SHOULDER = 8;       // 窄路肩：只平整路面本身，不改造大片地形
// 可见粗底板在道路走廊内的下沉量（米）。仅防共面 z-fighting：可见主地面现在
// 用与路基补丁相同的 8m 全局格点（ADR-0005），二者高度处处吻合，无需大下沉。
// 大下沉只在补丁覆盖不到的边缘造成可见壕沟，故保持微小值。
// ADR-0011：主地面在道路走廊内的下沉量。必须与路基补丁 lift、路面 lift 形成
// 足够垂直余量（>8m 格点曲面与 2m 路面三角面内部插值的最大偏差 ~0.28m），
// 否则补丁三角面从下方顶穿路面 → 锯齿/缺口。下沉 0.42 + 补丁 -0.22 + 路面 0.14
// ⇒ 路面-补丁 0.36m 余量、补丁-主地面 0.20m 仍填平壕沟。
export const ROAD_BED_DROP = 0.42;
// 路基补丁相对逻辑格点曲面的下沉量（city.js 里 bed.position.y = -BED_PATCH_LIFT）。
// 贴地计算用 min(drop, BED_PATCH_LIFT)：补丁覆盖带内可见顶面是补丁（-0.23），
// 补丁外主地面回到 -drop，两者取高者即为脚下实际顶面。
export const BED_PATCH_LIFT = 0.23;
const ROAD_CELL = 64;                 // 走廊段空间索引格边长（米）
const LANE_W = 3.4;                   // 与 cityData.LANE_W 一致（避免反向依赖）
const BED_TESS_EDGE = GROUND_STEP;    // displaceGroup 水平长面细分目标边长（与可见地面同精度，ADR-0005）
const BED_TESS_MAX = 24000;           // 单个几何细分后顶点上限

/* ---------------- 网格 ---------------- */

// 高度场覆盖的地图范围 AABB：多边形 = 顶点包围盒；矩形含旋转
export function terrainBBox(map) {
  const a = map && map.area;
  if (!a) return { x0: -2000, z0: -2000, x1: 2000, z1: 2000 };
  let pts;
  if (Array.isArray(a.pts) && a.pts.length >= 3) {
    pts = a.pts;
  } else {
    const w = (a.w || 4000) / 2, d = (a.d || 4000) / 2;
    const co = Math.cos(a.rot || 0), si = Math.sin(a.rot || 0);
    const cx = a.cx || 0, cz = a.cz || 0;
    pts = [[-w, -d], [w, -d], [w, d], [-w, d]].map(([x, z]) => [cx + x * co + z * si, cz - x * si + z * co]);
  }
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of pts) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  return { x0, z0, x1, z1 };
}

// 生成网格参数（步距自动放大保证网格数不超限）
export function makeTerrainGrid(map, step = TERRAIN_STEP_DEFAULT) {
  const { x0, z0, x1, z1 } = terrainBBox(map);
  step = Math.max(5, step);
  let cols = Math.ceil((x1 - x0) / step) + 1;
  let rows = Math.ceil((z1 - z0) / step) + 1;
  while ((cols > GRID_MAX || rows > GRID_MAX) && step < 500) {
    step *= 2;
    cols = Math.ceil((x1 - x0) / step) + 1;
    rows = Math.ceil((z1 - z0) / step) + 1;
  }
  return { x0: Math.round(x0), z0: Math.round(z0), x1, z1, cols, rows, step };
}

// 校验并返回已有高度场（无/脏数据 → null）
export function ensureTerrain(map) {
  const t = map && map.terrain;
  if (!t || !Array.isArray(t.heights) || !t.heights.length) return null;
  if (!(t.cols > 1) || !(t.rows > 1) || !(t.step > 0)) return null;
  // 旧地图兼容：random 已并入 custom（随机生成 = custom 高度场的一种填充手段）。
  // 就地改写模式，heights/seed/amplitude/scale 原样保留 → 旧随机地形打开即可笔刷雕刻
  if (t.mode === "random") t.mode = "custom";
  // 旧地图兼容：早期 blankTerrain 不写 x1/z1（高度场网格覆盖 bbox，可精确回填），
  // 缺失时编辑器 buildGroundSurface 收到 NaN 直接返回 null → 自定义地形整片无地面
  if (!Number.isFinite(t.x1) || !Number.isFinite(t.z1) || !Number.isFinite(t.x0) || !Number.isFinite(t.z0)) {
    const bb = terrainBBox(map);
    if (!Number.isFinite(t.x0)) t.x0 = Math.round(bb.x0);
    if (!Number.isFinite(t.z0)) t.z0 = Math.round(bb.z0);
    if (!Number.isFinite(t.x1)) t.x1 = bb.x1;
    if (!Number.isFinite(t.z1)) t.z1 = bb.z1;
  }
  return t;
}

/* ---------------- 采样 ---------------- */

// 原始地表高度（不含道路塑形）：双线性插值 + 建筑地基 pads 精确覆盖 / 过渡带
// 平滑混合。范围外按边缘延伸，无地形返回 0。道路设计纵坡由它派生 —— 生成
// 走廊时只读这一层，避免「塑形结果 → heights → 下一轮塑形」的自反馈漂移。
export function baseHeightAt(map, x, z) {
  const t = ensureTerrain(map);
  if (!t) return 0;
  const { x0, z0, cols, rows, step, heights } = t;
  const fx = (x - x0) / step, fz = (z - z0) / step;
  const i = clamp(Math.floor(fx), 0, cols - 2);
  const j = clamp(Math.floor(fz), 0, rows - 2);
  const tx = clamp(fx - i, 0, 1), tz = clamp(fz - j, 0, 1);
  const r0 = j * cols + i, r1 = r0 + cols;
  const h00 = heights[r0], h10 = heights[r0 + 1], h01 = heights[r1], h11 = heights[r1 + 1];
  const field = h00 + (h10 - h00) * tx + (h01 - h00) * tz + (h00 - h10 - h01 + h11) * tx * tz;
  const pads = t.pads;
  if (!pads || !pads.length) return field;
  for (const p of pads) {
    if (x < p.minX || x > p.maxX || z < p.minZ || z > p.maxZ) continue;
    if (pointInPoly(x, z, p.poly)) return p.h;
    const d = distToPoly(x, z, p.poly);
    if (d < p.band) {
      const w = (d / p.band) * (d / p.band) * (3 - 2 * (d / p.band)); // smoothstep 过渡
      return p.h + (field - p.h) * w;
    }
  }
  return field;
}

// 任意点地面高度 = 原始地表 + 道路走廊塑形。3D 编辑器与游戏运行时、静态几何
// 与动态实体全部只读这一个函数，天然保证路面/路基/物件/人物/车辆严丝合缝。
export function terrainHeightAt(map, x, z) {
  if (!ensureTerrain(map)) return 0;
  return roadGradeAt(map, baseHeightAt(map, x, z), x, z);
}

// 折线等距重采样（让道路/河流几何在起伏地形上有足够的顶点密度贴着地形走）
export function resamplePoints(pts, step = 20) {
  if (!pts || pts.length < 2) return pts;
  const out = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    let s = step - acc;
    while (s <= len) {
      const t = s / len;
      out.push({ x: a.x + dx * t, z: a.z + dz * t });
      s += step;
    }
    acc = (acc + len) % step;
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/* ---------------- 道路走廊场地平整（road corridor grading） ----------------
 * 道路与「放置模型」同理：它占的地面必须是一块平整场地；但道路是长条，不能
 * 像建筑地基那样压成一个常数高度，否则整条路会悬在半山腰或切进山体。
 *
 * 算法（道路设计里的纵断面 + 横断面简化）：
 *  1. 收集走廊：描边路 / 拼接路块 / 程序化横纵路网，中心线按 ROAD_GRADE_STEP
 *     等距重采样；取面路（closed）作为整块平整场地（area corridor）。
 *  2. 纵断面：沿中心线采原始地表 → 滑动平均滤掉 40m 网格的折线棱角 →
 *     前向/后向两遍最大纵坡限幅（默认 8%）。得到「随地形起伏但平顺」的
 *     设计高程 profile(s)：保留大尺度地势，消除局部坑洼与折角。
 *  3. 横断面：距中心线 ≤ half（含人行道）恒为 profile(s)，即横坡为 0 的
 *     平整路面；half..half+band 用 smoothstep 平滑接回原始地形（挖填边坡）。
 *  4. 路口 / 多走廊重叠：按权重加权平均，连续无台阶。
 * 结果存进 terrain.corridors（纯数组，随地图 JSON 保存）；terrainHeightAt
 * 现场查询，改地形 / 改道路都重新生成，旧地图无该字段时惰性补齐。
 * ------------------------------------------------------------------------ */

function aabbOf(pts, r) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) {
    const x = Array.isArray(p) ? p[0] : p.x, z = Array.isArray(p) ? p[1] : p.z;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  return { minX: minX - r, maxX: maxX + r, minZ: minZ - r, maxZ: maxZ + r };
}

// 地图数据 → 走廊定义（不依赖 city / 编辑器实例，编辑器与运行时共用一份）
function collectRoadLines(map) {
  const out = [];
  const f = (map && map.features) || {};
  for (const r of f.roads || []) {
    const pts = r.points || [];
    if (pts.length < 2) continue;
    if (r.closed && pts.length >= 3) {
      out.push({ kind: "area", poly: pts, band: ROAD_SHOULDER });
    } else {
      const sw = clamp(r.sidewalk ?? 3, 0, 12);
      out.push({
        kind: "line", band: ROAD_SHOULDER, half: (r.width || 12) / 2 + sw,
        pts: pts.map(([x, z]) => ({ x, z })),
      });
    }
  }
  for (const t of f.roadTiles || []) {
    const len = t.len || 3, w = t.w || 2;
    const s = Math.sin(t.rot || 0), c = Math.cos(t.rot || 0);
    const hl = len / 2 + 1; // 两端各外扩 1m：相邻块的走廊互相搭上，接缝不断
    out.push({
      kind: "line", band: ROAD_SHOULDER, half: w / 2 + 2,
      pts: [{ x: t.x - s * hl, z: t.z - c * hl }, { x: t.x + s * hl, z: t.z + c * hl }],
    });
  }
  const bb = terrainBBox(map), pad = 60;
  const halfOf = (r) => (r.lanes || 1) * LANE_W + (r.median || 0) / 2 + (r.sidewalk || 0);
  const xs = (map.roadsX || []).slice(), zs = (map.roadsZ || []).slice();
  // 程序化延伸街道：与 city.js / 编辑器骨架同源，corridor 才覆盖得到预览里的灰路带
  if (map.extRoads && xs.length && zs.length) {
    let guard = 200;
    while (guard-- > 0 && xs[xs.length - 1].at < bb.x1) {
      const at = xs[xs.length - 1].at + EXT_STEP_X;
      xs.push({ at, ...extRoadSpec(at, EXT_STEP_X) });
    }
    guard = 200;
    while (guard-- > 0 && xs[0].at > bb.x0) {
      const at = xs[0].at - EXT_STEP_X;
      xs.unshift({ at, ...extRoadSpec(at, EXT_STEP_X) });
    }
    guard = 200;
    while (guard-- > 0 && zs[zs.length - 1].at < bb.z1) {
      const at = zs[zs.length - 1].at + EXT_STEP_Z;
      zs.push({ at, ...extRoadSpec(at, EXT_STEP_Z) });
    }
    guard = 200;
    while (guard-- > 0 && zs[0].at > bb.z0) {
      const at = zs[0].at - EXT_STEP_Z;
      zs.unshift({ at, ...extRoadSpec(at, EXT_STEP_Z) });
    }
  }
  for (const r of xs) {
    if (!Number.isFinite(r.at)) continue;
    out.push({
      kind: "line", band: ROAD_SHOULDER, half: halfOf(r),
      pts: [{ x: r.at, z: bb.z0 - pad }, { x: r.at, z: bb.z1 + pad }],
    });
  }
  for (const r of zs) {
    if (!Number.isFinite(r.at)) continue;
    out.push({
      kind: "line", band: ROAD_SHOULDER, half: halfOf(r),
      pts: [{ x: bb.x0 - pad, z: r.at }, { x: bb.x1 + pad, z: r.at }],
    });
  }
  return out;
}

// 最大纵坡约束：前向 + 后向两遍，保证 |Δh/Δs| ≤ maxGrade
function limitSlope(h, s, maxGrade) {
  const n = h.length;
  for (let fwd = 1; fwd >= 0; fwd--) {
    for (let k = fwd ? 1 : n - 2; fwd ? k < n : k >= 0; fwd ? k++ : k--) {
      const a = fwd ? k - 1 : k + 1;
      const lim = maxGrade * (Math.abs(s[k] - s[a]) || ROAD_GRADE_STEP);
      h[k] = clamp(h[k], h[a] - lim, h[a] + lim);
    }
  }
  return h.map((v) => Math.round(v * 100) / 100);
}

// 纵断面平滑：滑动平均去棱角（滤掉 40m 网格折线）+ 最大纵坡限幅
function smoothProfile(raw, s, maxGrade) {
  const n = raw.length;
  let h = raw.slice();
  // 只滤掉高度场 40m 网格的折线棱角（~16m 低通），一遍即可。
  // 大窗口 / 多遍会削峰填谷，把山谷里的路抬成悬浮路堤 —— 用户要的是
  // 「随地形起伏」，所以纵断面基本保留原地表，横断面才做平整。
  const next = new Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0, wsum = 0;
    for (let k = -2; k <= 2; k++) {
      const j = clamp(i + k, 0, n - 1);
      const w = 3 - Math.abs(k);
      sum += h[j] * w; wsum += w;
    }
    next[i] = sum / wsum;
  }
  return limitSlope(next, s, maxGrade);
}

// 路口高程一致性：相交的两条走廊若各自设计高不同，加权融合带内会出现局部陡坡
// （车到路口突然抬头/低头）。按 24m 空间格找跨走廊的邻近采样点，把两者的剖面
// 高度向中间靠拢，两轮松弛且每轮重新限坡 —— 交叉点收敛到同一高程、纵坡仍受限。
function harmonizeJunctions(corridors, maxGrade) {
  const lines = corridors.filter((c) => c.kind === "line");
  if (lines.length < 2) return;
  const cell = ROAD_GRADE_STEP * 3;
  const buckets = new Map();
  const key = (i, j) => i + "," + j;
  for (let ci = 0; ci < lines.length; ci++) {
    const c = lines[ci];
    for (let k = 0; k < c.x.length; k++) {
      const kk = key(Math.floor(c.x[k] / cell), Math.floor(c.z[k] / cell));
      let a = buckets.get(kk);
      if (!a) buckets.set(kk, a = []);
      a.push(ci, k);
    }
  }
  for (let pass = 0; pass < 4; pass++) {
    const delta = lines.map((c) => new Float64Array(c.h.length));
    for (let ci = 0; ci < lines.length; ci++) {
      const c = lines[ci];
      for (let k = 0; k < c.x.length; k++) {
        const i0 = Math.floor(c.x[k] / cell), j0 = Math.floor(c.z[k] / cell);
        let other = null, bd = Infinity;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const a = buckets.get(key(i0 + di, j0 + dj));
            if (!a) continue;
            for (let q = 0; q < a.length; q += 2) {
              const cj = a[q];
              if (cj === ci) continue;
              const o = lines[cj], kk = a[q + 1];
              const d = Math.hypot(c.x[k] - o.x[kk], c.z[k] - o.z[kk]);
              // 阈值放宽到能覆盖相邻拼接路块的接缝（块心间距可达 8m）：
              // 否则每块各自平滑、端点高度对不上，路面就会裂成碎片
              if (d < Math.max(c.half, o.half) * 1.6 && d < bd) { bd = d; other = { o, kk }; }
            }
          }
        }
        if (other) delta[ci][k] = (other.o.h[other.kk] - c.h[k]) * 0.65;
      }
    }
    for (let ci = 0; ci < lines.length; ci++) {
      const c = lines[ci], d = delta[ci];
      for (let k = 0; k < c.h.length; k++) c.h[k] += d[k];
    }
  }
  // 限坡移到全部松弛之后：每轮都限坡会把路口刚收敛的高度差重新吃掉，
  // 交叉点始终对不齐（表现就是「路相交的地方陷下去」）
  for (const c of lines) c.h = limitSlope(c.h, c.s, maxGrade);
}

// 全量重算道路走廊：地形 / 道路 / 地基任一变化后调用（写入 terrain.corridors）
export function buildRoadCorridors(map) {
  const t = ensureTerrain(map);
  if (!t) return null;
  const saved = t.maxGrade;
  // 旧地图里保存的 8% 是上一版默认值：那版把山地硬削成缓坡，路面变成高出
  // 地面十几米的堤坝。这里把旧默认值迁移到「贴地」默认值；用户手动设的
  // 高坡度（>20%）保留。写回后滑杆显示与实际算法一致。
  const maxGrade = clamp(saved && saved > 0.2 ? saved : ROAD_MAX_GRADE, 0.05, 0.5);
  if (maxGrade !== saved) t.maxGrade = maxGrade;
  const corridors = [];
  for (const d of collectRoadLines(map)) {
    if (d.kind === "area") {
      let h = 0;
      for (const [x, z] of d.poly) h += baseHeightAt(map, x, z);
      corridors.push({
        kind: "area", poly: d.poly, band: d.band,
        h: Math.round((h / d.poly.length) * 100) / 100,
        aabb: aabbOf(d.poly, d.band),
      });
      continue;
    }
    const pts = resamplePoints(d.pts, ROAD_GRADE_STEP);
    if (pts.length < 2) continue;
    const s = [0], raw = [], px = [], pz = [];
    for (let i = 0; i < pts.length; i++) {
      if (i) s.push(s[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
      px.push(Math.round(pts[i].x * 100) / 100);
      pz.push(Math.round(pts[i].z * 100) / 100);
      raw.push(baseHeightAt(map, pts[i].x, pts[i].z));
    }
    corridors.push({
      kind: "line", x: px, z: pz, s, h: smoothProfile(raw, s, maxGrade),
      half: d.half, band: d.band, aabb: aabbOf(pts, d.half + d.band),
    });
  }
  harmonizeJunctions(corridors, maxGrade);
  t.corridors = corridors;
  detectJunctions(map, corridors, maxGrade);
  return corridors;
}

// 路口检测：记录每个交叉点中心与其「贴地引道半径」。
// 为什么要贴地：地形陡降段上，limitSlope 会把纵路设计高抬高 20m+，而横穿的
// 缓坡路只抬高几米 —— 两路在交叉点差 16m，谁也拉不齐（纵路自身已用满限坡
// 预算，再降 16m 必然断崖）。但若让路口区域两路都贴回**当前点的原始地形 base**，
// 两条路在交点天然同高（base 是同一个函数），高差从根上消失。
// 引道半径按「路口处 design 与 base 的最大偏离 / 限坡」自适应：偏离越大，引道
// 越长，把高差摊到足够距离上，形成平滑坡度而非断崖。
const JUNCTION_CELL = ROAD_GRADE_STEP * 3;
function detectJunctions(map, corridors, maxGrade) {
  const t = ensureTerrain(map);
  if (!t) return;
  const lines = corridors.filter((c) => c.kind === "line");
  const buckets = new Map();
  for (let ci = 0; ci < lines.length; ci++) {
    const c = lines[ci];
    for (let k = 0; k < c.x.length; k++) {
      const kk = Math.floor(c.x[k] / JUNCTION_CELL) + "," + Math.floor(c.z[k] / JUNCTION_CELL);
      let a = buckets.get(kk);
      if (!a) buckets.set(kk, a = []);
      a.push(ci, k);
    }
  }
  const out = [];
  for (const a of buckets.values()) {
    const cis = new Set();
    for (let q = 0; q < a.length; q += 2) cis.add(a[q]);
    if (cis.size < 2) continue;
    const ids = [...cis];
    for (let p = 0; p < ids.length; p++) {
      for (let q = p + 1; q < ids.length; q++) {
        const A = lines[ids[p]], B = lines[ids[q]];
        let bd = Infinity, bi = -1, bj = -1;
        for (let k = 0; k < a.length; k += 2) {
          if (a[k] !== ids[p]) continue;
          for (let m = 0; m < a.length; m += 2) {
            if (a[m] !== ids[q]) continue;
            const i = a[k + 1], j = a[m + 1];
            const d = Math.hypot(A.x[i] - B.x[j], A.z[i] - B.z[j]);
            if (d < bd) { bd = d; bi = i; bj = j; }
          }
        }
        if (bi < 0 || bd > Math.max(A.half, B.half) * 1.6) continue;
        const mx = (A.x[bi] + B.x[bj]) / 2, mz = (A.z[bi] + B.z[bj]) / 2;
        if (out.some((j) => Math.hypot(j.x - mx, j.z - mz) < JUNCTION_CELL)) continue;
        // 引道半径按「路口附近 design 相对 base 的最大偏离」计算：偏离在引道
        // 入口处最大（可到路口中心的 1.5 倍），用路口中心值会偏小、入口仍留陡坡。
        // 取两条路在路口前后各一段的最大偏离，再留 1.3 余量给 smoothstep 中心
        // 区的额外陡度（smoothstep 最大斜率是平均值的 1.5 倍）。
        let dev = 0;
        for (const c of [A, B]) {
          for (let k = 0; k < c.x.length; k++) {
            const d = Math.hypot(c.x[k] - mx, c.z[k] - mz);
            if (d > 160) continue;
            dev = Math.max(dev, Math.abs(c.h[k] - baseHeightAt(map, c.x[k], c.z[k])));
          }
        }
        // 偏离 0 时仍需小引道覆盖交叉带本身（半宽~12m + 过渡带~8m）
        const r = clamp(dev / maxGrade * 1.3, (A.half + A.band + B.half + B.band) * 1.2, 120);
        out.push({ x: mx, z: mz, r });
      }
    }
  }
  t.junctions = out.length ? out : null;
}

function profileAt(c, s) {
  const arr = c.s, n = arr.length;
  if (s <= arr[0]) return c.h[0];
  if (s >= arr[n - 1]) return c.h[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arr[m] <= s) lo = m; else hi = m; }
  const t = (s - arr[lo]) / (arr[hi] - arr[lo] || 1);
  return c.h[lo] + (c.h[hi] - c.h[lo]) * t;
}

// corridor 段的空间索引（64m 格）：displaceGroup 每次建城要查几十万个顶点，
// 不能每条走廊线性扫段。索引是派生数据，用 WeakMap 惰性缓存、不写进地图 JSON。
const corridorIndexCache = new WeakMap();
function corridorIndex(t) {
  const cs = t.corridors;
  let idx = corridorIndexCache.get(cs);
  if (idx) return idx;
  const buckets = new Map();
  const register = (ci, si, bb) => {
    const i0 = Math.floor(bb.minX / ROAD_CELL), i1 = Math.floor(bb.maxX / ROAD_CELL);
    const j0 = Math.floor(bb.minZ / ROAD_CELL), j1 = Math.floor(bb.maxZ / ROAD_CELL);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = i + "," + j;
        let a = buckets.get(k);
        if (!a) buckets.set(k, a = []);
        a.push(ci, si);
      }
    }
  };
  for (let ci = 0; ci < cs.length; ci++) {
    const c = cs[ci];
    if (c.kind === "area") { register(ci, -1, c.aabb); continue; }
    const r = c.half + c.band;
    for (let si = 0; si + 1 < c.x.length; si++) {
      register(ci, si, {
        minX: Math.min(c.x[si], c.x[si + 1]) - r, maxX: Math.max(c.x[si], c.x[si + 1]) + r,
        minZ: Math.min(c.z[si], c.z[si + 1]) - r, maxZ: Math.max(c.z[si], c.z[si + 1]) + r,
      });
    }
  }
  idx = { buckets };
  corridorIndexCache.set(cs, idx);
  return idx;
}

// 同一走廊在 64m 索引格里往往有多段候选（远多于 8m 采样步距）。若逐段累加，
// 相邻段的剖面值会被平均进路面，横断面反而不再绝对水平 —— 每条走廊只取最近
// 段的一次贡献。模块级复用数组 + stamp，避免几十万次顶点查询时反复分配对象。
const _qSeen = [], _qW = [], _qD = [], _qDist = [], _qTouched = [];
let _qStamp = 0;
function gradeQuery(map, x, z) {
  const t = ensureTerrain(map);
  if (!t) return null;
  if (t.corridors === undefined) buildRoadCorridors(map); // 旧地图 / 新采样源文件兜底
  const cs = t.corridors;
  if (!cs || !cs.length) return null;
  const bucket = corridorIndex(t).buckets.get(Math.floor(x / ROAD_CELL) + "," + Math.floor(z / ROAD_CELL));
  if (!bucket) return null;
  const stamp = ++_qStamp;
  _qTouched.length = 0;
  for (let k = 0; k < bucket.length; k += 2) {
    const ci = bucket[k], si = bucket[k + 1], c = cs[ci];
    let w = 0, design = 0, d = 0;
    if (c.kind === "area") {
      if (pointInPoly(x, z, c.poly)) { w = 1; d = 0; }
      else {
        d = distToPoly(x, z, c.poly);
        if (d < c.band) { const u = d / c.band; w = 1 - u * u * (3 - 2 * u); }
      }
      design = c.h;
    } else {
      const ax = c.x[si], az = c.z[si], bx = c.x[si + 1], bz = c.z[si + 1];
      const dx = bx - ax, dz = bz - az;
      const len2 = dx * dx + dz * dz || 1;
      const u = clamp(((x - ax) * dx + (z - az) * dz) / len2, 0, 1);
      d = Math.hypot(x - (ax + dx * u), z - (az + dz * u));
      if (d <= c.half) w = 1;
      else if (d < c.half + c.band) { const q = (d - c.half) / c.band; w = 1 - q * q * (3 - 2 * q); }
      else continue;
      design = profileAt(c, c.s[si] + (c.s[si + 1] - c.s[si]) * u);
    }
    if (w <= 0) continue;
    if (_qSeen[ci] !== stamp) {
      _qSeen[ci] = stamp; _qW[ci] = w; _qD[ci] = design; _qDist[ci] = d;
      _qTouched.push(ci);
    } else if (w > _qW[ci] || (w === _qW[ci] && d < _qDist[ci])) {
      _qW[ci] = w; _qD[ci] = design; _qDist[ci] = d;
    }
  }
  let wsum = 0, acc = 0, maxW = 0;
  for (let k = 0; k < _qTouched.length; k++) {
    const ci = _qTouched[k], w = _qW[ci];
    wsum += w; acc += w * _qD[ci];
    if (w > maxW) maxW = w;
  }
  return wsum > 0 ? { wsum, acc, maxW } : null;
}

// 道路塑形后的高度：走廊内取设计纵坡，过渡带按 smoothstep 混合回原始地表；
// 多条走廊重叠（路口）取加权平均。
//
// 路口贴地（detectJunctions 提供引道半径）：陡降段上纵路 design 比 base 高
// 20m+，横穿缓坡路只高几米，两者差 16m 且纵路已用满限坡预算无法拉齐 —— 旧版
// 在 wsum 1→1.6 的窄带里强制回退 base，一跳 22m（用户截图「十字路口塌陷」）。
// 新版：在路口半径内按 smoothstep 把加权设计高平滑混向 base，两条路在交点读
// 同一个 base 天然同高；引道半径按高差/限坡自适应，把高差摊到足够距离上，
// 坡度始终受限、无断崖。
export function roadGradeAt(map, base, x, z) {
  const q = gradeQuery(map, x, z);
  if (!q) return base;
  let graded = base + (q.acc - q.wsum * base) / Math.max(1, q.wsum);
  const t = ensureTerrain(map);
  if (t && t.junctions) {
    for (const j of t.junctions) {
      const d = Math.hypot(x - j.x, z - j.z);
      if (d >= j.r) continue;
      const u = d / j.r;
      const w = 1 - u * u * (3 - 2 * u); // 中心 1（完全贴地）→ 边缘 0（完全设计高）
      graded += (base - graded) * w;
      break;
    }
  }
  return graded;
}

// 走廊影响权重（0 = 原始地形，1 = 路基核心）：路基网格范围 / 底板下沉量共用
export function corridorWeightAt(map, x, z) {
  const q = gradeQuery(map, x, z);
  return q ? q.maxW : 0;
}

// 粗网格地形底板在路基处下沉：让路面 / 标线 / 路基网格永远盖在底板之上，
// 彻底消除「道路被地形三角形吞掉 → 显示断断续续」。下沉只作用于底板顶点，
// 逻辑高度（terrainHeightAt）不变，人物 / 车辆 / 物件不受影响。
export function roadBedDropAt(map, x, z) {
  if (!ensureTerrain(map)) return 0;
  const q = gradeQuery(map, x, z);
  return q ? ROAD_BED_DROP * q.maxW : 0;
}

// 动态实体统一贴地：按「实际可见顶面」分层取高（与静态几何的层叠常量一致）。
// 层叠模型（ADR-0011）：逻辑格点曲面 gridHeightAt 之上，主地面/路基补丁在走廊带
// 内下沉（主地面 -drop、补丁 -0.23），描边路条带 +0.18 / 拼接路条带 +0.19 /
// 人行道条带 +0.24 / 街廓平台 +0.16。
// - 默认（无条带覆盖）：主地面/补丁顶面 = grid - min(drop, 0.23)。贴逻辑高会在
//   程序化路上恒浮 0.23m、路肩浮 0.2~0.4m（实测截图确认）。
// - 描边路 / 拼接路条带：量到中心线距离（闭合板走廊的 segs 是周长，量周长会把
//   板边外的路肩误判成路面）。
export function surfaceHeightAt(map, x, z, city) {
  const th = gridHeightAt(map, x, z);
  if (!city) return th;
  const corridors = city.traceCorridors;
  if (corridors && corridors.length) {
    let best = Infinity, bestC = null;
    for (const c of corridors) {
      const segs = c.centerSegs || c.segs;
      if (!c._aabb) c._aabb = aabbOf(segs.flatMap((s) => [[s.ax, s.az], [s.bx, s.bz]]), c.edgeHalf + 1);
      const bb = c._aabb;
      if (x < bb.minX || x > bb.maxX || z < bb.minZ || z > bb.maxZ) continue;
      for (const s of segs) {
        const dx = s.bx - s.ax, dz = s.bz - s.az;
        const len2 = dx * dx + dz * dz;
        const u = clamp(len2 ? ((x - s.ax) * dx + (z - s.az) * dz) / len2 : 0, 0, 1);
        const d = Math.hypot(x - (s.ax + dx * u), z - (s.az + dz * u));
        if (d < best) { best = d; bestC = c; }
      }
    }
    if (bestC) {
      if (best <= bestC.roadHalf) return th + 0.18;
      if (bestC.sidewalk && best <= bestC.edgeHalf) return th + 0.24;
    }
  }
  for (const b of city.blocks || []) {
    if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) return th + 0.16;
  }
  return th - Math.min(roadBedDropAt(map, x, z), BED_PATCH_LIFT);
}

/* ---------------- 随机地形（种子化分形值噪声） ---------------- */

function hash2(ix, iz, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise2(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const tx = x - ix, tz = z - iz;
  const sx = tx * tx * (3 - 2 * tx), sz = tz * tz * (3 - 2 * tz);
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

// 生成随机高度场：4 层 fbm（scale = 主起伏波长 m，amplitude = 峰谷幅度 m），
// 范围边缘平滑回落到基础高度 base（防止世界边界出现断崖，也方便向外扩展平地）。
// mode = custom：随机生成只是自定义地形的一种填充手段，生成后可继续笔刷雕刻；
// seed/amplitude/scale/baseHeight 留在地形对象上供面板回显与重新生成
export function generateRandomTerrain(map, { seed = 1, amplitude = 60, scale = 500, base = 0, step = TERRAIN_STEP_DEFAULT } = {}) {
  const g = makeTerrainGrid(map, step);
  const { x0, z0, x1, z1, cols, rows } = g;
  const fall = clamp(Math.min(x1 - x0, z1 - z0) * 0.15, 120, 400); // 边缘衰减带宽
  const amp = clamp(amplitude, 2, 500);
  const wl = clamp(scale, 60, 4000); // 主波长（原局部变量 base，避免与新参数重名改名）
  const heights = new Array(cols * rows);
  let k = 0;
  for (let j = 0; j < rows; j++) {
    const z = z0 + j * g.step;
    for (let i = 0; i < cols; i++, k++) {
      const x = x0 + i * g.step;
      let h = 0, f = 1, a = 1, norm = 0;
      for (let o = 0; o < 4; o++) {
        h += noise2(x / (wl / f), z / (wl / f), seed + o * 101) * a;
        norm += a;
        f *= 2; a *= 0.5;
      }
      h = (h / norm - 0.5) * 2; // 归一到 [-1,1]
      const de = Math.min(x - x0, x1 - x, z - z0, z1 - z);
      const t = de >= fall ? 1 : de <= 0 ? 0 : (de / fall) * (de / fall) * (3 - 2 * (de / fall));
      heights[k] = Math.round((base + h * amp * t) * 10) / 10;
    }
  }
  return { mode: "custom", seed: seed | 0, amplitude: amp, scale: wl, baseHeight: base, ...g, heights, originH: 0 };
}

// 空白高度场（custom 笔刷雕刻 / real 采样前的容器）：
// heights 全部填基础高度 base（编辑器自定义默认 10m 平地，可负 = 盆地）。
// x0/z0/x1/z1 必须齐全（编辑器主地面按它取范围，缺 x1/z1 → NaN → 地面消失）
export function blankTerrain(map, mode = "custom", step = TERRAIN_STEP_DEFAULT, base = 0) {
  const g = makeTerrainGrid(map, step);
  return { mode, step: g.step, x0: g.x0, z0: g.z0, x1: g.x1, z1: g.z1, cols: g.cols, rows: g.rows, heights: new Array(g.cols * g.rows).fill(base), baseHeight: base, originH: 0 };
}

/* ---------------- 自定义笔刷 ---------------- */

// 单章盖章：以 (x,z) 为中心、radius 内按平滑衰减修改 heights。
// mode: raise 抬升 / lower 下压（strength = 米）；flatten 抹平到中心高度 / smooth 平滑（strength = 0~1 混合系数）
export function applyBrush(map, x, z, { mode = "raise", radius = 60, strength = 1 } = {}) {
  const t = ensureTerrain(map);
  if (!t) return false;
  const { x0, z0, cols, rows, step, heights } = t;
  // 笔刷范围内清除地基 pad（否则 pad 精确覆盖笔刷的雕刻结果）；笔画结束时
  // 编辑器会全量重算建筑地基（applyObjectPads），pad 随新地形重新生成
  if (t.pads && t.pads.length) {
    const padR = Math.max(5, radius) + 40; // + 过渡带余量
    t.pads = t.pads.filter((p) => x + padR < p.minX || x - padR > p.maxX || z + padR < p.minZ || z - padR > p.maxZ);
    if (!t.pads.length) t.pads = null;
  }
  const r = Math.max(5, radius);
  const i0 = Math.max(0, Math.floor((x - r - x0) / step)), i1 = Math.min(cols - 1, Math.ceil((x + r - x0) / step));
  const j0 = Math.max(0, Math.floor((z - r - z0) / step)), j1 = Math.min(rows - 1, Math.ceil((z + r - z0) / step));
  const target = baseHeightAt(map, x, z); // flatten 的目标 = 中心当前原始地表高度
  let changed = false;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const px = x0 + i * step, pz = z0 + j * step;
      const d = Math.hypot(px - x, pz - z);
      if (d > r) continue;
      const t01 = 1 - d / r;
      const w = t01 * t01 * (3 - 2 * t01); // smoothstep 衰减（笔刷边缘无台阶）
      const idx = j * cols + i;
      const h = heights[idx];
      let nh = h;
      if (mode === "raise") nh = h + strength * w;
      else if (mode === "lower") nh = h - strength * w;
      else if (mode === "flatten") nh = h + (target - h) * clamp(strength, 0, 1) * w;
      else if (mode === "smooth") {
        const l = i > 0 ? heights[idx - 1] : h, rgt = i < cols - 1 ? heights[idx + 1] : h;
        const up = j > 0 ? heights[idx - cols] : h, dn = j < rows - 1 ? heights[idx + cols] : h;
        const avg = (l + rgt + up + dn) / 4;
        nh = h + (avg - h) * clamp(strength, 0, 1) * w;
      }
      nh = Math.round(nh * 100) / 100;
      if (nh !== h) { heights[idx] = nh; changed = true; }
    }
  }
  return changed;
}

// 笔刷笔画：from → to 沿线按 radius/4 间隔连续盖章（快速拖动不留断点）
export function brushStamp(map, from, to, opts) {
  if (!from) return applyBrush(map, to.x, to.z, opts);
  const d = Math.hypot(to.x - from.x, to.z - from.z);
  const stepLen = Math.max(2, (opts.radius || 60) / 4);
  const n = Math.max(1, Math.ceil(d / stepLen));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    applyBrush(map, from.x + (to.x - from.x) * t, from.z + (to.z - from.z) * t, opts);
  }
}

/* ---------------- 场地平整（建筑地基 pad / site grading） ---------------- */

// 点是否在多边形内（射线法）
function pointInPoly(x, z, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], zi = pts[i][1], xj = pts[j][0], zj = pts[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
// 点到多边形边界的最短距离
function distToPoly(x, z, pts) {
  let best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], zi = pts[i][1], xj = pts[j][0], zj = pts[j][1];
    const dx = xj - xi, dz = zj - zi;
    const len2 = dx * dx + dz * dz || 1;
    const tt = Math.min(1, Math.max(0, ((x - xi) * dx + (z - zi) * dz) / len2));
    best = Math.min(best, Math.hypot(x - (xi + dx * tt), z - (zi + dz * tt)));
  }
  return best;
}

// 单块地基平整：footprint 绕形心放大 sqrt(factor)（面积 = 占地面积 × factor）
// 生成 pad 多边形，登记进 terrain.pads（terrainHeightAt 精确查询：pad 内恒为
// 角点平均高度、过渡带平滑衔接原地形）；同时把近似值烙进 heights 网格保持
// 粗粒度一致（笔刷交互底数）。专业地图工具的 site grading 做法：坡地建筑
// 不再陷入地面，且不依赖网格步距（网格 40m >> 建筑尺寸也能精确压平）。
export function flattenPad(map, fp, factor = 1.4) {
  const t = ensureTerrain(map);
  if (!t || !fp || fp.length < 3) return false;
  // 鞋带公式：面积与形心
  let a2 = 0, cx = 0, cz = 0;
  for (let i = 0; i < fp.length; i++) {
    const x1 = fp[i][0], z1 = fp[i][1], x2 = fp[(i + 1) % fp.length][0], z2 = fp[(i + 1) % fp.length][1];
    const cross = x1 * z2 - x2 * z1;
    a2 += cross;
    cx += (x1 + x2) * cross;
    cz += (z1 + z2) * cross;
  }
  const area = Math.abs(a2) / 2;
  if (area < 4 || !a2) return false;
  cx /= 3 * a2; cz /= 3 * a2;
  // pad 高度 = footprint 角点地形高度的平均值（建筑四角贴地）
  let padH = 0;
  for (const [x, z] of fp) padH += terrainHeightAt(map, x, z);
  padH = Math.round((padH / fp.length) * 100) / 100;
  const s = Math.sqrt(Math.max(1, factor));
  const poly = fp.map(([x, z]) => [cx + (x - cx) * s, cz + (z - cz) * s]);
  const band = clamp(Math.sqrt(area) * 0.4, 6, 30); // 过渡带宽度（米）
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of poly) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  minX -= band; maxX += band; minZ -= band; maxZ += band;
  if (!Array.isArray(t.pads)) t.pads = [];
  t.pads.push({ poly, band, h: padH, minX, maxX, minZ, maxZ });
  // 近似烙进 heights 网格（粗粒度一致：笔刷/面板高差统计可见平整效果）
  const bi0 = Math.max(0, Math.floor((minX - t.x0) / t.step)), bi1 = Math.min(t.cols - 1, Math.ceil((maxX - t.x0) / t.step));
  const bj0 = Math.max(0, Math.floor((minZ - t.z0) / t.step)), bj1 = Math.min(t.rows - 1, Math.ceil((maxZ - t.z0) / t.step));
  for (let j = bj0; j <= bj1; j++) {
    const z = t.z0 + j * t.step;
    for (let i = bi0; i <= bi1; i++) {
      const x = t.x0 + i * t.step;
      const h = baseHeightAt(map, x, z); // 只烙 pad（不烙道路设计高），保持原始高度场不被塑形污染
      const idx = j * t.cols + i;
      const hv = Math.round(h * 100) / 100;
      if (t.heights[idx] !== hv) { t.heights[idx] = hv; }
    }
  }
  return true;
}

// 世界坐标 footprint（与运行时 footprintAABB 同一变换约定：pos + rot）
function worldFootprint(o) {
  const fp = o && o.params && o.params.footprint;
  if (!fp || fp.length < 3 || !o.pos) return null;
  const c = Math.cos(o.rot || 0), s = Math.sin(o.rot || 0);
  return fp.map(([x, z]) => [o.pos[0] + x * c + z * s, o.pos[1] - x * s + z * c]);
}

// 全量重算一批建筑对象的地基：先清空旧 pads（移动/旋转/删除后旧 pad 不残留），
// 再逐建筑登记。最后按新地形/新地基重算道路走廊（地基是 baseHeightAt 的一部分，
// 道路设计纵坡必须跟着更新）。返回是否登记了任何 pad。
export function flattenPadsForObjects(map, objects, factor = 1.4) {
  const t = ensureTerrain(map);
  if (!t || !Array.isArray(objects)) return false;
  t.pads = [];
  t.corridors = null; // 显式清空：地基生成期间不触发惰性重建，避免旧走廊参与采样
  let any = false;
  for (const o of objects) {
    const fp = worldFootprint(o);
    if (fp && flattenPad(map, fp, factor)) any = true;
  }
  if (!t.pads.length) t.pads = null;
  buildRoadCorridors(map);
  return any;
}

/* ---------------- 运行时整体贴地 ---------------- */

// 水平长面细分：长标线 / 路块 / 街区平台 / 取面路往往只有 4~8 个顶点，逐顶点
// 贴地时中段仍是直线插值，在纵坡上会被路基吞掉（表现为标线/路面断断续续）。
// 按最长水平边二分到 ≤ BED_TESS_EDGE，让每个顶点都采到真实设计高程；
// 垂直墙面不细分（避免楼体顶点数暴涨）。所有顶点属性（uv/normal/color）一并插值。
export function tessellateFlat(geo, maxEdge, maxVerts) {
  const src = geo.attributes.position;
  // 大网格（地面底板 / 路基补丁）已足够密或另由路基补丁处理，不再细分
  if (!src || src.count < 3 || src.count > Math.min(maxVerts, 6000)) return geo;
  const specs = [];
  let stride = 0;
  for (const name of Object.keys(geo.attributes)) {
    const a = geo.attributes[name];
    if (!a || !a.itemSize) continue;
    specs.push({ name, size: a.itemSize, off: stride });
    stride += a.itemSize;
  }
  const p = specs.find((s) => s.name === "position");
  if (!p || p.size < 3) return geo;
  const read = (vi) => {
    const v = new Array(stride);
    for (const s of specs) {
      const a = geo.attributes[s.name];
      for (let k = 0; k < s.size; k++) {
        v[s.off + k] = a.getComponent ? a.getComponent(vi, k) : a.array[vi * s.size + k];
      }
    }
    return v;
  };
  const idx = geo.index ? geo.index.array : null;
  const triCount = Math.floor((idx ? idx.length : src.count) / 3);
  let tris = [];
  for (let i = 0; i < triCount; i++) {
    tris.push([
      read(idx ? idx[i * 3] : i * 3),
      read(idx ? idx[i * 3 + 1] : i * 3 + 1),
      read(idx ? idx[i * 3 + 2] : i * 3 + 2),
    ]);
  }
  const e2 = (u, v) => {
    const dx = u[p.off] - v[p.off], dz = u[p.off + 2] - v[p.off + 2];
    return dx * dx + dz * dz;
  };
  const flat = (t) => Math.abs(t[0][p.off + 1] - t[1][p.off + 1]) < 0.35 &&
    Math.abs(t[1][p.off + 1] - t[2][p.off + 1]) < 0.35 &&
    Math.abs(t[2][p.off + 1] - t[0][p.off + 1]) < 0.35;
  const max2 = maxEdge * maxEdge;
  let changed = false;
  for (let round = 0; round < 10; round++) {
    let need = false;
    for (const t of tris) {
      if (flat(t) && Math.max(e2(t[0], t[1]), e2(t[1], t[2]), e2(t[2], t[0])) > max2) { need = true; break; }
    }
    if (!need || tris.length * 6 > maxVerts) break;
    const next = [];
    for (const t of tris) {
      if (!flat(t)) { next.push(t); continue; }
      const [a, b, c] = t;
      const eab = e2(a, b), ebc = e2(b, c), eca = e2(c, a);
      if (Math.max(eab, ebc, eca) <= max2) { next.push(t); continue; }
      let u, v, w;
      if (eab >= ebc && eab >= eca) { u = a; v = b; w = c; }
      else if (ebc >= eca) { u = b; v = c; w = a; }
      else { u = c; v = a; w = b; }
      const m = u.map((val, k) => (val + v[k]) / 2);
      next.push([u, m, w], [m, v, w]); // 循环置换保持绕序 → 法线仍朝上
    }
    tris = next;
    changed = true;
  }
  if (!changed) return geo;
  const g = new THREE.BufferGeometry();
  const total = tris.length * 3;
  for (const s of specs) {
    const arr = new Float32Array(total * s.size);
    let k = 0;
    for (const t of tris) for (const v of t) for (let q = 0; q < s.size; q++) arr[k++] = v[s.off + q];
    g.setAttribute(s.name, new THREE.BufferAttribute(arr, s.size));
  }
  g.userData = { ...(geo.userData || {}) };
  return g;
}

// 把组内所有静态烘焙网格按高度场顶起（three.js 顶点位移）：
// 道路/河流/建筑/标线/街区平台等几何为各特征独享（逐顶点位移安全）；
// 树/路灯/模型资产实例的几何与模板缓存共享（不能逐顶点改），由调用方在实例
// 根节点整体抬升并打 userData.terrainRoot 标记，这里跳过其子树。
// terrainBed 标记的粗网格大地面额外下沉，避免吞掉平整路面；位移后重算包围球。
export function displaceGroup(map, group, opts = {}) {
  const t = ensureTerrain(map);
  if (!t || !group) return false;
  if (t.corridors === undefined) buildRoadCorridors(map);
  group.updateMatrixWorld(true);
  const wp = new THREE.Vector3();
  const inv = new THREE.Matrix4();
  group.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    let geo = o.geometry;
    if (!geo.attributes.position) return;
    if (geo.userData && geo.userData.shared) return;
    for (let p = o.parent; p; p = p.parent) {
      if (p.userData && p.userData.terrainRoot) return;
    }
    if (t.corridors && t.corridors.length) {
      const ng = tessellateFlat(geo, BED_TESS_EDGE, BED_TESS_MAX);
      if (ng !== geo) { o.geometry = ng; geo = ng; }
    }
    const bed = !!(o.userData && o.userData.terrainBed);
    inv.copy(o.matrixWorld).invert();
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      wp.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(o.matrixWorld);
      // 顶起采样 gridHeightAt（ADR-0009 渲染曲面）而非连续 terrainHeightAt：
      // 远景大地面 / 地形网格被细分到 ~8m 但相位与全局格网错开，按连续场顶起
      // 仍是"另一张"分段线性曲面，凸坡上比格点曲面低最多 ~0.4m —— 人物按格点
      // 曲面贴地就会在这些地方浮空。格点上两函数同值，主地面 / 补丁不受影响。
      wp.y += gridHeightAt(map, wp.x, wp.z) - (bed ? roadBedDropAt(map, wp.x, wp.z) : 0);
      wp.applyMatrix4(inv);
      pos.setXYZ(i, wp.x, wp.y, wp.z);
    }
    pos.needsUpdate = true;
    geo.computeBoundingSphere();
    // 位移后重算法线：大地面/山丘才有正确的光照明暗（默认关，网格大时一次
    // computeVertexNormals 有成本；地面等关键网格用 userData.terrainNormals 标记）
    if (opts.computeNormals || (o.userData && o.userData.terrainNormals)) geo.computeVertexNormals();
  });
  return true;
}

/* ---------------- 可见地面（与路基补丁同相位的全局格点） ---------------- */

// 生成覆盖 [x0,x1]×[z0,z1] 的全局格点地面网格，格点落在 step 的整数倍上
// （与 buildRoadBedGeometry 完全同相位）。顶点 y=0，由 displaceGroup / 编辑器
// _bendArea 按世界坐标采样 terrainHeightAt 顶起。
// 关键（ADR-0005）：可见主地面必须与 8m 路基补丁共用同一套格点。否则在地形
// ADR-0009：8m 全局格点的「渲染曲面」高度 —— 与 buildGroundSurface /
// buildRoadBedGeometry 的三角剖分 (a,c,b / b,c,d) 完全一致。
// 主地面与路基补丁都是这套格点网格：顶点采样 terrainHeightAt，格点之间按
// 三角形线性插值。路面条带必须采样这同一张曲面（而非连续 terrainHeightAt），
// 否则两套相位不同的 8m 三角网格各自插值同一高度函数，插值曲面互相穿插，
// 补丁三角面会从下方顶穿路面 → 规则的菱形/三角缺口（实测穿插 27%、深 1m）。
// polygonOffset 只改深度不改几何，无法解决；抬高 lift 也压不干净。
export function gridHeightAt(map, x, z, step = GROUND_STEP) {
  const i = Math.floor(x / step), j = Math.floor(z / step);
  const u = x / step - i, v = z / step - j;
  const h00 = terrainHeightAt(map, i * step, j * step);
  const h10 = terrainHeightAt(map, (i + 1) * step, j * step);
  const h01 = terrainHeightAt(map, i * step, (j + 1) * step);
  const h11 = terrainHeightAt(map, (i + 1) * step, (j + 1) * step);
  return u + v <= 1
    ? h00 * (1 - u - v) + h01 * v + h10 * u
    : h11 * (u + v - 1) + h01 * (1 - u) + h10 * (1 - v);
}

// 凹曲面，两者各自的分段线性插值曲面互相穿插，粗者从下方顶穿补丁与路面，
// 实测可高出 3.6m，表现就是「深绿底板盖住道路 / 路面断断续续」。
export function buildGroundSurface(x0, z0, x1, z1, step = GROUND_STEP, tile = 16, clipPoly = null) {
  // 极大地图保护：顶点超上限时自动放粗步距（8→16→…→512m）保住可见地形面。
  // 正常跨度（≤1.7 万米）在 8m 档从不触发，不影响 ADR-0005 的路基补丁同相位；
  // 超限地图上粗地面与补丁的插值差可能顶穿路面——属可接受的降级（总比没有地形面好）
  while (step < 512 && (Math.ceil((x1 - x0) / step) + 2) * (Math.ceil((z1 - z0) / step) + 2) > 800000) step *= 2;
  const i0 = Math.floor(x0 / step), i1 = Math.ceil(x1 / step);
  const j0 = Math.floor(z0 / step), j1 = Math.ceil(z1 / step);
  const cols = i1 - i0 + 1, rows = j1 - j0 + 1;
  const count = cols * rows;
  if (count < 4 || count > 800000) return null; // 极端范围保护：过大交给调用方降级
  const pos = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  let k = 0;
  for (let j = 0; j < rows; j++) {
    const z = (j0 + j) * step;
    for (let i = 0; i < cols; i++, k++) {
      const x = (i0 + i) * step;
      pos[k * 3] = x; pos[k * 3 + 1] = 0; pos[k * 3 + 2] = z;
      uv[k * 2] = x / tile; uv[k * 2 + 1] = z / tile;
    }
  }
  // clipPoly（世界坐标 [[x,z]...]）：格点网格保持全局同相（顶点不动，与路基补丁
  // 共享格点），只丢弃中心在多边形外的格子 → 地形面只铺在地图范围内。
  // 顶点保留全集是为了与 buildRoadBedGeometry 同相位（ADR-0005），不能裁顶点。
  const inPoly = clipPoly && clipPoly.length >= 3
    ? (x, z) => pointInPoly(x, z, clipPoly)
    : null;
  const idx = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let t = 0;
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      if (inPoly && !inPoly((i0 + i + 0.5) * step, (j0 + j + 0.5) * step)) continue;
      const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
      idx[t++] = a; idx[t++] = c; idx[t++] = b; // 俯视 CCW → 法线朝上
      idx[t++] = b; idx[t++] = c; idx[t++] = d;
    }
  }
  if (!t) return null; // 裁剪后无格子（多边形不与范围相交）
  // 裁剪丢弃了尾部格子 → 索引数组截断到实际用量（尾部 0 会变成退化三角形）
  const index = t === idx.length ? idx : idx.slice(0, t);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeVertexNormals();
  return g;
}

/* ---------------- 道路路基补丁网格 ---------------- */

// 地形大底板只有 128×128（~31m）/ 32~128 段（~50m）分辨率，表达不了十米宽的
// 道路走廊：粗三角形会把平整路面吞掉，这正是「道路穿地形 / 断断续续」的根因。
// 这里按 ROAD_GRADE_STEP 生成一张覆盖所有走廊影响范围的高密度地表补丁：
//  - 格点去重（全局 Set）→ 路口 / 多走廊重叠处不会生成共面重叠面片；
//  - 外扩一圈格点 → 补丁外缘与未下沉的原始地形同高，接缝无台阶；
//  - 顶点 y 先置 0，由编辑器 _bendArea / 运行时 displaceGroup 按世界坐标统一
//    采样 terrainHeightAt 顶起，与路面 / 路基 / 实体共享同一个高度权威。
export function buildRoadBedGeometry(map, tile = 16) { // 默认 = ASPHALT_TILE
  const t = ensureTerrain(map);
  if (!t) return null;
  if (t.corridors === undefined) buildRoadCorridors(map);
  const cs = t.corridors;
  if (!cs || !cs.length) return null;
  const step = ROAD_GRADE_STEP;
  const key = (i, j) => i + "," + j;
  const hot = new Set();
  for (const c of cs) {
    const bb = c.aabb;
    const i0 = Math.floor(bb.minX / step), i1 = Math.ceil(bb.maxX / step);
    const j0 = Math.floor(bb.minZ / step), j1 = Math.ceil(bb.maxZ / step);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const q = gradeQuery(map, i * step, j * step);
        if (q && q.maxW > 0) hot.add(key(i, j));
      }
    }
  }
  if (!hot.size) return null;
  // 外扩两圈（16m）：粗底板三角形跨越补丁边界时，外圈顶点仍与未下沉的
  // 原始地形同高，接缝不露台阶、也不会在路侧留下可见的下沉带
  const all = new Set(hot);
  let ring = [...hot];
  for (let pass = 0; pass < 2; pass++) {
    const next = [];
    for (const k of ring) {
      const [i, j] = k.split(",").map(Number);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const kk = key(i + di, j + dj);
          if (!all.has(kk)) { all.add(kk); next.push(kk); }
        }
      }
    }
    ring = next;
  }
  const pos = [], uv = [], idx = [], idOf = new Map();
  let n = 0;
  for (const k of all) {
    const [i, j] = k.split(",").map(Number);
    const x = i * step, z = j * step;
    pos.push(x, 0, z);
    uv.push(x / tile, z / tile);
    idOf.set(k, n++);
  }
  for (const k of all) {
    const [i, j] = k.split(",").map(Number);
    const a = idOf.get(k), b = idOf.get(key(i + 1, j));
    const c = idOf.get(key(i, j + 1)), d = idOf.get(key(i + 1, j + 1));
    if (b === undefined || c === undefined || d === undefined) continue;
    idx.push(a, c, b, b, c, d); // 俯视逆时针 → 法线朝上
  }
  if (!idx.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
