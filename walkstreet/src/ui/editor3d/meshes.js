// 3D 编辑器的几何构建工具：屏幕空间胖线、世界宽度路带、折线条带网格，
// 以及描边实体（道路/河流/建筑/树/路灯）的材质与网格构建。
// 全部以编辑器实例（ed）为第一参数（曲率下沉依赖 ed._curveOffset / ed._three.renderer）。

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { bendGeometry } from "../../config/curvature.js";
import { ensureTerrain, resamplePoints, ROAD_GRADE_STEP, GROUND_STEP, gridHeightAt, tessellateFlat } from "../../world/terrain.js";
import { makeAsphaltTexture, ASPHALT_TILE } from "../../world/textures.js";
import { getMaterial, scaleUVs, uvScaleFor, FACADE_UV, ROOF_UV } from "../../world/materials.js";
import { buildTreeGroup, buildLampGroup } from "../../world/customMap.js";
import { buildBillboardGroup, editorScreenMaterial, editorCornerScreenMaterial } from "../../world/billboard/mounts.js";

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
  geo.setPositions(pts.flatMap((p) => [p.x - ox, lift - ed._curveOffset(p.x, p.z) + (ed._terrainY ? ed._terrainY(p.x, p.z) : 0), p.z - oz]));
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
  // ADR-0009：路面必须采样「8m 格点渲染曲面」gridHeightAt（主地面/补丁用的同一张），
  // 而非连续 terrainHeightAt。旧版两者是相位不同的三角网格各自插值同一高度函数，
  // 补丁三角面从下方顶穿路面 → 规则菱形/三角缺口（实测 27% 顶穿、深 1m）。
  // 采样同一曲面后，路面恒高于补丁 0.04m（lift 差）；再细分到 2m，把路带三角
  // 内部的二阶插值误差压到 <0.04m，彻底消除残留穿插。
  const SUB = 2; // 目标边长 2m（纵向沿路 + 横向）
  // 纵向：把每段 8m 再细分成 2m
  const path = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / SUB));
    for (let k = 0; k < n; k++) path.push({ x: a.x + (b.x - a.x) * k / n, z: a.z + (b.z - a.z) * k / n });
  }
  path.push(pts[pts.length - 1]);
  const cross = Math.max(1, Math.ceil((2 * halfW) / SUB));
  const cols = cross + 1;
  const hasT = !!(ed.map && ensureTerrain(ed.map));
  for (let i = 0; i < path.length; i++) {
    const p0 = path[Math.max(i - 1, 0)], p1 = path[Math.min(i + 1, path.length - 1)];
    const dx = p1.x - p0.x, dz = p1.z - p0.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len, nz = dx / len; // 横向单位法向
    for (let j = 0; j < cols; j++) {
      const off = -halfW + (2 * halfW * j) / cross; // 从 -halfW 到 +halfW
      const wx = path[i].x + nx * off, wz = path[i].z + nz * off;
      // 采样补丁同款格点曲面；无地形时退化为连续高度（曲率仍由 _curveOffset 处理）
      const h = hasT ? gridHeightAt(ed.map, wx, wz) : (ed._terrainY ? ed._terrainY(wx, wz) : 0);
      const wy = 0.14 - ed._curveOffset(wx, wz) + h; // ADR-0011：0.14 - 补丁(-0.22) = 0.36m 余量
      pos.push(wx, wy, wz);
    }
  }
  for (let i = 0; i < path.length - 1; i++) {
    for (let j = 0; j < cross; j++) {
      const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
      idx.push(a, c, b, b, c, d); // 俯视绕序一致、法线朝上
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  planarUV(geo);
  // 贴图与「路块拼接」同一张沥青表面（tint 乘色：选中高亮 / 延伸路区分）。
  // ADR-0008：不透明 + 写深度 + polygonOffset。旧版 transparent + depthWrite:false
  // 依赖「路带几何恰好高于地面」的脆弱余量；陡峭地形 + 相位错开时，下沉主地面
  // 的 8m 三角形在路带边缘插值后从下方顶穿路带 → 锯齿 / 路面被啃缺口。
  // 改为不透明 + 深度偏置后路带强制渲染为可见最上层，彻底消除顶穿；
  // 横纵路带同为 terrainHeightAt+lift（同一高度、相同 offset），路口共面不闪烁。
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    map: makeAsphaltTexture(), color: colorHex, roughness: 0.94, metalness: 0.0,
    transparent: opacity < 1, opacity, depthWrite: true, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }));
  mesh.renderOrder = 1;
  return mesh;
}

/* ---------------- 实体材质 / 网格 ---------------- */

export function matRoad(tint = 0xffffff) {
  // 与「路块拼接」/程序化横纵路带同一张沥青表面贴图，编辑器内三种路面风格一致。
  // tint 乘色（贴图为灰阶）：默认原色，可传高亮/暗色调区分状态。
  // ADR-0008：深度偏置让描边路 / 面路同样强制盖住下沉主地面，消除边缘顶穿锯齿。
  return new THREE.MeshStandardMaterial({
    map: makeAsphaltTexture(), color: tint, roughness: 0.94, metalness: 0.0,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
}
export const matRiver = () => new THREE.MeshStandardMaterial({ color: 0x1d5f8f, transparent: true, opacity: 0.8, roughness: 0.25, metalness: 0.1 });
export const matBuilding = () => new THREE.MeshStandardMaterial({ color: 0xb8b2a6, roughness: 0.85 });
export const matRoof = () => new THREE.MeshStandardMaterial({ color: 0x6f6a60, roughness: 0.9 });

// 平面几何逐顶点贴地：编辑器没有运行时的 displaceGroup，所有路面 / 路块 / 面路
// 必须在构建时把「该点真实地面高度」烘焙进顶点。origin 描述 wrapper 的平面定位
// （拼接路块有 x/z/rot 且已按中心抬了 y；描边内容用世界坐标、wrapper 不抬升）。
// 这样道路与放置模型走同一个高度权威 terrainHeightAt：横断面平整、纵坡平顺。
export function fitGeometryToTerrain(ed, geo, yBase = 0.16, origin = null) {
  const o = origin || { x: 0, z: 0, rot: 0, y: 0 };
  const cs = Math.cos(o.rot), sn = Math.sin(o.rot);
  const pos = geo.attributes.position;
  const hasT = !!(ed.map && ensureTerrain(ed.map));
  for (let i = 0; i < pos.count; i++) {
    const lx = pos.getX(i), lz = pos.getZ(i);
    const wx = o.x + lx * cs + lz * sn, wz = o.z - lx * sn + lz * cs;
    // ADR-0009：采样补丁同款 8m 格点曲面，避免独立网格插值穿插
    const h = hasT ? gridHeightAt(ed.map, wx, wz) : (ed._terrainY ? ed._terrainY(wx, wz) : 0);
    const wy = yBase - ed._curveOffset(wx, wz) + h;
    pos.setY(i, wy - o.y); // wrapper 已抬的部分要扣掉，避免双重抬升
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

// 折线 → 带状网格（两三角/段 + 接头圆片补缝）；yBase 区分叠放层次
export function stripGeometry(ed, points, width, yBase = 0.16) {
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
  // ADR-0009：与 roadRibbon 一致 —— 采样 8m 格点渲染曲面 gridHeightAt + 细分 2m，
  // 让描边路与补丁共用同一张曲面，消除补丁三角面顶穿路面的菱形缺口。
  const SUB = 2;
  // 纵向细分到 2m
  const path = [], pdirs = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1], d = dirs[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / SUB));
    for (let k = 0; k < n; k++) { path.push({ x: a.x + (b.x - a.x) * k / n, z: a.z + (b.z - a.z) * k / n }); pdirs.push(d); }
  }
  path.push(points[points.length - 1]); pdirs.push(dirs[dirs.length - 1]);
  const cross = Math.max(1, Math.ceil(width / SUB));
  const cols = cross + 1;
  const hasT = !!(ed.map && ensureTerrain(ed.map));
  for (let i = 0; i < path.length; i++) {
    const p = path[i], n = pdirs[i];
    for (let j = 0; j < cols; j++) {
      const off = -hw + (2 * hw * j) / cross;
      const wx = p.x + n.nx * off, wz = p.z + n.nz * off;
      const h = hasT ? gridHeightAt(ed.map, wx, wz) : (ed._terrainY ? ed._terrainY(wx, wz) : 0);
      const wy = yBase - ed._curveOffset(wx, wz) + h;
      verts.push(wx, wy, wz);
    }
  }
  for (let i = 0; i < path.length - 1; i++) {
    for (let j = 0; j < cross; j++) {
      const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
      // 绕朝上（CCW）
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  planarUV(geo);
  // 接头圆片：水平圆盘在纵坡上会一头插进路基、一头悬空（旧实现整体取中心高度），
  // 改为逐顶点按世界坐标采样，圆片自然变成贴着纵坡的锥面。
  const discs = [];
  for (const p of points) {
    const c = new THREE.CircleGeometry(hw, 12);
    c.rotateX(-Math.PI / 2);
    const cp = c.attributes.position;
    for (let i = 0; i < cp.count; i++) {
      const wx = p.x + cp.getX(i), wz = p.z + cp.getZ(i);
      cp.setY(i, 0.004 + yBase - ed._curveOffset(wx, wz) + (ed._terrainY ? ed._terrainY(wx, wz) : 0));
    }
    cp.needsUpdate = true;
    c.translate(p.x, 0, p.z); // y 已按世界坐标烘焙，只补平面位移
    discs.push(planarUV(c));
  }
  const discMerged = mergeGeometries(discs);
  return mergeGeometries([geo, discMerged]) || geo;
}

// 折线点 → 条带几何：有地形时按 ROAD_GRADE_STEP 重采样（与纵剖面采样点对齐，
// 条带顶点密度足够才能贴合平顺纵坡，不会出现跨坡直线插值）
function terrainResampled(ed, points) {
  const pts = points.map(([x, z]) => ({ x, z }));
  return ensureTerrain(ed.map) ? resamplePoints(pts, ROAD_GRADE_STEP) : pts;
}

export function buildRoadMesh(ed, data) {
  if (data.closed && data.points.length >= 3) {
    // 取面道路：围合多边形整体填充。旧实现只有一个常数 y（完全不贴地形），
    // 且三角形内部顶点稀疏 → 坡地上必然穿地形。细分后逐顶点贴到 area corridor
    // 的平整台地上，边缘由路肩过渡带与周围地形平滑衔接。
    const shape = new THREE.Shape(data.points.map(([x, z]) => new THREE.Vector2(x, -z)));
    let geo = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);
    if (ensureTerrain(ed.map)) {
      geo = tessellateFlat(geo, ROAD_GRADE_STEP, 20000);
      planarUV(geo);
      fitGeometryToTerrain(ed, geo, 0.16);
    } else {
      geo = planarUV(bendGeometry(geo));
      geo.translate(0, 0.05, 0);
    }
    const mesh = new THREE.Mesh(geo, matRoad());
    mesh.receiveShadow = true;
    return mesh;
  }
  const geo = stripGeometry(ed, terrainResampled(ed, data.points), data.width || 12);
  const mesh = new THREE.Mesh(geo, matRoad());
  mesh.receiveShadow = true;
  return mesh;
}

export function buildRiverMesh(ed, data) {
  const geo = stripGeometry(ed, terrainResampled(ed, data.points), data.width || 26);
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

// 树/路灯复用运行时 customMap 的共享几何/材质（全项目同一份，userData.shared
// 标记防 dispose）：编辑器放几百棵树也不会新建几何，重建也不再是卡顿尖峰
export function buildTreeMesh() {
  return buildTreeGroup();
}

export function buildLampMesh() {
  return buildLampGroup();
}

export function buildObjectMesh(ed, o) {
  if (o.type === "building") return buildBuildingMesh(o);
  if (o.type === "tree") return buildTreeMesh();
  if (o.type === "lamp") return buildLampMesh();
  if (o.type === "billboard") {
    // wrapper 已按 data.pos/rot 定位（_makeWrapper），网格自身归零避免双重位移
    // 3D 转角一体屏用跨两面的全景占位图，编辑器里也是「一整块折角屏」
    const mat = o.params && o.params.mount === "corner3d" ? editorCornerScreenMaterial() : editorScreenMaterial();
    const g = buildBillboardGroup(o, mat).group;
    g.position.set(0, 0, 0);
    g.rotation.y = 0;
    return g;
  }
  return null;
}
