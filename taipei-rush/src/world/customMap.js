// 3D 编辑器描边内容（features.roads/rivers + objects 建筑/树/路灯）→ 运行时世界网格。
// 编辑器数据为局部平面米制坐标，运行时世界同为平面坐标，直接按坐标构建；
// 与编辑器渲染语义保持一致：建筑 = footprint（绝对坐标）+ pos 平移 + rot 旋转。
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { mapBounds } from "../data/cityData.js";

const wallMat = () => new THREE.MeshStandardMaterial({ color: 0xb8b2a6, roughness: 0.85 });
const roofMat = () => new THREE.MeshStandardMaterial({ color: 0x6f6a60, roughness: 0.9 });
const roadMat = () => new THREE.MeshStandardMaterial({ color: 0x2e3742, roughness: 0.95 });
const riverMat = () => new THREE.MeshStandardMaterial({ color: 0x1d5f8f, transparent: true, opacity: 0.8, roughness: 0.25 });

// 折线 → 带状平面网格（两三角/段 + 接头圆片补缝），贴合 y 平面
function stripGeometry(points, width, y) {
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
    c.translate(p.x, y, p.z);
    discs.push(c);
  }
  const merged = mergeGeometries([geo, mergeGeometries(discs)]);
  return merged || geo;
}

function polyline(points) {
  return (points || []).map(([x, z]) => ({ x, z }));
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
  g.position.set(obj.pos[0], 0, obj.pos[1]);
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
    let m;
    if (r.closed && r.points.length >= 3) {
      // 取面道路（closed）：围合多边形整体填充为路面
      const shape = new THREE.Shape(r.points.map(([x, z]) => new THREE.Vector2(x, -z)));
      m = new THREE.Mesh(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2).translate(0, 0.04, 0), roadMat());
    } else {
      m = new THREE.Mesh(stripGeometry(polyline(r.points), r.width || 12, 0.04), roadMat());
    }
    m.receiveShadow = true;
    group.add(m);
  }
  for (const r of data.features.rivers || []) {
    if (!r.points || r.points.length < 2) continue;
    const m = new THREE.Mesh(stripGeometry(polyline(r.points), r.width || 26, 0.02), riverMat());
    m.receiveShadow = true;
    group.add(m);
  }
  for (const o of data.objects || []) {
    if (o.type === "building") {
      const b = buildingGroup(o);
      if (b) {
        group.add(b);
        const box = footprintAABB(o);
        if (box) colliders.add(box.minX, box.minZ, box.maxX, box.maxZ);
      }
    } else if (o.type === "tree") {
      group.add(treeMesh(o));
      colliders.add(o.pos[0] - 0.5, o.pos[1] - 0.5, o.pos[0] + 0.5, o.pos[1] + 0.5);
    } else if (o.type === "lamp") {
      group.add(lampMesh(o));
      colliders.add(o.pos[0] - 0.3, o.pos[1] - 0.3, o.pos[0] + 0.3, o.pos[1] + 0.3);
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
