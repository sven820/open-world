// 标准材料库（全局唯一材质源 / single source of truth）
// ---------------------------------------------------------------
// 设计目标（从 3D 编辑器的"材质槽"角度出发）：
// 1. 程序化城市（city.js 合并批）、地标（landmarks.js）、描边建筑
//    （编辑器预览 meshes.js + 游戏世界 customMap.js）共用同一批
//    材质实例 —— 改一处参数，全城生效；同材质自动共享渲染状态。
// 2. 描边建筑 / 未来 GLB 导入模型通过【稳定 id】引用材质并落进地图
//    JSON（params.wallMaterial / params.roofMaterial），跨设备、跨
//    版本可重建；GLB 导入器后续也可按本库 id 给网格指定材质。
// 3. 材质实例缓存：getMaterial(id) 永远返回同一个 THREE 材质；
//    userData.shared = true 标记，世界销毁时不释放（main.js 跳过）。
//
// 分类（category）：
//   facade  —— 程序化外墙贴图（canvas 生成，含夜间窗光 emissiveMap）
//   roof    —— 屋顶贴图
//   surface —— 通用 PBR 素材（纯色/金属/玻璃，抽自地标建筑）

import * as THREE from "three";
import { FACADE_VARIANTS, makeFacades, makeRoofTexture, STOREFRONT_STYLES, makeStorefronts, makeSignAtlas } from "./textures.js";

/* ---------------- 中文显示名（编辑器 UI 用） ---------------- */
const FACADE_ZH = {
  "old-tile": "老公寓 · 贴砖",
  "apt-grey": "公寓 · 灰",
  "apt-cream": "公寓 · 米黄",
  "office-blue": "办公楼 · 蓝玻璃",
  "brick-red": "红砖",
  "white-mod": "白色现代",
  "tower-glass": "摩天楼 · 玻璃幕墙",
  "beige-old": "老楼 · 米色",
  "grey-old": "老楼 · 灰",
  "pink-tile": "贴砖 · 粉",
  "green-tile": "贴砖 · 绿",
  "modern-sand": "现代 · 砂色",
};

const STOREFRONT_ZH = {
  convenience: "便利店", cafe: "咖啡馆", fashion: "服饰店", restaurant: "餐厅",
  pharmacy: "药店", salon: "美发沙龙", bakery: "面包店", electronics: "数码店", shutter: "卷帘门(歇业)",
};

/* ---------------- 通用 PBR 素材（抽自地标建筑的材质参数） ---------------- */
const SURFACE_DEFS = [
  { id: "surface:concrete",     name: "混凝土",       preview: "#d8d8d4", make: () => ({ color: 0xd8d8d4, roughness: 0.92, metalness: 0 }) },
  { id: "surface:plaster-white", name: "白色抹灰",    preview: "#f2efe8", make: () => ({ color: 0xf2efe8, roughness: 0.9, metalness: 0 }) },
  { id: "surface:red",          name: "朱红漆",       preview: "#9c2f2a", make: () => ({ color: 0x9c2f2a, roughness: 0.85, metalness: 0 }) },
  { id: "surface:blue-roof",    name: "蓝瓦",         preview: "#2f4f8a", make: () => ({ color: 0x2f4f8a, roughness: 0.7, metalness: 0.1 }) },
  { id: "surface:gold",         name: "金色金属",     preview: "#c9a23a", make: () => ({ color: 0xc9a23a, roughness: 0.3, metalness: 0.7, emissive: 0x332200, emissiveIntensity: 0.4 }) },
  { id: "surface:brass",        name: "金色立柱",     preview: "#c9a23a", make: () => ({ color: 0xc9a23a, roughness: 0.6, metalness: 0 }) },
  { id: "surface:win-dark",     name: "深色发光窗",   preview: "#16242e", make: () => ({ color: 0x16242e, roughness: 0.5, metalness: 0, emissive: 0x224, emissiveIntensity: 1 }) },
  { id: "surface:lantern",      name: "红灯笼(发光)", preview: "#d11f1f", make: () => ({ color: 0xd11f1f, roughness: 0.6, metalness: 0, emissive: 0xd11f1f, emissiveIntensity: 1 }) },
  { id: "surface:blue-paint",   name: "蓝漆",         preview: "#2f4f8a", make: () => ({ color: 0x2f4f8a, roughness: 0.6, metalness: 0 }) },
  { id: "surface:mrt-red",      name: "捷运红",       preview: "#c62828", make: () => ({ color: 0xc62828, roughness: 0.6, metalness: 0 }) },
  { id: "surface:sign-red",     name: "招牌红(发光)", preview: "#c62828", make: () => ({ color: 0xc62828, roughness: 0.6, metalness: 0, emissive: 0x600, emissiveIntensity: 0.6 }) },
  { id: "surface:glass-blue",   name: "玻璃 · 蓝",    preview: "#8a9aa6", make: () => ({ color: 0x8a9aa6, roughness: 0.2, metalness: 0.85, emissive: 0x0e1418, emissiveIntensity: 1 }) },
  { id: "surface:glass-steel",  name: "玻璃 · 钢",    preview: "#7d93a6", make: () => ({ color: 0x7d93a6, roughness: 0.2, metalness: 0.85, emissive: 0x0e1418, emissiveIntensity: 1 }) },
  { id: "surface:glass-pale",   name: "玻璃 · 浅",    preview: "#9fb2c2", make: () => ({ color: 0x9fb2c2, roughness: 0.2, metalness: 0.85, emissive: 0x0e1418, emissiveIntensity: 1 }) },
  { id: "surface:glass-dark",   name: "玻璃 · 深",    preview: "#3a4a58", make: () => ({ color: 0x3a4a58, roughness: 0.2, metalness: 0.85, emissive: 0x0a1014, emissiveIntensity: 1 }) },
  { id: "surface:glass-light",  name: "玻璃 · 亮白",  preview: "#b8c2cc", make: () => ({ color: 0xb8c2cc, roughness: 0.25, metalness: 0.8, emissive: 0x0e1418, emissiveIntensity: 1 }) },
  { id: "surface:glass-sky",    name: "玻璃 · 天蓝",  preview: "#6f9bc4", make: () => ({ color: 0x6f9bc4, roughness: 0.25, metalness: 0.8, emissive: 0x0e1418, emissiveIntensity: 1 }) },
];

/* ---------------- 条目汇总 ---------------- */
// facade 条目按 FACADE_VARIANTS 顺序生成：id 与序号对齐
// city._pickFacade 返回的外观下标（facadeBatches[i]）。
const DEFS = [
  ...FACADE_VARIANTS.map((v, i) => ({
    id: `facade:${v.id}`, name: FACADE_ZH[v.id] || v.id, category: "facade",
    variantIndex: i, preview: v.base,
  })),
  { id: "roof:concrete", name: "屋顶 · 水泥", category: "roof", preview: "#7e7b74", make: () => ({ map: makeRoofTexture(), roughness: 0.92, metalness: 0 }) },
  { id: "roof:dark",     name: "屋顶 · 深灰", category: "roof", preview: "#4a4740", make: () => ({ color: 0x4a4740, roughness: 0.95, metalness: 0 }) },
  ...SURFACE_DEFS,
  // 店面：一格 = 一个开间（约 6m 宽 × 4m 高），uv 由 uvScaleFor 按此平铺
  ...STOREFRONT_STYLES.map((v, i) => ({
    id: `storefront:${v.id}`, name: STOREFRONT_ZH[v.id] || v.id, category: "storefront",
    variantIndex: i, preview: v.accent,
  })),
  // 招牌图集：整张 8x16 图集作为一张贴图（含自发光），适合 UV 已按格子
  // 排布的网格；平铺规则见 city._addStorefront 的 signTileRect
  { id: "sign:atlas", name: "招牌图集", category: "sign", preview: "#c9a23a", make: () => {
    const t = signAtlasTexture();
    return { map: t, emissiveMap: t, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0.5, roughness: 0.6, metalness: 0, side: THREE.DoubleSide,
      // 招牌贴片略向深度方向拉偏，避免与背面墙/盒子 z-fighting
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 };
  } },
];

/* ---------------- 材质实例缓存 ---------------- */
const _cache = new Map();
let _facadeTex = null;    // makeFacades() 只跑一次（贴图生成含随机做旧，需全局唯一）
let _storefrontTex = null;
let _signAtlasTex = null;

function facadeTextures() {
  if (!_facadeTex) _facadeTex = makeFacades();
  return _facadeTex;
}
function storefrontTextures() {
  if (!_storefrontTex) _storefrontTex = makeStorefronts();
  return _storefrontTex;
}
function signAtlasTexture() {
  if (!_signAtlasTex) _signAtlasTex = makeSignAtlas();
  return _signAtlasTex;
}

// 标记共享资源：世界销毁时跳过 dispose（main.js disposeTree / 编辑器 _rebuildAll）
function tagShared(mat) {
  mat.userData.shared = true;
  for (const k of Object.keys(mat)) {
    const v = mat[k];
    if (v && v.isTexture) v.userData.shared = true;
  }
  return mat;
}

export function getMaterial(id) {
  let m = _cache.get(id);
  if (m) return m;
  const def = DEFS.find((d) => d.id === id);
  if (!def) return null;
  let params;
  if (def.category === "facade") {
    const tex = facadeTextures()[def.variantIndex];
    params = {
      map: tex.map, emissiveMap: tex.emissive,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0.02, roughness: 0.86, metalness: 0.02,
    };
  } else if (def.category === "storefront") {
    const tex = storefrontTextures()[def.variantIndex];
    params = {
      map: tex.map, emissiveMap: tex.emissive,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0.2, roughness: 0.55, metalness: 0.05,
    };
  } else {
    params = def.make();
  }
  m = new THREE.MeshStandardMaterial(params);
  tagShared(m);
  _cache.set(id, m);
  return m;
}

// 程序化城市外墙材质数组（下标 = FACADE_VARIANTS 序号）。
// 夜间窗光：city.js 的 updateStream 直接改这批实例的 emissiveIntensity，
// 因此描边建筑选了 facade 类材质也会同步亮窗。
export function getFacadeMaterials() {
  return FACADE_VARIANTS.map((v) => getMaterial(`facade:${v.id}`));
}

// 店面材质数组（下标 = STOREFRONT_STYLES 序号）；夜间店堂灯光由
// city.js 的 updateStream 直接改这批实例的 emissiveIntensity
export function getStorefrontMaterials() {
  return STOREFRONT_STYLES.map((v) => getMaterial(`storefront:${v.id}`));
}

// 招牌图集材质（整张图集 + 自发光，夜间同样由 city.js 驱动亮度）
export function getSignMaterial() {
  return getMaterial("sign:atlas");
}

// 按材质 id 推导米制几何的 UV 平铺尺度 [sx, sy]；null = 无贴图不用管。
// facade 墙面 6.4m 一循环；roof 4m；storefront 一格 6m 宽 × 4m 高（一个开间）。
// 招牌图集是 UV 子矩形用法（signTileRect），整体平铺无意义 → 不缩放。
export function uvScaleFor(id) {
  if (!id) return null;
  if (id.startsWith("facade:")) return [FACADE_UV, FACADE_UV];
  if (id.startsWith("roof:")) return [ROOF_UV, ROOF_UV];
  if (id.startsWith("storefront:")) return [1 / 6, 1 / 4];
  return null;
}

// 材质元数据（不含 THREE 对象，可直接喂给编辑器 UI 下拉框）
export function listMaterials(categories) {
  return DEFS
    .filter((d) => !categories || categories.includes(d.category))
    .map(({ id, name, category, preview }) => ({ id, name, category, preview }));
}

/* ---------------- 几何 UV 工具 ---------------- */
// 贴图类材质的平铺规则：外墙每 6.4m 一循环、屋顶每 4m 一循环（与
// 程序化建筑的 wallQuad/roofQuad scaleUV 一致）。ExtrudeGeometry /
// ShapeGeometry 的 UV 单位是米，直接整体缩放即可对齐同一套平铺尺度。
export function scaleUVs(geo, sx, sy = sx) {
  const uv = geo.attributes.uv;
  if (!uv) return geo;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * sx, uv.getY(i) * sy);
  uv.needsUpdate = true;
  return geo;
}

// 外墙/屋顶 UV 缩放常量（米 → 贴图循环）
export const FACADE_UV = 1 / 6.4;
export const ROOF_UV = 1 / 4;
