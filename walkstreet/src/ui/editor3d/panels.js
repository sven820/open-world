// 3D 编辑器的两个弹出面板：图层控制 + 设置（图源 / 地图位置搜索 / 测量入口）。
// 全部以编辑器实例（ed）为第一参数；面板定位、开关、外部点击关闭在此统一处理。

import {
  basemapSources, getBasemapSource, setBasemapSource,
} from "../../config/cesium.js";
import { searchPlaces } from "../../config/placeSearch.js";
import { fmtDist } from "./util.js";

/* ================ 图层控制 ================ */
// 底图影像只保留注记层开关（图源选择在设置面板，影像整体开关在顶栏按钮），
// 场景内容层按分组节点与 wrapper kind 开关；显隐状态持久化在 localStorage。

export function layerDefs(ed) {
  // 图源面板（设置 → 地图图源）已接管底图选择；中文注记层常显，不再提供显隐开关；
  // 卫星影像/深色矢量不再单列（影像整体开关在顶栏「卫星底图」按钮）
  return [
    {
      title: "场景内容",
      items: [
        { key: "plate", label: "范围底板", hint: "地图范围的深色地面（地形模式 = 地形面）" },
        { key: "skeleton", label: "路网骨架", hint: "2D 数据：路网/地标/出生点" },
        { key: "road", label: "道路", hint: "描边/手工道路要素" },
        { key: "roadTile", label: "拼接路块", hint: "路块拼接工具放置的路块" },
        { key: "river", label: "河流", hint: "描边河流要素" },
        { key: "object", label: "物件", hint: "树木 / 路灯 / 建筑" },
        { key: "origin", label: "锚点标记", hint: "金色立柱 = 范围中心" },
        { key: "measure", label: "测距结果", hint: "测距工具保留的标注" },
      ],
    },
  ];
}

export function toggleLayers(ed) {
  if (ed._layersPop.classList.contains("hidden")) openLayers(ed);
  else closeLayers(ed);
}

export function openLayers(ed) {
  const pop = ed._layersPop;
  pop.innerHTML = "";
  for (const group of layerDefs(ed)) {
    const h = document.createElement("div");
    h.className = "e3-layer-cat";
    h.textContent = group.title;
    pop.appendChild(h);
    for (const def of group.items) {
      const on = ed._layerVis[def.key] !== false;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "e3-layer-row" + (on ? " on" : "");
      row.innerHTML = `<span class="e3-layer-check"></span><span class="e3-layer-name">${def.label}<small>${def.hint}</small></span>`;
      row.addEventListener("click", () => {
        const next = ed._layerVis[def.key] === false;
        row.classList.toggle("on", next); // 先更新勾选视觉，场景应用失败也不影响面板反馈
        setLayerVis(ed, def.key, next);
      });
      pop.appendChild(row);
    }
  }
  const hint = document.createElement("small");
  hint.className = "e3-set-hint";
  hint.textContent = "「卫星底图」整体开关在顶栏按钮";
  pop.appendChild(hint);
  pop.classList.remove("hidden");
  ed._layersBtn.classList.add("active");
  // 捕获阶段监听外部点击关闭（与设置面板同套路）；先移除旧监听防堆积
  setTimeout(() => {
    if (ed._onLayersOutside) document.removeEventListener("pointerdown", ed._onLayersOutside, true);
    ed._onLayersOutside = (e) => {
      if (!pop.contains(e.target) && e.target !== ed._layersBtn) closeLayers(ed);
    };
    // 挂到编辑器实例的 AbortController 上：close() 时随 _ac.abort() 自动摘除，防止多实例泄漏
    document.addEventListener("pointerdown", ed._onLayersOutside, { capture: true, signal: ed._sig?.signal });
  }, 0);
}

export function closeLayers(ed) {
  ed._layersPop.classList.add("hidden");
  ed._layersBtn.classList.remove("active");
  if (ed._onLayersOutside) {
    document.removeEventListener("pointerdown", ed._onLayersOutside, true);
    ed._onLayersOutside = null;
  }
}

export function setLayerVis(ed, key, on) {
  ed._layerVis[key] = on;
  try { localStorage.setItem("tr_e3_layers_v3", JSON.stringify(ed._layerVis)); } catch { /* 忽略 */ }
  try { ed._applyLayerVis(); } catch (e) { console.warn("[editor3d] 图层显隐应用失败：", e); }
}

// 统一应用显隐：影像层 + 场景分组 + 实体 wrapper（重建后由各创建点单独重设）。
// 影像层与 Three 场景分段独立容错：一侧异常不阻断另一侧，保证勾选即时生效。
export function applyLayerVis(ed) {
  const vis = ed._layerVis;
  try { ed._applyImageryVis(); } catch (e) { console.warn("[editor3d] 影像层显隐应用失败：", e); }
  const t = ed._three;
  if (!t) return;
  // 范围组内细分显隐：底板（地形面）/网格线各自开关；金色边界描边常显（范围轮廓）
  for (const c of t.areaGroup.children) {
    if (c.userData.isPlate) c.visible = vis.plate !== false;
    else if (c.userData.isGrid) c.visible = vis.grid !== false;
  }
  // ADR-0005：独立全局地面 + 路基补丁（8m 同相位格点）跟随「范围底板」显隐
  if (t.groundMesh) t.groundMesh.visible = vis.plate !== false;
  if (t.bedMesh) t.bedMesh.visible = vis.plate !== false;
  if (ed._skeleton) ed._skeleton.visible = vis.skeleton !== false;
  if (ed._originMarker) ed._originMarker.visible = vis.origin !== false;
  if (ed._measureGroup) ed._measureGroup.visible = vis.measure !== false;
  for (const w of ed._wrappers?.values() || []) w.root.visible = vis[w.kind] !== false;
}

/* ================ 设置面板 ================ */
// 可扩展设置面板：分节渲染，新增设置项只需在 settingsSections 返回数组里加一项
// { id, title, render(bodyEl) }，面板定位、开关、外部点击关闭均自动处理。

export function settingsSections(ed) {
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
          row.innerHTML = `<span class="e3-set-radio"></span><span class="e3-set-label">${s.label}</span>`;
          row.addEventListener("click", () => {
            if (s.id === getBasemapSource()) { closeSettings(ed); return; }
            setBasemapSource(s.id);
            ed._rebuildBasemap();
            openSettings(ed); // 重渲染以更新选中态
          });
          el.appendChild(row);
        }
      },
    },
    {
      id: "origin",
      title: "地图位置 · 范围中心的经纬度",
      render: (el) => {
        const o = ed.map.origin;
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
        wireOriginSearch(ed, el);
        el.querySelector("#e3-org-apply").addEventListener("click", () => {
          const lat = parseFloat(el.querySelector("#e3-org-lat").value);
          const lon = parseFloat(el.querySelector("#e3-org-lon").value);
          if (ed._setOriginLL(lat, lon)) openSettings(ed); // 重渲染以刷新输入框
        });
        el.querySelector("#e3-org-pick").addEventListener("click", () => {
          closeSettings(ed);
          ed._setOriginPickMode();
        });
      },
    },
    {
      id: "measure",
      title: "测量工具 · 距离",
      render: (el) => {
        const m = ed._measureResult;
        const measuring = !!(ed.draft && ed.draft.measure);
        el.innerHTML = `
          <div class="e3-set-row">
            <button id="e3-ms-start" class="e3-set-btn primary">${measuring ? "回到测距（进行中）" : "在地图上测距"}</button>
            <button id="e3-ms-clear" class="e3-set-btn" ${m ? "" : "disabled"}>清除结果</button>
          </div>
          ${m ? `<small class="e3-set-hint">上次测距：<b>${fmtDist(m.length)}</b> · ${m.points.length} 个点</small>` : ""}
          <small class="e3-set-hint">单击地图依次加点，实时显示每段与总距离（贴地直线距离）；双击 / Enter 结束，Esc 取消，Shift 锁 45° 直线。完成后结果保留在图上，直到清除或重新测距。</small>
        `;
        el.querySelector("#e3-ms-start").addEventListener("click", () => {
          closeSettings(ed);
          if (measuring) ed._renderMeasurePanel(); // 测距进行中：恢复右侧会话面板
          else ed._startMeasure();
        });
        el.querySelector("#e3-ms-clear").addEventListener("click", () => {
          ed._clearMeasure();
          openSettings(ed); // 重渲染以更新按钮/结果状态
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
export function wireOriginSearch(ed, el) {
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
    ed._setOriginLL(r.lat, r.lng);
    ed.status(`已定位到「${r.name}」· 地图整体搬至 ${r.lat.toFixed(6)}, ${r.lng.toFixed(6)} · 记得保存`);
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

export function toggleSettings(ed) {
  const pop = document.getElementById("e3-settings-pop");
  if (pop.classList.contains("hidden")) openSettings(ed);
  else closeSettings(ed);
}

export function openSettings(ed) {
  const pop = document.getElementById("e3-settings-pop");
  const btn = document.getElementById("e3-settings");
  pop.innerHTML = "";
  // 面板定位于设置按钮下方，超出右边界时回退
  const r = btn.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 268)) + "px";
  pop.style.top = r.bottom + 8 + "px";
  for (const sec of settingsSections(ed)) {
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
  // 先移除旧监听（面板内操作会反复 openSettings 重渲染，不移除会越积越多）
  setTimeout(() => {
    if (ed._onSettingsOutside) document.removeEventListener("pointerdown", ed._onSettingsOutside, true);
    ed._onSettingsOutside = (e) => {
      if (!pop.contains(e.target) && e.target !== btn) closeSettings(ed);
    };
    document.addEventListener("pointerdown", ed._onSettingsOutside, true);
  }, 0);
}

export function closeSettings(ed) {
  const pop = document.getElementById("e3-settings-pop");
  pop.classList.add("hidden");
  if (ed._onSettingsOutside) {
    document.removeEventListener("pointerdown", ed._onSettingsOutside, true);
    ed._onSettingsOutside = null;
  }
}
