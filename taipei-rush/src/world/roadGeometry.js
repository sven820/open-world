// 2D 几何求交工具：多边形裁切、局部走向估计、直线相交与路面区间测量。
// 供描边路口计算（city.js）、取面路处理（customMap.js）等使用。全部为纯函数。

// 水平线 z = at 与多边形求交，返回落在多边形内部的 x 区段。
// even-odd 规则：顶点正好压在线上时只计一次，不会把一条边算两遍。
export function polyClipX(poly, at) {
  const hits = [];
  for (let i = 0; i < poly.length; i++) {
    const [x1, z1] = poly[i], [x2, z2] = poly[(i + 1) % poly.length];
    if ((z1 > at) === (z2 > at)) continue;
    hits.push(x1 + ((x2 - x1) * (at - z1)) / (z2 - z1));
  }
  hits.sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < hits.length; i += 2) out.push([hits[i], hits[i + 1]]);
  return out;
}

// 竖直线 x = at 与多边形求交，返回内部 z 区段
export function polyClipZ(poly, at) {
  const hits = [];
  for (let i = 0; i < poly.length; i++) {
    const [x1, z1] = poly[i], [x2, z2] = poly[(i + 1) % poly.length];
    if ((x1 > at) === (x2 > at)) continue;
    hits.push(z1 + ((z2 - z1) * (at - x1)) / (x2 - x1));
  }
  hits.sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < hits.length; i += 2) out.push([hits[i], hits[i + 1]]);
  return out;
}

// 截线与多边形交点区段里最长一段的中点；没有交点返回 null
export function polySpanMid(segs) {
  if (!segs.length) return null;
  let best = segs[0];
  for (const s of segs) if (s[1] - s[0] > best[1] - best[0]) best = s;
  return (best[0] + best[1]) / 2;
}

// 面道路在截线 at 处的车流方向。
// 取 at±3 两条平行截线，看区段中点往哪边移 —— 这是路面的局部走向，
// 比"用最长边"可靠：多边形带楔角或 L 形时最长边并不等于该处的车道方向。
// 中点不动（轴对齐矩形）时退回外接矩形长边。
export function polyDirNear(poly, at, horizontal) {
  const d = 3;
  const clip = horizontal ? polyClipX : polyClipZ;
  const a = polySpanMid(clip(poly, at - d));
  const b = polySpanMid(clip(poly, at + d));
  if (a != null && b != null && Math.abs(b - a) > 0.35) {
    const du = b - a;
    const len = Math.hypot(du, 2 * d);
    return horizontal
      ? { ux: du / len, uz: (2 * d) / len }
      : { ux: (2 * d) / len, uz: du / len };
  }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of poly) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return (maxX - minX) > (maxZ - minZ) ? { ux: 1, uz: 0 } : { ux: 0, uz: 1 };
}

// 直线 a(τ) = o + τ·d 与直线 b(σ) = q + σ·e 的交点参数 τ；近平行返回 null
export function lineHitT(ox, oz, dx, dz, qx, qz, ex, ez) {
  const det = dx * ez - dz * ex;
  if (Math.abs(det) < 1e-9) return null;
  return ((qx - ox) * ez - (qz - oz) * ex) / det;
}

// 闭合面路（手绘多边形）与直线 L(τ) = o + τ·d 的相交区间。
// d 是坐标轴方向（程序化横纵路），直接用正交裁切；返回离 o 最近的一段 [τmin, τmax]。
// 路面在斑马线高度上的实际宽度由此实测 —— 手绘面路不是标准矩形，宽度沿线会变。
export function polySpanOnLine(poly, o, dx, dz) {
  const horizontal = Math.abs(dx) >= Math.abs(dz);
  const segs = horizontal ? polyClipX(poly, o.z) : polyClipZ(poly, o.x);
  let best = null, bd = Infinity;
  for (const [a, b] of segs) {
    const t0 = horizontal ? a - o.x : a - o.z;
    const t1 = horizontal ? b - o.x : b - o.z;
    const dist = Math.abs(t0 + t1);
    if (dist < bd) { bd = dist; best = [Math.min(t0, t1), Math.max(t0, t1)]; }
  }
  return best;
}

// 线形描边路（中线过 c、方向 u、半宽 half）与直线 L(τ) = o + τ·d 的相交区间：
// 路的两条边线平行于中线，各求一次与 L 的交点。斜交时区间比垂直路宽长（跨度 = 路宽 / sin交角）。
export function lineRoadSpanOnLine(o, dx, dz, cx, cz, ux, uz, half) {
  const nx = -uz, nz = ux;
  const t1 = lineHitT(o.x, o.z, dx, dz, cx + nx * half, cz + nz * half, ux, uz);
  const t2 = lineHitT(o.x, o.z, dx, dz, cx - nx * half, cz - nz * half, ux, uz);
  if (t1 == null || t2 == null) return null;
  return [Math.min(t1, t2), Math.max(t1, t2)];
}

// 面路路口两侧的实测边界（主路法线方向，相对路口锚点，负值在一侧）。
// 在被穿路开口范围（±scanHalf）内按 ~3m 扫描，只统计「车轴穿过的那段」截线，
// L 形多边形的另一支不会误入。手绘面路宽度沿线变化时，靠它把 B 组斑马线
// 推到两侧最宽边缘之外（否则条会压在变宽的路面下被盖住），并撑大路口断口。
// 车向几乎与扫描线平行（分量≈0）时量不准，返回 null 退回中心线宽度。
export function polyEdgeRange(poly, cx, cz, dir, scanHalf, alongX) {
  const clip = alongX ? polyClipX : polyClipZ;
  const along = alongX ? dir.uz : dir.ux;   // 车向在扫描线推进方向的分量
  if (Math.abs(along) < 1e-6) return null;
  let neg = 0, pos = 0, found = false;
  for (let d = -scanHalf; d <= scanHalf + 1e-6; d += 3) {
    // 车轴与扫描线的交点（扫描线另一维坐标）
    const axisAt = alongX ? cx + (d * dir.ux) / dir.uz : cz + (d * dir.uz) / dir.ux;
    for (const [a, b] of clip(poly, alongX ? cz + d : cx + d)) {
      if (a - 0.5 > axisAt || axisAt > b + 0.5) continue;
      // 截线端点在主路法线上的投影（相对路口锚点）
      const t0 = alongX ? (a - cx) * -dir.uz + d * dir.ux : -d * dir.uz + (a - cz) * dir.ux;
      const t1 = alongX ? (b - cx) * -dir.uz + d * dir.ux : -d * dir.uz + (b - cz) * dir.ux;
      neg = Math.min(neg, t0, t1);
      pos = Math.max(pos, t0, t1);
      found = true;
      break;
    }
  }
  return found ? { edgeNeg: neg, edgePos: pos } : null;
}
