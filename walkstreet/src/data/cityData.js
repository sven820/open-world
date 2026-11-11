// Virtual city street layout. Units are metres. +X = east, +Z = south.
// Roads are ordered arrays; blocks are derived between consecutive roads.

export const ROADS_X = [
  { id: "binhe",     zh: "滨河南路", en: "Binhe S. Rd",      at: -430, kind: "arterial",  lanes: 2, median: 2, sidewalk: 4 },
  { id: "zhongyang", zh: "中央大道", en: "Central Blvd",     at: -300, kind: "boulevard", lanes: 3, median: 6, sidewalk: 5 },
  { id: "wutong",    zh: "梧桐街",   en: "Wutong St",        at: -210, kind: "street",    lanes: 1, median: 0, sidewalk: 3 },
  { id: "yinxing",   zh: "银杏街",   en: "Ginkgo St",        at: -130, kind: "street",    lanes: 1, median: 0, sidewalk: 4 },
  { id: "renmin",    zh: "人民南路", en: "Renmin S. Rd",     at: -40,  kind: "boulevard", lanes: 3, median: 4, sidewalk: 4 },
  { id: "chaoyang",  zh: "朝阳南路", en: "Chaoyang S. Rd",   at: 90,   kind: "arterial",  lanes: 2, median: 2, sidewalk: 4 },
  { id: "jianshe",   zh: "建设南路", en: "Jianshe S. Rd",    at: 210,  kind: "arterial",  lanes: 2, median: 4, sidewalk: 4 },
  { id: "zhenxing",  zh: "振兴南路", en: "Zhenxing S. Rd",   at: 330,  kind: "arterial",  lanes: 2, median: 2, sidewalk: 4 },
  { id: "yunshan",   zh: "云杉大道", en: "Spruce Blvd",      at: 450,  kind: "boulevard", lanes: 3, median: 6, sidewalk: 5, treeMedian: true },
  { id: "chenxi",    zh: "晨曦路",   en: "Chenxi Rd",        at: 570,  kind: "arterial",  lanes: 2, median: 2, sidewalk: 4 },
  { id: "yunhe",     zh: "云河路",   en: "Yunhe Rd",         at: 690,  kind: "arterial",  lanes: 2, median: 4, sidewalk: 4 },
  { id: "songlin",   zh: "松林路",   en: "Songlin Rd",       at: 810,  kind: "street",    lanes: 1, median: 0, sidewalk: 3 },
];

export const ROADS_Z = [
  { id: "binjiang",  zh: "滨江大道", en: "Riverside Blvd",   at: -300, kind: "boulevard", lanes: 3, median: 6, sidewalk: 5 },
  { id: "zhongxing", zh: "中兴大道", en: "Zhongxing Blvd",   at: -200, kind: "boulevard", lanes: 3, median: 5, sidewalk: 5 },
  { id: "fenghuang", zh: "凤凰街",   en: "Fenghuang St",     at: -130, kind: "street",    lanes: 1, median: 0, sidewalk: 3 },
  { id: "haitang",   zh: "海棠街",   en: "Haitang St",       at: -75,  kind: "street",    lanes: 1, median: 0, sidewalk: 3 },
  { id: "qingfeng",  zh: "清风街",   en: "Qingfeng St",      at: -20,  kind: "street",    lanes: 1, median: 0, sidewalk: 3 },
  { id: "qingshi",   zh: "青石街",   en: "Qingshi St",       at: 35,   kind: "street",    lanes: 1, median: 0, sidewalk: 3 },
  { id: "hefeng",    zh: "荷风路",   en: "Hefeng Rd",        at: 110,  kind: "boulevard", lanes: 3, median: 7, sidewalk: 5, treeMedian: true },
  { id: "xinghai",   zh: "星海路",   en: "Xinghai Rd",       at: 190,  kind: "boulevard", lanes: 3, median: 5, sidewalk: 5 },
  { id: "songyun",   zh: "松云路",   en: "Songyun Rd",       at: 250,  kind: "street",    lanes: 1, median: 0, sidewalk: 3 },
  { id: "yongan",    zh: "永安路",   en: "Yongan Rd",        at: 280,  kind: "arterial",  lanes: 2, median: 4, sidewalk: 4 },
];

export const LANE_W = 3.4;

// 自动延伸街道的间距（世界边缘的程序化路网填充）
export const EXT_STEP_X = 110;
export const EXT_STEP_Z = 100;

// 延伸路网的分级规格：每 3 条升级为林荫大道（双车道 + 中央绿化带 + 宽人行道），
// 其余为街巷。建城（city.js）与两个地图编辑器的预览共用这一份规则，
// 保证"预览 = 实际生成的街道"。
export function extRoadSpec(at, step) {
  const i = Math.round(at / step);
  const avenue = ((i % 3) + 3) % 3 === 0;
  return avenue
    ? { kind: "avenue", lanes: 2, median: 4, sidewalk: 5, treeMedian: true }
    : { kind: "street", lanes: 1, median: 0, sidewalk: 4 };
}

// 程序化城市生成参数（地图编辑器里可调，随地图保存在 localStorage）：
//   procedural   是否自动生成程序化城市（街区建筑 / 绿植 / 路灯 / 街边停车），
//                用户地图默认关闭，需在编辑器里勾选；默认街区始终生成
//   gapScale     楼间距倍率（1 = 默认，相邻建筑之间约 2~4m 缝）
//   greenDensity 绿植密度倍率（0 = 不种，1 = 默认）
//   lampDensity  路灯密度倍率（0 = 不装，1 = 默认）
export const GEN_DEFAULTS = { procedural: true, gapScale: 1, greenDensity: 1, lampDensity: 1 };

// 把地图数据里的生成参数规整成安全范围（缺省 / 非法值回退到默认）
export function genConfig(map) {
  const src = map || {};
  const num = (v, min, max, def) =>
    (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def);
  return {
    // 地图未写该字段时（含默认街区 null 数据）沿用默认；用户地图由 mapStore 显式写入
    procedural: src.procedural === undefined ? GEN_DEFAULTS.procedural : !!src.procedural,
    gapScale: num(src.gapScale, 0.4, 2.2, GEN_DEFAULTS.gapScale),
    greenDensity: num(src.greenDensity, 0, 2.5, GEN_DEFAULTS.greenDensity),
    lampDensity: num(src.lampDensity, 0, 2.5, GEN_DEFAULTS.lampDensity),
  };
}

// 用户地图的世界边界：按路网范围四周延伸缓冲推导
export function mapBounds(roadsX, roadsZ) {
  const xs = (roadsX || []).map((r) => r.at);
  const zs = (roadsZ || []).map((r) => r.at);
  // 空/单侧路网：Math.min/max 展开空数组会得到 ±Infinity，回退到默认世界范围
  if (!xs.length || !zs.length) return { minX: -1072, maxX: 1462, minZ: -602, maxZ: 582 };
  const MX = 650, MZ = 300;
  return {
    minX: Math.min(...xs) - MX, maxX: Math.max(...xs) + MX,
    minZ: Math.min(...zs) - MZ, maxZ: Math.max(...zs) + MZ,
  };
}

export function asphaltHalf(road) {
  return road.lanes * LANE_W + road.median / 2;
}
export function corridorHalf(road) {
  return asphaltHalf(road) + road.sidewalk;
}

export const DISTRICTS = [
  { id: "tide",      zh: "潮汇坊", en: "TIDE HUB",       sub: "潮流 · 影院与街头", minX: -300, maxX: -40, minZ: -130, maxZ: 35 },
  { id: "hub",       zh: "中央车站", en: "CENTRAL STATION", sub: "商旅与转运", minX: -300, maxX: -130, minZ: -300, maxZ: -130 },
  { id: "midtown",   zh: "中城",   en: "MIDTOWN",        sub: "商圈 · 百货与夜市", minX: -130, maxX: 210, minZ: -200, maxZ: 110 },
  { id: "oldtown",   zh: "老城",   en: "OLD TOWN",       sub: "古庙 · 老街与市集", minX: -430, maxX: -210, minZ: -75, maxZ: 280 },
  { id: "parkside",  zh: "绿野",   en: "PARKSIDE",       sub: "森林公园 · 静巷住宅", minX: 210, maxX: 450, minZ: 110, maxZ: 280 },
  { id: "skyline",   zh: "云际",   en: "SKYLINE",        sub: "摩天塔 · 金融与百货", minX: 450, maxX: 810, minZ: 110, maxZ: 280 },
  { id: "east",      zh: "东街",   en: "EAST END",       sub: "潮流店家", minX: 330, maxX: 690, minZ: -300, maxZ: 110 },
  { id: "civic",     zh: "府前",   en: "CIVIC CENTER",   sub: "行政中心与公园", minX: -40, maxX: 330, minZ: -200, maxZ: 110 },
  { id: "campus",    zh: "学城",   en: "CAMPUS",         sub: "校园 · 书店与小吃", minX: -300, maxX: 330, minZ: 280, maxZ: 400 },
  { id: "river",     zh: "滨河",   en: "RIVERSIDE",      sub: "河滨 · 桥梁与自行车道", minX: -820, maxX: -430, minZ: -420, maxZ: 420 },
];

export function districtAt(x, z) {
  const districts = activeDistricts();
  let best = null;
  for (const d of districts) {
    if (x >= d.minX && x <= d.maxX && z >= d.minZ && z <= d.maxZ) {
      const area = (d.maxX - d.minX) * (d.maxZ - d.minZ);
      if (!best || area < best._area) { best = d; best._area = area; }
    }
  }
  return best || { zh: "主街区", en: "MAIN DISTRICT", sub: "城市街区", id: "downtown" };
}

export const LANDMARKS = [
  { id: "skytower", type: "skytower", x: 578, z: 168, rot: 0.15 },
  { id: "redbrick", type: "redhouse", x: -158, z: -4, rot: 0 },
  { id: "oldtemple", type: "temple", x: -384, z: 152, rot: 0.12 },
  { id: "grandhall", type: "hall", x: 268, z: 318, rot: 0 },
  { id: "centralstation", type: "station", x: -240, z: -240, rot: 0 },
  { id: "metrohub", type: "metro", x: -300, z: -20, rot: 0 },
  { id: "sky_tower_a", type: "tower", x: 664, z: 132, rot: 0.2, h: 128 },
  { id: "sky_tower_b", type: "tower", x: 505, z: 152, rot: -0.1, h: 96 },
  { id: "sky_tower_c", type: "tower", x: 706, z: 228, rot: 0.35, h: 112 },
  { id: "sky_tower_d", type: "tower", x: 478, z: 236, rot: 0.05, h: 84 },
  { id: "oldgate", type: "gate", x: -104, z: -292, rot: 0 },
];

// ---- Active map override ----
// 选中用户地图时 setMapData() 换入整套数据；未设置时全部回退到默认街区。
let OVERRIDE = null;
export function setMapData(d) { OVERRIDE = d || null; }
export function activeRoadsX() { return (OVERRIDE && OVERRIDE.roadsX) || ROADS_X; }
export function activeRoadsZ() { return (OVERRIDE && OVERRIDE.roadsZ) || ROADS_Z; }
export function activeDistricts() { return (OVERRIDE && OVERRIDE.districts) || DISTRICTS; }
export function activeLandmarks() { return (OVERRIDE && OVERRIDE.landmarks) || LANDMARKS; }
export function activeSpawn() { return (OVERRIDE && OVERRIDE.spawn) || SPAWN; }

export const SPAWN = { x: -160, z: -24, heading: -Math.PI / 2 };

export const SHOP_NAMES = [
  "球鞋王", "街头潮牌", "手工面线", "香酥鸡排", "珍珠奶茶", "鲜果茶铺", "茶汤会",
  "便利商店", "街角药局", "电影院", "服饰", "运动用品", "手机维修", "夹娃娃机",
  "卤味", "牛肉面", "咖啡", "早午餐", "书店", "文具", "面包坊", "小吃", "火锅",
  "烧肉", "发廊", "美甲", "刺青", "唱片行", "漫画", "眼镜", "钟表", "银楼",
  "中药行", "水果行", "洗衣", "拖鞋", "帽子", "包包", "饰品", "摄影", "旅馆",
  "网咖", "甜品", "豆花", "冰品", "炸鸡", "披萨", "寿司", "拉面", "饺子",
];

export const SHOP_SUBS = [
  "SINCE 1985", "24H", "总店", "城中", "本店", "旗舰店", "特卖", "新上市",
  "OPEN", "欢迎光临", "排队名店", "老店", "手作", "严选", "限量", "外带",
];

// sign palette (hex)
export const SIGN_COLORS = [
  "#e0231e", "#ff3d8b", "#ff6b2c", "#ffd23f", "#3ddc97", "#2ec4e6",
  "#4a6cf7", "#a855f7", "#ffffff", "#111111", "#0f766e", "#b91c1c",
];
