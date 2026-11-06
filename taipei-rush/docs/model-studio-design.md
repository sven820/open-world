# 模型资产编辑器（Model Studio）设计方案

> 目标链路：**描边建筑 / GLB / 自建模 → 模型资产库 → 3D 地图编辑器一键引用**。
> 让"设计一个模型"和"在地图上用这个模型"彻底解耦。

---

## 0. 链路总览

```
┌─────────────────────────────────────────────────────────────────┐
│                        模型资产库（IndexedDB）                     │
│   资产 = 几何（GLB 二进制）+ 材质绑定（材料库 id）+ 元数据/缩略图      │
└───────▲───────────────────────────────────────┬─────────────────┘
        │ 存/改                                  │ 引用（只存 assetId）
┌───────┴───────────┐                  ┌────────▼────────────────┐
│  Model Studio     │                  │  3D 地图编辑器            │
│  （新模块，独立页签）│ ──「转为资产」──→ │  objects 新类型 "asset"  │
│  查看/编辑/导入/建模 │ ←─「送来编辑」─── │  { assetId, pos, rot,   │
└───────▲───────────┘                  │   scale, matOverrides } │
        │ 「转为资产」                    └────────┬────────────────┘
┌───────┴───────────┐                           ▼ 运行时
│  3D 地图编辑器      │                  customMap.js 按资产重建
│  描边建筑一键入袋   │                  mesh + ColliderGrid AABB
└───────────────────┘
```

三个入口、一个出口：

1. **描边建筑 → 资产**：3D 地图编辑里画的楼，一键"转为资产"，进 Studio 重新设计（加屋顶、开洞、换材质），存回后地图上的引用自动更新；
2. **GLB → 资产**：Blender 建的模型导入 Studio，绑材料库材质、定原点/碰撞，存为资产；
3. **Studio 内建模**：参数几何体拼装（盒/柱/挤出/布尔），轻量自建模；
4. **出口唯一**：3D 地图编辑器的物件面板多一个"我的模型"分类，点一下放到地图上。

---

## 1. 数据模型：资产（Asset）

### 1.1 资产记录（JSON，存 IndexedDB `assets` 表）

```js
{
  id: "asset_abc123",
  name: "骑楼商住楼",
  category: "building",        // building | prop | vehicle | custom
  tags: ["骑楼", "商住"],
  createdAt / updatedAt,

  source: "glb" | "traced" | "studio",   // 来源
  // —— 几何来源三选一 ——
  glb: Blob,                    // source=glb/studio：整包 GLB 二进制（自包含）
  traced: {                     // source=traced：描边建筑数据直存（无需 GLB）
    footprint: [[x,z],...], height: 24, style: "extrude",
  },

  // —— 材质绑定：网格名/材质名 → 标准材料库 id ——
  materialBindings: {
    "facade_brick": "facade:brick-red",     // 按 GLB 内材质名匹配
    "mat_roof": "roof:concrete",
    "*": "surface:concrete",                // 兜底
  },

  // —— 放置约定（地图编辑器用）——
  pivot: "base-center",         // 放置锚点：base-center（落地中心，默认）| origin | custom
  collider: { mode: "aabb" },   // 碰撞：aabb（包围盒）| box(手调) | none
  unitSize: { x: 12, y: 24, z: 10 },  // 原始包围盒，供缩放参考
  thumb: Blob,                  // 缩略图（png，资产面板展示）
}
```

**关键设计：几何与材质分离。** GLB 里只带几何 + 占位材质（命名如 `mat_facade_brick`），
导入/保存时按 `materialBindings` 换成标准材料库的共享实例（`materials.js`）。
好处：改一次库材质全城生效；GLB 体积小；draw call 可控。

### 1.2 地图上的引用（`map.objects` 新类型）

```js
{
  id: uid(), type: "asset",
  assetId: "asset_abc123",      // 只存引用，不存几何
  pos: [x, z], rot: 0, scale: 1,
  matOverrides: {},             // 可选：本实例覆盖个别材质（同一资产换肤）
}
```

地图 JSON 依旧轻量（localStorage 无压力），二进制只进 IndexedDB。

---

## 2. 存储层：`src/data/assetStore.js`

新建，对齐 `mapStore.js` 的风格（读写 API + 迁移），但底层换 **IndexedDB**（GLB 动辄几 MB，localStorage 5MB 上限装不下）：

```js
// 库：modelStudio（两个 object store）
//   assets  — 资产记录（含 glb Blob 与 thumb Blob）
//   meta    — 版本号/迁移标记
export function listAssets({ category, keyword })   // 资产面板
export function getAsset(id)                        // 地图编辑器/运行时取
export function putAsset(asset)                     // 新建/更新
export function deleteAsset(id)
export function saveAssetThumb(id, blob)
export function importAssetFromGLB(file)            // GLB → 解析 → 材质名提取 → 建记录
export function exportAssetGLB(id)                  // 导出备份/分享
```

> IndexedDB 的 Blob 直接可存；打开 DB 失败（隐私模式等）降级为"内存 + 不持久化"并在 UI 提示。

---

## 3. Model Studio：新编辑器模块

### 3.1 定位与形态

- 独立入口（主菜单加"模型工坊"页签），复用引擎初始化套路（参照 mapEditor3d 的 scene/camera/orbit/tc 结构）；
- **单模型工作台**：一次编辑一个资产，场景 = 地面网格 + 该模型，不带城市。

### 3.2 功能分层（按里程碑实现）

| 层级 | 功能 | 技术点 |
|---|---|---|
| **P0 查看/管理** | 资产库面板（网格卡片+缩略图+搜索）、导入 GLB、预览（转台/线框/包围盒）、删除导出 | `GLTFLoader`、`assetStore`、canvas 截图出缩略图 |
| **P1 材质绑定** | 左侧场景树（GLB 节点树），点选 mesh → 右侧"材质槽"下拉（`listMaterials()` 全部 41 槽）→ 实时换库材质；绑定结果写 `materialBindings` | raycaster 拾取（加 `three-mesh-bvh` 加速）、共享材质直接赋值 |
| **P1 放置约定** | 设原点（base-center 对齐地面）、看包围盒尺寸、试拖到"模拟地面"预览落地效果 | TransformControls（已在用） |
| **P2 参数建模** | 添加基本体（盒/圆柱/挤出多边形）、移动旋转缩放、成组；描边建筑的"重新设计"= 把 footprint 挤出体拆成可编辑轮廓 + 零件 | 参数几何 + TransformControls，沿用描边建筑的生成公式保证外观一致 |
| **P3 进阶** | 布尔（开窗挖洞，`three-bvh-csg`）、镜像/阵列、简单 UV 调整 | 引入 CSG 库 |
| **P3 描边建筑互通** | 「转为资产」：把 `type:"building"` 的 footprint+height+材质打包成资产；编辑保存后**可选**回写原描边建筑（继续用轻量数据）或地图上换成 asset 引用 | 见 §5 |

### 3.3 保存格式

- **source=glb / studio**：把工作台场景（几何 + 占位材质名）用 `GLTFExporter` 导出为 GLB Blob 存库——资产自带完整几何，未来可导出分享/给 Blender 二次加工；
- **source=traced**：保留描边数据直存（挤出公式运行时算），体积最小；一旦在 Studio 里"破坏性编辑"（加了零件/布尔），自动升级为 GLB 存储。

---

## 4. 3D 地图编辑器接入

### 4.1 放置（mapEditor3d.js）

- 工具栏加"我的模型"面板：网格卡片列出资产（缩略图）→ 单击进入放置模式 → 地面点击落位（复用 place-tree 的幽灵跟随 + 吸附逻辑）；
- 放下的对象 `type:"asset"`，选中后 Gizmo 平移/旋转/缩放（复用现有 object wrapper 全套：拾取、高亮框、undo、Delete）；
- 属性面板：assetId 只读 + 缩放 + "编辑此资产"按钮（跳转 Studio 并载入）。

### 4.2 预览网格（editor3d/meshes.js）

```js
buildAssetMesh(assetRecord)  // GLTFLoader.parse(assets.glb) → 遍历节点
                             // 按材料库 materialBindings 替换材质
                             // 按 pivot 把根节点对齐到 base-center
```

加载结果按 assetId **缓存**（同一资产放 50 个实例共享同一几何/材质，只做 Transform 差异）。

### 4.3 运行时（customMap.js）

- `objects` 遍历加 `type === "asset"` 分支：`getAsset(assetId)` → 同样的 buildAssetMesh 逻辑 → 加入描边内容 group；
- 碰撞：`collider.mode === "aabb"` 时按放置变换算包围盒注册（复用 footprintAABB 思路）；
- **程序化建筑避让**：`city.js` 构造时把 asset 对象的 AABB 也并入 `traceBuildingRects`（现成的排除区机制，零新逻辑）；
- 材质若含 `facade:/storefront:/sign:` 库材质 → 夜间灯光自动跟随（共享实例的既有红利）。

---

## 5. 描边建筑 ↔ Studio 双向打通

**地图 → Studio（转为资产）**
1. 选中描边建筑 → 属性面板"转为模型资产"；
2. 打包：footprint 挤出几何（同一公式）+ 当前 wall/roof 材质绑定 → `putAsset(source:"traced")`；
3. Studio 打开即见，可继续加屋顶水塔、门廊（此时升级为 GLB 存储）。

**Studio → 地图（两种归宿，用户选）**
- **替换式**：原描边建筑 objects 项升级为 `type:"asset"` 引用（地图数据仍轻量，Studio 里改模型地图自动变）；
- **新建式**：原建筑保留，资产作为新物件另放。

---

## 6. 新增/改动文件清单

```
src/
├─ data/
│  └─ assetStore.js          ★ 新：IndexedDB 资产库（含 GLB 解析/导出助手）
├─ studio/                   ★ 新：Model Studio 模块
│  ├─ studio.js              主类（场景/相机/控制/循环，参照 mapEditor3d 初始化）
│  ├─ assetPanel.js          资产库面板（卡片/搜索/导入/删除）
│  ├─ sceneTree.js           GLB 节点树 + 点选
│  ├─ materialBinding.js     材质槽绑定 UI（listMaterials 下拉 → materialBindings）
│  └─ primitives.js          P2 参数建模工具（基本体/挤出/成组）
├─ ui/
│  ├─ mapEditor3d.js         改：物件面板加"我的模型"；type:"asset" 的 wrapper/放置/属性
│  └─ editor3d/meshes.js     改：buildAssetMesh（GLB→库材质→锚点对齐），实例缓存
├─ world/
│  ├─ customMap.js           改：objects 渲染加 asset 分支 + 碰撞注册
│  └─ city.js                改：traceBuildingRects 并入 asset AABB（1 处循环）
└─ main.js                   改：入口页签（游戏 / 2D 编辑 / 3D 地图编辑 / 模型工坊）
```

依赖新增：`three-mesh-bvh`（P1 拾取加速）、`three-bvh-csg`（P3，可后置）。GLTF 的 Loader/Exporter three 自带。

---

## 7. 实施路线图

| 里程碑 | 交付物 | 验收标准 |
|---|---|---|
| **M1 资产库 + 查看器** | assetStore(IndexedDB)、GLB 导入、资产面板、预览、缩略图 | 导入一个 Blender GLB，重启浏览器资产还在，能删能导出 |
| **M2 材质绑定 + 地图引用** | 材质槽绑定 UI、buildAssetMesh、地图放置/Gizmo/undo、运行时渲染+碰撞 | Blender 楼模型放上地图，夜里窗户亮（绑了 facade 槽），玩家撞不穿 |
| **M3 描边建筑互通** | "转为资产"、Studio 内编辑描边楼、替换式回写 | 描边楼进 Studio 加个屋顶水箱，地图上原位置模型自动更新 |
| **M4 参数建模** | 基本体拼装/成组/挤出编辑，保存为 GLB 资产 | 不依赖 Blender 也能从零捏一个公交站并放上地图 |
| **M5 进阶（可选）** | CSG 开洞、阵列镜像、资产导出分享 | — |

建议顺序严格 M1→M4：**存储和链路先通，建模能力后加**——M2 完成时"GLB 进、地图用"的主链路就已闭环。

---

## 8. 关键技术决策记录

1. **几何存 GLB Blob 而非 JSON 化 geometry**：自包含、可导出给 Blender、GLTFExporter 现成；
2. **材质不进资产文件**：只存材料库 id 绑定表——全城材质一致 + 夜间灯光免费获得 + 换肤成本低；
3. **地图只存 assetId 引用**：地图 JSON 保持 localStorage 友好；同一资产多实例共享几何与 draw call；
4. **碰撞用 AABB 起步**：与现有 ColliderGrid 语义一致，够用且零成本；后续要"斜坡可走"再考虑凸包；
5. **Studio 复用 mapEditor3d 骨架**：不引 React/three-drei 框架，团队已有代码风格延续，TransformControls/拾取/undo 全套现成；
6. **降级策略**：IndexedDB 不可用时内存兜底 + 明确提示，不阻塞游戏本体。
