# ADR-0003：地图地形高度场（heightfield）架构

日期：2026-11-18 · 状态：已采纳

## 背景

walkstreet 的世界此前是纯平面：地图数据只有 `pos:[x,z]` 二维坐标，所有元素
（建筑/道路/树木/路灯/玩家/车辆）y 恒为 0。3D 编辑器需要三种地形高模式：
随机地形、真实地形（卫星底图叠加）、自定义笔刷雕刻，且要求任何元素不陷入
地下、不飘在空中。

## 决策

1. **单一高度权威 = 规则网格高度场**（`walkstreet/src/world/terrain.js`）：
   地图数据新增可选字段 `terrain = { mode, step, x0, z0, cols, rows, heights[], originH }`，
   覆盖地图范围包围盒（默认 40m 步距，网格单边上限 220 自动放大步距）。
   任意点高度用双线性插值实时求出（`terrainHeightAt`）；地图无 `terrain` 字段
   = 平面，所有 API 返回 0，旧地图零迁移兼容（schema v2 不变，字段可选）。
2. **物件不存 y**：所有静态内容数据仍只存 `pos(x,z)`，渲染高度一律现场采样
   高度场。运行时建城收尾对整棵 city.group 做一次性逐顶点位移
   （`displaceGroup`），道路/河流在有地形时按 20m 重采样保证顶点密度；
   树/路灯/模型资产几何与模板缓存共享，改为按落点整体抬升并打
   `terrainRoot` 标记跳过顶点位移（防止污染共享几何）。
   改地形 → 重新保存/重建即全部重新落地，从机制上杜绝悬空/入地。
3. **真实地形 = Cesium 高程采样**（`walkstreet/src/ui/editor3d/terrain.js`）：
   数据源复刻 uav-inspection 的回退链 —— ArcGIS 全球地形
   （elevation3d.arcgis.com .../Terrain3D/ImageServer，免 key）优先，
   Cesium Ion World Terrain 兜底（需 `VITE_CESIUM_ION_TOKEN`），均不可达时
   优雅提示并保持平面。采样用 `sampleTerrainMostDetailed` 按网格点取椭球高；
   heights 存椭球高（与 Cesium 地形渲染同基准），采样成功后把同一 provider
   挂到编辑器底图 Cesium 球上，卫星影像贴合真实起伏，与 three.js 地形网格
   严丝合缝。随机/自定义模式则恢复椭球平面（高度与平铺影像对齐）。
4. **动态实体贴地**：玩家 `_groundHeightAt` 以高度场为基准叠加道路/平台偏移；
   车辆 `y = 0.02 + terrainHeightAt`；广告大屏基座按落点抬升。

## 被否决的备选

- **逐物件存 y / baseY 字段**：改地形后要批量回写、易漂移，放弃（保留
  baseY 仅作为描边行道树等程序化微调偏移，语义不变）。
- **直接启用 Cesium Globe 渲染世界**：与 three.js 主渲染管线冲突，放弃；
  Cesium 仅在编辑器底图层挂地形 provider，游戏世界仍是 three.js。
- **三角网 TIN / per-object 支撑柱**：复杂度不成比例，规则网格 + 双线性
  插值在 40m 步距下已满足街区尺度需求。

## 已知限制

- 取面路（closed）与多边形地图范围底板为整体三角化，内部顶点稀疏，陡峭
  地形上大块面路会出现跨坡直线插值（建议取面路用在缓坡区）。
- 程序化楼体/街区平台是大盒子（8 角点采样），坡地上块中段会有米级偏差
  （角点贴地、底面随地形轻微变形，不会整体悬空）；游戏世界两块大地面
  （外围 + 路网沥青）有地形时强制细分到 ~50-60m 网格，逐顶点贴地。
- 相机遮挡碰撞体顶高未叠加地形（相机遮挡判定略保守）。

## 影响

- 地图 JSON 体积：+heights 数组（4000m/40m ≈ 10k 数值 ≈ 80KB，localStorage 可承受）。
- 建城耗时：+一次全组顶点位移（<100ms 量级，一次性）。
