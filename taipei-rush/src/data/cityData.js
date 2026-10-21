// Taipei street layout. Units are metres. +X = east, +Z = south.
// Roads are ordered arrays; blocks are derived between consecutive roads.

export const ROADS_X = [
  { id: "huanhe",    zh: "環河南路", en: "Huanhe S. Rd",    at: -430, kind: "arterial",  lanes: 2, median: 2, sidewalk: 4 },
  { id: "zhonghua",  zh: "中華路",   en: "Zhonghua Rd",     at: -300, kind: "boulevard", lanes: 3, median: 6, sidewalk: 5 },
  { id: "kunming",   zh: "昆明街",   en: "Kunming St",      at: -210, kind: "street",    lanes: 1, median: 0, sidewalk: 3 },
  { id: "hanzhong",  zh: "漢中街",   en: "Hanzhong St",     at: -130, kind: "street",    lanes: 1, median: 0, sidewalk: 4 },
  { id: "zhongshan", zh: "中山南路", en: "Zhongshan S. Rd", at: -40,  kind: "boulevard", lanes: 3, median: 4, sidewalk: 4 },
  { id: "xinsheng",  zh: "新生南路", en: "Xinsheng S. Rd",  at: 90,   kind: "arterial",  lanes: 2, median: 2, sidewalk: 4 },
  { id: "jianguo",   zh: "建國南路", en: "Jianguo S. Rd",   at: 210,  kind: "arterial",  lanes: 2, median: 4, sidewalk: 4 },
  { id: "fuxing",    zh: "復興南路", en: "Fuxing S. Rd",    at: 330,  kind: "arterial",  lanes: 2, median: 2, sidewalk: 4 },
  { id: "dunhua",    zh: "敦化南路", en: "Dunhua S. Rd",    at: 450,  kind: "boulevard", lanes: 3, median: 6, sidewalk: 5, treeMedian: true },
  { id: "guangfu",   zh: "光復南路", en: "Guangfu S. Rd",   at: 570,  kind: "arterial",  lanes: 2, median: 2, sidewalk: 4 },
  { id: "keelung",   zh: "基隆路",   en: "Keelung Rd",      at: 690,  kind: "arterial",  lanes: 2, median: 4, sidewalk: 4 },
  { id: "songren",   zh: "松仁路",   en: "Songren Rd",      at: 810,  kind: "street",    lanes: 1, median: 0, sidewalk: 3 },
];

export const ROADS_Z = [
  { id: "civic",     zh: "市民大道", en: "Civic Blvd",      at: -300, kind: "boulevard", lanes: 3, median: 6, sidewalk: 5 },
  { id: "zhongxiao", zh: "忠孝東路", en: "Zhongxiao E. Rd", at: -200, kind: "boulevard", lanes: 3, median: 5, sidewalk: 5 },
  { id: "kaifeng",   zh: "開封街",   en: "Kaifeng St",      at: -130, kind: "street",    lanes: 1, median: 0, sidewalk: 3 },
  { id: "hankou",    zh: "漢口街",   en: "Hankou St",       at: -75,  kind: "street",    lanes: 1, median: 0, sidewalk: 3 },
  { id: "emei",      zh: "峨嵋街",   en: "Emei St",         at: -20,  kind: "street",    lanes: 1, median: 0, sidewalk: 3 },
  { id: "chengdu",   zh: "成都路",   en: "Chengdu Rd",      at: 35,   kind: "street",    lanes: 1, median: 0, sidewalk: 3 },
  { id: "renai",     zh: "仁愛路",   en: "Renai Rd",        at: 110,  kind: "boulevard", lanes: 3, median: 7, sidewalk: 5, treeMedian: true },
  { id: "xinyi",     zh: "信義路",   en: "Xinyi Rd",        at: 190,  kind: "boulevard", lanes: 3, median: 5, sidewalk: 5 },
  { id: "songgao",   zh: "松高路",   en: "Songgao Rd",      at: 250,  kind: "street",    lanes: 1, median: 0, sidewalk: 3 },
  { id: "heping",    zh: "和平東路", en: "Heping E. Rd",    at: 280,  kind: "arterial",  lanes: 2, median: 4, sidewalk: 4 },
];

export const LANE_W = 3.4;

export function asphaltHalf(road) {
  return road.lanes * LANE_W + road.median / 2;
}
export function corridorHalf(road) {
  return asphaltHalf(road) + road.sidewalk;
}

export const DISTRICTS = [
  { id: "ximending", zh: "西門町", en: "XIMENDING", sub: "潮流 · 電影院與街頭", minX: -300, maxX: -40, minZ: -130, maxZ: 35 },
  { id: "station",   zh: "臺北車站", en: "TAIPEI MAIN STATION", sub: "補習街 · 商旅與轉運", minX: -300, maxX: -130, minZ: -300, maxZ: -130 },
  { id: "zhongshan", zh: "中山", en: "ZHONGSHAN", sub: "商圈 · 條通與百貨", minX: -130, maxX: 210, minZ: -200, maxZ: 110 },
  { id: "wanhua",    zh: "萬華", en: "WANHUA", sub: "龍山寺 · 老街與夜市", minX: -430, maxX: -210, minZ: -75, maxZ: 280 },
  { id: "daan",      zh: "大安", en: "DA'AN", sub: "森林公園 · 靜巷住宅", minX: 210, maxX: 450, minZ: 110, maxZ: 280 },
  { id: "xinyi",     zh: "信義", en: "XINYI", sub: "臺北101 · 金融與百貨", minX: 450, maxX: 810, minZ: 110, maxZ: 280 },
  { id: "east",      zh: "東區", en: "EAST DISTRICT", sub: "忠孝敦化 · 潮流店家", minX: 330, maxX: 690, minZ: -300, maxZ: 110 },
  { id: "central",   zh: "中正", en: "ZHONGZHENG", sub: "博愛特區 · 官署與公園", minX: -40, maxX: 330, minZ: -200, maxZ: 110 },
  { id: "south",     zh: "公館", en: "GONGUAN", sub: "校園 · 書店與小吃", minX: -300, maxX: 330, minZ: 280, maxZ: 400 },
  { id: "river",     zh: "淡水河", en: "TAMSUI RIVER", sub: "河濱 · 橋樑與自行車道", minX: -820, maxX: -430, minZ: -420, maxZ: 420 },
];

export function districtAt(x, z) {
  let best = null;
  for (const d of DISTRICTS) {
    if (x >= d.minX && x <= d.maxX && z >= d.minZ && z <= d.maxZ) {
      const area = (d.maxX - d.minX) * (d.maxZ - d.minZ);
      if (!best || area < best._area) { best = d; best._area = area; }
    }
  }
  return best || { zh: "臺北", en: "TAIPEI", sub: "城市街區", id: "taipei" };
}

export const LANDMARKS = [
  { id: "taipei101", type: "taipei101", x: 578, z: 168, rot: 0.15 },
  { id: "redhouse", type: "redhouse", x: -158, z: -4, rot: 0 },
  { id: "longshan", type: "temple", x: -384, z: 152, rot: 0.12 },
  { id: "cks", type: "cks", x: 268, z: 318, rot: 0 },
  { id: "mainstation", type: "station", x: -240, z: -240, rot: 0 },
  { id: "ximen_mrt", type: "mrt", x: -300, z: -20, rot: 0 },
  { id: "xinyi_tower_a", type: "tower", x: 664, z: 132, rot: 0.2, h: 128 },
  { id: "xinyi_tower_b", type: "tower", x: 505, z: 152, rot: -0.1, h: 96 },
  { id: "xinyi_tower_c", type: "tower", x: 706, z: 228, rot: 0.35, h: 112 },
  { id: "xinyi_tower_d", type: "tower", x: 478, z: 236, rot: 0.05, h: 84 },
  { id: "northgate", type: "gate", x: -104, z: -292, rot: 0 },
];

export const SPAWN = { x: -160, z: -46, heading: Math.PI * 0.5 };

export const SHOP_NAMES = [
  "球鞋王", "街頭潮牌", "阿宗麵線", "豪大大雞排", "珍珠奶茶", "五十嵐", "茶湯會",
  "便利商店", "西門藥局", "電影院", "服飾", "運動用品", "手機維修", "夾娃娃機",
  "滷味", "牛肉麵", "咖啡", "早午餐", "書店", "文具", "麵包坊", "小吃", "火鍋",
  "燒肉", "髮廊", "美甲", "刺青", "唱片行", "漫畫", "眼鏡", "鐘錶", "銀樓",
  "中藥行", "水果行", "洗衣", "拖鞋", "帽子", "包包", "飾品", "攝影", "旅館",
  "網咖", "甜品", "豆花", "冰品", "炸雞", "披薩", "壽司", "拉麵", "餃子",
];

export const SHOP_SUBS = [
  "SINCE 1985", "24H", "西門店", "臺北", "本店", "旗艦店", "特賣", "新上市",
  "OPEN", "歡迎光臨", "排隊名店", "老店", "手作", "嚴選", "限量", "外帶",
];

// sign palette (hex)
export const SIGN_COLORS = [
  "#e0231e", "#ff3d8b", "#ff6b2c", "#ffd23f", "#3ddc97", "#2ec4e6",
  "#4a6cf7", "#a855f7", "#ffffff", "#111111", "#0f766e", "#b91c1c",
];
