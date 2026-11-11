// 3D 编辑器公共小工具：数值/ID/格式化、道路类型常量、米↔经纬度换算。

// 程序化道路类型（与 2D 编辑器一致）
export const ROAD_KINDS = ["street", "arterial", "boulevard"];
export const ROAD_KIND_ZH = { street: "街道", arterial: "干道", boulevard: "大道" };

// 米 ↔ 经纬度（局部 ENU 近似，3km 内误差 <0.5m）
// origin 语义 = 地图范围中心 (area.cx, area.cz) 在地球上的经纬度；
// 任意局部点 (x,z) 的经纬度按相对中心的偏移换算。移动范围即整体搬移地图在地球上的落点。
export const M_PER_DEG_LAT = 111320;
export function lonLatAt(origin, area, x, z) {
  const dx = x - (area ? area.cx : 0), dz = z - (area ? area.cz : 0);
  return {
    lon: origin.lon + dx / (M_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180)),
    lat: origin.lat + -dz / M_PER_DEG_LAT,
  };
}
// 经纬度偏移 → 局部米位移：未直接使用，保留公式备注
// dx = dLon · M_PER_DEG_LAT · cos(lat)；dz = -dLat · M_PER_DEG_LAT

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const uid = () => "o" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
export const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)}km` : `${Math.round(m)}m`);

// 鞋带公式：多边形面积（有符号）
export function polyArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % pts.length];
    a += x1 * z2 - x2 * z1;
  }
  return a / 2;
}

export function polylineLen(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

// 手工描边平滑：① 1-2-1 卷积两轮去除手抖噪声（闭合时环绕，刻意直角/收口区不动）；
// ② Chaikin 角切割两轮（严格在凸包内，绝不外凸；直角顶点原样保留）；
// ③ 弦长等距线性重采样（Chaikin 后已足够圆滑）；
// ④ 闭合面按质心等比放大回原面积（平滑会使面积略缩）。
// keepEnds > 0 时（闭合面）：收口起点沿路径两侧该弧长内的顶点全部保持原样，头尾拐角不磨圆
export function smoothPath(pts, closed, step = 3, keepEnds = 0) {
  if (pts.length < 3) return pts.map((p) => [p[0], p[1]]);
  const n0 = pts.length;
  // 收口保护区：闭合面起点沿路径正/反向 keepEnds 弧长内
  const protect = new Array(n0).fill(false);
  if (closed && keepEnds > 0) {
    const d = [0];
    for (let i = 1; i < n0; i++) d.push(d[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = d[n0 - 1] + Math.hypot(pts[0][0] - pts[n0 - 1][0], pts[0][1] - pts[n0 - 1][1]);
    for (let i = 0; i < n0; i++) if (Math.min(d[i], total - d[i]) <= keepEnds) protect[i] = true;
  }
  // 转角检测（带符号）：|转角| >40° 且相邻转角非大角度异号（排除左右交替的手抖尖刺）
  // → 刻意直角，平滑时保持原位。全直角多边形（矩形）所有顶点同号，全部保留
  const sharpMarks = (arr) => {
    const n = arr.length, turn = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const p = arr[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
      const v = arr[i], q = arr[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
      const a1 = Math.atan2(v[1] - p[1], v[0] - p[0]);
      const a2 = Math.atan2(q[1] - v[1], q[0] - v[0]);
      let t = a2 - a1;
      while (t > Math.PI) t -= 2 * Math.PI;
      while (t < -Math.PI) t += 2 * Math.PI;
      turn[i] = t;
    }
    return turn.map((t, i) => {
      if (!closed && (i === 0 || i === n - 1)) return false;
      if (Math.abs(t) <= 0.7) return false;
      // 手抖尖刺特征：相邻即出现异号大转角，且两点几乎重合（真凹角与相邻拐角相距很远）
      const pi = closed ? (i - 1 + n) % n : Math.max(0, i - 1);
      const ni = closed ? (i + 1) % n : Math.min(n - 1, i + 1);
      const spike = (Math.abs(turn[pi]) > 0.5 && turn[pi] * t < 0 && Math.hypot(arr[i][0] - arr[pi][0], arr[i][1] - arr[pi][1]) < 3) ||
                    (Math.abs(turn[ni]) > 0.5 && turn[ni] * t < 0 && Math.hypot(arr[i][0] - arr[ni][0], arr[i][1] - arr[ni][1]) < 3);
      return !spike;
    });
  };
  let src = pts.map((p) => [p[0], p[1]]);
  let marks = sharpMarks(src);
  for (let k = 0; k < 2; k++) {
    const n = src.length, out = [];
    for (let i = 0; i < n; i++) {
      const p = src[i];
      if (protect[i] || marks[i]) { out.push([p[0], p[1]]); continue; } // 直角/收口顶点保持原位
      const prev = src[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
      const next = src[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
      out.push([(prev[0] + 2 * p[0] + next[0]) / 4, (prev[1] + 2 * p[1] + next[1]) / 4]);
    }
    src = out;
  }
  for (let k = 0; k < 2; k++) {
    const n = src.length, out = [];
    const segs = closed ? n : n - 1;
    if (!closed) out.push([src[0][0], src[0][1]]);
    for (let i = 0; i < segs; i++) {
      const p = src[i], q = src[(i + 1) % n];
      // 直角顶点不切割，原样保留，拐角 crisp
      out.push(marks[i] ? [p[0], p[1]] : [p[0] * 0.75 + q[0] * 0.25, p[1] * 0.75 + q[1] * 0.25]);
      out.push(marks[(i + 1) % n] ? [q[0], q[1]] : [p[0] * 0.25 + q[0] * 0.75, p[1] * 0.25 + q[1] * 0.75]);
    }
    if (!closed) out.push([src[n - 1][0], src[n - 1][1]]);
    // 直角顶点原样保留会产生连续重复点（零长度段），需去重，否则转角检测与面积补偿失真
    const ded = [];
    for (const p of out) {
      const l = ded[ded.length - 1];
      if (!l || Math.hypot(p[0] - l[0], p[1] - l[1]) > 0.01) ded.push(p);
    }
    if (closed && ded.length > 1) {
      const f = ded[0], l = ded[ded.length - 1];
      if (Math.hypot(f[0] - l[0], f[1] - l[1]) < 0.01) ded.pop(); // 闭合环首尾重复
    }
    src = ded;
    marks = sharpMarks(src); // 顶点数已变，重算直角标记
  }
  // 弦长等距重采样（线性插值足够：Chaikin 后折线已圆滑）
  const m = src.length;
  const segN = closed ? m : m - 1;
  const segL = [];
  let total = 0;
  for (let i = 0; i < segN; i++) {
    const p = src[i], q = src[(i + 1) % m];
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
    segL.push(l); total += l;
  }
  const count = Math.max(8, Math.min(2000, Math.round(total / step)));
  const res = [];
  let seg = 0, acc = 0;
  for (let k = 0; k < count; k++) {
    const target = (total * k) / count;
    while (seg < segN - 1 && acc + segL[seg] < target) { acc += segL[seg]; seg++; }
    const p = src[seg], q = src[(seg + 1) % m];
    const t = segL[seg] > 0 ? (target - acc) / segL[seg] : 0;
    res.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
  }
  if (!closed) res.push([src[m - 1][0], src[m - 1][1]]);
  if (closed) {
    // 平滑使面积略缩：按质心等比放大回原面积
    const area = (ps) => {
      let a = 0;
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i], q = ps[(i + 1) % ps.length];
        a += p[0] * q[1] - q[0] * p[1];
      }
      return a / 2;
    };
    const a0 = Math.abs(area(pts)), a1 = Math.abs(area(res));
    if (a0 > 0.0001 && a1 > 0.0001) {
      const s = Math.min(1.1, Math.sqrt(a0 / a1)); // 上限 1.1，避免局部圆角损失被整体放大越界
      const cx = res.reduce((t, p) => t + p[0], 0) / res.length;
      const cz = res.reduce((t, p) => t + p[1], 0) / res.length;
      for (const p of res) { p[0] = cx + (p[0] - cx) * s; p[1] = cz + (p[1] - cz) * s; }
    }
  }
  const out = [];
  for (const p of res) {
    const q = [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10];
    const last = out[out.length - 1];
    if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) >= 0.2) out.push(q);
  }
  return out.length >= 2 ? out : src.map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]);
}
