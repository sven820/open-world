// 模型资产库（IndexedDB）—— 独立数据模块，与任何编辑器解耦。
// 依赖方向：assetStore ← studio / mapEditor3d / customMap（谁都能用，它不依赖谁）。
//
// 存储：IndexedDB 库 "tr_model_studio"
//   assets —— 资产记录 { id, name, category, tags, source, glb(Blob|Null),
//                        traced, materialBindings, pivot, collider, unitSize, thumb(Blob) }
//   meta   —— 版本/迁移标记
// 降级：IndexedDB 打不开（隐私模式等）→ 内存 Map 兜底 + memoryOnly 标记，不抛错。

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

const DB_NAME = "tr_model_studio";
const DB_VERSION = 1;
const STORE_ASSETS = "assets";
const STORE_META = "meta";

const uid = () => "asset_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

let _db = null;          // 打开缓存的 IDBDatabase
let _mem = new Map();    // 降级内存库
let _memOnly = false;    // true = IndexedDB 不可用
// 同步记录缓存：运行时建城/建屏是同步的，IndexedDB 是异步的。
// 预热阶段（getAsset/listAssets）顺手填缓存，同步代码用 getAssetRecordSync 读。
// 只作缓存，不替代 IndexedDB —— 写入仍以 putAsset 为准。
const _recordCache = new Map();

export function isMemoryOnly() { return _memOnly; }
export function cacheAssetRecord(asset) { if (asset && asset.id) _recordCache.set(asset.id, asset); return asset; }
export function getAssetRecordSync(id) { return _recordCache.get(id) || null; }
export function forgetAssetRecord(id) { _recordCache.delete(id); }

/* ---------------- DB 打开与降级 ---------------- */

function openDB() {
  return new Promise((resolve) => {
    if (_db) return resolve(_db);
    if (_memOnly) return resolve(null);
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      _memOnly = true;
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_ASSETS)) db.createObjectStore(STORE_ASSETS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => { _memOnly = true; resolve(null); };
    req.onblocked = () => { _memOnly = true; resolve(null); };
  });
}

function tx(store, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    if (!db) return resolve(fn(null)); // 内存模式：fn(null) 自己操作 _mem
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

/* ---------------- CRUD ---------------- */

export async function putAsset(asset) {
  const rec = { pivot: "base-center", collider: { mode: "aabb" }, tags: [], materialBindings: {}, ...asset };
  if (!rec.id) rec.id = uid();
  if (!rec.createdAt) rec.createdAt = Date.now();
  rec.updatedAt = Date.now();
  await tx(STORE_ASSETS, "readwrite", (s) => {
    if (!s) { _mem.set(rec.id, rec); return { result: undefined }; }
    return s.put(rec);
  });
  cacheAssetRecord(rec);
  return rec;
}

export async function getAsset(id) {
  return tx(STORE_ASSETS, "readonly", (s) => {
    if (!s) return { result: _mem.get(id) || null };
    return s.get(id);
  }).then((r) => {
    if (r) cacheAssetRecord(r);
    return r || null;
  });
}

export async function listAssets({ category, keyword } = {}) {
  const all = await tx(STORE_ASSETS, "readonly", (s) => {
    if (!s) return { result: [..._mem.values()] };
    return s.getAll();
  });
  let out = all || [];
  for (const a of out) cacheAssetRecord(a);
  if (category) out = out.filter((a) => a.category === category);
  if (keyword) {
    const k = keyword.toLowerCase();
    out = out.filter((a) => (a.name || "").toLowerCase().includes(k) || (a.tags || []).some((t) => String(t).toLowerCase().includes(k)));
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function deleteAsset(id) {
  await tx(STORE_ASSETS, "readwrite", (s) => {
    if (!s) { _mem.delete(id); return { result: undefined }; }
    return s.delete(id);
  });
  forgetAssetRecord(id);
}

/* ---------------- 资产分组（存 meta 表，用户可增改） ---------------- */

// 默认分组 id 与旧版固定 category 值一致，存量资产无需迁移
const KEY_GROUPS = "assetGroups";
const DEFAULT_GROUPS = [
  { id: "building", name: "建筑", color: "#3a72b0" },
  { id: "prop", name: "道具", color: "#3f8f5f" },
  { id: "vehicle", name: "载具", color: "#b07a3a" },
  { id: "billboard", name: "广告牌", color: "#b05fa0" },
  { id: "custom", name: "自定义", color: "#7d5fb0" },
];
const _memMeta = new Map(); // 内存降级模式的 meta 存储

function metaGet(key) {
  return tx(STORE_META, "readonly", (s) => {
    if (!s) return { result: _memMeta.get(key) };
    return s.get(key);
  });
}

function metaSet(key, val) {
  return tx(STORE_META, "readwrite", (s) => {
    if (!s) { _memMeta.set(key, val); return { result: undefined }; }
    return s.put(val, key);
  });
}

export async function listGroups() {
  let groups = await metaGet(KEY_GROUPS);
  if (!Array.isArray(groups) || !groups.length) {
    groups = DEFAULT_GROUPS.map((g) => ({ ...g }));
    await metaSet(KEY_GROUPS, groups);
  }
  return groups;
}

// group.id 为空 → 新建；否则按 id 更新属性（name/color）
export async function putGroup(group) {
  const groups = await listGroups();
  if (!group.id) {
    group.id = "grp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    groups.push(group);
  } else {
    const i = groups.findIndex((g) => g.id === group.id);
    if (i >= 0) groups[i] = { ...groups[i], ...group };
    else groups.push(group);
  }
  await metaSet(KEY_GROUPS, groups);
  return group;
}

/* ---------------- 放置尺寸智能推断 ---------------- */

// GLB 的数字没有物理单位：建模按米、厘米、或被缩放 100 倍都很常见。
// 这里按「名字/标签 → 物件类型」猜一个合理的米制目标尺寸；猜不出时用
// 原始包围盒的「看起来已是米」区间决定是否原尺寸放置。
const PLACE_SIZE_RULES = [
  [/椅|凳|沙发|柜|桌|chair|stool|sofa|desk|table/i, 1.2],
  [/路灯|街灯|lamp|streetlight/i, 6],
  [/广告|招牌|屏|billboard|screen|sign/i, 14],
  [/树|植物|tree|plant/i, 6],
  [/车|汽车|巴士|car|vehicle|bus|truck/i, 5],
  [/人|角色|人物|person|character|human/i, 1.8],
  [/建筑|楼|房|大厦|塔|building|tower|house/i, 30],
];
const PLACE_SIZE_BY_CATEGORY = { building: 30, prop: 2, vehicle: 5, billboard: 14 };

/** 资产放置时的「最大边目标米数」。结果写入 placeSize 可被用户覆盖。 */
export function inferPlaceSize(asset) {
  if (!asset || asset.source !== "glb") return 1; // 描边/广告牌本来就是米坐标
  const text = [asset.name || "", ...(asset.tags || []).map(String)].join(" ");
  for (const [re, size] of PLACE_SIZE_RULES) if (re.test(text)) return size;
  if (PLACE_SIZE_BY_CATEGORY[asset.category]) return PLACE_SIZE_BY_CATEGORY[asset.category];
  const s = asset.unitSize || {};
  const maxDim = Math.max(s.x || 0, s.y || 0, s.z || 0);
  // 0.2~80 之间的裸数字绝大多数就是米 —— 直接原尺寸放，不要再乘系数
  if (maxDim >= 0.2 && maxDim <= 80) return maxDim;
  return 30; // 明显不是米（0.3 的楼 / 3000 的厘米模型）走通用目标
}

/* ---------------- GLB 导入 ---------------- */

// File/Blob → 解析场景 → 资产记录（未保存，调用方确认后 putAsset）
// 提取 GLB 内材质名清单供绑定 UI 展示；缩略图由调用方渲染后 saveAssetThumb
export async function importAssetFromGLB(file, { name, category = "custom" } = {}) {
  const buf = await file.arrayBuffer();
  const gltf = await parseGLB(buf);
  const matNames = collectMaterialNames(gltf.scene);
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = box.isEmpty() ? { x: 1, y: 1, z: 1 } : box.getSize(new THREE.Vector3());
  return putAsset({
    name: name || (file.name || "模型").replace(/\.glb$/i, ""),
    category,
    source: "glb",
    glb: new Blob([buf], { type: "model/gltf-binary" }),
    materialBindings: Object.fromEntries(matNames.map((m) => [m, ""])), // 空 = 待绑定
    unitSize: { x: +size.x.toFixed(2), y: +size.y.toFixed(2), z: +size.z.toFixed(2) },
    meshCount: countMeshes(gltf.scene),
  });
}

// 共享 DRACOLoader：Draco 压缩的 GLB（如 three.js 官方示例 LittlestTokyo.glb）
// 没有 DRACOLoader 会直接解析失败，表现为"导入没反应"
let _draco = null;
function dracoLoader() {
  if (!_draco) {
    _draco = new DRACOLoader().setDecoderPath("/draco/");
  }
  return _draco;
}

export function parseGLB(buffer) {
  return new Promise((resolve, reject) => {
    new GLTFLoader().setDRACOLoader(dracoLoader()).parse(buffer, "", resolve, reject);
  });
}

function collectMaterialNames(root) {
  const names = new Set();
  root.traverse((o) => {
    if (o.isMesh && o.material) {
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (m.name) names.add(m.name);
      }
    }
  });
  return [...names];
}

function countMeshes(root) {
  let n = 0;
  root.traverse((o) => { if (o.isMesh) n++; });
  return n;
}

/* ---------------- GLB 导出（备份 / 给 Blender 二次加工） ---------------- */

export async function exportAssetGLB(id) {
  const asset = await getAsset(id);
  if (!asset) return null;
  if (asset.glb) return asset.glb;
  if (asset.traced) {
    // 描边资产：按同一挤出公式现场重建再导出，保证外观一致。
    // 库共享材质没有 name，Blender 里会显示 Material.001 —— 克隆副本
    // 按 bindingKey（wall/roof）命名，导入外部软件后可直接辨认
    const { buildTracedAssetObject } = await import("../studio/tracedAsset.js");
    const obj = buildTracedAssetObject(asset);
    obj.traverse((o) => {
      if (!o.isMesh) return;
      const key = o.userData.bindingKey || (o.geometry && o.geometry.type === "ShapeGeometry" ? "roof" : "wall");
      const m = o.material.clone();
      m.name = key;
      delete m.userData.shared; // 导出副本不再标记共享
      o.material = m;
    });
    return exportObjectGLB(obj);
  }
  if (asset.source === "billboard" && asset.billboard) {
    // 广告牌资产：按规格现场重建屏体再导出（给 Blender 二次加工 / 备份）。
    // 屏面材质不进资产文件，导出时按 bindingKey 命名，重新导入可重新绑定。
    const { buildBillboardAssetObject } = await import("../world/billboard/billboardAssetBridge.js");
    const obj = buildBillboardAssetObject(asset);
    if (!obj) return null;
    obj.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const key = o.userData.bindingKey || "screen";
      const m = o.material.clone();
      m.name = key;
      delete m.userData.shared;
      o.material = m;
    });
    return exportObjectGLB(obj);
  }
  return null;
}

export function exportObjectGLB(object3d) {
  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(object3d, (out) => resolve(new Blob([out], { type: "model/gltf-binary" })), reject, { binary: true });
  });
}

/* ---------------- 描边建筑 → 资产（M3 互通入口） ---------------- */

// buildingObj: map.objects 里 type==="building" 的对象
export async function createAssetFromTraced(buildingObj, extra = {}) {
  const p = buildingObj.params || {};
  const pts = Array.isArray(p.footprint) ? p.footprint : [];
  const xs = pts.map(([x]) => x), zs = pts.map(([, z]) => z);
  const unitSize = pts.length >= 3
    ? { x: +(Math.max(...xs) - Math.min(...xs)).toFixed(2), y: p.height || 24, z: +(Math.max(...zs) - Math.min(...zs)).toFixed(2) }
    : { x: 12, y: p.height || 24, z: 12 }; // 描边几何本来就是真实米，放置 scale 恒为 1
  return putAsset({
    name: extra.name || buildingObj.name || "描边建筑",
    category: "building",
    source: "traced",
    unitSize,
    traced: {
      footprint: (p.footprint || []).map(([x, z]) => [x, z]),
      height: p.height || 24,
      style: "extrude",
    },
    materialBindings: {
      ...(p.wallMaterial ? { wall: p.wallMaterial } : {}),
      ...(p.roofMaterial ? { roof: p.roofMaterial } : {}),
    },
    ...extra,
  });
}

/* ---------------- 缩略图 ---------------- */

export async function saveAssetThumb(id, blob) {
  const asset = await getAsset(id);
  if (!asset) return;
  asset.thumb = blob;
  await putAsset(asset);
}

// 渲染一个 Object3D 的正面截图 → png Blob（Studio/导入后自动出缩略图）
// direction: 可选，世界坐标下「相机 → 原点」的方向；Studio 保存时传当前视口机位，
// 做到「转到你想要的角度再保存，列表图就是那个角度」。
export function renderThumb(root, { size = 256, direction = null } = {}) {
  const scene = new THREE.Scene();
  scene.add(root);
  const box = new THREE.Box3().setFromObject(root);
  const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
  const sphere = box.isEmpty() ? new THREE.Sphere(center, 1) : box.getBoundingSphere(new THREE.Sphere());
  // 机位统一默认；模型的展示朝向由资产自己的 poseYaw 决定（构建期已转到合适角度）。
  // 这里不再按 mount / 类型特判，任何新资产都走同一套。
  const viewDir = (direction && direction.lengthSq && direction.lengthSq() > 1e-6)
    ? direction.clone().normalize()
    : new THREE.Vector3(1.6, 1.1, 1.6).normalize();
  // 距离按包围球给，保持任意尺寸模型构图一致；只继承方向不继承缩放
  const cam = new THREE.PerspectiveCamera(40, 1, 0.1, Math.max(10, sphere.radius * 6));
  cam.position.copy(center).addScaledVector(viewDir, sphere.radius * 2.5);
  cam.lookAt(center);
  const dl = new THREE.DirectionalLight(0xffffff, 2.2);
  dl.position.copy(cam.position).add(new THREE.Vector3(2, 4, 2));
  scene.add(dl, new THREE.AmbientLight(0xffffff, 1.2));
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(size, size);
  renderer.render(scene, cam);
  const canvas = renderer.domElement;
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      renderer.dispose();
      resolve(blob);
    }, "image/png");
  });
}
