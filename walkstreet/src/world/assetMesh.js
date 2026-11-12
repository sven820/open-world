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

import * as THREE from "three/webgpu";
import { getMaterial, scaleUVs, uvScaleFor, FACADE_UV, ROOF_UV } from "./materials.js";
import { parseGLB } from "../data/assetStore.js"; // 含 DRACOLoader（Draco 压缩 GLB）

const _templates = new Map(); // id → THREE.Group（已绑库材质、已对齐 base-center）
const _boxes = new Map();     // id → THREE.Box3（模板局部包围盒）
const _loading = new Map();   // id → Promise（去重并发预热）
const _clips = new Map();     // id → AnimationClip[]（GLB 内建动画，如 LittlestTokyo 的小火车）
const _animCfg = new Map();   // id → 资产记录的播放配置 { enabled:[名字], speed }（构建时快照）
const _mixers = new Set();    // 活跃的 AnimationMixer（实例销毁时自动清理）
const _nightMats = new Set(); // 资产自发光材质（夜市效果：夜间把漫反射贴图亮部点亮）

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
// 注意：模板根节点的 position 上写着 base-center 贴地偏移（alignBaseCenter，
// 单位 = 模型本地单位）。position 是父空间量，不受节点自身 scale 缩放 ——
// 所以缩放必须加在外层 Group 上；若加在内层，缩小模型时贴地偏移保持原值，
// 模型会飞到天上（本地 211 单位的偏移 × 0.05 缩放场景 = 200m 高空）。
export function assetInstance(asset, { pos, rot = 0, scale = 1 } = {}) {
  const tpl = _templates.get(asset.id);
  if (!tpl) return null;
  const inst = tpl.clone(); // 内层：保留贴地偏移，恒为单位缩放
  inst.userData.sharedTpl = true; // 标记：几何/材质与模板缓存共享，宿主重建时不得 dispose
  const root = new THREE.Group(); // 外层：承载放置位姿（pos/rot/scale 绕底面中心）
  root.add(inst);
  const s = scale == null ? 1 : scale;
  root.scale.set(s, s, s);
  root.rotation.y = rot || 0;
  root.position.set(pos ? pos[0] : 0, 0, pos ? pos[1] : 0);
  // 内建动画：每个实例一个 mixer 自动循环播放（AnimationMixer 按名字在克隆体
  // 内解析轨道，clone 不破坏节点动画；剔除时机见 updateAssetAnimations）。
  // 运行时以最小 ref {id} 实例化 → 配置取构建时的快照；传完整记录则用记录里的
  playAssetClips(asset.id, root, asset.animation || _animCfg.get(asset.id));
  return root;
}

// 资产包含的动画片段清单（工坊右侧面板展示用）
export function getAssetClipNames(assetId) {
  const clips = _clips.get(assetId);
  return clips ? clips.map((c) => ({ name: c.name, duration: +c.duration.toFixed(2) })) : [];
}

// 在 root 上播放资产的内建动画片段（assetInstance 与 Studio 工作台共用）。
// cfg: { enabled: [片段名]，缺省/null = 全部播放；speed: 倍速，默认 1 }。
// 返回 mixer（调用方可 stop 后重建实现实时改配置），无可用片段返回 null
export function playAssetClips(assetId, root, cfg) {
  const clips = _clips.get(assetId);
  if (!clips || !clips.length) return null;
  const enabled = cfg && Array.isArray(cfg.enabled) ? cfg.enabled : null;
  const mixer = new THREE.AnimationMixer(root);
  for (const c of clips) {
    if (enabled && !enabled.includes(c.name)) continue;
    mixer.clipAction(c).play();
  }
  mixer.timeScale = (cfg && cfg.speed) || 1;
  _mixers.add(mixer);
  return mixer;
}

// 停掉某个 mixer 并从注册表移除（工坊实时改配置时旧 mixer 必须显式停掉，
// 否则与新建 mixer 叠加 double 速度）
export function stopAssetMixer(mixer) {
  if (!mixer) return;
  mixer.stopAllAction();
  _mixers.delete(mixer);
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
  _clips.delete(id);
  _animCfg.delete(id);
}

/* ---------------- GLB 资产构建 ---------------- */

async function buildGLBObject(asset) {
  const buf = await asset.glb.arrayBuffer();
  const gltf = await parseGLB(buf);
  const root = gltf.scene;
  applyMaterialBindings(root, asset.materialBindings || {});
  // 有名材质 → 绑定键 = 材质名；无名（旧版导出）留给 Studio 按序迁移
  root.traverse((o) => {
    if (o.isMesh && o.material.name) o.userData.bindingKey = o.material.name;
  });
  alignBaseCenter(root);
  enableShadows(root);
  // 动画：GLB 内建片段（如 LittlestTokyo 的火车环线）随模板缓存，实例化时播放；
  // 播放配置（启用哪些片段/速度）在构建时从资产记录快照，运行时以最小 ref 实例化也能拿到
  _clips.set(asset.id, gltf.animations || []);
  _animCfg.set(asset.id, asset.animation || null);
  // 色彩：游戏渲染器用 ACES tone mapping（压暗、去饱和），GLB 卡通资产的原始
  // 材质跳过 tone mapping 还原官方 demo 的鲜艳观感；库共享材质（city 大面积
  // 使用）不动，避免影响全局氛围
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m || (m.userData && m.userData.shared)) continue;
      m.toneMapped = false;
      // 夜市自发光：把漫反射贴图复用为自发光贴图（共享同一张 GPU 纹理，零额外
      // 显存），白天 emissiveIntensity=0 完全无感；夜里由 city.update 按夜色
      // 系数点亮——贴图里的窗户/灯笼/灯牌亮部自发光，配合夜景 bloom 出霓虹感。
      // 亮度/开关来自资产记录（工坊「夜景」面板可调，默认 0.7）
      if (m.map || m.emissiveMap) {
        if (!m.emissiveMap) {
          m.emissiveMap = m.map;
          if (!m.emissive || m.emissive.getHex() === 0) m.emissive.setHex(0xffffff);
        }
        // 重导入的 GLB 可能已带 emissiveMap（工坊导出写回的）：直接按记录配置接管强度
        applyGlowCfg(m, asset.nightGlow);
        _nightMats.add(m);
      }
    }
  });
  // 部件级夜景覆盖：nightGlow.parts[绑定键] 存在的部件克隆独立材质单独调亮度
  // （克隆共享 emissiveMap 纹理，仅多一份材质参数，无额外纹理显存）
  const partCfgs = asset.nightGlow && asset.nightGlow.parts;
  if (partCfgs) {
    root.traverse((o) => {
      if (!o.isMesh) return;
      const key = o.userData.bindingKey || (o.material && o.material.name);
      const pc = key && partCfgs[key];
      const m = o.material;
      if (!pc || !m || !m.emissiveMap || (m.userData && m.userData.shared)) return;
      const c = m.clone();
      applyGlowCfg(c, { on: pc.on, strength: pc.strength });
      c.userData.partGlowKey = key;
      o.material = c;
      _nightMats.add(c);
    });
  }
  return root;
}

// 把夜景配置落到材质上（构建时用；工坊实时预览另有直接赋值逻辑）
function applyGlowCfg(m, cfg) {
  cfg = cfg || {};
  m.userData.glowOn = cfg.on !== false;
  m.userData.glowStrength = cfg.strength != null ? cfg.strength : 0.7;
  m.emissiveIntensity = 0;
}

// 夜色系数（0=白昼 1=深夜）驱动资产自发光强度；city.update 在夜色变化超阈值时调用。
// 强度 = 夜色渐变系数 × 资产各自的 glowStrength（工坊可调），关闭的资产恒为 0
export function updateAssetNightGlow(night) {
  const k = Math.max(0, (night - 0.15) / 0.85); // 0.15 后起步，黄昏渐亮
  for (const m of _nightMats) {
    m.emissiveIntensity = m.userData.glowOn ? k * (m.userData.glowStrength ?? 0.7) : 0;
  }
}

// 驱动所有在场的资产实例动画（每帧由宿主渲染循环调用，dt 秒）。
// 实例被移出场景（parent 链断开）后自动从注册表剔除，重建产生的新实例重新注册
export function updateAssetAnimations(dt) {
  if (!_mixers.size || !dt) return;
  for (const mixer of _mixers) {
    const root = mixer.getRoot();
    if (!root || !root.parent) { _mixers.delete(mixer); continue; }
    mixer.update(dt);
  }
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
