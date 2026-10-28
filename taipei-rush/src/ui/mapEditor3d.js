// 3D 地图编辑器：Three.js 场景内描边生成道路/河流/建筑、放置树/路灯、
// Gizmo 移动旋转缩放；可选 Cesium 地球作为底图（相机同步 + 局部米坐标桥）。
// 与 2D 编辑器共享同一份地图数据（schema v2 的 features/objects/origin）。

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import {
  buildImageryLayers, basemapInfo, basemapSources,
  getBasemapSource, setBasemapSource,
} from "../config/cesium.js";
import { searchPlaces } from "../config/placeSearch.js";
import { dropAt, bendGeometry } from "../config/curvature.js";
import { EXT_STEP_X, EXT_STEP_Z, asphaltHalf, corridorHalf } from "../data/cityData.js";
import { areaPoly, clipAxisLine, worldBounds } from "../world/customMap.js";
import { GRID_OPACITY_DEFAULT } from "../data/mapStore.js";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uid = () => "o" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// 程序化道路类型（与 2D 编辑器一致）
const ROAD_KINDS = ["street", "arterial", "boulevard"];
const ROAD_KIND_ZH = { street: "街道", arterial: "干道", boulevard: "大道" };

// 米 ↔ 经纬度（局部 ENU 近似，3km 内误差 <0.5m）
// origin 语义 = 地图范围中心 (area.cx, area.cz) 在地球上的经纬度；
// 任意局部点 (x,z) 的经纬度按相对中心的偏移换算。移动范围即整体搬移地图在地球上的落点。
const M_PER_DEG_LAT = 111320;
function lonLatAt(origin, area, x, z) {
  const dx = x - (area ? area.cx : 0), dz = z - (area ? area.cz : 0);
  return {
    lon: origin.lon + dx / (M_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180)),
    lat: origin.lat + -dz / M_PER_DEG_LAT,
  };
}
// 经纬度偏移 → 局部米位移：未直接使用，保留公式备注
// dx = dLon · M_PER_DEG_LAT · cos(lat)；dz = -dLat · M_PER_DEG_LAT

export class MapEditor3d {
  // opts: { map, onSave(data)=>bool, onPlay(), onClose() }
  constructor(opts) {
    this.opts = opts;
    this.map = opts.map;
    this.tool = "select";
    this.draft = null;        // { points: [{x,z}] } 绘制中的折线/多边形
    this.sel = null;          // { kind, data, root, meshes }
    this.undoStack = [];
    this.redoStack = [];
    this._raf = 0;
    this._cesium = null;
    this._disposed = false;
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._snap = 5;
    this._dirty = false;
    this._cesiumOn = localStorage.getItem("tr_e3_basemap") !== "0"; // 记住上次选择
  }

  /* ---------------- lifecycle ---------------- */
  async open() {
    const root = document.getElementById("map-editor3d");
    root.classList.remove("hidden");
    document.getElementById("e3-name").value = this.map.name || "";

    this._initThree();
    this._initUI();
    this._rebuildAll();
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
    window.removeEventListener("resize", this._onResize);
    window.removeEventListener("keydown", this._onKey);
    if (this._compassEl) {
      this._compassEl.remove();
      this._compassEl = this._compassRose = this._compassTxt = null;
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
    // 双击把相机回正北（正南机位）
    const compass = document.createElement("div");
    compass.className = "e3-compass";
    compass.title = "视线方位角（0°=正北）· 双击回正北";
    compass.innerHTML =
      '<div class="e3-compass-rose"><b class="n">N</b><b class="e">E</b><b class="s">S</b><b class="w">W</b></div>' +
      '<span class="e3-compass-txt"></span>';
    vp.appendChild(compass);
    this._compassEl = compass;
    this._compassRose = compass.querySelector(".e3-compass-rose");
    this._compassTxt = compass.querySelector(".e3-compass-txt");
    compass.addEventListener("dblclick", () => {
      const { camera, orbit } = this._three;
      const off = camera.position.clone().sub(orbit.target);
      const dist = Math.max(1, Math.hypot(off.x, off.z));
      camera.position.set(orbit.target.x, orbit.target.y + off.y, orbit.target.z + dist);
      this.status("视角已回正北（0°）");
    });

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
    tc.addEventListener("mouseUp", () => { this._syncGizmoToData(); this._pushUndo("变换"); });
    scene.add(tc.getHelper()); // r169 起 TransformControls 不再是 Object3D，需加 helper

    this._three = { renderer, scene, camera, canvas, raycaster, groundPlane, orbit, tc, areaGroup };
    this._initOriginMarkers();
    this._initArea();
    this._resize();
    this._onResize = () => this._resize();
    window.addEventListener("resize", this._onResize);

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

  // Cesium 渲染外置后其自有循环里的 resize/configureCameraFrustum 不再执行，
  // 显式按视口尺寸同步 backing store，并在尺寸变化时同步相机纵横比
  _resizeCesium() {
    if (!this._cesium) return;
    const vp = document.getElementById("e3-viewport");
    const c = document.querySelector("#e3-cesium canvas");
    if (!c || !vp.clientWidth) return;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const bw = Math.round(vp.clientWidth * dpr), bh = Math.round(vp.clientHeight * dpr);
    if (c.width !== bw || c.height !== bh) {
      c.width = bw; c.height = bh;
      c.style.width = vp.clientWidth + "px";
      c.style.height = vp.clientHeight + "px";
      this._cesium.viewer.camera.frustum.aspectRatio = bw / bh;
    }
  }

  // 视锥对齐：Cesium 的 fov 语义是"水平 FOV"（aspect>1 时），Three 是垂直 FOV。
  // 不对齐时影像与网格投影比例不一致，平移视角后错位越来越明显。
  _syncFrustum() {
    if (!this._cesium || !this._three) return;
    const size = this._three.renderer.getSize(new THREE.Vector2());
    const aspect = size.x / Math.max(1, size.y);
    const vFovHalf = (this._three.camera.fov * Math.PI) / 360;
    this._cesium.viewer.camera.frustum.fov = 2 * Math.atan(Math.tan(vFovHalf) * aspect);
  }

  _loop() {
    const tick = () => {
      if (this._disposed) return;
      this._raf = requestAnimationFrame(tick);
      const { orbit, camera, renderer, scene, tc } = this._three;
      orbit.update();
      if (tc.dragging) this._syncGizmoToData();
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
  async _initCesium() {
    const Cesium = await import("cesium");
    await import("cesium/Build/Cesium/Widgets/widgets.css");
    window.CESIUM_BASE_URL = "/cesium/";
    const info = basemapInfo();
    if (!info.configured) {
      this.status("天地图 key 未配置（.env.local: VITE_TIANDITU_KEY），已回退 Esri 影像");
    }

    const el = document.getElementById("e3-cesium");
    const credit = document.createElement("div"); // 隐藏版权容器
    credit.style.display = "none";
    el.appendChild(credit);
    const viewer = new Cesium.Viewer(el, {
      imageryProvider: false,
      baseLayerPicker: false, animation: false, timeline: false, geocoder: false,
      homeButton: false, sceneModePicker: false, navigationHelpButton: false,
      fullscreenButton: false, infoBox: false, selectionIndicator: false,
      creditContainer: credit,
      requestRenderMode: false, // 渲染循环外置（见下），每帧显式渲染
      contextOptions: { webgl: { alpha: false } },
    });
    for (const p of buildImageryLayers(Cesium)) viewer.imageryLayers.addImageryProvider(p);
    const scene = viewer.scene;
    scene.globe.baseColor = Cesium.Color.fromCssColorString("#0d141c");
    scene.skyBox.show = false;
    scene.sun.show = false;
    scene.moon.show = false;
    scene.screenSpaceCameraController.enableInputs = false; // 相机由 Three 驱动
    // 渲染循环外置：Cesium 不再自建 RAF。其回调比编辑器 tick 恒早注册、先执行，
    // 总是用「上一帧」的相机姿态画底图；静止时两层姿态相同看不出，
    // 缩放/旋转时每帧差一个增量，网格相对底图来回跳（视觉上闪烁）。
    // 改由 _loop 里 _renderCesiumSync 与 Three 在同一回调内先后渲染，姿态恒同帧
    viewer.useDefaultRenderLoop = false;

    this._cesium = { Cesium, viewer, enu: null, creditEl: credit };
    window.__e3 = this; // dev 调试句柄
    // Cesium 锚点标记（金色点 + 标签，disableDepthTest 保证远处可见）
    const o = this.map.origin;
    this._originEntity = viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(o.lon, o.lat, 30),
      point: {
        pixelSize: 14, color: Cesium.Color.fromCssColorString("#f2c14e"),
        outlineColor: Cesium.Color.WHITE, outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: "锚点", font: "600 13px sans-serif", fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
        pixelOffset: new Cesium.Cartesian2(0, -18),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    this._updateEnu();
    this._applyBasemap(); // 应用记忆中的开/关状态
    this._resizeCesium(); // 底图创建后按当前视口校正尺寸
    this._syncFrustum();  // 视锥与 Three 相机对齐
    this.status(`底图：${info.credit} · 地理锚点 ${this.map.origin.lat.toFixed(4)}, ${this.map.origin.lon.toFixed(4)}`);
  }

  /* ---------------- basemap on/off ---------------- */
  _toggleBasemap() {
    this._cesiumOn = !this._cesiumOn;
    localStorage.setItem("tr_e3_basemap", this._cesiumOn ? "1" : "0");
    this._applyBasemap();
  }

  _applyBasemap() {
    const el = document.getElementById("e3-cesium");
    const btn = document.getElementById("e3-basemap");
    if (btn) btn.classList.toggle("off", !this._cesiumOn);
    if (!this._cesium) return; // 底图尚未加载完成，仅同步按钮；加载完成后会再调用
    el.style.visibility = this._cesiumOn ? "visible" : "hidden";
    if (this._cesiumOn) {
      this._cesium.viewer.scene.requestRender(); // 恢复时立即重绘一帧
    }
  }

  // 切换图源后重建 imagery layers（无需重开编辑器）
  _rebuildBasemap() {
    if (!this._cesium) {
      this.status("底图尚未加载完成，图源选择将在加载后生效");
      return;
    }
    const { Cesium, viewer } = this._cesium;
    viewer.imageryLayers.removeAll();
    for (const p of buildImageryLayers(Cesium)) viewer.imageryLayers.addImageryProvider(p);
    const info = basemapInfo();
    if (!info.configured) {
      this.status("天地图 key 未配置（.env.local: VITE_TIANDITU_KEY），已回退 Esri 影像");
    } else {
      this.status(`底图已切换：${info.credit}`);
    }
    if (this._cesiumOn) viewer.scene.requestRender();
  }

  /* ---------------- settings panel ---------------- */
  // 可扩展设置面板：分节渲染，新增设置项只需在 _settingsSections 返回数组里加一项
  // { id, title, render(bodyEl) }，面板定位、开关、外部点击关闭均自动处理。
  _settingsSections() {
    return [
      {
        id: "basemap-src",
        title: "地图图源",
        render: (el) => {
          const current = getBasemapSource();
          for (const s of basemapSources) {
            const row = document.createElement("button");
            row.type = "button";
            row.className = "e3-set-item" + (s.id === current ? " active" : "");
            row.innerHTML = `<span class="e3-set-radio"></span><span class="e3-set-label">${s.label}<small>${s.desc}</small></span>`;
            row.addEventListener("click", () => {
              if (s.id === getBasemapSource()) { this._closeSettings(); return; }
              setBasemapSource(s.id);
              this._rebuildBasemap();
              this._openSettings(); // 重渲染以更新选中态
            });
            el.appendChild(row);
          }
        },
      },
      {
        id: "origin",
        title: "地图位置 · 范围中心的经纬度",
        render: (el) => {
          const o = this.map.origin;
          el.innerHTML = `
            <div class="e3-org-search">
              <input id="e3-org-q" type="text" placeholder="搜索地点，如：上海东方明珠" spellcheck="false" autocomplete="off" />
              <ul id="e3-org-q-list" class="hidden"></ul>
            </div>
            <div class="e3-set-xy">
              <label>纬度 lat<input id="e3-org-lat" type="number" step="0.000001" min="-90" max="90" value="${o.lat.toFixed(6)}" /></label>
              <label>经度 lon<input id="e3-org-lon" type="number" step="0.000001" min="-180" max="180" value="${o.lon.toFixed(6)}" /></label>
            </div>
            <div class="e3-set-row">
              <button id="e3-org-apply" class="e3-set-btn primary">应用坐标</button>
              <button id="e3-org-pick" class="e3-set-btn">在地图上拾取</button>
            </div>
            <small class="e3-set-hint">搜索 / 拾取 / 手动输入均会把地图整体搬到该处（范围中心 = 金色立柱）。调整范围位置时坐标自动跟随。</small>
          `;
          this._wireOriginSearch(el);
          el.querySelector("#e3-org-apply").addEventListener("click", () => {
            const lat = parseFloat(el.querySelector("#e3-org-lat").value);
            const lon = parseFloat(el.querySelector("#e3-org-lon").value);
            if (this._setOriginLL(lat, lon)) this._openSettings(); // 重渲染以刷新输入框
          });
          el.querySelector("#e3-org-pick").addEventListener("click", () => {
            this._closeSettings();
            this._setOriginPickMode();
          });
        },
      },
      // 后续设置项示例：
      // { id: "grid", title: "网格", render: (el) => {...} },
    ];
  }

  // 设置面板地名搜索：输入关键字（350ms 防抖）搜天地图 POI，下拉选择后
  // 回填经纬度并把地图整体搬到该处（= 设为范围中心）。搜索框仿
  // work/uav-inspection 的 PlaceSearchBox（键盘上下/回车/Esc、过期请求取消）。
  // 监听与状态挂在本次面板渲染的 DOM 上，面板重渲染即自然丢弃。
  _wireOriginSearch(el) {
    const input = el.querySelector("#e3-org-q");
    const list = el.querySelector("#e3-org-q-list");
    if (!input || !list) return;
    let debounceTimer = 0;
    let abortController = null;
    let results = [];
    let activeIndex = -1;

    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const show = (html) => { list.innerHTML = html; list.classList.remove("hidden"); };
    const hide = () => { list.classList.add("hidden"); list.innerHTML = ""; };
    const renderResults = () => {
      show(results.map((r, i) => `
        <li data-i="${i}" class="${i === activeIndex ? "active" : ""}">
          <div class="e3-org-q-name">${esc(r.name)}</div>
          ${r.meta ? `<div class="e3-org-q-meta">${esc(r.meta)}</div>` : ""}
        </li>`).join(""));
    };

    const choose = (i) => {
      const r = results[i];
      if (!r) return;
      input.value = r.name;
      hide();
      abortController?.abort();
      el.querySelector("#e3-org-lat").value = r.lat.toFixed(6);
      el.querySelector("#e3-org-lon").value = r.lng.toFixed(6);
      this._setOriginLL(r.lat, r.lng);
      this.status(`已定位到「${r.name}」· 地图整体搬至 ${r.lat.toFixed(6)}, ${r.lng.toFixed(6)} · 记得保存`);
    };

    const runSearch = async (q) => {
      abortController?.abort();
      abortController = new AbortController();
      const { signal } = abortController;
      show(`<li class="e3-org-q-empty">搜索中…</li>`);
      try {
        const rows = await searchPlaces(q, { signal });
        if (signal.aborted) return;
        results = rows;
        activeIndex = rows.length ? 0 : -1;
        if (results.length) renderResults();
        else show(`<li class="e3-org-q-empty">未找到匹配的地点</li>`);
      } catch (err) {
        if (signal.aborted || err?.name === "AbortError") return;
        results = []; activeIndex = -1;
        show(`<li class="e3-org-q-empty">${err?.name === "TimeoutError" ? "搜索超时，请检查网络" : "搜索服务暂不可用"}</li>`);
      }
    };

    input.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      const q = input.value.trim();
      if (!q) { clearTimeout(debounceTimer); abortController?.abort(); results = []; activeIndex = -1; hide(); return; }
      debounceTimer = setTimeout(runSearch, 350, q);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!results.length) return;
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        activeIndex = (activeIndex + delta + results.length) % results.length;
        renderResults();
      } else if (e.key === "Enter") {
        e.preventDefault();
        choose(activeIndex >= 0 ? activeIndex : 0);
      } else if (e.key === "Escape") {
        hide();
      }
    });
    // mousedown.prevent 保住输入框焦点；click 兜底（键盘选择的回车路径已由 keydown 处理）
    list.addEventListener("mousedown", (e) => {
      const li = e.target.closest("li[data-i]");
      if (li) { e.preventDefault(); choose(+li.dataset.i); }
    });
  }

  _toggleSettings() {
    const pop = document.getElementById("e3-settings-pop");
    if (pop.classList.contains("hidden")) this._openSettings();
    else this._closeSettings();
  }

  _openSettings() {
    const pop = document.getElementById("e3-settings-pop");
    const btn = document.getElementById("e3-settings");
    pop.innerHTML = "";
    // 面板定位于设置按钮下方，超出右边界时回退
    const r = btn.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 268)) + "px";
    pop.style.top = r.bottom + 8 + "px";
    for (const sec of this._settingsSections()) {
      const box = document.createElement("div");
      box.className = "e3-set-sec";
      const h = document.createElement("h5");
      h.textContent = sec.title;
      const body = document.createElement("div");
      body.className = "e3-set-body";
      sec.render(body);
      box.append(h, body);
      pop.appendChild(box);
    }
    pop.classList.remove("hidden");
    // 捕获阶段监听外部点击关闭；setTimeout 避免本次点击立即触发。
    // 先移除旧监听（面板内操作会反复 _openSettings 重渲染，不移除会越积越多）
    setTimeout(() => {
      if (this._onSettingsOutside) document.removeEventListener("pointerdown", this._onSettingsOutside, true);
      this._onSettingsOutside = (e) => {
        if (!pop.contains(e.target) && e.target !== btn) this._closeSettings();
      };
      document.addEventListener("pointerdown", this._onSettingsOutside, true);
    }, 0);
  }

  _closeSettings() {
    const pop = document.getElementById("e3-settings-pop");
    pop.classList.add("hidden");
    if (this._onSettingsOutside) {
      document.removeEventListener("pointerdown", this._onSettingsOutside, true);
      this._onSettingsOutside = null;
    }
  }

  _updateEnu() {
    if (!this._cesium) return;
    const { Cesium, viewer } = this._cesium;
    const o = this.map.origin || { lat: 25.0477, lon: 121.5173 };
    this._cesium.enu = Cesium.Transforms.eastNorthUpToFixedFrame(
      Cesium.Cartesian3.fromDegrees(o.lon, o.lat),
    );
    viewer.scene.globe.show = true;
    // 同步 Cesium 锚点标记位置
    if (this._originEntity) {
      this._originEntity.position = Cesium.Cartesian3.fromDegrees(o.lon, o.lat, 30);
      if (this._cesiumOn) viewer.scene.requestRender();
    }
  }

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

  // 屏幕空间胖线（Line2）：线宽恒定像素，任意视角/距离都清晰可见（不受雾影响）；
  // 曲率下沉直接烘焙进端点（相邻点间距内弯曲量可忽略），不参与 _bendArea 顶点重写。
  // ox/oz：几何存储的相对原点（位置减去原点，曲率仍按绝对坐标计算）
  _fatLine(pts, widthPx, colorHex, opacity, lift, ox = 0, oz = 0) {
    const geo = new LineGeometry();
    geo.setPositions(pts.flatMap((p) => [p.x - ox, lift - this._curveOffset(p.x, p.z), p.z - oz]));
    const mat = new LineMaterial({
      color: colorHex, linewidth: widthPx, transparent: true, opacity, depthWrite: false,
    });
    const size = this._three.renderer.getSize(new THREE.Vector2());
    mat.resolution.set(size.x, size.y);
    const line = new Line2(geo, mat);
    line.userData.fatLine = true;
    return line;
  }

  // 世界宽度路带（贴合曲率）：中心线 pts 两侧偏移 halfW 构建三角条带。
  // 真实世界宽 → 透视正确（近宽远窄，平视不失真）；同一几何体无接缝，
  // 不会出现屏幕空间胖线的段接缝亮斑 / 近轴向光斑
  _roadRibbon(pts, halfW, colorHex, opacity) {
    const pos = [], idx = [];
    for (let i = 0; i < pts.length; i++) {
      const p0 = pts[Math.max(i - 1, 0)], p1 = pts[Math.min(i + 1, pts.length - 1)];
      const dx = p1.x - p0.x, dz = p1.z - p0.z;
      const len = Math.hypot(dx, dz) || 1;
      const ox = (-dz / len) * halfW, oz = (dx / len) * halfW;
      const y = 0.02 - this._curveOffset(pts[i].x, pts[i].z);
      pos.push(pts[i].x + ox, y, pts[i].z + oz, pts[i].x - ox, y, pts[i].z - oz);
      if (i) {
        const a = (i - 1) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: colorHex, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide,
    }));
    mesh.renderOrder = 1;
    return mesh;
  }

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

  // Three(局部米) → Cesium ECEF 相机同步。
  // ENU 原点 = 范围中心（origin 经纬度），相机局部坐标按相对中心换算。
  // 轴映射：ENU.x=game.x, ENU.y=-game.z, ENU.z=game.y
  _syncCesiumCamera() {
    if (!this._cesium || !this._cesiumOn) return;
    const { Cesium, viewer, enu } = this._cesium;
    const cam = this._three.camera;
    const a = this.map.area || { cx: 0, cz: 0 };
    const pos = Cesium.Matrix4.multiplyByPoint(
      enu,
      new Cesium.Cartesian3(cam.position.x - a.cx, -(cam.position.z - a.cz), cam.position.y),
      new Cesium.Cartesian3(),
    );
    // 方向/up 是 ENU 切平面向量，同样要经 enu 旋转到 ECEF（不含平移）
    const d = cam.getWorldDirection(this._v);
    const dir = Cesium.Matrix4.multiplyByPointAsVector(
      enu,
      new Cesium.Cartesian3(d.x, -d.z, d.y),
      new Cesium.Cartesian3(),
    );
    const up = Cesium.Matrix4.multiplyByPointAsVector(
      enu,
      new Cesium.Cartesian3(cam.up.x, -cam.up.z, cam.up.y),
      new Cesium.Cartesian3(),
    );
    viewer.camera.setView({
      destination: pos,
      orientation: { direction: dir, up },
    });
  }

  // 底图同步渲染（useDefaultRenderLoop 已关）：在编辑器的 RAF 回调里显式绘制，
  // 与 Three 的 renderer.render 同帧执行，两层 canvas 姿态恒一致。
  // viewer.render = initializeFrame + clock.tick + scene.render，与 Cesium 自有循环逐帧等价，
  // 总渲染工作量不变（此前也是每帧 requestRender 画一帧）
  _renderCesiumSync() {
    const viewer = this._cesium.viewer;
    this._resizeCesium(); // 逐帧校验画布尺寸（值不变时零开销）
    viewer.render();
  }

  // 切换工具并同步左侧工具栏高亮
  _setTool(t) {
    this.tool = t;
    document.querySelectorAll("#e3-tools .e3-tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === t));
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
  _groundPoint(e) {
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
    // 描边绘制中（草稿激活）绕过网格吸附：吸附会把弯路量化成锯齿台阶，严重走形
    const snap = !this.draft && this._snap > 1 ? this._snap : 0;
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
    } else if (this.tool === "place-tree" || this.tool === "place-lamp") {
      const type = this.tool === "place-tree" ? "tree" : "lamp";
      this._addObject({ id: uid(), type, pos: [pt.x, pt.z], rot: 0, params: {} });
      this._pushUndo("放置" + (type === "tree" ? "树木" : "路灯"));
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
    } else if (this.tool === "select") {
      const picked = this._pickObject(e);
      if (picked) this._select(picked.wrapper);
      else {
        const road = this._pickRoad(pt);
        if (road) this._selectRoad(road);
        else this._select(null);
      }
    }
  }

  _onMove(e) {
    const d = this.draft;
    if (!d || !(this.tool.startsWith("draw") || d.area)) return;
    let pt = this._groundPoint(e);
    if (!pt) return;
    if (d.road && e.shiftKey) pt = this._snap45(pt); // Shift：45° 方向吸附
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
  }

  _finishDraft() {
    if (!this.draft) return;
    if (this.draft.area) return this._finishAreaDraft();
    if (this.draft.road) return this._finishRoadTrace();
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
      const obj = { id: uid(), type: "building", pos: [pts[0][0], pts[0][1]], rot: 0, params: { height: 24, footprint: pts } };
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

  // 切换工具 / 开始新绘制前丢弃进行中的草稿（描边会话需同时恢复左键视角控制）
  _discardDraft() {
    if (!this.draft) return;
    if (this.draft.road) this._endRoadTrace();
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
    const road = { id: uid(), points: pts, width: d.width || 12 };
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
    const road = { id: uid(), points: pts, width: d.width || 12, closed: true };
    this.map.features.roads.push(road);
    this._rebuildFeature("roads");
    this._pushUndo("取面生成道路");
    const area = Math.round(Math.abs(this._polyArea(pts)));
    const w = this._wrappers.get(road.id);
    this._endRoadTrace();
    if (w) this._select(w);
    this.status(`面道路已生成：${pts.length} 节点 · 约 ${area}㎡ · 可点选继续编辑`);
  }

  // 鞋带公式：多边形面积（有符号）
  _polyArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % pts.length];
      a += x1 * z2 - x2 * z1;
    }
    return a / 2;
  }

  _polylineLen(pts) {
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return L;
  }

  // 手工描边平滑：① 1-2-1 卷积两轮去除手抖噪声（闭合时环绕，刻意直角/收口区不动）；
  // ② Chaikin 角切割两轮（严格在凸包内，绝不外凸；直角顶点原样保留）；
  // ③ 弦长等距线性重采样（Chaikin 后已足够圆滑）；
  // ④ 闭合面按质心等比放大回原面积（平滑会使面积略缩）。
  // keepEnds > 0 时（闭合面）：收口起点沿路径两侧该弧长内的顶点全部保持原样，头尾拐角不磨圆
  _smoothPath(pts, closed, step = 3, keepEnds = 0) {
    if (pts.length < 3) return pts.map((p) => [p[0], p[1]]);
    const n0 = pts.length;
    // 收口保护区：闭合面起点沿路径正/反向 keepEnds 弧长内
    const protect = new Array(n0).fill(false);
    if (closed && keepEnds > 0) {
      const d = [0];
      for (let i = 1; i < n0; i++) d.push(d[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const total = d[n0 - 1] + Math.hypot(pts[0][0] - pts[n0 - 1][0], pts[0][1] - pts[n0 - 1][1]);
      for (let i = 0; i < n0; i++) if (Math.min(d[i], total - d[i]) <= keepEnds) protect[i] = true;
    }
    // 转角检测（带符号）：|转角| >40° 且相邻转角非大角度异号（排除左右交替的手抖尖刺）
    // → 刻意直角，平滑时保持原位。全直角多边形（矩形）所有顶点同号，全部保留
    const sharpMarks = (arr) => {
      const n = arr.length, turn = new Array(n).fill(0);
      for (let i = 0; i < n; i++) {
        const p = arr[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
        const v = arr[i], q = arr[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
        const a1 = Math.atan2(v[1] - p[1], v[0] - p[0]);
        const a2 = Math.atan2(q[1] - v[1], q[0] - v[0]);
        let t = a2 - a1;
        while (t > Math.PI) t -= 2 * Math.PI;
        while (t < -Math.PI) t += 2 * Math.PI;
        turn[i] = t;
      }
      return turn.map((t, i) => {
        if (!closed && (i === 0 || i === n - 1)) return false;
        if (Math.abs(t) <= 0.7) return false;
        // 手抖尖刺特征：相邻即出现异号大转角，且两点几乎重合（真凹角与相邻拐角相距很远）
        const pi = closed ? (i - 1 + n) % n : Math.max(0, i - 1);
        const ni = closed ? (i + 1) % n : Math.min(n - 1, i + 1);
        const spike = (Math.abs(turn[pi]) > 0.5 && turn[pi] * t < 0 && Math.hypot(arr[i][0] - arr[pi][0], arr[i][1] - arr[pi][1]) < 3) ||
                      (Math.abs(turn[ni]) > 0.5 && turn[ni] * t < 0 && Math.hypot(arr[i][0] - arr[ni][0], arr[i][1] - arr[ni][1]) < 3);
        return !spike;
      });
    };
    let src = pts.map((p) => [p[0], p[1]]);
    let marks = sharpMarks(src);
    for (let k = 0; k < 2; k++) {
      const n = src.length, out = [];
      for (let i = 0; i < n; i++) {
        const p = src[i];
        if (protect[i] || marks[i]) { out.push([p[0], p[1]]); continue; } // 直角/收口顶点保持原位
        const prev = src[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
        const next = src[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
        out.push([(prev[0] + 2 * p[0] + next[0]) / 4, (prev[1] + 2 * p[1] + next[1]) / 4]);
      }
      src = out;
    }
    for (let k = 0; k < 2; k++) {
      const n = src.length, out = [];
      const segs = closed ? n : n - 1;
      if (!closed) out.push([src[0][0], src[0][1]]);
      for (let i = 0; i < segs; i++) {
        const p = src[i], q = src[(i + 1) % n];
        // 直角顶点不切割，原样保留，拐角 crisp
        out.push(marks[i] ? [p[0], p[1]] : [p[0] * 0.75 + q[0] * 0.25, p[1] * 0.75 + q[1] * 0.25]);
        out.push(marks[(i + 1) % n] ? [q[0], q[1]] : [p[0] * 0.25 + q[0] * 0.75, p[1] * 0.25 + q[1] * 0.75]);
      }
      if (!closed) out.push([src[n - 1][0], src[n - 1][1]]);
      // 直角顶点原样保留会产生连续重复点（零长度段），需去重，否则转角检测与面积补偿失真
      const ded = [];
      for (const p of out) {
        const l = ded[ded.length - 1];
        if (!l || Math.hypot(p[0] - l[0], p[1] - l[1]) > 0.01) ded.push(p);
      }
      if (closed && ded.length > 1) {
        const f = ded[0], l = ded[ded.length - 1];
        if (Math.hypot(f[0] - l[0], f[1] - l[1]) < 0.01) ded.pop(); // 闭合环首尾重复
      }
      src = ded;
      marks = sharpMarks(src); // 顶点数已变，重算直角标记
    }
    // 弦长等距重采样（线性插值足够：Chaikin 后折线已圆滑）
    const m = src.length;
    const segN = closed ? m : m - 1;
    const segL = [];
    let total = 0;
    for (let i = 0; i < segN; i++) {
      const p = src[i], q = src[(i + 1) % m];
      const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
      segL.push(l); total += l;
    }
    const count = Math.max(8, Math.min(2000, Math.round(total / step)));
    const res = [];
    let seg = 0, acc = 0;
    for (let k = 0; k < count; k++) {
      const target = (total * k) / count;
      while (seg < segN - 1 && acc + segL[seg] < target) { acc += segL[seg]; seg++; }
      const p = src[seg], q = src[(seg + 1) % m];
      const t = segL[seg] > 0 ? (target - acc) / segL[seg] : 0;
      res.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
    if (!closed) res.push([src[m - 1][0], src[m - 1][1]]);
    if (closed) {
      // 平滑使面积略缩：按质心等比放大回原面积
      const area = (ps) => {
        let a = 0;
        for (let i = 0; i < ps.length; i++) {
          const p = ps[i], q = ps[(i + 1) % ps.length];
          a += p[0] * q[1] - q[0] * p[1];
        }
        return a / 2;
      };
      const a0 = Math.abs(area(pts)), a1 = Math.abs(area(res));
      if (a0 > 0.0001 && a1 > 0.0001) {
        const s = Math.min(1.1, Math.sqrt(a0 / a1)); // 上限 1.1，避免局部圆角损失被整体放大越界
        const cx = res.reduce((t, p) => t + p[0], 0) / res.length;
        const cz = res.reduce((t, p) => t + p[1], 0) / res.length;
        for (const p of res) { p[0] = cx + (p[0] - cx) * s; p[1] = cz + (p[1] - cz) * s; }
      }
    }
    const out = [];
    for (const p of res) {
      const q = [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10];
      const last = out[out.length - 1];
      if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) >= 0.2) out.push(q);
    }
    return out.length >= 2 ? out : src.map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]);
  }

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

  // 描边点级撤销 / 恢复（仅作用于草稿，不影响已提交内容；范围描边与地图描边通用）
  _undoDraftPoint() {
    const d = this.draft;
    if (!d || (!d.area && !d.road) || !d.points.length) return;
    d.redo.push(d.points.pop());
    this._updateDraftPreview();
    if (d.road) this._updateTracePanel();
    else this._renderAreaDraftPanel();
  }

  _redoDraftPoint() {
    const d = this.draft;
    if (!d || (!d.area && !d.road) || !d.redo.length) return;
    d.points.push(d.redo.pop());
    this._updateDraftPreview();
    if (d.road) this._updateTracePanel();
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
  _matRoad() {
    // 与程序化纵横路带同色同透明度（0x8ea3bd @ 0.5），编辑器内视觉统一
    return new THREE.MeshBasicMaterial({ color: 0x8ea3bd, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide });
  }
  _matRiver() { return new THREE.MeshStandardMaterial({ color: 0x1d5f8f, transparent: true, opacity: 0.8, roughness: 0.25, metalness: 0.1 }); }
  _matBuilding() { return new THREE.MeshStandardMaterial({ color: 0xb8b2a6, roughness: 0.85 }); }
  _matRoof() { return new THREE.MeshStandardMaterial({ color: 0x6f6a60, roughness: 0.9 }); }

  // 折线 → 带状网格（两三角/段 + 接头圆片补缝）；yBase 区分叠放层次
  _stripGeometry(points, width, yBase = 0.05) {
    const hw = width / 2;
    const verts = [], idx = [];
    const dirs = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const prev = points[Math.max(0, i - 1)], next = points[Math.min(points.length - 1, i + 1)];
      const dx = next.x - prev.x, dz = next.z - prev.z;
      const len = Math.hypot(dx, dz) || 1;
      dirs.push({ nx: -dz / len, nz: dx / len });
    }
    for (let i = 0; i < points.length; i++) {
      const p = points[i], n = dirs[i];
      const y = yBase - this._curveOffset(p.x, p.z); // 贴合球面（中心零基准）
      verts.push(p.x + n.nx * hw, y, p.z + n.nz * hw);
      verts.push(p.x - n.nx * hw, y, p.z - n.nz * hw);
      if (i < points.length - 1) {
        const a = i * 2;
        // 绕朝上（CCW）：A_i → A_{i+1} → B_i，否则正面朝下被剔除，从上看只剩接头圆片
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    // 接头圆片（去掉 uv 以与带状几何属性一致，否则 mergeGeometries 返回 null）
    const discs = [];
    for (const p of points) {
      const c = new THREE.CircleGeometry(hw, 12);
      c.deleteAttribute("uv");
      c.rotateX(-Math.PI / 2);
      c.translate(p.x, yBase - this._curveOffset(p.x, p.z), p.z);
      discs.push(c);
    }
    const discMerged = mergeGeometries(discs);
    return mergeGeometries([geo, discMerged]) || geo;
  }

  _buildRoadMesh(data) {
    if (data.closed && data.points.length >= 3) {
      // 取面道路：围合多边形整体填充为路面
      const shape = new THREE.Shape(data.points.map(([x, z]) => new THREE.Vector2(x, -z)));
      const geo = bendGeometry(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2));
      geo.translate(0, 0.05, 0);
      const mesh = new THREE.Mesh(geo, this._matRoad());
      mesh.receiveShadow = true;
      return mesh;
    }
    const geo = this._stripGeometry(data.points.map(([x, z]) => ({ x, z })), data.width || 12);
    const mesh = new THREE.Mesh(geo, this._matRoad());
    mesh.receiveShadow = true;
    return mesh;
  }

  _buildRiverMesh(data) {
    const geo = this._stripGeometry(data.points.map(([x, z]) => ({ x, z })), data.width || 26);
    const mesh = new THREE.Mesh(geo, this._matRiver());
    mesh.position.y = -0.02;
    return mesh;
  }

  _buildBuildingMesh(obj) {
    const fp = (obj.params.footprint || []).map(([x, z]) => new THREE.Vector2(x, -z));
    if (fp.length < 3) return null;
    const h = obj.params.height || 24;
    const shape = new THREE.Shape(fp);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2); // (x, y, 0..h) → (x, h..0?) 旋转后挤出方向变为 +Y
    const walls = new THREE.Mesh(geo, this._matBuilding());
    walls.castShadow = true; walls.receiveShadow = true;
    const roofGeo = new THREE.ShapeGeometry(shape);
    roofGeo.rotateX(-Math.PI / 2);
    roofGeo.translate(0, h, 0);
    const roof = new THREE.Mesh(roofGeo, this._matRoof());
    const group = new THREE.Group();
    group.add(walls, roof);
    return group;
  }

  _buildTreeMesh() {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.35, 3, 6), new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 1 }));
    trunk.position.y = 1.5; trunk.castShadow = true;
    const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(2.2, 0), new THREE.MeshStandardMaterial({ color: 0x2f7a3f, roughness: 1, flatShading: true }));
    crown.position.y = 4.6; crown.castShadow = true;
    g.add(trunk, crown);
    return g;
  }

  _buildLampMesh() {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 6.5, 6), new THREE.MeshStandardMaterial({ color: 0x3c4650, roughness: 0.6 }));
    pole.position.y = 3.25; pole.castShadow = true;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.45, 10, 8), new THREE.MeshStandardMaterial({ color: 0xfff3c4, emissive: 0xffd873, emissiveIntensity: 1.4 }));
    head.position.y = 6.6;
    g.add(pole, head);
    return g;
  }

  /* ---------------- wrappers（data ↔ three 对象） ---------------- */
  _makeWrapper(kind, data, object3d) {
    const root = new THREE.Group();
    root.userData.entityRoot = true; // 标记必须设在场景根节点上，_rebuildAll 清理时据此移除旧网格
    // 物件整体下沉贴合球面（数据仍存平面 x/z，y 仅是渲染偏移，中心零基准）
    if (kind === "object") root.position.set(data.pos[0], -this._curveOffset(data.pos[0], data.pos[1]), data.pos[1]), root.rotation.y = data.rot || 0;
    root.add(object3d);
    const pickMeshes = [];
    object3d.traverse((o) => { if (o.isMesh) { o.userData.entityId = data.id; pickMeshes.push(o); } });
    const w = { kind, data, root, pickMeshes };
    this._wrappers.set(data.id, w);
    for (const m of pickMeshes) this._byPick.set(m, w);
    this._three.scene.add(root);
    return w;
  }

  _rebuildAll() {
    this._wrappers = new Map();
    this._byPick = new Map();
    for (const w of this._three.scene.children.slice()) {
      if (w.userData.entityRoot) {
        this._three.scene.remove(w);
        w.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
      }
    }
    for (const r of this.map.features.roads) {
      this._makeWrapper("road", r, this._buildRoadMesh(r));
    }
    for (const r of this.map.features.rivers) {
      this._makeWrapper("river", r, this._buildRiverMesh(r));
    }
    for (const o of this.map.objects) {
      const m = this._buildObjectMesh(o);
      if (!m) continue;
      this._makeWrapper("object", o, m);
    }
    this._rebuildSkeleton();
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
    if (this.map.extRoads) {
      if (xs.length) {
        while (xs[xs.length - 1].at < b.maxX) xs.push({ at: xs[xs.length - 1].at + EXT_STEP_X, ext: true });
        while (xs[0].at > b.minX) xs.unshift({ at: xs[0].at - EXT_STEP_X, ext: true });
      }
      if (zs.length) {
        while (zs[zs.length - 1].at < b.maxZ) zs.push({ at: zs[zs.length - 1].at + EXT_STEP_Z, ext: true });
        while (zs[0].at > b.minZ) zs.unshift({ at: zs[0].at - EXT_STEP_Z, ext: true });
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
      const worldW = r.ext ? 6.8 : asphaltHalf(r.obj) * 2; // 延伸路=默认 street（lanes 1）
      const color = sel ? 0xf2c14e : r.ext ? 0x55637a : 0x8ea3bd;
      // 世界宽度路带：真实透视（近宽远窄），平视地球不失真
      g.add(this._roadRibbon(pts, worldW / 2, color, sel ? 0.9 : 0.5));
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
    if (o.type === "building") return this._buildBuildingMesh(o);
    if (o.type === "tree") return this._buildTreeMesh();
    if (o.type === "lamp") return this._buildLampMesh();
    return null;
  }

  _addObject(data) {
    this.map.objects.push(data);
    const m = this._buildObjectMesh(data);
    if (m) { this._select(this._makeWrapper("object", data, m)); }
  }

  /* ---------------- selection / properties ---------------- */
  _select(w) {
    const wasRoad = this.sel && (this.sel.kind === "roadX" || this.sel.kind === "roadZ");
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
    // 道路选中/取消时刷新骨架高亮（金色 = 选中）
    if (wasRoad || (w && (w.kind === "roadX" || w.kind === "roadZ"))) this._rebuildSkeleton();
  }

  _syncGizmoToData() {
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
    if (this.sel.kind === "object") {
      this.sel.data.pos = [Math.round(r.position.x * 10) / 10, Math.round(r.position.z * 10) / 10];
      this.sel.data.rot = Math.round((r.rotation.y || 0) * 100) / 100;
      r.position.y = -this._curveOffset(r.position.x, r.position.z); // 维持球面贴合
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

  _deleteSel() {
    if (!this.sel) return;
    if (this.sel.kind === "area") { this.status("地图范围不可删除，可在右侧重新描边或用 Gizmo 调整"); return; }
    const { kind, data } = this.sel;
    if (kind === "roadX") this.map.roadsX = this.map.roadsX.filter((r) => r !== data);
    else if (kind === "roadZ") this.map.roadsZ = this.map.roadsZ.filter((r) => r !== data);
    else if (kind === "road") this.map.features.roads = this.map.features.roads.filter((r) => r !== data);
    else if (kind === "river") this.map.features.rivers = this.map.features.rivers.filter((r) => r !== data);
    else this.map.objects = this.map.objects.filter((o) => o !== data);
    this._three.tc.detach();
    this.sel = null;
    this._rebuildAll();
    this._pushUndo("删除");
    this.status("已删除");
  }

  _renderProps() {
    const el = document.getElementById("e3-props");
    if (!this.sel) {
      const f = this.map.features;
      const opT = Math.round((1 - (this.map.gridOpacity ?? GRID_OPACITY_DEFAULT)) * 100); // 网格透明度%（0=默认浓度，100=完全透出影像）
      el.innerHTML = `
        <h4 class="me-tiprow">地图内容<span class="me-tip" data-tip="描边道路：道路菜单 →「地图描边」沿影像勾画 · 河流：折线描边（双击结束）· 建筑：多边形描边（≥3 点自动闭合）· 树 / 路灯：点击放置 · W/E/R 切换移动 / 旋转 / 缩放">?</span></h4>
        <div class="me-stat">描边道路 <b>${f.roads.length}</b></div>
        <div class="me-stat">河流 <b>${f.rivers.length}</b></div>
        <div class="me-stat">建筑/物件 <b>${this.map.objects.length}</b></div>
        <div class="me-stat me-tiprow">程序化路网 <b>${this.map.roadsX.length}×${this.map.roadsZ.length}</b>（2D 编辑器管理）<span class="me-tip" data-tip="灰色路带 / 紫色圆点 / 绿色标记 = 程序化城市骨架，与游戏实际生成的街道一致，仅显示不可选中；手工道路可点选编辑。两个编辑器编辑的是同一张地图。">?</span></div>
        <label class="me-check me-tiprow" data-tip="勾选后按固定间距自动补满世界边缘的默认街道（游戏内与预览同步）；不勾选则只保留手工道路。"><input id="ep-ext" type="checkbox" ${this.map.extRoads ? "checked" : ""} /> 程序化延伸街道</label>
        <div class="me-slider">
          <div class="me-slider-head"><span>网格透明度</span><b id="ep-grid-op-val">${opT}%</b></div>
          <input id="ep-grid-op-range" type="range" min="0" max="100" step="5" value="${opT}" style="--fill: ${opT}%" />
        </div>`;
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
        <label>车道<select id="ep-r-lanes">${[1, 2, 3, 4].map((n) => `<option ${n === (r.lanes || 1) ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        <label>人行道宽<input id="ep-r-sw" type="number" min="0" max="12" value="${r.sidewalk ?? 3}" /></label>
        <label>分隔带宽<input id="ep-r-md" type="number" min="0" max="14" value="${r.median ?? 0}" /></label>
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
    if (kind === "road" || kind === "river") {
      const poly = kind === "road" && data.closed;
      el.innerHTML = `
        <h4>${poly ? "面道路" : kind === "road" ? "描边道路" : "河流"} · 属性</h4>
        <label>名称<input id="ep-name" value="${data.name || ""}" maxlength="10" /></label>
        ${poly ? "" : `<label>宽度(m)<input id="ep-w" type="number" min="4" max="80" value="${data.width}" /></label>`}
        <div class="me-pos">${data.points.length} 个点${poly ? ` · 约 ${Math.round(Math.abs(this._polyArea(data.points)))}㎡` : ""}</div>
        <button class="me-del" id="ep-del">删除</button>`;
      if (!poly) el.querySelector("#ep-w").addEventListener("input", (e) => {
        data.width = clamp(+e.target.value || 12, 4, 80);
        this._rebuildAll(); this._dirty = true;
        const w = this._wrappers.get(data.id);
        if (w) { this.sel = w; this._three.tc.attach(w.root); } // 同步 Gizmo，但不重绘面板（避免输入被打断丢失）
      });
      // 名称用 input 事件逐键写入：change 需失焦才触发，输完直接点画布会随面板重绘丢字
      el.querySelector("#ep-name").addEventListener("input", (e) => { data.name = e.target.value; this._dirty = true; });
      el.querySelector("#ep-del").addEventListener("click", () => this._deleteSel());
    } else if (kind === "object" && data.type === "building") {
      el.innerHTML = `
        <h4>建筑 · 属性</h4>
        <label>高度(m)<input id="ep-h" type="number" min="4" max="240" value="${data.params.height}" /></label>
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
      el.querySelector("#ep-del").addEventListener("click", () => this._deleteSel());
    } else {
      const zh = { tree: "树木", lamp: "路灯" }[data.type] || data.type;
      el.innerHTML = `<h4>${zh} · 属性</h4>${posEl(data.pos[0], data.pos[1])}<button class="me-del" id="ep-del">删除</button>`;
      el.querySelector("#ep-del").addEventListener("click", () => this._deleteSel());
    }
  }

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
    return JSON.stringify({ f: this.map.features, o: this.map.objects, origin: this.map.origin, area: this.map.area, rx: this.map.roadsX, rz: this.map.roadsZ, ex: !!this.map.extRoads });
  }
  _pushUndo(label) {
    this.undoStack.push(this._snapshot());
    if (this.undoStack.length > 40) this.undoStack.shift();
    this.redoStack = [];
    this._dirty = true;
  }
  _undo() {
    if (this.draft && (this.draft.area || this.draft.road)) { this._undoDraftPoint(); return; } // 描边中：撤销草稿点
    if (this.undoStack.length <= 1) return;
    this.redoStack.push(this.undoStack.pop());
    this._applySnapshot(this.undoStack[this.undoStack.length - 1]);
    this.status("已撤销");
  }
  _redo() {
    if (this.draft && (this.draft.area || this.draft.road)) { this._redoDraftPoint(); return; } // 描边中：恢复草稿点
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
    ];
    const bar = document.getElementById("e3-tools");
    bar.innerHTML = tools.map(([t, icon, label], i) =>
      `<button class="e3-tool${i === 0 ? " active" : ""}" data-tool="${t}">${icon}<span>${label}</span></button>`).join("");

    // 「道路」子菜单：点击向右弹出（添加纵路 / 添加横路 / 地图描边，取代原独立按钮）
    const roadBtn = bar.querySelector('[data-tool="draw-road"]');
    roadBtn.classList.add("has-sub");
    const roadSub = document.createElement("div");
    roadSub.className = "e3-tool-sub hidden";
    roadSub.innerHTML =
      `<button data-tool="add-roadX">‖<span>添加纵路</span></button>` +
      `<button data-tool="add-roadZ">═<span>添加横路</span></button>` +
      `<button data-tool="draw-road">║<span>地图描边</span></button>`;
    bar.appendChild(roadSub);
    const closeRoadSub = () => roadSub.classList.add("hidden");
    roadSub.querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", () => {
        const t = b.dataset.tool;
        closeRoadSub();
        if (t === "draw-road") { this._startRoadTrace(); return; }
        this._discardDraft();
        this.tool = t;
        bar.querySelectorAll(".e3-tool").forEach((x) => x.classList.toggle("active", x === roadBtn));
        this._select(null);
        this.status(t === "add-roadX"
          ? "添加纵向路（南北向）：点击地图放置，放置后可拖动/编辑属性"
          : "添加横向路（东西向）：点击地图放置，放置后可拖动/编辑属性");
      });
    });

    bar.querySelectorAll(".e3-tool").forEach((b) => {
      b.addEventListener("click", () => {
        const t = b.dataset.tool;
        if (t === "set-origin") { this._setOriginPickMode(); return; }
        // 点击「道路」即选中该工具（进入地图描边并高亮），子菜单仍由下方切换器弹出
        if (t === "draw-road") { this._startRoadTrace(); return; }
        if (b !== roadBtn) closeRoadSub(); // 道路按钮由下方切换器自行收起/弹出
        this._discardDraft();
        this.tool = t;
        bar.querySelectorAll(".e3-tool").forEach((x) => x.classList.toggle("active", x === b));
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
        }[t] || "");
      });
    });
    // 道路按钮：切换子菜单显隐（后绑定，确保先执行通用处理再弹出）
    roadBtn.addEventListener("click", () => {
      roadSub.style.top = roadBtn.offsetTop + "px";
      roadSub.classList.toggle("hidden");
    });

    document.getElementById("e3-save").addEventListener("click", () => this._save());
    document.getElementById("e3-play").addEventListener("click", () => { if (this._save()) this.opts.onPlay(); });
    document.getElementById("e3-exit").addEventListener("click", () => this.opts.onClose());
    document.getElementById("e3-undo").addEventListener("click", () => this._undo());
    document.getElementById("e3-redo").addEventListener("click", () => this._redo());
    document.getElementById("e3-snap").addEventListener("change", (e) => { this._snap = +e.target.value; });
    document.getElementById("e3-basemap").addEventListener("click", () => this._toggleBasemap());
    document.getElementById("e3-settings").addEventListener("click", () => this._toggleSettings());

    this._onKey = (e) => {
      if (document.activeElement && ["INPUT", "SELECT"].includes(document.activeElement.tagName)) return;
      if (e.key === "Escape") {
        const pop = document.getElementById("e3-settings-pop");
        if (pop && !pop.classList.contains("hidden")) { this._closeSettings(); return; }
        closeRoadSub();
        if (this.tool === "set-origin") { this._setTool("select"); this.status("已取消锚点拾取"); return; }
        if (this.draft && this.draft.area) {
          this.draft = null; this._updateDraftPreview();
          this._selectArea(); this.status("已取消范围描边");
          return;
        }
        if (this.draft && this.draft.road) { this._endRoadTrace("已取消地图描边"); return; }
        this.draft = null; this._updateDraftPreview(); this._select(null);
      }
      else if (e.key === "Enter") this._finishDraft();
      else if (e.key === "Delete" || e.key === "Backspace") {
        if (this.draft && (this.draft.area || this.draft.road)) { this._undoDraftPoint(); return; } // 描边中：撤销上一顶点
        this._deleteSel();
      }
      else if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); this._undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key === "y") { e.preventDefault(); this._redo(); }
      else if (e.key === "w" || e.key === "W") this._three.tc.setMode("translate");
      else if (e.key === "e" || e.key === "E") this._three.tc.setMode("rotate");
      else if (e.key === "r" || e.key === "R") this._three.tc.setMode("scale");
    };
    window.addEventListener("keydown", this._onKey);
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
      features: this.map.features,
      objects: this.map.objects,
      origin: this.map.origin,
      area: this._areaEnsure(),
    });
    this.status(ok ? `已保存 · ${new Date().toLocaleTimeString()}` : "保存失败");
    return ok;
  }
}
