// Cesium 底图桥接：viewer 生命周期、影像图层、Three↔Cesium 相机/视锥/ENU 同步。
// 全部以编辑器实例（ed）为第一参数；ed 上用到的状态：
//   _cesium {Cesium,viewer,enu,creditEl} / _cesiumOn / _originEntity / _three / _v / _v2
//   map.origin / map.area / _layerVis / status()

import * as THREE from "three/webgpu";
import {
  buildImageryLayers, basemapInfo,
} from "../../config/cesium.js";
import { ORIGIN_DEFAULT } from "../../data/mapStore.js";

// 动态 import Cesium 并创建 viewer：外加影像层、关自带渲染循环（由编辑器 RAF 显式渲染）、
// 建立金色锚点标记。失败向上抛，由调用方决定降级（仅无底图，不影响编辑）。
export async function initCesium(ed) {
  const Cesium = await import("cesium");
  await import("cesium/Build/Cesium/Widgets/widgets.css");
  window.CESIUM_BASE_URL = "/cesium/";
  const info = basemapInfo();
  if (info.builtinToken) {
    ed.status("天地图使用内置公共 token（.env.local: VITE_TIANDITU_KEY 可配专属 key）");
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

  ed._cesium = { Cesium, viewer, enu: null, creditEl: credit };
  window.__e3 = ed; // dev 调试句柄
  // Cesium 锚点标记（金色点 + 标签，disableDepthTest 保证远处可见）
  const o = ed.map.origin;
  ed._originEntity = viewer.entities.add({
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
  updateEnu(ed);
  applyImageryVis(ed); // 恢复图层面板里被关闭的影像层（须在 ed._cesium 赋值后调用）
  applyBasemap(ed);  // 应用记忆中的开/关状态
  resizeCesium(ed);  // 底图创建后按当前视口校正尺寸
  syncFrustum(ed);   // 视锥与 Three 相机对齐
  ed.status(`底图：${info.credit} · 地理锚点 ${ed.map.origin.lat.toFixed(4)}, ${ed.map.origin.lon.toFixed(4)}`);
}

// 底图开/关（localStorage 持久化）
export function toggleBasemap(ed) {
  ed._cesiumOn = !ed._cesiumOn;
  localStorage.setItem("tr_e3_basemap", ed._cesiumOn ? "1" : "0");
  applyBasemap(ed);
}

export function applyBasemap(ed) {
  const el = document.getElementById("e3-cesium");
  const btn = document.getElementById("e3-basemap");
  if (btn) btn.classList.toggle("off", !ed._cesiumOn);
  if (!ed._cesium) return; // 底图尚未加载完成，仅同步按钮；加载完成后会再调用
  el.style.visibility = ed._cesiumOn ? "visible" : "hidden";
  if (ed._cesiumOn) {
    ed._cesium.viewer.scene.requestRender(); // 恢复时立即重绘一帧
  }
}

// 切换图源后重建 imagery layers（无需重开编辑器）
export function rebuildBasemap(ed) {
  if (!ed._cesium) {
    ed.status("底图尚未加载完成，图源选择将在加载后生效");
    return;
  }
  const { Cesium, viewer } = ed._cesium;
  viewer.imageryLayers.removeAll();
  for (const p of buildImageryLayers(Cesium)) viewer.imageryLayers.addImageryProvider(p);
  applyImageryVis(ed); // 图源切换重建后恢复影像层显隐
  const info = basemapInfo();
  ed.status(info.builtinToken
    ? `底图已切换：${info.credit}（内置公共 token，可配 VITE_TIANDITU_KEY 替换）`
    : `底图已切换：${info.credit}`);
  if (ed._cesiumOn) viewer.scene.requestRender();
}

// 底图影像层按 provider URL 分类显隐（GeoQ 垫底 / 天地图注记 / 其余=卫星影像）
export function applyImageryVis(ed) {
  if (!ed._cesium) return;
  const { viewer } = ed._cesium;
  const layers = viewer.imageryLayers;
  for (let i = 0; i < layers.length; i++) {
    const layer = layers.get(i);
    const p = layer.imageryProvider || layer.provider || layer._imageryProvider;
    const url = String(p?.url || "");
    // cia/cva 均为天地图中文注记（影像注记/矢量注记），URL 被规范化时仍能命中
    const key = url.includes("geoq") ? "base" : (url.includes("cia_w") || url.includes("cva_w")) ? "anno" : "img";
    layer.show = ed._layerVis[key] !== false;
  }
  if (ed._cesiumOn) { try { viewer.scene.requestRender(); } catch { /* 忽略 */ } }
}

// Cesium 渲染外置后其自有循环里的 resize/configureCameraFrustum 不再执行，
// 显式按视口尺寸同步 backing store，并在尺寸变化时同步相机纵横比
export function resizeCesium(ed) {
  if (!ed._cesium) return;
  const vp = document.getElementById("e3-viewport");
  const c = document.querySelector("#e3-cesium canvas");
  if (!c || !vp.clientWidth) return;
  const dpr = Math.min(window.devicePixelRatio, 2);
  const bw = Math.round(vp.clientWidth * dpr), bh = Math.round(vp.clientHeight * dpr);
  if (c.width !== bw || c.height !== bh) {
    c.width = bw; c.height = bh;
    c.style.width = vp.clientWidth + "px";
    c.style.height = vp.clientHeight + "px";
    ed._cesium.viewer.camera.frustum.aspectRatio = bw / bh;
  }
}

// 视锥对齐：Cesium 的 fov 语义是"水平 FOV"（aspect>1 时），Three 是垂直 FOV。
// 不对齐时影像与网格投影比例不一致，平移视角后错位越来越明显。
export function syncFrustum(ed) {
  if (!ed._cesium || !ed._three) return;
  const size = ed._three.renderer.getSize(new THREE.Vector2());
  const aspect = size.x / Math.max(1, size.y);
  const vFovHalf = (ed._three.camera.fov * Math.PI) / 360;
  ed._cesium.viewer.camera.frustum.fov = 2 * Math.atan(Math.tan(vFovHalf) * aspect);
}

// ENU 矩阵重算（origin 变化 / 编辑器打开时）+ 同步 Cesium 锚点标记位置
export function updateEnu(ed) {
  if (!ed._cesium) return;
  const { Cesium, viewer } = ed._cesium;
  const o = ed.map.origin || { ...ORIGIN_DEFAULT };
  ed._cesium.enu = Cesium.Transforms.eastNorthUpToFixedFrame(
    Cesium.Cartesian3.fromDegrees(o.lon, o.lat),
  );
  viewer.scene.globe.show = true;
  // 同步 Cesium 锚点标记位置
  if (ed._originEntity) {
    ed._originEntity.position = Cesium.Cartesian3.fromDegrees(o.lon, o.lat, 30);
    if (ed._cesiumOn) viewer.scene.requestRender();
  }
}

// Three(局部米) → Cesium ECEF 相机同步。
// ENU 原点 = 范围中心（origin 经纬度），相机局部坐标按相对中心换算。
// 轴映射：ENU.x=game.x, ENU.y=-game.z, ENU.z=game.y
export function syncCesiumCamera(ed) {
  if (!ed._cesium || !ed._cesiumOn) return;
  const { Cesium, viewer, enu } = ed._cesium;
  const cam = ed._three.camera;
  const a = ed.map.area || { cx: 0, cz: 0 };
  const pos = Cesium.Matrix4.multiplyByPoint(
    enu,
    new Cesium.Cartesian3(cam.position.x - a.cx, -(cam.position.z - a.cz), cam.position.y),
    new Cesium.Cartesian3(),
  );
  // 方向/up 是 ENU 切平面向量，同样要经 enu 旋转到 ECEF（不含平移）。
  // up 必须传相机真实"屏幕上方"基向量（matrixWorld 列 1），不能传世界竖直 cam.up=(0,1,0)：
  // Cesium setView 内部会把 direction/up 往返转成 heading/pitch/roll，而该转换在接近天顶
  // （视线与 up 平行，俯仰 ±2.6° 内）退化——heading 退取 up 的水平残差、roll 被直接丢弃。
  // 世界竖直 up 俯视时与视线平行，残差只剩噪声级几何量 → 底图姿态随俯视跳变，
  // 网格相对影像旋转几十°~180°（"俯视时网格不贴地图"的根源）；
  // 屏幕上方恒 ⊥ 视线，退化分支变成"由屏幕上方精确推方位角"，全俯仰连续贴合。
  const d = cam.getWorldDirection(ed._v);
  const su = ed._v2.setFromMatrixColumn(cam.matrixWorld, 1);
  const dir = Cesium.Matrix4.multiplyByPointAsVector(
    enu,
    new Cesium.Cartesian3(d.x, -d.z, d.y),
    new Cesium.Cartesian3(),
  );
  const up = Cesium.Matrix4.multiplyByPointAsVector(
    enu,
    new Cesium.Cartesian3(su.x, -su.z, su.y),
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
export function renderCesiumSync(ed) {
  const viewer = ed._cesium.viewer;
  resizeCesium(ed); // 逐帧校验画布尺寸（值不变时零开销）
  viewer.render();
}
