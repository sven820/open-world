// 广告牌内容渲染接口（解耦层 2）。
//
// 渲染器只消费「已解析素材地址」的规范化 content item，不关心素材来自编辑器、
// 后台素材库还是模型工坊资产。新增渲染方式 = 往 RENDERERS 里注册一项，
// 内容层 / 模型层 / 后台都不用改。
//
// 渲染器契约：
//   { id, label, test(item, env), create(item, env) }
//   env = { W, H, aspect, ctx, cfg, make2d(it,w,a) }
//   返回统一 item 接口：{ texture, update?, setActive?, setAudio?, dispose?, is3d? ... }

import { make3dContent, make3dPlaceholder } from "./content3d.js";

// 屏位级内容渲染策略（内容配置 sourceType，见 contentConfig.js）
//   auto      按素材自身属性决定（存量行为）
//   flat      强制 2D 平面（3D 素材平贴退化）
//   3d-static 3D 静态素材离轴渲染（需 corner3d 屏 + 离轴上下文）
export const SOURCE_TYPES = {
  auto: "自动（按素材）",
  flat: "2D 平面渲染",
  "3d-static": "3D 静态渲染（离轴）",
};

export const RENDERERS = [
  {
    id: "offaxis-3d",
    label: "3D裸眼离轴渲染",
    test(item, env) {
      const forceFlat = env.cfg && env.cfg.sourceType === "flat";
      const force3d = env.cfg && env.cfg.sourceType === "3d-static";
      const want3d = force3d || item.type === "model3d" || item.is3d === true;
      return !!env.ctx && !item.flat && !forceFlat && want3d;
    },
    create(item, env) {
      return make3dContent(item, env.W, env.H, env.aspect, env.ctx, env.cfg && env.cfg.d3, () => env.make2d(item));
    },
  },
  {
    id: "flat-3d",
    label: "3D素材平贴退化",
    test(item, env) {
      if (item.type !== "model3d") return false;
      const forceFlat = env.cfg && env.cfg.sourceType === "flat";
      return !env.ctx || item.flat === true || forceFlat;
    },
    create(item, env) {
      return make3dPlaceholder(item, env.W, env.H);
    },
  },
];

// 默认渲染器：2D 程序化 / 图片 / 视频 / 字幕 / 时钟，由 contentSource.js 的 make2d 实现
const FALLBACK = { id: "2d-canvas", label: "2D 平面渲染" };

export function resolveRenderer(item, env) {
  for (const r of RENDERERS) if (r.test(item, env)) return r;
  return FALLBACK;
}

export function listRenderers() {
  return [FALLBACK, ...RENDERERS].map(({ id, label }) => ({ id, label }));
}

/** 注册自定义渲染器（放在最前，优先匹配）。返回注销函数。 */
export function registerRenderer(renderer) {
  RENDERERS.unshift(renderer);
  return () => {
    const i = RENDERERS.indexOf(renderer);
    if (i >= 0) RENDERERS.splice(i, 1);
  };
}
