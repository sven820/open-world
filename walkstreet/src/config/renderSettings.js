// 渲染性能配置（单一数据源）
// 只放"影响渲染负载"的参数：分辨率、视距、阴影、泛光、行人/车流规模、帧率上限。
// 世界生成（路网/建筑）不属于这里，改它需要重建地图。
// 用户可整体切档位，也可单独拖动某一项；改动即时生效并写入 localStorage。

const STORAGE_KEY = "walkstreet.render.v1";
// 旧版键（taipei-rush 时期）：新键无数据时回读一次，保留用户已有画面设置
const LEGACY_STORAGE_KEY = "taipei-rush.render.v1";

// 实例化对象的容量上限（构建期一次性分配，运行期只切换启用数量）
export const MAX_PEDESTRIANS = 320;
export const MAX_VEHICLES = 60;

export const PRESETS = {
  low: {
    label: "流畅",
    hint: "低端手机 / 集成显卡",
    renderScale: 0.7,
    maxPixelRatio: 1,
    renderDistance: 420,
    shadows: false,
    shadowMapSize: 1024,
    shadowDistance: 70,
    bloom: false,
    pedestrians: 70,
    pedestrianDistance: 60,
    traffic: 14,
    trafficDistance: 140,
    hudFps: 8,
  },
  medium: {
    label: "均衡",
    hint: "主流笔记本 / 中端手机",
    renderScale: 0.85,
    maxPixelRatio: 1.35,
    renderDistance: 700,
    shadows: true,
    shadowMapSize: 1024,
    shadowDistance: 80,
    bloom: true,
    pedestrians: 150,
    pedestrianDistance: 100,
    traffic: 28,
    trafficDistance: 200,
    hudFps: 12,
  },
  high: {
    label: "高清",
    hint: "独立显卡 / 推荐",
    renderScale: 1,
    maxPixelRatio: 1.75,
    renderDistance: 1000,
    shadows: true,
    shadowMapSize: 2048,
    shadowDistance: 95,
    bloom: true,
    pedestrians: 240,
    pedestrianDistance: 140,
    traffic: 40,
    trafficDistance: 280,
    hudFps: 15,
  },
  ultra: {
    label: "极致",
    hint: "高端显卡 / 大屏",
    renderScale: 1,
    maxPixelRatio: 2,
    renderDistance: 1600,
    shadows: true,
    shadowMapSize: 4096,
    shadowDistance: 130,
    bloom: true,
    pedestrians: 300,
    pedestrianDistance: 200,
    traffic: 54,
    trafficDistance: 420,
    hudFps: 20,
  },
};

// 数值项的取值范围（滑杆与外部写入共用，防止 localStorage 里的脏值炸掉渲染）
const LIMITS = {
  renderScale: [0.5, 1],
  maxPixelRatio: [0.75, 2],
  renderDistance: [150, 2000],
  shadowMapSize: [512, 4096],
  shadowDistance: [40, 200],
  pedestrians: [0, MAX_PEDESTRIANS],
  pedestrianDistance: [30, 400],
  traffic: [0, MAX_VEHICLES],
  trafficDistance: [60, 800],
  fpsCap: [0, 144],
  hudFps: [5, 30],
};

const presetValues = (name) => {
  const { label, hint, ...rest } = PRESETS[name];
  return rest;
};

export const DEFAULT_SETTINGS = {
  ...presetValues("high"),
  preset: "high",
  fpsCap: 0, // 0 = 不限帧（跟随显示器）
};

// 档位名 + 所有可调项；单项被改动后 preset 记为 "custom"
const PRESET_KEYS = Object.keys(presetValues("high"));

let current = load();

function clamp(key, v) {
  const lim = LIMITS[key];
  if (!lim) return v;
  return Math.min(lim[1], Math.max(lim[0], v));
}

function sanitize(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== "object") return out;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (raw[key] === undefined) continue;
    const def = DEFAULT_SETTINGS[key];
    if (typeof def === "number") {
      const n = Number(raw[key]);
      if (Number.isFinite(n)) out[key] = clamp(key, n);
    } else if (typeof def === "boolean") {
      out[key] = !!raw[key];
    } else if (key === "preset") {
      out.preset = raw.preset === "custom" || PRESETS[raw.preset] ? raw.preset : DEFAULT_SETTINGS.preset;
    }
  }
  return out;
}

function load() {
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    if (!raw && localStorage.getItem(LEGACY_STORAGE_KEY)) {
      raw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (raw) localStorage.setItem(STORAGE_KEY, raw); // 一次性迁移到新键
    }
    if (!raw) return { ...DEFAULT_SETTINGS };
    return sanitize(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* 隐私模式 / 存储已满：忽略，设置仅在本次会话生效 */
  }
}

const listeners = new Set();

function commit(next) {
  current = sanitize(next);
  save();
  for (const fn of listeners) {
    try {
      fn(current);
    } catch (e) {
      console.warn("[render-settings] listener failed:", e);
    }
  }
  return current;
}

export function getRenderSettings() {
  return current;
}

/**
 * 局部更新设置（单项滑杆/开关）。返回更新后的完整设置。
 * 若改动项与当前档位不一致，档位标记为 custom。
 */
export function updateRenderSettings(patch) {
  const next = { ...current, ...patch };
  if (patch.preset === undefined) {
    const p = PRESETS[current.preset];
    const matched = p && PRESET_KEYS.every((k) => next[k] === p[k]);
    if (!matched) next.preset = "custom";
  }
  return commit(next);
}

export function applyPreset(name) {
  if (!PRESETS[name]) return current;
  return commit({ ...current, ...presetValues(name), preset: name });
}

export function resetRenderSettings() {
  return commit({ ...DEFAULT_SETTINGS });
}

/** 订阅设置变化；返回取消订阅函数。 */
export function onRenderSettingsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
