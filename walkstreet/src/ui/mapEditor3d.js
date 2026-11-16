// 3D 地图编辑器：Three.js 场景内描边生成道路/河流/建筑、放置树/路灯、
// Gizmo 移动旋转缩放；可选 Cesium 地球作为底图（相机同步 + 局部米坐标桥）。
// 与 2D 编辑器共享同一份地图数据（schema v2 的 features/objects/origin）。

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { dropAt, bendGeometry } from "../config/curvature.js";
import { EXT_STEP_X, EXT_STEP_Z, extRoadSpec, genConfig, asphaltHalf, corridorHalf } from "../data/cityData.js";
import { areaPoly, clipAxisLine, worldBounds, polyCenterLine } from "../world/customMap.js";
import { GRID_OPACITY_DEFAULT, ORIGIN_DEFAULT } from "../data/mapStore.js";
import { genParamsHtml, bindGenParams } from "./genParams.js";
import { clamp, uid, fmtDist, ROAD_KINDS, ROAD_KIND_ZH, lonLatAt, polyArea, polylineLen, smoothPath } from "./editor3d/util.js";
import {
  initCesium, toggleBasemap, applyBasemap, rebuildBasemap,
  applyImageryVis, resizeCesium, syncFrustum, updateEnu,
  syncCesiumCamera, renderCesiumSync,
} from "./editor3d/cesium.js";
import {
  layerDefs, toggleLayers, openLayers, closeLayers, setLayerVis, applyLayerVis,
  settingsSections, wireOriginSearch, toggleSettings, openSettings, closeSettings,
} from "./editor3d/panels.js";
import {
  startMeasure, endMeasure, clearMeasure, measureAddPoint, finishMeasure,
  renderMeasurePanel, updateMeasureLive, renderMeasureResult,
  buildMeasureGroup, measureLabel,
} from "./editor3d/measure.js";
import {
  fatLine, roadRibbon,
  matRoad, matRiver, matBuilding, matRoof, stripGeometry,
  buildRoadMesh, buildRiverMesh, buildBuildingMesh, buildTreeMesh, buildLampMesh, buildObjectMesh,
} from "./editor3d/meshes.js";
import {
  rtGhostState, rtUpdateGhost, rtPlace, rtStart, rtLeave, rtMarkDirty, rtDisposeGhost, rtRenderPanel,
  rtRebuildOne, rtRebuildGroup, buildRoadTileMesh, TILE_STYLE_ZH, rtRoadGroupOf, tilePorts, rtSetMode,
} from "./editor3d/roadTiles.js";
import { rtMiters, RT_PAIR_TOL } from "../world/customMap.js";
import { MOUNTS, normalizeSpec, buildBillboardGroup, editorGhostMaterial } from "../world/billboard/mounts.js";
import {
  collectConstraints, footprintOf, snapPlacement, validatePlacement,
  resolvePlacement, reasonText,
} from "../world/billboard/placement.js";
import {
  BB_COLORS, createFootprintBoundary, updateFootprintBoundary, disposeFootprintBoundary,
} from "./editor3d/billboardBoundary.js";
import { openBillboardContent } from "./editor3d/billboardContent.js";
import { listMaterials } from "../world/materials.js";
import { listAssets, getAsset, getAssetRecordSync, putAsset, inferPlaceSize, createAssetFromTraced } from "../data/assetStore.js";
import { getAssetTemplateIfReady, warmAssetTemplate, assetInstance, updateAssetAnimations, tracedUnitSize, invalidateAssetTemplate } from "../world/assetMesh.js";
import { ensureBillboardAssets, billboardParamsFor, createAssetFromBillboard } from "../data/billboardAsset.js";
import { billboardItemFromRecord } from "../world/billboard/billboardAssetBridge.js";

export class MapEditor3d {
  // opts: { map, onSave(data)=>bool, onPlay(), onClose() }
  constructor(opts) {
    this.opts = opts;
    this.map = opts.map;
    this.tool = "select";
    this.draft = null;        // { points: [{x,z}] } 绘制中的折线/多边形
    this.sel = null;          // { kind, data, root, meshes }
    this.undoStack = [];
    this._assetCache = new Map();   // 模型资产记录缓存（assetId → record，放置/属性面板用）
    this._assetFetchPending = new Set();
    this.redoStack = [];
    this._raf = 0;
    this._cesium = null;
    this._disposed = false;
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._snap = 5;
    this._dirty = false;
    // 广告大屏放置：模型资产引用（几何来自资产库）+ 实例覆盖 + 路缘吸附 / 幽灵边界
    this._bbAsset = null;          // 当前选中的广告牌模型资产（资产库记录）
    this._bbAssets = [];           // 资产库里的广告牌模型列表
    this._bbDraft = { mount: "standalone", ...MOUNTS.standalone.defaults, autoSnap: true };
    this._bbSnapOn = true;
    this._bbConstraints = null;
    this._bbGhostKey = "";
    this._bbLastPlace = null;
    this._bbLastStatus = "";
    this._bbLastEvent = null;
    // 路块拼接工具状态（实现见 ui/editor3d/roadTiles.js）
    this._rtLen = 20;         // 路块长度（米）= 链式放置时每步前进的距离
    this._rtW = 10;           // 路块宽度（米，最小 6）
    this._rtStep = 15;        // 角度步进（度，0 = 自由）
    this._rtStyle = "dash";   // 贴图样式
    this._rtLanes = 1;        // 每方向车道数（影响贴图车道分隔线）
    this._rtChain = null;     // 链条粘滞端口 { x, z }（放置后 = 新块出口）
    this._rtMode = "place";   // 路块工具子模式：place = 添加（幽灵放置），edit = 编辑已放路块/整条路
    this._rtPin = null;       // 自由放置落钉点 { x, z }（两段式：落点 → 瞄准 → 放置）
    this._rtGhostState = null; // 幽灵路块状态
    this._rtYaw = 0;          // 自由放置时的上次方向
    this._rtPortsDirty = true; // 空闲端口缓存脏标记
    this._rtFreePorts = null;
    this._rtLastRef = null;    // 自由放置时的方向参考点（上次块中心）
    this._rtLastMovePt = null; // 上次光标世界坐标（判定光标是否真正移动）
    this._rtOpIds = [];        // 本次链条操作放置的路块 id（一键清空只删这些，不影响之前加的路）
    this._measureResult = null; // 上次测距结果 { points: [{x,z}], length }
    this._cesiumOn = localStorage.getItem("tr_e3_basemap") !== "0"; // 记住上次选择
    // 图层显隐状态（图层控制面板）：默认全开；持久化用 v2 键，
    // 旧键 tr_e3_layers 里存有旧版勾选失效期间写入的错误状态，弃用不读
    this._layerVis = { base: true, img: true, anno: true, area: true, skeleton: true, road: true, river: true, roadTile: true, object: true, origin: true, measure: true };
    try { Object.assign(this._layerVis, JSON.parse(localStorage.getItem("tr_e3_layers_v2") || "{}")); } catch { /* 忽略脏数据 */ }
    // 顶栏按钮等是 index.html 里的单例 DOM：监听挂到本实例 controller 上，
    // close() 一次性摘除。否则旧实例仍绑在同一个「保存」按钮上，保存时会把
    // 上一张地图按当前名称输入框的内容再写一遍（表现为另一张地图被改名）。
    this._ac = new AbortController();
    this._sig = { signal: this._ac.signal };
  }

  /* ---------------- lifecycle ---------------- */
  async open() {
    const root = document.getElementById("map-editor3d");
    root.classList.remove("hidden");
    document.getElementById("e3-name").value = this.map.name || "";
    window.__e3 = this; // dev 调试句柄（同 cesium.js 约定）

    this._initThree();
    this._initUI();
    this._rebuildAll();
    this._applyLayerVis(); // 应用记忆中的图层面板显隐（含 Cesium 就绪前的 Three 侧）
    this._pushUndo("打开编辑器");
    try {
      await this._initCesium(); // 失败不影响编辑（仅无底图）
    } catch (e) {
      console.warn("[editor3d] Cesium 底图加载失败：", e);
      this.status("Cesium 底图不可用（可继续编辑）");
    }
    this._loop();
  }

  close() {
    this._disposed = true;
    cancelAnimationFrame(this._raf);
    if (this._ac) { this._ac.abort(); this._ac = null; } // 摘除本实例在单例 DOM 上的全部监听
    if (this._three) {
      const { tc, scene } = this._three;
      try { tc.dispose(); } catch { /* three r169 dispose 内部 bug（r170 修复），忽略 */ }
      scene.remove(tc.getHelper());
      this._three.orbit.dispose();
      this._three.renderer.dispose();
      this._three.canvas.remove();
    }
    if (this._cesium) {
      try { this._cesium.viewer.destroy(); } catch { /* 忽略 */ }
      this._cesium = null;
    }
    if (this._labelTex) { // 测距标注贴图缓存（材质 dispose 不会释放贴图）
      for (const t of this._labelTex.values()) t.dispose();
      this._labelTex.clear();
    }
    rtDisposeGhost(this); // 路块幽灵网格（非 entityRoot，不在 _rebuildAll 清理范围）
    if (this._assetGhost) { // 模型幽灵盒（同上）
      if (this._three) this._three.scene.remove(this._assetGhost);
      this._assetGhost.geometry.dispose();
      this._assetGhost.material.dispose();
      this._assetGhost = null;
    }
    this._disposeBBGhost();
    disposeFootprintBoundary(this._bbBoundary);
    this._bbBoundary = null;
    window.removeEventListener("resize", this._onResize);
    window.removeEventListener("keydown", this._onKey);
    if (this._compassEl) {
      this._compassEl.remove();
      this._compassEl = this._compassRose = this._compassTxt = null;
    }
    if (this._layersBtn) { this._layersBtn.remove(); this._layersBtn = null; }
    if (this._layersPop) { this._layersPop.remove(); this._layersPop = null; }
    if (this._onLayersOutside) {
      document.removeEventListener("pointerdown", this._onLayersOutside, true);
      this._onLayersOutside = null;
    }
    if (this._onSettingsOutside) {
      document.removeEventListener("pointerdown", this._onSettingsOutside, true);
      this._onSettingsOutside = null;
    }
    document.getElementById("map-editor3d").classList.add("hidden");
  }

  status(t) { document.getElementById("e3-status").textContent = t; }

  /* ---------------- three.js ---------------- */
  _initThree() {
    const vp = document.getElementById("e3-viewport");
    const canvas = document.createElement("canvas");
    canvas.id = "e3-canvas";
    vp.appendChild(canvas);

    // 罗盘：实时显示视线方位角（0°=正北，顺时针，地理约定与 lonLatAt 一致）；
    // 单击一键复位视角（正南方俯瞰范围中心的默认机位）
    const compass = document.createElement("div");
    compass.className = "e3-compass";
    compass.title = "视线方位角（0°=正北）· 点击一键复位视角";
    compass.innerHTML =
      '<div class="e3-compass-rose"><b class="n">N</b><b class="e">E</b><b class="s">S</b><b class="w">W</b></div>' +
      '<span class="e3-compass-txt"></span>';
    vp.appendChild(compass);
    this._compassEl = compass;
    this._compassRose = compass.querySelector(".e3-compass-rose");
    this._compassTxt = compass.querySelector(".e3-compass-txt");
    compass.addEventListener("click", () => this._resetView());

    // 图层控制：视口右侧（罗盘下方）按钮 + 弹出面板，开关底图影像层与场景内容层
    const layersBtn = document.createElement("button");
    layersBtn.type = "button";
    layersBtn.className = "e3-layer-btn";
    layersBtn.title = "图层控制：查看并开关各图层";
    layersBtn.innerHTML = "<i>▤</i>"; // 仅图标，不显示文字
    vp.appendChild(layersBtn);
    this._layersBtn = layersBtn;
    layersBtn.addEventListener("click", () => this._toggleLayers());

    const layersPop = document.createElement("div");
    layersPop.className = "e3-layers-pop hidden";
    vp.appendChild(layersPop);
    this._layersPop = layersPop;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.shadowMap.enabled = true;

    const scene = new THREE.Scene();
    scene.background = null; // 透出 Cesium
    // 不用雾：雾会把远处网格/内容"洗"进背景，且与未受雾的 Cesium 影像不一致，
    // 造成拉远视角后地图范围逐渐消失
    const camera = new THREE.PerspectiveCamera(55, 1, 0.5, 50000);
    // 初始机位在正南方（+Z=南），看向范围中心：屏幕上方 = 北（-Z）、右 = 东（+X），
    // 与 2D 编辑器及地理方位角一致（此前机位偏东南，网格整体看起来右斜约 30-45°）
    camera.position.set(0, 140, 260);

    scene.add(new THREE.HemisphereLight(0xbfd6ff, 0x36404a, 0.9));
    const sun = new THREE.DirectionalLight(0xfff2d8, 1.2);
    sun.position.set(300, 500, 200);
    scene.add(sun);

    // 工作地面：淡网格 + 半透明底板（Cesium 影像透出时底板压暗）。
    // 两者置于 areaGroup（可选中：Gizmo 拖拽调整地图范围）；
    // 网格体按范围形态（矩形/描边多边形）由 _rebuildAreaMeshes 动态构建，
    // 顶点按"以区域中心为基准的曲率差分"下沉，与球面影像透视一致
    const areaGroup = new THREE.Group();
    areaGroup.userData.isArea = true;
    scene.add(areaGroup);

    // 程序化城市骨架叠加（2D 编辑器管理的数据：纵横路网/地标/出生点），
    // 仅显示不可选中 —— 与 2D 编辑器看到的是同一份内容
    this._skeleton = new THREE.Group();
    scene.add(this._skeleton);

    const orbit = new OrbitControls(camera, canvas);
    orbit.enableDamping = true;
    orbit.maxPolarAngle = Math.PI / 2.05;
    orbit.target.set(0, 0, 0);
    orbit.screenSpacePanning = false;

    const raycaster = new THREE.Raycaster();
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    const tc = new TransformControls(camera, canvas);
    tc.addEventListener("dragging-changed", (e) => { orbit.enabled = !e.value; });
    tc.addEventListener("objectChange", () => {
      if (this.sel && this.sel.kind === "area") this._syncAreaFromGroup(); // 拖拽中实时重烘焙曲率
      this._dirty = true;
    });
    tc.addEventListener("mouseUp", () => {
      this._syncGizmoToData(true);
      this._pushUndo("变换");
      // Gizmo 旋转/缩放后同步属性面板数值（旋转角度等）
      if (this.sel && this.sel.kind === "object" && this.sel.data && this.sel.data.type === "asset") this._renderProps();
    });
    scene.add(tc.getHelper()); // r169 起 TransformControls 不再是 Object3D，需加 helper
    // Gizmo 永远画在最上层：锚点常落在建筑/道路内部，被自身体积挡住就没法拖
    tc.getHelper().traverse((o) => {
      if (o.material) { o.material.depthTest = false; o.material.transparent = true; }
    });
    // 选中高亮框：标出当前选中物件（建筑等）的包围盒，弥补 Gizmo 小、建筑大的识别问题
    this._selHelper = new THREE.BoxHelper(undefined, 0xffc24d);
    this._selHelper.material.depthTest = false;
    this._selHelper.material.transparent = true;
    this._selHelper.visible = false;
    scene.add(this._selHelper);

    this._three = { renderer, scene, camera, canvas, raycaster, groundPlane, orbit, tc, areaGroup };
    this._initOriginMarkers();
    this._initArea();
    this._resize();
    this._onResize = () => this._resize();
    window.addEventListener("resize", this._onResize, this._sig);

    // pointer events（绘制 / 选择）
    canvas.addEventListener("pointerdown", (e) => this._onDown(e));
    canvas.addEventListener("pointermove", (e) => this._onMove(e));
    canvas.addEventListener("dblclick", () => this._finishDraft());
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  _resize() {
    const vp = document.getElementById("e3-viewport");
    const { renderer, camera } = this._three;
    const w = vp.clientWidth || 800, h = vp.clientHeight || 500;
    renderer.setSize(w, h, false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // 胖线（Line2）线宽按屏幕像素换算，resize 后同步分辨率
    const size = renderer.getSize(new THREE.Vector2());
    this._three.scene.traverse((o) => {
      if (o.userData && o.userData.fatLine) o.material.resolution.set(size.x, size.y);
    });
    this._resizeCesium();
    this._syncFrustum();
  }

  // Cesium 桥接方法：实现见 ui/editor3d/cesium.js（以编辑器实例为上下文）
  _resizeCesium() { resizeCesium(this); }

  _syncFrustum() { syncFrustum(this); }

  _loop() {
    const tick = () => {
      if (this._disposed) return;
      this._raf = requestAnimationFrame(tick);
      const { orbit, camera, renderer, scene, tc } = this._three;
      orbit.update();
      if (tc.dragging) this._syncGizmoToData();
      if (this._selHelper && this._selHelper.visible && this.sel) this._selHelper.setFromObject(this.sel.root); // 高亮框跟随选中物
      this._clock = this._clock || new THREE.Clock();
      updateAssetAnimations(this._clock.getDelta()); // 资产内建动画（如小火车）
      this._updateDraftPreview();
      this._updateRoadCenterlines();
      this._updateCompass();
      this._syncCesiumCamera();
      renderer.render(scene, camera);
      // 底图与网格在同一 RAF 回调内先后渲染，两层 canvas 携带同一帧相机姿态；
      // 出错只停用底图，不能让异常中断编辑器自身的渲染循环
      if (this._cesium && this._cesiumOn) {
        try {
          this._renderCesiumSync();
        } catch (e) {
          console.warn("[editor3d] Cesium 渲染失败，已停用底图：", e);
          this._cesiumOn = false;
          this._applyBasemap();
        }
      }
    };
    tick();
  }

  /* ---------------- cesium base map ---------------- */
  async _initCesium() { await initCesium(this); }

  _toggleBasemap() { toggleBasemap(this); }

  _applyBasemap() { applyBasemap(this); }

  _rebuildBasemap() { rebuildBasemap(this); }

  /* ---------------- 图层控制 / 设置面板 ---------------- */
  // 面板实现见 ui/editor3d/panels.js（以编辑器实例为上下文）
  _layerDefs() { return layerDefs(this); }

  _toggleLayers() { toggleLayers(this); }

  _openLayers() { openLayers(this); }

  _closeLayers() { closeLayers(this); }

  _setLayerVis(key, on) { setLayerVis(this, key, on); }

  // 统一应用显隐：影像层 + 场景分组 + 实体 wrapper（重建后由各创建点单独重设）
  _applyLayerVis() { applyLayerVis(this); }

  _applyImageryVis() { applyImageryVis(this); }

  // 设置面板：分节渲染（图源 / 地图位置搜索 / 测量入口），实现见 ui/editor3d/panels.js
  _settingsSections() { return settingsSections(this); }

  _wireOriginSearch(el) { wireOriginSearch(this, el); }

  _toggleSettings() { toggleSettings(this); }

  _openSettings() { openSettings(this); }

  _closeSettings() { closeSettings(this); }

  _updateEnu() { updateEnu(this); }

  /* ---------------- map area（网格/底板范围） ---------------- */
  // 两种形态：
  //   矩形   { cx, cz, w, d, rot }        —— 中心 + 宽深（米）+ 水平旋转（弧度），旧数据兼容；
  //   多边形 { cx, cz, pts: [[x,z]...] }  —— 在底图上描边绘制的任意范围，cx/cz 为顶点均值中心。
  // 矩形几何固定 4000×4000 靠 Group.scale 表达；多边形按顶点直接构建（Group 恒为单位变换）。
  // 曲率以"区域中心为基准的差分"烘焙进顶点，拖拽/重绘后重算保持贴合球面。
  // 不变式：改边界（描边/换形态/拖拽多边形）不搬移内容 —— 中心迁移量补偿进 origin，
  // 使任意局部点 (x,z) 的经纬映射 lonLatAt(origin, area, x, z) 保持不变。
  _isPolyArea(a = this.map.area) {
    return !!(a && Array.isArray(a.pts) && a.pts.length >= 3);
  }

  // 多边形顶点包围盒中心 → 中心（cx/cz）：视觉上处于网格范围中部（锚点/Gizmo 所在）
  _areaCenter(pts) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of pts) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    return { cx: Math.round((minX + maxX) / 2), cz: Math.round((minZ + maxZ) / 2) };
  }

  // 中心迁移 (dcx, dcz) 时补偿 origin，保持内容经纬映射不变（见上方不变式注释）
  _shiftOrigin(dcx, dcz) {
    if (!dcx && !dcz) return;
    const k = M_PER_DEG_LAT * Math.cos((this.map.origin.lat * Math.PI) / 180);
    this.map.origin = {
      lat: this.map.origin.lat - dcz / M_PER_DEG_LAT,
      lon: this.map.origin.lon + dcx / k,
    };
  }

  _areaEnsure() {
    let a = this.map.area;
    if (a && Array.isArray(a.pts)) {
      if (a.pts.length >= 3) {
        if (!Number.isFinite(a.cx) || !Number.isFinite(a.cz)) Object.assign(a, this._areaCenter(a.pts));
        return a;
      }
      delete a.pts; // 点数不足，回退矩形
    }
    a = this.map.area || (this.map.area = {});
    a.cx = a.cx || 0; a.cz = a.cz || 0;
    a.w = clamp(a.w || 4000, 200, 20000);
    a.d = clamp(a.d || 4000, 200, 20000);
    a.rot = a.rot || 0;
    return a;
  }

  _initArea() {
    this._areaEnsure();
    this._rebuildAreaMeshes();
    this._applyAreaToGroup();
    this._bendArea();
  }

  // 数据 → Group 变换（网格体本身由 _rebuildAreaMeshes 构建）
  // 两种形态的 Group 都定位在中心：Gizmo 锚点恒为范围中心
  _applyAreaToGroup() {
    const a = this._areaEnsure();
    const g = this._three.areaGroup;
    g.position.set(a.cx, 0, a.cz);
    if (this._isPolyArea(a)) {
      g.rotation.set(0, 0, 0); // 多边形不支持旋转/缩放，几何按中心相对坐标构建
      g.scale.set(1, 1, 1);
    } else {
      g.rotation.set(0, a.rot, 0);
      g.scale.set(a.w / 4000, 1, a.d / 4000);
    }
    g.updateMatrixWorld(true);
  }

  // 重建范围内的网格体（初始化、描边重绘、形态切换、撤销恢复后调用）
  _rebuildAreaMeshes() {
    const g = this._three.areaGroup;
    for (const c of g.children.slice()) {
      g.remove(c);
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    }
    const a = this._areaEnsure();
    if (this._isPolyArea(a)) {
      // 几何按中心相对坐标构建（Group 恒在中心=Gizmo 锚点），平移不变、拖拽无需重建；
      // 曲率/网格裁剪仍按绝对坐标计算
      const ox = a.cx, oz = a.cz;
      const pts = a.pts.map(([x, z]) => ({ x: x - ox, z: z - oz }));
      const abs = a.pts.map(([x, z]) => ({ x, z }));
      // 底板：多边形三角化（曲率下沉由 _bendArea 统一处理）
      const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, -p.z)));
      const plate = new THREE.Mesh(
        new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x0d141c, transparent: true, opacity: 0.55, depthWrite: false }),
      );
      plate.userData.areaGrid = true; // 参与网格浓度调节
      plate.userData.baseOpacity = 0.55;
      // 描边：屏幕空间胖线（线宽恒定像素，任意视角/距离都清晰，不受雾影响）。
      // 深色衬底 + 亮金主线（casing），亮/暗影像上都清晰可辨
      const closed = [...abs, abs[0]];
      const casing = this._fatLine(closed, 10, 0x0b1220, 0.85, 0.04, ox, oz);
      casing.renderOrder = 1;
      const outline = this._fatLine(closed, 5, 0xffd76a, 1, 0.06, ox, oz);
      outline.renderOrder = 2;
      g.add(plate, casing, outline, ...this._buildPolyGrid(abs, ox, oz));
    } else {
      const grid = new THREE.GridHelper(4000, 200, 0x3a4a5c, 0x22303e);
      grid.userData.lift = 0.02;
      grid.userData.areaGrid = true; // 参与网格浓度调节
      grid.userData.baseOpacity = 1;
      const plate = new THREE.Mesh(
        new THREE.PlaneGeometry(4000, 4000, 64, 64).rotateX(-Math.PI / 2), // 分段才能呈现球面弯曲
        new THREE.MeshBasicMaterial({ color: 0x0d141c, transparent: true, opacity: 0.55, depthWrite: false }),
      );
      plate.userData.areaGrid = true;
      plate.userData.baseOpacity = 0.55;
      g.add(grid, plate);
    }
    this._applyGridOpacity();
    g.updateMatrixWorld(true);
  }

  // 网格层浓度（map.gridOpacity 1=默认 → 0=完全透出底图影像）：底板/网格线
  // 按各自基准透明度等比缩放，金色边界描边不受影响（调淡后仍保留范围轮廓）
  _applyGridOpacity() {
    const k = this.map.gridOpacity ?? GRID_OPACITY_DEFAULT;
    for (const c of this._three.areaGroup.children) {
      if (!c.userData.areaGrid || !c.material) continue;
      c.material.transparent = true;
      c.material.opacity = (c.userData.baseOpacity ?? 1) * k;
    }
  }

  // 屏幕空间胖线 / 世界宽度路带（实现见 ui/editor3d/meshes.js）
  _fatLine(pts, widthPx, colorHex, opacity, lift, ox = 0, oz = 0) {
    return fatLine(this, pts, widthPx, colorHex, opacity, lift, ox, oz);
  }

  _roadRibbon(pts, halfW, colorHex, opacity) { return roadRibbon(this, pts, halfW, colorHex, opacity); }

  // 多边形内网格线：逐条与多边形边界求交，取内部区段（20m 细线 / 100m 粗线，同矩形网格密度）。
  // 顶点按 (ox, oz) 相对存储，y 置 0 由 _bendArea 按世界坐标统一下沉
  _buildPolyGrid(pts, ox = 0, oz = 0) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    let step = 20;
    while ((maxX - minX + maxZ - minZ) / step > 4000) step *= 2; // 超大范围自动降密度
    const minor = [], major = [];
    // 与多边形求交：返回直线 fixed 在多边形内部的区段 [起, 止]（horiz=false 竖线 x=fixed）
    const segsAt = (fixed, horiz) => {
      const ts = [];
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[(i + 1) % pts.length];
        const pf = horiz ? p.z : p.x, qf = horiz ? q.z : q.x;
        if ((pf <= fixed) !== (qf <= fixed)) {
          const t = (fixed - pf) / (qf - pf);
          ts.push((horiz ? p.x : p.z) + t * ((horiz ? q.x : q.z) - (horiz ? p.x : p.z)));
        }
      }
      ts.sort((x, y) => x - y);
      const segs = [];
      for (let i = 0; i + 1 < ts.length; i += 2) segs.push([ts[i], ts[i + 1]]);
      return segs;
    };
    for (let v = Math.ceil(minX / step) * step; v <= maxX; v += step) {
      const arr = Math.round(v / step) % 5 === 0 ? major : minor;
      for (const [s, e] of segsAt(v, false)) arr.push(v - ox, 0, s - oz, v - ox, 0, e - oz);
    }
    for (let v = Math.ceil(minZ / step) * step; v <= maxZ; v += step) {
      const arr = Math.round(v / step) % 5 === 0 ? major : minor;
      for (const [s, e] of segsAt(v, true)) arr.push(s - ox, 0, v - oz, e - ox, 0, v - oz);
    }
    const mk = (verts, color) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
      const ls = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color }));
      ls.userData.lift = 0.02;
      ls.userData.areaGrid = true; // 参与网格浓度调节
      ls.userData.baseOpacity = 1;
      return ls;
    };
    const out = [];
    if (minor.length) out.push(mk(minor, 0x22303e));
    if (major.length) out.push(mk(major, 0x3a4a5c));
    return out;
  }

  // Group 变换 → 数据（Gizmo 拖拽反读），随后重烘焙曲率。
  // 中心位移时 origin（= 中心经纬度）随之平移：地图在地球上整体搬移。
  // force=true 时同时重建道路/物件（拖拽中轻量刷新，松手/数值编辑后重建）。
  _syncAreaFromGroup(force) {
    const a = this._areaEnsure();
    const g = this._three.areaGroup;
    if (this._isPolyArea(a)) {
      // 多边形：Gizmo 拖拽整体平移。几何按中心相对坐标构建、Group 恒在中心，
      // 拖拽手感与矩形一致（数据每帧跟随指针，无位置回弹）；不支持旋转/缩放
      g.rotation.set(0, 0, 0);
      g.scale.set(1, 1, 1);
      const ncx = Math.round(g.position.x);
      const ncz = Math.round(g.position.z);
      const dx = ncx - a.cx, dz = ncz - a.cz;
      if (dx || dz) {
        a.pts = a.pts.map(([x, z]) => [Math.round((x + dx) * 10) / 10, Math.round((z + dz) * 10) / 10]);
        a.cx = ncx;
        a.cz = ncz;
        this._shiftOrigin(dx, dz);
        if (force) this._rebuildAll(); // 曲率零基准随中心变化，重建内容网格
        this._updateEnu(); // ENU 原点=新中心经纬，锚点标记/相机桥同步
        this._updateOriginLabel();
      }
      this._applyAreaToGroup();
      this._bendArea();
      this._dirty = true;
      return;
    }
    const newCx = Math.round(g.position.x);
    const newCz = Math.round(g.position.z);
    const dLat = (-newCz - -a.cz) / M_PER_DEG_LAT;
    const dLon = (newCx - a.cx) / (M_PER_DEG_LAT * Math.cos((this.map.origin.lat * Math.PI) / 180));
    this.map.origin = {
      lat: this.map.origin.lat + dLat,
      lon: this.map.origin.lon + dLon,
    };
    a.cx = newCx;
    a.cz = newCz;
    a.rot = Math.round(g.rotation.y * 1000) / 1000;
    a.w = clamp(Math.round(4000 * Math.abs(g.scale.x)), 200, 20000);
    a.d = clamp(Math.round(4000 * Math.abs(g.scale.z)), 200, 20000);
    g.rotation.x = g.rotation.z = 0; // 仅保留水平旋转
    g.scale.y = 1;
    this._applyAreaToGroup();
    this._bendArea();
    if (force) this._rebuildAll(); // 曲率零基准随中心变化，重建内容网格
    this._updateEnu(); // ENU 原点=新中心经纬，锚点标记/相机桥同步
    this._updateOriginLabel();
    this._dirty = true;
  }

  // 曲率下沉量（相对范围中心为零基准）：中心贴椭球面，边缘相对下垂
  _curveOffset(x, z) {
    const a = this.map.area || { cx: 0, cz: 0 };
    return dropAt(x, z) - dropAt(a.cx, a.cz);
  }

  // 曲率差分：局部顶点 y = lift - curveOffset(世界x,z)，Group 贴椭球面（y=0）；
  // lift 区分叠放层次（网格 0.02 / 描边 0.05）；
  // 锚点立柱同步移到范围中心（= 地图在地球上的位置）
  _bendArea() {
    const g = this._three.areaGroup;
    g.position.y = 0;
    g.updateMatrixWorld(true);
    const a = this._areaEnsure();
    if (this._originMarker) this._originMarker.position.set(a.cx, 0, a.cz);
    const v = new THREE.Vector3();
    for (const obj of g.children) {
      const pos = obj.geometry.attributes.position;
      if (!pos) continue; // 胖线（Line2）等非普通网格体：曲率已烘焙进端点，跳过
      const lift = obj.userData.lift || 0;
      for (let i = 0; i < pos.count; i++) {
        v.set(pos.getX(i), 0, pos.getZ(i)).applyMatrix4(g.matrixWorld);
        pos.setY(i, lift - this._curveOffset(v.x, v.z));
      }
      pos.needsUpdate = true;
    }
  }

  // 选中地图范围（工具入口），供 Gizmo 调整
  _selectArea() {
    this._areaEnsure();
    this._applyAreaToGroup();
    this._select({ kind: "area", root: this._three.areaGroup, data: this.map.area });
  }

  // 锚点可视标记：Three 侧原点立柱+圆环（锚点=局部原点，恒在 0,0）；
  // Cesium 侧金色点+标签（随 origin 在地球上移动）。任一侧修改锚点后自动对齐。
  _initOriginMarkers() {
    const g = new THREE.Group();
    const gold = new THREE.MeshBasicMaterial({ color: 0xf2c14e });
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 60, 8), gold);
    pole.position.y = 30;
    const tip = new THREE.Mesh(new THREE.SphereGeometry(1.4, 12, 10), gold);
    tip.position.y = 60;
    const ring = new THREE.Mesh(new THREE.RingGeometry(5, 6.5, 40), new THREE.MeshBasicMaterial({ color: 0xf2c14e, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.3;
    g.add(pole, tip, ring);
    g.renderOrder = 5;
    this._originMarker = g;
    this._three.scene.add(g);
  }

  // Three(局部米) → Cesium ECEF 相机同步 + 同帧渲染（实现见 ui/editor3d/cesium.js）
  _syncCesiumCamera() { syncCesiumCamera(this); }

  _renderCesiumSync() { renderCesiumSync(this); }

  // 切换工具并同步左侧工具栏高亮
  _setTool(t) {
    this.tool = t;
    document.querySelectorAll("#e3-tools .e3-tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === t));
    this._syncRoadToolUI();
    if (t !== "place-road") rtLeave(this); // 离开路块工具：清链条 + 藏幽灵（工具间来回切保留链不做，简单一致）
    if (t !== "place-asset") this._hideAssetGhost();
    if (t !== "place-billboard") this._hideBBGhost();
  }

  // 左侧「道路」按钮显示当前子模式（道路 / 地图描边 / 添加纵路 / 添加横路 / 路块拼接），子菜单高亮当前项
  _syncRoadToolUI() {
    const btn = document.querySelector('#e3-tools [data-tool="draw-road"]');
    const span = btn && btn.querySelector("span");
    if (span) span.textContent = { "draw-road": "地图描边", "add-roadX": "添加纵路", "add-roadZ": "添加横路", "place-road": "路块拼接" }[this.tool] || "道路";
    if (btn) btn.classList.toggle("active", ["draw-road", "add-roadX", "add-roadZ", "place-road"].includes(this.tool)); // 任一子模式激活时高亮「道路」按钮
    if (this._roadSub) this._roadSub.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.tool === this.tool));
  }

  // 地图定位：进入拾取模式，下一次点击处成为范围中心（= 地图在地球上的位置）
  _setOriginPickMode() {
    this._select(null);
    this._discardDraft();
    this._setTool("set-origin");
    this.status("地图定位：点击地图任意位置，该处将作为范围中心（Esc 取消）");
  }

  _setOriginAt(pt) {
    // 点击处成为范围中心：origin=点击处经纬度，中心移到点击处，内容在地球上整体搬移
    const { lat, lon } = lonLatAt(this.map.origin, this.map.area, pt.x, pt.z);
    this.map.origin = { lat, lon };
    const a = this._areaEnsure();
    const ncx = Math.round(pt.x), ncz = Math.round(pt.z);
    if (this._isPolyArea(a)) {
      const dx = ncx - a.cx, dz = ncz - a.cz; // 多边形：整体平移顶点
      a.pts = a.pts.map(([x, z]) => [x + dx, z + dz]);
      this._rebuildAreaMeshes();
    }
    a.cx = ncx;
    a.cz = ncz;
    this._applyAreaToGroup();
    this._bendArea();
    this._rebuildAll(); // 曲率零基准变化，重建内容
    this._updateEnu();
    this._dirty = true;
    this._updateOriginLabel();
    this.status(`地图已定位到 ${lat.toFixed(6)}, ${lon.toFixed(6)}（范围中心）· 记得保存`);
  }

  // 应用手动输入的经纬度（设置面板/地名搜索调用）：设定范围中心的经纬度
  _setOriginLL(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      this.status("经纬度无效（纬度 ±90 / 经度 ±180）");
      return false;
    }
    if (this.tool === "set-origin") this._setTool("select"); // 应用坐标即结束拾取模式
    this.map.origin = { lat, lon };
    this._updateEnu();
    this._dirty = true;
    this._updateOriginLabel();
    this.status(`地图已定位到 ${lat.toFixed(6)}, ${lon.toFixed(6)}（范围中心）`);
    return true;
  }

  _updateOriginLabel() {
    const el = document.getElementById("e3-origin");
    if (!el) return;
    const t = this._three.orbit.target;
    const { lat, lon } = lonLatAt(this.map.origin, this.map.area, t.x, t.z);
    el.textContent = `中心 ${this.map.area.cx},${this.map.area.cz} · 视点 ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  }

  /* ---------------- picking / tools ---------------- */
  _ndc(e) {
    const rect = this._three.canvas.getBoundingClientRect();
    return new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }
  _groundPoint(e, noSnap = false) {
    this._three.raycaster.setFromCamera(this._ndc(e), this._three.camera);
    const ray = this._three.raycaster.ray;
    const hit = new THREE.Vector3();
    // 地面已按曲率弯曲（y = -dropAt(x,z) 抛物面）：先与 y=0 平面求交，
    // 再用交点处的下沉量更新平面高度迭代两次，收敛到 <1cm 误差
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    if (!ray.intersectPlane(plane, hit)) return null;
    for (let i = 0; i < 2; i++) {
      plane.constant = dropAt(hit.x, hit.z);
      if (!ray.intersectPlane(plane, hit)) return null;
    }
    // 描边绘制中（草稿激活）绕过网格吸附：吸附会把弯路量化成锯齿台阶，严重走形；
    // 路块拼接同样绕过：位置由端口磁吸决定，网格量化会破坏端口对齐
    const snap = !noSnap && !this.draft && this.tool !== "place-road" && this._snap > 0 ? this._snap : 0;
    return snap ? { x: Math.round(hit.x / snap) * snap, z: Math.round(hit.z / snap) * snap } : { x: hit.x, z: hit.z };
  }
  _pickObject(e) {
    this._three.raycaster.setFromCamera(this._ndc(e), this._three.camera);
    const meshes = [];
    for (const w of this._wrappers.values()) for (const m of w.pickMeshes) meshes.push(m);
    const hits = this._three.raycaster.intersectObjects(meshes, false);
    return hits.length ? { hit: hits[0], wrapper: this._byPick.get(hits[0].object) } : null;
  }

  // 拾取程序化道路：命中半径 = 道路半宽（corridorHalf）+4m，保底 10m，取最近
  _pickRoad(pt) {
    let best = null, bd = Infinity;
    const hit = (d, r) => d < Math.max(10, corridorHalf(r) + 4) && d < bd;
    for (const r of this.map.roadsX) {
      const d = Math.abs(pt.x - r.at);
      if (hit(d, r)) { bd = d; best = { kind: "roadX", obj: r }; }
    }
    for (const r of this.map.roadsZ) {
      const d = Math.abs(pt.z - r.at);
      if (hit(d, r)) { bd = d; best = { kind: "roadZ", obj: r }; }
    }
    return best;
  }

  // 选中程序化道路：挂到代理对象上供 Gizmo 拖动
  _selectRoad(hit) {
    if (!this._roadProxy) {
      this._roadProxy = new THREE.Object3D();
      this._three.scene.add(this._roadProxy);
    }
    if (hit.kind === "roadX") this._roadProxy.position.set(hit.obj.at, 0, 0);
    else this._roadProxy.position.set(0, 0, hit.obj.at);
    this._select({ kind: hit.kind, data: hit.obj, root: this._roadProxy });
    this.status("程序化道路 · Gizmo 拖动调整位置 · 右侧编辑属性 · Delete 删除");
  }

  _onDown(e) {
    if (e.button !== 0 || this._three.tc.dragging) return;
    const pt = this._groundPoint(e);
    if (!pt) return;
    if (this.tool === "draw-road") {
      if (!this.draft || !this.draft.road) this._startRoadTrace();
      this._traceAddPoint(pt, e);
    } else if (this.tool === "draw-river") {
      if (!this.draft) this.draft = { points: [] };
      this.draft.points.push(pt);
      this._updateDraftPreview();
    } else if (this.tool === "draw-building") {
      if (!this.draft) this.draft = { points: [] };
      this.draft.points.push(pt);
      this._updateDraftPreview();
    } else if (this.tool === "area" && this.draft && this.draft.area) {
      this.draft.points.push(pt); // 范围描边加点
      this.draft.redo = [];
      this._updateDraftPreview();
      this._renderAreaDraftPanel();
    } else if (this.tool === "place-road") {
      if (this._rtMode === "edit") { this._pickSelectAt(e, pt); return; } // 编辑模式：单击拾取路块 / 整条路
      this._roadTilePlace(e); // 放置/延续路块链（磁吸与方向已在幽灵状态里算好）
    } else if (this.tool === "place-tree" || this.tool === "place-lamp") {
      const type = this.tool === "place-tree" ? "tree" : "lamp";
      this._addObject({ id: uid(), type, pos: [pt.x, pt.z], rot: 0, params: {} });
      this._pushUndo("放置" + (type === "tree" ? "树木" : "路灯"));
    } else if (this.tool === "place-billboard") {
      const raw = this._groundPoint(e, true); // 原始光标点，先做路缘吸附再按网格取整
      if (!raw) return;
      const ctx = this._bbGetConstraints();
      const draft = this._bbDraftItem([raw.x, raw.z]);
      const sp = snapPlacement(raw, draft, ctx, { snapStep: this._snap, roadSnap: this._bbSnapOn });
      const v = validatePlacement(draft, ctx, sp.pos);
      if (!v.ok) {
        this.status(`无法放置：占位压到${reasonText(v.reasons)}，请移到青/金色边界内（红框为冲突）`);
        return;
      }
      // 地图只存资产引用 + 内容引用 + 实例覆盖；屏体几何从模型资产库读
      this._addObject({
        id: uid(), type: "billboard",
        assetId: this._bbAsset ? this._bbAsset.id : null,
        pos: sp.pos, rot: this._bbDefaultRot(),
        params: { override: this._bbOverrides(), content: null },
      });
      this._bbConstraints = null; // 新屏也是后续放置的障碍
      this._pushUndo("放置广告大屏");
      this.status(`已放置${MOUNTS[this._bbDraft.mount].label} · ${sp.onRoad ? "吸附路缘" : "网格吸附"} · 选中后可见真实占位边界 · Delete 删除`);
    } else if (this.tool === "place-asset") {
      if (!this._placingAsset) { this.status("请先在右侧「我的模型」中选择一个资产"); return; }
      const a = this._placingAsset;
      // GLB 按目标尺寸自动适配；描边建筑 / 广告牌是真实米模型，原尺寸放置（scale=1）
      const scale = this._assetPlaceScale(a);
      const sp = this._assetSnapPoint(pt); // 与幽灵预览同一吸附逻辑：所见即所得
      this._addObject({ id: uid(), type: "asset", assetId: a.id, pos: sp.pos, rot: 0, scale });
      this._pushUndo("放置模型资产");
      this.status(`已放置「${a.name}」· ${scale === 1 ? "原始尺寸" : `最大边适配为 ${this._assetPlaceTarget(a)}m`} · ${sp.onRoad ? "吸附路缘" : "网格吸附"}`);
    } else if (this.tool === "add-roadX" || this.tool === "add-roadZ") {
      const r = this.tool === "add-roadX"
        ? { id: uid(), zh: "新纵路", en: "New Rd", at: Math.round(pt.x), kind: "street", lanes: 1, median: 0, sidewalk: 3 }
        : { id: uid(), zh: "新横路", en: "New Rd", at: Math.round(pt.z), kind: "street", lanes: 1, median: 0, sidewalk: 3 };
      (this.tool === "add-roadX" ? this.map.roadsX : this.map.roadsZ).push(r);
      this._rebuildSkeleton();
      this._selectRoad({ kind: this.tool === "add-roadX" ? "roadX" : "roadZ", obj: r });
      this._pushUndo("添加道路");
      this.status("道路已添加 · Gizmo 拖动调整位置 · 右侧编辑属性");
    } else if (this.tool === "set-origin") {
      this._setOriginAt(pt); // 点击处成为范围中心（= 地图在地球上的落点）
      this._setTool("select");
    } else if (this.tool === "measure" && this.draft && this.draft.measure) {
      this._measureAddPoint(pt, e);
    } else if (this.tool === "select") {
      this._pickSelectAt(e, pt);
    }
  }

  // 选择拾取（select 工具与路块工具编辑模式共用）：拼接路两级选择 —— 端口连通的
  // 整条路优先（单击 = 选整条）；组已选中时再点组内某块 = 回到单块编辑；孤立的
  // 散块（组内仅 1 块）直接单选；空点 = 选描边道路 / 取消选择
  _pickSelectAt(e, pt) {
    const picked = this._pickObject(e);
    if (picked && picked.wrapper.kind === "roadTile") {
      const grp = rtRoadGroupOf(this.map.features.roadTiles || [], picked.wrapper.data);
      const inSelGroup = this.sel && this.sel.kind === "roadGroup" && grp.includes(picked.wrapper.data);
      if (grp.length > 1 && !inSelGroup) this._selectRoadGroup(grp, picked.wrapper);
      else this._select(picked.wrapper);
    } else if (picked) this._select(picked.wrapper);
    else {
      const road = this._pickRoad(pt);
      if (road) this._selectRoad(road);
      else this._select(null);
    }
  }

  _onMove(e) {
    if (this.tool === "place-road") {
      if (this._rtMode === "edit") return; // 编辑模式：无幽灵跟随，Gizmo 拖拽由 TransformControls 自理
      this._roadTileMove(e); return; // 幽灵路块跟随（无需草稿）
    }
    if (this.tool === "place-asset") {
      this._assetGhostMove(e); return; // 模型幽灵跟随 + 吸附预览
    }
    if (this.tool === "place-billboard") {
      this._bbLastEvent = e;
      this._bbGhostMove(e); return; // 大屏幽灵 + 真实占位边界跟随
    }
    const d = this.draft;
    if (!d || !(this.tool.startsWith("draw") || d.area || d.measure)) return;
    let pt = this._groundPoint(e);
    if (!pt) return;
    if ((d.road || d.measure) && e.shiftKey) pt = this._snap45(pt); // Shift：45° 方向吸附
    d.cursor = pt;
    // 拖描模式：按住左键沿道路移动，间距 + 转角双阈值采样（弯道自动加密，更贴合影像）
    if (d.road && d.free && e.buttons & 1) {
      const last = d.points[d.points.length - 1];
      const dist = last ? Math.hypot(pt.x - last.x, pt.z - last.z) : Infinity;
      const min = Math.max(2, (d.width || 12) / 4);
      let turn = 0;
      if (last && d.points.length >= 2) {
        const prev = d.points[d.points.length - 2];
        const a1 = Math.atan2(last.z - prev.z, last.x - prev.x);
        const a2 = Math.atan2(pt.z - last.z, pt.x - last.x);
        turn = Math.abs(a2 - a1);
        if (turn > Math.PI) turn = 2 * Math.PI - turn;
      }
      if (dist >= min || (dist >= 1.5 && turn > 0.12)) { d.points.push(pt); d.redo = []; }
    }
    this._updateDraftPreview();
    if (d.road) this._updateTracePanel();
    else if (d.measure) this._updateMeasureLive();
  }

  _finishDraft() {
    if (!this.draft) return;
    if (this.draft.area) return this._finishAreaDraft();
    if (this.draft.road) return this._finishRoadTrace();
    if (this.draft.measure) return this._finishMeasure();
    if (this.draft.points.length < 2) { this.draft = null; this._updateDraftPreview(); return; }
    const pts = this.draft.points.map((p) => [Math.round(p.x * 10) / 10, Math.round(p.z * 10) / 10]);
    if (this.tool === "draw-river") {
      const w = 26;
      const smooth = this._smoothPath(pts, false, 6);
      this.map.features.rivers.push({ id: uid(), points: smooth, width: w });
      this._rebuildFeature("rivers");
      this._pushUndo("绘制河流");
      this.status(`河流已生成（${smooth.length} 点，宽 ${w}m）`);
    } else if (this.tool === "draw-building") {
      if (pts.length < 3) { this.status("建筑需要至少 3 个点闭合"); return; }
      // footprint 存相对 pos（质心）的局部坐标，与树/路灯同款语义：
      // 渲染 = pos 平移 + 局部 footprint，Gizmo 锚点即建筑中心（旋转绕中心）
      let cx = 0, cz = 0;
      for (const [x, z] of pts) { cx += x; cz += z; }
      cx /= pts.length; cz /= pts.length;
      const obj = {
        id: uid(), type: "building", pos: [cx, cz], rot: 0,
        params: { height: 24, anchorCenter: true, footprint: pts.map(([x, z]) => [x - cx, z - cz]) },
      };
      this.map.objects.push(obj);
      this._rebuildObjects();
      this._pushUndo("生成建筑");
      this.status(`建筑已生成（${pts.length} 边，高 24m）· 选中后可调整高度/位置`);
    }
    this.draft = null;
    this._updateDraftPreview();
  }

  /* ---------------- 地图描边（沿卫星影像勾画道路） ---------------- */
  // 会话式描边：进入后右侧面板常驻（点描/拖描模式、路宽、实时点数/长度、完成/撤销/恢复/取消）。
  // 点描 = 沿影像道路逐点单击（Shift 锁 45° 方向）；拖描 = 按住左键沿路拖动自动采样。
  // 描边期间左键专用于加点（禁用 OrbitControls 左键旋转），右键旋转 / 滚轮缩放不受影响。
  // 数据格式与旧描边一致 {id, points, width}，运行时 customMap.js 无需改动。
  _startRoadTrace() {
    if (this.draft && this.draft.road) { this._updateTracePanel(); return; } // 已在描边中
    this._discardDraft();
    this._select(null);
    this.draft = { points: [], road: true, redo: [], width: this._traceW || 12, free: !!this._traceFree, mode: this._traceMode || "auto" };
    this._setTool("draw-road");
    this._three.orbit.mouseButtons.LEFT = null; // 左键让位给描边
    this._updateDraftPreview();
    this._renderTracePanel();
    this.status("地图描边：沿道路描线 —— 首尾围合自动生成面道路，开放线路生成条带 · 双击/Enter 完成 · Esc 取消");
  }

  // 结束描边会话：清草稿、恢复左键视角控制、右侧面板回到默认
  _endRoadTrace(msg) {
    this.draft = null;
    this._three.orbit.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    this._updateDraftPreview();
    this._renderProps();
    if (msg) this.status(msg);
  }

  // 切换工具 / 开始新绘制前丢弃进行中的草稿（描边/测距会话需同时恢复左键视角控制）
  _discardDraft() {
    if (!this.draft) return;
    if (this.draft.road) this._endRoadTrace();
    else if (this.draft.measure) this._endMeasure();
    else { this.draft = null; this._updateDraftPreview(); }
  }

  // 描边加点：点描 = 单击加点（双击结束产生的重复点击按 <0.8m 去重）；拖描 = 按间距采样
  _traceAddPoint(pt, e) {
    const d = this.draft;
    if (!d || !d.road) return;
    if (d.free) {
      if (e && e.shiftKey) return;
      const last = d.points[d.points.length - 1];
      const min = Math.max(2, (d.width || 12) / 4);
      if (!last || Math.hypot(pt.x - last.x, pt.z - last.z) >= min) { d.points.push(pt); d.redo = []; }
    } else {
      if (e && e.shiftKey) pt = this._snap45(pt);
      const last = d.points[d.points.length - 1];
      if (last && Math.hypot(pt.x - last.x, pt.z - last.z) < 0.8) return; // 双击去重
      d.points.push(pt);
      d.redo = [];
    }
    this._updateDraftPreview();
    this._updateTracePanel();
  }

  // Shift 吸附：新点约束在上一方向的 45° 倍数上，画直路/斜路更整齐
  _snap45(pt) {
    const last = this.draft.points[this.draft.points.length - 1];
    const ang = Math.round(Math.atan2(pt.z - last.z, pt.x - last.x) / (Math.PI / 4)) * (Math.PI / 4);
    const dist = Math.hypot(pt.x - last.x, pt.z - last.z);
    return { x: last.x + Math.cos(ang) * dist, z: last.z + Math.sin(ang) * dist };
  }

  // 闭合判定：末点接近起点 → 视为围合取面（阈值随路宽放大，避免发卡弯误判）
  _traceClosing(path) {
    if (!this.draft || !this.draft.road || path.length < 3) return false;
    const f = path[0], l = path[path.length - 1];
    return Math.hypot(l.x - f.x, l.z - f.z) <= Math.max(8, this.draft.width || 12);
  }

  _finishRoadTrace() {
    const d = this.draft;
    if (!d || !d.road) return;
    if (d.mode === "poly" || (d.mode === "auto" && this._traceClosing(d.points))) return this._finishRoadPolyTrace();
    if (d.points.length < 2) { this._endRoadTrace("地图描边：至少 2 个节点才能生成道路"); return; }
    const pts = this._smoothPath(d.points.map((p) => [p.x, p.z]), false, Math.max(2, (d.width || 12) / 4));
    const road = { id: uid(), points: pts, width: d.width || 12, zh: "描边道路", en: "New Rd", kind: "street", lanes: 2, sidewalk: 3, median: 0 };
    this.map.features.roads.push(road);
    this._rebuildFeature("roads");
    this._pushUndo("绘制道路");
    const len = Math.round(this._polylineLen(pts));
    const w = this._wrappers.get(road.id);
    this._endRoadTrace();
    if (w) this._select(w); // 完成后自动选中，右侧可直接改宽度/名称
    this.status(`道路已生成：${pts.length} 节点 · 约 ${len}m · 宽 ${road.width}m · 可点选继续编辑`);
  }

  // 取面描边：沿道路边缘围合一圈，完成时自动闭合，整块区域填充为路面
  _finishRoadPolyTrace() {
    const d = this.draft;
    const raw = [...d.points];
    if (raw.length >= 2) {
      const f = raw[0], l = raw[raw.length - 1];
      if (Math.hypot(l.x - f.x, l.z - f.z) < 1) raw.pop(); // 收尾回到起点时去掉重复末点
    }
    if (raw.length < 3) { this._endRoadTrace("取面描边：至少 3 个节点才能围合成面"); return; }
    const pts = this._smoothPath(raw.map((p) => [p.x, p.z]), true, Math.max(2, (d.width || 12) / 4), Math.max(10, (d.width || 12) * 2));
    const road = { id: uid(), points: pts, width: d.width || 12, closed: true, zh: "面道路", en: "New Rd", kind: "street", lanes: 2, sidewalk: 3, median: 0 };
    this.map.features.roads.push(road);
    this._rebuildFeature("roads");
    this._pushUndo("取面生成道路");
    const area = Math.round(Math.abs(this._polyArea(pts)));
    const w = this._wrappers.get(road.id);
    this._endRoadTrace();
    if (w) this._select(w);
    this.status(`面道路已生成：${pts.length} 节点 · 约 ${area}㎡ · 可点选继续编辑`);
  }

  // 鞋带面积 / 折线长度 / 描边平滑（实现见 ui/editor3d/util.js）
  _polyArea(pts) { return polyArea(pts); }

  _polylineLen(pts) { return polylineLen(pts); }

  _smoothPath(pts, closed, step = 3, keepEnds = 0) { return smoothPath(pts, closed, step, keepEnds); }

  // 描边会话右侧面板：模式切换 / 路宽预设与输入 / 实时进度 / 完成按钮
  _renderTracePanel() {
    const d = this.draft;
    if (!d || !d.road) return;
    const el = document.getElementById("e3-props");
    el.innerHTML = `
      <h4>地图描边 · 进行中</h4>
      <div class="trace-row">
        <button class="trace-seg${d.mode === "auto" ? " active" : ""}" id="ep-trace-auto">自动</button>
        <button class="trace-seg${d.mode === "line" ? " active" : ""}" id="ep-trace-line">线路</button>
        <button class="trace-seg${d.mode === "poly" ? " active" : ""}" id="ep-trace-poly">取面</button>
      </div>
      <div class="trace-row">
        <button class="trace-seg${d.free ? "" : " active"}" id="ep-trace-point">点描</button>
        <button class="trace-seg${d.free ? " active" : ""}" id="ep-trace-free">拖描</button>
      </div>
      <div class="trace-wrow">
        ${[6, 9, 12, 16, 24].map((w) => `<button class="trace-w${d.width === w ? " active" : ""}" data-w="${w}">${w}</button>`).join("")}
        <input id="ep-trace-w" type="number" min="4" max="80" value="${d.width}" title="路宽（米，取面时仅用于预览线宽）" />
      </div>
      <div class="me-stat">节点 <b id="ep-trace-n">${d.points.length}</b> · 长度 <b id="ep-trace-len">${Math.round(this._polylineLen(d.points.map((p) => [p.x, p.z])))}</b>m</div>
      <button class="me-btn" id="ep-trace-done">完成描边（Enter / 双击）</button>
      <button class="me-btn" id="ep-trace-undo">撤销上一节点（Ctrl+Z）</button>
      <button class="me-btn" id="ep-trace-redo">恢复节点（Ctrl+Y）</button>
      <button class="me-del" id="ep-trace-cancel">取消描边（Esc）</button>
      <p class="me-hint">自动：沿道路边缘围合一圈（首尾接近）→ 整块填充成面；开放线路 → 按路宽生成条带 · 线路 / 取面可强制指定 · 点描逐点单击（Shift 锁 45°），拖描按住左键拖动自动采样</p>`;
    const setMode = (m) => { d.mode = m; this._traceMode = m; this._renderTracePanel(); this._updateDraftPreview(); };
    el.querySelector("#ep-trace-auto").addEventListener("click", () => setMode("auto"));
    el.querySelector("#ep-trace-line").addEventListener("click", () => setMode("line"));
    el.querySelector("#ep-trace-poly").addEventListener("click", () => setMode("poly"));
    el.querySelector("#ep-trace-point").addEventListener("click", () => { d.free = false; this._traceFree = false; this._renderTracePanel(); });
    el.querySelector("#ep-trace-free").addEventListener("click", () => { d.free = true; this._traceFree = true; this._renderTracePanel(); });
    el.querySelectorAll(".trace-w").forEach((b) => b.addEventListener("click", () => {
      d.width = +b.dataset.w; this._traceW = d.width; this._renderTracePanel(); this._updateDraftPreview();
    }));
    el.querySelector("#ep-trace-w").addEventListener("change", (e) => {
      d.width = Math.min(80, Math.max(4, +e.target.value || 12)); this._traceW = d.width; this._renderTracePanel(); this._updateDraftPreview();
    });
    const bind = (id, fn, disabled) => {
      const btn = el.querySelector(id);
      btn.disabled = !!disabled;
      btn.addEventListener("click", (e2) => { e2.currentTarget.blur(); fn(); });
    };
    bind("#ep-trace-done", () => this._finishRoadTrace(), d.points.length < 2);
    bind("#ep-trace-undo", () => this._undoDraftPoint(), !d.points.length);
    bind("#ep-trace-redo", () => this._redoDraftPoint(), !d.redo.length);
    bind("#ep-trace-cancel", () => this._endRoadTrace("已取消地图描边"));
  }

  // 轻量刷新：只更新数字与按钮可用态（拖描采样频繁，不能整面板重绘）
  _updateTracePanel() {
    const d = this.draft;
    if (!d || !d.road) return;
    const el = document.getElementById("e3-props");
    const n = el.querySelector("#ep-trace-n"), len = el.querySelector("#ep-trace-len");
    if (!n) { this._renderTracePanel(); return; }
    n.textContent = d.points.length;
    len.textContent = Math.round(this._polylineLen(d.points.map((p) => [p.x, p.z])));
    const undo = el.querySelector("#ep-trace-undo"), redo = el.querySelector("#ep-trace-redo"), done = el.querySelector("#ep-trace-done");
    if (undo) undo.disabled = !d.points.length;
    if (redo) redo.disabled = !d.redo.length;
    if (done) done.disabled = d.points.length < 2;
  }

  /* ---------------- 测距工具（设置面板入口） ---------------- */
  // 会话式测距实现见 ui/editor3d/measure.js（以编辑器实例为上下文）
  _startMeasure() { startMeasure(this); }

  _endMeasure(msg) { endMeasure(this, msg); }

  _clearMeasure() { clearMeasure(this); }

  _measureAddPoint(pt, e) { measureAddPoint(this, pt, e); }

  _finishMeasure() { finishMeasure(this); }

  _renderMeasurePanel() { renderMeasurePanel(this); }

  _updateMeasureLive() { updateMeasureLive(this); }

  _renderMeasureResult() { renderMeasureResult(this); }

  _buildMeasureGroup(points, cursor) { return buildMeasureGroup(this, points, cursor); }

  _measureLabel(text, accent) { return measureLabel(this, text, accent); }

  /* ---------------- 路块拼接（实现见 ui/editor3d/roadTiles.js） ---------------- */
  _startRoadTile() { rtStart(this); }

  _roadTileMove(e) {
    const pt = this._groundPoint(e);
    if (!pt) { this._rtGhostState = null; rtUpdateGhost(this); return; }
    // 惯性基准 _rtLastMovePt 只在放置时写入：moved = 相对放置点累计位移，
    // 慢速拖动也能累积触发转向（旧版逐事件覆盖导致慢移永远「未移动」）
    this._rtGhostState = rtGhostState(this, pt, e.shiftKey);
    rtUpdateGhost(this);
    // 落钉瞄准中：状态栏实时回显方向角（0° = 北/+z，顺时针），方便对齐精确角度
    if (this._rtPin && this._rtGhostState) {
      const deg = ((this._rtGhostState.yaw * 180) / Math.PI % 360 + 360) % 360;
      this.status(`瞄准中 · 方向 ${deg.toFixed(1)}° · 单击放置 · Esc 取消落点`);
    }
  }

  _roadTilePlace(e) {
    const pt = this._groundPoint(e);
    if (!pt) return;
    rtPlace(this, pt, e.shiftKey);
  }

  /* ---------------- 整条拼接路（端口连通分组） ---------------- */
  // 分组是派生数据（rtRoadGroupOf 按端口连通现算）：不落数据，旧地图自动生效，
  // 单块增删/挪动后分组自动跟随拓扑。组选中 = 质心上的代理对象挂 Gizmo，
  // mouseUp 时把位移/旋转增量刚性应用到组内每块（端口贴合关系保持）。

  _selectRoadGroup(tiles, focus) {
    const wraps = tiles.map((t) => this._wrappers.get(t.id)).filter(Boolean);
    if (!wraps.length) return;
    let cx = 0, cz = 0;
    for (const t of tiles) { cx += t.x; cz += t.z; }
    cx /= tiles.length; cz /= tiles.length;
    this._clearGroupVisuals();
    if (!this._rtGroupProxy) this._rtGroupProxy = new THREE.Group();
    const proxy = this._rtGroupProxy;
    if (!proxy.parent) this._three.scene.add(proxy);
    proxy.position.set(cx, 0, cz);
    proxy.rotation.set(0, 0, 0);
    const box = new THREE.Box3();
    for (const w of wraps) box.expandByObject(w.root);
    box.expandByScalar(0.5);
    this._rtGroupHelper = new THREE.Box3Helper(box, 0x4ade80); // 绿框标出整条路的范围
    this._three.scene.add(this._rtGroupHelper);
    this._rtGroupBaseline = { px: cx, pz: cz, dr: 0, tiles: tiles.map((t) => ({ t, x: t.x, z: t.z, rot: t.rot || 0 })) };
    this._rtGroupFocus = focus || wraps[0];
    this._select({ kind: "roadGroup", data: tiles, root: proxy });
    this.status(`已选中整条拼接路（${tiles.length} 块）· Gizmo 平移 / E 键旋转整条路 · 单击组内某块单独编辑 · Delete 删除整条路`);
  }

  _clearGroupVisuals() {
    if (this._rtGroupHelper) {
      this._three.scene.remove(this._rtGroupHelper);
      if (this._rtGroupHelper.geometry) this._rtGroupHelper.geometry.dispose();
      this._rtGroupHelper = null;
    }
    this._rtGroupBaseline = null;
    this._rtGroupFocus = null;
  }

  _updateGroupHelper() {
    if (!this._rtGroupHelper || !this.sel || this.sel.kind !== "roadGroup") return;
    const box = new THREE.Box3();
    for (const t of this.sel.data) {
      const w = this._wrappers.get(t.id);
      if (w) box.expandByObject(w.root);
    }
    box.expandByScalar(0.5);
    this._rtGroupHelper.box.copy(box);
    this._rtGroupHelper.update();
  }

  /* ---------------- 范围描边（多边形地图范围） ---------------- */
  // 进入范围描边模式：单击加点，双击/Enter/「完成描边」按钮结束（≥3 点），Esc 取消；
  // 绘制中右侧面板停留在描边面板（点数 + 撤销/恢复/完成/取消），支持点级 Ctrl+Z / Ctrl+Y
  _startAreaDraft() {
    this._select(null);
    this._discardDraft();
    this.draft = { points: [], area: true, redo: [] };
    this._setTool("area");
    this._updateDraftPreview();
    this._renderAreaDraftPanel();
    this.status("范围描边：在底图上单击依次加点（≥3 点），双击/Enter 或点「完成描边」结束");
  }

  // 描边中的右侧面板：保持停留，提供完成/撤销/恢复/取消操作
  _renderAreaDraftPanel() {
    const d = this.draft;
    if (!d || !d.area) return;
    const el = document.getElementById("e3-props");
    const n = d.points.length;
    el.innerHTML = `
      <h4>地图范围 · 描边中</h4>
      <div class="me-stat">已加顶点 <b>${n}</b>（≥3 点可完成）</div>
      <button class="me-btn" id="ep-draft-done">完成描边</button>
      <button class="me-btn" id="ep-draft-undo">撤销上一顶点（Ctrl+Z）</button>
      <button class="me-btn" id="ep-draft-redo">恢复顶点（Ctrl+Y）</button>
      <button class="me-del" id="ep-draft-cancel">取消描边</button>
      <p class="me-hint">在地图上单击加点 · Delete 也可撤销上一顶点 · 双击/Enter 完成</p>`;
    const bind = (id, fn, disabled) => {
      const btn = el.querySelector(id);
      btn.disabled = !!disabled;
      btn.addEventListener("click", (e) => { e.currentTarget.blur(); fn(); });
    };
    bind("#ep-draft-done", () => this._finishAreaDraft(), n < 3);
    bind("#ep-draft-undo", () => this._undoDraftPoint(), !n);
    bind("#ep-draft-redo", () => this._redoDraftPoint(), !d.redo.length);
    bind("#ep-draft-cancel", () => {
      this.draft = null;
      this._updateDraftPreview();
      this._selectArea();
      this.status("已取消范围描边");
    });
  }

  // 描边点级撤销 / 恢复（仅作用于草稿，不影响已提交内容；范围描边/地图描边/测距通用）
  _undoDraftPoint() {
    const d = this.draft;
    if (!d || (!d.area && !d.road && !d.measure) || !d.points.length) return;
    d.redo.push(d.points.pop());
    this._updateDraftPreview();
    if (d.road) this._updateTracePanel();
    else if (d.measure) this._renderMeasurePanel();
    else this._renderAreaDraftPanel();
  }

  _redoDraftPoint() {
    const d = this.draft;
    if (!d || (!d.area && !d.road && !d.measure) || !d.redo.length) return;
    d.points.push(d.redo.pop());
    this._updateDraftPreview();
    if (d.road) this._updateTracePanel();
    else if (d.measure) this._renderMeasurePanel();
    else this._renderAreaDraftPanel();
  }

  // 结束范围描边：生成/替换多边形范围。内容不动 —— 中心迁移量补偿进 origin，
  // 保持内容经纬映射不变（见 map area 不变式注释）。
  _finishAreaDraft() {
    if (this.draft.points.length < 3) {
      this.status("范围描边：至少需要 3 个点（继续单击加点）");
      this._renderAreaDraftPanel(); // 保留草稿，面板停留在描边态
      return;
    }
    const pts = [];
    for (const p of this.draft.points) {
      const q = pts[pts.length - 1];
      if (!q || Math.hypot(p.x - q[0], p.z - q[1]) >= 0.5) {
        pts.push([Math.round(p.x * 10) / 10, Math.round(p.z * 10) / 10]);
      }
    }
    if (pts.length >= 2) {
      const f = pts[0], l = pts[pts.length - 1];
      if (Math.hypot(f[0] - l[0], f[1] - l[1]) < 0.5) pts.pop(); // 双击收尾产生的重复点
    }
    if (pts.length < 3) {
      this.status("范围描边：至少需要 3 个不同的点");
      this._renderAreaDraftPanel();
      return;
    }
    const a = this._areaEnsure();
    const c = this._areaCenter(pts);
    this._shiftOrigin(c.cx - a.cx, c.cz - a.cz);
    this.map.area = { cx: c.cx, cz: c.cz, pts };
    this.draft = null;
    this._updateDraftPreview();
    this._rebuildAreaMeshes();
    this._applyAreaToGroup();
    this._bendArea();
    this._rebuildAll(); // 曲率零基准随中心变化，重建内容
    this._updateEnu();
    this._selectArea();
    this._pushUndo("描边地图范围");
    this.status(`地图范围已描边（${pts.length} 个顶点）· 记得保存`);
  }

  /* ---------------- entity build ---------------- */
  // 实体材质 / 网格构建（实现见 ui/editor3d/meshes.js）
  _matRoad() { return matRoad(); }
  _matRiver() { return matRiver(); }
  _matBuilding() { return matBuilding(); }
  _matRoof() { return matRoof(); }

  _stripGeometry(points, width, yBase = 0.05) { return stripGeometry(this, points, width, yBase); }

  _buildRoadMesh(data) { return buildRoadMesh(this, data); }

  _buildRiverMesh(data) { return buildRiverMesh(this, data); }

  _buildBuildingMesh(obj) { return buildBuildingMesh(obj); }

  _buildTreeMesh() { return buildTreeMesh(); }

  _buildLampMesh() { return buildLampMesh(); }

  /* ---------------- wrappers（data ↔ three 对象） ---------------- */
  _makeWrapper(kind, data, object3d) {
    const root = new THREE.Group();
    root.userData.entityRoot = true; // 标记必须设在场景根节点上，_rebuildAll 清理时据此移除旧网格
    root.userData.layerKind = kind; // 图层控制面板按此分类开关
    root.visible = this._layerVis[kind] !== false; // 重建出的实体保持面板里的显隐状态
    // 物件整体下沉贴合球面（数据仍存平面 x/z，y 仅是渲染偏移，中心零基准）
    if (kind === "object") root.position.set(data.pos[0], -this._curveOffset(data.pos[0], data.pos[1]), data.pos[1]), root.rotation.y = data.rot || 0;
    else if (kind === "roadTile") root.position.set(data.x, -this._curveOffset(data.x, data.z), data.z), root.rotation.y = data.rot || 0;
    root.add(object3d);
    const pickMeshes = [];
    let bbEmbedded = null;
    object3d.traverse((o) => {
      if (o.userData.bbEmbedded) bbEmbedded = o;
      if (o.isMesh) { o.userData.entityId = data.id; pickMeshes.push(o); }
    });
    const w = { kind, data, root, pickMeshes, bbEmbedded };
    this._wrappers.set(data.id, w);
    for (const m of pickMeshes) this._byPick.set(m, w);
    this._three.scene.add(root);
    return w;
  }

  _rebuildAll() {
    this._wrappers = new Map();
    this._byPick = new Map();
    this._bbConstraints = null; // 路网/描边路/手绘建筑变了，摆放约束需重算
    for (const w of this._three.scene.children.slice()) {
      if (w.userData.entityRoot) {
        this._three.scene.remove(w);
        // 资产实例（sharedTpl）的几何/材质与模板缓存共享，dispose 会把 GPU 缓冲
        // 一并释放，下次渲染重新上传 —— 资产多时每次重建都是卡顿尖峰，故跳过；
        // 标准材料库共享材质（userData.shared）同样不随对象重建释放
        const shared = w.children[0] && w.children[0].userData && w.children[0].userData.sharedTpl;
        if (!shared) w.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material && !(o.material.userData && o.material.userData.shared)) o.material.dispose(); });
      }
    }
    for (const r of this.map.features.roads) {
      this._makeWrapper("road", r, this._buildRoadMesh(r));
    }
    for (const r of this.map.features.rivers) {
      this._makeWrapper("river", r, this._buildRiverMesh(r));
    }
    this.map.features.roadTiles = this.map.features.roadTiles || []; // 旧地图补空
    rtMarkDirty(this); // 端口缓存随数据整体失效
    const rtM = rtMiters(this.map.features.roadTiles); // 端头斜切参数（按相邻块转角）
    for (const t of this.map.features.roadTiles) {
      this._makeWrapper("roadTile", t, buildRoadTileMesh(this, t, false, rtM));
    }
    for (const o of this.map.objects) {
      let m = null;
      try {
        m = this._buildObjectMesh(o);
      } catch (err) {
        // 单个物件数据异常不应拖垮整个场景重建（否则表现为"一大片内容消失"）
        console.warn("[editor3d] 物件构建失败，已跳过：", o && o.type, err);
      }
      if (!m) continue;
      this._makeWrapper("object", o, m);
    }
    this._rebuildSkeleton();
    // 重建后旧 wrapper 已销毁：选中态接回同 id 的新 wrapper，
    // 否则 TransformControls 还挂在已移出场景的对象上（每帧报错）
    if (this.sel && this.sel.data && this.sel.data.id) {
      const w = this._wrappers.get(this.sel.data.id);
      if (w && w !== this.sel) { this.sel = w; this._three.tc.attach(w.root); }
      else if (!w) this._select(null);
    }
    this._updateBBSelection(); // 重建后边界跟随新 wrapper
  }

  // 程序化城市骨架叠加（2D 编辑器管理的数据，与运行时世界一致）：
  // 灰色路带 = 纵横路网（勾选「程序化延伸街道」时含世界边缘自动延伸街道）· 紫色圆盘 = 地标 · 绿色标记 = 出生点。
  // 延伸路仅显示不可选中，手工道路可点选编辑。路网延伸逻辑与 city.js _buildRoads 同源，预览 = 游戏实际生成的街道
  _rebuildSkeleton() {
    const g = this._skeleton;
    for (const c of g.children.slice()) {
      g.remove(c);
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    }
    // 世界边界：路网 ∪ 描边内容 ∪ 地图范围（与运行时 City 构造同源，customMap.worldBounds）
    const b = worldBounds(this.map);
    // 复刻运行时延伸：按 EXT_STEP 向四周补 street，直到铺满世界边界。
    // 路线用屏幕空间胖线，线宽 = 真实世界宽（asphaltHalf*2，同 2D 编辑器）按相机
    // 距离逐帧换算像素，缩放时不同道路保持相对宽窄；低于保底像素时取保底，
    // 缩太远路网仍清晰。选中道路高亮金色
    this._roadLines = [];
    const xs = this.map.roadsX.map((r) => ({ obj: r, at: r.at, ext: false })).sort((p, q) => p.at - q.at);
    const zs = this.map.roadsZ.map((r) => ({ obj: r, at: r.at, ext: false })).sort((p, q) => p.at - q.at);
    // 与运行时 _buildRoads 同源：勾选「程序化延伸街道」= 按固定间距铺满世界边界。
    // 拼接路 + 程序化城市时，运行时补的是「虚拟边界路」（不画线 / 无路口 / 不进
    // 交通图，仅参与街区划分），因此预览不绘制任何额外道路 —— 用户只看到自己画的路。
    if (this.map.extRoads) {
      // 延伸路规格与运行时同源：大道 / 街巷的宽度在预览里也要一致
      const extAt = (at, step) => ({ at, ext: true, spec: extRoadSpec(at, step) });
      if (xs.length) {
        while (xs[xs.length - 1].at < b.maxX) xs.push(extAt(xs[xs.length - 1].at + EXT_STEP_X, EXT_STEP_X));
        while (xs[0].at > b.minX) xs.unshift(extAt(xs[0].at - EXT_STEP_X, EXT_STEP_X));
      }
      if (zs.length) {
        while (zs[zs.length - 1].at < b.maxZ) zs.push(extAt(zs[zs.length - 1].at + EXT_STEP_Z, EXT_STEP_Z));
        while (zs[0].at > b.minZ) zs.unshift(extAt(zs[0].at - EXT_STEP_Z, EXT_STEP_Z));
      }
    }
    // 每 ~1000m 细分一次：路带条带与中心线跟随曲率下沉
    // （条带是同一几何体无接缝重叠；1000m 弦弧差 ~0.02m 不可见）
    const seg = (x0, z0, x1, z1) => {
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 1000));
      const pts = [];
      for (let i = 0; i <= n; i++) pts.push({ x: x0 + ((x1 - x0) * i) / n, z: z0 + ((z1 - z0) * i) / n });
      return pts;
    };
    const roadLine = (r, pts) => {
      const sel = this.sel && this.sel.data === r.obj;
      const worldW = r.ext ? asphaltHalf(r.spec) * 2 : asphaltHalf(r.obj) * 2;
      // 路带贴图与「路块拼接」一致（沥青表面），tint 仅区分状态：选中金色 / 延伸路暗调
      const color = sel ? 0xf2c14e : r.ext ? 0x8a93a2 : 0xffffff;
      // 世界宽度路带：真实透视（近宽远窄），平视地球不失真
      g.add(this._roadRibbon(pts, worldW / 2, color, 1));
      // 中心引导线：远景路带缩到亚像素时仍可辨路网走向；近景淡化为路面标线
      const line = this._fatLine(pts, sel ? 3 : 2, color, sel ? 0.95 : 0.8, 0.06);
      line.userData.roadW = worldW;
      line.userData.baseOp = sel ? 0.95 : 0.8;
      this._roadLines.push(line);
      line.renderOrder = 2;
      g.add(line);
    };
    // 道路显示裁剪到地图范围（网格地图）内：超出范围的路段不渲染。
    // 无范围时退化为整段显示（与旧版一致）
    const poly = areaPoly(this.map);
    const segsFor = (fixed, horiz) =>
      poly ? clipAxisLine(poly, fixed, horiz) : [[horiz ? b.minX : b.minZ, horiz ? b.maxX : b.maxZ]];
    for (const r of xs) {
      for (const [a0, a1] of segsFor(r.at, false)) {
        if (a1 - a0 < 1) continue;
        roadLine(r, seg(r.at, a0, r.at, a1));
      }
    }
    for (const r of zs) {
      for (const [a0, a1] of segsFor(r.at, true)) {
        if (a1 - a0 < 1) continue;
        roadLine(r, seg(a0, r.at, a1, r.at));
      }
    }
    const landMat = new THREE.MeshBasicMaterial({ color: 0xc46bd6, transparent: true, opacity: 0.9 });
    for (const l of this.map.landmarks) {
      const disc = new THREE.Mesh(new THREE.CircleGeometry(6, 20).rotateX(-Math.PI / 2), landMat);
      disc.position.set(l.x, 0.08 - this._curveOffset(l.x, l.z), l.z);
      g.add(disc);
    }
    const sp = this.map.spawn;
    if (sp) {
      const y = this._curveOffset(sp.x, sp.z);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(6, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x4ade80 }));
      disc.position.set(sp.x, 0.08 - y, sp.z);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 24, 6), new THREE.MeshBasicMaterial({ color: 0x4ade80 }));
      pole.position.set(sp.x, 12 - y, sp.z);
      g.add(disc, pole);
    }
    // 3D 描边道路中心引导线（与程序化道路同款胖线 + 逐帧淡出）：
    // 线形路沿折线（折线即路中心）；取面路用最小外接矩形长轴中线（直路取面才有）
    const f = this.map.features;
    for (const r of (f && f.roads) || []) {
      let pts = null;
      if (r.closed && r.points.length >= 3) {
        const cl = polyCenterLine(r.points, 80);
        if (cl) pts = [{ x: cl[0][0], z: cl[0][1] }, { x: cl[1][0], z: cl[1][1] }];
      } else if (r.points.length >= 2) {
        pts = r.points.map(([x, z]) => ({ x, z }));
      }
      if (!pts) continue;
      const sel = this.sel && this.sel.kind === "road" && this.sel.data === r;
      const color = sel ? 0xf2c14e : 0x8ea3bd;
      const line = this._fatLine(pts, sel ? 3 : 2, color, sel ? 0.95 : 0.8, 0.06);
      line.userData.roadW = r.width || 12;
      line.userData.baseOp = sel ? 0.95 : 0.8;
      this._roadLines.push(line);
      line.renderOrder = 2;
      g.add(line);
    }
  }

  // 中心引导线逐帧透明度：近景路带已呈现真实宽度 → 引导线淡化为路面标线；
  // 远景路带缩到亚像素 → 引导线保持可见（指明路网走向）
  _updateRoadCenterlines() {
    if (!this._roadLines || !this._roadLines.length) return;
    const { camera, orbit, renderer } = this._three;
    const dist = Math.max(1, camera.position.distanceTo(orbit.target));
    const size = renderer.getSize(new THREE.Vector2());
    const pxPerWorld = size.y / (2 * dist * Math.tan((camera.fov * Math.PI) / 360));
    for (const line of this._roadLines) {
      const t = clamp((line.userData.roadW * pxPerWorld - 3) / 5, 0, 1); // 0=远景 1=近景
      line.material.opacity = line.userData.baseOp * (1 - 0.8 * t);
    }
  }

  // 一键复位视角：回到正南方俯瞰范围中心的默认机位（与打开编辑器时一致，屏幕上方 = 北）
  _resetView() {
    const { camera, orbit } = this._three;
    const g = this._three.areaGroup;
    const cx = g ? g.position.x : 0, cz = g ? g.position.z : 0; // 范围中心（拖走范围后仍回正俯瞰）
    orbit.target.set(cx, 0, cz);
    camera.position.set(cx, 140, cz + 260);
    orbit.update();
    this.status("视角已复位（正南方俯瞰范围中心）");
  }

  // 罗盘逐帧更新：视线方位角 = 视线方向相对真北（-Z）的顺时针夹角
  // （0°北 / 90°东 / 180°南 / 270°西）。罗盘刻度盘反向旋转 = 北在屏幕上的指向
  _updateCompass() {
    if (!this._compassEl) return;
    const { camera, orbit } = this._three;
    const dx = orbit.target.x - camera.position.x;
    const dz = orbit.target.z - camera.position.z;
    if (!dx && !dz) return;
    let deg = (Math.atan2(dx, -dz) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    if (this._compassDeg !== undefined && Math.abs(deg - this._compassDeg) < 0.2) return;
    this._compassDeg = deg;
    this._compassRose.style.transform = `rotate(${-deg}deg)`;
    const dirs = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"];
    this._compassTxt.textContent = `${Math.round(deg)}° ${dirs[Math.round(deg / 45) % 8]}`;
  }

  _rebuildFeature(listName) {
    // 简单起见：单类重建走全量重建（数据量小，成本可忽略）
    this._rebuildAll();
  }

  _rebuildObjects() { this._rebuildAll(); }

  _buildObjectMesh(o) {
    if (o.type === "asset") return this._buildAssetMesh(o);
    // 广告牌：模型规格从资产引用解析（老对象内联 params 原样兼容）
    const item = (o.type === "billboard" && o.assetId)
      ? billboardItemFromRecord(o, this._bbAssetOf(o))
      : o;
    const base = buildObjectMesh(this, item);
    if (o.type === "billboard" && base) {
      // 已放置的大屏常驻一条高亮占位边界：深色塔体与深蓝网格几乎同色，
      // 没有这条边框在编辑器里根本看不出它到底占了多大、有没有压到路
      const g = new THREE.Group();
      const bd = createFootprintBoundary();
      bd.userData.bbEmbedded = true;
      updateFootprintBoundary(bd, item, BB_COLORS.idle);
      bd.visible = false; // 未选中不显示边界，展示模型原样；选中态由 _updateBBSelection 打开
      g.add(base, bd);
      return g;
    }
    return base;
  }

  // 资产实例（同步）：模板热 → 克隆；未热 → 线框占位盒 + 异步预热后重建。
  // 资产记录缓存未命中 → 异步取一次再重建（编辑器打开时资产可能在工坊里刚保存）
  _buildAssetMesh(o) {
    const asset = this._assetCache.get(o.assetId);
    if (!asset) {
      if (!this._assetFetchPending) this._assetFetchPending = new Set();
      if (!this._assetFetchPending.has(o.assetId)) {
        this._assetFetchPending.add(o.assetId);
        getAsset(o.assetId).then((a) => {
          this._assetFetchPending.delete(o.assetId);
          if (a) { this._assetCache.set(a.id, a); this._rebuildObjects(); }
        });
      }
      return null;
    }
    // 老地图里的描边建筑存的是旧自动适配 scale（30 / 原始裸尺寸），
    // 现在几何已在构建期归一化，旧值会让楼再放大一遍 → 自动归位为 1。
    if (asset.source === "traced" && o.scale != null && o.scale !== 1) {
      const raw = asset.unitSize || { x: 4, y: 4, z: 4 };
      const oldAuto = +(30 / (Math.max(raw.x, raw.y, raw.z) || 1)).toFixed(4);
      if (Math.abs(o.scale - oldAuto) < 0.01) { o.scale = 1; this._dirty = true; }
    }
    const tpl = getAssetTemplateIfReady(asset.id);
    if (tpl) return assetInstance(asset, { scale: o.scale == null ? 1 : o.scale });
    warmAssetTemplate(asset).then((t) => { if (t) this._rebuildObjects(); });
    const s = asset.source === "traced" ? tracedUnitSize(asset) : (asset.unitSize || { x: 4, y: 4, z: 4 });
    const k = o.scale == null ? 1 : o.scale;
    const ph = new THREE.Mesh(
      new THREE.BoxGeometry(Math.max(0.1, s.x * k), Math.max(0.1, s.y * k), Math.max(0.1, s.z * k)),
      new THREE.MeshBasicMaterial({ color: 0x3a72b0, wireframe: true }),
    );
    ph.position.y = Math.max(0.1, s.y * k) / 2;
    return ph;
  }

  /* ---------------- 放置幽灵 + 吸附（place-asset） ---------------- */
  // 幽灵是单个半透明盒（不克隆多 mesh 模板），且只在 pointermove 时更新位置
  // —— 无每帧成本，任何规模地图上都不产生性能负担
  _ensureAssetGhost() {
    if (this._assetGhost) return;
    this._assetGhost = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.32, depthWrite: false }),
    );
    this._assetGhost.visible = false;
    this._three.scene.add(this._assetGhost);
  }

  _hideAssetGhost() {
    if (this._assetGhost) this._assetGhost.visible = false;
  }

  _assetGhostMove(e) {
    if (!this._placingAsset) { this._hideAssetGhost(); return; }
    const pt = this._groundPoint(e);
    if (!pt) { this._hideAssetGhost(); return; }
    const sp = this._assetSnapPoint(pt);
    const us = this._placingAsset.source === "traced"
      ? tracedUnitSize(this._placingAsset)
      : (this._placingAsset.unitSize || { x: 4, y: 4, z: 4 });
    // 与放置时同一套缩放：描边建筑/广告牌 = 1，GLB 按目标尺寸适配
    const k = this._assetPlaceScale(this._placingAsset);
    this._ensureAssetGhost();
    const g = this._assetGhost;
    g.scale.set(Math.max(0.5, us.x * k), Math.max(0.5, us.y * k), Math.max(0.5, us.z * k));
    g.position.set(sp.pos[0], Math.max(0.5, us.y * k) / 2, sp.pos[1]); // 底面贴地
    g.material.color.setHex(sp.onRoad ? 0xffc24d : 0x3a72b0); // 金色 = 吸附路缘，蓝色 = 网格吸附
    g.visible = true;
  }

  // 吸附落点：优先路缘（12m 内最近路块，投影到路缘线、沿路向限制在块内），
  // 否则按编辑器网格步长（_snap，默认 5m）取整。放置与幽灵共用，保证所见即所得
  _assetSnapPoint(pt) {
    const snap = this._snap > 0 ? this._snap : 0;
    const grid = { pos: snap ? [Math.round(pt.x / snap) * snap, Math.round(pt.z / snap) * snap] : [pt.x, pt.z], onRoad: false };
    if (!this._bbSnapOn) return grid; // 顶栏「路缘吸附」关闭：只按网格（或自由落点）
    const tiles = this.map.features.roadTiles || [];
    if (!tiles.length) return grid;
    const R2 = 12 * 12;
    let best = null;
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      const dx = pt.x - t.x, dz = pt.z - t.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > R2 || (best && d2 >= best.d2)) continue;
      const rot = t.rot || 0, c = Math.cos(rot), s = Math.sin(rot);
      // 世界 → 路块局部（旋转变换约定同 assetWorldAABB）
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      const halfL = (t.len || 20) / 2, halfW = (t.w || 10) / 2;
      if (Math.abs(lx) > halfL + 2 || Math.abs(lz) > halfW + 6) continue; // 只吸块附近
      best = { d2, t, lx: clamp(lx, -halfL, halfL), lz: lz >= 0 ? halfW : -halfW };
    }
    if (!best) return grid;
    const t = best.t, rot = t.rot || 0, c = Math.cos(rot), s = Math.sin(rot);
    const wx = t.x + best.lx * c + best.lz * s;
    const wz = t.z - best.lx * s + best.lz * c;
    return { pos: [Math.round(wx * 10) / 10, Math.round(wz * 10) / 10], onRoad: true };
  }

  /* ---------------- 放置幽灵 + 真实占位边界（place-billboard） ----------------
   * 幽灵按右侧「待放参数」构建（可在放置前就选好转角包柱屏），随鼠标只改位置；
   * 边界组画的是与运行时完全一致的旋转后占位包络（含屏体高度），
   * 青=网格吸附合法 / 金=吸附路缘 / 红=压到建筑、道路或地图范围外。
   */
  _bbGetConstraints() {
    if (!this._bbConstraints) this._bbConstraints = collectConstraints({ data: this.map });
    return this._bbConstraints;
  }

  /** 实例级覆盖：只存与资产默认值不同的字段，保持地图数据轻量、几何仍归资产库 */
  _bbOverrides() {
    const a = this._bbAsset;
    if (!a) return { ...this._bbDraft };
    const def = billboardParamsFor({ params: {} }, a);
    const out = {};
    // 弧度不放实例覆盖：只认模型资产 + 后台覆盖（见 billboardParamsFor / billboardManager）
    for (const k of ["w", "h", "y", "autoSnap"]) {
      if (this._bbDraft[k] !== def[k]) out[k] = this._bbDraft[k];
    }
    return out;
  }

  /** 资产的目标米数：用户显式设置 > 智能推断（名字/分类/原始尺寸） > 全局默认 */
  _assetPlaceTarget(asset) {
    if (asset && asset.placeSize != null && +asset.placeSize > 0) return +asset.placeSize;
    if (asset && asset.source === "glb") return inferPlaceSize(asset);
    if (asset && asset.source === "traced") return 30; // 描边资产几何在构建期归一化到 30m
    return this._assetTargetSize || 30;
  }

  /** 放置缩放：GLB 建模单位不统一，按该资产的目标尺寸自动适配；描边建筑 / 广告牌
   *  本身按真实米构建，必须原尺寸放置（scale=1），否则一栋楼被放大 7.5 倍。 */
  _assetPlaceScale(asset) {
    if (asset && (asset.source === "traced" || asset.source === "billboard")) return 1;
    const s = (asset && asset.unitSize) || { x: 4, y: 4, z: 4 };
    const maxDim = Math.max(s.x, s.y, s.z) || 1;
    const target = this._assetPlaceTarget(asset);
    return clamp(+(target / maxDim).toFixed(4), 0.001, 1000);
  }

  /** 新放广告牌的默认朝向 = 资产展示朝向（转角屏 π，让广告面朝向默认视角）。
   *  这是写进地图对象的真实 rot，编辑器与进游戏表现一致 —— 不是编辑器单独转一下。 */
  _bbDefaultRot() {
    return this._bbAsset ? (+this._bbAsset.poseYaw || 0) : 0;
  }

  /** 幽灵 / 放置校验用的完整参数（资产规格 + 实例覆盖） */
  _bbDraftItem(pos) {
    const base = {
      id: "__bb_draft__", type: "billboard",
      assetId: this._bbAsset ? this._bbAsset.id : null,
      pos: pos || [0, 0], rot: this._bbDefaultRot(),
      params: { override: this._bbOverrides() },
    };
    return { ...base, params: billboardParamsFor(base, this._bbAsset) };
  }

  /** 取 billboard 对象引用的资产记录（同步缓存优先，缺失则异步拉一次再重绘面板） */
  _bbAssetOf(data) {
    if (!data || !data.assetId) return null;
    const id = data.assetId;
    let a = this._assetCache.get(id) || getAssetRecordSync(id);
    if (!a && !this._assetFetchPending.has(id)) {
      this._assetFetchPending.add(id);
      getAsset(id).then((r) => {
        this._assetFetchPending.delete(id);
        if (r) { this._assetCache.set(id, r); if (!this._disposed) this._renderProps(); }
      });
    }
    return a || null;
  }

  _disposeBBGhost() {
    if (!this._bbGhost) return;
    if (this._three) this._three.scene.remove(this._bbGhost);
    this._bbGhost.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && !(o.material.userData && o.material.userData.shared)) o.material.dispose();
    });
    this._bbGhost = null;
    this._bbGhostKey = "";
  }

  _ensureBBGhost() {
    const key = `${this._bbDraft.mount}|${this._bbDraft.w}|${this._bbDraft.h}|${this._bbDraft.y}`;
    if (this._bbGhost && this._bbGhostKey === key) return;
    this._disposeBBGhost();
    this._bbGhost = buildBillboardGroup(this._bbDraftItem(), editorGhostMaterial()).group;
    this._bbGhost.visible = false;
    this._bbGhostKey = key;
    this._three.scene.add(this._bbGhost);
  }

  _ensureBBBoundary() {
    if (!this._bbBoundary) {
      this._bbBoundary = createFootprintBoundary();
      this._three.scene.add(this._bbBoundary);
    }
    return this._bbBoundary;
  }

  _hideBBGhost() {
    if (this._bbGhost) this._bbGhost.visible = false;
    if (this._bbBoundary) this._bbBoundary.visible = false;
  }

  _bbGhostMove(e) {
    const raw = this._groundPoint(e, true);
    if (!raw) { this._hideBBGhost(); return; }
    const ctx = this._bbGetConstraints();
    const item = this._bbDraftItem([raw.x, raw.z]);
    const sp = snapPlacement(raw, item, ctx, { snapStep: this._snap, roadSnap: this._bbSnapOn });
    const v = validatePlacement(item, ctx, sp.pos);
    const color = !v.ok ? BB_COLORS.invalid : (sp.onRoad ? BB_COLORS.road : BB_COLORS.grid);

    this._ensureBBGhost();
    const g = this._bbGhost;
    g.position.set(sp.pos[0], -this._curveOffset(sp.pos[0], sp.pos[1]), sp.pos[1]);
    g.rotation.y = 0;
    g.visible = true;
    editorGhostMaterial().color.setHex(color);

    const bd = this._ensureBBBoundary();
    updateFootprintBoundary(bd, item, color);
    bd.position.copy(g.position);
    bd.rotation.y = 0;

    this._bbLastPlace = { pos: sp.pos, onRoad: sp.onRoad, ok: v.ok, reasons: v.reasons };
    const f = footprintOf(item);
    const size = `${(f.hx * 2).toFixed(1)}×${(f.hz * 2).toFixed(1)}m`;
    const msg = !v.ok
      ? `不可放置：占位压到${reasonText(v.reasons)}（红框）· 占位 ${size}`
      : `${MOUNTS[this._bbDraft.mount].label} · ${sp.onRoad ? "已吸附路缘" : "网格吸附"} · 合法占位 ${size} · 单击放置`;
    if (msg !== this._bbLastStatus) { this.status(msg); this._bbLastStatus = msg; }
  }

  // 未选中的大屏不显示边界（展示模型原样）；选中的那块才显示合法/冲突色。
  // 边界是 wrapper 的子节点，随 Gizmo 平移旋转一起走，改尺寸后由重建刷新几何。
  _updateBBSelection() {
    for (const w of this._wrappers ? this._wrappers.values() : []) {
      if (w.bbEmbedded) w.bbEmbedded.visible = false;
    }
    const sel = this.sel;
    if (!sel || !sel.bbEmbedded || sel.kind !== "object" || !sel.data || sel.data.type !== "billboard") return;
    sel.bbEmbedded.visible = true;
    const v = validatePlacement(sel.data, this._bbGetConstraints());
    const color = v.ok ? BB_COLORS.grid : BB_COLORS.invalid;
    for (const c of sel.bbEmbedded.children) c.material.color.setHex(color);
  }

  // 放置工具无选中时：先从「模型工坊 · 广告牌资产库」选模型，再调实例尺寸。
  // 四种广告牌 = 四条资产记录；新增承载形式只需在资产库里加记录，这里自动列出。
  async _renderBBPicker(el) {
    let assets = await listAssets({ category: "billboard" });
    if (!assets.length) { await ensureBillboardAssets(); assets = await listAssets({ category: "billboard" }); }
    if (this._disposed) return;
    assets = assets.filter((a) => a && a.billboard);
    this._bbAssets = assets;
    if (!this._bbAsset || !assets.some((a) => a.id === this._bbAsset.id)) {
      this._bbAsset = assets.find((a) => a.billboard && a.billboard.mount === "standalone") || assets[0] || null;
    }
    if (this._bbAsset) this._bbDraft = billboardParamsFor({ params: {} }, this._bbAsset);
    if (this._bbThumbUrls) for (const u of Object.values(this._bbThumbUrls)) URL.revokeObjectURL(u);
    this._bbThumbUrls = {};
    const d = this._bbDraft;
    const cards = assets.map((a) => {
      const sp = (a.billboard && a.billboard.spec) || {};
      const label = MOUNTS[a.billboard && a.billboard.mount] ? MOUNTS[a.billboard.mount].label : (a.name || "广告牌");
      const active = this._bbAsset && this._bbAsset.id === a.id;
      return `<div class="me-asset-item${active ? " active" : ""}" data-id="${escHtml(a.id)}">
        ${a.thumb ? `<img src="${this._bbThumbUrls[a.id] = URL.createObjectURL(a.thumb)}" alt="" />` : `<span class="me-asset-thumb-empty"></span>`}
        <div class="me-asset-info"><b>${escHtml(a.name || label)}</b><small>${escHtml(label)} · ${sp.w || "?"}×${sp.h || "?"}m</small></div>
      </div>`;
    }).join("");
    el.innerHTML = `
      <h4>广告牌模型 <small>ASSET LIBRARY</small></h4>
      ${cards || `<p class="me-hint">广告牌资产库为空，去「模型工坊」新建广告牌资产。</p>`}
      <div class="me-hint">模型几何来自资产库；下方仅调整这一块的实例尺寸（不写回资产）。移动鼠标预览占位：<b style="color:#2ce8c0">青</b>=合法、<b style="color:#ffc24d">金</b>=路缘、<b style="color:#ff4d5e">红</b>=冲突。</div>
      <label class="me-row">屏宽(m)<input id="ep-bbp-w" class="me-input-wide" type="number" min="4" max="40" step="1" value="${d.w}" /></label>
      <label class="me-row">屏高(m)<input id="ep-bbp-h" class="me-input-wide" type="number" min="2" max="30" step="1" value="${d.h}" /></label>
      <label class="me-row">屏心高度(m)<input id="ep-bbp-y" class="me-input-wide" type="number" min="3" max="120" step="1" value="${d.y}" /></label>`;
    const refresh = () => {
      this._bbGhostKey = "";
      if (this._bbLastEvent) this._bbGhostMove(this._bbLastEvent);
    };
    for (const item of el.querySelectorAll(".me-asset-item")) {
      item.addEventListener("click", () => {
        this._bbAsset = assets.find((x) => x.id === item.dataset.id) || null;
        if (this._bbAsset) this._bbDraft = billboardParamsFor({ params: {} }, this._bbAsset);
        this.status(`已选择广告牌资产「${this._bbAsset ? this._bbAsset.name : "?"}」· 点击地图放置`);
        this._renderBBPicker(el);
        refresh();
      });
    }
    for (const [id, k, min, max] of [["w", "w", 4, 40], ["h", "h", 2, 30], ["y", "y", 3, 120]]) {
      el.querySelector(`#ep-bbp-${id}`).addEventListener("change", (e) => {
        this._bbDraft[k] = clamp(+e.target.value || this._bbDraft[k], min, max);
        e.target.value = this._bbDraft[k];
        refresh();
      });
    }
  }

  // 右侧「我的模型」选择面板（place-asset 工具的无选中状态）
  async _renderAssetPicker(el) {
    const list = await listAssets();
    if (this._pickerThumbUrls) for (const u of Object.values(this._pickerThumbUrls)) URL.revokeObjectURL(u);
    this._pickerThumbUrls = {};
    el.innerHTML = `
      <h4>我的模型 <small>ASSETS</small></h4>
      ${list.length ? list.map((a) => {
        const sz = a.source === "traced" ? tracedUnitSize(a) : a.unitSize;
        return `
        <div class="me-asset-item${this._placingAsset && this._placingAsset.id === a.id ? " active" : ""}" data-id="${a.id}">
          ${a.thumb ? `<img src="${this._pickerThumbUrls[a.id] = URL.createObjectURL(a.thumb)}" alt="" />` : `<span class="me-asset-thumb-empty"></span>`}
          <div class="me-asset-info">
            <b>${escHtml(a.name || "未命名")}</b>
            <small>${escHtml(a.category || "")} · 放置适配 ${this._assetPlaceTarget(a)}m · ${sz ? `${sz.x}×${sz.y}×${sz.z}m` : "?"}</small>
          </div>
        </div>`;
      }).join("")
      : `<p class="me-hint">资产库为空。去「模型工坊」导入 GLB 或新建模型。</p>`}
      ${this._placingAsset && (this._placingAsset.source === "glb" || this._placingAsset.source === "traced") ? `
      <label class="me-asset-target">「${escHtml(this._placingAsset.name || "该模型")}」放置目标尺寸（米 · 最大边）
        <input id="me-asset-place-size" type="number" min="0.05" max="2000" step="0.1" value="${this._assetPlaceTarget(this._placingAsset)}" />
      </label>
      <div class="me-hint">按名称/分类智能推断（椅子约 1.2m、建筑约 30m），可在这里改，会存进资产。</div>` : ""}
      <label class="me-asset-target">全局兜底尺寸（无智能推断时用）
        <input id="me-asset-target" type="number" min="1" max="2000" step="1" value="${this._assetTargetSize || 30}" />
      </label>
      <p class="me-hint">选中后移动鼠标预览位置：靠近道路自动吸附路缘（金框），空白处按网格吸附（蓝框）· 单击放置 · Gizmo 可移动/旋转 · Delete 删除 · E 键旋转朝向</p>`;
    el.querySelector("#me-asset-target").addEventListener("change", (e) => {
      this._assetTargetSize = clamp(+e.target.value || 30, 1, 2000);
      e.target.value = this._assetTargetSize;
      this._renderAssetPicker(el);
    });
    const sizeInput = el.querySelector("#me-asset-place-size");
    if (sizeInput) sizeInput.addEventListener("change", async (e) => {
      const a = this._placingAsset;
      if (!a) return;
      a.placeSize = clamp(+e.target.value || this._assetPlaceTarget(a), 0.05, 2000);
      e.target.value = a.placeSize;
      await putAsset(a);
      this._assetCache.set(a.id, a);
      invalidateAssetTemplate(a.id); // 描边资产几何按新目标尺寸重建
      this.status(`「${a.name}」放置尺寸已设为 ${a.placeSize}m，已存入资产`);
      this._renderAssetPicker(el);
    });
    for (const item of el.querySelectorAll(".me-asset-item")) {
      item.addEventListener("click", () => {
        const a = list.find((x) => x.id === item.dataset.id);
        if (!a) return;
        this._placingAsset = a;
        if (!this._assetCache.has(a.id)) this._assetCache.set(a.id, a);
        this.status(`已选择「${a.name}」· 点击地图放置`);
        this._renderAssetPicker(el);
      });
    }
  }

  // 标准材料库 → 下拉框选项（按分类分组，含"默认"项 = 不指定材质）
  _materialOptions(categories, selected) {
    const CAT_ZH = { facade: "外墙贴图", roof: "屋顶", surface: "通用材质", storefront: "店面贴图", sign: "招牌" };
    const mats = listMaterials(categories);
    let html = `<option value=""${!selected ? " selected" : ""}>默认（素色）</option>`;
    for (const cat of categories) {
      const group = mats.filter((m) => m.category === cat);
      if (!group.length) continue;
      html += `<optgroup label="${CAT_ZH[cat] || cat}">`;
      for (const m of group) {
        html += `<option value="${m.id}"${m.id === selected ? " selected" : ""}>${m.name}</option>`;
      }
      html += `</optgroup>`;
    }
    return html;
  }

  _addObject(data) {
    this.map.objects.push(data);
    this._bbConstraints = null; // 新物件（尤其是大屏/建筑）参与后续摆放避让
    const m = this._buildObjectMesh(data);
    if (m) { this._select(this._makeWrapper("object", data, m)); }
  }

  /* ---------------- selection / properties ---------------- */
  _select(w) {
    if (this._rtGroupHelper && (!w || w.kind !== "roadGroup")) this._clearGroupVisuals();
    const wasRoad = this.sel && (this.sel.kind === "roadX" || this.sel.kind === "roadZ" || this.sel.kind === "road");
    this.sel = w;
    const tc = this._three.tc;
    if (w) {
      tc.attach(w.root);
      tc.setMode("translate");
      this._renderProps();
    } else {
      tc.detach();
      this._renderProps();
    }
    // 选中高亮框跟随：仅物件（建筑/树/路灯）显示，拖拽/重建后由 tick 循环保持同步
    if (this._selHelper) {
      if (w && w.kind === "object") {
        this._selHelper.setFromObject(w.root);
        this._selHelper.visible = true;
      } else {
        this._selHelper.visible = false;
      }
    }
    // 道路（程序化/描边）选中/取消时刷新骨架高亮（金色 = 选中）
    if (wasRoad || (w && (w.kind === "roadX" || w.kind === "roadZ" || w.kind === "road"))) this._rebuildSkeleton();
    this._updateBBSelection();
  }

  _syncGizmoToData(commit = false) {
    if (!this.sel) return;
    const r = this.sel.root;
    if (this.sel.kind === "area") { this._syncAreaFromGroup(true); return; }
    if (this.sel.kind === "roadX" || this.sel.kind === "roadZ") {
      // 程序化道路：只取拖动轴上的坐标（roadsX 沿 X / roadsZ 沿 Z）
      const v = Math.round(this.sel.kind === "roadX" ? r.position.x : r.position.z);
      if (v !== this.sel.data.at) {
        this.sel.data.at = v;
        this._rebuildSkeleton();
      }
      if (this.sel.kind === "roadX") r.position.set(v, 0, 0);
      else r.position.set(0, 0, v);
      this._dirty = true;
      return;
    }
    if (this.sel.kind === "roadGroup") {
      // 整条拼接路：把代理相对基线的位移/旋转增量刚性应用到组内每块
      // （绕基线锚点旋转 + 平移，块间端口贴合关系保持），随后全量重建刷新端头
      const base = this._rtGroupBaseline;
      if (base) {
        const dx = r.position.x - base.px, dz = r.position.z - base.pz;
        const dr = (r.rotation.y || 0) - base.dr;
        const cos = Math.cos(dr), sin = Math.sin(dr);
        const q = (v) => Math.round(v * 1e4) / 1e4;
        for (const b of base.tiles) {
          const ox = b.x - base.px, oz = b.z - base.pz;
          b.t.x = q(base.px + ox * cos + oz * sin + dx);
          b.t.z = q(base.pz - ox * sin + oz * cos + dz);
          b.t.rot = q(b.rot + dr);
        }
        this._rebuildAll(); // 端口位置变了 → miter/圆弧端头按新拓扑重算
        this._rtGroupBaseline = {
          px: r.position.x, pz: r.position.z, dr: r.rotation.y || 0,
          tiles: this.sel.data.map((t) => ({ t, x: t.x, z: t.z, rot: t.rot || 0 })),
        };
        this._updateGroupHelper();
        this.status(`整条路已移动（${this.sel.data.length} 块）· 可继续拖动调整 · Ctrl+Z 撤销`);
      }
      r.position.y = 0; // 组只在地面平移/旋转，忽略误拖的竖直轴
      this._dirty = true;
      return;
    }
    if (this.sel.kind === "object") {
      this.sel.data.pos = [Math.round(r.position.x * 10) / 10, Math.round(r.position.z * 10) / 10];
      this.sel.data.rot = Math.round((r.rotation.y || 0) * 100) / 100;
      r.position.y = -this._curveOffset(r.position.x, r.position.z); // 维持球面贴合
      if (this.sel.data.type === "billboard") this._updateBBSelection(); // 拖动中边界实时跟随
    } else if (this.sel.kind === "roadTile") {
      this.sel.data.x = Math.round(r.position.x * 10) / 10;
      this.sel.data.z = Math.round(r.position.z * 10) / 10;
      this.sel.data.rot = Math.round((r.rotation.y || 0) * 1000) / 1000;
      r.position.y = -this._curveOffset(r.position.x, r.position.z); // 维持球面贴合
      if (commit) this._rtHealTile(this.sel.data); // 松手自愈：端口吸回邻近端口
    } else {
      const d = this.sel.data;
      d.points = d.points.map(([x, z]) => [x + Math.round(r.position.x * 10) / 10, z + Math.round(r.position.z * 10) / 10]);
      r.position.set(0, 0, 0);
      this._rebuildAll();
      const w = this._wrappers.get(d.id);
      if (w) { this.sel = w; this._three.tc.attach(w.root); }
    }
    this._dirty = true;
  }

  // 拼接路块拖拽松手自愈：单块被挪/转后端口错开（超过配对半径就不再焊接，
  // 留下方口楔缝）。RT_PAIR_TOL 内有其他块的端口时，把整块平移吸回最近的一对
  // —— 焊接公式对端口错位/转角免疫，平移对齐即可无缝；只平移不转（转动会
  // 带着另一端端口跑，残余错位交给宽容配对处理）
  _rtHealTile(t) {
    const tiles = this.map.features.roadTiles || [];
    const my = tilePorts(t);
    let best = null;
    for (const o of tiles) {
      if (o === t) continue;
      for (const p of tilePorts(o)) {
        for (let i = 0; i < 2; i++) {
          const d = Math.hypot(p.x - my[i].x, p.z - my[i].z);
          if (d < RT_PAIR_TOL && (!best || d < best.d)) best = { d, dx: p.x - my[i].x, dz: p.z - my[i].z };
        }
      }
    }
    if (!best) return;
    const q = (v) => Math.round(v * 1e4) / 1e4;
    t.x = q(t.x + best.dx);
    t.z = q(t.z + best.dz);
    this._rebuildAll(); // 端口对齐 → 端头焊接按新拓扑重算
    const w = this._wrappers.get(t.id);
    if (w) { this.sel = w; this._three.tc.attach(w.root); }
    this.status(`路块已自动吸附邻近端口（错位 ${best.d.toFixed(2)}m）· Ctrl+Z 撤销`);
  }

  _deleteSel() {
    if (!this.sel) return;
    if (this.sel.kind === "area") { this.status("地图范围不可删除，可在右侧重新描边或用 Gizmo 调整"); return; }
    const { kind, data } = this.sel;
    if (kind === "roadX") this.map.roadsX = this.map.roadsX.filter((r) => r !== data);
    else if (kind === "roadZ") this.map.roadsZ = this.map.roadsZ.filter((r) => r !== data);
    else if (kind === "road") this.map.features.roads = this.map.features.roads.filter((r) => r !== data);
    else if (kind === "river") this.map.features.rivers = this.map.features.rivers.filter((r) => r !== data);
    else if (kind === "roadTile") this.map.features.roadTiles = (this.map.features.roadTiles || []).filter((t) => t !== data);
    else if (kind === "roadGroup") {
      // 整条拼接路删除：按组过滤（组内块集合），剩余块按端口拓扑自动重分组
      const set = new Set(data);
      this.map.features.roadTiles = (this.map.features.roadTiles || []).filter((t) => !set.has(t));
    } else this.map.objects = this.map.objects.filter((o) => o !== data);
    this._three.tc.detach();
    this.sel = null;
    this._clearGroupVisuals();
    this._rebuildAll();
    this._pushUndo("删除");
    this._renderProps(); // 删除后右侧面板回无选中态（路块编辑模式 = 拼接面板）
    this.status(kind === "roadGroup" ? `已删除整条拼接路（${data.length} 块）` : "已删除");
  }

  _renderProps() {
    const el = document.getElementById("e3-props");
    if (!this.sel && this.tool === "place-road") { rtRenderPanel(this); return; } // 路块工具无选中：右侧显示拼接面板（含添加/编辑模式切换），而非地图统计
    if (!this.sel && this.tool === "place-asset") { this._renderAssetPicker(el); return; } // 资产工具无选中：右侧显示「我的模型」选择面板
    if (!this.sel && this.tool === "place-billboard") { this._renderBBPicker(el); return; } // 大屏工具无选中：先选承载形式/尺寸
    if (!this.sel) {
      const f = this.map.features;
      const opT = Math.round((1 - (this.map.gridOpacity ?? GRID_OPACITY_DEFAULT)) * 100); // 网格透明度%（0=默认浓度，100=完全透出影像）
      el.innerHTML = `
        <h4 class="me-tiprow">地图内容<span class="me-tip" data-tip="描边道路：道路菜单 →「地图描边」沿影像勾画 · 河流：折线描边（双击结束）· 建筑：多边形描边（≥3 点自动闭合）· 树 / 路灯：点击放置 · W/E/R 切换移动 / 旋转 / 缩放">?</span></h4>
        <div class="me-stat">描边道路 <b>${f.roads.length}</b></div>
        <div class="me-stat">河流 <b>${f.rivers.length}</b></div>
        <div class="me-stat">拼接路块 <b>${(f.roadTiles || []).length}</b></div>
        <div class="me-stat">建筑/物件 <b>${this.map.objects.length}</b></div>
        <div class="me-stat me-tiprow">程序化路网 <b>${this.map.roadsX.length}×${this.map.roadsZ.length}</b>（2D 编辑器管理）<span class="me-tip" data-tip="灰色路带 / 紫色圆点 / 绿色标记 = 程序化城市骨架，与游戏实际生成的街道一致，仅显示不可选中；手工道路可点选编辑。两个编辑器编辑的是同一张地图。">?</span></div>
        <label class="me-check me-tiprow" data-tip="勾选后按固定间距自动补满世界边缘的默认街道（游戏内与预览同步）；不勾选则只保留手工道路。放置拼接路且程序化城市开启时，游戏内仅在拼接路越出路网的外侧补一条不可见的虚拟边界（不画线、无路口、不进交通图），仅用于划分街区：横纵路标线延伸到拼接路，相交区域正常生成建筑。"><input id="ep-ext" type="checkbox" ${this.map.extRoads ? "checked" : ""} /> 程序化延伸街道</label>
        <div class="me-slider">
          <div class="me-slider-head"><span>网格透明度</span><b id="ep-grid-op-val">${opT}%</b></div>
          <input id="ep-grid-op-range" type="range" min="0" max="100" step="5" value="${opT}" style="--fill: ${opT}%" />
        </div>
        <h4 class="me-tiprow">程序化城市<span class="me-tip" data-tip="勾选后才会在手工路网之间自动生成街区（建筑、绿植、路灯）；不勾选则只保留手工路网与描边内容。保存后进入游戏生效，两个编辑器编辑的是同一张地图。">?</span></h4>
        ${genParamsHtml(this.map, "ep")}`;
      el.querySelector("#ep-ext").addEventListener("change", (e) => {
        this.map.extRoads = !!e.target.checked;
        this._dirty = true;
        this._rebuildSkeleton();
        this._pushUndo("延伸街道开关");
      });
      const opRange = el.querySelector("#ep-grid-op-range");
      opRange.addEventListener("input", () => {
        this.map.gridOpacity = 1 - +opRange.value / 100;
        el.querySelector("#ep-grid-op-val").textContent = `${opRange.value}%`;
        opRange.style.setProperty("--fill", `${opRange.value}%`);
        this._applyGridOpacity();
        this._dirty = true;
      });
      bindGenParams(el, this.map, "ep", () => { this._dirty = true; });
      return;
    }
    const { kind, data } = this.sel;
    const posEl = (x, z) => `<div class="me-pos">X ${Math.round(x)} · Z ${Math.round(z)}</div>`;
    if (kind === "area") {
      const a = this._areaEnsure();
      const apply = (patch) => {
        Object.assign(this._areaEnsure(), patch);
        this._applyAreaToGroup();
        this._bendArea();
        this._rebuildAll(); // 曲率零基准变化，重建内容
        this._pushUndo("调整范围");
        this._renderProps(); // 刷新数值显示
      };
      const num = (id) => parseFloat(el.querySelector(id).value) || 0;
      if (a.pts) {
        // 多边形范围：中心可平移整体顶点，可重描/转矩形
        el.innerHTML = `
          <h4>地图范围 · 属性</h4>
          <div class="me-pos">多边形 · ${a.pts.length} 个顶点</div>
          <div class="me-xy">
            <label>中心X(m)<input id="ep-cx" type="number" step="10" value="${a.cx}" /></label>
            <label>中心Z(m)<input id="ep-cz" type="number" step="10" value="${a.cz}" /></label>
          </div>
          <button class="me-btn" id="ep-redraw">重新描边绘制</button>
          <button class="me-btn" id="ep-torect">转为矩形</button>
          <p class="me-hint">Gizmo 拖拽整体移动（多边形不支持旋转/缩放）；重新描边可绘制任意形状</p>`;
        const movePoly = () => {
          const a2 = this._areaEnsure();
          const dx = Math.round(num("#ep-cx")) - a2.cx, dz = Math.round(num("#ep-cz")) - a2.cz;
          if (!dx && !dz) return;
          a2.pts = a2.pts.map(([x, z]) => [x + dx, z + dz]);
          a2.cx += dx; a2.cz += dz;
          this._shiftOrigin(dx, dz);
          this._rebuildAreaMeshes();
          this._applyAreaToGroup();
          this._bendArea();
          this._rebuildAll();
          this._pushUndo("调整范围");
          this._renderProps();
        };
        el.querySelector("#ep-cx").addEventListener("change", movePoly);
        el.querySelector("#ep-cz").addEventListener("change", movePoly);
        el.querySelector("#ep-redraw").addEventListener("click", () => this._startAreaDraft());
        el.querySelector("#ep-torect").addEventListener("click", () => {
          // 多边形 → 外接矩形（中心迁移补偿进 origin，内容不动）
          let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
          for (const [x, z] of a.pts) {
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
          }
          const ncx = Math.round((minX + maxX) / 2), ncz = Math.round((minZ + maxZ) / 2);
          this._shiftOrigin(ncx - a.cx, ncz - a.cz);
          this.map.area = {
            cx: ncx, cz: ncz,
            w: clamp(Math.round(maxX - minX), 200, 20000),
            d: clamp(Math.round(maxZ - minZ), 200, 20000),
            rot: 0,
          };
          this._rebuildAreaMeshes();
          this._applyAreaToGroup();
          this._bendArea();
          this._rebuildAll();
          this._updateEnu();
          this._pushUndo("范围转矩形");
          this._renderProps();
        });
        return;
      }
      el.innerHTML = `
        <h4>地图范围 · 属性</h4>
        <div class="me-xy">
          <label>中心X(m)<input id="ep-cx" type="number" step="10" value="${a.cx}" /></label>
          <label>中心Z(m)<input id="ep-cz" type="number" step="10" value="${a.cz}" /></label>
        </div>
        <div class="me-xy">
          <label>宽 W(m)<input id="ep-w" type="number" min="200" max="20000" step="100" value="${a.w}" /></label>
          <label>深 D(m)<input id="ep-d" type="number" min="200" max="20000" step="100" value="${a.d}" /></label>
        </div>
        <label>旋转(°)<input id="ep-rot" type="number" min="-180" max="180" step="1" value="${Math.round((a.rot * 180) / Math.PI)}" /></label>
        <button class="me-btn" id="ep-draw">描边绘制多边形</button>
        <p class="me-hint">也可用 Gizmo：W 移动 / E 旋转方向 / R 缩放大小；描边可在底图上绘制任意形状范围</p>`;
      el.querySelector("#ep-cx").addEventListener("change", () => apply({ cx: num("#ep-cx") }));
      el.querySelector("#ep-cz").addEventListener("change", () => apply({ cz: num("#ep-cz") }));
      el.querySelector("#ep-w").addEventListener("change", () => apply({ w: clamp(num("#ep-w"), 200, 20000) }));
      el.querySelector("#ep-d").addEventListener("change", () => apply({ d: clamp(num("#ep-d"), 200, 20000) }));
      el.querySelector("#ep-rot").addEventListener("change", () => apply({ rot: (clamp(num("#ep-rot"), -180, 180) * Math.PI) / 180 }));
      el.querySelector("#ep-draw").addEventListener("click", () => this._startAreaDraft());
      return;
    }
    if (kind === "roadX" || kind === "roadZ") {
      const r = data;
      el.innerHTML = `
        <h4>${kind === "roadX" ? "纵向路" : "横向路"} · 属性</h4>
        <label>名称<input id="ep-r-zh" value="${r.zh || ""}" maxlength="10" /></label>
        <label>英文名<input id="ep-r-en" value="${r.en || ""}" maxlength="24" /></label>
        <label>类型<select id="ep-r-kind">${ROAD_KINDS.map((k) => `<option value="${k}" ${k === (r.kind || "street") ? "selected" : ""}>${ROAD_KIND_ZH[k]}</option>`).join("")}</select></label>
        <label>车道（每条宽3.4m）<select id="ep-r-lanes">${[1, 2, 3, 4].map((n) => `<option ${n === (r.lanes || 1) ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        <label>人行道宽（m）<input id="ep-r-sw" type="number" min="0" max="12" value="${r.sidewalk ?? 3}" /></label>
        <label>分隔带宽（m）<input id="ep-r-md" type="number" min="0" max="14" value="${r.median ?? 0}" /></label>
        <div class="me-pos">${kind === "roadX" ? `X ${r.at}` : `Z ${r.at}`}</div>
        <button class="me-del" id="ep-r-del">删除道路</button>`;
      const edit = (fn) => (e) => {
        fn(e);
        this._dirty = true;
        this._rebuildSkeleton();
        this._pushUndo("编辑道路");
      };
      // 文本名逐键实时写入（change 需失焦，输完直接点画布会随面板重绘丢失），提交时再重建/入栈
      const live = (fn) => (e) => { fn(e); this._dirty = true; };
      el.querySelector("#ep-r-zh").addEventListener("input", live((e) => { r.zh = e.target.value; }));
      el.querySelector("#ep-r-en").addEventListener("input", live((e) => { r.en = e.target.value; }));
      el.querySelector("#ep-r-zh").addEventListener("change", edit(() => {}));
      el.querySelector("#ep-r-en").addEventListener("change", edit(() => {}));
      el.querySelector("#ep-r-kind").addEventListener("change", edit((e) => { r.kind = e.target.value; }));
      el.querySelector("#ep-r-lanes").addEventListener("change", edit((e) => { r.lanes = +e.target.value || 1; }));
      el.querySelector("#ep-r-sw").addEventListener("change", edit((e) => { r.sidewalk = clamp(+e.target.value || 0, 0, 12); }));
      el.querySelector("#ep-r-md").addEventListener("change", edit((e) => { r.median = clamp(+e.target.value || 0, 0, 14); }));
      el.querySelector("#ep-r-del").addEventListener("click", () => this._deleteSel());
      return;
    }
    if (kind === "road") {
      // 描边道路：与程序化横/纵路同套属性（名称/英文/类型/人行道/分隔带）。
      // 无车道数——描边路宽度即路幅，路面宽窄由「宽度」决定
      const r = data;
      const poly = !!r.closed;
      el.innerHTML = `
        <h4>${poly ? "面道路" : "描边道路"} · 属性</h4>
        <label>名称<input id="ep-r-zh" value="${(r.zh ?? r.name) || ""}" maxlength="10" /></label>
        <label>英文名<input id="ep-r-en" value="${r.en || ""}" maxlength="24" /></label>
        <label>类型<select id="ep-r-kind">${ROAD_KINDS.map((k) => `<option value="${k}" ${k === (r.kind || "street") ? "selected" : ""}>${ROAD_KIND_ZH[k]}</option>`).join("")}</select></label>
        <label>车道（每方向）<select id="ep-r-lanes">${[1, 2, 3, 4].map((n) => `<option ${n === (r.lanes || 2) ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        ${poly ? "" : `<label>宽度(m)<input id="ep-w" type="number" min="4" max="80" value="${r.width}" /></label>`}
        <label>人行道宽（m）<input id="ep-r-sw" type="number" min="0" max="12" value="${r.sidewalk ?? 3}" /></label>
        <label>分隔带宽（m）<input id="ep-r-md" type="number" min="0" max="14" value="${r.median ?? 0}" /></label>
        <div class="me-pos">${r.points.length} 个点${poly ? ` · 约 ${Math.round(Math.abs(this._polyArea(r.points)))}㎡` : ""}</div>
        <button class="me-del" id="ep-del">删除道路</button>`;
      const edit = (fn) => (e) => {
        fn(e);
        this._dirty = true;
        this._rebuildAll();
        const w = this._wrappers.get(r.id);
        if (w) { this.sel = w; this._three.tc.attach(w.root); } // 重建后接回新 wrapper，保持选中
        this._pushUndo("编辑描边道路");
      };
      // 名称逐键实时写入（change 需失焦，输完直接点画布会随面板重绘丢失），失焦时再重建/入栈
      const live = (fn) => (e) => { fn(e); this._dirty = true; };
      el.querySelector("#ep-r-zh").addEventListener("input", live((e) => { r.zh = e.target.value; }));
      el.querySelector("#ep-r-en").addEventListener("input", live((e) => { r.en = e.target.value; }));
      el.querySelector("#ep-r-zh").addEventListener("change", edit(() => {}));
      el.querySelector("#ep-r-en").addEventListener("change", edit(() => {}));
      el.querySelector("#ep-r-kind").addEventListener("change", edit((e) => { r.kind = e.target.value; }));
      el.querySelector("#ep-r-lanes").addEventListener("change", edit((e) => { r.lanes = +e.target.value || 2; }));
      el.querySelector("#ep-r-sw").addEventListener("change", edit((e) => { r.sidewalk = clamp(+e.target.value || 0, 0, 12); }));
      el.querySelector("#ep-r-md").addEventListener("change", edit((e) => { r.median = clamp(+e.target.value || 0, 0, 14); }));
      if (!poly) {
        el.querySelector("#ep-w").addEventListener("input", (e) => {
          r.width = clamp(+e.target.value || 12, 4, 80);
          this._rebuildAll(); this._dirty = true;
          const w = this._wrappers.get(r.id);
          if (w) { this.sel = w; this._three.tc.attach(w.root); } // 同步 Gizmo，但不重绘面板（避免输入被打断丢失）
        });
        el.querySelector("#ep-w").addEventListener("change", () => this._pushUndo("调整道路宽度"));
      }
      el.querySelector("#ep-del").addEventListener("click", () => this._deleteSel());
      return;
    }
    if (kind === "roadGroup") {
      const tiles = data;
      const total = tiles.reduce((s, t) => s + (t.len || 3), 0);
      // 组级公共属性随块存储（组是端口拓扑的派生分组，不落数据）：显示取组内
      // 第一个有值的块，编辑批量写入组内所有块；新块放置时从连通旧块自动继承
      const prop = (k, d) => { for (const t of tiles) if (t[k] !== undefined) return t[k]; return d; };
      const zh = prop("zh", ""), en = prop("en", ""), rkind = prop("kind", "street");
      const lanes = prop("lanes", 1), sw = prop("sidewalk", 3), md = prop("median", 0);
      el.innerHTML = `
        <h4>拼接路 · 整条</h4>
        <div class="me-stat">路块 <b>${tiles.length}</b> · 总长约 <b>${Math.round(total)}m</b></div>
        <label>名称<input id="ep-r-zh" value="${zh}" maxlength="10" /></label>
        <label>英文名<input id="ep-r-en" value="${en}" maxlength="24" /></label>
        <label>类型<select id="ep-r-kind">${ROAD_KINDS.map((k) => `<option value="${k}" ${k === rkind ? "selected" : ""}>${ROAD_KIND_ZH[k]}</option>`).join("")}</select></label>
        <label>车道（每方向）<select id="ep-r-lanes">${[1, 2, 3, 4].map((n) => `<option ${n === lanes ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        <label>人行道宽（m）<input id="ep-r-sw" type="number" min="0" max="12" value="${sw}" /></label>
        <label>分隔带宽（m）<input id="ep-r-md" type="number" min="0" max="14" value="${md}" /></label>
        <div class="me-pos">按端口连通自动分组：整条移动/旋转时块间贴合关系保持</div>
        <button class="me-btn" id="ep-rg-one">单独编辑一块</button>
        <button class="me-del" id="ep-del">删除整条路</button>
        <p class="me-hint">公共属性（名称/类型/车道/人行道/分隔带）与横纵路同套，批量写入组内所有路块；链条延续或磁吸并入的新块自动继承。车道数会同步刷新路块贴图。Gizmo 平移整条路；E 键切旋转 = 绕组质心整体旋转。「单独编辑」后再点组内任一路块可单块调整；Ctrl+Z 撤销。</p>`;
      // 公共属性批量写组内所有块；名称同横纵路逐键实时写（change 需失焦），change 时入撤销栈
      const writeAll = (fn) => { for (const t of tiles) fn(t); this._dirty = true; };
      const editAll = (fn, label) => { writeAll(fn); this._pushUndo(label); };
      const live = (fn) => (e) => writeAll((t) => fn(t, e));
      el.querySelector("#ep-r-zh").addEventListener("input", live((t, e) => { t.zh = e.target.value; }));
      el.querySelector("#ep-r-en").addEventListener("input", live((t, e) => { t.en = e.target.value; }));
      el.querySelector("#ep-r-zh").addEventListener("change", () => editAll(() => {}, "编辑拼接路名称"));
      el.querySelector("#ep-r-en").addEventListener("change", () => editAll(() => {}, "编辑拼接路英文名"));
      el.querySelector("#ep-r-kind").addEventListener("change", (e) => editAll((t) => { t.kind = e.target.value; }, "编辑拼接路类型"));
      el.querySelector("#ep-r-lanes").addEventListener("change", (e) => {
        editAll((t) => { t.lanes = +e.target.value || 1; }, "编辑拼接路车道数");
        rtRebuildGroup(this, tiles); // 车道数影响路块贴图车道线：组内网格重建（组选择 / Gizmo 不动）
        this.status("已更新整条路车道数 · 路块贴图已刷新");
      });
      el.querySelector("#ep-r-sw").addEventListener("change", (e) => editAll((t) => { t.sidewalk = clamp(+e.target.value || 0, 0, 12); }, "编辑拼接路人行道"));
      el.querySelector("#ep-r-md").addEventListener("change", (e) => editAll((t) => { t.median = clamp(+e.target.value || 0, 0, 14); }, "编辑拼接路分隔带"));
      el.querySelector("#ep-del").addEventListener("click", () => this._deleteSel());
      el.querySelector("#ep-rg-one").addEventListener("click", () => {
        if (this._rtGroupFocus && this._wrappers.get(this._rtGroupFocus.data.id)) this._select(this._rtGroupFocus);
        else this.status("单击组内任一路块即可单独选中编辑");
      });
      return;
    }
    if (kind === "roadTile") {
      const t = data;
      const grpN = rtRoadGroupOf(this.map.features.roadTiles || [], t).length;
      el.innerHTML = `
        <h4>路块 · 属性</h4>
        <div class="trace-row">${Object.entries(TILE_STYLE_ZH).map(([k, z]) => `<button class="trace-seg${t.style === k ? " active" : ""}" data-style="${k}">${z}</button>`).join("")}</div>
        <div class="me-stat">每方向车道数</div>
        <div class="trace-wrow">
          ${[1, 2, 3, 4].map((v) => `<button class="trace-w${(t.lanes || 1) === v ? " active" : ""}" data-lanes="${v}">${v}</button>`).join("")}
        </div>
        <div class="me-pos">X ${t.x} · Z ${t.z} · ${(t.len || 3)}×${t.w || 2}m · ${Math.round(((t.rot || 0) * 180) / Math.PI)}°</div>
        ${grpN > 1 ? `<button class="me-btn" id="ep-tile-group">选中整条路（${grpN} 块）</button>` : ""}
        <button class="me-del" id="ep-del">删除路块</button>
        <p class="me-hint">Gizmo 拖动/旋转（E 键切旋转）会同步更新端口位置，其他路块可重新磁吸到新端口</p>`;
      const editTile = (label) => {
        rtRebuildOne(this, t); // 单块重建，避免全量 rebuild 卡顿
        this._dirty = true;
        this._pushUndo(label);
        this._renderProps();
      };
      el.querySelectorAll("[data-style]").forEach((b) => b.addEventListener("click", () => {
        t.style = b.dataset.style;
        editTile("路块样式");
      }));
      el.querySelectorAll("[data-lanes]").forEach((b) => b.addEventListener("click", () => {
        t.lanes = +b.dataset.lanes;
        editTile("路块车道数");
      }));
      el.querySelector("#ep-del").addEventListener("click", () => this._deleteSel());
      const grpBtn = el.querySelector("#ep-tile-group");
      if (grpBtn) grpBtn.addEventListener("click", () => {
        const grp = rtRoadGroupOf(this.map.features.roadTiles || [], t);
        if (grp.length > 1) this._selectRoadGroup(grp, this.sel);
      });
      return;
    }
    if (kind === "river") {
      el.innerHTML = `
        <h4>河流 · 属性</h4>
        <label>名称<input id="ep-name" value="${data.name || ""}" maxlength="10" /></label>
        <div class="me-pos">${data.points.length} 个点</div>
        <button class="me-del" id="ep-del">删除</button>`;
      // 名称用 input 事件逐键写入：change 需失焦才触发，输完直接点画布会随面板重绘丢字
      el.querySelector("#ep-name").addEventListener("input", (e) => { data.name = e.target.value; this._dirty = true; });
      el.querySelector("#ep-del").addEventListener("click", () => this._deleteSel());
    } else if (kind === "object" && data.type === "building") {
      el.innerHTML = `
        <h4>建筑 · 属性</h4>
        <label>高度(m)<input id="ep-h" type="number" min="4" max="240" value="${data.params.height}" /></label>
        <label>墙面材质<select id="ep-wm">${this._materialOptions(["facade", "storefront", "sign", "surface"], data.params.wallMaterial)}</select></label>
        <label>屋顶材质<select id="ep-rm">${this._materialOptions(["roof", "surface"], data.params.roofMaterial)}</select></label>
        ${posEl(data.pos[0], data.pos[1])}
        <div class="me-pos">边数 ${data.params.footprint.length}</div>
        <button class="me-del" id="ep-del">删除</button>`;
      el.querySelector("#ep-h").addEventListener("input", (e) => {
        data.params.height = clamp(+e.target.value || 24, 4, 240);
        this._rebuildObjects(); this._dirty = true;
        const w = this._wrappers.get(data.id);
        if (w) { this.sel = w; this._three.tc.attach(w.root); } // 同步 Gizmo，不重绘面板
      });
      el.querySelector("#ep-h").addEventListener("change", () => this._pushUndo("调整高度"));
      // 转为模型资产：打包 footprint+height+材质绑定进资产库，随后可去工坊深度编辑
      const toAsset = document.createElement("button");
      toAsset.className = "me-btn";
      toAsset.textContent = "转为模型资产";
      toAsset.addEventListener("click", async () => {
        const asset = await createAssetFromTraced(data, { name: data.name || "描边建筑" });
        this._assetCache.set(asset.id, asset);
        this.status(`已转为资产「${asset.name}」· 在「我的模型」工具中可放置，或在模型工坊中继续编辑`);
        if (this.opts.onEditAsset) this.opts.onEditAsset(asset.id);
      });
      el.querySelector("#ep-del").before(toAsset);
      // 换材质：写 params（稳定 id 落地图 JSON），重建预览并接回 Gizmo
      const applyMat = (key, val) => {
        if (val) data.params[key] = val; else delete data.params[key];
        this._rebuildObjects(); this._dirty = true;
        const w = this._wrappers.get(data.id);
        if (w) { this.sel = w; this._three.tc.attach(w.root); }
      };
      el.querySelector("#ep-wm").addEventListener("change", (e) => {
        applyMat("wallMaterial", e.target.value);
        this._pushUndo("更换墙面材质");
      });
      el.querySelector("#ep-rm").addEventListener("change", (e) => {
        applyMat("roofMaterial", e.target.value);
        this._pushUndo("更换屋顶材质");
      });
      el.querySelector("#ep-del").addEventListener("click", () => this._deleteSel());
    } else if (kind === "object" && data.type === "asset") {
      const asset = this._assetCache.get(data.assetId);
      // 尺寸信息与按尺寸调整：unitSize 是模型本地的包围盒（米），乘缩放 = 放置后的实际尺寸
      const us = (asset && asset.unitSize) || null;
      const k = data.scale ?? 1;
      const fmt = (v) => (Math.round(v * 10) / 10).toFixed(1);
      const cur = us ? { x: us.x * k, y: us.y * k, z: us.z * k } : null;
      const maxDim = us ? Math.max(us.x, us.y, us.z) || 1 : 1;
      el.innerHTML = `
        <h4>模型资产 · 属性</h4>
        <div class="me-pos">${asset ? escHtml(asset.name || "未命名") : data.assetId}</div>
        ${us ? `
        <div class="me-stat">原始尺寸<b>${fmt(us.x)} × ${fmt(us.y)} × ${fmt(us.z)} m</b></div>
        <div class="me-stat">当前尺寸<b id="ep-cursize">${fmt(cur.x)} × ${fmt(cur.y)} × ${fmt(cur.z)} m</b></div>
        <label class="me-row">按最大边调整<input id="ep-fitmax" class="me-input-wide" type="number" min="0.1" max="5000" step="1" value="${fmt(Math.max(cur.x, cur.y, cur.z))}" /></label>
        <label class="me-row">缩放<input id="ep-scale" class="me-input-wide" type="number" min="0.001" max="1000" step="0.001" value="${k}" /></label>
        ` : `<label class="me-row">缩放<input id="ep-scale" class="me-input-wide" type="number" min="0.001" max="1000" step="0.001" value="${k}" /></label>`}
        <label class="me-row">旋转(°)<input id="ep-rot" class="me-input-wide" type="number" min="0" max="360" step="5" value="${Math.round(((data.rot || 0) * 180 / Math.PI % 360 + 360) % 360)}" /></label>
        ${posEl(data.pos[0], data.pos[1])}
        <button class="me-btn" id="ep-editasset">在模型工坊中编辑</button>
        <button class="me-del" id="ep-del">删除</button>`;
      const applyScale = (s, undoLabel) => {
        data.scale = clamp(+(+s).toFixed(4), 0.001, 1000);
        this._rebuildObjects(); this._dirty = true;
        const w = this._wrappers.get(data.id);
        if (w) { this.sel = w; this._three.tc.attach(w.root); }
        this._renderProps(); // 刷新当前尺寸 / 最大边输入框显示
        this._pushUndo(undoLabel);
      };
      const scaleInput = el.querySelector("#ep-scale");
      scaleInput.addEventListener("change", (e) => applyScale(+e.target.value || 1, "调整资产缩放"));
      // 旋转（度→弧度）：与 Gizmo 的 E 旋转模式写同一 data.rot，互相同步
      el.querySelector("#ep-rot").addEventListener("change", (e) => {
        let deg = +e.target.value || 0;
        deg = ((deg % 360) + 360) % 360;
        data.rot = Math.round(deg * Math.PI / 180 * 100) / 100;
        e.target.value = deg;
        this._rebuildObjects(); this._dirty = true;
        const w = this._wrappers.get(data.id);
        if (w) { this.sel = w; this._three.tc.attach(w.root); }
        this._pushUndo("旋转资产");
      });
      const fitInput = el.querySelector("#ep-fitmax");
      if (fitInput) fitInput.addEventListener("change", (e) => {
        const target = clamp(+e.target.value || maxDim, 0.1, 5000);
        applyScale(target / maxDim, "按尺寸调整资产");
      });
      el.querySelector("#ep-editasset").addEventListener("click", () => {
        if (this.opts.onEditAsset) this.opts.onEditAsset(data.assetId);
        else this.status("未配置模型工坊入口");
      });
      el.querySelector("#ep-del").addEventListener("click", () => this._deleteSel());
    } else if (kind === "object" && data.type === "billboard") {
      // 广告大屏：模型 = 资产库引用；内容 / 素材 / 后台三层各自独立。
      const p = data.params || (data.params = {});
      const asset = this._bbAssetOf(data);
      const spec = normalizeSpec(billboardParamsFor(data, asset));
      const placeItem = billboardItemFromRecord(data, asset);
      const deg = Math.round(((data.rot || 0) * 180 / Math.PI % 360 + 360) % 360);
      const valid = validatePlacement(placeItem, this._bbGetConstraints());
      const f = footprintOf(placeItem);
      const validHint = valid.ok
        ? `<span style="color:#2ce8c0">✓ 占位边界有效</span> · 未压占建筑 / 道路 / 范围外`
        : `<span style="color:#ff4d5e">✗ 占位冲突：${reasonText(valid.reasons)}</span> · 进游戏会自动挪到最近合法路缘`;
      const mountOpts = Object.entries(MOUNTS)
        .map(([id, m]) => `<option value="${id}"${id === spec.mount ? " selected" : ""}>${m.label}</option>`).join("");
      // 宿主候选：建筑 / 模型资产 —— 广告牌挂上去后跟随宿主的位移与旋转
      const hosts = this.map.objects.filter((o) => o && o.id !== data.id && (o.type === "building" || o.type === "asset"));
      const hostOpts = `<option value="">不挂载（独立放置）</option>` + hosts.map((o) => {
        const nm = o.type === "building" ? "建筑" : "模型资产";
        return `<option value="${escHtml(o.id)}"${o.id === data.hostId ? " selected" : ""}>${nm} · ${escHtml((o.name || "未命名").slice(0, 18))}</option>`;
      }).join("");
      const local = data.local || {};
      const lp = Array.isArray(local.pos) ? local.pos : [0, 0, 0];
      el.innerHTML = `
        <h4>广告大屏 · 属性</h4>
        <div class="me-stat">模型资产<b>${asset ? escHtml(asset.name || "未命名") : (data.assetId ? "读取中…" : "旧数据 · 未绑定资产")}</b></div>
        <div class="me-hint">占位 ${(f.hx * 2).toFixed(1)}×${(f.hz * 2).toFixed(1)}m · ${validHint}</div>
        ${data.assetId
          ? `<button class="me-btn" id="ep-bb-editasset">在模型工坊中编辑此广告牌模型</button>`
          : `<button class="me-btn" id="ep-bb-toasset">转为模型资产（解耦几何）</button>`}
        ${asset && asset.poseYaw && Math.abs((data.rot || 0) - asset.poseYaw) > 0.01
          ? `<button class="me-btn" id="ep-bb-face">转到资产默认朝向（广告面朝默认视角）</button>` : ""}
        ${!data.hostId ? `<button class="me-btn" id="ep-bb-fix">自动校正到合法落点</button>` : ""}
        <label class="me-row">承载形式<select id="ep-bb-mount" class="me-input-wide">${mountOpts}</select></label>
        <label class="me-row">屏宽(m)<input id="ep-bb-w" class="me-input-wide" type="number" min="4" max="40" step="1" value="${spec.w}" /></label>
        <label class="me-row">屏高(m)<input id="ep-bb-h" class="me-input-wide" type="number" min="2" max="30" step="1" value="${spec.h}" /></label>
        <label class="me-row">屏心高度(m)<input id="ep-bb-y" class="me-input-wide" type="number" min="3" max="120" step="1" value="${spec.y}" /></label>
        <label class="me-row">旋转(°)<input id="ep-rot" class="me-input-wide" type="number" min="0" max="360" step="5" value="${deg}" /></label>
        <label class="me-row" title="仅立面屏：进游戏时自动吸附到最近建筑墙面、对齐朝向">自动贴墙<input id="ep-bb-snap" type="checkbox" ${spec.autoSnap ? "checked" : ""} /></label>
        <label class="me-row">挂载宿主<select id="ep-bb-host" class="me-input-wide">${hostOpts}</select></label>
        ${data.hostId ? `
          <div class="me-hint">宿主局部偏移（米 / 度）：挂上后跟随宿主移动旋转，进游戏不再做贴墙/避让。</div>
          <label class="me-row">X<input id="ep-bb-lx" class="me-input-wide" type="number" step="0.1" value="${lp[0]}" /></label>
          <label class="me-row">高度偏移<input id="ep-bb-ly" class="me-input-wide" type="number" step="0.1" value="${lp[1]}" /></label>
          <label class="me-row">Z<input id="ep-bb-lz" class="me-input-wide" type="number" step="0.1" value="${lp[2] || 0}" /></label>
          <label class="me-row">相对朝向(°)<input id="ep-bb-lrot" class="me-input-wide" type="number" step="5" value="${Math.round(((local.rot || 0) * 180 / Math.PI % 360 + 360) % 360)}" /></label>` : ""}
        ${posEl(data.pos[0], data.pos[1])}
        <button class="me-btn" id="ep-bb-content">编辑显示内容 · ${(p.content && p.content.items && p.content.items.length) || 8} 项</button>
        <button class="me-del" id="ep-del">删除</button>`;
      const rebuild = () => {
        this._bbConstraints = null;
        this._rebuildObjects(); this._dirty = true;
        const w = this._wrappers.get(data.id);
        if (w) { this.sel = w; this._three.tc.attach(w.root); }
      };
      const apply = (patch, undoLabel) => {
        p.override = { ...(p.override || {}), ...patch };
        rebuild(); this._pushUndo(undoLabel);
      };
      const fixBtn = el.querySelector("#ep-bb-fix");
      if (fixBtn) fixBtn.addEventListener("click", () => {
        const r = resolvePlacement(placeItem, this._bbGetConstraints());
        if (!r.ok) { this.status("附近没有合法落点：请先调整道路/建筑，或缩小屏体尺寸"); return; }
        if (!r.moved) { this.status("当前落点已合法，无需校正"); return; }
        data.pos = r.item.pos; rebuild(); this._pushUndo("自动校正大屏落点");
        this._renderProps(); this.status(`已校正落点至 ${data.pos[0]}, ${data.pos[1]} · 边界有效`);
      });
      const editBtn = el.querySelector("#ep-bb-editasset");
      if (editBtn) editBtn.addEventListener("click", () => {
        if (this.opts.onEditAsset) this.opts.onEditAsset(data.assetId);
        else this.status("未配置模型工坊入口");
      });
      const faceBtn = el.querySelector("#ep-bb-face");
      if (faceBtn) faceBtn.addEventListener("click", () => {
        data.rot = asset.poseYaw;
        rebuild(); this._pushUndo("广告牌转到资产默认朝向"); this._renderProps();
        this.status("已把广告面转到默认视角朝向；编辑器与进游戏表现一致");
      });
      const toAssetBtn = el.querySelector("#ep-bb-toasset");
      if (toAssetBtn) toAssetBtn.addEventListener("click", async () => {
        const rec = await createAssetFromBillboard(data);
        data.assetId = rec.id;
        data.params = { override: {}, content: p.content || null };
        this._assetCache.set(rec.id, rec);
        rebuild(); this._pushUndo("广告牌转为模型资产"); this._renderProps();
        this.status(`已转为模型资产「${rec.name}」· 几何不再存地图 JSON`);
      });
      el.querySelector("#ep-bb-mount").addEventListener("change", async (e) => {
        // 切换承载形式 = 换一个广告牌模型资产（几何来自资产库，不内联到地图）
        let list = this._bbAssets && this._bbAssets.length ? this._bbAssets : await listAssets({ category: "billboard" });
        if (!list.length) { await ensureBillboardAssets(); list = await listAssets({ category: "billboard" }); }
        const next = list.find((a) => a.billboard && a.billboard.mount === e.target.value) || null;
        if (!next) { this.status("资产库里没有该承载形式的广告牌模型"); return; }
        data.assetId = next.id;
        p.override = {};
        this._assetCache.set(next.id, next);
        rebuild(); this._pushUndo("切换广告牌模型"); this._renderProps();
      });
      el.querySelector("#ep-bb-w").addEventListener("change", (e) => apply({ w: +e.target.value || spec.w }, "调整屏宽"));
      el.querySelector("#ep-bb-h").addEventListener("change", (e) => apply({ h: +e.target.value || spec.h }, "调整屏高"));
      el.querySelector("#ep-bb-y").addEventListener("change", (e) => apply({ y: +e.target.value || spec.y }, "调整屏心高度"));
      el.querySelector("#ep-bb-snap").addEventListener("change", (e) => apply({ autoSnap: e.target.checked }, "切换自动贴墙"));
      el.querySelector("#ep-bb-host").addEventListener("change", (e) => {
        if (e.target.value) data.hostId = e.target.value;
        else { delete data.hostId; delete data.local; }
        rebuild(); this._pushUndo("设置广告牌宿主"); this._renderProps();
      });
      for (const [sel, key, i] of [["#ep-bb-lx", "pos", 0], ["#ep-bb-ly", "pos", 1], ["#ep-bb-lz", "pos", 2]]) {
        const node = el.querySelector(sel);
        if (!node) continue;
        node.addEventListener("change", () => {
          const cur = data.local || (data.local = { pos: [0, 0, 0], rot: 0 });
          if (!Array.isArray(cur.pos)) cur.pos = [0, 0, 0];
          cur.pos[i] = +node.value || 0;
          rebuild(); this._pushUndo("调整广告牌宿主偏移");
        });
      }
      const lrot = el.querySelector("#ep-bb-lrot");
      if (lrot) lrot.addEventListener("change", () => {
        const d = +lrot.value || 0;
        const cur = data.local || (data.local = { pos: [0, 0, 0], rot: 0 });
        cur.rot = (((d % 360) + 360) % 360) * Math.PI / 180;
        rebuild(); this._pushUndo("调整广告牌宿主朝向");
      });
      el.querySelector("#ep-bb-content").addEventListener("click", () => {
        openBillboardContent(p.content, (cfg) => {
          p.content = cfg;
          this._dirty = true;
          this._pushUndo("编辑大屏显示内容");
          this.status(`已更新大屏内容 · ${cfg.items.length} 项 · 保存后进游戏生效`);
          this._renderProps();
        });
      });
      el.querySelector("#ep-rot").addEventListener("change", (e) => {
        let d = +e.target.value || 0;
        d = ((d % 360) + 360) % 360;
        data.rot = Math.round(d * Math.PI / 180 * 100) / 100;
        e.target.value = d;
        rebuild(); this._pushUndo("旋转大屏");
      });
      el.querySelector("#ep-del").addEventListener("click", () => this._deleteSel());
    } else {
      const zh = { tree: "树木", lamp: "路灯" }[data.type] || data.type;
      el.innerHTML = `<h4>${zh} · 属性</h4>${posEl(data.pos[0], data.pos[1])}<button class="me-del" id="ep-del">删除</button>`;
      el.querySelector("#ep-del").addEventListener("click", () => this._deleteSel());
    }
  }

  /* ---------------- helpers ---------------- */

  /* ---------------- draft preview ---------------- */
  _updateDraftPreview() {
    if (this._draftGroup) {
      this._three.scene.remove(this._draftGroup);
      this._draftGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
      this._draftGroup = null;
    }
    if (!this.draft || !this.draft.points.length) return;
    if (this.draft.area) {
      this._draftGroup = this._buildAreaDraftGroup();
      if (this._draftGroup) this._three.scene.add(this._draftGroup);
      return;
    }
    if (this.draft.road) {
      this._draftGroup = this._buildRoadTraceGroup();
      if (this._draftGroup) this._three.scene.add(this._draftGroup);
      return;
    }
    if (this.draft.measure) {
      this._draftGroup = this._buildMeasureGroup(this.draft.points, this.draft.cursor);
      if (this._draftGroup) this._three.scene.add(this._draftGroup);
      return;
    }
    const g = new THREE.Group();
    const areaDraft = !!this.draft.area;
    const pts = [...this.draft.points];
    if (this.draft.cursor && this.tool !== "draw-building") pts.push(this.draft.cursor);
    const color = areaDraft ? 0xf2c14e : this.tool === "draw-river" ? 0x3fa7d6 : this.tool === "draw-building" ? 0xf2c14e : 0x9fb4c8;
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(p.x, 0.3 - this._curveOffset(p.x, p.z), p.z))),
      new THREE.LineBasicMaterial({ color }),
    );
    g.add(line);
    // 范围描边：≥3 点时预览闭合边（末点回到起点）
    if (areaDraft && pts.length >= 3) {
      const close = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(
          [pts[pts.length - 1], pts[0]].map((p) => new THREE.Vector3(p.x, 0.3 - this._curveOffset(p.x, p.z), p.z)),
        ),
        new THREE.LineBasicMaterial({ color }),
      );
      g.add(close);
    }
    for (const p of pts) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.9, 8, 6), new THREE.MeshBasicMaterial({ color }));
      dot.position.set(p.x, 0.3 - this._curveOffset(p.x, p.z), p.z);
      g.add(dot);
    }
    // 建筑多边形/范围描边实时预览面
    if ((this.tool === "draw-building" || areaDraft) && pts.length >= 3) {
      const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, -p.z)));
      const geo = bendGeometry(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2));
      const face = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xf2c14e, transparent: true, opacity: 0.18, side: THREE.DoubleSide }));
      g.add(face);
    }
    // 河流宽度预览带（地图描边走 _buildRoadTraceGroup）
    if (this.tool === "draw-river" && pts.length >= 2) {
      const mesh = new THREE.Mesh(
        this._stripGeometry(pts, 26),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3 }),
      );
      g.add(mesh);
    }
    this._draftGroup = g;
    this._three.scene.add(g);
  }

  // 地图描边草稿预览：金色胖线（深色衬底，屏幕空间恒定像素）+ 半透明路宽条带 + 节点圆点，
  // 全部跟随曲率下沉；光标处橡皮筋实时指示下一段走向与宽度
  _buildRoadTraceGroup() {
    const d = this.draft;
    const g = new THREE.Group();
    const path = [...d.points];
    if (d.cursor) path.push(d.cursor);
    const yAt = (p) => 0.14 - this._curveOffset(p.x, p.z);
    // 自动模式：光标接近起点即实时切换为取面预览，所见即所得
    const poly = d.mode === "poly" || (d.mode === "auto" && this._traceClosing(path));
    if (poly) {
      // 取面预览：围合区域实时填充 + 闭合轮廓（≥3 点自动闭合成面）
      if (path.length >= 3) {
        const shape = new THREE.Shape(path.map((p) => new THREE.Vector2(p.x, -p.z)));
        const geo = bendGeometry(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2));
        geo.translate(0, 0.12, 0);
        const face = new THREE.Mesh(
          geo,
          new THREE.MeshBasicMaterial({ color: 0xffd76a, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false }),
        );
        face.renderOrder = 0;
        const closed = [...path, path[0]];
        const casing = this._fatLine(closed, 6, 0x0b1220, 0.85, 0.14);
        casing.renderOrder = 1;
        const main = this._fatLine(closed, 2.5, 0xffd76a, 1, 0.16);
        main.renderOrder = 2;
        g.add(face, casing, main);
      }
    } else if (path.length >= 2) {
      const strip = new THREE.Mesh(
        this._stripGeometry(path, d.width || 12, 0.08),
        new THREE.MeshBasicMaterial({ color: 0xffd76a, transparent: true, opacity: 0.22, depthWrite: false }),
      );
      strip.renderOrder = 0;
      const casing = this._fatLine(path, 6, 0x0b1220, 0.85, 0.14);
      casing.renderOrder = 1;
      const main = this._fatLine(path, 2.5, 0xffd76a, 1, 0.16);
      main.renderOrder = 2;
      g.add(strip, casing, main);
    }
    for (const p of path) {
      const rim = new THREE.Mesh(
        new THREE.SphereGeometry(1.2, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0x0b1220, transparent: true, opacity: 0.9, depthWrite: false }),
      );
      rim.position.set(p.x, yAt(p), p.z);
      rim.renderOrder = 1;
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(0.65, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0xffd76a, depthWrite: false }),
      );
      core.position.set(p.x, yAt(p), p.z);
      core.renderOrder = 2;
      g.add(rim, core);
    }
    return g;
  }

  // 范围描边草稿预览：屏幕空间胖线（深色衬底 10px + 亮金主线 5px，任意视角清晰），
  // 顶点带描边圈，≥3 点实时预览填充面与闭合边
  _buildAreaDraftGroup() {
    const g = new THREE.Group();
    const path = [...this.draft.points];
    if (this.draft.cursor) path.push(this.draft.cursor);
    if (path.length >= 3) path.push(path[0]); // 预览闭合边
    const yAt = (p) => 0.12 - this._curveOffset(p.x, p.z);
    if (path.length >= 2) {
      const casing = this._fatLine(path, 10, 0x0b1220, 0.85, 0.1);
      casing.renderOrder = 1;
      const main = this._fatLine(path, 5, 0xffd76a, 1, 0.16);
      main.renderOrder = 2;
      g.add(casing, main);
    }
    for (const p of path) {
      const rim = new THREE.Mesh(
        new THREE.SphereGeometry(2.2, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0x0b1220, transparent: true, opacity: 0.9, depthWrite: false }),
      );
      rim.position.set(p.x, yAt(p), p.z);
      rim.renderOrder = 1;
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(1.3, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0xffd76a, depthWrite: false }),
      );
      core.position.set(p.x, yAt(p), p.z);
      core.renderOrder = 2;
      g.add(rim, core);
    }
    // 实时填充预览（Shape 自动闭合）
    const fp = [...this.draft.points];
    if (this.draft.cursor) fp.push(this.draft.cursor);
    if (fp.length >= 3) {
      const shape = new THREE.Shape(fp.map((p) => new THREE.Vector2(p.x, -p.z)));
      const geo = bendGeometry(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2));
      const face = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({ color: 0xffd76a, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
      );
      face.renderOrder = 0;
      g.add(face);
    }
    return g;
  }

  /* ---------------- undo / redo ---------------- */
  _snapshot() {
    return JSON.stringify({ f: this.map.features, o: this.map.objects, origin: this.map.origin, area: this.map.area, rx: this.map.roadsX, rz: this.map.roadsZ, ex: !!this.map.extRoads, pg: !!this.map.procedural });
  }
  _pushUndo(label) {
    this.undoStack.push(this._snapshot());
    if (this.undoStack.length > 40) this.undoStack.shift();
    this.redoStack = [];
    this._dirty = true;
  }
  _undo() {
    if (this.draft && (this.draft.area || this.draft.road || this.draft.measure)) { this._undoDraftPoint(); return; } // 描边/测距中：撤销草稿点
    if (this.undoStack.length <= 1) return;
    this.redoStack.push(this.undoStack.pop());
    this._applySnapshot(this.undoStack[this.undoStack.length - 1]);
    this.status("已撤销");
  }
  _redo() {
    if (this.draft && (this.draft.area || this.draft.road || this.draft.measure)) { this._redoDraftPoint(); return; } // 描边/测距中：恢复草稿点
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(s);
    this._applySnapshot(s);
    this.status("已重做");
  }
  _applySnapshot(snap) {
    const d = JSON.parse(snap);
    this.map.features = d.f;
    this.map.objects = d.o;
    this.map.origin = d.origin;
    if (d.area) this.map.area = d.area;
    if (d.rx) this.map.roadsX = d.rx;
    if (d.rz) this.map.roadsZ = d.rz;
    this.map.extRoads = !!d.ex;
    if ("pg" in d) this.map.procedural = !!d.pg; // 旧快照无该字段 → 保持当前值
    this._rtChain = null; // 快照后的链端端口可能已不存在，断链让磁吸重新接管
    const extCb = document.getElementById("ep-ext");
    if (extCb) extCb.checked = this.map.extRoads;
    this._select(null);
    this._rebuildAreaMeshes(); // 范围形态/顶点可能已变
    this._applyAreaToGroup();
    this._bendArea();
    this._rebuildAll();
    this._updateEnu();
    this._dirty = true;
  }

  /* ---------------- ui wiring ---------------- */
  _initUI() {
    const tools = [
      ["select", "◇", "选择/移动"],
      ["area", "▢", "地图范围"],
      ["draw-road", "║", "道路"],
      ["draw-river", "≈", "河流描边"],
      ["draw-building", "▲", "建筑描边"],
      ["place-tree", "♣", "放置树木"],
      ["place-lamp", "¶", "放置路灯"],
      ["place-billboard", "▣", "广告大屏"],
      ["place-asset", "◆", "我的模型"],
    ];
    const bar = document.getElementById("e3-tools");
    bar.innerHTML = tools.map(([t, icon, label], i) =>
      `<button class="e3-tool${i === 0 ? " active" : ""}" data-tool="${t}">${icon}<span>${label}</span></button>`).join("");

    // 「道路」子菜单：点击向右弹出（添加纵路 / 添加横路 / 地图描边 / 路块拼接，取代原独立按钮）
    const roadBtn = bar.querySelector('[data-tool="draw-road"]');
    roadBtn.classList.add("has-sub");
    const roadSub = document.createElement("div");
    roadSub.className = "e3-tool-sub hidden";
    roadSub.innerHTML =
      `<button data-tool="add-roadX">‖<span>添加纵路</span></button>` +
      `<button data-tool="add-roadZ">═<span>添加横路</span></button>` +
      `<button data-tool="draw-road">║<span>地图描边</span></button>` +
      `<button data-tool="place-road">▦<span>路块拼接</span></button>`;
    bar.appendChild(roadSub);
    this._roadSub = roadSub; // 供 _syncRoadToolUI 高亮当前子模式
    const closeRoadSub = () => roadSub.classList.add("hidden");
    roadSub.querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", () => {
        const t = b.dataset.tool;
        closeRoadSub();
        if (t === "draw-road") { this._startRoadTrace(); return; }
        if (t === "place-road") { this._rtPin = null; this._rtGhostState = null; } // 重置落点/幽灵状态
        this._discardDraft();
        this.tool = t;
        this._syncRoadToolUI(); // 文案 + 子菜单高亮 + 「道路」按钮激活
        this._select(null);
        if (t !== "place-asset") this._hideAssetGhost();
        if (t === "place-road") rtRenderPanel(this); // 路块工具右侧参数面板（替代默认地图内容面板）
        this.status({
          "add-roadX": "添加纵向路（南北向）：点击地图放置，放置后可拖动/编辑属性",
          "add-roadZ": "添加横向路（东西向）：点击地图放置，放置后可拖动/编辑属性",
          "place-road": "路块拼接：单击落点、瞄准后再击放置 · 靠近空闲端口磁吸单击直放 · Esc 取消落点/断链/退出",
        }[t] || "");
      });
    });

    bar.querySelectorAll(".e3-tool").forEach((b) => {
      b.addEventListener("click", () => {
        const t = b.dataset.tool;
        if (t === "set-origin") { this._setOriginPickMode(); return; }
        if (b === roadBtn) return; // 「道路」按钮只负责弹出子菜单（下方绑定），不改动当前子模式
        closeRoadSub(); // 道路按钮由下方切换器自行收起/弹出
        this._discardDraft();
        this._setTool(t); // 高亮 + 同步「道路」按钮子模式文案
        this._select(null);
        if (t === "area") {
          this._selectArea(); // 选中地图范围，Gizmo 立即可用
          this.status("地图范围：Gizmo 拖拽移动 · 右侧可数值编辑 / 描边绘制多边形");
          return;
        }
        this.status({
          "draw-river": "河流描边：点击加点，双击结束（宽度默认 26m）",
          "draw-building": "建筑描边：点击多边形顶点（≥3 点自动闭合生成盒子）",
          "place-tree": "点击地面放置树木",
          "place-lamp": "点击地面放置路灯",
          "place-billboard": "先在右侧选承载形式（含转角包柱屏）与尺寸 · 移动鼠标看真实占位边界 · 自动吸附路缘/网格 · 红框禁止放置",
          "place-asset": "在右侧「我的模型」中选择资产后，点击地图放置",
        }[t] || "");
      });
    });
    // 道路按钮：切换子菜单显隐（后绑定，确保先执行通用处理再弹出）
    roadBtn.addEventListener("click", () => {
      this._syncRoadToolUI(); // 弹出前刷新子菜单高亮，反映当前子模式
      roadSub.style.top = roadBtn.offsetTop + "px";
      roadSub.classList.toggle("hidden");
    });

    document.getElementById("e3-save").addEventListener("click", () => this._save(), this._sig);
    document.getElementById("e3-play").addEventListener("click", () => { if (this._save()) this.opts.onPlay(); }, this._sig);
    document.getElementById("e3-exit").addEventListener("click", () => this.opts.onClose(), this._sig);
    document.getElementById("e3-undo").addEventListener("click", () => this._undo(), this._sig);
    document.getElementById("e3-redo").addEventListener("click", () => this._redo(), this._sig);
    document.getElementById("e3-snap").addEventListener("change", (e) => { this._snap = +e.target.value; }, this._sig);
    const roadSnap = document.getElementById("e3-road-snap");
    if (roadSnap) {
      roadSnap.checked = this._bbSnapOn;
      roadSnap.addEventListener("change", (e) => {
        this._bbSnapOn = !!e.target.checked;
        this.status(this._bbSnapOn ? "路缘吸附已开启：靠近道路自动落到合法路缘（金色边界）" : "路缘吸附已关闭：仅按网格吸附");
        if (this._bbLastEvent && this.tool === "place-billboard") this._bbGhostMove(this._bbLastEvent);
      }, this._sig);
    }
    document.getElementById("e3-basemap").addEventListener("click", () => this._toggleBasemap(), this._sig);
    document.getElementById("e3-settings").addEventListener("click", () => this._toggleSettings(), this._sig);

    this._onKey = (e) => {
      const active = document.activeElement;
      const typing = active && (["INPUT", "SELECT", "TEXTAREA"].includes(active.tagName) || active.isContentEditable);
      if (e.key === "Escape") {
        const pop = document.getElementById("e3-settings-pop");
        if (pop && !pop.classList.contains("hidden")) { this._closeSettings(); return; }
        closeRoadSub();
        // 属性面板输入框聚焦时也要能用 Esc 退出选中：先退出输入焦点，再走下面的取消逻辑
        if (typing) active.blur();
        if (this.tool === "set-origin") { this._setTool("select"); this.status("已取消锚点拾取"); return; }
        if (this.tool === "place-billboard" || this.tool === "place-asset") {
          // 放置模型/广告牌时 Esc 直接退出放置（幽灵与吸附边界由 _setTool 一并清掉）
          this._setTool("select");
          this._select(null);
          this.status("已取消放置");
          return;
        }
        if (this.tool === "place-road") {
          if (this._rtMode === "edit") {
            if (this.sel) { this._select(null); this.status("已取消选择 · Esc 再次返回添加模式"); } // 分级退回：先取消选择
            else rtSetMode(this, "place");
            return;
          }
          if (this._rtPin) {
            this._rtPin = null; // 分阶段取消：先取消落点，再断链，最后退出工具
            this._rtGhostState = null;
            rtUpdateGhost(this);
            this.status("已取消落点：重新单击落点，靠近空闲端口自动磁吸");
          } else if (this._rtChain) {
            this._rtChain = null;
            rtRenderPanel(this);
            this.status("已断开链条：下一次单击重新开始（靠近空闲端口仍会自动磁吸）");
          } else {
            this._setTool("select");
            this.status("已退出路块拼接");
          }
          return;
        }
        if (this.draft && this.draft.area) {
          this.draft = null; this._updateDraftPreview();
          this._selectArea(); this.status("已取消范围描边");
          return;
        }
        if (this.draft && this.draft.road) { this._endRoadTrace("已取消地图描边"); return; }
        if (this.draft && this.draft.measure) { this._endMeasure("已取消测距"); return; }
        this.draft = null; this._updateDraftPreview(); this._select(null);
      }
      else if (typing) return; // 输入框聚焦时不响应编辑快捷键（Esc 已单独处理）
      else if (e.key === "Enter") {
        if (this.tool === "place-road" && this._rtChain) { this._rtChain = null; rtRenderPanel(this); this.status("已断开链条"); return; }
        this._finishDraft();
      }
      else if (e.key === "Delete" || e.key === "Backspace") {
        if (this.draft && (this.draft.area || this.draft.road || this.draft.measure)) { this._undoDraftPoint(); return; } // 描边/测距中：撤销上一顶点
        this._deleteSel();
      }
      else if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); this._undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key === "y") { e.preventDefault(); this._redo(); }
      else if (this.tool === "place-road" && this._rtMode !== "edit" && (e.key === "q" || e.key === "Q" || e.key === "e" || e.key === "E")) {
        // 路块工具下 Q/E 旋转幽灵（自由放置态；吸附态方向由端口→光标决定，会被移动刷新覆盖）
        const st = this._rtGhostState;
        if (st && !st.anchor) {
          const stepDeg = (+this._rtStep || 0) || 15;
          this._rtYaw = (this._rtYaw || 0) + (e.key.toLowerCase() === "q" ? -1 : 1) * (stepDeg * Math.PI) / 180;
          st.yaw = this._rtYaw;
          rtUpdateGhost(this);
        }
      }
      else if (e.key === "w" || e.key === "W") this._three.tc.setMode("translate");
      else if (e.key === "e" || e.key === "E") this._three.tc.setMode("rotate");
      else if (e.key === "r" || e.key === "R") this._three.tc.setMode("scale");
    };
    window.addEventListener("keydown", this._onKey, this._sig);
    this._snap = 5;
    this._renderProps();
    this._updateOriginLabel();
  }

  _save() {
    if (!this.map.spawn) { this.status("保存失败：缺少出生点"); return false; }
    const ok = this.opts.onSave({
      name: document.getElementById("e3-name").value.trim() || "未命名地图",
      roadsX: this.map.roadsX,
      roadsZ: this.map.roadsZ,
      landmarks: this.map.landmarks,
      spawn: this.map.spawn,
      extRoads: !!this.map.extRoads,
      gridOpacity: this.map.gridOpacity ?? GRID_OPACITY_DEFAULT,
      ...genConfig(this.map), // 程序化城市开关 / 楼间距 / 绿植密度 / 路灯密度
      features: this.map.features,
      objects: this.map.objects,
      origin: this.map.origin,
      area: this._areaEnsure(),
    });
    this.status(ok ? `已保存 · ${new Date().toLocaleTimeString()}` : "保存失败");
    return ok;
  }
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
