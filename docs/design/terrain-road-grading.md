# 道路走廊纵坡塑形：设计与实现说明

状态：active · 创建：2026-11-19 · 最后更新：2026-11-19
决策依据：[ADR-0004](../adr/ADR-0004-road-corridor-grading.md) · [ADR-0003](../adr/ADR-0003-terrain-heightfield.md) · [ADR-0006](../adr/ADR-0006-junction-grade-blend.md)

> **路口实现更新**：下文关于「wsum 1→1.6 直接拉回原始地形」的描述已由 ADR-0006
> 取代为「按高差自适应引道（terrain.junctions）平滑贴回 base」。其余部分不变。

## 目标与验收

| 目标 | 验收 |
|---|---|
| 道路占用的地面是平整场地 | 同一纵向位置、core 内任意横向偏移的 `terrainHeightAt` 完全相等 |
| 道路随地形起伏 | 沿路设计高高差与原始地势同量级（自测 42.94m），纵坡 ≤ 设定上限 |
| 路口平顺 | 多走廊重叠直接贴回原始地形，两路同高、不产生假陡坎 / 凹坑 |
| 路面不隆起 | 路面与原地表单点落差 <0.5m（自测 0.46m），不是悬空堤坝 |
| 路块接缝不断裂 | 5 块连续路块链，接缝两侧高度差 <0.5m |
| 编辑器 / 游戏世界都不穿地形、不断续 | 8m 路基补丁覆盖走廊 + 粗底板下沉 6m + 几何纵向细分 |
| 车辆 / 人物沿地形表面走 | 统一 `surfaceHeightAt`，车辆按 pitch 贴合纵坡 |
| 无地形地图零影响 | `terrainHeightAt` 返回 0，不生成走廊 / 补丁 / 细分 |

## 数据流

```
map.terrain.heights (原始高度场，40m 网格)
        │  baseHeightAt(map,x,z)  双线性插值 + 建筑地基 pads
        ▼
buildRoadCorridors(map)  ← 描边路 / 取面路 / 拼接路块 / 程序化横纵路网（含延伸路）
        │  中心线 8m 重采样 → 滑动平均 → 最大纵坡限幅 → 路口高程一致性松弛
        ▼
map.terrain.corridors  [{ kind, x[], z[], s[], h[], half, band, aabb } | { kind:"area", poly, h, band, aabb }]
        │  gradeQuery（64m 空间索引 + 每走廊取最近段 + 路口加权平均）
        ▼
terrainHeightAt(map,x,z)  ← 唯一高度权威
        ├─ 静态几何：编辑器 fitGeometryToTerrain / 运行时 displaceGroup（含水平长面细分）
        ├─ 可见地面：buildRoadBedGeometry（8m 路基补丁）+ terrainBed 粗底板下沉
        └─ 动态实体：surfaceHeightAt(map,x,z,city)
                       ├─ 玩家 _groundHeightAt / _drive
                       ├─ AI 车流 Traffic._place（+ pitch）
                       ├─ 行人 PedestrianCrowd
                       └─ 地标独立组按落点抬升
```

## 算法细节

### 纵断面

1. `resamplePoints(pts, 8)` 得到等距中心线，累积弧长 `s[]`；
2. `baseHeightAt` 逐点采原始地表 `raw[]`；
3. 半径 2 的加权滑动平均做**一遍**（~16m 低通），只滤掉 40m 网格折线棱角；
   大窗口 / 多遍会削峰填谷把路抬成堤坝，禁止使用；
4. `limitSlope`：前向 + 后向两遍，把 `|Δh/Δs|` 约束到 `maxGrade`（默认 **0.35**，
   编辑器 5~50% 可调）。旧地图保存的 0.08 会在 `buildRoadCorridors` 里自动
   迁移到 0.35，否则刷新后仍是削坡版；
5. `harmonizeJunctions`：24m 空间格找跨走廊邻近采样点，四轮把剖面高度向中间
   靠拢，阈值放宽到 `max(half)*1.6`（覆盖相邻路块接缝）；限坡在全部松弛
   结束后统一做一次。

### 横断面 / 路口

- 点到中心线段的投影得弧长 `s` 与横向距离 `d`；
- `d ≤ half`（half 含人行道）→ 权重 1，设计高 = `profile(s)`，横坡 0；
- `half < d < half + 8` → 权重 `1 - smoothstep((d-half)/8)`，与原地形混合（窄路肩）；
- 多条走廊重叠（`wsum` > 1）→ 用 smoothstep 在 `wsum` 1→1.6 间把结果**拉回原始
  地形** `base`：相交的两条路天然同高，不再出现加权平均造成的假陡坎 / 凹坑；
- 取面路（closed）为 area corridor：多边形内常数高，外圈 8m 过渡带。

### 为什么需要路基补丁 + 底板下沉

大底板内部三角形按两端顶点线性插值，**跨过**十米宽的平整走廊，把路面吞掉 ——
这是「断断续续」的根因。单靠 `polygonOffset` 或抬高路面无法解决。

- 底板加密到 ~21m（编辑器 192 段）/ ~32m（运行时），缩小跨界插值误差；
- `buildRoadBedGeometry` 按 8m 全局格点生成一张补丁，全局 Set 去重（路口不重叠），
  **外扩两圈**使补丁边缘完全包住底板跨界三角形；顶点 y 由 `_bendArea` /
  `displaceGroup` 统一采样 `terrainHeightAt` 顶起；
- 粗底板顶点只做 **0.15m 微下沉**（`roadBedDropAt`，core 内、过渡带渐变到 0），
  仅防粗三角形穿面；**逻辑高度不变**。实测 6m 下沉会在补丁边缘形成可见壕沟 /
  路堤（「横路隆起来像坝」），已废弃。路肩改为 8m 窄带：只平整路面本身，
  不改造大片地形（40m 宽路肩也会造出明显的人工路基）。

## 改动清单

| 文件 | 改动 |
|---|---|
| `walkstreet/src/world/terrain.js` | `baseHeightAt` / `terrainHeightAt` 两层拆分、走廊生成与查询、路基补丁、`tessellateFlat`、`displaceGroup` 下沉、`surfaceHeightAt` |
| `walkstreet/src/ui/editor3d/meshes.js` | `fitGeometryToTerrain`、圆片逐顶点贴地、closed 面路细分贴地、8m 重采样 |
| `walkstreet/src/ui/editor3d/roadTiles.js` | 取消按尺寸缓存的四顶点几何，改为每块纵向细分 + 逐顶点贴地 |
| `walkstreet/src/ui/mapEditor3d.js` | `_rebuildAll` 重算走廊、程序化骨架 8m 细分、路基补丁 mesh、底板下沉、顶点色 bug 修复、草稿线贴地 |
| `walkstreet/src/ui/editor3d/terrain.js` | `rebuildTerrain` 重算走廊、新增「道路最大纵坡」滑杆 |
| `walkstreet/src/world/customMap.js` | `rtTileQuadGeometry` 支持纵向 seg、道路/河流 8m 重采样 |
| `walkstreet/src/world/city.js` | `_init` 重算走廊、大地面 `terrainBed` 标记、路基补丁 mesh |
| `walkstreet/src/entities/{player,traffic,pedestrians}.js` | 统一 `surfaceHeightAt`，车辆/驾驶加 pitch |
| `walkstreet/src/world/landmarks.js` | 地标独立组按落点抬升 |
| `walkstreet/temp-test-road-grade.mjs` | 回归自测（与既有 `temp-test-terrain.mjs` / `temp-test-pad.mjs` 同惯例） |

## 验证命令

```powershell
cd walkstreet
node temp-test-road-grade.mjs     # 算法回归：横断面/纵坡/起伏/路口/补丁/实体/平面地图
node temp-test-terrain.mjs        # 既有高度场回归
node temp-test-pad.mjs            # 既有建筑地基回归
npm run build                     # 打包语法校验
```

编辑器手工验收：3D 地图编辑器 → 地形编辑（随机/真实/自定义）→ 描边道路 /
拼接路块 / 程序化路网，俯视与低角度检查路面连续无断裂、无穿山；调「道路最大纵坡」
滑杆观察路基随坡度变化；保存并进游戏，检查车辆/行人沿坡面行走、不穿地。
