// 用户自定义地图的本地存储（localStorage）。
// 地图数据结构与 src/data/cityData.js 同构：
// { id, name, createdAt, updatedAt, roadsX, roadsZ, districts, landmarks, spawn }
// "default" 不是存储的地图，而是回退到程序化台北。

const KEY_LIST = "tr_maps";        // 所有用户地图（含完整数据）
const KEY_ACTIVE = "tr_activeMap"; // 当前选中地图 id；"default" = 默认台北

const uid = () => "map_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// 网格层默认浓度（3D 编辑器显示偏好；0=完全透出影像，1=不透明。0.6 = 面板滑杆默认 40%）
export const GRID_OPACITY_DEFAULT = 0.6;

function readAll() {
  try { return JSON.parse(localStorage.getItem(KEY_LIST)) || []; } catch { return []; }
}
function writeAll(list) {
  try { localStorage.setItem(KEY_LIST, JSON.stringify(list)); } catch { /* 配额满等异常忽略 */ }
}

// 全新地图数据：完全空白，不拷贝任何默认台北内容
// （roadsX/roadsZ/districts/landmarks 由用户在编辑器中自行绘制）
export function templateData() {
  return {
    roadsX: [],
    roadsZ: [],
    districts: [],
    landmarks: [],
    spawn: { x: 0, z: 0, heading: -Math.PI / 2 }, // 默认出生在地图范围中心
    extRoads: false, // 程序化延伸街道：默认不生成，用户勾选后开启
  };
}

// schema v2 迁移：补齐 3D 编辑器新增字段（features/objects/origin），旧地图无损升级
export function migrate(map) {
  if (!map) return map;
  if (map.version !== 2) {
    map.version = 2;
    map.origin = map.origin || { lat: 25.0477, lon: 121.5173 }; // 默认锚点：台北车站
    map.features = map.features || { roads: [], rivers: [] };
    map.objects = map.objects || [];
  }
  // 地图工作范围（3D 编辑器的网格/底板区域；局部米制，rot 为弧度）
  map.area = map.area || { cx: 0, cz: 0, w: 4000, d: 4000, rot: 0 };
  // 程序化延伸街道开关（旧地图无此字段 → 视为未勾选）
  map.extRoads = map.extRoads === undefined ? false : !!map.extRoads;
  // 网格层浓度（3D 编辑器显示偏好；0=完全透出影像，1=默认）
  map.gridOpacity = typeof map.gridOpacity === "number" ? Math.min(1, Math.max(0, map.gridOpacity)) : GRID_OPACITY_DEFAULT;
  return map;
}

// 列表条目（仅 meta，供面板展示）
export function listMaps() {
  return readAll()
    .map(({ id, name, createdAt, updatedAt }) => ({ id, name, createdAt, updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getMap(id) {
  return migrate(readAll().find((m) => m.id === id) || null);
}

export function createMap(name) {
  const now = Date.now();
  const map = { id: uid(), name: (name || "").trim() || "未命名地图", createdAt: now, updatedAt: now, version: 2, origin: { lat: 25.0477, lon: 121.5173 }, features: { roads: [], rivers: [] }, objects: [], area: { cx: 0, cz: 0, w: 4000, d: 4000, rot: 0 }, ...templateData() };
  const list = readAll();
  list.push(map);
  writeAll(list);
  return map;
}

// 保存地图数据（data 为部分字段：roadsX/roadsZ/districts/landmarks/spawn）
export function saveMapData(id, data, name) {
  const list = readAll();
  const m = list.find((x) => x.id === id);
  if (!m) return null;
  Object.assign(m, data, { updatedAt: Date.now() });
  if (name != null && String(name).trim()) m.name = String(name).trim();
  writeAll(list);
  return m;
}

export function deleteMap(id) {
  writeAll(readAll().filter((m) => m.id !== id));
  if (getActiveMapId() === id) setActiveMapId("default");
}

export function getActiveMapId() {
  return localStorage.getItem(KEY_ACTIVE) || "default";
}
export function setActiveMapId(id) {
  localStorage.setItem(KEY_ACTIVE, id || "default");
}

// 当前激活地图的完整数据；null 表示默认程序化台北
export function resolveActiveMap() {
  const id = getActiveMapId();
  if (id === "default") return null;
  return getMap(id);
}
