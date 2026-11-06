# 三维模型与材质扫盲

> 面向没有 3D 美术背景的开发者。所有概念都对应到本项目的实际代码
> （`src/world/materials.js` 标准材料库），看完就能对着库里的参数理解每一项是什么。

---

## 1. 一栋"楼"在 Three.js 眼里是什么

一个三维模型由四层东西组成，从里到外：

```
几何体 Geometry   →  材质 Material  →  网格 Mesh  →  场景图 Scene Graph
   (形状)            (外观规则)         (形状+外观)     (组织/层级/变换)
```

用一个比喻：

- **Geometry（几何体）** = 雕塑的**泥坯形状**——一堆顶点和三角面，只有形状没有颜色；
- **Material（材质）** = 刷在泥坯上的**油漆施工规范**——"用什么颜色、多光滑、反不反光、会不会自己发光"这一整套**规则**；
- **Texture（纹理/贴图）** = 油漆要用的**图案纸**——一张图片，贴到表面上去；材质是规则，贴图是规则的素材之一；
- **Mesh（网格）** = 形状 + 规则组装后的**成品**——场景里真正能被渲染、被看见的对象。

本项目例子（`landmarks.js` 台北 101 的竹节段）：

```js
new THREE.Mesh(
  new THREE.CylinderGeometry(rt, rb, h, 4),  // ← Geometry：形状
  getMaterial("surface:glass-blue")          // ← Material：外观（来自材料库）
);
```

---

## 2. Geometry：形状到底存了什么

### 2.1 顶点与三角面

GPU 只会画三角形。任何模型——sphere、box、人、车——最终都是一堆**顶点（vertex）**按顺序组成的**三角面（triangle / face）**。一个球 ≈ 几百个三角形，一个精细角色模型可达几十万。

顶点数据存在 `BufferGeometry` 的属性里，三个最核心的：

| 属性 | 含义 |
|---|---|
| `position` | 每个顶点的 (x, y, z) 坐标 |
| `normal` | 每个顶点的"朝向"（法线），决定光照怎么打在上面 |
| `uv` | 每个顶点在贴图上的"取色坐标"，见第 3 节 |

### 2.2 常见几何体

- **参数几何体**：代码直接生成——`BoxGeometry`（盒子）、`CylinderGeometry`（圆柱）、`PlaneGeometry`（平面）、`ExtrudeGeometry`（把一个多边形轮廓"拉"成有高度的立体）。本项目的程序化楼、描边建筑全用这些；
- **建模软件做的网格**：美术在 Blender / 3ds Max 里雕出来的复杂模型，导出成文件再加载（GLB 等），见第 6 节。

### 2.3 本项目里几何体的两种存在形态

| | 程序化普通建筑 | 地标 / 描边建筑 |
|---|---|---|
| 形态 | 裸 `BufferGeometry`，生成后**合并**进 220m 大网格 | 独立的 `Mesh` / `Group` |
| 单栋楼可寻址 | 否（只是大几何体中的一段三角形） | 是 |
| 目的 | 几千栋楼只有几十个 draw call | 数量少，换取造型自由 |

---

## 3. Texture（纹理/贴图）：一张"图案纸"

贴图就是一张图片（本项目全是 canvas 代码画出来的，也可以是 png/jpg 文件），通过 **UV 坐标**"包"到模型表面。

### 3.1 UV 坐标——贴图的"钉子位置"

三维顶点怎么知道该取贴图上哪个颜色？靠每个顶点存了一个二维坐标 `(u, v)`，范围通常是 0~1，对应贴图的左下角到右上角。这个过程叫 **UV 映射**（U 横 V 纵）。

本项目的关键约定：

- `ExtrudeGeometry` / `ShapeGeometry` 生成的 UV **单位是米**（顶点在哪 uv 就是几）；
- 所以材料库里 `scaleUVs(geo, sx, sy)` 把它除以"平铺尺度"：外墙贴图 6.4m 一循环、屋顶 4m、店面一个开间 6m×4m。**uv 越过 1 就从头再来（RepeatWrapping），于是贴图能沿墙面平铺**。

### 3.2 常见贴图种类（不止"一张彩图"）

| 贴图 | 作用 | 本项目哪里在用 |
|---|---|---|
| **color / map（颜色贴图）** | 表面基础颜色图案 | `facade:brick-red` 的砖墙图案 |
| **emissiveMap（自发光贴图）** | 夜里哪些地方"自己亮"及亮什么颜色 | 外墙的窗户灯光、招牌灯箱、店堂灯光 |
| **normal map（法线贴图）** | 不加三角形，用假法线骗出凹凸细节 | 暂未用，GLB 模型常带 |
| **roughness / metalness map** | 逐像素控制粗糙度/金属度 | 暂未用 |
| **AO map（环境光遮蔽）** | 烘焙出来的阴影加深（墙角、缝隙） | 暂未用 |
| **图集 atlas** | 把很多小图拼进一张大图，减少材质切换 | `sign:atlas` 8×16 商店招牌图集 |

> **纹理 vs 贴图**：中文里两者基本同义（texture 的两种译法）。本文统一用"贴图"。

### 3.3 平铺参数 wrap / repeat

贴图 uv 超出 0~1 怎么办？`wrapS/wrapT = RepeatWrapping` 表示"重复平铺"——这就是"一张 512×512 的图能贴满一整面墙"的原理（`textures.js` 的 `canvasTexture()` 默认开启）。

---

## 4. Material（材质）：外观的"施工规范"

材质不是一张图，而是**一组参数 + 渲染规则**，告诉 GPU"这个表面怎么对光照起反应"。本项目统一用 PBR 材质 `MeshStandardMaterial`。

### 4.1 PBR 核心参数（对着材料库看）

| 参数 | 白话解释 | 取值感受 | 库里的例子 |
|---|---|---|---|
| `color` | 基础颜色 | `0xc9a23a` 金色 | `surface:gold` |
| `roughness` | **粗糙度**：0=镜面（光滑），1=完全磨砂 | 玻璃 0.2 / 混凝土 0.92 | `surface:glass-blue` vs `surface:concrete` |
| `metalness` | **金属度**：0=非金属（漫反射为主），1=金属（反射环境色） | 金 0.7 / 蓝瓦 0.1 | `surface:gold` |
| `emissive` + `emissiveIntensity` | **自发光**：不受光照、自己亮 | 红灯笼同色发光 | `surface:lantern` |
| `map` | 颜色贴图 | — | `facade:*` 全系 |
| `emissiveMap` | 自发光贴图（夜间窗户/招牌） | — | 同上 |
| `side` | 渲染哪一面：正面/双面 | 招牌薄片双面 | `sign:atlas` |
| `polygonOffset` | 深度偏移，防两层面片闪烁（z-fighting） | 招牌贴墙面片 | 同上 |

**金属度/粗糙度为什么重要**：真实现实里"金属"和"塑料"的区别就是反射方式不同。PBR（Physically Based Rendering，基于物理的渲染）就是用这两个参数模拟它——同样一张贴图，`metalness 0` 是刷漆铁皮，`metalness 0.85 roughness 0.2` 就成了玻璃幕墙。

### 4.2 材质与贴图的关系一句话

> **材质是"菜谱"，贴图是"食材"。** `MeshStandardMaterial` 是一份菜谱模板，`map`/`emissiveMap` 是往里放的食材，`roughness/metalness` 是火候调料。同一个菜谱换食材，就是库里 41 个槽位的关系。

### 4.3 材质共享 = 性能

GPU 每换一次材质（draw call）都有开销。材料库 `getMaterial(id)` 对同 id **永远返回同一个材质实例**，几栋楼用同一种"红砖"就共享一次渲染状态。这就是库存在的核心意义——也要求使用者**绝不要随手 clone 材质**。

---

## 5. Mesh 与场景图（Scene Graph）

### 5.1 Mesh = Geometry + Material

```js
const mesh = new THREE.Mesh(geometry, material);
mesh.position.set(x, y, z);   // 位移
mesh.rotation.y = rot;        // 旋转
mesh.scale.set(sx, sy, sz);   // 缩放
```

`position/rotation/scale` 属于 Mesh 的**变换（Transform）**，不影响几何数据本身——同一份几何可以被多个 Mesh 以不同变换引用。

### 5.2 Group：把零件组装成整体

台北 101 = 裙楼盒子 + 8 段退台圆柱 + 金色腰线 + 尖塔。它们被 `add` 进一个 `THREE.Group`：

```js
const g = new THREE.Group();     // 整体
g.add(裙楼, 退台×8, 腰线×8, 尖塔);
g.position.set(l.x, 0, l.z);     // 移动 Group = 整栋楼一起动
```

**子对象跟着父对象走**——这就是场景图（Scene Graph）：一棵对象树，变换逐层向下叠加。GLB 模型加载进来也是一棵这样的树（骨骼、部件层级）。

### 5.3 碰撞体是另一套数据

场景图只管"看得见"。玩家撞墙、镜头遮挡用的是**另一套简化数据**——本项目是 `ColliderGrid` 里的 AABB 矩形（`[x0,z0,x1,z1,top]`）。渲染形状可以很复杂，碰撞用简化盒子是行业惯例。

---

## 6. 模型文件格式

| 格式 | 特点 | 建议 |
|---|---|---|
| **glTF / GLB** | 三维界的 JPEG：glTF 是 JSON 描述 + 外部资源，**GLB = 打包成单文件**。带层级、PBR 材质、动画、骨骼 | **推荐**，Three.js 官方支持最好 |
| OBJ | 老格式，只有静态网格 + mtl 材质引用，无动画 | 简单静态道具可用 |
| FBX | 闭源，动画/绑定常用 | 尽量转成 GLB 再进引擎 |
| STL | 只有三角面，无材质无 UV，3D 打印用 | 不适合游戏 |

**GLB 里面装了什么**：一棵节点树（每节点有变换）→ 节点挂 Mesh → Mesh 引用 Geometry（顶点数据）和 Material（PBR 参数 + 贴图引用）→ 贴图以图片形式内嵌。**它不包含游戏逻辑**（碰撞、灯光逻辑、夜间开关都要引擎侧自己做）。

---

## 7. 性能词汇表（和本项目强相关）

| 术语 | 意思 | 本项目对应 |
|---|---|---|
| **Draw call** | CPU 命令 GPU 画一次的开销。材质/网格切换越多越卡 | 材料库共享实例 + `ChunkedBatch` 合并，几千栋楼 → 每格每材质 1 次 |
| **合并几何（merge / batching）** | 同材质的几何拼成一个 BufferGeometry，一次画完 | 程序化建筑的 `Batch` / `ChunkedBatch` |
| **实例化（Instancing）** | 同一几何+材质画 N 份，只传一份顶点数据 | 车流/人群用的思路 |
| **分块剔除（frustum/distance culling）** | 看不见的不画 | 220m 格子 + 玩家距离流式显隐 |
| **LOD** | 远处用低模 | 未用（靠剔除） |
| **z-fighting** | 两个面片共面导致闪烁 | 招牌材质的 `polygonOffset` |

---

## 8. 对照表：一句话 + 本项目位置

| 概念 | 一句话 | 本项目位置 |
|---|---|---|
| Geometry | 形状（顶点+三角形+UV） | `batch.js`、`ExtrudeGeometry` |
| UV | 顶点在贴图上的取色坐标 | `scaleUVs` / `uvScaleFor` |
| Texture | 贴上去的图案（颜色/发光/法线…） | `textures.js` 全部 canvas 生成 |
| Material | 外观规则（PBR 参数+贴图引用） | `materials.js` 41 个槽位 |
| Mesh | 形状+外观的渲染单元 | `landmarks.js` 的 `box()/cyl()` |
| Group | 零件组装与整体变换 | 每个地标一个 Group |
| Scene Graph | 对象树，变换向下叠加 | `scene.add(...)` 的整棵树 |
| Collider | 玩家碰撞用的简化形状（与渲染无关） | `colliderGrid.js` |
| Draw call | 每次渲染提交的开销 | 材料库共享 + ChunkedBatch |
| GLB | 标准三维模型单文件（glTF 二进制） | 未来自建模型的导入格式 |

---

## 9. 以后你自建模型时的实操建议

1. **用 Blender 建模 → 导出 GLB**（File → Export → glTF 2.0，勾选"应用变换"）；
2. **材质不在 GLB 里调**：模型里只保留占位材质并按约定命名（`mat_facade_brick-red`、`mat_surface_gold`、`mat_storefront_cafe`），导入器按名字换成材料库实例——模型只带几何，材质全城共享；
3. **贴图坐标交给库**：库材质的平铺尺度已定（facade 6.4m / roof 4m / storefront 6×4m），建模时把 UV 摆成米制或用 box mapping，引擎侧 `uvScaleFor` 会自动对齐；
4. **招牌特殊**：`sign:atlas` 是图集用法，招牌面片的 UV 要对准图集某一格（可用 `signTileRect(index)` 导出每格的 UV 矩形去 Blender 里对位）；
5. **碰撞不用建模**：导入器按包围盒自动生成 AABB 碰撞（同描边建筑的 `footprintAABB` 逻辑）；
6. **面数预算**：单个建筑模型建议 < 5 万三角形；重复道具（路灯、长椅）越低越好，它们可能成片出现。
