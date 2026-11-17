// 工作台模型的立面分析（只读）：找出可挂广告屏的「单面墙」与「L 形转角」，
// 并给出落点、朝向与缩放建议。广告屏作为组合部件拖入时自动调用，
// 用户仍可在右侧面板微调；几何分析本身不改场景、不依赖编辑器状态。
//
// 坐标约定：输入 root 为资产工作台根（零变换），输出为资产根坐标系下的世界点，
// 与 assetMesh 组合模板、BillboardManager 挂屏使用同一套坐标。
import * as THREE from "three";
import { billboardSpecFromAsset } from "../data/billboardAsset.js";

const MAX_TRIS = 12000;      // 大 GLB 采样上限，拖放时同步分析不能卡
const MIN_AREA = 18;         // 候选墙最小面积 m²
const MIN_WIDTH = 5;
const MIN_HEIGHT = 4;
const ANGLE_BIN = Math.PI / 16;
const ANGLE_BINS = 32;       // 2π / ANGLE_BIN，角度分桶数（取模归一到 [0,32)）
const DIST_BIN = 1;
const SEG_GAP = 0.6;         // 同一平面内 u 方向间隔超过这个值就算两段墙（凹槽 / 断开）

function isCompositeChild(obj) {
  for (let o = obj; o; o = o.parent) if (o.userData && o.userData.compositePart) return true;
  return false;
}

/** 同平面的三角面按 u 方向并成「连续的墙段」：中间有缺口就断开，
 *  否则一整排楼 / 带凹槽的立面会被当成一整面墙，屏一挂就超出实际墙面。 */
function mergeSegments(tris) {
  const sorted = tris.slice().sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const t of sorted) {
    const last = out[out.length - 1];
    if (last && t[0] <= last.u1 + SEG_GAP) {
      if (t[1] > last.u1) last.u1 = t[1];
      if (t[2] < last.v0) last.v0 = t[2];
      if (t[3] > last.v1) last.v1 = t[3];
    } else {
      out.push({ u0: t[0], u1: t[1], v0: t[2], v1: t[3] });
    }
  }
  return out;
}

/** 取包含（或最接近）u 坐标的那一段墙 */
function segmentAt(flat, u, tol = 1.2) {
  const segs = flat && flat.segments;
  if (!segs || !segs.length) return null;
  let best = null, bestGap = Infinity;
  for (const s of segs) {
    const gap = u < s.u0 ? s.u0 - u : u > s.u1 ? u - s.u1 : 0;
    if (gap < bestGap) { bestGap = gap; best = s; }
  }
  return bestGap <= tol ? best : null;
}

/* ---------------- 楼角：用网格共享边直接求 ---------------- */

/** 竖直棱线 → 接近直角的凸楼角。
 *  描边建筑 / 多边形立面是许多窄面拼出来的：按「两个平面求交线」得到的角点
 *  是两个平均平面的交点，常常落在楼体外面，角屏就悬在空中并伸出墙面。
 *  共享边是真实的棱线，位置与两面法线都精确。 */
function cornersFromEdges(tris) {
  const out = [];
  if (tris.length < 2) return out;
  const CELL = 50; // 2cm 取整，容忍浮点误差导致的重复顶点
  const keyOf = (v) => `${Math.round(v.x * CELL)},${Math.round(v.y * CELL)},${Math.round(v.z * CELL)}`;
  const edges = new Map();
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    for (let k = 0; k < 3; k++) {
      const v0 = t.p[k], v1 = t.p[(k + 1) % 3];
      if (Math.abs(v1.y - v0.y) < 2) continue;         // 只要竖直棱
      const k0 = keyOf(v0), k1 = keyOf(v1);
      const ek = k0 < k1 ? `${k0}|${k1}` : `${k1}|${k0}`;
      let rec = edges.get(ek);
      if (!rec) { rec = { v0, v1, list: [] }; edges.set(ek, rec); }
      rec.list.push(i);
    }
  }
  for (const rec of edges.values()) {
    if (rec.list.length !== 2) continue;               // 开口 / 非流形
    const t1 = tris[rec.list[0]], t2 = tris[rec.list[1]];
    if (Math.abs(t1.n.dot(t2.n)) > 0.35) continue;     // 只要接近 90° 的楼角
    if (t1.area < 2 || t2.area < 2) continue;
    const h = Math.abs(rec.v1.y - rec.v0.y);
    if (h < MIN_HEIGHT) continue;
    // 凸角判定：相邻面的远端顶点要落在本面内侧；凹角（内折）正好相反
    const near = (p) => p.distanceToSquared(rec.v0) < 0.01 || p.distanceToSquared(rec.v1) < 0.01;
    const apex = t2.p.find((p) => !near(p));
    if (!apex) continue;
    if (apex.clone().sub(rec.v0).dot(t1.n) > -0.05) continue;
    out.push({
      center: new THREE.Vector3(
        (rec.v0.x + rec.v1.x) / 2, (rec.v0.y + rec.v1.y) / 2, (rec.v0.z + rec.v1.z) / 2,
      ),
      n1: t1.n.clone(), n2: t2.n.clone(),
      yMin: Math.min(rec.v0.y, rec.v1.y), yMax: Math.max(rec.v0.y, rec.v1.y), height: h,
    });
  }
  return out;
}

/** 从棱线沿 dir（该墙切向）量到墙段的边沿；墙面数据缺失时用保守默认值 */
function runAlongWall(flats, point, normal, dir, fallback = 14) {
  for (const f of flats) {
    if (f.normal.dot(normal) < 0.95) continue;
    if (Math.abs(point.dot(normal) - f.d) > 0.6) continue;
    const u = point.x * f.uDir.x + point.z * f.uDir.z;
    const seg = segmentAt(f, u, 1.5);
    if (!seg) continue;
    const sign = dir.x * f.uDir.x + dir.z * f.uDir.z;
    return sign >= 0 ? seg.u1 - u : u - seg.u0;
  }
  return fallback;
}

/** 落点所在的那一段墙：宽高与中心都按这一段算，拿不到就返回 null（调用方退回整面条目） */
function wallAtPoint(flat, point) {
  if (!point) return null;
  const u = point.x * flat.uDir.x + point.z * flat.uDir.z;
  const seg = segmentAt(flat, u);
  if (!seg || seg.u1 - seg.u0 < 2 || seg.v1 - seg.v0 < 2) return null;
  const center = flat.anchor.clone().addScaledVector(flat.uDir, (seg.u0 + seg.u1) / 2 - flat.anchorU);
  center.y = (seg.v0 + seg.v1) / 2;
  return {
    ...flat, center,
    width: seg.u1 - seg.u0, height: seg.v1 - seg.v0,
    yMin: seg.v0, yMax: seg.v1, uMin: seg.u0, uMax: seg.u1,
  };
}

/**
 * 从工作台模型提取立面候选。
 * @returns {{flats:Array, corners:Array}}
 *   flat  = { type, center, normal, d, width, height, yMin, yMax, rotY, area, uMin, uMax, uDir }
 *   corner= { type, center, normal, width, height, yMin, yMax, rotY, area }
 */
export function analyzeSurfaces(root) {
  const out = { flats: [], corners: [] };
  if (!root) return out;
  root.updateWorldMatrix(true, true);
  const modelCenter = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3());

  const buckets = new Map();
  const tris = []; // 立面三角形快照（楼角靠共享边求，见 cornersFromEdges）
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
  const uDir = new THREE.Vector3(), p = new THREE.Vector3();
  let seen = 0;

  root.traverse((mesh) => {
    if (!mesh.isMesh || !mesh.visible || isCompositeChild(mesh)) return;
    const geo = mesh.geometry;
    if (!geo || !geo.attributes || !geo.attributes.position) return;
    const pos = geo.attributes.position;
    const idx = geo.index;
    const count = idx ? idx.count : pos.count;
    if (count < 3) return;
    const triCount = Math.floor(count / 3);
    const stepN = Math.max(1, Math.ceil(triCount / MAX_TRIS));

    for (let t = 0; t < triCount && seen < MAX_TRIS; t += stepN) {
      const i = t * 3;
      a.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(pos, idx ? idx.getX(i + 1) : i + 1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(pos, idx ? idx.getX(i + 2) : i + 2).applyMatrix4(mesh.matrixWorld);
      ab.subVectors(b, a); ac.subVectors(c, a);
      n.crossVectors(ab, ac);
      const area2 = n.length();
      if (area2 < 1) continue; // 太小 / 退化三角形
      n.multiplyScalar(1 / area2);
      if (Math.abs(n.y) > 0.35) continue; // 只看立面，不看地面 / 屋顶
      seen++;

      uDir.set(-n.z, 0, n.x).normalize();
      const d = n.dot(a);
      const angle = Math.atan2(n.x, n.z);
      // 角度取模到 [0,32)：atan2 对同一朝向会给出 ±π，不归一化会把一整面墙
      // 拆成两个桶、每桶只剩 1 个三角面而被丢弃（墙凭空消失 / 只剩半个宽）
      const bin = ((Math.round(angle / ANGLE_BIN) % ANGLE_BINS) + ANGLE_BINS) % ANGLE_BINS;
      const key = `${bin}|${Math.round(d / DIST_BIN)}`;
      let g = buckets.get(key);
      if (!g) {
        p.copy(a).add(b).add(c).multiplyScalar(1 / 3);
        g = {
          nSum: new THREE.Vector3(), dSum: 0, area: 0, triCount: 0,
          uMin: Infinity, uMax: -Infinity, vMin: Infinity, vMax: -Infinity,
          uDir: uDir.clone(), anchor: p.clone(), anchorU: p.dot(uDir), anchorV: p.y,
          tris: [],
        };
        buckets.set(key, g);
      }
      g.nSum.add(n);
      g.dSum += d;
      g.area += area2 / 2;
      g.triCount++;
      let tu0 = Infinity, tu1 = -Infinity, tv0 = Infinity, tv1 = -Infinity;
      for (const v of [a, b, c]) {
        const u = v.dot(uDir), y = v.y;
        if (u < g.uMin) g.uMin = u;
        if (u > g.uMax) g.uMax = u;
        if (y < g.vMin) g.vMin = y;
        if (y > g.vMax) g.vMax = y;
        if (u < tu0) tu0 = u;
        if (u > tu1) tu1 = u;
        if (y < tv0) tv0 = y;
        if (y > tv1) tv1 = y;
      }
      g.tris.push([tu0, tu1, tv0, tv1]);
      // 楼角要从网格共享边求（平面取平均后求交线会跑到楼外），这里留一份三角形快照
      if (area2 / 2 > 0.5) {
        tris.push({ n: n.clone(), area: area2 / 2, p: [a.clone(), b.clone(), c.clone()] });
      }
    }
  });

  for (const g of buckets.values()) {
    if (g.triCount < 2) continue;
    // 同一平面可能被缺口 / 内凹分成好几段墙：默认取最长的那一段，
    // 不用整条 u 范围（否则屏会按「两倍墙宽」去放大）
    const segments = mergeSegments(g.tris);
    let seg = null;
    for (const s of segments) {
      if (!seg || s.u1 - s.u0 > seg.u1 - seg.u0) seg = s;
    }
    const width = seg ? seg.u1 - seg.u0 : g.uMax - g.uMin;
    const height = seg ? seg.v1 - seg.v0 : g.vMax - g.vMin;
    if (g.area < MIN_AREA || width < MIN_WIDTH || height < MIN_HEIGHT) continue;
    const normal = g.nSum.clone().normalize();
    const d = g.dSum / g.triCount;
    const center = g.anchor.clone().addScaledVector(g.uDir,
      (seg ? (seg.u0 + seg.u1) / 2 : (g.uMin + g.uMax) / 2) - g.anchorU);
    center.y = seg ? (seg.v0 + seg.v1) / 2 : (g.vMin + g.vMax) / 2;
    // 统一朝模型外侧：法线反向时平面方程 d 也要跟着变号
    const outward = center.clone().sub(modelCenter); outward.y = 0;
    let dd = d;
    if (normal.dot(outward) < 0) { normal.negate(); dd = -d; }
    out.flats.push({
      type: "flat", center, normal, d: dd, width, height,
      yMin: seg ? seg.v0 : g.vMin, yMax: seg ? seg.v1 : g.vMax,
      rotY: Math.atan2(normal.x, normal.z), area: g.area,
      uMin: seg ? seg.u0 : g.uMin, uMax: seg ? seg.u1 : g.uMax, uDir: g.uDir,
      // 落点精确定位用：段列表 + 锚点，便于把面收窄到「落点所在的那一段墙」
      segments, anchor: g.anchor.clone(), anchorU: g.anchorU,
    });
  }
  out.flats.sort((x, y) => y.area - x.area);

  // 楼角优先用网格共享边（真实棱线）；拿不到共享边才退回「两个平均平面求交」
  for (const ec of cornersFromEdges(tris)) {
    // 角屏几何：A 面朝局部 -Z、B 面朝局部 -X，两面成 90°。
    // 选一个面作 A，使另一面的外法线 = (nA.z, -nA.x)
    const perp = (n) => new THREE.Vector3(n.z, 0, -n.x);
    let nA = ec.n1, nB = ec.n2;
    if (perp(nA).dot(nB) < 0.9) { nA = ec.n2; nB = ec.n1; }
    if (perp(nA).dot(nB) < 0.9) continue;   // 两面不是标准直角
    const dirA = new THREE.Vector3(-nA.z, 0, nA.x); // 局部 +X 的世界方向
    const dirB = nA.clone().negate();               // 局部 +Z 的世界方向
    const lenA = runAlongWall(out.flats, ec.center, nA, dirA);
    const lenB = runAlongWall(out.flats, ec.center, nB, dirB);
    if (lenA < 4 || lenB < 4) continue;
    out.corners.push({
      type: "corner",
      center: new THREE.Vector3(ec.center.x, Math.max(3, ec.center.y), ec.center.z),
      normal: nA.clone().add(nB).normalize(),
      width: Math.min(lenA, lenB), lenA, lenB,
      height: ec.height, yMin: ec.yMin, yMax: ec.yMax,
      rotY: Math.atan2(-nA.x, -nA.z),
      area: ec.height * Math.min(lenA, lenB),
    });
  }

  // 兜底：两个近似垂直的平面相交 = 楼角（网格没有共享边信息时才会走到这里）
  if (!out.corners.length) for (let i = 0; i < out.flats.length; i++) {
    for (let j = i + 1; j < out.flats.length; j++) {
      const f1 = out.flats[i], f2 = out.flats[j];
      const det = f1.normal.x * f2.normal.z - f1.normal.z * f2.normal.x;
      if (Math.abs(f1.normal.dot(f2.normal)) > 0.35 || Math.abs(det) < 0.4) continue;
      const x = (f1.d * f2.normal.z - f2.d * f1.normal.z) / det;
      const z = (f1.normal.x * f2.d - f2.normal.x * f1.d) / det;
      const u1 = x * f1.uDir.x + z * f1.uDir.z;
      const u2 = x * f2.uDir.x + z * f2.uDir.z;
      // 棱线必须真的落在这两堵墙的某一段上（同平面被缺口断开的墙体不能算连续）
      const seg1 = segmentAt(f1, u1), seg2 = segmentAt(f2, u2);
      const onWall1 = seg1 ? (u1 >= seg1.u0 - 1 && u1 <= seg1.u1 + 1) : (u1 >= f1.uMin - 1 && u1 <= f1.uMax + 1);
      const onWall2 = seg2 ? (u2 >= seg2.u0 - 1 && u2 <= seg2.u1 + 1) : (u2 >= f2.uMin - 1 && u2 <= f2.uMax + 1);
      if (!onWall1 || !onWall2) continue;
      const yLow = Math.max(seg1 ? seg1.v0 : f1.yMin, seg2 ? seg2.v0 : f2.yMin);
      const yHigh = Math.min(seg1 ? seg1.v1 : f1.yMax, seg2 ? seg2.v1 : f2.yMax);
      if (yHigh - yLow < MIN_HEIGHT) continue;
      // 转角屏几何基准朝 -Z/-X（挂件已回移到棱线），再转 π 才能让两面分别贴住两堵墙
      const rotY = (det > 0 ? Math.atan2(f2.normal.x, f2.normal.z)
        : Math.atan2(f1.normal.x, f1.normal.z)) + Math.PI;
      // 转角屏从楼角沿各自墙面向「一侧」展开，可用长度是角点到墙边沿那一段，
      // 不是整面墙宽。按 rotY 推出两面延伸方向再量，屏才不会比建筑还宽。
      const wallA = det > 0 ? f2 : f1; // det>0 时 A 面贴 f2 墙、B 面贴 f1 墙
      const wallB = det > 0 ? f1 : f2;
      const uA = det > 0 ? u2 : u1;
      const uB = det > 0 ? u1 : u2;
      const dirA = [Math.cos(rotY), -Math.sin(rotY)]; // 局部 +X 旋转 rotY
      const dirB = [Math.sin(rotY), Math.cos(rotY)];  // 局部 +Z 旋转 rotY
      const signA = dirA[0] * wallA.uDir.x + dirA[1] * wallA.uDir.z;
      const signB = dirB[0] * wallB.uDir.x + dirB[1] * wallB.uDir.z;
      // 可用长度按角点所在的那一段墙量（墙角到墙边沿），不是整面墙的 u 范围
      const sA = segmentAt(wallA, uA) || { u0: wallA.uMin, u1: wallA.uMax };
      const sB = segmentAt(wallB, uB) || { u0: wallB.uMin, u1: wallB.uMax };
      const lenA = signA > 0 ? sA.u1 - uA : uA - sA.u0;
      const lenB = signB > 0 ? sB.u1 - uB : uB - sB.u0;
      if (lenA < 4 || lenB < 4) continue; // 这个朝向上有一面没墙，屏会悬空
      out.corners.push({
        type: "corner",
        center: new THREE.Vector3(x, Math.max(3, (yLow + yHigh) / 2), z),
        normal: f1.normal.clone().add(f2.normal).normalize(),
        width: Math.min(lenA, lenB), lenA, lenB, height: yHigh - yLow,
        yMin: yLow, yMax: yHigh, rotY, area: Math.min(f1.area, f2.area),
      });
    }
  }
  out.corners.sort((x, y) => y.area - x.area);
  // 相邻体块会产生重叠的内墙面，同一个转角可能被检出多次；按落点与朝向去重
  const unique = [];
  for (const c of out.corners) {
    if (unique.some((u) => u.center.distanceToSquared(c.center) < 1 && Math.abs(u.rotY - c.rotY) < 0.2)) continue;
    unique.push(c);
  }
  out.corners = unique;
  return out;
}

/**
 * 给广告屏资产挑一个最合适的面，并算好缩放：
 * 单面资产（立面/独立）选 flat，转角资产（corner/corner3d）选 corner。
 * hint 为拖放落点：有则「落点优先」——先找落点所在的面 / 楼角，
 * 找不到才退回就近选面；无则选面积最大的面（点卡片 ＋ 时用）。
 */
export function fitScreenToModel(surfaces, asset, hint = null) {
  if (!surfaces || !asset || !asset.billboard) return null;
  const mount = asset.billboard.mount || "facade";
  const isCorner = mount === "corner" || mount === "corner3d";
  const pool = (isCorner ? surfaces.corners : surfaces.flats).slice();
  if (!pool.length) return null;
  let s = null;
  if (!isCorner && hint) {
    // 单面屏：优先「落点真正贴着的那一段墙」。同一平面里被缺口 / 内凹分开的
    // 其他墙段不能算进来，否则屏会按整条平面的长度放大，比实际墙面还宽。
    let best = null, bestScore = Infinity;
    for (const f of pool) {
      const wall = wallAtPoint(f, hint);
      if (!wall) continue;
      const planeDist = Math.abs(f.normal.dot(hint) - f.d);
      if (planeDist > 2.5) continue; // 落点不在这堵墙的平面上
      const outY = hint.y < wall.yMin - 1 || hint.y > wall.yMax + 1 ? 8 : 0;
      const score = planeDist * 4 + outY;
      if (score < bestScore - 1e-6 || (Math.abs(score - bestScore) < 1e-6 && best && wall.width < best.width)) {
        bestScore = score; best = wall;
      }
    }
    s = best;
  }
  if (!s && isCorner && hint) {
    // 转角屏：优先「落点所在墙面」的楼角 —— 拖在哪面墙上，就贴这面墙的角，
    // 不选别的墙上的角（哪怕它离落点更近 / 面积更大）。
    // 角屏朝向约定：A 面贴 nA 墙、沿 -nB 延伸 lenA；B 面贴 nB 墙、沿 -nA 延伸 lenB
    let best = null, bestDist = Infinity;
    for (const c of pool) {
      const nA = new THREE.Vector3(-Math.sin(c.rotY), 0, -Math.cos(c.rotY));
      const nB = new THREE.Vector3(-Math.cos(c.rotY), 0, Math.sin(c.rotY));
      const off = new THREE.Vector3(hint.x - c.center.x, 0, hint.z - c.center.z);
      const latA = off.dot(nB), latB = off.dot(nA);
      const onA = Math.abs(off.dot(nA)) < 2.5 && latA <= 0.5 && latA >= -(c.lenA || 20) - 1;
      const onB = Math.abs(off.dot(nB)) < 2.5 && latB <= 0.5 && latB >= -(c.lenB || 20) - 1;
      if (!onA && !onB) continue;
      const dist = off.lengthSq();
      if (dist < bestDist) { bestDist = dist; best = c; }
    }
    if (best) s = best;
  }
  if (!s) {
    if (hint) pool.sort((x, y) => x.center.distanceToSquared(hint) - y.center.distanceToSquared(hint));
    s = pool[0];
  }
  const spec = billboardSpecFromAsset(asset);
  const w0 = spec.w || 14, h0 = spec.h || 8;
  // 每边留 0.8m 安装余量；运行时 normalizeSpec 的 w∈[4,40] / h∈[2,30] 也要满足
  const maxH = Math.max(2, s.height - 1.6);
  let kh = Math.min(maxH / h0, 3, 30 / h0);
  kh = Math.max(kh, 2 / h0, 0.2);
  let w, wA, wB, k;
  if (isCorner) {
    // 左右屏长各自贴合「角点 → 墙边沿」的可用长度；比墙宽就缩到与墙等宽
    const maxWA = Math.max(4, (s.lenA || s.width) - 1.6);
    const maxWB = Math.max(4, (s.lenB || s.width) - 1.6);
    wA = +Math.min(40, maxWA).toFixed(2);
    wB = +Math.min(40, maxWB).toFixed(2);
    w = +Math.min(wA, wB).toFixed(2);
    k = w / w0;
  } else {
    k = Math.min((s.width - 1.6) / w0, kh, 3);
    k = Math.min(k, 40 / w0);
    k = Math.max(k, 4 / w0, 0.2);
    w = +(w0 * k).toFixed(2);
    wA = w; wB = w;
  }
  // 离地高度（屏心）在预览与运行时必须同一份
  let centerY;
  let room = maxH;
  if (isCorner && hint) {
    // 转角屏按落点高度挂：楼体和楼角都很高时，屏不该自动跑到楼角中部
    const lo = (s.yMin ?? 0) + 2, hi = Math.max(lo, (s.yMax ?? 30) - 2);
    centerY = Math.max(3, Math.min(hi, Math.max(lo, hint.y)));
    room = Math.max(2, Math.min(centerY - (s.yMin ?? 0), (s.yMax ?? 30) - centerY) * 2 - 1.2);
  } else {
    centerY = Math.max(3, s.center.y);
  }
  return {
    point: s.center.clone().setY(centerY), rotY: s.rotY, scale: +k.toFixed(3), surface: s,
    // 直接给出可读的屏幕规格，工坊面板可继续单独改左右屏长 / 离地高度
    // 屏高随宽度等比缩放，不把整面墙铺满成竖长条；仍受墙高与运行时 clamp 约束
    spec: {
      w, h: +Math.max(2, Math.min(30, maxH, room, h0 * k)).toFixed(2),
      y: +centerY.toFixed(2), wA, wB,
    },
  };
}

/* ---------------- 实测校正：直接对着渲染出来的模型量墙 ----------------
 * 上面的分析是按三角面聚类估出来的，遇到描边建筑（斜切面）、贴图窗户、飘窗、
 * 女儿墙等情况仍可能把「墙」估得比肉眼看到的长。这里改用射线：从墙外侧回打，
 * 沿墙面方向逐段探测，只有连续命中同一面墙（同深度、同朝向）才算可用长度，
 * 于是屏的宽高与中心必然落在实际墙面上，不会再伸到楼外。 */

const PROBE_STEP = 0.5;   // 沿墙扫描步长(m)
const PROBE_MAX = 45;     // 单侧最大扫描长度(m)
const PROBE_BACK = 2.5;   // 从墙外多远处往回打
const PROBE_DEPTH_TOL = 1.2; // 同一面墙允许的平面深度差(m)
const PROBE_DOT = 0.7;    // 同一面墙允许的法线夹角

const _UP = new THREE.Vector3(0, 1, 0);

/** 构造探针：point 处是否有同向墙面命中，命中返回 { point, normal } */
function makeProbe(root) {
  const rc = new THREE.Raycaster();
  const from = new THREE.Vector3(), dir = new THREE.Vector3(), nrm = new THREE.Vector3();
  return (point, normal) => {
    from.copy(point).addScaledVector(normal, PROBE_BACK);
    dir.copy(normal).negate();
    rc.set(from, dir);
    rc.near = 0; rc.far = PROBE_BACK + 3;
    const hits = rc.intersectObject(root, true);
    for (const h of hits) {
      const o = h.object;
      if (!o || !o.isMesh || !o.visible || isCompositeChild(o)) continue;
      if (h.face) {
        nrm.copy(h.face.normal).transformDirection(o.matrixWorld);
        if (nrm.dot(normal) < PROBE_DOT) continue; // 窗框 / 侧面 / 背面不算墙面
        return { point: h.point, normal: nrm.clone() };
      }
      return { point: h.point, normal: normal.clone() };
    }
    return null;
  };
}

/** 以 point 为原点沿 tangent 双向扫描，返回两侧连续墙面的偏移 [lo, hi]。
 *  loMax / hiMax = 该侧扫到上限还没断（墙比扫描范围长），不能当成墙的边界。 */
function scanRun(probe, point, normal, tangent, depth, max = PROBE_MAX) {
  const p = new THREE.Vector3();
  const step = (sign) => {
    let last = 0;
    for (let s = PROBE_STEP; s <= max; s += PROBE_STEP) {
      p.copy(point).addScaledVector(tangent, sign * s);
      const hit = probe(p, normal);
      if (!hit || Math.abs(hit.point.dot(normal) - depth) > PROBE_DEPTH_TOL) break;
      last = s;
    }
    return last;
  };
  const lo = step(-1), hi = step(1);
  return { lo: -lo, hi, loMax: lo >= max, hiMax: hi >= max };
}

/** 从 origin 起只朝 tangent 正方向扫描（转角屏从楼角往一侧展开） */
function scanForward(probe, origin, normal, tangent, depth, max = PROBE_MAX) {
  const p = new THREE.Vector3();
  let last = 0;
  for (let s = PROBE_STEP; s <= max; s += PROBE_STEP) {
    p.copy(origin).addScaledVector(tangent, s);
    const hit = probe(p, normal);
    if (!hit || Math.abs(hit.point.dot(normal) - depth) > PROBE_DEPTH_TOL) break;
    last = s;
  }
  return last;
}

/**
 * 用实测墙面校正 fitScreenToModel 结果（只缩小、不放大的保守策略）。
 * 任何一步拿不到可信数据就原样返回，绝不把屏推得比分析结果更大。
 * @param {THREE.Object3D} root 工作台模型根（零变换）
 * @param {object} fit fitScreenToModel 的返回值
 * @param {object} asset 广告屏资产记录
 */
export function refineFitOnModel(root, fit, asset, hint = null) {
  if (!root || !fit || !fit.spec || !asset || !asset.billboard) return fit;
  const mount = asset.billboard.mount || "facade";
  const isCorner = mount === "corner" || mount === "corner3d";
  try {
    root.updateWorldMatrix(true, true);
    const probe = makeProbe(root);
    const spec = { ...fit.spec };
    const point = fit.point.clone();
    let rotY = fit.rotY;

    if (!isCorner) {
      const surface = fit.surface || {};
      if (!surface.normal) return fit;
      const normal = surface.normal.clone().setY(0).normalize();
      const tangent = (surface.uDir ? surface.uDir.clone() : new THREE.Vector3(-normal.z, 0, normal.x))
        .setY(0).normalize();
      if (!normal.lengthSq() || !tangent.lengthSq()) return fit;
      let hit = probe(point, normal);
      // 落点优先：分析挑的墙若不包含落点（拖在了另一面墙上 / 平均平面偏移），
      // 改贴「落点真正打到的那面墙」——交互上屏必须出现在鼠标松手的位置附近
      const onHint = !hint || !surface.uDir ? true : (() => {
        const u = hint.x * surface.uDir.x + hint.z * surface.uDir.z;
        const d = surface.d != null ? surface.d : point.dot(surface.normal);
        return Math.abs(surface.normal.dot(hint) - d) < 2.5
          && u >= (surface.uMin ?? -1e9) - 1 && u <= (surface.uMax ?? 1e9) + 1;
      })();
      const dropAnchored = !!hint; // 有落点时垂直方向也跟随鼠标高度
      if (!hit || !onHint) {
        let adopted = false;
        if (hint) {
          const hHit = probe(hint, normal);
          if (hHit) {
            const hN = hHit.normal.clone().setY(0).normalize();
            const hT = new THREE.Vector3(-hN.z, 0, hN.x);
            // 落点那面墙太短（窗框 / 护栏等小构件）就别跟过去，保留分析结果
            const hRun = scanRun(probe, hHit.point, hN, hT, hHit.point.dot(hN));
            if (hRun.hi - hRun.lo >= 4) {
              point.copy(hHit.point);
              normal.copy(hN);
              tangent.copy(hT);
              rotY = Math.atan2(normal.x, normal.z);
              adopted = true;
            }
          }
        }
        if (!adopted && !hit) return fit;
      }
      const depth = point.dot(normal);
      const h = scanRun(probe, point, normal, tangent, depth);
      const span = h.hi - h.lo;
      // 扫到上限还没断 = 墙比扫描范围长：不能把它当边界收缩，也不该挪屏心
      if (span > 4 && !h.loMax && !h.hiMax) {
        const maxW = Math.max(4, span - 1.6);
        spec.w = +Math.min(spec.w, maxW).toFixed(2);
        spec.wA = spec.w; spec.wB = spec.w;
        point.addScaledVector(tangent, (h.lo + h.hi) / 2); // 居中到实测墙段
      }
      const v = scanRun(probe, point, normal, _UP, depth, 30);
      const vSpan = v.hi - v.lo;
      if (vSpan > 3) {
        const vLo = v.loMax ? -Infinity : point.y + v.lo;
        const vHi = v.hiMax ? Infinity : point.y + v.hi;
        // 落点优先：有落点时屏心停在鼠标松手的高度（夹在实测墙高范围内），
        // 不自动跑到墙高中部；点卡片 ＋（无落点）才取墙段居中
        const centerY = dropAnchored
          ? Math.min(Math.max(hint.y, vLo + 0.5), Math.max(vLo + 0.5, vHi - 0.5))
          : (v.loMax && v.hiMax ? point.y : point.y + (v.lo + v.hi) / 2);
        const room = (v.loMax && v.hiMax) ? Infinity
          : v.loMax ? (vHi - centerY) * 2 - 1.2
          : v.hiMax ? (centerY - vLo) * 2 - 1.2
          : Math.min(centerY - vLo, vHi - centerY) * 2 - 1.2;
        spec.h = +Math.max(2, Math.min(spec.h, room)).toFixed(2);
        point.y = centerY;
      }
      spec.y = +Math.max(0.5 + spec.h / 2, point.y, 3).toFixed(2);
      point.y = spec.y;
      return { ...fit, point, rotY, spec };
    }

    // 转角：按 rotY 拆出两面墙的切向与法向，从楼角沿各自墙面量可用长度
    const dirA = new THREE.Vector3(Math.cos(rotY), 0, -Math.sin(rotY));
    const dirB = new THREE.Vector3(Math.sin(rotY), 0, Math.cos(rotY));
    const nA = dirB.clone().negate(); // A 面朝局部 -Z
    const nB = dirA.clone().negate(); // B 面朝局部 -X
    const depthA = point.dot(nA), depthB = point.dot(nB);
    if (!probe(point, nA) || !probe(point, nB)) return fit; // 楼角不在墙上
    const runA = scanForward(probe, point, nA, dirA, depthA);
    const runB = scanForward(probe, point, nB, dirB, depthB);
    if (runA > 4) spec.wA = +Math.max(4, Math.min(spec.wA, runA - 1.6)).toFixed(2);
    if (runB > 4) spec.wB = +Math.max(4, Math.min(spec.wB, runB - 1.6)).toFixed(2);
    spec.w = +Math.min(spec.wA, spec.wB).toFixed(2);
    return { ...fit, point, rotY, spec };
  } catch (e) {
    console.warn("[surfaceFit] 实测校正失败，沿用分析结果:", e);
    return fit;
  }
}
