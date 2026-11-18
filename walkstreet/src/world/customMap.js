// 3D 编辑器描边内容（features.roads/rivers + objects 建筑/树/路灯）→ 运行时世界网格。
// 编辑器数据为局部平面米制坐标，运行时世界同为平面坐标，直接按坐标构建；
// 与编辑器渲染语义保持一致：建筑 = footprint（相对 pos 的局部坐标）+ pos 平移 + rot 旋转。
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { mapBounds } from "../data/cityData.js";
import { getMaterial, scaleUVs, uvScaleFor, FACADE_UV, ROOF_UV } from "./materials.js";
import { assetInstance, assetWorldAABB } from "./assetMesh.js";
import { ASPHALT_TILE, makeAsphaltTexture, makeRoadTileTexture } from "./textures.js";

const wallMat = () => new THREE.MeshStandardMaterial({ color: 0xb8b2a6, roughness: 0.85 });
const roofMat = () => new THREE.MeshStandardMaterial({ color: 0x6f6a60, roughness: 0.9 });
// 描边路面：与程序化横纵路用同一张沥青贴图（色板一致），uv 由 planarUV 按世界米制生成
let asphaltMat = null;
function roadMat() {
  if (!asphaltMat) {
    asphaltMat = new THREE.MeshStandardMaterial({
      map: makeAsphaltTexture(), color: 0xffffff, roughness: 0.95, metalness: 0.0,
    });
  }
  return asphaltMat;
}
const sidewalkMat = () => new THREE.MeshStandardMaterial({ color: 0x9aa2ab, roughness: 0.92 });
// 拼接式路块材质：整块贴图（含路缘石/标线），UV 0..1，按尺寸+样式缓存
const tileMatCache = new Map();
function roadTileMat(len, w, style, lanes) {
  const key = `${len}x${w}:${style}:${lanes}`;
  let m = tileMatCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      map: makeRoadTileTexture(len, w, style, lanes), roughness: 0.94, metalness: 0,
    });
    tileMatCache.set(key, m);
  }
  return m;
}
// 同尺寸路块共享几何已由 rtTileQuadGeometry 按端头参数逐块生成取代
// （端头取决于相邻块，无法按尺寸共享；单块几十个顶点，开销可忽略）
/* ---------------- 拼接路块转角对接（圆弧转角 / 端头斜切 miter / 平口焊接） ---------------- */
// 矩形路块按角度拼接时，弯道外侧出现楔形缺口、内侧两块互相重叠（路缘石与
// 边线在重叠区交叉穿行）。基础方案借鉴相框拼角：把每块端头按「两块侧边线的
// 交点连线」切割 —— 切割线在世界系由两块共同确定，相接两块的端头顶点精确
// 落在同一条直线上：外缘连续无缺口、内缘不再交叉，任意转角(<150°)严格无缝，
// 且对端口舍入/漂移（旧地图 ~cm 级错位）免疫 —— 两块各自求自己角点与公共
// 切割线的交点，误差被切割线本身吸收。
// 端口配对放宽到 1.5m（RT_PAIR_TOL）：gizmo 手挪 / 自由落钉造成的厘米~米级
// 错位也能焊上（正是切割线公式的强项），磁吸/链条放置的精确端口行为不变。
// 小转角(<3.5°)时侧边线近乎平行、交点发散到远处，改用「过端口中点、垂直于
// 前进角平分方向」的公共垂线焊接平口 —— 两块原本各自垂直断开留下的楔形缝
// （缝宽 ≈ 半宽×转角）同样闭合。
// 圆弧转角（更接近真实道路的曲线转弯）：等宽块优先用相切圆弧代替直斜切 ——
// 圆心 C 在世界系唯一确定（两块轴线各向弯内侧平移 R 后的交点，随 R 线性移动），
// 两块各裁直 t_i（= 圆心到端口的投影差），端头之间补一段环形带（半径 R±h）；
// 两块半带共用同一 C/R/半角，角平分面处精确共边，路缘石/边线沿圆弧连续转向。
// 纯派生计算不落数据，编辑器（ui/editor3d/roadTiles.js）与运行时共用同一套逻辑。

export const RT_PAIR_TOL = 1.5;  // 端口配对半径：≤1.5m 即视为相接（宽限救回手挪/自由落钉的错位——
                                 // 端头切割线由两块共同确定，对端口错位天然免疫；磁吸/链条放置本就精确）
const RT_MIN_MITER_ANGLE = 0.06; // 转角小于 ~3.5° 不做斜切/圆弧，改用平口焊接（公共垂线）
const RT_MAX_MITER_ANGLE = (Math.PI * 5) / 6; // 转角超过 150° 不处理（近乎掉头的叠放，无法挽救）

// 块的 A/B 端口世界坐标（与 ui/editor3d/roadTiles.tilePorts 同式，跨层复制的纯函数）
function rtTilePorts(t) {
  const s = Math.sin(t.rot || 0), c = Math.cos(t.rot || 0);
  const hl = (t.len || 3) / 2;
  return [
    { x: t.x - s * hl, z: t.z - c * hl },
    { x: t.x + s * hl, z: t.z + c * hl },
  ];
}

// 端口相接的块对 [[tileA, tileB, { x, z, d }], ...]（1m 网格桶聚类，O(n)）。
// 同一块对允许多对端口各自配对（平行错放的两块 A/A、B/B 端都对得上时两端都对齐）；
// P.d = 两端口距离，rtMiters 用它做「同端多对相接时的优先级」。
export function rtPortPairs(tiles) {
  const CELL = 1;
  const ports = [];
  for (const t of tiles || []) {
    const s = Math.sin(t.rot || 0), c = Math.cos(t.rot || 0);
    const hl = (t.len || 3) / 2;
    ports.push({ t, end: 0, x: t.x - s * hl, z: t.z - c * hl });
    ports.push({ t, end: 1, x: t.x + s * hl, z: t.z + c * hl });
  }
  const buckets = new Map();
  for (const p of ports) {
    const k = Math.floor(p.x / CELL) + "," + Math.floor(p.z / CELL);
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = []));
    b.push(p);
  }
  const pairs = [];
  const seen = new Set();
  for (const p of ports) {
    const cx = Math.floor(p.x / CELL), cz = Math.floor(p.z / CELL);
    // ±2 桶覆盖 RT_PAIR_TOL（桶内最远 2m + 半径 1.5m 需要 5×5 邻域）
    for (let i = -2; i <= 2; i++) {
      for (let j = -2; j <= 2; j++) {
        const b = buckets.get((cx + i) + "," + (cz + j));
        if (!b) continue;
        for (const q of b) {
          if (q.t === p.t) continue;
          const d = Math.hypot(p.x - q.x, p.z - q.z);
          if (d < RT_PAIR_TOL) {
            const key = p.t.id < q.t.id
              ? p.t.id + ":" + p.end + "|" + q.t.id + ":" + q.end
              : q.t.id + ":" + q.end + "|" + p.t.id + ":" + p.end;
            if (!seen.has(key)) {
              seen.add(key);
              pairs.push([p.t, q.t, { x: (p.x + q.x) / 2, z: (p.z + q.z) / 2, d }]);
            }
          }
        }
      }
    }
  }
  return pairs;
}

// 每块两端的对接参数：Map<id, { a, b }>。端记录两种：
//  · { mode:'arc',   ang, side, R, half, t }  圆弧转角：t = 本块裁直长度（圆心到
//                                             本块端线的投影），公共圆心对两块一致
//  · { mode:'miter', ang, m1, m2 }            直线对接：m1/m2 = 端头 +x/−x 角沿
//                                             前进方向的外向延伸量（正 = 伸出块外，
//                                             B 端角 z=+L+m，A 端角 z=−L−m）
//  a/b = 入口端（本地 z=-len/2）/ 出口端（z=+len/2）；arc 的 side = 弯道外侧在
//  本地哪侧（+1 = +x，-1 = -x；任意转角下相接两块同号）。均为纯派生数据。
//  miter 端两角必落在同一条公共切割线上 —— 与相邻块的端头严格共线无缝。
export function rtMiters(tiles) {
  const map = new Map();
  const rec = (t) => {
    let r = map.get(t.id);
    if (!r) map.set(t.id, (r = { t, a: null, b: null }));
    return r;
  };
  // 直线求交：p1 + u·d1 = p2 + v·d2（|d1×d2| 过小时返回 null）
  const isect = (p1x, p1z, d1x, d1z, p2x, p2z, d2x, d2z) => {
    const det = d1x * d2z - d1z * d2x;
    if (Math.abs(det) < 1e-9) return null;
    const u = ((p2x - p1x) * d2z - (p2z - p1z) * d2x) / det;
    return { x: p1x + d1x * u, z: p1z + d1z * u };
  };
  // 端头两角的世界点(+x 角 q1 / −x 角 q2) → 端记录：角点投影到本地 z，
  // 与平端口 z=±L 的差即延伸量
  const endRec = (t, end, ang, q1, q2) => {
    const s = Math.sin(t.rot || 0), c = Math.cos(t.rot || 0);
    const L = (t.len || 3) / 2;
    const z1 = (q1.x - t.x) * s + (q1.z - t.z) * c;
    const z2 = (q2.x - t.x) * s + (q2.z - t.z) * c;
    return end === "b"
      ? { mode: "miter", ang, m1: z1 - L, m2: z2 - L }
      : { mode: "miter", ang, m1: -(z1 + L), m2: -(z2 + L) };
  };
  for (const [t1, t2, P] of rtPortPairs(tiles)) {
    const dr = (t2.rot || 0) - (t1.rot || 0);
    const d = Math.atan2(Math.sin(dr), Math.cos(dr)); // wrap 到 [-π, π]
    const ang = Math.abs(d);
    if (ang > RT_MAX_MITER_ANGLE) continue;
    const f1 = { x: Math.sin(t1.rot || 0), z: Math.cos(t1.rot || 0) };
    const n1 = { x: f1.z, z: -f1.x }; // 本地 +x 侧向
    const f2 = { x: Math.sin(t2.rot || 0), z: Math.cos(t2.rot || 0) };
    const n2 = { x: f2.z, z: -f2.x };
    const h1 = (t1.w || 2) / 2, h2 = (t2.w || 2) / 2;
    const side = d > 0 ? -1 : 1; // 右转（d>0）外侧在本地 -x 侧
    // 端口 → 端（距 P 近者）
    const nearEnd = (t) => {
      const s = Math.sin(t.rot || 0), c = Math.cos(t.rot || 0), hl = (t.len || 3) / 2;
      const dA = (P.x - t.x + s * hl) ** 2 + (P.z - t.z + c * hl) ** 2;
      const dB = (P.x - t.x - s * hl) ** 2 + (P.z - t.z - c * hl) ** 2;
      return dB < dA ? "b" : "a";
    };
    const end1 = nearEnd(t1), end2 = nearEnd(t2);
    let e1 = null, e2 = null;
    if (ang < RT_MIN_MITER_ANGLE) {
      // 平口焊接：侧边线近乎平行、交点发散到远处，公共切割线改取「过端口
      // 中点 P、垂直于前进角平分方向」—— 两块各自求侧边线与该线的交点作为
      // 端角，原本各自垂直断开留下的楔形缝（缝宽 ≈ 半宽×转角）随之闭合
      let bx = f1.x + f2.x, bz = f1.z + f2.z;
      const bl = Math.hypot(bx, bz) || 1;
      const dx = -bz / bl, dz = bx / bl; // 切割线方向（⊥ 角平分方向）
      const butt = (t, end) => {
        const h = (t.w || 2) / 2;
        const nx = Math.cos(t.rot || 0), nz = -Math.sin(t.rot || 0);
        const fx = Math.sin(t.rot || 0), fz = Math.cos(t.rot || 0);
        const q1 = isect(t.x + h * nx, t.z + h * nz, fx, fz, P.x, P.z, dx, dz);
        const q2 = isect(t.x - h * nx, t.z - h * nz, fx, fz, P.x, P.z, dx, dz);
        return q1 && q2 ? endRec(t, end, ang, q1, q2) : null;
      };
      e1 = butt(t1, end1);
      e2 = butt(t2, end2);
    } else {
      // 精确对接：公共切割线 = 两块同号侧边线交点的连线（+x 配 +x、−x 配 −x，
      // 任意转角/宽度差/端口错位下都成立）—— 两块端角精确共线
      const qP = isect(t1.x + h1 * n1.x, t1.z + h1 * n1.z, f1.x, f1.z,
                       t2.x + h2 * n2.x, t2.z + h2 * n2.z, f2.x, f2.z);
      const qM = isect(t1.x - h1 * n1.x, t1.z - h1 * n1.z, f1.x, f1.z,
                       t2.x - h2 * n2.x, t2.z - h2 * n2.z, f2.x, f2.z);
      if (qP && qM) {
        e1 = endRec(t1, end1, ang, qP, qM);
        e2 = endRec(t2, end2, ang, qP, qM);
        // 等宽：优先圆弧转角。圆心 C 在世界系唯一：把两块轴线各向弯内侧平移 R，
        // 交点即 C(R)（随 R 线性移动）→ 两块半带共用 C/R/half，角平分面精确共边；
        // 裁直长度 t_i 改为按本块端线到 C 的投影逐块求解，端口错位不再撕裂圆弧
        if (Math.abs(h1 - h2) < 1e-4) {
          const half = ang / 2;
          const C0 = isect(t1.x, t1.z, f1.x, f1.z, t2.x, t2.z, f2.x, f2.z);
          const C1 = isect(t1.x - side * n1.x, t1.z - side * n1.z, f1.x, f1.z,
                           t2.x - side * n2.x, t2.z - side * n2.z, f2.x, f2.z);
          if (C0 && C1) {
            const dcx = C1.x - C0.x, dcz = C1.z - C0.z;
            const tOf = (t, end, R) => {
              const fx = Math.sin(t.rot || 0), fz = Math.cos(t.rot || 0);
              const zc = (C0.x + R * dcx - t.x) * fx + (C0.z + R * dcz - t.z) * fz;
              const L = (t.len || 3) / 2;
              return end === "b" ? L - zc : zc + L;
            };
            const len1 = t1.len || 3, len2 = t2.len || 3;
            const a1 = tOf(t1, end1, 0), b1 = tOf(t1, end1, 1) - a1;
            const a2 = tOf(t2, end2, 0), b2 = tOf(t2, end2, 1) - a2;
            // 可行 R 区间：内半径为正（R ≥ 1.06h）+ t_i 保持在 [−0.15, 0.75] 块长。
            // 0.75：钝角弯允许裁直吃掉大半块长换圆弧 —— 收得太紧会让 95°~130°
            // 掉进直线斜切区，外角伸出半个块长成尖刺（锯齿状连接的来源之一）
            let lo = h1 * 1.06;
            let hi = Math.min(h1 * 2.5, (0.75 * Math.min(len1, len2)) / Math.tan(half));
            const fit = (a, b, min, max) => {
              if (Math.abs(b) < 1e-9) return a >= min && a <= max;
              let r1 = (min - a) / b, r2 = (max - a) / b;
              if (r1 > r2) { const tmp = r1; r1 = r2; r2 = tmp; }
              lo = Math.max(lo, r1);
              hi = Math.min(hi, r2);
              return lo <= hi;
            };
            if (hi > lo &&
                fit(a1, b1, -0.15 * len1, 0.75 * len1) &&
                fit(a2, b2, -0.15 * len2, 0.75 * len2) &&
                hi > lo) {
              const R = hi;
              e1 = { mode: "arc", ang, side, R, half, t: tOf(t1, end1, R) };
              e2 = { mode: "arc", ang, side, R, half, t: tOf(t2, end2, R) };
            }
          }
        }
      }
    }
    const set = (t, end, e, d) => {
      if (!e) return;
      e._d = d || 0;
      const r = rec(t);
      const cur = r[end];
      // 同端多对相接：优先端口更近者（宽容配对下，真正的延续压过邻近分支的
      // 大转角）；距离相同（端口重合的交叉）取转角更大者
      if (!cur || e._d < cur._d - 1e-9 ||
          (Math.abs(e._d - cur._d) < 1e-9 && e.ang > cur.ang)) r[end] = e;
    };
    set(t1, end1, e1, P.d);
    set(t2, end2, e2, P.d);
  }
  // 防退化后置钳制：同一块两端的「端头占用」（miter = 两角最大延伸，arc = t）
  // 合计不得超过块长（切割边不得在块内交叉成蝶形）。arc 的构造上已受限，只收缩
  // miter 端 —— 仅「短块 + 两端都是急弯」的极端叠放会触发，优先保证几何不自交
  for (const r of map.values()) {
    const len = r.t.len || 3;
    const tSum = (r.a && r.a.mode === "arc" ? r.a.t : 0) + (r.b && r.b.mode === "arc" ? r.b.t : 0);
    const ext = (e) => (e && e.mode === "miter" ? Math.max(Math.abs(e.m1), Math.abs(e.m2)) : 0);
    const mA = ext(r.a), mB = ext(r.b);
    const mSum = mA + mB;
    if (mSum > len * 0.98 - tSum && mSum > 0) {
      const k = Math.max(0, len * 0.98 - tSum) / mSum;
      if (mA) { r.a.m1 *= k; r.a.m2 *= k; }
      if (mB) { r.b.m1 *= k; r.b.m2 *= k; }
    }
  }
  return map;
}

// 端记录 → 几何缓存键片段（编辑器 ui/editor3d/roadTiles.js 的几何缓存共用，
// 端记录字段变化时两处自动同步）
export const rtEndKey = (e) => !e ? "-"
  : e.mode === "arc" ? `a${e.t.toFixed(3)},${e.side},${e.R.toFixed(2)},${e.half.toFixed(3)}`
  : `m${e.m1.toFixed(3)},${e.m2.toFixed(3)}`;

// 路块几何：中心为原点、沿本地 +z 前进、法线 +y。eA/eB = 两端对接参数
// （null = 平口；mode 'miter' 直线对接（逐角延伸量）/ 'arc' 圆弧转角，见 rtMiters）。
// 主体四边形顶点按物理侧边排序（A端+x → B端+x → B端−x → A端−x），两端外侧在
// 不同物理侧（S 弯）也不会自交。UV 沿本地坐标线性映射（x→u 全宽 0..1，v =
// z/len + 0.5）：miter 端 v 允许略超 0..1（ClampToEdge 取边行像素），arc 端裁边
// 内缩 —— 路缘石/边线像素列随端头转向，弯道标线视觉连续。arc 端在裁边之外拼接
// 半段环形带（切线边与裁边重合、角平分面与邻块半带共边），圆弧段路缘石/标线
// 连续，中心虚线自然延续后收笔。
export function rtTileQuadGeometry(len, w, eA, eB, y) {
  const h = w / 2, L = len / 2;
  // 端头两角的 z：z1 = +x 侧角、z2 = −x 侧角（sign=+1 B 端 / -1 A 端）
  const endZ = (e, sign) => {
    if (!e) return [sign * L, sign * L];
    if (e.mode === "arc") { const z = sign * (L - e.t); return [z, z]; }
    return sign > 0 ? [L + e.m1, L + e.m2] : [-L - e.m1, -L - e.m2];
  };
  const [az1, az2] = endZ(eA, -1), [bz1, bz2] = endZ(eB, 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([
    h, y, az1,  // A 端 +x 侧
    h, y, bz1,  // B 端 +x 侧
    -h, y, bz2, // B 端 −x 侧
    -h, y, az2, // A 端 −x 侧
  ], 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute([
    1, az1 / len + 0.5,
    1, bz1 / len + 0.5,
    0, bz2 / len + 0.5,
    0, az2 / len + 0.5,
  ], 2));
  g.setAttribute("normal", new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  g.setIndex([0, 2, 1, 0, 3, 2]); // 上方看逆时针 → 法线朝上
  const parts = [g];
  if (eA && eA.mode === "arc") parts.push(rtArcBandGeometry(len, w, eA, -1, y));
  if (eB && eB.mode === "arc") parts.push(rtArcBandGeometry(len, w, eB, 1, y));
  return parts.length > 1 ? mergeGeometries(parts) : g;
}

// 圆弧转角的半段环形带（本块一侧）：从裁边（切线，φ=0）扫到角平分面（φ=half），
// 与邻块半带在此共边。side = 弯道外侧在本地 ±x 侧；endSign = +1 B 端 / -1 A 端。
// 圆心在弯内侧 (−side·R, z0)，内/外边缘半径 R∓h、R+h，贴图 v 随弧长 R·φ 延续
// （t = R·tan(half) > R·half，v 始终落在 0..1 内，不触发 ClampToEdge）。
function rtArcBandGeometry(len, w, e, endSign, y) {
  const h = w / 2, L = len / 2;
  const { R, half, t, side } = e;
  const N = Math.max(2, Math.ceil(half / 0.17)); // ~10° 步进
  const z0 = endSign * (L - t);                   // 裁边位置
  const vT = endSign > 0 ? 1 - t / len : t / len; // 裁边处 v
  const uOut = side > 0 ? 1 : 0;                  // 外侧边 u（+x 侧为 1）
  const pos = [], uv = [], nrm = [];
  for (let k = 0; k <= N; k++) {
    const phi = (half * k) / N, c = Math.cos(phi), s = Math.sin(phi);
    pos.push(side * ((R + h) * c - R), y, z0 + endSign * (R + h) * s); // 外边缘
    pos.push(side * ((R - h) * c - R), y, z0 + endSign * (R - h) * s); // 内边缘
    const v = vT + (endSign * R * phi) / len;
    uv.push(uOut, v, 1 - uOut, v);
    nrm.push(0, 1, 0, 0, 1, 0);
  }
  const idx = [];
  const flip = side * endSign > 0; // 换端/换侧的镜像会翻转三角形朝向
  for (let k = 0; k < N; k++) {
    const a = k * 2;
    if (flip) idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    else idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}
const medianBedMat = () => new THREE.MeshStandardMaterial({ color: 0x9aa2ab, roughness: 0.92 });
const hedgeMat = () => new THREE.MeshStandardMaterial({ color: 0x2f5426, roughness: 1 });
const markWhiteMat = () => new THREE.MeshBasicMaterial({ color: 0xe8e8e2, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
const markYellowMat = () => new THREE.MeshBasicMaterial({ color: 0xd8a524, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
const riverMat = () => new THREE.MeshStandardMaterial({ color: 0x1d5f8f, transparent: true, opacity: 0.8, roughness: 0.25 });

// 世界米制平面 uv：直接取 position.xz / ASPHALT_TILE。
// 密度与程序化路面一致（那边是整块平面 repeat = 尺寸 / ASPHALT_TILE），
// 而且纹理按世界坐标对齐，两条路交接处不会出现错位的纹理接缝。
function planarUV(geo) {
  const pos = geo.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i) / ASPHALT_TILE;
    uv[i * 2 + 1] = pos.getZ(i) / ASPHALT_TILE;
  }
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return geo;
}

// 折线 → 带状平面网格（两三角/段 + 接头圆片补缝），贴合 y 平面。
// 圆片必须略微高于带面：两者共面时深度完全相等，远处会整片 z-fighting 闪烁。
function stripGeometry(points, width, y, discLift = 0.004) {
  const hw = width / 2;
  const verts = [], idx = [], dirs = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const prev = points[Math.max(0, i - 1)], next = points[Math.min(points.length - 1, i + 1)];
    const dx = next.x - prev.x, dz = next.z - prev.z;
    const len = Math.hypot(dx, dz) || 1;
    dirs.push({ nx: -dz / len, nz: dx / len });
  }
  for (let i = 0; i < points.length; i++) {
    const p = points[i], n = dirs[i];
    verts.push(p.x + n.nx * hw, y, p.z + n.nz * hw);
    verts.push(p.x - n.nx * hw, y, p.z - n.nz * hw);
    if (i < points.length - 1) {
      const a = i * 2;
      // 绕朝上（CCW）：与编辑器 _stripGeometry 一致，正面朝上否则游戏内路面被背面剔除
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  planarUV(geo);
  const discs = [];
  for (const p of points) {
    const c = new THREE.CircleGeometry(hw, 10);
    c.rotateX(-Math.PI / 2);
    c.translate(p.x, y + discLift, p.z);
    // 圆片用同一套世界 uv：补缝处纹理与带身连续，否则圆片上会出现一张被压缩的贴图
    discs.push(planarUV(c));
  }
  const merged = mergeGeometries([geo, mergeGeometries(discs)]);
  return merged || geo;
}

function polyline(points) {
  return (points || []).map(([x, z]) => ({ x, z }));
}

// 折线总弧长
function polylineLen(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return s;
}

// 弧长 → 折线上的点（超出范围按端点 clamp）
function pointAtLen(pts, s) {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (acc + len >= s || i === pts.length - 1) {
      const t = len < 1e-6 ? 0 : Math.min(1, Math.max(0, (s - acc) / len));
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
    }
    acc += len;
  }
  return { x: pts[pts.length - 1].x, z: pts[pts.length - 1].z };
}

// 取 [s0, s1] 区间的子折线，两端按弧长插值补点
function slicePolyline(pts, s0, s1) {
  const out = [pointAtLen(pts, s0)];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    acc += len;
    if (acc > s0 && acc < s1) out.push({ x: b.x, z: b.z });
  }
  out.push(pointAtLen(pts, s1));
  return out;
}

// 按"挖掉"的弧长区间把折线切成若干子折线；ranges 为空时原样返回（保持旧行为）
function cutPolyline(pts, ranges) {
  const total = polylineLen(pts);
  if (!ranges || !ranges.length) return [pts];
  const rs = ranges
    .map(([a, b]) => [Math.max(0, Math.min(a, b)), Math.min(total, Math.max(a, b))])
    .filter(([a, b]) => b - a > 0.01)
    .sort((p, q) => p[0] - q[0]);
  if (!rs.length) return [pts];
  const merged = [];
  for (const r of rs) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push(r.slice());
  }
  const spans = [];
  let cur = 0;
  for (const [a, b] of merged) {
    if (a - cur > 0.5) spans.push([cur, a]);
    cur = Math.max(cur, b);
  }
  if (total - cur > 0.5) spans.push([cur, total]);
  return spans.map(([a, b]) => slicePolyline(pts, a, b));
}

// 折线整体沿法线偏移 off（每点取相邻方向的平均法线，转角平滑）
function offsetPolyline(points, off) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const prev = points[Math.max(0, i - 1)], next = points[Math.min(points.length - 1, i + 1)];
    const dx = next.x - prev.x, dz = next.z - prev.z;
    const len = Math.hypot(dx, dz) || 1;
    out.push({ x: p.x + (-dz / len) * off, z: p.z + (dx / len) * off });
  }
  return out;
}

// 闭合多边形顶点整体内缩 d（miter join，尖角按 4d 截断）：取面路的路缘白实线
// 沿边界内侧走，需要把边界线向路面内收一点
function insetPolygon(pts, d) {
  const n = pts.length;
  if (n < 3) return null;
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    area2 += a[0] * b[1] - b[0] * a[1];
  }
  const s = area2 >= 0 ? 1 : -1; // 缠绕方向决定「内侧」法线取哪一侧
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = pts[(i + n - 1) % n], c = pts[i], q = pts[(i + 1) % n];
    let e1x = c[0] - p[0], e1z = c[1] - p[1];
    let e2x = q[0] - c[0], e2z = q[1] - c[1];
    const l1 = Math.hypot(e1x, e1z) || 1, l2 = Math.hypot(e2x, e2z) || 1;
    e1x /= l1; e1z /= l1; e2x /= l2; e2z /= l2;
    const n1x = -e1z * s, n1z = e1x * s, n2x = -e2z * s, n2z = e2x * s;
    const mx = n1x + n2x, mz = n1z + n2z;
    if (mx * mx + mz * mz < 1e-9) { // 掉头折返：miter 退化，取第一条边的法线
      out.push({ x: c[0] + n1x * d, z: c[1] + n1z * d });
      continue;
    }
    const k = Math.min(4 * d, d / (mx * n1x + mz * n1z));
    out.push({ x: c[0] + mx * k, z: c[1] + mz * k });
  }
  return out;
}

// 线段 a→b 落在「程序化路条带」（轴线过 j、半宽 progHalf+pad）内的 t 区间：
// 用于取面路的路缘白实线在路口断开，不横穿程序化路的车道
function spanInRoadBand(a, b, j, pad) {
  const hw = (j.progHalf || 0) + pad;
  const dw = (b.x - a.x) * j.mx + (b.z - a.z) * j.mz;
  const w0 = (a.x - j.x) * j.mx + (a.z - j.z) * j.mz;
  if (Math.abs(dw) < 1e-9) return Math.abs(w0) <= hw ? [0, 1] : null;
  let t0 = (-hw - w0) / dw, t1 = (hw - w0) / dw;
  if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
  t0 = Math.max(0, t0); t1 = Math.min(1, t1);
  return t0 < t1 - 1e-6 ? [t0, t1] : null;
}

// 沿段方向的标线四边形（略加长补段间缝隙）
function markQuad(x0, z0, x1, z1, w, y) {
  const dx = x1 - x0, dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  if (len < 0.02) return null;
  const g = new THREE.PlaneGeometry(len + w * 0.6, w);
  g.rotateX(-Math.PI / 2);
  g.rotateY(Math.atan2(-dz, dx));
  g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
  // uv 必须保留：whites 里要和 stripGeometry 产物合并，属性集不一致 mergeGeometries 会返回 null
  return planarUV(g);
}

// 白色虚线：沿折线按 9m 周期 emit 3.2m 短划（与程序化道路一致）
function emitDashes(pts, y, out) {
  const DASH = 3.2, PERIOD = 9, W = 0.14, MIN_STEP = 1e-4;
  let acc = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    let t = 0;
    while (t < len - MIN_STEP) {
      const phase = acc % PERIOD;
      const inDash = phase < DASH;
      // 本段应走的真实长度；MIN_STEP 保底推进，防止浮点驻留（phase ≈ DASH 时 d≈0 死循环）
      const step = Math.max(inDash ? Math.min(DASH - phase, len - t) : Math.min(PERIOD - phase, len - t), MIN_STEP);
      if (inDash) {
        const d = Math.min(step, len - t);
        const q = markQuad(a.x + (b.x - a.x) * (t / len), a.z + (b.z - a.z) * (t / len),
          a.x + (b.x - a.x) * ((t + d) / len), a.z + (b.z - a.z) * ((t + d) / len), W, y);
        if (q) out.push(q);
      }
      acc += step; t += step;
    }
  }
}

// 白色实线：连续带状。逐段四边形每段会加长 0.6w 补缝，导致相邻段两两重叠、
// 完全共面 —— 高空俯瞰时就是沿路一条条闪烁的横纹。改用连续带（无重叠）。
function emitSolid(pts, y, w, out) {
  if (!pts || pts.length < 2) return;
  out.push(stripGeometry(pts, w, y));
}

// 分隔带盒体（逐段、按段方向旋转，合并后成整条）
function emitBoxStrip(pts, w, h, y, out) {
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 0.05) continue;
    const g = new THREE.BoxGeometry(len, h, w);
    g.rotateY(Math.atan2(-(b.z - a.z), b.x - a.x));
    g.translate((a.x + b.x) / 2, y, (a.z + b.z) / 2);
    out.push(g);
  }
}

// 点是否在多边形内（射线法）
export function pointInPoly(x, z, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i], [xj, zj] = pts[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function buildingGroup(obj) {
  const fp = (obj.params && obj.params.footprint) || [];
  if (fp.length < 3) return null;
  const h = obj.params.height || 24;
  const shape = new THREE.Shape(fp.map(([x, z]) => new THREE.Vector2(x, -z)));
  // 墙面/屋顶材质：params 指定了标准材料库 id 就用库材质（与编辑器预览一致，
  // 选 facade 类还能吃到夜间窗光），否则回退默认素色
  const wallM = (obj.params.wallMaterial && getMaterial(obj.params.wallMaterial)) || wallMat();
  const roofM = (obj.params.roofMaterial && getMaterial(obj.params.roofMaterial)) || roofMat();
  const walls = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false }).rotateX(-Math.PI / 2), wallM);
  // ExtrudeGeometry UV 单位是米，按材质贴图平铺尺度缩放（facade 6.4m / storefront 6×4m）
  const wUV = uvScaleFor(obj.params.wallMaterial) || [FACADE_UV, FACADE_UV];
  scaleUVs(walls.geometry, wUV[0], wUV[1]);
  walls.castShadow = true; walls.receiveShadow = true;
  const roof = new THREE.Mesh(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2).translate(0, h, 0), roofM);
  const rUV = uvScaleFor(obj.params.roofMaterial) || [ROOF_UV, ROOF_UV];
  scaleUVs(roof.geometry, rUV[0], rUV[1]); // 屋顶贴图 4m 平铺
  const g = new THREE.Group();
  g.add(walls, roof);
  g.position.set(obj.pos[0], 0, obj.pos[1]);
  g.rotation.y = obj.rot || 0;
  return g;
}

// 建筑/树/路灯的碰撞盒（AABB，含编辑器同款 pos+rot 变换）
export function footprintAABB(obj) {
  const fp = (obj.params && obj.params.footprint) || [];
  if (fp.length < 3) return null;
  const c = Math.cos(obj.rot || 0), s = Math.sin(obj.rot || 0);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of fp) {
    const wx = obj.pos[0] + x * c + z * s;
    const wz = obj.pos[1] + -x * s + z * c;
    minX = Math.min(minX, wx); maxX = Math.max(maxX, wx);
    minZ = Math.min(minZ, wz); maxZ = Math.max(maxZ, wz);
  }
  return { minX, maxX, minZ, maxZ };
}

// 树/路灯几何与材质全项目共享缓存（编辑器 meshes.js 与运行时 treeMesh/lampMesh 用同一份）：
// 实例 Mesh 只携带各自变换，几千棵树也只有 2 组几何 + 2 组材质；
// userData.shared 标记让重建/销毁逻辑跳过 dispose，避免把共享缓存释放掉
let _tlShared = null;
function treeLampShared() {
  if (!_tlShared) {
    const shared = (o) => { o.userData.shared = true; return o; };
    _tlShared = {
      trunkGeo: shared(new THREE.CylinderGeometry(0.25, 0.35, 3, 6)),
      trunkMat: shared(new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 1 })),
      crownGeo: shared(new THREE.IcosahedronGeometry(2.2, 0)),
      crownMat: shared(new THREE.MeshStandardMaterial({ color: 0x2f7a3f, roughness: 1, flatShading: true })),
      poleGeo: shared(new THREE.CylinderGeometry(0.12, 0.16, 6.5, 6)),
      poleMat: shared(new THREE.MeshStandardMaterial({ color: 0x3c4650, roughness: 0.6 })),
      headGeo: shared(new THREE.SphereGeometry(0.45, 10, 8)),
      headMat: shared(new THREE.MeshStandardMaterial({ color: 0xfff3c4, emissive: 0xffd873, emissiveIntensity: 1.4 })),
    };
  }
  return _tlShared;
}

// 编辑器构建用（不定位，wrapper / 调用方负责位置缩放）
export function buildTreeGroup() {
  const s = treeLampShared();
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(s.trunkGeo, s.trunkMat);
  trunk.position.y = 1.5; trunk.castShadow = true;
  const crown = new THREE.Mesh(s.crownGeo, s.crownMat);
  crown.position.y = 4.6; crown.castShadow = true;
  g.add(trunk, crown);
  return g;
}

export function buildLampGroup() {
  const s = treeLampShared();
  const g = new THREE.Group();
  const pole = new THREE.Mesh(s.poleGeo, s.poleMat);
  pole.position.y = 3.25; pole.castShadow = true;
  const head = new THREE.Mesh(s.headGeo, s.headMat);
  head.position.y = 6.6;
  g.add(pole, head);
  return g;
}

function treeMesh(obj) {
  const g = buildTreeGroup();
  g.scale.setScalar(obj.sc || 1);
  g.position.set(obj.pos[0], obj.baseY || 0, obj.pos[1]);
  return g;
}

function lampMesh(obj) {
  const g = buildLampGroup();
  g.position.set(obj.pos[0], 0, obj.pos[1]);
  return g;
}

// 描边内容的包围盒（用于扩展世界边界与出生点）；无内容返回 null
export function customBBox(data) {
  if (!data || !data.features) return null;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let has = false;
  const ext = (x, z) => {
    has = true;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  };
  for (const r of data.features.roads || []) for (const [x, z] of r.points) ext(x, z);
  for (const r of data.features.rivers || []) for (const [x, z] of r.points) ext(x, z);
  // 拼接路块：四角（前进向 f=(sinθ,cosθ)，侧向 side=(cosθ,−sinθ)）；
  // 端头斜切的外角会伸出块外，偏移量一并计入
  const tileMiters = rtMiters(data.features.roadTiles || []);
  for (const t of data.features.roadTiles || []) {
    const mm = tileMiters.get(t.id);
    // 端头沿前进方向伸出块外的量：miter = 两角最大外向延伸；arc = 外弧中点越过原端线的距离
    const endExt = (e) => !e ? 0 : e.mode === "arc"
      ? Math.max(0, (e.R + (t.w || 2) / 2) * Math.sin(e.half) - e.t)
      : Math.max(0, e.m1, e.m2);
    const mx = mm ? Math.max(endExt(mm.a), endExt(mm.b)) : 0;
    const hl = (t.len || 3) / 2 + mx, hw = (t.w || 2) / 2;
    const s = Math.sin(t.rot || 0), c = Math.cos(t.rot || 0);
    ext(t.x + s * hl + c * hw, t.z + c * hl - s * hw);
    ext(t.x + s * hl - c * hw, t.z + c * hl + s * hw);
    ext(t.x - s * hl + c * hw, t.z - c * hl - s * hw);
    ext(t.x - s * hl - c * hw, t.z - c * hl + s * hw);
  }
  for (const o of data.objects || []) {
    ext(o.pos[0], o.pos[1]);
    const box = footprintAABB(o);
    if (box) {
      ext(box.minX, box.minZ); ext(box.maxX, box.maxZ);
    }
  }
  return has ? { minX, maxX, minZ, maxZ } : null;
}

// ---- 地图范围（3D 描边的网格地图）----

// 范围的世界坐标多边形轮廓：多边形 pts 或旋转矩形四角；无有效范围返回 null
export function areaPoly(data) {
  const a = data && data.area;
  if (!a) return null;
  if (a.pts && a.pts.length >= 3) return a.pts;
  if (!a.w || !a.d) return null;
  const co = Math.cos(a.rot || 0), si = Math.sin(a.rot || 0);
  const cx = a.cx || 0, cz = a.cz || 0;
  // 与 three.js rotation.y 一致：x' = x·cos + z·sin，z' = -x·sin + z·cos
  return [[-a.w / 2, -a.d / 2], [a.w / 2, -a.d / 2], [a.w / 2, a.d / 2], [-a.w / 2, a.d / 2]]
    .map(([x, z]) => [cx + x * co + z * si, cz - x * si + z * co]);
}

// 范围多边形的包围盒；无有效范围返回 null
export function areaBBox(data) {
  const pts = areaPoly(data);
  if (!pts) return null;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of pts) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  return { minX, maxX, minZ, maxZ };
}

// 闭合多边形的中轴虚线端点：最小外接矩形（遍历凸包边方向取最小面积）长轴中线。
// 仅对细长多边形（短边 ≤ maxChord 且长宽比 ≥ 1.6，即描边取面的直路）生成；
// 弯道/大块围合面返回 null 不画，避免虚假或越界线条。2D/3D 编辑器共用
export function polyCenterLine(pts, maxChord) {
  if (!pts || pts.length < 3) return null;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const sorted = [...pts].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const lo = [], hi = []; // 凸包（Andrew 单调链）
  for (const p of sorted) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop();
    hi.push(p);
  }
  const hull = lo.concat(hi.slice(1, -1));
  if (hull.length < 3) return null;
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const [x1, z1] = hull[i], [x2, z2] = hull[(i + 1) % hull.length];
    const len = Math.hypot(x2 - x1, z2 - z1) || 1;
    const ux = (x2 - x1) / len, uz = (z2 - z1) / len, vx = -uz, vz = ux;
    let tmin = Infinity, tmax = -Infinity, wmin = Infinity, wmax = -Infinity;
    for (const [x, z] of hull) {
      const t = (x - x1) * ux + (z - z1) * uz, w = (x - x1) * vx + (z - z1) * vz;
      if (t < tmin) tmin = t;
      if (t > tmax) tmax = t;
      if (w < wmin) wmin = w;
      if (w > wmax) wmax = w;
    }
    const area = (tmax - tmin) * (wmax - wmin);
    if (!best || area < best.area) best = { area, tmin, tmax, wmin, wmax, ux, uz, vx, vz, x1, z1 };
  }
  const b = best;
  const cx = b.x1 + b.ux * (b.tmin + b.tmax) / 2 + b.vx * (b.wmin + b.wmax) / 2;
  const cz = b.z1 + b.uz * (b.tmin + b.tmax) / 2 + b.vz * (b.wmin + b.wmax) / 2;
  const alongU = b.tmax - b.tmin, alongV = b.wmax - b.wmin;
  const longIsU = alongU >= alongV;
  const lx = longIsU ? b.ux : b.vx, lz = longIsU ? b.uz : b.vz;
  const shortLen = Math.min(alongU, alongV), longLen = Math.max(alongU, alongV);
  if (shortLen > maxChord || longLen < shortLen * 1.6) return null; // 大块面 / 近方形不画
  // 端点取多边形在长轴上的实际投影范围并略内缩；端点落在多边形外时向内收缩（应对弯道）
  let pmin = Infinity, pmax = -Infinity;
  for (const [x, z] of pts) {
    const t = (x - cx) * lx + (z - cz) * lz;
    if (t < pmin) pmin = t;
    if (t > pmax) pmax = t;
  }
  const inset = shortLen * 0.15;
  const pullIn = (t0, dir) => {
    let t = t0;
    for (let k = 0; k < 24; k++) {
      const q = [cx + lx * t, cz + lz * t];
      if (pointInPoly(q[0], q[1], pts)) return q;
      t += dir * longLen * 0.04;
    }
    return null;
  };
  const a = pullIn(pmin + inset, 1), bEnd = pullIn(pmax - inset, -1);
  if (!a || !bEnd) return null;
  if (Math.hypot(bEnd[0] - a[0], bEnd[1] - a[1]) < shortLen * 1.2) return null; // 内缩后太短不画
  return [a, bEnd];
}

// 轴对齐直线与多边形求交（偶奇规则）：返回多边形内部的区段 [起, 止]。
// horiz=false → 竖线 x=fixed（返回 z 区段）；horiz=true → 横线 z=fixed（返回 x 区段）
export function clipAxisLine(poly, fixed, horiz) {
  const ts = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const pf = horiz ? p[1] : p[0], qf = horiz ? q[1] : q[0];
    if ((pf <= fixed) !== (qf <= fixed)) {
      const t = (fixed - pf) / (qf - pf);
      ts.push((horiz ? p[0] : p[1]) + t * ((horiz ? q[0] : q[1]) - (horiz ? p[0] : p[1])));
    }
  }
  ts.sort((x, y) => x - y);
  const segs = [];
  for (let i = 0; i + 1 < ts.length; i += 2) segs.push([ts[i], ts[i + 1]]);
  return segs;
}

// 世界边界（编辑器预览与运行时同源）：路网范围 ∪ 描边内容+120 ∪ 地图范围+120。
// 延伸街道铺满该边界（含整张网格地图），显示层再按范围多边形裁剪。
export function worldBounds(data) {
  let b = data.roadsX && data.roadsX.length && data.roadsZ && data.roadsZ.length
    ? mapBounds(data.roadsX, data.roadsZ)
    : { minX: -1072, maxX: 1462, minZ: -602, maxZ: 582 };
  const grow = (bb) => {
    b = {
      minX: Math.min(b.minX, bb.minX - 120), maxX: Math.max(b.maxX, bb.maxX + 120),
      minZ: Math.min(b.minZ, bb.minZ - 120), maxZ: Math.max(b.maxZ, bb.maxZ + 120),
    };
  };
  const cb = customBBox(data);
  if (cb) grow(cb);
  const ab = areaBBox(data);
  if (ab) grow(ab);
  return b;
}

// 构建描边内容的运行时网格组 + 注册碰撞；返回 null 表示该地图没有描边内容
// junctions: 由 city 算好的「描边路 × 程序化横纵路」路口，用来在路口断开人行道与标线
export function buildCustomMap(data, colliders, junctions = []) {
  const bbox = customBBox(data);
  if (!bbox) return null;
  const group = new THREE.Group();
  group.name = "customMap";

  const roads = data.features.roads || [];
  for (let ri = 0; ri < roads.length; ri++) {
    const r = roads[ri];
    if (!r.points || r.points.length < 2) continue;
    const pts = polyline(r.points);
    // 程序化街区平台顶 0.16 —— 描边路面抬到其上，穿越街区时路面不被平台盖住
    let m;
    if (r.closed && r.points.length >= 3) {
      // 取面道路（closed）：围合多边形整体填充为路面
      const shape = new THREE.Shape(r.points.map(([x, z]) => new THREE.Vector2(x, -z)));
      m = new THREE.Mesh(planarUV(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2).translate(0, 0.18, 0)), roadMat());
    } else {
      m = new THREE.Mesh(stripGeometry(pts, r.width || 12, 0.18), roadMat());
    }
    m.receiveShadow = true;
    group.add(m);
    // 路口断开：路面本身保留（车要开过去），但人行道 / 标线 / 分隔带在横路宽度内截断，
    // 否则 0.24 高的人行道会像一堵墙横穿车道，路缘白线和双黄线也会直接压过路口。
    const cutRanges = [];
    if (!r.closed) {
      for (const j of junctions || []) {
        if (j.roadIndex === ri) cutRanges.push([j.s - j.alongHalf - 0.6, j.s + j.alongHalf + 0.6]);
        // 这条路作为"被穿路"时也要断开（描边路 × 描边路）
        if (j.viaRoadIndex === ri) cutRanges.push([j.viaS - j.viaAlongHalf - 0.6, j.viaS + j.viaAlongHalf + 0.6]);
      }
    }
    const spans = cutPolyline(pts, cutRanges);

    // 取面路的路缘白实线：程序化路与开路都有（偏移 0.16、宽 0.14），面路此前没有 ——
    // 沿边界内缩 0.16 画一圈，落在程序化路条带内的段在路口断开，不横穿程序化路的车道
    if (r.closed && r.points.length >= 3) {
      const ring = insetPolygon(r.points, 0.16);
      if (ring && ring.length >= 3) {
        ring.push(ring[0]); // 闭合
        const cuts = [];
        let acc = 0;
        for (let i = 0; i + 1 < ring.length; i++) {
          const a = ring[i], b = ring[i + 1];
          const len = Math.hypot(b.x - a.x, b.z - a.z);
          if (len > 1e-6) {
            for (const j of junctions || []) {
              if (j.roadIndex !== ri) continue;
              const iv = spanInRoadBand(a, b, j, 0.6);
              if (iv) cuts.push([acc + iv[0] * len, acc + iv[1] * len]);
            }
          }
          acc += len;
        }
        const edgeWhites = [];
        for (const span of cutPolyline(ring, cuts)) {
          if (span.length >= 2) emitSolid(span, 0.19, 0.14, edgeWhites);
        }
        if (edgeWhites.length) group.add(new THREE.Mesh(mergeGeometries(edgeWhites), markWhiteMat()));
      }
    }

    // 人行道：沿两侧偏移的窄条带（路缘高出路面 6cm）；取面路为整块填充，无侧边不生成
    const sw = Math.min(Math.max(r.sidewalk ?? 3, 0), 12);
    const half = (r.width || 12) / 2;
    if (!r.closed && sw > 0) {
      for (const span of spans) {
        for (const s of [1, -1]) {
          const sm = new THREE.Mesh(stripGeometry(offsetPolyline(span, s * (half + sw / 2)), sw, 0.24), sidewalkMat());
          sm.receiveShadow = true;
          group.add(sm);
        }
      }
    }
    // 车道标线 / 双黄线 / 分隔带（与程序化横纵路同语义）。
    // 描边路宽度固定，车道数由用户指定：车道白虚线按固定车道宽 3.4m 布置；
    // 线形路沿折线（折线即路中心）；取面路沿最小外接矩形长轴中线（直路取面才有中线）
    const lanes = Math.min(Math.max(r.lanes ?? 2, 1), 4);
    const med = Math.min(Math.max(r.median ?? 0, 0), 14);
    let markSpans = null;
    if (!r.closed) markSpans = spans;
    else {
      const cl = polyCenterLine(r.points, 80);
      if (cl) {
        const line = [{ x: cl[0][0], z: cl[0][1] }, { x: cl[1][0], z: cl[1][1] }];
        // 取面路没有侧边人行道，但中线标线 / 分隔带照样会横穿路口 ——
        // 绿篱高 0.56，会直接压住 0.2 高的斑马线，必须按路口位置截断
        const len = polylineLen(line);
        const dx = line[1].x - line[0].x, dz = line[1].z - line[0].z;
        const cuts = [];
        for (const j of junctions || []) {
          if (j.roadIndex !== ri || len < 1e-6) continue;
          const t = ((j.x - line[0].x) * dx + (j.z - line[0].z) * dz) / (len * len);
          if (t < -0.05 || t > 1.05) continue;
          const px = line[0].x + dx * t, pz = line[0].z + dz * t;
          if (Math.hypot(j.x - px, j.z - pz) > j.roadHalf + 2) continue; // 投影不在这条中线上
          cuts.push([t * len - j.alongHalf - 0.6, t * len + j.alongHalf + 0.6]);
        }
        markSpans = cutPolyline(line, cuts);
      }
    }
    if (markSpans && markSpans.length) {
      const whites = [], yellows = [], beds = [], hedges = [];
      for (const mp of markSpans) {
        for (const s of [-1, 1]) {
          if (!r.closed) emitSolid(offsetPolyline(mp, s * (half - 0.16)), 0.19, 0.14, whites); // 路缘白实线
          for (let lane = 1; lane < lanes; lane++) {
            const off = med / 2 + lane * 3.4; // 固定车道宽 3.4m
            if (!r.closed && off > half - 0.35) break; // 超出车行道不画
            emitDashes(offsetPolyline(mp, s * off), 0.19, whites);
          }
        }
        if (med > 0) {
          // 中央分隔带：基座 + 绿篱 + 行道树（median ≥ 5 时每 ~22m，缩小 0.8）
          emitBoxStrip(mp, med, 0.2, 0.28, beds);
          emitBoxStrip(mp, Math.max(0.9, med - 1.4), 0.55, 0.56, hedges);
        } else {
          emitSolid(offsetPolyline(mp, -0.17), 0.19, 0.1, yellows); // 双黄线
          emitSolid(offsetPolyline(mp, 0.17), 0.19, 0.1, yellows);
        }
      }
      if (whites.length) group.add(new THREE.Mesh(mergeGeometries(whites), markWhiteMat()));
      if (yellows.length) group.add(new THREE.Mesh(mergeGeometries(yellows), markYellowMat()));
      if (beds.length) {
        const bed = new THREE.Mesh(mergeGeometries(beds), medianBedMat());
        bed.receiveShadow = true;
        group.add(bed);
      }
      if (hedges.length) {
        const hedge = new THREE.Mesh(mergeGeometries(hedges), hedgeMat());
        hedge.castShadow = true;
        group.add(hedge);
      }
      if (med >= 5) {
        for (const mp of markSpans) {
          let acc = 0, next = 12;
          for (let i = 0; i + 1 < mp.length; i++) {
            const a = mp[i], b = mp[i + 1];
            const len = Math.hypot(b.x - a.x, b.z - a.z);
            while (next <= acc + len) {
              const t = (next - acc) / len;
              group.add(treeMesh({ pos: [a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t], sc: 0.8, baseY: 0.38 }));
              next += 22;
            }
            acc += len;
          }
        }
      }
    }
  }
  for (const r of data.features.rivers || []) {
    if (!r.points || r.points.length < 2) continue;
    const m = new THREE.Mesh(stripGeometry(polyline(r.points), r.width || 26, 0.05), riverMat());
    m.receiveShadow = true;
    group.add(m);
  }
  // 拼接式路块（3D 编辑器「路块拼接」）：整块贴图，抬到描边路面(0.18)之上避免 z-fighting；
  // 端头按相邻块转角斜切（miter），弯道外缘连续、内缘不重叠
  const tiles = data.features.roadTiles || [];
  const tileMiters = rtMiters(tiles);
  for (const t of tiles) {
    const len = t.len || 3, w = t.w || 2;
    const mi = tileMiters.get(t.id);
    const geo = rtTileQuadGeometry(len, w, mi && mi.a, mi && mi.b, 0.19);
    const m = new THREE.Mesh(geo, roadTileMat(len, w, t.style || "dash", t.lanes || 1));
    m.position.set(t.x, 0, t.z);
    m.rotation.y = t.rot || 0;
    m.receiveShadow = true;
    group.add(m);
  }
  for (const o of data.objects || []) {
    if (o.type === "building") {
      const b = buildingGroup(o);
      if (b) {
        group.add(b);
        const box = footprintAABB(o);
        // top = 建筑高度（与 buildingGroup 的 extrude depth 一致），供相机遮挡判断
        if (box) colliders.add(box.minX, box.minZ, box.maxX, box.maxZ, (o.params && o.params.height) || 24);
      }
    } else if (o.type === "asset" && o.assetId) {
      // 模型工坊资产：模板已在 city._init 预热（assetMesh 缓存），这里同步克隆。
      // 只传 {id} 即可 —— 实例化只读 id；未预热/已删除的资产静默跳过
      const ref = { id: o.assetId };
      const inst = assetInstance(ref, { pos: o.pos, rot: o.rot, scale: o.scale, hideBillboardProxies: true });
      if (inst) {
        group.add(inst);
        const aabb = assetWorldAABB(ref, { pos: o.pos, rot: o.rot, scale: o.scale });
        // 碰撞顶点取模型实际最高点，供相机遮挡判断
        if (aabb) colliders.add(aabb.minX, aabb.minZ, aabb.maxX, aabb.maxZ, aabb.maxY);
      }
    } else if (o.type === "tree") {
      group.add(treeMesh(o));
      colliders.add(o.pos[0] - 0.5, o.pos[1] - 0.5, o.pos[0] + 0.5, o.pos[1] + 0.5, 5);
    } else if (o.type === "lamp") {
      group.add(lampMesh(o));
      colliders.add(o.pos[0] - 0.3, o.pos[1] - 0.3, o.pos[0] + 0.3, o.pos[1] + 0.3, 6);
    }
  }

  return {
    group,
    bbox,
    center: { x: (bbox.minX + bbox.maxX) / 2, z: (bbox.minZ + bbox.maxZ) / 2 },
    roads: data.features.roads || [],
    rivers: data.features.rivers || [],
    buildings: (data.objects || []).filter((o) => o.type === "building"),
    trees: (data.objects || []).filter((o) => o.type === "tree"),
    area: data.area || null,
  };
}
