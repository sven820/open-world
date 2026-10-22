## 1. 目录结构
```
openworld/
├─ rea/                  # 逆向工作区（按目标站点分目录）
│  └─ taibei-gta/        # 原版 taipei-gta.org 的全部逆向资料（见附录 A）
│     ├─ target_assets/  # 原版站点的已构建产物（逆向目标本体，27 文件）
│     ├─ target_data/    # 原版的世界/内容数据（JSON）
│     ├─ rea/            # 原版核心模块的静态分析副本（7 文件）
│     ├─ tools/          # 抓取原版资源的脚本
│     ├─ site_index.html # 原版站点入口 HTML
│     └─ recon_*.png     # 原版实机侦察截图（8 张）
├─ tr_*.png             # 本项目构建/验证截图（多张）
├─ taipei-rush/          # 本项目（见正文各章节）
```

### A.1 `rea/taibei-gta/target_assets/`（原版构建产物，27 文件 = 26 `.js` + 1 `.css`）
Vite/Rolldown 打包产物（文件名带 hash，如 `three-DoD3b_mB.js`）。关键模块：
- `three-*.js` —— 确认原版即 **three.js**；
- `engine-*.js` / `game-*.js` / `world-*.js` / `worldData-*.js` / `cities-*.js` —— 引擎、游戏主循环、世界/城市生成与数据；
- `tilePool-*.js` / `regionTiles-*.js` —— **分块（tile）流式加载**实现（"城市分段載入"的真相）；
- `BufferGeometryUtils-*.js` —— 内含 `mergeGeometries`，证明原版**也用几何合批**；
- `postfx-*.js` —— 后处理（含 `VignetteEffect` 暗角）；
- `actors-*.js` —— 行人/车辆/角色；`content-*.js`、`text-*.js`、`ui-*.js`、`controllers-*.js`、`boot-*.js`、`session-*.js`、`landing-*.js`、`tabs-*.js`；
- `site-bolero-1934-*.js` / `site-donqi-ximen-*.js` / `sites-kit-*.js` —— 店铺/地标套件（`donqi-ximen` = 西门町唐吉诃德等）；
- `roadClearance-*.js` —— 道路净空/碰撞；
- `modulepreload-polyfill-*.js` / `preload-helper-*.js` / `rolldown-runtime-*.js` —— 构建运行时。

### A.2 `rea/taibei-gta/target_data/`
- `worldData.json` —— **原版整套台北世界的真实配置**：山脉、路网（真实坐标 + 车道数/分隔带/人行道）、14 个区 + 建筑风格参数 `{floors,towers,neon,old,shops}`、河流、桥梁、捷运线（R/BR/G/BL/O 及车站坐标）、上百个地标。是"数据驱动"的最有力证据。
- `content.json` —— 内容数据（店招/活动/文本等）。

### A.3 `rea/taibei-gta/rea/`（7 文件）
原版核心模块的**工作副本**，便于静态阅读：`actors` / `boot` / `cities` / `content` / `controllers` / `engine` / `world`（与 `target_assets/` 同名模块**字节一致**，仅用于阅读标注；可运行的完整模块图在 `target_assets/`，其内部相对 import 在同目录内自洽）。

### A.4 `rea/taibei-gta/tools/`
- `collect_server.mjs` —— 接收 `taipei-gta.org` 页面回传的资源并落盘到 `target_data/` 的服务端脚本（逆向的第一手来源；默认输出目录按脚本位置解析，已适配新路径）。

### A.5 `rea/taibei-gta/site_index.html`
原版站点入口 HTML（核对 DOM 结构、字体、加载流程）。

### A.6 截图对照
- `rea/taibei-gta/recon_*.png`（8 张：`recon_1`/`recon_2`、`recon_game1`~`recon_game4`、`recon_map`、`recon_night1`）—— **原版**实机侦察画面（游戏/HUD/地图/夜景），用于对照片观感与功能。
- `tr_*.png`（多张：`tr_day_spawn`、`tr_final_default`、`tr_game1`、`tr_load`、`tr_menu`、`tr_orig_close*`、`tr_orig2`、`tr_player_glb`、`tr_road*`、`tr_sign_fix`、`tr_top`、`tr_wall`）—— **本项目**的构建验证截图（出生点、菜单、路面、招牌修复、墙体、角色 GLB、与原版对比等）。

### A.7 `taipei-rush`
本项目的目录结构。

```
taipei-rush/
├─ index.html              # 入口 HTML：加载字体/样式/主模块；定义 loader、HUD、菜单、大地图、点击提示等 DOM
├─ package.json            # 依赖 three + vite；scripts: dev / build / preview
├─ package-lock.json
├─ public/                 # 静态资源（不经打包，原样拷贝）
│  ├─ avatars/             # 15 个角色 GLB（KTX2 + Meshopt），当前仅 jie.glb 被加载
│  │   ├─ jie.glb  auntie.glb  casual-f.glb  casual-m.glb  elder-f.glb  elder-m.glb
│  │   ├─ office-f.glb  office-m.glb  office-m2.glb  police.glb  student-f.glb
│  │   ├─ student-m.glb  uncle.glb  vendor.glb  wen.glb
│  └─ basis/               # KTX2/Basis 转码器（wasm + js），供 KTX2Loader 解码压缩纹理
├─ dist/                   # vite 构建产物（自动生成，部署用）
└─ src/                    # 源码（ESM）
   ├─ main.js              # 启动流程 + UI 事件绑定 + 主循环
   ├─ style.css            # 全部界面样式（loader / HUD / 菜单 / 大小地图 / 速度表 / 通知）
   ├─ core/
   │  ├─ engine.js         # 渲染核心：WebGLRenderer + 阴影 + Bloom 后处理 + 主循环
   │  ├─ environment.js    # 昼夜与天空：自定义 GLSL 天空穹顶 + 日/月灯光 + 时间循环
   │  └─ input.js          # 键鼠输入（e.code + e.key 双识别、指针锁定）
   ├─ world/
   │  ├─ city.js           # 城市生成主逻辑（地面/路/建筑/招牌/合批）
   │  ├─ landmarks.js      # 程序化地标（101 / 车站 / 龙山寺 / 红楼 / 牌楼 / 信义高楼）
   │  ├─ textures.js       # 运行时 Canvas 程序化贴图（沥青/人行道/楼面/店面/招牌/屋顶）
   │  └─ batch.js          # 几何合批工具（mergeGeometries + 顶点色）
   ├─ entities/
   │  ├─ player.js         # 玩家：程序化骨骼兜底 + GLB 角色（含上下车/跳跃/姿态）
   │  ├─ models.js         # 车辆程序化几何（轿车/机车/公交）
   │  ├─ pedestrians.js    # 行人：InstancedMesh 实例化群
   │  └─ traffic.js        # 交通流（沿车道行驶的车辆）
   ├─ ui/
   │  └─ hud.js            # HUD：小地图 / 大地图 / 区名 / 速度表 / 通知
   └─ data/
      └─ cityData.js       # 数据驱动配置（路网/区/店名/招牌词/地标）
```

> 注：城市数据集中在 `src/data/cityData.js`，由 `world/city.js`、`world/textures.js`、`world/landmarks.js`、`ui/hud.js` 通过 `../data/cityData.js` 导入使用。

### 各模块职责速览
- **`core/engine.js`** — `WebGLRenderer`（抗锯齿、`powerPreference:high-performance`、`pixelRatio≤1.75`）、`ACESFilmic` 色调映射、`PCFSoftShadowMap` 软阴影、`FogExp2` 雾；`PerspectiveCamera(58°)`；`EffectComposer` + `UnrealBloomPass` + `OutputPass` 实现霓虹/车灯泛光；`onUpdate(fn)` 注册每帧回调，`dt` 限幅 0.05s。
- **`core/environment.js`** — 自定义 GLSL 天空穹顶（`SkyVert/SkyFrag`：日月光晕、太阳圆盘、地平线渐变）；day/dawn/dusk/night 预设与色温插值；sun/moon/hemi/ambient 灯光随时间 `setHour()/update()` 循环，驱动昼夜。
- **`core/input.js`** — `window` 级 `keydown/keyup` 收集按键；**同时按 `e.code` 与 `e.key` 识别**（兼容非 QWERTY 布局 / 输入法）；指针锁定与鼠标位移转视角。
- **`world/city.js`** — 城市生成核心：大沥青地面（`PlaneGeometry` + Canvas 沥青纹理）、车道线/斑马线/双黄线（薄平面片 batch）、按区块切分并 `_addBuilding`（四面墙 + 屋顶 + 女儿墙 + 屋顶水箱/空调杂物，按楼层随机高度）、临街店面 + 雨棚 + 招牌（含 z-fighting 修复）、`_finalize()` 把每种材质 `mergeGeometries` 成单 Mesh 以压低 draw call；同时生成碰撞体。
- **`data/cityData.js`** — 数据驱动：路网 `ROADS_X/ROADS_Z`（忠孝东路、中华路、环河南路…）、`DISTRICTS`（西门町/台北车站/万华/信义…及副标题）、店名词库与招牌词、地标清单。
- **`world/landmarks.js`** — 程序化地标：台北 101（竹节分段 + 尖顶）、台北车站、龙山寺、红楼、牌楼/城门、信义高楼群，全用 `Box/Cylinder/Torus` + 玻璃/混凝土/红/金材质。
- **`world/textures.js`** — 运行时用 2D `<canvas>` 画出所有贴图（沥青、人行道瓷砖、楼面窗格变体、店面、招牌图集中文店名、屋顶），输出 `CanvasTexture`（含 mipmap / 各向异性），**零外部图片**。
- **`world/batch.js`** — `Batch` 类：收集多个 `BufferGeometry` 后 `mergeGeometries` 合成为单 Mesh，并支持顶点色；`wallQuad/roofQuad/boxAt/planeAt/signQuad/cylAt` 等构造 helper。
- **`entities/player.js`** — 玩家：默认用程序化骨骼 rig 兜底；`GLTFLoader` + `KTX2Loader` + `MeshoptDecoder` 异步加载 `/avatars/jie.glb`，自动归一化身高与朝向（源模型朝 -Z，rig 朝 +Z，旋转 π 修正）；管理步行/驾驶、上下车、跳跃、动画姿态。
- **`entities/models.js`** — 车辆程序化几何：轿车 / 机车 / 公交等用 `Box/Cylinder` 合并，含车身、玻璃、车灯（vertexColors）、轮胎、轮辋；`scooter` / `car` 两种 `kind`。
- **`entities/pedestrians.js`** — 行人：用 `InstancedMesh` 实例化数百个行人（头/身/四肢分部件、顶点色），沿人行道行走的简易 AI。
- **`entities/traffic.js`** — 交通流：沿车道生成并行驶车辆，与玩家 / 信号灯交互。
- **`ui/hud.js`** — HUD：2D canvas 雷达小地图（玩家/车辆/地标点）、大地图（`WASD` 平移 + 滚轮缩放）、区名/时间/天气/金钱/通缉/血量/速度表、通知 toast、上车提示。

---

## 2. 从原版逆向分析到构建本项目

### 2.1 原版是什么
原版 **台北 GTA / Taipei Rush**（`https://taipei-gta.org/`，英文名 *Taipei Rush*，同站还有 *Hong Kong Rush*）是一个"免下载的浏览器开放世界"。其官网 FAQ 对自身技术实现有公开的、关键的描述（字面引用）：

- **「城市是分段載入的」**
- **「第一次慢多半是在下載場景」**（首屏慢，主要是在下载场景）
- **「The city streams in, so wait before you refresh.」**（城市是流式载入的，刷新前请等待）
- 「3D 城市吃效能，手機和舊筆電比較容易卡」

这几句足以判断：**原版把"场景"作为资源从服务器分块流式加载（stream / 下载場景）**，属于"资源驱动"路线，而非纯客户端程序化生成。

### 2.2 逆向分析的资料与手段
本项目没有拿到原版源码，但有一个完整的**逆向工作区**（见附录 A：`rea/taibei-gta/`）。分析建立在以下真实资料与手段之上：

1. **原版构建产物（`rea/taibei-gta/target_assets/`）**：从 `taipei-gta.org` 抓取的已构建 JS 包（Vite/Rolldown 产物，带 hash）。能直接确认原版技术栈：
   - `three-*.js` —— 确认原版就是 **three.js**；
   - `world-*.js` / `worldData-*.js` / `cities-*.js` —— 世界/城市生成与数据；
   - `tilePool-*.js` / `regionTiles-*.js` —— **分块（tile）流式加载**的真实实现（"城市是分段載入的"的落地方式）；
   - `BufferGeometryUtils-*.js` —— 内含 `mergeGeometries`，证明原版**也用几何合批**（与本项目的 `batch.js` 同路数）；
   - `postfx-*.js` —— 后处理（含 `VignetteEffect` 暗角），与本项目的 `UnrealBloom` 同为后期路线；
   - `actors-*.js`（行人/车辆/角色）、`content-*.js`、`text-*.js`、`ui-*.js`、`controllers-*.js`、`engine-*.js`、`boot-*.js`、`session-*.js`、`site-*.js`（bolero / donqi-ximen 等店铺套件）。
2. **原版世界数据（`rea/taibei-gta/target_data/worldData.json`）**：这是原版**整套台北世界的真实配置**——山脉（七星山/大屯山…）、路网（真实坐标 + 车道数/中央分隔带/人行道宽）、**14 个区**及其建筑风格参数 `{floors,towers,neon,old,shops}`、河流（淡水河/基隆河/新店溪/大汉溪）、桥梁（台北桥/忠孝桥/关渡大桥…）、捷运线（R/BR/G/BL/O 含车站坐标）、上百个地标（故宫/龙山寺/北投温泉/淡水老街/猫空/各大夜市…）。**坐实原版也是"数据驱动"**，且覆盖大台北全域，远胜本项目的核心街区 Demo。`content.json` 为内容数据。
3. **原版入口（`rea/taibei-gta/site_index.html`）** 与 **工作副本（`rea/taibei-gta/rea/`）**：后者是抽出用于静态分析的 7 个核心模块副本（actors/boot/cities/content/controllers/engine/world）。
4. **抓取工具（`rea/taibei-gta/tools/collect_server.mjs`）**：接收原版页面回传的资源并落盘到 `target_data/` 的服务端脚本，是逆向的第一手来源。
5. **DevTools 行为分析 + 代码扫描**：在抽取到的包中过滤 `.glb` / `gltf` / `GLTFLoader` **未命中城市模型加载**（仅有 three.js 的 `ShaderMaterial` 定义与后处理），结合 `tilePool/regionTiles` 可判定原版是**程序化几何 + 分块流式**，而非预建模 GLB 城市。
6. **实机游玩观察 + three.js 生态常识**：提炼可玩特征（步行/机车/开车、地标分布、密度、昼夜霓虹、行人车流、HUD）。

> **修正说明**：早期仅凭官网"下載場景 / streams in"曾推测原版用 GLB 城市模型；但工作区证据（`BufferGeometryUtils`=合批、`tilePool`/`regionTiles`=分块流式、`worldData.json`=数据驱动、且包内无 GLB 城市加载）表明：**原版实质是"数据驱动 + 程序化几何 + 分块流式加载"**——与本项目的程序化路线同源，只是原版把生成结果按 tile 分块、按需从服务器流式拉取，规模覆盖全台北。



