// 广告牌素材内容源层（解耦层 3）。
//
// 内容配置只声明「从哪拿素材」(sourceRef) ，不写死素材地址；
// 渲染层（contentSource.js / content3d.js）只认最终 url/text，不关心素材来自哪。
// 本模块在两者之间做同步解析，保证运行时建池仍是同步的。
//
//   item.source = { kind: "inline" }                   直接填地址 / 文字（默认，兼容存量）
//   item.source = { kind: "admin", id: "media_xxx" }   后台素材库 ID（后台内容源管理推送目录）
//   item.source = { kind: "asset", id: "asset_xxx" }   模型工坊资产 ID（GLB 素材）
//
// 解析结果只覆盖 url / fallback / 3D 标志，不改 item.type —— 显示形态仍由内容配置决定。

export const SOURCE_KINDS = {
  inline: { label: "直接地址（内置）", hint: "URL / 文字直接写在内容配置里" },
  admin: { label: "后台素材库", hint: "按素材 ID 引用后台「素材库」里的图片 / 视频 / 3D 模型" },
  asset: { label: "模型工坊资产", hint: "按资产 ID 引用资产库里的 GLB 模型" },
};

const _catalogs = {
  admin: new Map(),  // id → media 记录（由 adminClient 从后台拉取）
  asset: new Map(),  // id → { url, name, ... }（由编辑器/运行时预热时注册 objectURL）
};

const _providers = {
  inline: () => null, // 无需解析：item.url / item.text 已是最终值
  admin: (ref) => _catalogs.admin.get(ref.id) || null,
  asset: (ref) => _catalogs.asset.get(ref.id) || null,
};

/** 注册/替换 provider（扩展新内容源只需一行，不动渲染层）。 */
export function registerSourceProvider(kind, resolveFn) {
  _providers[kind] = resolveFn;
}

/** 后台下发素材目录 → 本地目录缓存（adminClient 调用）。 */
export function setSourceCatalog(kind, list) {
  const map = _catalogs[kind];
  if (!map) return 0;
  map.clear();
  for (const m of (list || [])) if (m && m.id) map.set(m.id, m);
  return map.size;
}

/** 注册单个资产素材的可用地址（objectURL / http URL）。 */
export function registerAssetSource(id, url, meta = {}) {
  if (!id || !url) return;
  _catalogs.asset.set(id, { url, ...meta });
}

export function listSourceCatalog(kind) {
  const map = _catalogs[kind];
  return map ? [...map.values()] : [];
}

export function getSourceItem(kind, id) {
  const map = _catalogs[kind];
  return (map && map.get(id)) || null;
}

/** 单条目 sourceRef → 具体素材字段。找不到目录项时保留原 url（不黑屏）。 */
export function resolveItemSource(item) {
  const ref = item && item.source;
  if (!ref || !ref.kind || ref.kind === "inline") return item;
  const provider = _providers[ref.kind];
  const media = provider && provider.resolve ? provider.resolve(ref) : provider && provider(ref);
  if (!media) return item;
  const out = { ...item };
  if (media.url) out.url = media.url;
  if (media.fallback) out.fallback = media.fallback;
  // 素材库的 3D 勾选 → 渲染层据此选离轴渲染器（item 自身显式设置优先）
  if (item.is3d === undefined && media.is3d !== undefined) out.is3d = media.is3d;
  if (media.depth !== undefined && out.depth === undefined) out.depth = media.depth;
  if (media.flat !== undefined && out.flat === undefined) out.flat = media.flat;
  return out;
}

/** 整份内容配置解析（建内容池前调用，同步）。 */
export function resolveContentSources(cfg) {
  if (!cfg || !Array.isArray(cfg.items)) return cfg;
  return { ...cfg, items: cfg.items.map(resolveItemSource) };
}

/** 把已解析的 url 回写为 sourceRef 快照，供存量配置迁移 / 后台发布使用。 */
export function withSourceRef(item, kind, id) {
  return { ...item, source: { kind, id } };
}
