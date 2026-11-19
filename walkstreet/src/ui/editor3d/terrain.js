// 「地形编辑」工具（3D 编辑器左侧工具栏入口）：右侧模式面板 + 自定义笔刷 +
// 真实高程采样 + Cesium 地形挂载。高度场本体在 world/terrain.js（与运行时共用）。
//
// 三种地形高模式（右侧面板单选）：
//  1. 随机地形高度 —— 种子化分形噪声一键生成（幅度/起伏尺度/种子可调）；
//  2. 使用真实地形高 —— 需打开卫星底图：Cesium 高程源网格采样，数据源复刻
//     uav-inspection 的回退链（ArcGIS 全球地形优先 → Cesium Ion 兜底）；
//     采样成功后把同一 provider 挂到编辑器底图 Cesium 球上，卫星影像贴合真实
//     地形起伏，与 three.js 侧地形网格（同一份 heights）严丝合缝；
//  3. 自定义地形高 —— 笔刷在高度场上雕刻（抬升/下压/抹平/平滑）。
// 切到「平面」= 清除 terrain 字段，恢复全平世界。

import { RingGeometry, MeshBasicMaterial, Mesh, DoubleSide } from "three";
import {
  ensureTerrain, terrainHeightAt, generateRandomTerrain, blankTerrain,
  brushStamp, flattenPadsForObjects, buildRoadCorridors,
  TERRAIN_STEP_DEFAULT, ROAD_MAX_GRADE,
} from "../../world/terrain.js";
import { lonLatAt } from "./util.js";

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

const MODE_LABEL = { flat: "平面（无地形）", random: "随机地形高度", real: "真实地形高", custom: "自定义地形高" };

function statLine(ed) {
  const t = ensureTerrain(ed.map);
  if (!t) return `当前：<b>平面</b>（无地形高）`;
  let hMin = Infinity, hMax = -Infinity;
  for (const h of t.heights) { if (h < hMin) hMin = h; if (h > hMax) hMax = h; }
  return `当前：<b>${MODE_LABEL[t.mode] || t.mode}</b> · 格距 <b>${Math.round(t.step)}m</b> · 高差 <b>${Math.round(hMax - hMin)}m</b>` +
    (t.mode === "real" ? ` · 平均高程 <b>${t.originH}m</b>` : "");
}

export function terrainRenderPanel(ed) {
  const el = document.getElementById("e3-props");
  const t = ensureTerrain(ed.map);
  // 旧地图保存的 8% 是上一版削坡默认值，面板与算法一样按新贴地默认值展示
  const gradePct = Math.round((t && t.maxGrade > 0.2 ? t.maxGrade : ROAD_MAX_GRADE) * 100);
  const mode = t ? t.mode : "flat";
  const br = ed._terrainBrush;
  const amp = t && t.mode === "random" ? t.amplitude : 60;
  const scale = t && t.mode === "random" ? t.scale : 500;
  const seed = t && t.mode === "random" ? t.seed : Math.floor(Math.random() * 99999);
  const rStep = t && t.mode === "real" ? Math.round(t.step) : 80;
  el.innerHTML = `
    <h4>地形编辑 <small>TERRAIN</small></h4>
    <div class="me-stat">${statLine(ed)}</div>
    <label class="me-check" data-tip="一键生成分形随机地形（山丘/谷地）。生成的地形与世界边缘平地平滑衔接，已放置的建筑/树木/道路会自动落到地形表面。"><input type="radio" name="ep-ter-mode" value="random" ${mode === "random" ? "checked" : ""} /> 随机地形高度</label>
    <div id="ep-ter-random" ${mode === "random" ? "" : "hidden"}>
      <div class="me-slider"><div class="me-slider-head"><span>起伏幅度</span><b id="ep-ter-amp-v">${amp}m</b></div>
        <input id="ep-ter-amp" type="range" min="5" max="150" step="5" value="${amp}" style="--fill: ${(amp / 150) * 100}%" /></div>
      <div class="me-slider"><div class="me-slider-head"><span>起伏尺度（主波长）</span><b id="ep-ter-scale-v">${scale}m</b></div>
        <input id="ep-ter-scale" type="range" min="150" max="2000" step="50" value="${scale}" style="--fill: ${((scale - 150) / 1850) * 100}%" /></div>
      <label class="me-slider"><div class="me-slider-head"><span>随机种子</span></div>
        <input id="ep-ter-seed" type="number" min="0" max="999999" step="1" value="${seed}" style="width:100%;margin-top:8px" /></label>
      <button class="me-btn" id="ep-ter-regen">重新生成随机地形</button>
    </div>
    <label class="me-check" data-tip="按地图范围网格采样真实世界高程。数据源：ArcGIS 全球地形优先（免 key），失败自动回退 Cesium Ion。需要先打开卫星底图（自动帮你打开）；采样成功后底图影像会贴合真实地形起伏。"><input type="radio" name="ep-ter-mode" value="real" ${mode === "real" ? "checked" : ""} /> 使用真实地形高（需打开卫星底图）</label>
    <div id="ep-ter-real" ${mode === "real" ? "" : "hidden"}>
      <label class="me-slider"><div class="me-slider-head"><span>采样格距（越大越快）</span></div>
        <select id="ep-ter-rstep" style="width:100%;margin-top:8px">
          ${[160, 80, 40, 20].map((s) => `<option value="${s}" ${rStep === s ? "selected" : ""}>${s}m</option>`).join("")}
        </select></label>
      <button class="me-btn" id="ep-ter-sample">采样真实高程</button>
    </div>
    <label class="me-check" data-tip="按住左键在地图上拖动雕刻地形：抬升/下压堆山挖谷，抹平压平场地，平滑消除毛刺。半径/强度在下方调整；Ctrl+Z 撤销整笔。"><input type="radio" name="ep-ter-mode" value="custom" ${mode === "custom" ? "checked" : ""} /> 自定义地形高（笔刷雕刻）</label>
    <div id="ep-ter-custom" ${mode === "custom" ? "" : "hidden"}>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px">
        ${[["raise", "抬升"], ["lower", "下压"], ["flatten", "抹平"], ["smooth", "平滑"]].map(([v, label]) =>
          `<button class="me-btn" data-brush="${v}" style="margin-top:0;${br.mode === v ? "" : "opacity:.45"}">${label}</button>`).join("")}
      </div>
      <div class="me-slider"><div class="me-slider-head"><span>笔刷半径</span><b id="ep-ter-radius-v">${br.radius}m</b></div>
        <input id="ep-ter-radius" type="range" min="10" max="300" step="5" value="${br.radius}" style="--fill: ${((br.radius - 10) / 290) * 100}%" /></div>
      <div class="me-slider"><div class="me-slider-head"><span>笔刷强度</span><b id="ep-ter-strength-v">${br.strength}</b></div>
        <input id="ep-ter-strength" type="range" min="0.1" max="5" step="0.1" value="${br.strength}" style="--fill: ${((br.strength - 0.1) / 4.9) * 100}%" /></div>
    </div>
    <label class="me-slider me-tiprow" data-tip="建筑地基自动平整：在地形上放置/拖动建筑时，自动把「建筑占地面积 × 系数」的范围压平到角点平均高度（外圈平滑过渡），坡地建筑不陷入地面。1.0 = 不扩大（贴合建筑轮廓），1.4 = 场地面积为建筑占地 1.4 倍。">
      <div class="me-slider-head"><span>地基平整系数</span><b id="ep-ter-pad-v">${t ? (t.padFactor ?? 1.4) : 1.4}</b></div>
      <input id="ep-ter-pad" type="range" min="1" max="2" step="0.1" value="${t ? (t.padFactor ?? 1.4) : 1.4}" style="--fill: ${((t ? (t.padFactor ?? 1.4) : 1.4) - 1) / 1 * 100}%" ${t ? "" : "disabled"} />
    </label>
    <label class="me-slider me-tiprow" data-tip="道路路基自动平整：道路占用的地面被整平为横向水平、纵向平顺的路基（与建筑地基同一机制），路基沿原地势起伏但坡度不超过此值，路肩平滑接回地形。描边路 / 拼接路块 / 程序化路网都生效。">
      <div class="me-slider-head"><span>道路最大纵坡</span><b id="ep-ter-grade-v">${gradePct}%</b></div>
      <input id="ep-ter-grade" type="range" min="5" max="50" step="1" value="${gradePct}" style="--fill: ${(gradePct - 5) / 45 * 100}%" ${t ? "" : "disabled"} />
    </label>
    <button class="me-del" id="ep-ter-clear">清除地形（恢复平面）</button>
    <p class="me-hint">地形高度场与游戏世界共用：道路路基自动平整并随地势起伏，建筑/道路/树木/玩家/车辆都会自动贴合地形表面。放好地形再摆物件效果最佳；已有物件在重新保存/进游戏时自动重新落地。</p>`;

  el.querySelectorAll('input[name="ep-ter-mode"]').forEach((r) => {
    r.addEventListener("change", () => setTerrainMode(ed, r.value));
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
  bindRange("#ep-ter-amp", (v) => regenRandom(ed, { amplitude: v }), (v) => v + "m");
  bindRange("#ep-ter-scale", (v) => regenRandom(ed, { scale: v }), (v) => v + "m");
  el.querySelector("#ep-ter-seed").addEventListener("change", (e) => {
    regenRandom(ed, { seed: Math.abs(+e.target.value | 0) || 1 });
  });
  el.querySelector("#ep-ter-regen").addEventListener("click", () => {
    regenRandom(ed, { seed: Math.floor(Math.random() * 999999) + 1 });
    ed.status(`已按新种子 ${ed.map.terrain.seed} 重新生成随机地形`);
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
      ed.status(`真实高程采样完成：平均高程 ${t.originH}m · 格距 ${Math.round(t.step)}m · 已挂载到底图地形`);
    }
    terrainRenderPanel(ed);
  });

  // 笔刷
  el.querySelectorAll("[data-brush]").forEach((b) => {
    b.addEventListener("click", () => {
      ed._terrainBrush.mode = b.dataset.brush;
      terrainRenderPanel(ed);
    });
  });
  bindRange("#ep-ter-radius", (v) => { ed._terrainBrush.radius = v; if (ed._terrainCursor) ed._terrainCursor.scale.set(v, v, 1); }, (v) => v + "m");
  bindRange("#ep-ter-strength", (v) => { ed._terrainBrush.strength = v; });

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
    ed.map.terrain = null;
    ed._terrainStroke = null;
    syncEditorCesiumTerrain(ed);
    rebuildTerrain(ed);
    ed._pushUndo("清除地形");
    terrainRenderPanel(ed);
    ed.status("已清除地形：地图恢复平面");
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
  const seed = patch.seed ?? (t && t.mode === "random" ? t.seed : 1);
  const amplitude = patch.amplitude ?? (t && t.mode === "random" ? t.amplitude : 60);
  const scale = patch.scale ?? (t && t.mode === "random" ? t.scale : 500);
  ed.map.terrain = generateRandomTerrain(ed.map, { seed, amplitude, scale });
  if (t && t.padFactor) ed.map.terrain.padFactor = t.padFactor; // 平整系数跨重生成保留
  applyObjectPads(ed); // 已放置建筑的地基重新压平（贴新地形）
  syncEditorCesiumTerrain(ed);
  rebuildTerrain(ed);
  ed._dirty = true;
  const stat = document.querySelector("#e3-props .me-stat");
  if (stat) stat.innerHTML = statLine(ed); // 参数拖动实时刷新高差统计（不整面板重绘，避免打断滑杆）
}

function setTerrainMode(ed, mode) {
  if (mode === "flat") {
    ed.map.terrain = null;
    syncEditorCesiumTerrain(ed);
    rebuildTerrain(ed);
    ed._pushUndo("恢复平面地形");
    terrainRenderPanel(ed);
    return;
  }
  if (mode === "random") {
    const t = ensureTerrain(ed.map);
    regenRandom(ed, t && t.mode === "random" ? {} : { seed: Math.floor(Math.random() * 999999) + 1 });
    ed._pushUndo("随机地形");
    terrainRenderPanel(ed);
    ed.status("随机地形已生成 · 右侧可调幅度/尺度/种子 · 建筑道路等保存后自动贴地");
    return;
  }
  if (mode === "custom") {
    const prev = ensureTerrain(ed.map);
    if (!prev || prev.mode !== "custom") {
      ed.map.terrain = blankTerrain(ed.map, "custom", ed._terrainRealStep || TERRAIN_STEP_DEFAULT);
      syncEditorCesiumTerrain(ed);
      rebuildTerrain(ed);
    }
    ed._pushUndo("自定义地形");
    terrainRenderPanel(ed);
    ed.status("自定义地形：按住左键拖动雕刻（抬升/下压/抹平/平滑，右侧可调半径与强度）");
    return;
  }
  if (mode === "real") {
    if (!ed._cesiumOn) ed._toggleBasemap(); // 真实地形需要卫星底图：自动打开
    const prev = ensureTerrain(ed.map);
    if (!prev || prev.mode !== "real") {
      ed.map.terrain = blankTerrain(ed.map, "real", ed._terrainRealStep || TERRAIN_STEP_DEFAULT);
      syncEditorCesiumTerrain(ed);
      rebuildTerrain(ed);
    }
    ed._pushUndo("切换真实地形");
    terrainRenderPanel(ed);
    ed.status("真实地形：点击「采样真实高程」获取世界真实起伏（ArcGIS 优先 → Cesium Ion 兜底）");
  }
}

/* ---------------- 笔刷交互 ---------------- */

// 地形工具初始化：笔刷状态 + 光标环 + 笔画收尾（编辑器 open() 时调用一次）
export function initTerrainTool(ed) {
  ed._terrainBrush = { mode: "raise", radius: 60, strength: 1.2 };
  ed._terrainRealStep = 80;
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
  if (!t || t.mode !== "custom" || e.button !== 0 || !pt) return;
  ed._terrainStroke = { last: { x: pt.x, z: pt.z } };
  ed._three.orbit.enabled = false; // 笔画期间禁用视角旋转（左键拖动留给笔刷）
  brushStamp(ed.map, null, ed._terrainStroke.last, ed._terrainBrush);
  updateStrokeVisuals(ed, pt);
}

export function terrainOnMove(ed, e, pt) {
  const cursor = ed._terrainCursor;
  const t = ensureTerrain(ed.map);
  const painting = ed._terrainStroke && t && t.mode === "custom";
  if (cursor) {
    const show = ed.tool === "terrain" && t && t.mode === "custom";
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
