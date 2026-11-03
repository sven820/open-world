// 3D 编辑器描边内容（features.roads/rivers + objects 建筑/树/路灯）→ 运行时世界网格。
// 编辑器数据为局部平面米制坐标，运行时世界同为平面坐标，直接按坐标构建；
// 与编辑器渲染语义保持一致：建筑 = footprint（绝对坐标）+ pos 平移 + rot 旋转。
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { mapBounds } from "../data/cityData.js";

const wallMat = () => new THREE.MeshStandardMaterial({ color: 0xb8b2a6, roughness: 0.85 });
const roofMat = () => new THREE.MeshStandardMaterial({ color: 0x6f6a60, roughness: 0.9 });
const roadMat = () => new THREE.MeshStandardMaterial({ color: 0x2e3742, roughness: 0.95 });
const sidewalkMat = () => new THREE.MeshStandardMaterial({ color: 0x9aa2ab, roughness: 0.92 });
const medianBedMat = () => new THREE.MeshStandardMaterial({ color: 0x9aa2ab, roughness: 0.92 });
const hedgeMat = () => new THREE.MeshStandardMaterial({ color: 0x2f5426, roughness: 1 });
const markWhiteMat = () => new THREE.MeshBasicMaterial({ color: 0xe8e8e2, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
const markYellowMat = () => new THREE.MeshBasicMaterial({ color: 0xd8a524, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
const riverMat = () => new THREE.MeshStandardMaterial({ color: 0x1d5f8f, transparent: true, opacity: 0.8, roughness: 0.25 });

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
  const discs = [];
  for (const p of points) {
    const c = new THREE.CircleGeometry(hw, 10);
    c.deleteAttribute("uv");
    c.rotateX(-Math.PI / 2);
    c.translate(p.x, y + discLift, p.z);
    discs.push(c);
  }
  const merged = mergeGeometries([geo, mergeGeometries(discs)]);
  return merged || geo;
}

function polyline(points) {
  return (points || []).map(([x, z]) => ({ x, z }));
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

// 沿段方向的标线四边形（略加长补段间缝隙）
function markQuad(x0, z0, x1, z1, w, y) {
  const dx = x1 - x0, dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  if (len < 0.02) return null;
  const g = new THREE.PlaneGeometry(len + w * 0.6, w);
  g.deleteAttribute("uv");   // 纯色标线：与 stripGeometry 产物属性保持一致才能合并
  g.rotateX(-Math.PI / 2);
  g.rotateY(Math.atan2(-dz, dx));
  g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
  return g;
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
  const walls = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false }).rotateX(-Math.PI / 2), wallMat());
  walls.castShadow = true; walls.receiveShadow = true;
  const roof = new THREE.Mesh(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2).translate(0, h, 0), roofMat());
  const g = new THREE.Group();
  g.add(walls, roof);
  g.position.set(obj.pos[0], 0, obj.pos[1]);
  g.rotation.y = obj.rot || 0;
  return g;
}

// 建筑/树/路灯的碰撞盒（AABB，含编辑器同款 pos+rot 变换）
function footprintAABB(obj) {
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

function treeMesh(obj) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.35, 3, 6), new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 1 }));
  trunk.position.y = 1.5; trunk.castShadow = true;
  const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(2.2, 0), new THREE.MeshStandardMaterial({ color: 0x2f7a3f, roughness: 1, flatShading: true }));
  crown.position.y = 4.6; crown.castShadow = true;
  g.add(trunk, crown);
  g.scale.setScalar(obj.sc || 1);
  g.position.set(obj.pos[0], obj.baseY || 0, obj.pos[1]);
  return g;
}

function lampMesh(obj) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 6.5, 6), new THREE.MeshStandardMaterial({ color: 0x3c4650, roughness: 0.6 }));
  pole.position.y = 3.25; pole.castShadow = true;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.45, 10, 8), new THREE.MeshStandardMaterial({ color: 0xfff3c4, emissive: 0xffd873, emissiveIntensity: 1.4 }));
  head.position.y = 6.6;
  g.add(pole, head);
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
export function buildCustomMap(data, colliders) {
  const bbox = customBBox(data);
  if (!bbox) return null;
  const group = new THREE.Group();
  group.name = "customMap";

  for (const r of data.features.roads || []) {
    if (!r.points || r.points.length < 2) continue;
    const pts = polyline(r.points);
    // 程序化街区平台顶 0.16 —— 描边路面抬到其上，穿越街区时路面不被平台盖住
    let m;
    if (r.closed && r.points.length >= 3) {
      // 取面道路（closed）：围合多边形整体填充为路面
      const shape = new THREE.Shape(r.points.map(([x, z]) => new THREE.Vector2(x, -z)));
      m = new THREE.Mesh(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2).translate(0, 0.18, 0), roadMat());
    } else {
      m = new THREE.Mesh(stripGeometry(pts, r.width || 12, 0.18), roadMat());
    }
    m.receiveShadow = true;
    group.add(m);
    // 人行道：沿两侧偏移的窄条带（路缘高出路面 6cm）；取面路为整块填充，无侧边不生成
    const sw = Math.min(Math.max(r.sidewalk ?? 3, 0), 12);
    const half = (r.width || 12) / 2;
    if (!r.closed && sw > 0) {
      for (const s of [1, -1]) {
        const sm = new THREE.Mesh(stripGeometry(offsetPolyline(pts, s * (half + sw / 2)), sw, 0.24), sidewalkMat());
        sm.receiveShadow = true;
        group.add(sm);
      }
    }
    // 车道标线 / 双黄线 / 分隔带（与程序化横纵路同语义）。
    // 描边路宽度固定，车道数由用户指定：车道白虚线按固定车道宽 3.4m 布置；
    // 线形路沿折线（折线即路中心）；取面路沿最小外接矩形长轴中线（直路取面才有中线）
    const lanes = Math.min(Math.max(r.lanes ?? 2, 1), 4);
    const med = Math.min(Math.max(r.median ?? 0, 0), 14);
    let markPts = null;
    if (!r.closed) markPts = pts;
    else {
      const cl = polyCenterLine(r.points, 80);
      if (cl) markPts = [{ x: cl[0][0], z: cl[0][1] }, { x: cl[1][0], z: cl[1][1] }];
    }
    if (markPts) {
      const whites = [], yellows = [], beds = [], hedges = [];
      for (const s of [-1, 1]) {
        if (!r.closed) emitSolid(offsetPolyline(markPts, s * (half - 0.16)), 0.19, 0.14, whites); // 路缘白实线
        for (let lane = 1; lane < lanes; lane++) {
          const off = med / 2 + lane * 3.4; // 固定车道宽 3.4m
          if (!r.closed && off > half - 0.35) break; // 超出车行道不画
          emitDashes(offsetPolyline(markPts, s * off), 0.19, whites);
        }
      }
      if (med > 0) {
        // 中央分隔带：基座 + 绿篱 + 行道树（median ≥ 5 时每 ~22m，缩小 0.8）
        emitBoxStrip(markPts, med, 0.2, 0.28, beds);
        emitBoxStrip(markPts, Math.max(0.9, med - 1.4), 0.55, 0.56, hedges);
      } else {
        emitSolid(offsetPolyline(markPts, -0.17), 0.19, 0.1, yellows); // 双黄线
        emitSolid(offsetPolyline(markPts, 0.17), 0.19, 0.1, yellows);
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
        let acc = 0, next = 12;
        for (let i = 0; i + 1 < markPts.length; i++) {
          const a = markPts[i], b = markPts[i + 1];
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
  for (const r of data.features.rivers || []) {
    if (!r.points || r.points.length < 2) continue;
    const m = new THREE.Mesh(stripGeometry(polyline(r.points), r.width || 26, 0.05), riverMat());
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
