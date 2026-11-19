# ADR-0007 路面条带横断面与补丁同相位

日期：2026-11-19 · 状态：已采纳
关联：扩展 ADR-0005（可见地面网格同精度）、ADR-0006（路口贴地引道）

## 背景

用户反馈：3D 地图编辑器里一横一纵两条路，十字路口附近**路面显示不全**——深色沥青
两侧边缘出现阶梯状 / 锯齿状缺口，路面被灰蓝地形一块块盖住。游戏视角正常。

这与 ADR-0005 解决的"粗底板顶穿"是**不同层**的问题：

- ADR-0005 修的是可见主地面（outer / road 面）与**路基补丁**之间的顶穿；
- 本次是**路面条带本身**与**路基补丁**之间的顶穿。

## 根因（诊断数据）

高度权威链路里，同一位置的可见高度由几层网格各自采样 `terrainHeightAt`，但采样密度不同：

| 层 | 横向采样 | lift |
|---|---|---|
| 路基补丁 `buildRoadBedGeometry`（ADR-0005） | **8m 格点逐点采样** | 0.04 |
| 路面条带 `roadRibbon` / `stripGeometry`（旧） | **仅左右两条边**，中间线性插值 | 0.08 / 0.09 |

旧实现路面条带两侧顶点共用**中心线单点高度**，横断面是"平"的：

```js
const y = 0.08 + ed._terrainY(pts[i].x, pts[i].z);  // 单点高度
pos.push(x+ox, y, z+oz, x-ox, y, z-oz);             // 两侧同 y
```

平坦地形下没问题。但 ADR-0006 让路口区域 `terrainHeightAt` 贴回原始地形后，
横向 16m 跨度内起伏可达数米：

- 补丁在路中央有 8m 格点，逐点采到凸起 / 凹陷；
- 条带只有左右两条边、中间靠线性插值，跨 16m 的直线**低于**补丁的凸起格点；
- 补丁从下方顶穿条带 → 视觉上路面被啃出阶梯状缺口。

诊断脚本（`temp-diag-crossroad*.mjs`，seed=3 / 振幅 150m / 一横一纵）：

- 旧（共用中心高度）：横路 **44.1%** 采样点顶穿，最深 **-1.86m**；
- 只改两侧逐点采样：边缘修好，但条带中间仍有 **7.8%** 顶穿、最深 -0.63m（路中央凸起）；
- 横向 8m 细分 + 逐点采样：**0% 顶穿，最小高差恒 +0.04m**。

## 决策

路面条带 `roadRibbon` 与 `stripGeometry` 横向按 `GROUND_STEP`（8m）细分，
每个顶点按**自身世界坐标**采样高度，与路基补丁完全同相位：

```js
const cross = Math.max(1, Math.ceil((2 * halfW) / GROUND_STEP));
for (let i = 0; i < pts.length; i++) {
  const nx = -dz / len, nz = dx / len;           // 横向单位法向
  for (let j = 0; j <= cross; j++) {
    const off = -halfW + (2 * halfW * j) / cross;
    const wx = pts[i].x + nx * off, wz = pts[i].z + nz * off;
    const wy = 0.08 - ed._curveOffset(wx, wz) + ed._terrainY(wx, wz);
    pos.push(wx, wy, wz);
  }
}
```

条带与补丁共用同一高度函数、同一格点相位，只差固定 lift 0.04m（0.08 − 0.04），
任何地形下都保持条带在上、补丁在下，不再互相穿插。

`fitGeometryToTerrain`（拼接路 / 描边面路）本是逐顶点采样，无需改动。

## 备选方案（否决）

- **只让两侧边逐点采样**：条带中间仍是跨 16m 线性插值，路中央凸起处照样顶穿（实测 7.8%），否决。
- **整体抬高路面条带 lift**（如 0.08→0.3）：起伏达数米时治标不治本，且路面悬空、路口与标线脱节，否决。
- **降低路基补丁 lift**：补丁要盖住下沉主地面（ADR-0005），不能降，否决。
- **关闭路口贴 base**（回退 ADR-0006）：路口断崖重现，否决。

## 验证

- `temp-diag-crossroad.mjs` / `temp-diag-crossroad2.mjs`：0% 顶穿，最小高差 +0.04m；
- 浏览器内实测（`temp-verify-ribbon.mjs`）：2 条路带共 3006 顶点，
  `y − (0.04 − curveOffset + terrainY)` 恒 = 0.04，outliers = 0；
- 编辑器斜视 / 俯视截图：十字路口路面连续、两侧边缘平滑、无阶梯缺口；
- `npm run build` + 逻辑回归（road-grade / terrain / pad / verify-final）全通过。
