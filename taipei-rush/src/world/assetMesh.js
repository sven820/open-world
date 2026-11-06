// 资产 → Three.js 对象的共享渲染层（M2 核心）。
// 三方共用：Model Studio 预览 / 3D 地图编辑器放置 / 运行时 customMap。
//
// 设计要点：
// - 模板缓存：同一资产只解析一次 GLB / 只建一次几何，实例用 .clone()
//   （clone 共享 geometry 与 material，仅变换独立）→ 放 50 个也只 1 份顶点；
// - 材质绑定：按 materialBindings（GLB 材质名 → 标准材料库 id）替换成库的
//   共享材质实例 → 夜间灯光/换肤全城生效；未绑定的保留 GLB 原材质兜底；
// - 锚点 base-center：模型局部坐标以"底面中心"为原点，放置时 pos 直接落地；
// - 异步加载与同步构建的桥：customMap 的建城是同步的，所以运行时先
//   preloadAssetTemplates() 预热缓存，再同步 assetInstance()；未命中返回 null
//   （调用方跳过该物件），编辑器侧则 warm 后触发重建。

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { getMaterial, scaleUVs, uvScaleFor, FACADE_UV, ROOF_UV } from "./materials.js";

const _templates = new Map(); // id → THREE.Group（已绑库材质、已对齐 base-center）
const _boxes = new Map();     // id → THREE.Box3（模板局部包围盒）
const _loading = new Map();   // id → Promise（去重并发预热）

/* ---------------- 对外 API ---------------- */

// 预热一批资产模板（运行时建城前调用；编辑器放置前也可调）
export async function preloadAssetTemplates(assets) {
  const jobs = (assets || []).filter(Boolean).map((a) => warmAssetTemplate(a));
  await Promise.allSettled(jobs);
}

// 从地图数据提取全部 asset 引用并预热（city.js 建城前调用）
export async function preloadAssetTemplatesFromMap(data) {
  const defs = (data && data.objects) || [];
  const ids = new Set();
  for (const o of defs) if (o.type === "asset" && o.assetId) ids.add(o.assetId);
  if (!ids.size) return;
  const { getAsset } = await import("../data/assetStore.js");
  const assets = (await Promise.all([...ids].map((id) => getAsset(id)))).filter(Boolean);
  await preloadAssetTemplates(assets);
}

// 异步取模板（保证加载完成）
export async function getAssetTemplate(asset) {
  if (!asset) return null;
  await warmAssetTemplate(asset);
  return _templates.get(asset.id) || null;
}

// 同步取模板（未预热返回 null）
export function getAssetTemplateIfReady(id) {
  return _templates.get(id) || null;
}

// 模板局部包围盒（未预热返回 null）
export function getAssetLocalBox(id) {
  return _boxes.get(id) || null;
}

// 预热单个资产（去重）
export function warmAssetTemplate(asset) {
  if (_templates.has(asset.id)) return Promise.resolve(_templates.get(asset.id));
  if (_loading.has(asset.id)) return _loading.get(asset.id);
  const p = (async () => {
    try {
      let tpl;
      if (asset.source === "traced" && asset.traced) {
        tpl = buildTracedObject(asset);
      } else if (asset.glb) {
        tpl = await buildGLBObject(asset);
      } else {
        return null;
      }
      _templates.set(asset.id, tpl);
      _boxes.set(asset.id, new THREE.Box3().setFromObject(tpl));
      return tpl;
    } catch (e) {
      console.warn("[assetMesh] 模板构建失败:", asset.id, e);
      return null;
    } finally {
      _loading.delete(asset.id);
    }
  })();
  _loading.set(asset.id, p);
  return p;
}

// 放置实例：克隆模板（同步；未预热返回 null）。placement: { pos, rot, scale }
export function assetInstance(asset, { pos, rot = 0, scale = 1 } = {}) {
  const tpl = _templates.get(asset.id);
  if (!tpl) return null;
  const inst = tpl.clone();
  inst.position.set(pos ? pos[0] : 0, 0, pos ? pos[1] : 0);
  inst.rotation.y = rot || 0;
  const s = scale == null ? 1 : scale;
  inst.scale.set(s, s, s);
  return inst;
}

// 放置后的世界 AABB（碰撞注册 / 程序化建筑避让）。placement 同上。
export function assetWorldAABB(asset, { pos, rot = 0, scale = 1 } = {}) {
  const box = _boxes.get(asset.id);
  if (!box) return null;
  const s = scale == null ? 1 : scale;
  const c = Math.cos(rot || 0), sn = Math.sin(rot || 0);
  const px = pos ? pos[0] : 0, pz = pos ? pos[1] : 0;
  // 八角变换取 AABB（含缩放；rot 只绕 Y）
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const ys = [box.min.y * s, box.max.y * s];
  for (const lx of [box.min.x * s, box.max.x * s]) {
    for (const lz of [box.min.z * s, box.max.z * s]) {
      const wx = px + lx * c + lz * sn;
      const wz = pz - lx * sn + lz * c;
      minX = Math.min(minX, wx); maxX = Math.max(maxX, wx);
      minZ = Math.min(minZ, wz); maxZ = Math.max(maxZ, wz);
    }
  }
  return { minX, maxX, minZ, maxZ, minY: Math.min(...ys), maxY: Math.max(...ys) };
}

// 清除某个资产的缓存（Studio 保存后调用，下次重建用新几何）
export function invalidateAssetTemplate(id) {
  _templates.delete(id);
  _boxes.delete(id);
  _loading.delete(id);
}

/* ---------------- GLB 资产构建 ---------------- */

async function buildGLBObject(asset) {
  const buf = await asset.glb.arrayBuffer();
  const gltf = await new Promise((resolve, reject) =>
    new GLTFLoader().parse(buf, "", resolve, reject));
  const root = gltf.scene;
  applyMaterialBindings(root, asset.materialBindings || {});
  // 有名材质 → 绑定键 = 材质名；无名（旧版导出）留给 Studio 按序迁移
  root.traverse((o) => {
    if (o.isMesh && o.material.name) o.userData.bindingKey = o.material.name;
  });
  alignBaseCenter(root);
  enableShadows(root);
  return root;
}

// 绑定键 → 标准材料库实例。键的来源（按优先级）：
// 1. mesh.userData.bindingKey —— Studio 导出的 GLB 会把 userData 序列化为
//    glTF extras，绑定键随文件往返，这是最可靠的匹配方式；
// 2. 原材质名（Blender 等外部工具导出的模型）；
// 都匹配不到 → 保留 GLB 原材质兜底。
function applyMaterialBindings(root, bindings) {
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const key = o.userData.bindingKey || o.material.name;
    const id = key ? bindings[key] : null;
    if (!id) return;
    const lib = getMaterial(id);
    if (lib) o.material = lib;
  });
}

function alignBaseCenter(root) {
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3());
  root.position.sub(new THREE.Vector3(c.x, box.min.y, c.z)); // 底面中心 → 原点
  root.updateMatrixWorld(true);
}

function enableShadows(root) {
  root.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });
}

/* ---------------- 描边资产构建（与 customMap.buildingGroup 同一挤出公式） ---------------- */

export function buildTracedObject(asset) {
  const fp = (asset.traced && asset.traced.footprint) || [];
  if (fp.length < 3) return null;
  const h = asset.traced.height || 24;
  const bindings = asset.materialBindings || {};
  const wallM = (bindings.wall && getMaterial(bindings.wall)) || new THREE.MeshStandardMaterial({ color: 0xb8b2a6, roughness: 0.85 });
  const roofM = (bindings.roof && getMaterial(bindings.roof)) || new THREE.MeshStandardMaterial({ color: 0x6f6a60, roughness: 0.9 });
  const shape = new THREE.Shape(fp.map(([x, z]) => new THREE.Vector2(x, -z)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  const wUV = uvScaleFor(bindings.wall) || [FACADE_UV, FACADE_UV];
  scaleUVs(geo, wUV[0], wUV[1]);
  const walls = new THREE.Mesh(geo, wallM);
  walls.castShadow = true; walls.receiveShadow = true;
  const roofGeo = new THREE.ShapeGeometry(shape);
  roofGeo.rotateX(-Math.PI / 2);
  roofGeo.translate(0, h, 0);
  const rUV = uvScaleFor(bindings.roof) || [ROOF_UV, ROOF_UV];
  scaleUVs(roofGeo, rUV[0], rUV[1]);
  const roof = new THREE.Mesh(roofGeo, roofM);
  const g = new THREE.Group();
  g.add(walls, roof);
  alignBaseCenter(g); // footprint 质心 → 底面中心原点（放置时 pos 即落点）
  return g;
}
