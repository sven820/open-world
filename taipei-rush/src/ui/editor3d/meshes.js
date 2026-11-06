// 3D 编辑器的几何构建工具：屏幕空间胖线、世界宽度路带、折线条带网格，
// 以及描边实体（道路/河流/建筑/树/路灯）的材质与网格构建。
// 全部以编辑器实例（ed）为第一参数（曲率下沉依赖 ed._curveOffset / ed._three.renderer）。

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { bendGeometry } from "../../config/curvature.js";
import { makeAsphaltTexture, ASPHALT_TILE } from "../../world/textures.js";
import { getMaterial, scaleUVs, uvScaleFor, FACADE_UV, ROOF_UV } from "../../world/materials.js";

// 世界米制 planar UV（与运行时 customMap.planarUV 同式）：纹理按世界坐标对齐，
// 交叠 / 相邻路面的颗粒、明暗斑与轮迹无缝衔接
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

// 屏幕空间胖线（Line2）：线宽恒定像素，任意视角/距离都清晰可见（不受雾影响）；
// 曲率下沉直接烘焙进端点（相邻点间距内弯曲量可忽略），不参与 _bendArea 顶点重写。
// ox/oz：几何存储的相对原点（位置减去原点，曲率仍按绝对坐标计算）
export function fatLine(ed, pts, widthPx, colorHex, opacity, lift, ox = 0, oz = 0) {
  const geo = new LineGeometry();
  geo.setPositions(pts.flatMap((p) => [p.x - ox, lift - ed._curveOffset(p.x, p.z), p.z - oz]));
  const mat = new LineMaterial({
    color: colorHex, linewidth: widthPx, transparent: true, opacity, depthWrite: false,
  });
  const size = ed._three.renderer.getSize(new THREE.Vector2());
  mat.resolution.set(size.x, size.y);
  const line = new Line2(geo, mat);
  line.userData.fatLine = true;
  return line;
}

// 世界宽度路带（贴合曲率）：中心线 pts 两侧偏移 halfW 构建三角条带。
// 真实世界宽 → 透视正确（近宽远窄，平视不失真）；同一几何体无接缝，
// 不会出现屏幕空间胖线的段接缝亮斑 / 近轴向光斑
export function roadRibbon(ed, pts, halfW, colorHex, opacity) {
  const pos = [], idx = [];
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[Math.max(i - 1, 0)], p1 = pts[Math.min(i + 1, pts.length - 1)];
    const dx = p1.x - p0.x, dz = p1.z - p0.z;
    const len = Math.hypot(dx, dz) || 1;
    const ox = (-dz / len) * halfW, oz = (dx / len) * halfW;
    const y = 0.02 - ed._curveOffset(pts[i].x, pts[i].z);
    pos.push(pts[i].x + ox, y, pts[i].z + oz, pts[i].x - ox, y, pts[i].z - oz);
    if (i) {
      const a = (i - 1) * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  planarUV(geo);
  // 贴图与「路块拼接」同一张沥青表面（tint 乘色：选中高亮 / 延伸路区分）；
  // transparent + 不写深度：交叉路带间无 z-fighting，又能被上方路块/条带正确遮挡
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    map: makeAsphaltTexture(), color: colorHex, roughness: 0.94, metalness: 0.0,
    transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide,
  }));
  mesh.renderOrder = 1;
  return mesh;
}

/* ---------------- 实体材质 / 网格 ---------------- */

export function matRoad(tint = 0xffffff) {
  // 与「路块拼接」/程序化横纵路带同一张沥青表面贴图，编辑器内三种路面风格一致。
  // tint 乘色（贴图为灰阶）：默认原色，可传高亮/暗色调区分状态
  return new THREE.MeshStandardMaterial({
    map: makeAsphaltTexture(), color: tint, roughness: 0.94, metalness: 0.0,
  });
}
export const matRiver = () => new THREE.MeshStandardMaterial({ color: 0x1d5f8f, transparent: true, opacity: 0.8, roughness: 0.25, metalness: 0.1 });
export const matBuilding = () => new THREE.MeshStandardMaterial({ color: 0xb8b2a6, roughness: 0.85 });
export const matRoof = () => new THREE.MeshStandardMaterial({ color: 0x6f6a60, roughness: 0.9 });

// 折线 → 带状网格（两三角/段 + 接头圆片补缝）；yBase 区分叠放层次
export function stripGeometry(ed, points, width, yBase = 0.05) {
  const hw = width / 2;
  const verts = [], idx = [];
  const dirs = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const prev = points[Math.max(0, i - 1)], next = points[Math.min(points.length - 1, i + 1)];
    const dx = next.x - prev.x, dz = next.z - prev.z;
    const len = Math.hypot(dx, dz) || 1;
    dirs.push({ nx: -dz / len, nz: dx / len });
  }
  for (let i = 0; i < points.length; i++) {
    const p = points[i], n = dirs[i];
    const y = yBase - ed._curveOffset(p.x, p.z); // 贴合球面（中心零基准）
    verts.push(p.x + n.nx * hw, y, p.z + n.nz * hw);
    verts.push(p.x - n.nx * hw, y, p.z - n.nz * hw);
    if (i < points.length - 1) {
      const a = i * 2;
      // 绕朝上（CCW）：A_i → A_{i+1} → B_i，否则正面朝下被剔除，从上看只剩接头圆片
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  planarUV(geo);
  // 接头圆片（uv 一并按世界坐标写入，与带状几何属性一致，mergeGeometries 才不返回 null）
  const discs = [];
  for (const p of points) {
    const c = new THREE.CircleGeometry(hw, 12);
    c.rotateX(-Math.PI / 2);
    c.translate(p.x, yBase - ed._curveOffset(p.x, p.z), p.z);
    discs.push(planarUV(c));
  }
  const discMerged = mergeGeometries(discs);
  return mergeGeometries([geo, discMerged]) || geo;
}

export function buildRoadMesh(ed, data) {
  if (data.closed && data.points.length >= 3) {
    // 取面道路：围合多边形整体填充为路面
    const shape = new THREE.Shape(data.points.map(([x, z]) => new THREE.Vector2(x, -z)));
    const geo = planarUV(bendGeometry(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2)));
    geo.translate(0, 0.05, 0);
    const mesh = new THREE.Mesh(geo, matRoad());
    mesh.receiveShadow = true;
    return mesh;
  }
  const geo = stripGeometry(ed, data.points.map(([x, z]) => ({ x, z })), data.width || 12);
  const mesh = new THREE.Mesh(geo, matRoad());
  mesh.receiveShadow = true;
  return mesh;
}

export function buildRiverMesh(ed, data) {
  const geo = stripGeometry(ed, data.points.map(([x, z]) => ({ x, z })), data.width || 26);
  const mesh = new THREE.Mesh(geo, matRiver());
  mesh.position.y = -0.02;
  return mesh;
}

export function buildBuildingMesh(obj) {
  const fp = (obj.params.footprint || []).map(([x, z]) => new THREE.Vector2(x, -z));
  if (fp.length < 3) return null;
  const h = obj.params.height || 24;
  const shape = new THREE.Shape(fp);
  // 墙面/屋顶材质：params 指定标准材料库 id 就用库材质（与游戏世界同一实例，
  // 预览即所得），否则回退默认素色
  const wallM = (obj.params.wallMaterial && getMaterial(obj.params.wallMaterial)) || matBuilding();
  const roofM = (obj.params.roofMaterial && getMaterial(obj.params.roofMaterial)) || matRoof();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2); // (x, y, 0..h) → (x, h..0?) 旋转后挤出方向变为 +Y
  const wUV = uvScaleFor(obj.params.wallMaterial) || [FACADE_UV, FACADE_UV]; // 按材质贴图平铺尺度缩放
  scaleUVs(geo, wUV[0], wUV[1]);
  const walls = new THREE.Mesh(geo, wallM);
  walls.castShadow = true; walls.receiveShadow = true;
  const roofGeo = new THREE.ShapeGeometry(shape);
  roofGeo.rotateX(-Math.PI / 2);
  roofGeo.translate(0, h, 0);
  const rUV = uvScaleFor(obj.params.roofMaterial) || [ROOF_UV, ROOF_UV];
  scaleUVs(roofGeo, rUV[0], rUV[1]); // 屋顶贴图 4m 平铺
  const roof = new THREE.Mesh(roofGeo, roofM);
  const group = new THREE.Group();
  group.add(walls, roof);
  return group;
}

export function buildTreeMesh() {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.35, 3, 6), new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 1 }));
  trunk.position.y = 1.5; trunk.castShadow = true;
  const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(2.2, 0), new THREE.MeshStandardMaterial({ color: 0x2f7a3f, roughness: 1, flatShading: true }));
  crown.position.y = 4.6; crown.castShadow = true;
  g.add(trunk, crown);
  return g;
}

export function buildLampMesh() {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 6.5, 6), new THREE.MeshStandardMaterial({ color: 0x3c4650, roughness: 0.6 }));
  pole.position.y = 3.25; pole.castShadow = true;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.45, 10, 8), new THREE.MeshStandardMaterial({ color: 0xfff3c4, emissive: 0xffd873, emissiveIntensity: 1.4 }));
  head.position.y = 6.6;
  g.add(pole, head);
  return g;
}

export function buildObjectMesh(ed, o) {
  if (o.type === "building") return buildBuildingMesh(o);
  if (o.type === "tree") return buildTreeMesh();
  if (o.type === "lamp") return buildLampMesh();
  return null;
}
