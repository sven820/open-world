/* ---------------- 广告大屏 · 内容配置数据契约 ----------------
 * 编辑器的「编辑显示内容」页面与游戏运行时共用这份定义。
 * 数据存于 billboard.params.content；不配置 = 使用默认节目单。
 *
 * 条目 type：
 *   ad      内置广告（程序化生成，自动按屏比排版）
 *   text    滚动字幕（文字自动按屏比缩放，不裁切）
 *   clock   时钟信息（字号按屏宽自适应，不裁切）
 *   image   图片 URL（可选显示模式）
 *   video   视频 URL（mp4/webm，可选显示模式）
 *   stream  直播流 URL（HLS/m3u8 经 hls.js，低延迟模式）
 *   model3d GLB 3D 模型（离轴投影 3D 裸眼；仅 3D转角包柱屏生效，URL 空 = 内置演示）
 *
 * fit 显示模式（仅图片/视频/直播有效；文字类永远自动排版）：
 *   auto    完整显示且按屏比自适应（等价 contain，推荐）
 *   contain 等比完整显示，两侧留黑边
 *   cover   等比铺满屏面，裁掉超出部分
 *   stretch 拉伸铺满（可能变形）
 *
 * 全局：transition 轮播交叉淡入秒数；audio 音频策略；fallback 备用海报。
 ---------------------------------------------------------------------- */

export const FIT_MODES = {
  auto: "自适应（完整显示）",
  contain: "完整显示（留黑边）",
  cover: "铺满裁切",
  stretch: "拉伸铺满（可能变形）",
};

export const AUDIO_MODES = {
  off: "静音（推荐）",
  nearest: "仅最近一块屏出声",
  on: "全部出声",
};

export const CONTENT_TYPES = {
  ad: { label: "内置广告", media: false, hint: "程序化品牌广告，按屏比自动排版" },
  text: { label: "滚动字幕", media: false, hint: "文字按屏比自动缩放，循环滚动，不会裁切" },
  clock: { label: "时钟信息", media: false, hint: "时钟/日期按屏宽自适应，不会裁切" },
  image: { label: "图片", media: true, hint: "http(s) 图片地址；跨域图片需服务端允许 CORS" },
  video: { label: "视频", media: true, hint: "mp4 / webm 直链；远离屏幕时自动暂停解码" },
  stream: { label: "直播流", media: true, hint: "HLS(m3u8) 经 hls.js 低延迟播放；失败自动切备用海报" },
  model3d: { label: "3D裸眼模型", media: true, hint: "GLB 经离轴投影呈现 3D 裸眼；仅 3D转角包柱屏生效，其他屏显示占位提示。留空 / builtin://demo1 = 内置演示1；builtin://demo2 = 演示2（12秒品牌广告）；builtin://calib = 几何校准片；也可填 http(s) 或 /media/ 的 GLB 地址" },
};

/** 屏位级 3D 参数默认值（实验台「遛眼参数 / 显示开关 / 转角弧度」同款，后台屏位绑定可改） */
export const D3_DEFAULTS = {
  depth: 2.5,   // 出屏深度（米，0~10）：contentRoot.position = VC + OUT·depth
  scale: 1,     // 尺寸（0.4~2）：contentRoot.scale
  arc: 0,       // 圆角半径（米，0~5）：0 = 直角共棱；>0 转角过渡成 1/4 圆柱弧
  spin: true,   // 轻微摆动/自转（平面素材板不受此开关影响，永远不转）
  track: true,  // 片源跟随当前视点（实时追踪）；关闭则固定最佳视点
  hud: false,   // 右下角双路预览（管理器叠加层）
  helper: false, // 视线 / 眼位辅助线
};

/** 圆角半径上限（与 cornerArc.js ARC_R_MAX 一致；屏窄时实际上限还会取屏宽一半） */
export const ARC_R_MAX = 5;

export const DEFAULT_TEXT = "潮汇坊 · 中央大道商圈 今日营业至 22:00   ◆   新品上市 全场 8 折起   ◆   周末街头市集 · 梧桐街广场   ◆   ";

export function defaultContent() {
  return {
    fit: "auto",
    transition: 0.6,
    audio: "off",
    items: [
      { type: "ad", duration: 9, seed: 1 },
      { type: "text", duration: 10, text: DEFAULT_TEXT },
      { type: "ad", duration: 9, seed: 2 },
      { type: "ad", duration: 8, seed: 3 },
      { type: "clock", duration: 8, note: "晴 24°C" },
      { type: "ad", duration: 9, seed: 4 },
      { type: "ad", duration: 8, seed: 5 },
      { type: "ad", duration: 9, seed: 6 },
    ],
  };
}

const clamp = (v, min, max, def) =>
  (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def);

/** 规整配置：过滤未知类型/非法字段，保证运行时不会拿到脏数据 */
export function normalizeContent(raw) {
  if (!raw || !Array.isArray(raw.items) || !raw.items.length) return null;
  // 屏位级 3D 参数（仅 3D转角包柱屏消费；后台屏位绑定发布时合并进快照）
  let d3 = null;
  if (raw.d3 && typeof raw.d3 === "object") {
    d3 = {
      depth: clamp(Math.round((+raw.d3.depth || 0) * 10) / 10, 0, 10, D3_DEFAULTS.depth),
      scale: clamp(Math.round((+raw.d3.scale || 0) * 100) / 100, 0.4, 2, D3_DEFAULTS.scale),
      // 转角弧度：0 / 未配置 / 非法值都走直角共棱（老快照没有该字段，行为不变）
      arc: clamp(Math.round((+raw.d3.arc || 0) * 10) / 10, 0, ARC_R_MAX, D3_DEFAULTS.arc),
      spin: raw.d3.spin !== false,
      track: raw.d3.track !== false,
      hud: !!raw.d3.hud,
      helper: !!raw.d3.helper,
    };
  }
  const items = raw.items
    .filter((it) => it && CONTENT_TYPES[it.type])
    .slice(0, 16)
    .map((it) => {
      const out = {
        type: it.type,
        duration: clamp(Math.round(it.duration), 2, 300, 9),
      };
      if (it.type === "text") out.text = String(it.text || DEFAULT_TEXT).slice(0, 400);
      if (it.type === "clock") out.note = String(it.note || "晴 24°C").slice(0, 40);
      if (it.type === "ad") out.seed = clamp(it.seed, 0, 99999, 1);
      // 条目级 3D 属性（来自素材库勾选，发布时合并）：是否 3D 展示 + 出屏深度（米，0~10）。
      // model3d 天然是 3D 内容；普通素材勾选 is3d 也会进离轴管线，游戏端按条目实时切换显示模式。
      const is3d = it.type === "model3d" || it.is3d === true;
      if (it.type === "model3d" || it.is3d !== undefined) out.is3d = is3d;
      if (is3d) {
        out.depth = clamp(Math.round((+it.depth || 0) * 10) / 10, 0, 10, 2.5);
        // 平贴退化（素材属性）：勾选后该条目跳过离轴渲染，按普通平面贴图直接贴屏
        out.flat = it.flat === true;
      }
      if (CONTENT_TYPES[it.type].media) {
        out.url = String(it.url || "").slice(0, 4000).trim();
        out.fallback = String(it.fallback || "").slice(0, 4000).trim();
        out.fit = FIT_MODES[it.fit] ? it.fit : (FIT_MODES[raw.fit] ? raw.fit : "auto");
      }
      return out;
    });
  if (!items.length) return null;
  return {
    fit: FIT_MODES[raw.fit] ? raw.fit : "auto",
    transition: clamp(raw.transition, 0, 2, 0.6),
    audio: AUDIO_MODES[raw.audio] ? raw.audio : "off",
    d3,
    items,
  };
}

/** 稳定哈希：相同配置 + 相同屏比 → 共享同一内容池（d3 参与：3D 参数不同 = 内容不同） */
export function contentKey(cfg, aspect) {
  const s = JSON.stringify([cfg.items, cfg.fit, cfg.audio, cfg.d3 || 0]);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return `${aspect.toFixed(2)}|${cfg.fit}|${h.toString(36)}`;
}

export function scheduleFrom(cfg) {
  return cfg.items.map((it, idx) => ({ idx, duration: it.duration }));
}
