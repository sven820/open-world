// 地名搜索（纯前端直连，无后端代理）——移植自 work/uav-inspection
// （src/components/wayline/utils/placeSearch.js）：
//
// 数据源固定为天地图「地名搜索 V2.0」（api.tianditu.gov.cn/v2/search）：
// - token 复用天地图浏览器端 token（config/tianditu.js 的 tiandituKey，优先
//   VITE_TIANDITU_KEY，同一开发者账号下瓦片与搜索通用），国内网络稳定、中文 POI 覆盖全；
// - 响应 CORS 开放、浏览器可直接 GET（浏览器端 token 要求请求带浏览器 UA / Referer，
//   浏览器 fetch 天然满足）；坐标系 CGCS2000 ≈ WGS84，喂 Cesium 无需纠偏。
//
// 高德 / 百度不取：前端直调要么 CORS 受限、要么要求安全密钥走服务端代理（即需要后端）；
// Nominatim（OSM）属境外服务（国内网络实测不可达），均不作为数据源。

import { tiandituKey as tiandituSearchKey } from "./tianditu.js";

const TIANDITU_SEARCH_URL = "https://api.tianditu.gov.cn/v2/search";

/** 单次返回条数，与下拉列表容量一致 */
const RESULT_LIMIT = 8;

/** 搜索范围（西,南,东,北）：全国陆域范围，保证跨省地名也能命中 */
const CHINA_MAP_BOUND = "73.5,18.0,135.0,54.0";

/**
 * 单次请求超时（毫秒）。
 * 必须显式设：网络异常或服务端挂起时请求会长时间停摆，不设超时搜索框就一直转圈。
 */
const REQUEST_TIMEOUT_MS = 8000;

/** fetch + 超时：合并外部 signal 与超时定时器，任一触发都取消请求 */
async function fetchWithTimeout(url, signal, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("geocoding request timeout", "TimeoutError")), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// 天地图「普通搜索」（queryType=1）：名称模糊匹配，返回 POI 列表
async function searchByTianditu(keyword, signal) {
  const postStr = {
    keyWord: keyword,
    level: 12,
    mapBound: CHINA_MAP_BOUND,
    queryType: "1",
    start: 0,
    count: RESULT_LIMIT,
    mapType: "0001",
    queryTerminal: "6800", // 终端类型：6800 = 浏览器
  };
  const url = `${TIANDITU_SEARCH_URL}?postStr=${encodeURIComponent(JSON.stringify(postStr))}&type=query&tk=${tiandituSearchKey}`;
  const response = await fetchWithTimeout(url, signal);
  if (!response.ok) throw new Error(`tianditu search http ${response.status}`);
  const data = await response.json();
  // infocode=1000 为成功（实测是数字，用 Number() 兼容字符串形式）；key 失效 / 配额耗尽等都会落到非 1000 分支
  if (Number(data?.status?.infocode) !== 1000)
    throw new Error(`tianditu search failed: ${data?.status?.infocode ?? "unknown"}`);
  const pois = Array.isArray(data.pois) ? data.pois : [];
  return pois
    .map((poi) => {
      const [lng, lat] = String(poi.lonlat || "").split(",").map(Number);
      // poiType 是数字分类代码（101/102…），无展示价值；次级说明直接用地址
      return { name: String(poi.name || ""), lng, lat, meta: String(poi.address || "") };
    })
    .filter((item) => item.name && Number.isFinite(item.lng) && Number.isFinite(item.lat));
}

/**
 * 模糊搜索地名。
 *
 * @param {string} keyword 关键字（建议 >=2 字符，由调用方防抖后传入）
 * @param {{ signal?: AbortSignal }} [options] 传 AbortSignal 取消过期请求
 * @returns {Promise<{name: string, lng: number, lat: number, meta: string}[]>} WGS84 经纬度，可直接喂 Cesium
 */
export async function searchPlaces(keyword, options = {}) {
  const q = typeof keyword === "string" ? keyword.trim() : "";
  if (!q || !tiandituSearchKey) return [];
  return searchByTianditu(q, options.signal);
}
