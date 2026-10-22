// 用户自定义地图的本地存储（localStorage）。
// 地图数据结构与 src/data/cityData.js 同构：
// { id, name, createdAt, updatedAt, roadsX, roadsZ, districts, landmarks, spawn }
// "default" 不是存储的地图，而是回退到程序化台北。

import { ROADS_X, ROADS_Z, DISTRICTS, LANDMARKS, SPAWN } from "./cityData.js";

const KEY_LIST = "tr_maps";        // 所有用户地图（含完整数据）
const KEY_ACTIVE = "tr_activeMap"; // 当前选中地图 id；"default" = 默认台北

const uid = () => "map_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const clone = (v) => JSON.parse(JSON.stringify(v));

function readAll() {
  try { return JSON.parse(localStorage.getItem(KEY_LIST)) || []; } catch { return []; }
}
function writeAll(list) {
  try { localStorage.setItem(KEY_LIST, JSON.stringify(list)); } catch { /* 配额满等异常忽略 */ }
}

// 以默认台北为模板的全新地图数据
export function templateData() {
  return {
    roadsX: clone(ROADS_X),
    roadsZ: clone(ROADS_Z),
    districts: clone(DISTRICTS),
    landmarks: clone(LANDMARKS),
    spawn: { ...SPAWN },
  };
}

// 列表条目（仅 meta，供面板展示）
export function listMaps() {
  return readAll()
    .map(({ id, name, createdAt, updatedAt }) => ({ id, name, createdAt, updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getMap(id) {
  return readAll().find((m) => m.id === id) || null;
}

export function createMap(name) {
  const now = Date.now();
  const map = { id: uid(), name: (name || "").trim() || "未命名地图", createdAt: now, updatedAt: now, ...templateData() };
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
