// Cesium 底图图源配置 —— 图源方案复刻自 work/uav-inspection（src/config/cesium.ts）：
// - 天地图 DataServer 卫星影像(img_w) + 中文注记(cia_w)，tk 与图层瓦片地址统一在
//   config/tianditu.js（优先 VITE_TIANDITU_KEY，未配置时用内置开发者 token，开箱即用）
// - Esri World Imagery，免 key 备选（天地图对高频瓦片请求会封 IP）
// - GeoQ 深色矢量图垫底（免 key，CORS 开放）
// 天地图影像与注记同为 CGCS2000 ≈ WGS84，与项目局部米坐标锚点转换无需纠偏。
// 图源选择由 3D 编辑器设置面板写入 localStorage，此处提供注册表 + 读写 + 构建三层 API。

import { hasTiandituKey, tiandituBasemapLayers } from "./tianditu.js";

/* ---------------- 图源注册表 ---------------- */
// 新增图源：在数组里加一项（id/label/desc/needKey），并在下方 buildImageryLayers
// 的 switch 里补对应 provider 构建即可，设置面板会自动列出新选项。
export const basemapSources = [
  {
    id: "esri",
    label: "Esri 卫星影像",
    desc: "免 key · 全球覆盖 · 开发默认",
    needKey: false,
  },
  {
    id: "tianditu",
    label: "天地图影像 + 注记",
    desc: hasTiandituKey ? "官方图源 · 卫星影像含中文注记" : "内置公共 token · 可配专属 key（.env.local: VITE_TIANDITU_KEY）",
    needKey: false,
  },
  {
    id: "tianditu_vec_anno",
    label: "天地图矢量 + 注记",
    desc: "官方图源 · 矢量底图含中文注记（vec_w/cva_w · 球面墨卡托）",
    needKey: false,
  },
];

/* ---------------- 图源选择（持久化） ---------------- */
const KEY_SRC = "tr_e3_basemap_src";

// 生产/环境变量决定的默认图源（用户未选择时生效）
function envDefaultSource() {
  if (import.meta.env.PROD) return "tianditu";
  return import.meta.env.VITE_BASEMAP_SOURCE === "tianditu" ? "tianditu" : "esri";
}

// 当前生效图源：用户选择(localStorage) > 生产/环境默认
export function getBasemapSource() {
  try {
    const saved = localStorage.getItem(KEY_SRC);
    if (saved && basemapSources.some((s) => s.id === saved)) return saved;
  } catch { /* localStorage 不可用时走默认 */ }
  return envDefaultSource();
}

export function setBasemapSource(id) {
  try { localStorage.setItem(KEY_SRC, id); } catch { /* 忽略 */ }
}

// 图源元信息：credit 文案 + 就绪状态（天地图 tk 由 config/tianditu.js 常备，configured 恒 true；
// builtinToken = 正在用内置公共 token，供 UI 提示可配专属 key）
export function basemapInfo(sourceId = getBasemapSource()) {
  const credit = sourceId === "esri" ? "Esri World Imagery" : "天地图";
  const builtinToken = sourceId === "tianditu" && !hasTiandituKey;
  return { id: sourceId, credit, configured: true, builtinToken };
}

/* ---------------- 瓦片层定义 ---------------- */

// 栅格瓦片层（UrlTemplateImageryProvider 参数）：{z}/{x}/{y} 由 Cesium 注入
export const esriImageryLayer = {
  url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  maximumLevel: 18,
};

// 外围垫底：GeoQ 深色矢量（standard XYZ 自北向南，Cesium {y} 语义正好对上，无需 reverseY）
export const geoqVectorLayer = {
  url: "https://digit.atcdi.com.cn:60/basemap/thematic.geoq-purplishblue-onlysymbol/{z}/{x}/{y}.jpg",
  maximumLevel: 16,
};

/* ---------------- Provider 构建 ---------------- */

// 生成 Cesium ImageryProvider 列表（顺序：GeoQ 垫底 → 卫星影像 → 注记）
// sourceId 缺省时取当前生效图源；天地图瓦片模板/层级由 config/tianditu.js 提供。
export function buildImageryLayers(Cesium, sourceId = getBasemapSource()) {
  const providers = [
    new Cesium.UrlTemplateImageryProvider({ url: geoqVectorLayer.url, maximumLevel: geoqVectorLayer.maximumLevel }),
  ];
  if (sourceId === "tianditu" || sourceId === "tianditu_vec_anno") {
    const preset = sourceId === "tianditu_vec_anno" ? "vector" : "satellite";
    for (const l of tiandituBasemapLayers(preset)) {
      providers.push(new Cesium.UrlTemplateImageryProvider({
        url: l.url, subdomains: l.subdomains, maximumLevel: l.maximumLevel,
      }));
    }
  } else {
    providers.push(new Cesium.UrlTemplateImageryProvider({
      url: esriImageryLayer.url, maximumLevel: esriImageryLayer.maximumLevel,
    }));
  }
  return providers;
}
