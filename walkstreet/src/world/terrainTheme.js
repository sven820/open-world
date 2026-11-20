// 地表主题（terrain.theme）：地形表面配色 + 坡地岩石/雪线自动规则。
// 设计见 docs/design/terrain-theme.md。
//
// 渲染模型：最终颜色 = 基础纹理（textures.js 按主题出图，只提供地表颗粒质感）
// × 顶点色（本模块 shadeTerrainVertex：高度明暗 + 坡地岩石 + 雪线）。
// 编辑器地形板（mapEditor3d._shadeTerrainPlate）与运行时主地面（city._buildGround）
// 共用同一实现，保证两端观感一致。
//
// 主题可拓展：新增主题 = TERRAIN_THEMES 加一条 + textures.js GROUND_PAINTERS 加一个
// painter（v2 材质笔刷的 splat 权重可把 shadeTerrainVertex 平移为「自动填充权重」）。
// 不依赖 three：颜色一律 [r,g,b] 0~1 数组，调用方自行写入 color attribute。

import { ensureTerrain } from "./terrain.js";

// 各主题参数（颜色为 0xRRGGBB，阈值单位：坡度比 1≈45°，海拔米）：
//  low/high   高度明暗色带（低处→高处）
//  slope      岩石色 + slopeStart/slopeFull 过渡区间（坡度比）
//  snow       雪色 + snowFrom 雪线海拔 + snowBlend 过渡带（0 = 无雪线）
//  outer      运行时远景底板（主地面之外的环形）颜色
export const TERRAIN_THEMES = {
  city: {
    label: "城市",
    low: 0x242f3b, high: 0xa7b4c2, // 沿用编辑器旧色带（蓝灰明暗），旧地图观感不变
    slope: 0x565e6a, slopeStart: 0.55, slopeFull: 0.95,
    snow: 0, snowFrom: 0, snowBlend: 60,
    outer: 0x2c322c,
  },
  grass: {
    label: "草地",
    low: 0x39602f, high: 0xa3b868,
    slope: 0x6e6a62, slopeStart: 0.45, slopeFull: 0.8,
    snow: 0xe9edf0, snowFrom: 3000, snowBlend: 60,
    outer: 0x2c3a2e,
  },
  rock: {
    label: "岩石",
    low: 0x5d5348, high: 0xb9b3a6,
    slope: 0x49433b, slopeStart: 0.4, slopeFull: 0.7,
    snow: 0xe9edf0, snowFrom: 3200, snowBlend: 60,
    outer: 0x32302c,
  },
  desert: {
    label: "沙漠",
    low: 0xbf9d5b, high: 0xe6d096,
    slope: 0x8a6f4a, slopeStart: 0.5, slopeFull: 0.9,
    snow: 0, snowFrom: 0, snowBlend: 60,
    outer: 0x4a3f2c,
  },
};

export const TERRAIN_THEME_DEFAULT = "city";
export const TERRAIN_THEME_IDS = Object.keys(TERRAIN_THEMES);

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rgb = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
const SNOW_RGB = rgb(0xe9edf0); // 雪色（面板强制开雪线时，无雪主题也用这个白）

// 地图 terrain 的主题键（旧地图/非法值兜底 city）
export function themeOf(t) {
  return t && TERRAIN_THEMES[t.theme] ? t.theme : TERRAIN_THEME_DEFAULT;
}

// 雪线生效配置：terrain.snowOn / terrain.snowFrom（面板可调，写入地图数据）
// 未设置时跟随主题默认（草地/岩石有雪线，城市/沙漠无）。
// 雪线海拔下限 3000m：真实雪线在海拔 3000m 以上（阿尔卑斯 ~3000m、青藏高原 ~5000m），
// 旧地图存的更低值也按 3000 生效（显示/着色统一走这里钳制）
export const SNOW_FROM_MIN = 3000;
export const SNOW_FROM_MAX = 8000;
export function snowDefaultsOf(t) {
  const th = TERRAIN_THEMES[themeOf(t)];
  const raw = t && Number.isFinite(t.snowFrom) ? Math.round(t.snowFrom) : (th ? th.snowFrom : 0);
  return {
    snowOn: t && t.snowOn != null ? !!t.snowOn : !!(th && th.snow),
    snowFrom: Math.max(SNOW_FROM_MIN, Math.min(SNOW_FROM_MAX, raw || SNOW_FROM_MIN)),
  };
}

// 预转换色表（模块加载时一次性）
for (const th of Object.values(TERRAIN_THEMES)) {
  th._low = rgb(th.low); th._high = rgb(th.high); th._slope = rgb(th.slope);
  th._snow = th.snow ? rgb(th.snow) : null;
}

// 坡度 = 高度场有限差分梯度（dH/dx、dH/dz 的模，1 ≈ 45°）。
// 刻意只读原始 heights 网格：不含道路走廊塑形/建筑地基 pad —— 着色是视觉规则，
// 不必贴路面；且 O(1) 纯查表，_shadeTerrainPlate 逐顶点调用无采样开销。
export function terrainSlopeAt(map, x, z) {
  const t = ensureTerrain(map);
  if (!t) return 0;
  const { x0, z0, cols, rows, step, heights } = t;
  const fx = Math.min(Math.max((x - x0) / step, 0), cols - 1.001);
  const fz = Math.min(Math.max((z - z0) / step, 0), rows - 1.001);
  const i = Math.floor(fx), j = Math.floor(fz);
  const tx = fx - i, tz = fz - j;
  const r0 = j * cols + i, r1 = r0 + cols;
  const gx = lerp(heights[r0 + 1] - heights[r0], heights[r1 + 1] - heights[r1], tz) / step;
  const gz = lerp(heights[r1] - heights[r0], heights[r1 + 1] - heights[r0 + 1], tx) / step;
  return Math.hypot(gx, gz);
}

// 顶点着色（写入 out[0..2]，0~1 线性 RGB）。
// ctx = { isReal, hMn, span, base, scale }（编辑器/运行时各自算好传入）：
// 高度明暗逻辑与旧编辑器实现逐位一致 —— custom 按基础高度锚定（0.85 基准，
// 对比度随高差自适应、最小 60m 满量程），real 低点锚定，全平固定 0.85 中间调。
export function shadeTerrainVertex(themeKey, h, slope, ctx, out) {
  const th = TERRAIN_THEMES[themeKey] || TERRAIN_THEMES[TERRAIN_THEME_DEFAULT];
  const span = ctx.span;
  const t = span > 0.5
    ? (ctx.isReal ? clamp01((h - ctx.hMn) / span) : clamp01(0.85 + (h - ctx.base) / ctx.scale))
    : 0.85;
  let r = lerp(th._low[0], th._high[0], t);
  let g = lerp(th._low[1], th._high[1], t);
  let b = lerp(th._low[2], th._high[2], t);
  const sw = clamp01((slope - th.slopeStart) / (th.slopeFull - th.slopeStart));
  if (sw > 0) {
    r = lerp(r, th._slope[0], sw);
    g = lerp(g, th._slope[1], sw);
    b = lerp(b, th._slope[2], sw);
  }
  if (ctx.snowOn && h > ctx.snowFrom) {
    const w = clamp01((h - ctx.snowFrom) / th.snowBlend) * 0.9; // 封顶 0.9，保留一点地表质感
    const sc = th._snow || SNOW_RGB; // 无雪主题强制开雪线 → 白雪兜底
    r = lerp(r, sc[0], w);
    g = lerp(g, sc[1], w);
    b = lerp(b, sc[2], w);
  }
  out[0] = r; out[1] = g; out[2] = b;
  return out;
}

// 着色上下文公共片段：编辑器/运行时从 terrain 高度场算 min/max 与锚定参数；
// 雪线开关/海拔按 terrain.snowOn / terrain.snowFrom（面板可调），未设跟随主题默认
export function shadeCtxFor(t) {
  let hMn = Infinity, hMx = -Infinity;
  if (t) for (const h of t.heights) { if (h < hMn) hMn = h; if (h > hMx) hMx = h; }
  const span = hMx - hMn;
  return {
    isReal: !!(t && t.mode === "real"),
    hMn,
    span,
    base: t && Number.isFinite(t.baseHeight) ? t.baseHeight : 0,
    scale: Math.max(60, span),
    ...snowDefaultsOf(t),
  };
}
