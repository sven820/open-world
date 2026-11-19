# ADR-0010 拼接路块横向细分（补齐 ADR-0009 遗漏的一类几何）

日期：2026-11-19 · 状态：已采纳
关联：补完 ADR-0009（其只覆盖 roadRibbon / stripGeometry / fitGeometryToTerrain 的调用，
未覆盖拼接路块的 `rtTileQuadGeometry`）

## 背景

用户反馈：3D 地图编辑器里**拼接路块本身**有锯齿 / 显示不全，且与横纵路交汇处仍不行。
ADR-0009 之后横纵路（roadRibbon）已 2m 细分且验证无顶穿，但拼接路依旧破损。

## 根因（诊断量化）

`temp-diag-tile-cross.mjs` 量化：拼接路 `rtTileQuadGeometry` 每站**只有 ±x 两个顶点**
（横向完全不细分），`fitGeometryToTerrain` 只在这两点采样 `gridHeightAt 8m 格点曲面`，
中间靠 GPU 直线插值。8m 宽路面跨越多个 8m 格点单元时，中间格点峰值从下方顶穿路面，
最大顶穿 **2.5m**（极端地形）、**0.88m**（用户同款振幅）。

而横纵路 roadRibbon 横向细分到 2m，所以只有拼接路破损 —— 这是 ADR-0009 覆盖遗漏。

## 决策

**让 `rtTileQuadGeometry` 支持横向细分（新增第 7 参数 `cross`），与纵向 `seg` 一起
把每块拼成 2m×2m 网格；圆弧转角带 `rtArcBandGeometry` 径向同步细分。**

1. `rtTileQuadGeometry(len, w, eA, eB, y, seg, cross)`：每站生成 `cross+1` 个顶点，
   横向从 +h 到 −h 线性插值，斜切端头 z 按横向插值；索引绕序保持法线朝上。
2. `rtArcBandGeometry(..., cross)`：径向从外缘 R+h 到内缘 R−h 按 `cross` 细分。
3. 编辑器 `buildRoadTileMesh` 与游戏 `customMap` 均传 `cross = ceil(w/2)`。
4. `cross=1` 保留旧行为，兼容无地形 / 其它调用。

## 效果

- `temp-verify-tile-junction.mjs`：拼接路全部顶点相对格点曲面的 lift 恒定，三角面剖分密度
  与横纵路一致。
- 视觉 `verify-junction-zoom.png`：拼接路块本身由锯齿 / 缺口变为连续平滑、标线连续。
- `npm run build` + 5 项逻辑回归通过。

## 取舍与后续

横向细分使单块顶点数从 ~6 增到 ~45（8m 宽 × 16m 长），全地图量级仍远低于地面，
性能可接受。本 ADR 只解决「顶点贴合曲面」；三角面**内部**仍因 8m/2m 剖分不同而有
插值偏差（见 ADR-0011）。
