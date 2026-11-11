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

export function isMemoryOnly() { return _memOnly; }

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
  return rec;
}

export async function getAsset(id) {
  return tx(STORE_ASSETS, "readonly", (s) => {
    if (!s) return { result: _mem.get(id) || null };
    return s.get(id);
  }).then((r) => r || null);
}

export async function listAssets({ category, keyword } = {}) {
  const all = await tx(STORE_ASSETS, "readonly", (s) => {
    if (!s) return { result: [..._mem.values()] };
    return s.getAll();
  });
  let out = all || [];
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
  return putAsset({
    name: extra.name || buildingObj.name || "描边建筑",
    category: "building",
    source: "traced",
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
export function renderThumb(root, { size = 256 } = {}) {
  const scene = new THREE.Scene();
  scene.add(root);
  const box = new THREE.Box3().setFromObject(root);
  const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
  const sphere = box.isEmpty() ? new THREE.Sphere(center, 1) : box.getBoundingSphere(new THREE.Sphere());
  const cam = new THREE.PerspectiveCamera(40, 1, 0.1, Math.max(10, sphere.radius * 6));
  cam.position.set(center.x + sphere.radius * 1.6, center.y + sphere.radius * 1.1, center.z + sphere.radius * 1.6);
  cam.lookAt(center);
  const dl = new THREE.DirectionalLight(0xffffff, 2.2);
  dl.position.set(3, 6, 4);
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
