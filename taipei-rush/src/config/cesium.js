// Cesium 底图图源配置 —— 图源方案复刻自 work/uav-inspection（src/config/cesium.ts）：
// - 天地图 WMTS 卫星影像(img) + 中文注记(cia)，需要 key（VITE_TIANDITU_KEY）
// - Esri World Imagery，免 key（天地图对高频瓦片请求会封 IP）
// - GeoQ 深色矢量图垫底（免 key，CORS 开放）
// 天地图影像与注记同为 CGCS2000 ≈ WGS84，与项目局部米坐标锚点转换无需纠偏。
// 图源选择由 3D 编辑器设置面板写入 localStorage，此处提供注册表 + 读写 + 构建三层 API。

const tiandituSubdomains = ["0", "1", "2", "3", "4", "5", "6", "7"];

// URL 模板里前缀 t 已写死，{s} 只能填数字（t0 会拼出不存在的域名）
function tiandituUrl(layer) {
  const key = (import.meta.env.VITE_TIANDITU_KEY || "").trim();
  return `https://t{s}.tianditu.gov.cn/${layer}_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=${key}`;
}

export const hasTiandituKey = !!(import.meta.env.VITE_TIANDITU_KEY || "").trim();

// 地名搜索（config/placeSearch.js）用的天地图浏览器端 token：优先 VITE_TIANDITU_KEY；
// 未配置时回退与 work/uav-inspection 共用的开发者账号 token（同一账号下瓦片与搜索通用），
// 保证搜索功能开箱即用。仅用于低频搜索请求——不用于瓦片（天地图对高频瓦片请求会封 IP，
// 所以底图仍按 hasTiandituKey 走「未配置即回退 Esri」的原有逻辑）。
export const tiandituSearchKey = hasTiandituKey
  ? import.meta.env.VITE_TIANDITU_KEY.trim()
  : "21372393c1e0828a116962c4362ff898";

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
    desc: hasTiandituKey ? "官方图源 · 卫星影像含中文注记" : "需要 key（.env.local: VITE_TIANDITU_KEY）",
    needKey: true,
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

// 图源元信息：credit 文案与就绪状态（如天地图未配 key 则未就绪）
export function basemapInfo(sourceId = getBasemapSource()) {
  const credit = sourceId === "tianditu" ? "天地图" : "Esri World Imagery";
  const configured = sourceId !== "tianditu" || hasTiandituKey;
  return { id: sourceId, credit, configured };
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

export function tiandituImageryLayers() {
  return [
    { url: tiandituUrl("img"), subdomains: tiandituSubdomains, maximumLevel: 18 },
    { url: tiandituUrl("cia"), subdomains: tiandituSubdomains, maximumLevel: 18 },
  ];
}

/* ---------------- Provider 构建 ---------------- */

// 生成 Cesium ImageryProvider 列表（顺序：GeoQ 垫底 → 卫星影像 → 注记）
// sourceId 缺省时取当前生效图源；天地图未配 key 自动回退 Esri。
export function buildImageryLayers(Cesium, sourceId = getBasemapSource()) {
  const providers = [
    new Cesium.UrlTemplateImageryProvider({ url: geoqVectorLayer.url, maximumLevel: geoqVectorLayer.maximumLevel }),
  ];
  if (sourceId === "tianditu" && hasTiandituKey) {
    for (const l of tiandituImageryLayers()) {
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
