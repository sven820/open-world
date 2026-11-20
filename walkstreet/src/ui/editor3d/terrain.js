// 「地形编辑」工具（3D 编辑器左侧工具栏入口）：右侧模式面板 + 自定义笔刷 +
// 真实高程采样 + Cesium 地形挂载。高度场本体在 world/terrain.js（与运行时共用）。
//
// 面板结构：
//  - 「开启地形」总开关：关 = 全平世界（与没有地形编辑时一致）；开 = 先给一张
//    基础平地，下面两种生成方式铺出起伏，生成结果都能继续笔刷雕刻：
//    ① 随机地形 —— 分形噪声一键填充（幅度/起伏尺度/种子可调）；
//    ② 真实地形 —— 按地图范围网格采样真实世界高程（需卫星底图，自动打开），
//       数据源复刻 uav-inspection 的回退链（ArcGIS 全球地形优先 → Cesium Ion 兜底）；
//       采样成功后把同一 provider 挂到编辑器底图 Cesium 球上，卫星影像贴合真实
//       地形起伏，与 three.js 侧地形网格（同一份 heights）严丝合缝。
//  - 笔刷（抬升/下压/抹平/平滑）对两种地形都生效；随机生成只是填充手段
//    （旧版曾单列 random 模式，已并入 custom，旧地图由 ensureTerrain 就地迁移）。
//  - 「地表主题」（terrain.theme，见 docs/design/terrain-theme.md）：city/grass/
//    rock/desert 色表 + 坡地岩石/雪线顶点色规则，编辑器与运行时共用
//    world/terrainTheme.js 的同一实现。
// 「关闭总开关」= 清除 terrain 字段恢复全平世界；「重置地形」按钮 = 重置为初始平地（总开关保持勾选）。

import { RingGeometry, MeshBasicMaterial, Mesh, DoubleSide } from "three";
import {
  ensureTerrain, terrainHeightAt, generateRandomTerrain, blankTerrain,
  brushStamp, flattenPadsForObjects, buildRoadCorridors,
  TERRAIN_STEP_DEFAULT, ROAD_MAX_GRADE,
} from "../../world/terrain.js";
import { lonLatAt, clamp } from "./util.js";
import { TERRAIN_THEMES, TERRAIN_THEME_IDS, themeOf, snowDefaultsOf, SNOW_FROM_MIN, SNOW_FROM_MAX } from "../../world/terrainTheme.js";

// ArcGIS World Elevation（复刻 uav-inspection terrainSource.js，ArcGIS 优先）
const ARCGIS_TERRAIN_URL =
  "https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer";

// 高程 provider 会话缓存（编辑器多实例共用，provider 无状态）
let realProviderPromise = null;
async function getRealProvider(Cesium) {
  if (!realProviderPromise) {
    realProviderPromise = (async () => {
      try {
        return await Cesium.ArcGISTiledElevationTerrainProvider.fromUrl(ARCGIS_TERRAIN_URL);
      } catch (e) {
        console.warn("[terrain] ArcGIS 全球地形不可用，尝试 Cesium Ion：", e);
      }
      try {
        // Ion 需要 access token：配置 VITE_CESIUM_ION_TOKEN（.env.local）才启用；
        // 未配置/网络不通 → 整条回退链失败，走「真实高程不可用」提示（地形保持平面）
        const tok = import.meta.env.VITE_CESIUM_ION_TOKEN;
        if (tok) Cesium.Ion.defaultAccessToken = tok;
        return await Cesium.createWorldTerrainAsync({ requestVertexNormals: false, requestWaterMask: false });
      } catch (e) {
        console.warn("[terrain] Cesium Ion 地形不可用：", e);
        return null;
      }
    })();
  }
  return realProviderPromise;
}

// 编辑器底图 Cesium 球的地形挂载同步：real 模式挂真实 provider（影像贴地形），
// 其他模式恢复椭球平面（随机/自定义高度与平铺影像对齐）
export function syncEditorCesiumTerrain(ed) {
  const c = ed._cesium;
  if (!c || ed._disposed) return;
  const { Cesium, viewer } = c;
  const mode = ed.map.terrain && ed.map.terrain.mode;
  if (mode === "real") {
    getRealProvider(Cesium).then((p) => {
      if (ed._disposed || !ed._cesium || !p) return;
      if (!(viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider) &&
          viewer.terrainProvider === p) return;
      viewer.terrainProvider = p;
    });
  } else if (!(viewer.terrainProvider instanceof Cesium.EllipsoidTerrainProvider)) {
    viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
  }
}

// 真实高程采样：高度场每个网格点 → 经纬度（lonLatAt）→ sampleTerrainMostDetailed
export async function sampleRealTerrain(ed) {
  const t = ensureTerrain(ed.map);
  const Cesium = ed._cesium && ed._cesium.Cesium;
  if (!t) return false;
  if (!Cesium) { ed.status("底图尚未加载完成，请稍后再试"); return false; }
  const provider = await getRealProvider(Cesium);
  if (!provider) {
    ed.status("真实高程不可用：ArcGIS 与 Cesium Ion 数据源均无法访问（检查网络）");
    return false;
  }
  ed.status(`正在采样真实高程（${t.cols}×${t.rows} 格点 · 可能需要数十秒，请勿关闭编辑器）…`);
  const cartos = [];
  for (let j = 0; j < t.rows; j++) {
    for (let i = 0; i < t.cols; i++) {
      const { lat, lon } = lonLatAt(ed.map.origin, ed.map.area, t.x0 + i * t.step, t.z0 + j * t.step);
      cartos.push(Cesium.Cartographic.fromDegrees(lon, lat));
    }
  }
  try {
    await Cesium.sampleTerrainMostDetailed(provider, cartos);
  } catch (e) {
    console.warn("[terrain] 高程采样失败：", e);
    ed.status("高程采样失败：" + ((e && e.message) || e));
    return false;
  }
  let sum = 0;
  t.heights = cartos.map((c2) => {
    const h = Math.round((c2.height || 0) * 100) / 100;
    sum += h;
    return h;
  });
  t.originH = Math.round((sum / t.heights.length) * 10) / 10; // 平均高程（面板展示）
  return true;
}

/* ---------------- 面板 ---------------- */

const MODE_LABEL = { flat: "平面（无地形）", random: "随机地形", real: "真实地形", custom: "自定义地形" };

function statLine(ed) {
  const t = ensureTerrain(ed.map);
  if (!t) return `当前：<b>平面</b>（无地形高）`;
  let hMin = Infinity, hMax = -Infinity;
  for (const h of t.heights) { if (h < hMin) hMin = h; if (h > hMax) hMax = h; }
  return `当前：<b>${MODE_LABEL[t.mode] || t.mode}</b> · 格距 <b>${Math.round(t.step)}m</b> · 高差 <b>${Math.round(hMax - hMin)}m</b>` +
    (t.mode === "real" ? ` · 平均高程 <b>${t.originH}m</b>` : "") +
    (t.baseHeight != null ? ` · 基础高度 <b>${t.baseHeight}m</b>` : "");
}

export function terrainRenderPanel(ed) {
  const el = document.getElementById("e3-props");
  const t = ensureTerrain(ed.map);
  // 旧地图保存的 8% 是上一版削坡默认值，面板与算法一样按新贴地默认值展示
  const gradePct = Math.round((t && t.maxGrade > 0.2 ? t.maxGrade : ROAD_MAX_GRADE) * 100);
  const br = ed._terrainBrush;
  // 起伏上下非对称（山可很高、盆地不会太深）：旧地图只存 amplitude（对称）时上下各取该值
  const ampUp = t ? (t.ampUp ?? t.amplitude ?? 60) : 60;
  const ampDown = t ? (t.ampDown ?? Math.min(t.amplitude ?? 60, 1000)) : 60;
  const scale = t ? (t.scale ?? 500) : 500;
  const seed = t ? (t.seed ?? Math.floor(Math.random() * 99999)) : Math.floor(Math.random() * 99999);
  const rStep = t && t.mode === "real" ? Math.round(t.step) : 80;
  const baseH = t ? (t.baseHeight ?? 0) : 10;
  const snow = snowDefaultsOf(t); // 雪线生效值（地图字段优先，主题默认兜底）
  // 分组折叠状态（面板重绘后保留）；基础/笔刷不再分组，生成方式①②与通用默认收起
  const fold = (ed._terrainFold ??= { area: true, random: true, real: true, common: true });
  const grp = (key, title, body) =>
    `<div class="me-group${fold[key] ? " collapsed" : ""}" data-fold="${key}">
      <div class="me-group-title">${title}</div>
      <div class="me-group-body">${body}</div>
    </div>`;
  // 「地图范围」分组：与「范围」工具的属性面板共用编辑器的整图平移/重建链。
  // 改中心 = 整张地图（地形/影像落点/内容）一起搬；不能只改数字造成地形与范围错位。
  const a = ed._areaEnsure();
  const isPoly = Array.isArray(a.pts);
  const applyArea = (patch) => {
    const a0 = ed._areaEnsure();
    const dx = (patch.cx ?? a0.cx) - a0.cx, dz = (patch.cz ?? a0.cz) - a0.cz;
    if (dx || dz) ed._translateMap(dx, dz);
    Object.assign(a0, patch);
    if (dx || dz) ed._rebuildAreaMeshes(); // 底板/裙边按新范围锚点重建（世界坐标几何）
    ed._applyAreaToGroup();
    ed._bendArea();
    ed._rebuildAll();
    ed._pushUndo("地形面板调整范围");
    ed._renderProps(); // 刷新（工具仍为 terrain，回到本面板）
  };
  el.innerHTML = `
    <h4>地形编辑 <small>TERRAIN</small></h4>
    <div class="me-stat">${statLine(ed)}</div>
    <div class="me-ter-head">
      <label class="me-check" data-tip="地形总开关：关闭 = 全平世界（与没有地形编辑时一致）；打开后可用下面两种方式生成地形，生成结果都能继续笔刷雕刻。Ctrl+Z 撤销整笔。"><input type="checkbox" id="ep-ter-on" ${t ? "checked" : ""} /> 开启地形</label>
      <button class="me-del" id="ep-ter-clear" ${t ? "" : "hidden"}>重置地形</button>
    </div>
    <div id="ep-ter-body" ${t ? "" : "hidden"}>
      <label class="me-slider" data-tip="整体平移高度场（保留已雕刻起伏），可负 = 盆地。范围 -200~5000m：类比真实地理（青藏高原海拔 4000m+），基础高度大时从高处望远更有纵深，界外还会渐入远景山形（ADR-0013）。回车或失焦提交。">
        <div class="me-slider-head"><span>地形基础高度 m（负值 = 盆地，最高 5000）</span></div>
        <input id="ep-ter-base" type="number" min="-200" max="5000" step="10" value="${baseH}" style="width:100%;margin-top:8px" /></label>
      <label class="me-slider"><div class="me-slider-head"><span>地表主题</span></div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:8px">
          ${TERRAIN_THEME_IDS.map((k) =>
            `<button class="me-btn" data-theme="${k}" style="margin-top:0;${themeOf(t) === k ? "" : "opacity:.45"}">${TERRAIN_THEMES[k].label}</button>`).join("")}
        </div></label>
      <label class="me-check" data-tip="雪线开关：开启后高于雪线海拔的地表渐变为雪色（峰顶自动积雪）。默认跟随主题（草地/岩石有雪线，城市/沙漠无）；在这里可强制开/关任意主题。">
        <input type="checkbox" id="ep-ter-snow" ${snow.snowOn ? "checked" : ""} /> 有雪线</label>
      <div class="me-slider" data-tip="雪线海拔：真实雪线在海拔 3000m 以上（阿尔卑斯约 3000m、青藏高原约 5000m），低于此海拔的山不会积雪。">
        <div class="me-slider-head"><span>雪线海拔</span><b id="ep-ter-snowfrom-v">${snow.snowFrom}m</b></div>
        <input id="ep-ter-snowfrom" type="range" min="${SNOW_FROM_MIN}" max="${SNOW_FROM_MAX}" step="50" value="${snow.snowFrom}" style="--fill: ${((snow.snowFrom - SNOW_FROM_MIN) / (SNOW_FROM_MAX - SNOW_FROM_MIN)) * 100}%" ${snow.snowOn ? "" : "disabled"} /></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px">
        ${[["raise", "抬升"], ["lower", "下压"], ["flatten", "抹平"], ["smooth", "平滑"]].map(([v, label]) =>
          `<button class="me-btn" data-brush="${v}" style="margin-top:0;${br.mode === v ? "" : "opacity:.45"}">${label}</button>`).join("")}
      </div>
      <div class="me-slider"><div class="me-slider-head"><span>笔刷半径</span><b id="ep-ter-radius-v">${br.radius}m</b></div>
        <input id="ep-ter-radius" type="range" min="10" max="300" step="5" value="${br.radius}" style="--fill: ${((br.radius - 10) / 290) * 100}%" /></div>
      <div class="me-slider"><div class="me-slider-head"><span>笔刷强度</span><b id="ep-ter-strength-v">${br.strength}</b></div>
        <input id="ep-ter-strength" type="range" min="0.1" max="5" step="0.1" value="${br.strength}" style="--fill: ${((br.strength - 0.1) / 4.9) * 100}%" /></div>
      ${grp("random", "生成方式 ① 随机地形", `
        <div class="me-slider" data-tip="山峰起伏（相对基础高度向上）：山可以很高，最高 5000m（青藏高原量级）。建议主波长设为起伏的 5~20 倍，山形更自然。"><div class="me-slider-head"><span>山峰起伏（向上）</span><b id="ep-ter-ampup-v">${ampUp}m</b></div>
          <input id="ep-ter-ampup" type="range" min="0" max="5000" step="10" value="${ampUp}" style="--fill: ${(ampUp / 5000) * 100}%" /></div>
        <div class="me-slider" data-tip="盆地起伏（相对基础高度向下）：挖深谷/盆地用，最大 1000m。"><div class="me-slider-head"><span>盆地起伏（向下）</span><b id="ep-ter-ampdown-v">${ampDown}m</b></div>
          <input id="ep-ter-ampdown" type="range" min="0" max="1000" step="5" value="${ampDown}" style="--fill: ${(ampDown / 1000) * 100}%" /></div>
        <div class="me-slider" data-tip="主起伏波长：自然山体的波长/起伏比约 5~20，大幅起伏配大波长才像山；过短会被自动抬高保底（反针尖）。"><div class="me-slider-head"><span>起伏尺度（主波长）</span><b id="ep-ter-scale-v">${scale}m</b></div>
          <input id="ep-ter-scale" type="range" min="100" max="10000" step="100" value="${scale}" style="--fill: ${((scale - 100) / 9900) * 100}%" /></div>
        <label class="me-slider"><div class="me-slider-head"><span>随机种子</span></div>
          <input id="ep-ter-seed" type="number" min="0" max="999999" step="1" value="${seed}" style="width:100%;margin-top:8px" /></label>
        <button class="me-btn" id="ep-ter-regen">随机生成地形（覆盖当前雕刻）</button>`)}
      ${grp("real", "生成方式 ② 真实地形", `
        <label class="me-slider"><div class="me-slider-head"><span>采样格距（越大越快）</span></div>
          <select id="ep-ter-rstep" style="width:100%;margin-top:8px">
            ${[160, 80, 40, 20].map((s) => `<option value="${s}" ${rStep === s ? "selected" : ""}>${s}m</option>`).join("")}
          </select></label>
        <button class="me-btn" id="ep-ter-sample">采样真实高程（需卫星底图，自动打开）</button>`)}
      ${grp("area", "地图范围", `
        <div class="me-xy">
          <label class="me-tiprow">中心X(m)<span class="me-tip" data-tip="范围中心的东西向坐标（米，+X = 东）。改中心数值 = 整张地图（含地形/影像落点/内容）一起平移。">?</span><input id="ep-ar-cx" type="number" step="10" value="${a.cx}" /></label>
          <label class="me-tiprow">中心Z(m)<span class="me-tip" data-tip="范围中心的南北向坐标（米，+Z = 南）。改中心数值 = 整张地图一起平移。">?</span><input id="ep-ar-cz" type="number" step="10" value="${a.cz}" /></label>
        </div>
        ${isPoly ? `<p class="me-hint">多边形范围：中心可平移整体顶点，宽/深由描边决定</p>` : `
        <div class="me-xy">
          <label>宽 W(m)<input id="ep-ar-w" type="number" min="200" max="20000" step="100" value="${a.w}" /></label>
          <label>深 D(m)<input id="ep-ar-d" type="number" min="200" max="20000" step="100" value="${a.d}" /></label>
        </div>`}
        <p class="me-hint">改中心 = 整张地图一起平移；旋转暂禁用（地理对齐请用中心坐标 / 描边对准底图，见 ADR-0014）</p>`)}
      ${grp("common", "通用", `
        <label class="me-slider me-tiprow" data-tip="建筑地基自动平整：在地形上放置/拖动建筑时，自动把「建筑占地面积 × 系数」的范围压平到角点平均高度（外圈平滑过渡），坡地建筑不陷入地面。1.0 = 不扩大（贴合建筑轮廓），1.4 = 场地面积为建筑占地 1.4 倍。">
          <div class="me-slider-head"><span>地基平整系数</span><b id="ep-ter-pad-v">${t ? (t.padFactor ?? 1.4) : 1.4}</b></div>
          <input id="ep-ter-pad" type="range" min="1" max="2" step="0.1" value="${t ? (t.padFactor ?? 1.4) : 1.4}" style="--fill: ${((t ? (t.padFactor ?? 1.4) : 1.4) - 1) / 1 * 100}%" />
        </label>
        <label class="me-slider me-tiprow" data-tip="道路路基自动平整：道路占用的地面被整平为横向水平、纵向平顺的路基（与建筑地基同一机制），路基沿原地势起伏但坡度不超过此值，路肩平滑接回地形。描边路 / 拼接路块 / 程序化路网都生效。">
          <div class="me-slider-head"><span>道路最大纵坡</span><b id="ep-ter-grade-v">${gradePct}%</b></div>
          <input id="ep-ter-grade" type="range" min="5" max="50" step="1" value="${gradePct}" style="--fill: ${(gradePct - 5) / 45 * 100}%" />
        </label>`)}
      <p class="me-hint">地形高度场与游戏世界共用：道路路基自动平整并随地势起伏，建筑/道路/树木/玩家/车辆都会自动贴合地形表面。放好地形再摆物件效果最佳；已有物件在重新保存/进游戏时自动重新落地。</p>
    </div>`;

  el.querySelector("#ep-ter-on").addEventListener("change", (e) => {
    toggleTerrain(ed, e.target.checked);
  });

  // 分组标题点击折叠/展开
  el.querySelectorAll(".me-group-title").forEach((h) => {
    h.addEventListener("click", () => {
      const g = h.parentElement;
      g.classList.toggle("collapsed");
      fold[g.dataset.fold] = g.classList.contains("collapsed");
    });
  });

  // 「地图范围」分组绑定：中心走整图平移，宽/深走范围重建（与范围属性面板同一套 apply）
  const areaNum = (id) => parseFloat(el.querySelector(id).value) || 0;
  el.querySelector("#ep-ar-cx").addEventListener("change", () => applyArea({ cx: areaNum("#ep-ar-cx") }));
  el.querySelector("#ep-ar-cz").addEventListener("change", () => applyArea({ cz: areaNum("#ep-ar-cz") }));
  if (!isPoly) {
    el.querySelector("#ep-ar-w").addEventListener("change", () => applyArea({ w: clamp(areaNum("#ep-ar-w"), 200, 20000) }));
    el.querySelector("#ep-ar-d").addEventListener("change", () => applyArea({ d: clamp(areaNum("#ep-ar-d"), 200, 20000) }));
  }

  // 地表主题单选：换 theme → 重建地形板（新贴图 + 顶点着色随新主题色表）
  el.querySelectorAll("[data-theme]").forEach((b) => {
    b.addEventListener("click", () => {
      const t0 = ensureTerrain(ed.map);
      if (!t0 || themeOf(t0) === b.dataset.theme) return;
      t0.theme = b.dataset.theme;
      ed._terrainTheme = b.dataset.theme; // 会话记忆：关闭再开启地形时沿用
      ed._pushUndo("地表主题");
      rebuildTerrain(ed);
      terrainRenderPanel(ed);
      ed.status(`地表主题 → ${TERRAIN_THEMES[b.dataset.theme].label}（坡地自动岩石，高海拔自动积雪）`);
    });
  });

  // 雪线开关/海拔：只改顶点色，不需要重建几何 —— _bendArea 重跑着色即可。
  // change 事件提交（拖动中不重算），写回 terrain 便于撤销/保存
  el.querySelector("#ep-ter-snow").addEventListener("change", (e) => {
    const t0 = ensureTerrain(ed.map);
    if (!t0) return;
    t0.snowOn = e.target.checked;
    ed._pushUndo("雪线开关");
    ed._bendArea();
    ed._dirty = true;
    terrainRenderPanel(ed);
    ed.status(t0.snowOn ? `雪线已开启：海拔 > ${snowDefaultsOf(t0).snowFrom}m 的地表渐变为雪色` : "雪线已关闭");
  });
  el.querySelector("#ep-ter-snowfrom").addEventListener("change", (e) => {
    const t0 = ensureTerrain(ed.map);
    if (!t0) return;
    // 雪线海拔 3000~8000m（真实雪线量级，见 terrainTheme.js SNOW_FROM_*）
    const v = Math.max(SNOW_FROM_MIN, Math.min(SNOW_FROM_MAX, Math.round(+e.target.value || SNOW_FROM_MIN)));
    e.target.value = v;
    e.target.style.setProperty("--fill", ((v - SNOW_FROM_MIN) / (SNOW_FROM_MAX - SNOW_FROM_MIN)) * 100 + "%");
    t0.snowFrom = v;
    ed._pushUndo("雪线海拔");
    ed._bendArea();
    ed._dirty = true;
    const lab = el.querySelector("#ep-ter-snowfrom-v");
    if (lab) lab.textContent = v + "m";
    ed.status(`雪线海拔 → ${v}m`);
  });

  const bindRange = (id, fn, fmt = (v) => v) => {
    const inp = el.querySelector(id);
    inp.addEventListener("input", () => {
      const v = +inp.value;
      fn(v);
      const lab = el.querySelector(id + "-v");
      if (lab) lab.textContent = fmt(v);
      inp.style.setProperty("--fill", ((v - +inp.min) / (+inp.max - +inp.min)) * 100 + "%");
    });
  };

  // 随机参数（调参即重生成，参数写回 terrain 便于撤销/保存）
  bindRange("#ep-ter-ampup", (v) => regenRandom(ed, { ampUp: v }), (v) => v + "m");
  bindRange("#ep-ter-ampdown", (v) => regenRandom(ed, { ampDown: v }), (v) => v + "m");
  bindRange("#ep-ter-scale", (v) => regenRandom(ed, { scale: v }), (v) => v + "m");
  el.querySelector("#ep-ter-seed").addEventListener("change", (e) => {
    regenRandom(ed, { seed: Math.abs(+e.target.value | 0) || 1 });
  });
  el.querySelector("#ep-ter-regen").addEventListener("click", () => {
    regenRandom(ed, { seed: Math.floor(Math.random() * 999999) + 1 });
    ed.status(`已按新种子 ${ed.map.terrain.seed} 随机生成自定义地形 · 可继续笔刷雕刻`);
  });

  // 真实高程
  el.querySelector("#ep-ter-rstep").addEventListener("change", (e) => {
    ed._terrainRealStep = +e.target.value || 80;
  });
  el.querySelector("#ep-ter-sample").addEventListener("click", async () => {
    if (!ed._cesiumOn) ed._toggleBasemap(); // 真实地形需要卫星底图：自动打开
    const t = ensureTerrain(ed.map) || blankTerrain(ed.map, "real", ed._terrainRealStep);
    ed.map.terrain = t;
    t.mode = "real";
    syncEditorCesiumTerrain(ed);
    const ok = await sampleRealTerrain(ed);
    if (ok) {
      applyObjectPads(ed); // 已放置建筑的地基压平
      rebuildTerrain(ed);
      ed._pushUndo("采样真实地形");
      ed._fitViewIfNeeded && ed._fitViewIfNeeded(); // 高原真实高程（如青藏）默认机位会沉进地形
      ed.status(`真实高程采样完成：平均高程 ${t.originH}m · 格距 ${Math.round(t.step)}m · 已挂载到底图地形`);
    }
    terrainRenderPanel(ed);
  });

  // 笔刷：点选切换；再点已选中的按钮 = 取消选择（取消后按住左键不再雕刻）
  el.querySelectorAll("[data-brush]").forEach((b) => {
    b.addEventListener("click", () => {
      ed._terrainBrush.mode = ed._terrainBrush.mode === b.dataset.brush ? null : b.dataset.brush;
      terrainRenderPanel(ed);
      if (!ed._terrainBrush.mode) ed.status("已取消笔刷选择：重新点选 抬升/下压/抹平/平滑 后才能雕刻（Esc 同效）");
    });
  });
  bindRange("#ep-ter-radius", (v) => { ed._terrainBrush.radius = v; if (ed._terrainCursor) ed._terrainCursor.scale.set(v, v, 1); }, (v) => v + "m");
  bindRange("#ep-ter-strength", (v) => { ed._terrainBrush.strength = v; });

  // 地形基础高度：整体平移高度场（保留已雕刻的起伏），可负 = 盆地；
  // 数字输入 change 事件提交（回车/失焦），范围钳制 -200~5000m（青藏高原量级）
  el.querySelector("#ep-ter-base").addEventListener("change", (e) => {
    const t0 = ensureTerrain(ed.map);
    if (!t0) return;
    const nb = Math.max(-200, Math.min(5000, Math.round(+e.target.value || 0)));
    e.target.value = nb;
    const delta = nb - (t0.baseHeight ?? 0);
    if (!delta) return;
    for (let i = 0; i < t0.heights.length; i++) t0.heights[i] = Math.round((t0.heights[i] + delta) * 100) / 100;
    t0.baseHeight = nb;
    ed._terrainBase = nb; // 之后重新勾选自定义时沿用
    t0.pads = null; // pad 存绝对高度，已随平移失效（applyObjectPads 全量重算）
    applyObjectPads(ed);
    rebuildTerrain(ed);
    ed._pushUndo("调整地形基础高度");
    ed._fitViewIfNeeded && ed._fitViewIfNeeded(); // 抬高后默认机位会沉进地形 → 自动拉起
    ed.status(`地形基础高度 → ${nb}m（整体平移，已保留雕刻起伏；负值 = 盆地）`);
  });

  // 地基平整系数：调参即对全部建筑重新压平（新地形上重新落地）
  bindRange("#ep-ter-pad", (v) => {
    const t0 = ensureTerrain(ed.map);
    if (!t0) return;
    t0.padFactor = v;
    applyObjectPads(ed);
    rebuildTerrain(ed);
    ed._dirty = true;
  });

  // 道路最大纵坡：调参即重算所有走廊的设计高程剖面并重建场景
  bindRange("#ep-ter-grade", (v) => {
    const t0 = ensureTerrain(ed.map);
    if (!t0) return;
    t0.maxGrade = v / 100;
    buildRoadCorridors(ed.map);
    rebuildTerrain(ed);
    ed._dirty = true;
  }, (v) => v + "%");

  el.querySelector("#ep-ter-clear").addEventListener("click", () => {
    // 重置为开启地形时的初始平地，保持「开启地形」勾选（不是关闭地形）
    const base = ed._terrainBase ?? 10;
    const nt = blankTerrain(ed.map, "custom", ed._terrainRealStep || TERRAIN_STEP_DEFAULT, base);
    if (ed._terrainTheme) nt.theme = ed._terrainTheme;
    ed.map.terrain = nt;
    ed._terrainStroke = null;
    syncEditorCesiumTerrain(ed);
    rebuildTerrain(ed);
    // 把 target/相机从旧高程整体平移到新地面：否则停在高原高度时滚轮拉近贴不到地表标记
    ed._rebaseViewToTerrain && ed._rebaseViewToTerrain();
    ed._pushUndo("重置地形");
    terrainRenderPanel(ed);
    ed.status(`已重置地形：恢复初始平地（基础高度 ${base}m），开启地形保持勾选`);
  });
}

// 建筑地基场地平整：把所有描边建筑「占地面积 × padFactor」的范围压平到
// 角点平均高度（坡地建筑不再陷入地面）。地形存在时才有意义。
export function applyObjectPads(ed) {
  const t = ensureTerrain(ed.map);
  if (!t) return false;
  return flattenPadsForObjects(ed.map, (ed.map.objects || []).filter((o) => o.type === "building"), t.padFactor ?? 1.4);
}

function regenRandom(ed, patch) {
  const t = ensureTerrain(ed.map);
  const seed = patch.seed ?? (t && t.seed != null ? t.seed : 1);
  // 起伏上下非对称：旧地图只存 amplitude（对称）时向下取值钳到 1000
  const ampUp = patch.ampUp ?? (t ? (t.ampUp ?? t.amplitude ?? 60) : 60);
  const ampDown = patch.ampDown ?? (t ? (t.ampDown ?? Math.min(t.amplitude ?? 60, 1000)) : 60);
  const scale = patch.scale ?? (t && t.scale != null ? t.scale : 500);
  const base = patch.base ?? (t && t.baseHeight != null ? t.baseHeight : (ed._terrainBase ?? 10));
  ed.map.terrain = generateRandomTerrain(ed.map, { seed, ampUp, ampDown, scale, base });
  if (t && t.padFactor) ed.map.terrain.padFactor = t.padFactor; // 平整系数跨重生成保留
  if (t && t.maxGrade) ed.map.terrain.maxGrade = t.maxGrade;    // 道路最大纵坡跨重生成保留
  if (t && t.theme) ed.map.terrain.theme = t.theme;                     // 地表主题跨重生成保留
  if (t && t.snowOn != null) ed.map.terrain.snowOn = t.snowOn;          // 雪线开关跨重生成保留
  if (t && Number.isFinite(t.snowFrom)) ed.map.terrain.snowFrom = t.snowFrom; // 雪线海拔跨重生成保留
  applyObjectPads(ed); // 已放置建筑的地基重新压平（贴新地形）
  syncEditorCesiumTerrain(ed);
  rebuildTerrain(ed);
  ed._dirty = true;
  ed._fitViewIfNeeded && ed._fitViewIfNeeded(); // 大基础高度时默认机位沉进地形 → 自动拉起
  const stat = document.querySelector("#e3-props .me-stat");
  if (stat) stat.innerHTML = statLine(ed); // 参数拖动实时刷新高差统计（不整面板重绘，避免打断滑杆）
}

// 地形总开关：开启 = 无地形时先给一张基础平地（可再随机生成/采样/雕刻）；
// 关闭 = 清除 terrain 字段恢复全平世界（与「重置地形」按钮不同：那只是重置为初始平地，开关保持勾选）
function toggleTerrain(ed, on) {
  if (!on) {
    ed.map.terrain = null;
    ed._terrainStroke = null;
    syncEditorCesiumTerrain(ed);
    rebuildTerrain(ed);
    ed._pushUndo("关闭地形");
    terrainRenderPanel(ed);
    ed.status("已关闭地形：地图恢复平面");
    return;
  }
  if (!ensureTerrain(ed.map)) {
    // 基础高度默认 10m 平地（可负 = 盆地），直接笔刷雕刻或换生成方式铺起伏；
    // 地表主题沿用本会话上次选择（ed._terrainTheme），否则跟随默认
    ed.map.terrain = blankTerrain(ed.map, "custom", ed._terrainRealStep || TERRAIN_STEP_DEFAULT, ed._terrainBase ?? 10);
    if (ed._terrainTheme) ed.map.terrain.theme = ed._terrainTheme;
    syncEditorCesiumTerrain(ed);
    rebuildTerrain(ed);
    ed._fitViewIfNeeded && ed._fitViewIfNeeded(); // 会话记忆的大基础高度 → 机位可能沉进地形
  }
  ed._pushUndo("开启地形");
  terrainRenderPanel(ed);
  ed.status("已开启地形：基础平地可直接笔刷雕刻，或用「随机生成 / 采样真实高程」铺出起伏");
}

/* ---------------- 笔刷交互 ---------------- */

// 地形工具初始化：笔刷状态 + 光标环 + 笔画收尾（编辑器 open() 时调用一次）
export function initTerrainTool(ed) {
  ed._terrainBrush = { mode: null, radius: 60, strength: 1.2 }; // 进工具默认不选笔刷（点选 抬升/下压/抹平/平滑 后才能雕刻）
  ed._terrainRealStep = 80;
  ed._terrainBase = 10; // 自定义地形默认基础高度（米，可负 = 盆地）
  ed._terrainStroke = null;
  const cursor = new Mesh(
    new RingGeometry(0.94, 1, 48),
    new MeshBasicMaterial({ color: 0xffd76a, transparent: true, opacity: 0.9, side: DoubleSide, depthWrite: false }),
  );
  cursor.rotation.x = -Math.PI / 2;
  cursor.visible = false;
  cursor.renderOrder = 20;
  ed._three.scene.add(cursor);
  ed._terrainCursor = cursor;

  const finishStroke = () => {
    if (!ed._terrainStroke) return;
    ed._terrainStroke = null;
    ed._three.orbit.enabled = true; // 恢复视角控制（笔画期间被禁用防左键冲突）
    applyObjectPads(ed); // 雕刻后重压建筑地基（坡地建筑不陷入）
    rebuildTerrain(ed); // 笔画结束：道路/河流/建筑等全部按新高度重新落地
    ed._pushUndo("地形笔刷");
    if (ed.tool === "terrain" && !ed.sel) terrainRenderPanel(ed);
  };
  ed._three.canvas.addEventListener("pointerup", finishStroke);
  ed._three.canvas.addEventListener("pointercancel", finishStroke);
}

// 工具失焦时收尾 + 藏光标（mapEditor3d._setTool 调用）
export function terrainLeave(ed) {
  if (ed._terrainStroke) {
    ed._terrainStroke = null;
    ed._three.orbit.enabled = true;
    rebuildTerrain(ed);
    ed._pushUndo("地形笔刷");
  }
  if (ed._terrainCursor) ed._terrainCursor.visible = false;
}

function updateStrokeVisuals(ed, pt) {
  // 轻量实时反馈：底板/网格顶点按新高度重弯 + 笔刷附近物件跟随（整场重建留到笔画结束）
  ed._bendArea();
  const r = ed._terrainBrush.radius + 60;
  for (const w of ed._wrappers.values()) {
    const d = w.data;
    if (!d || !d.pos) continue;
    if (Math.abs(d.pos[0] - pt.x) > r || Math.abs(d.pos[1] - pt.z) > r) continue;
    w.root.position.y = -ed._curveOffset(d.pos[0], d.pos[1]) + terrainHeightAt(ed.map, d.pos[0], d.pos[1]);
  }
}

// 地形工具的按下/移动（mapEditor3d._onDown / _onMove 转发；pt 已绕过网格吸附）
export function terrainOnDown(ed, e, pt) {
  const t = ensureTerrain(ed.map);
  if (!t || e.button !== 0 || !pt || !ed._terrainBrush.mode) return; // 未开启地形/未选笔刷不雕刻
  ed._terrainStroke = { last: { x: pt.x, z: pt.z } };
  ed._three.orbit.enabled = false; // 笔画期间禁用视角旋转（左键拖动留给笔刷）
  brushStamp(ed.map, null, ed._terrainStroke.last, ed._terrainBrush);
  updateStrokeVisuals(ed, pt);
}

export function terrainOnMove(ed, e, pt) {
  const cursor = ed._terrainCursor;
  const t = ensureTerrain(ed.map);
  const painting = ed._terrainStroke && t;
  if (cursor) {
    const show = ed.tool === "terrain" && t && ed._terrainBrush.mode; // 未选笔刷不显示光标环
    cursor.visible = !!show && !!pt;
    if (show && pt) {
      const r = Math.max(3, ed._terrainBrush.radius);
      cursor.scale.set(r, r, 1);
      cursor.position.set(pt.x, -ed._curveOffset(pt.x, pt.z) + terrainHeightAt(ed.map, pt.x, pt.z) + 0.4, pt.z);
    }
  }
  if (!painting || !pt) return;
  brushStamp(ed.map, ed._terrainStroke.last, pt, ed._terrainBrush);
  ed._terrainStroke.last = { x: pt.x, z: pt.z };
  updateStrokeVisuals(ed, pt);
}

// 地形变化后的编辑器场景刷新：底板重建（材质/分段随有无地形切换）+ 重弯 +
// 全部内容重建（贴新地形）
export function rebuildTerrain(ed) {
  buildRoadCorridors(ed.map); // 地形变了 → 道路设计纵坡按新高度场重算
  ed._rebuildAreaMeshes();
  ed._applyAreaToGroup();
  ed._bendArea();
  ed._rebuildAll();
  ed._dirty = true;
}
