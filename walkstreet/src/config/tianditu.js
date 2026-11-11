// 天地图公共资源配置 —— 统一管理 token（tk）与各图层瓦片地址（DataServer 接口）：
// - tk 优先级：VITE_TIANDITU_KEY（.env.local 专属 key）> 内置开发者 token
//   （与 work/uav-inspection、地名搜索共用，同一账号下瓦片与搜索通用），开箱即用；
// - 图层代号以 _w 结尾 = Web 墨卡托投影（CGCS2000 ≈ WGS84），与项目局部米坐标
//   锚点转换无需纠偏；
// - 注意：天地图对高频瓦片请求会封 IP，内置 token 建议仅开发/低频场景使用，
//   生产环境请配置专属 key（.env.local: VITE_TIANDITU_KEY）。

const BUILTIN_TOKEN = "21372393c1e0828a116962c4362ff898";

// 实际生效的 tk：优先 .env.local 配置的专属 key
export const tiandituKey = (import.meta.env.VITE_TIANDITU_KEY || "").trim() || BUILTIN_TOKEN;

// 是否配置了专属 key（false = 正在使用内置公共 token，UI 可据此提示）
export const hasTiandituKey = !!(import.meta.env.VITE_TIANDITU_KEY || "").trim();

// 瓦片子域 t0 ~ t7（模板 {s} 由地图库注入；逐条列出的数组版见 tiandituUrls）
export const tiandituSubdomains = ["0", "1", "2", "3", "4", "5", "6", "7"];

/* ---------------- 图层注册表 ----------------
 * DataServer 接口：https://t{s}.tianditu.gov.cn/DataServer?T=<图层代号>&x={x}&y={y}&l={z}&tk=<tk>
 * maximumLevel 为各图层对外提供的最大瓦片层级。
 */
export const tiandituLayers = {
  img_w: { label: "卫星影像", maximumLevel: 18 },
  cia_w: { label: "影像注记（中文）", maximumLevel: 18 },
  vec_w: { label: "矢量底图", maximumLevel: 18 },
  cva_w: { label: "矢量注记（中文）", maximumLevel: 18 },
  ter_w: { label: "地形晕渲", maximumLevel: 14 },
  cta_w: { label: "地形注记（中文）", maximumLevel: 14 },
  ibo_w: { label: "省市区县境界", maximumLevel: 18 },
};

// 单图层 URL 模板（{s}/{x}/{y}/{z} 由地图库注入，Cesium / Leaflet 通用）
export function tiandituTemplate(layer) {
  return `https://t{s}.tianditu.gov.cn/DataServer?T=${layer}&x={x}&y={y}&l={z}&tk=${tiandituKey}`;
}

// 单图层全子域 URL 数组（t0~t7 逐条列出，供按多条 URL 取瓦片的图源直接使用）
export function tiandituUrls(layer) {
  return tiandituSubdomains.map(
    (s) => `https://t${s}.tianditu.gov.cn/DataServer?T=${layer}&x={x}&y={y}&l={z}&tk=${tiandituKey}`
  );
}

/* ---------------- 常用底图组合（图层代号数组，按叠加顺序） ---------------- */
export const basemapPresets = {
  satellite: ["img_w", "cia_w"], // 影像 + 中文注记（3D 编辑器底图）
  vector: ["vec_w", "cva_w"], // 矢量 + 中文注记
  terrain: ["ter_w", "cta_w"], // 地形晕渲 + 中文注记
};

// 底图组合 → 瓦片层参数列表（url 模板 + 子域 + 最大层级），Cesium UrlTemplateImageryProvider
// 直接可用；也接受单个图层代号（如 "vec_w"）只取一层。
export function tiandituBasemapLayers(preset = "satellite") {
  const layers = basemapPresets[preset] || [preset];
  return layers.map((layer) => ({
    url: tiandituTemplate(layer),
    subdomains: tiandituSubdomains,
    maximumLevel: tiandituLayers[layer].maximumLevel,
  }));
}
