# 地表主题（terrain.theme）设计

> 状态：active　|　创建：2026-11-19　|　最后更新：2026-11-19

## 1. 背景与目标

**现状问题**：

- 地形表面只有一张固定的程序斑驳贴图（`makeTerrainTexture()`，编辑器地形板用），运行时主地面却硬编码沥青（`city.js _buildGround` → `makeAsphaltTexture()`）——编辑器与游戏地面观感不一致；
- 用户希望地形可选地表风格（城市/草地/岩石/沙漠）；且「随机地形 + 沙漠」这类组合下，山体不应也是沙漠色 → 需要**坡度/海拔自动适配**（坡地自动岩石、高海拔自动积雪）。

**目标**：

1. `terrain.theme` 字段（`city / grass / rock / desert`），3D 编辑器地形面板单选；
2. 规则式自动适配用**顶点色**实现（不上 splatmap）：高度明暗 + 坡地岩石 + 雪线，参照 Unity Terrain Layers 的「规则自动放置」思路的轻量版；
3. 编辑器与运行时**共用同一个着色函数**（杜绝"编辑器草地、游戏沥青"）；
4. 主题可拓展：新增主题 = 主题注册表加一条 + 纹理 painter 加一个，为 v2 材质笔刷留结构。

**非目标（v2 再做）**：逐格材质权重（splatmap）、材质笔刷、按权重混合多张贴图、按坡度自动混贴图。

## 2. 方案

### 2.1 数据

- `terrain.theme: string`，缺省 `"city"`；旧地图无此字段 → `themeOf()` 兜底为 city，观感与改动前一致；
- `terrain.snowOn: boolean?`（雪线开关）、`terrain.snowFrom: number?`（雪线海拔，米）：编辑器面板可调，未设置跟随主题默认（草地/岩石有雪线 280/300m，城市/沙漠无）——`snowDefaultsOf()` 单点兜底，编辑器/运行时共用；
- theme / snowOn / snowFrom 随 terrain 一起走编辑器撤销快照与地图 JSON 保存；随机重生成时与 padFactor/maxGrade 同机制手动保留。

### 2.2 渲染模型

```
最终颜色 = 基础纹理（按主题出图，只提供地表颗粒质感）
         × 顶点色（规则着色：高度明暗 + 坡地岩石 + 雪线）
```

规则着色 `shadeTerrainVertex(themeKey, h, slope, ctx, out)`（`world/terrainTheme.js`）：

| 规则 | 输入 | 行为 |
|---|---|---|
| 高度明暗 | h、ctx（hMn/span/base/scale/isReal） | custom 按基础高度锚定（0.85 基准、对比度最小 60m 满量程）、real 低点锚定——**与旧编辑器 `_shadeTerrainPlate` 逐位一致**，city 主题编辑器观感不变 |
| 坡地岩石 | slope（heights 网格有限差分梯度，1 ≈ 45°） | `slopeStart → slopeFull` 线性过渡到主题岩石色；只读**原始高度场**（不含道路塑形/地基 pad）——着色是视觉规则，不必贴路面，且 O(1) 无采样开销 |
| 雪线 | h > snowFrom | 按 snowBlend（米）过渡到雪色；snowOn/snowFrom 面板可调（terrain.snowOn/terrain.snowFrom），未设跟随主题默认（city/desert 无雪线）；无雪主题强制开雪线时用白雪兜底 |

### 2.3 三处同步点（防"编辑器草地、游戏沥青"）

| 位置 | 改动 |
|---|---|
| 编辑器地形板（`mapEditor3d.js` 矩形 + 多边形两处材质） | `makeTerrainTexture(theme)`；`_shadeTerrainPlate` 改调共享函数 |
| 运行时主地面（`city.js _buildGround`） | **非 city 主题**：换主题贴图 + `vertexColors: true` + 顶点烘焙颜色；**city 主题保持沥青 + 无顶点色（零回归）** |
| 道路 | 路基补丁 / 路面 / 标线**永远沥青**，独立材质（道路是道路，主题只管野地）；运行时远景底板颜色按主题 `outer` 色微调 |

### 2.4 文件与职责

| 文件 | 职责 |
|---|---|
| `world/terrainTheme.js`（新） | 主题注册表 `TERRAIN_THEMES`（label/low/high/slope/snow/outer 色与阈值）+ `themeOf` + `terrainSlopeAt` + `shadeTerrainVertex`；不依赖 three |
| `world/textures.js` | `makeTerrainTexture(theme)`：`GROUND_PAINTERS` painter 注册表 + 按主题缓存；新增主题只加一个 painter |
| `ui/mapEditor3d.js` | 两处地形板材质传 theme；`_shadeTerrainPlate` 改调共享着色函数 |
| `ui/editor3d/terrain.js` | 面板「基础」组加「地表主题」单选按钮组 |
| `world/city.js` | `_buildGround` 按主题换贴图/顶点色；路基补丁独立沥青材质 |

### 2.5 已知取舍

- 顶点色分辨率 = 8m 网格（GROUND_STEP），岩石/草地过渡是块状渐变——与项目 flatShading 低多边形风格一致，可接受；
- 运行时主地面颜色在 `displaceGroup` 之前按世界坐标采样高度场烘焙（displaceGroup 的 `tessellateFlat` 会连带插值 color 属性，无需特殊处理）；
- 雪线用绝对海拔（米）：随机地形幅度默认 60m 通常到不了雪线，真实地形/高幅度雕刻可见——刻意行为，避免相对高度把小地图也染雪。

## 3. 验收

1. 编辑器选「草地」+ 随机生成地形：缓坡草绿、陡坡岩石灰、（幅度够高时）峰顶积雪；
2. 保存进游戏：野地观感与编辑器一致，道路仍是沥青 + 标线；主题换「沙漠」后野地变沙色、山体岩石；
3. 旧地图（无 theme 字段）打开：观感与改动前完全一致；
4. `npx vite build` 通过；`npm run dev` 手测编辑器 + 游戏两端。

## 4. 后续（v2 预留）

材质笔刷（`terrain.mats` 逐格权重数组 + 笔刷 stamp 写权重 + 着色器按权重混贴图）时：
- `TERRAIN_THEMES` 注册表结构不变，`shadeTerrainVertex` 平移为「自动填充权重」的规则引擎；
- painter 注册表继续承担各材质底图。
