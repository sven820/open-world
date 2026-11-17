// 广告牌模型资产 · 数据层（纯数据，不依赖 three / 渲染层）。
//
// 解耦四层之一：广告牌「模型」本身。
//   - 资产记录只描述屏体（mount + 规格），不含任何内容 / 素材 / 后台信息；
//   - 地图对象只存 { type:"billboard", assetId, pos, rot, hostId?, local? }，
//     几何规格不再内联在地图 JSON 里；
//   - 内容通过 contentRef（内容配置）单独挂接，素材通过 sourceRef 单独引用。
//
// 依赖方向：billboardAsset ← assetStore（CRUD），渲染层见
// src/world/billboard/billboardAssetBridge.js（three 侧，动态 import，保持本层纯净）。

import { putAsset, listAssets, getAsset } from "./assetStore.js";

/* ---------------- 内置四种广告牌资产模板 ---------------- */

// 稳定 id：幂等播种，重启 / 清缓存都不会重复创建。
export const BILLBOARD_ASSET_IDS = {
  standalone: "bb_asset_standalone",
  facade: "bb_asset_facade",
  corner: "bb_asset_corner",
  corner3d: "bb_asset_corner3d",
};

// 四种承载形式 = 四种广告牌模型资产（与 mounts.js 的 MOUNTS 一一对应）。
// 默认值与 mounts.js 的 defaults 保持一致；改这里即可改新放广告牌的初始规格。
// poseYaw = 资产在工坊/缩略图里的展示朝向（弧度），不是放置朝向。
// 转角屏两面朝局部 -Z/-X，转 180° 后正对默认 +X/+Z 机位；其它屏本来朝 +Z 无需转。
// 朝向是资产数据，不是相机代码里的 if —— 以后任何模型都靠这个字段。
export const BILLBOARD_TEMPLATES = [
  { mount: "standalone", name: "独立广告牌", desc: "底座 + 立柱 + 双面屏，可立在路上", spec: { w: 12, h: 7, y: 10, arc: 0 }, screenFaces: 1, poseYaw: 0 },
  { mount: "facade", name: "建筑立面屏", desc: "贴附建筑外墙，进游戏自动贴墙", spec: { w: 14, h: 8, y: 9, arc: 0 }, screenFaces: 1, poseYaw: 0 },
  { mount: "corner", name: "转角包柱屏", desc: "楼角 L 形双面屏，两面可播不同内容", spec: { w: 14, h: 8, y: 13, arc: 0 }, screenFaces: 2, poseYaw: Math.PI },
  { mount: "corner3d", name: "3D转角包柱屏", desc: "楼角一体屏，支持裸眼 3D 离轴内容", spec: { w: 14, h: 8, y: 13, arc: 0 }, screenFaces: 2, poseYaw: Math.PI },
];

const approxSize = (t) => {
  const { w, h, y } = t.spec;
  return {
    x: t.mount === "corner" || t.mount === "corner3d" ? w + 1.4 : w + 0.8,
    y: Math.round((y + h / 2 + 0.6) * 100) / 100,
    z: t.mount === "corner" || t.mount === "corner3d" ? w + 1.4 : 2,
  };
};

/** 幂等播种四种广告牌资产到模型工坊资产库。返回本次新建的资产记录数组。 */
export async function ensureBillboardAssets() {
  const existed = (await listAssets({ category: "billboard" })) || [];
  const byMount = new Map(existed.filter((a) => a && a.billboard).map((a) => [a.billboard.mount, a]));
  const created = [];
  for (const t of BILLBOARD_TEMPLATES) {
    const old = byMount.get(t.mount);
    if (old) {
      // 老资产补齐展示朝向（poseYaw），不必用户手动重建资产
      if (old.poseYaw === undefined || old.poseYaw === null) {
        await putAsset({ ...old, poseYaw: t.poseYaw || 0 });
      }
      continue;
    }
    created.push(await putAsset({
      id: BILLBOARD_ASSET_IDS[t.mount],
      name: t.name,
      category: "billboard",
      tags: ["广告牌", "内置模型", t.name],
      source: "billboard",
      builtin: true,
      poseYaw: t.poseYaw || 0,
      billboard: {
        mount: t.mount,
        spec: { ...t.spec },
        autoSnap: t.mount === "facade",
        screenFaces: t.screenFaces,
      },
      // 机箱 / 边框可绑库材质，屏面永不绑定（每屏独立 screenMaterial 才能播放内容）
      materialBindings: {},
      pivot: "base-center",
      collider: { mode: "aabb" },
      unitSize: approxSize(t),
    }));
  }
  return created;
}

/** 资产记录 → 纯几何规格（编辑器幽灵 / 运行时构建 / 边界都吃这份数据）。 */
export function billboardSpecFromAsset(asset, overrides = null) {
  const b = (asset && asset.billboard) || {};
  const s = b.spec || {};
  return {
    mount: b.mount || "standalone",
    w: s.w, h: s.h, y: s.y, arc: s.arc || 0,
    // 转角屏左右两面可各自设长度；未设时回退到基准屏宽
    wA: s.wA != null ? s.wA : s.w,
    wB: s.wB != null ? s.wB : s.w,
    autoSnap: b.autoSnap !== false,
    screenFaces: b.screenFaces || 1,
    ...(overrides || {}),
  };
}

/** 地图 billboard 对象 → 放置参数（供 buildBillboardGroup / placement 使用）。
 *  新对象读 asset.billboard；老对象（内联 params）原样兼容，不破坏存量地图。 */
export function billboardParamsFor(item, asset) {
  if (asset && asset.billboard) {
    const spec = billboardSpecFromAsset(asset);
    const p = item.params || {};
    // 实例级只覆盖 w/h/y 与贴墙开关；弧度只允许来自资产或后台覆盖
    const o = p.override || {};
    return {
      mount: spec.mount,
      w: o.w != null ? +o.w : spec.w,
      h: o.h != null ? +o.h : spec.h,
      y: o.y != null ? +o.y : spec.y,
      wA: o.wA != null ? +o.wA : spec.wA,
      wB: o.wB != null ? +o.wB : spec.wB,
      arc: spec.arc,
      autoSnap: o.autoSnap != null ? o.autoSnap : spec.autoSnap,
      // 组合挂件：屏作为别的模型的子部件，不生成自带塔体/立柱
      attached: !!(o.attached || p.attached),
      // 内容配置是独立一层，覆盖在模型规格之上（不写回资产）
      content: p.content || null,
    };
  }
  return item.params || {};
}

/** 老式内联 billboard 对象 → 资产记录（「转为模型资产」入口）。 */
export async function createAssetFromBillboard(item, extra = {}) {
  const p = (item && item.params) || {};
  const mount = p.mount || "standalone";
  const t = BILLBOARD_TEMPLATES.find((x) => x.mount === mount) || BILLBOARD_TEMPLATES[0];
  const spec = {
    w: Number.isFinite(+p.w) ? +p.w : t.spec.w,
    h: Number.isFinite(+p.h) ? +p.h : t.spec.h,
    y: Number.isFinite(+p.y) ? +p.y : t.spec.y,
    arc: Number.isFinite(+p.arc) ? +p.arc : 0,
  };
  return putAsset({
    name: extra.name || item.name || `${t.name} · 自定义`,
    category: "billboard",
    tags: ["广告牌", t.name],
    source: "billboard",
    poseYaw: t.poseYaw || 0,
    billboard: {
      mount, spec,
      autoSnap: p.autoSnap !== false,
      screenFaces: t.screenFaces,
    },
    materialBindings: {},
    pivot: "base-center",
    collider: { mode: "aabb" },
    unitSize: approxSize({ mount, spec }),
    ...extra,
  });
}

/** 取资产（带同步缓存填充；BillboardManager 构建期同步读用 getAssetRecordSync）。 */
export async function loadBillboardAsset(id) {
  if (!id) return null;
  return getAsset(id);
}
