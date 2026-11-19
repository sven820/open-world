import { Engine } from "./core/engine.js";
import { Environment } from "./core/environment.js";
import { Input } from "./core/input.js";
import { City } from "./world/city.js";
import { buildLandmarks } from "./world/landmarks.js";
import { BillboardManager } from "./world/billboard/billboardManager.js";
import { AdminSync } from "./world/billboard/adminClient.js";
import { ensureBillboardAssets } from "./data/billboardAsset.js";
import { listAssets } from "./data/assetStore.js";
import { registerAssetSource } from "./world/billboard/contentSources.js";
import { Traffic } from "./entities/traffic.js";
import { PedestrianCrowd } from "./entities/pedestrians.js";
import { Player } from "./entities/player.js";
import { Hud } from "./ui/hud.js";
import { ChatPanel } from "./ui/chatPanel.js";
import {
  listMaps, getMap, createMap, saveMapData, deleteMap,
  getActiveMapId, setActiveMapId, resolveActiveMap,
} from "./data/mapStore.js";
import { MapEditor } from "./ui/mapEditor.js";
import {
  getRenderSettings, onRenderSettingsChange, MAX_PEDESTRIANS, MAX_VEHICLES,
} from "./config/renderSettings.js";
import { RenderSettingsPanel } from "./ui/renderSettingsPanel.js";
import { CharacterCreator, loadSavedAvatar } from "./creator/index.js";

window.__errs = [];
window.addEventListener("error", (e) => window.__errs.push(String(e.message) + " @" + (e.filename || "") + ":" + (e.lineno || "")));
window.addEventListener("unhandledrejection", (e) => window.__errs.push("promise:" + String(e.reason && e.reason.stack || e.reason)));

const canvas = document.getElementById("game-canvas");
canvas.tabIndex = 0; // make canvas focusable so keyboard input lands on the game
const engine = new Engine(canvas);
const input = new Input(canvas);
const env = new Environment(engine.scene, engine.renderer);

const loader = document.getElementById("loader");
const ldFill = document.getElementById("ld-fill");
const ldPct = document.getElementById("ld-pct");
const ldStage = document.getElementById("ld-stage");
const ldBusyHint = document.querySelector("#loader .ld-hint"); // 加载页右下角提示语
const LD_HINT_DEFAULT = ldBusyHint ? ldBusyHint.textContent : "";
const hudEl = document.getElementById("hud");
const menuEl = document.getElementById("menu");
const clickPlay = document.getElementById("click-to-play");

let started = false;
let bigOpen = false;
let world = null;      // { mapId, mapName, city, landmarkGroup, traffic, peds, player, hud }
let worldStale = false; // 激活地图数据被编辑器修改过，进入游戏前需要重建
let editor = null;
let editor3d = null;
let fps = 60, fpsAcc = 0, fpsFrames = 0;

// 后台内容接入：单例轮询器，重建世界时只换 billboards 引用
const adminSync = new AdminSync();
window.__adminSync = adminSync;

function setProgress(p, stage) {
  ldFill.style.width = Math.round(p * 100) + "%";
  ldPct.textContent = Math.round(p * 100) + "%";
  if (stage) ldStage.textContent = stage;
  // 新一轮加载开始：清掉上一次失败留下的红色文案和「重试」提示
  ldStage.style.color = "";
  if (ldBusyHint) ldBusyHint.textContent = LD_HINT_DEFAULT;
}

/* ---------------- 启动 / 重建的容错提示 ----------------
 * 城市构建、地图重建都是异步链路。以前抛错只进 window.__errs / console，
 * 用户看到的是进度条停在某一格，分不清「还在加载」还是「已经失败」。
 * 这里统一把异常显示到加载页：保留进度条、给出原因与可执行的下一步。
 * 注意只处理启动链路；内容加载（GLB / 视频）失败由屏面提示板负责，不弹加载页。 */
function showFatal(stage, err) {
  const msg = String((err && (err.message || err.reason)) || err || "未知错误");
  console.error("[walkstreet]", stage, err);
  window.__errs.push(`${stage}: ${msg}`);
  loader.classList.remove("hidden");
  menuEl.classList.add("hidden");
  hudEl.classList.add("hidden");
  ldStage.textContent = `${stage}失败：${msg.slice(0, 140)}`; // 截断，避免长堆栈撑破加载页
  ldStage.style.color = "#ff9b8a";
  if (ldBusyHint) ldBusyHint.textContent = "请刷新页面重试；若持续失败请检查控制台 / 后台地址";
}

// 主菜单「选择地图」按钮上的当前地图名
function updateMapButton() {
  const el = document.getElementById("btn-map-name");
  if (!el) return;
  const id = getActiveMapId();
  const m = id === "default" ? null : getMap(id);
  el.textContent = m ? m.name : "默认街区 · 程序化城市";
  el.title = m ? `当前地图：${m.name}` : "当前地图：默认街区 · 程序化城市";
}

/* ---------------- world build / dispose ---------------- */

async function buildWorld(mapData, mapId) {
  setProgress(0.2, "正在对齐街区坐标…");
  const city = new City(engine.scene, mapData);
  // 程序化城市分块生成期间把真实进度回填加载条（0.2 → 0.48）：
  // 街廓多时加载条持续前进，不会停在 20% 像卡死
  const progressTimer = setInterval(() => {
    const p = city.buildProgress;
    if (p > 0 && p < 1) setProgress(0.2 + p * 0.28, "正在生成街廓与建筑…");
  }, 120);
  try {
    await city.ready;
  } catch (e) {
    console.error("[city] 世界构建失败：", e);
    throw e;
  } finally {
    clearInterval(progressTimer);
  }
  setProgress(0.5, "正在生成街廓与建筑…");
  await new Promise((r) => setTimeout(r, 30));
  setProgress(0.62, "正在布置店家招牌与街灯…");
  const landmarkGroup = buildLandmarks(engine.scene, city);
  // 地标也纳入分块按需渲染（离开视野/距离后整组跳过绘制）
  for (const g of landmarkGroup.children) city.registerStreamed(g);
  if (city.custom && city.custom.group) city.registerStreamed(city.custom.group);
  setProgress(0.72, "正在布置地图中的广告大屏…");
  // 四种广告牌 = 模型工坊资产库的四个模型资产（幂等播种，用户删除后重启会重建）。
  // 地图对象只存 assetId；资产记录已在 city 预热阶段进同步缓存。
  await ensureBillboardAssets();
  // 资产库 GLB 注册为「模型工坊资产」内容源：内容配置只存 assetId，地址运行时解析
  for (const a of (await listAssets()) || []) {
    if (a.glb) registerAssetSource(a.id, URL.createObjectURL(a.glb), { name: a.name, is3d: true, type: "model3d" });
  }
  // 广告大屏：只构建地图里手动放置的 billboard 记录，默认街区不自动生成
  const billboards = new BillboardManager(engine.scene, city, engine.renderer);
  for (const s of billboards.screens) city.registerStreamed(s.group);
  setProgress(0.78, "正在唤醒行人与车流…");
  await new Promise((r) => setTimeout(r, 30));
  // 实例容量按上限分配，实际启用数量由画面设置决定（可热切换，无需重建世界）
  const rs = getRenderSettings();
  const traffic = new Traffic(engine.scene, city, MAX_VEHICLES);
  traffic.setActiveCount(rs.traffic);
  traffic.setMaxDistance(rs.trafficDistance);
  city.traffic = traffic;
  const peds = new PedestrianCrowd(engine.scene, city, MAX_PEDESTRIANS);
  peds.setActiveCount(rs.pedestrians);
  peds.setMaxDistance(rs.pedestrianDistance);
  const player = new Player(engine.scene, engine.camera, city, engine.renderer);
  player.reset();
  await player.ready;
  await player.setAvatarConfig(loadSavedAvatar());
  const hud = new Hud(city, player, env);
  const chat = new ChatPanel(hudEl); // 右下角频道聊天面板（设计见 docs/design/chat-channel-design.md）
  const mapName = mapData ? mapData.name : "默认街区 · 程序化城市";
  world = { mapId, mapName, city, landmarkGroup, traffic, peds, player, hud, chat, billboards };
  window.__game = { engine, env, city, traffic, peds, player, hud, billboards, adminSync };
  adminSync.attach(billboards, { mapId, mapName });
}

function disposeTree(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
      // 标准材料库的共享实例（userData.shared）全局复用，不随世界释放；
      // 其贴图同理跳过
      if (m.userData && m.userData.shared) return;
      for (const k of Object.keys(m)) {
        const v = m[k];
        if (v && v.isTexture && !(v.userData && v.userData.shared)) v.dispose();
      }
      m.dispose();
    });
  });
}

function disposeWorld() {
  if (!world) return;
  const w = world;
  world = null;
  started = false;
  bigOpen = false;
  const safe = (fn) => { try { fn(); } catch (e) { console.warn("[dispose]", e); } };
  if (w.player.driving) safe(() => w.player.exit());
  safe(() => w.hud.dispose());
  safe(() => w.chat.dispose());
  safe(() => w.traffic.dispose());
  safe(() => w.peds.dispose());
  safe(() => w.player.dispose());
  safe(() => { engine.scene.remove(w.landmarkGroup); disposeTree(w.landmarkGroup); });
  safe(() => { engine.scene.remove(w.billboards.group); disposeTree(w.billboards.group); w.billboards.dispose(); });
  safe(() => { engine.scene.remove(w.city.group); disposeTree(w.city.group); });
  safe(() => w.city.dispose());
  adminSync.detach();
  window.__game = null;
}

// 按当前选择的地图重建世界；showMenu=false 时结束后保持 loader/菜单由调用方处理
async function rebuildWorld(stage, showMenu = true) {
  loader.classList.remove("hidden");
  menuEl.classList.add("hidden");
  hudEl.classList.add("hidden");
  setProgress(0.12, stage || "正在加载地图…");
  try {
    disposeWorld();
    await new Promise((r) => setTimeout(r, 40));
    const mapData = resolveActiveMap();
    await buildWorld(mapData, getActiveMapId());
    worldStale = false;
    setProgress(1.0, "就绪");
    await new Promise((r) => setTimeout(r, 200));
    loader.classList.add("hidden");
    updateMapButton();
    if (showMenu) menuEl.classList.remove("hidden");
  } catch (err) {
    // 重建失败时把原因留在加载页，不要静默吞掉后让调用方继续按「成功」往下走
    showFatal(stage || "地图重建", err);
  }
}

async function boot() {
  setProgress(0.08, "正在对齐街区坐标…");
  try {
    const mapData = resolveActiveMap();
    await buildWorld(mapData, getActiveMapId());
    setProgress(1.0, "就绪");
    await new Promise((r) => setTimeout(r, 250));
    loader.classList.add("hidden");
    updateMapButton();
    menuEl.classList.remove("hidden");
    engine.start();
  } catch (err) {
    // 启动链路失败：菜单和 HUD 都还没就绪，加载页是唯一能告诉用户发生了什么的地方
    showFatal("城市构建", err);
  }
}

/* ---------------- UI wiring ---------------- */
document.getElementById("btn-start").addEventListener("click", startGame);

/* ---------------- 捏脸工坊（选择角色入口） ---------------- */
const creator = new CharacterCreator({
  onSave: (cfg) => {
    if (world && world.player) world.player.setAvatarConfig(cfg);
    if (world && world.hud) world.hud.showNotify(`角色已更新：${cfg.name} · 已进入街区形象`, 2400);
  },
});
window.__creator = creator;
document.getElementById("btn-character").addEventListener("click", () => creator.open());

/* ---------------- 设置（画面 / AI，供各入口复用） ---------------- */
let settingsPanel = null;
function openSettings(tab) {
  if (!settingsPanel) settingsPanel = new RenderSettingsPanel();
  settingsPanel.open(tab);
}
window.openSettings = openSettings; // 其他功能模块需要配置 AI 时可直接 openSettings("ai")
document.getElementById("btn-settings").addEventListener("click", () => openSettings("graphics"));

// 行人/车流规模属于"实例数量"，热切换即可，不用重建世界
onRenderSettingsChange((s) => {
  if (!world) return;
  world.peds.setActiveCount(s.pedestrians);
  world.peds.setMaxDistance(s.pedestrianDistance);
  world.traffic.setActiveCount(s.traffic);
  world.traffic.setMaxDistance(s.trafficDistance);
});
document.getElementById("btn-map").addEventListener("click", openMapSelect);
document.getElementById("ms-close").addEventListener("click", () => mapSelectEl().classList.add("hidden"));
document.getElementById("ms-new").addEventListener("click", onNewMap);
document.getElementById("bm-close").addEventListener("click", closeBigMap);
document.getElementById("bm-home").addEventListener("click", backToMenu);
clickPlay.addEventListener("click", () => { canvas.focus(); input.requestLock(); });
// clicking the game view (re)focuses the canvas so keyboard input keeps working
canvas.addEventListener("pointerdown", () => canvas.focus());
// click the minimap to open / close the big map (same as pressing M)
document.getElementById("minimap").addEventListener("click", (e) => {
  e.stopPropagation();
  bigOpen ? closeBigMap() : openBigMap();
});

function mapSelectEl() { return document.getElementById("map-select"); }

function openMapSelect() {
  renderMapList();
  mapSelectEl().classList.remove("hidden");
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const fmtTime = (ts) => {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

function renderMapList() {
  const activeId = getActiveMapId();
  const items = [
    { id: "default", name: "默认街区 · 程序化城市", meta: "程序化城市 · 出厂预设", isDefault: true },
    ...listMaps().map((m) => ({ id: m.id, name: m.name, meta: `上次保存 ${fmtTime(m.updatedAt)}` })),
  ];
  const listEl = document.getElementById("ms-list");
  listEl.innerHTML = "";
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "ms-item" + (it.id === activeId ? " active" : "");
    row.innerHTML = `
      <div class="ms-info"><b>${escapeHtml(it.name)}</b><small>${it.meta}</small></div>
      ${it.id === activeId ? '<span class="ms-badge">使用中</span>' : ""}
      <div class="ms-btns">
        <button class="ms-act go" data-act="play">进入</button>
        <button class="ms-act" data-act="edit">${it.isDefault ? "编辑副本" : "编辑"}</button>
        <button class="ms-act" data-act="edit3d">${it.isDefault ? "3D副本" : "3D 编辑"}</button>
        ${it.isDefault ? "" : '<button class="ms-act danger" data-act="del">删除</button>'}
      </div>`;

    row.querySelector('[data-act="play"]').addEventListener("click", async () => {
      setActiveMapId(it.id);
      mapSelectEl().classList.add("hidden");
      if (!world || world.mapId !== it.id) {
        const name = it.name;
        await rebuildWorld(`正在进入「${name}」…`);
      }
      if (world) world.hud.showNotify(`已选择地图：${world.mapName} · 点击「进入街区」开启`, 3000);
    });

    row.querySelector('[data-act="edit"]').addEventListener("click", () => {
      let map;
      if (it.isDefault) {
        map = createMap(takeMapName("我的城市"));
      } else {
        map = getMap(it.id);
      }
      mapSelectEl().classList.add("hidden");
      openEditor(map);
    });

    row.querySelector('[data-act="edit3d"]').addEventListener("click", () => {
      let map;
      if (it.isDefault) {
        map = createMap(takeMapName("我的城市"));
      } else {
        map = getMap(it.id);
      }
      mapSelectEl().classList.add("hidden");
      openEditor3d(map);
    });

    const del = row.querySelector('[data-act="del"]');
    if (del) del.addEventListener("click", () => {
      if (!window.confirm(`删除地图「${it.name}」？此操作不可恢复。`)) return;
      deleteMap(it.id);
      if (getActiveMapId() === it.id) worldStale = true;
      renderMapList();
    });

    listEl.appendChild(row);
  }
  updateMapButton();
}

// 取走输入框里的新地图名称并清空：避免同名被「编辑副本 / 3D 副本」反复沿用，
// 出现两行完全一样的地图名（容易被误认为改名串到了别的地图）
function takeMapName(fallback) {
  const el = document.getElementById("ms-name");
  const name = el.value.trim();
  el.value = "";
  return name || fallback;
}

function onNewMap() {
  // 不直接进编辑器：先让用户选 3D / 普通，点其他区域自动收起
  const choose = document.getElementById("ms-new-choose");
  choose.classList.toggle("hidden");
}

function bindNewMapChoice() {
  const choose = document.getElementById("ms-new-choose");
  const create = async (mode) => {
    const map = createMap(takeMapName(""));
    choose.classList.add("hidden");
    mapSelectEl().classList.add("hidden");
    if (mode === "3d") await openEditor3d(map);
    else openEditor(map);
  };
  document.getElementById("ms-new-3d").addEventListener("click", () => create("3d"));
  document.getElementById("ms-new-2d").addEventListener("click", () => create("2d"));
  document.addEventListener("pointerdown", (e) => {
    if (choose.classList.contains("hidden")) return;
    if (!choose.contains(e.target) && !e.target.closest("#ms-new")) choose.classList.add("hidden");
  });
}
bindNewMapChoice();

function openEditor(map) {
  closeEditor();
  editor = new MapEditor({
    map,
    onSave: (data) => {
      const saved = saveMapData(map.id, data, data.name);
      if (saved && getActiveMapId() === map.id) worldStale = true;
      return !!saved;
    },
    onPlay: async () => {
      setActiveMapId(map.id);
      closeEditor();
      await rebuildWorld(`正在构建「${map.name}」…`, false);
      enterGame();
    },
    onClose: () => closeEditor(),
  });
  editor.open();
}

function closeEditor() {
  if (editor) { editor.close(); editor = null; }
  updateMapButton(); // 编辑器中可能改名/保存
}

async function openEditor3d(map) {
  closeEditor3d();
  const { MapEditor3d } = await import("./ui/mapEditor3d.js");
  editor3d = new MapEditor3d({
    map,
    onSave: (data) => {
      const saved = saveMapData(map.id, data, data.name);
      if (saved && getActiveMapId() === map.id) worldStale = true;
      return !!saved;
    },
    onPlay: async () => {
      setActiveMapId(map.id);
      closeEditor3d();
      await rebuildWorld(`正在构建「${map.name}」…`, false);
      enterGame();
    },
    onClose: () => closeEditor3d(),
    // 资产面板「在模型工坊中编辑」：关编辑器 → 开工坊；工坊返回后回地图选择
    onEditAsset: (assetId) => {
      closeEditor3d();
      openStudio(assetId);
    },
  });
  await editor3d.open();
}

function closeEditor3d() {
  if (editor3d) { editor3d.close(); editor3d = null; }
  updateMapButton();
}

/* ---------------- 模型工坊（Model Studio） ---------------- */
let studio = null;
async function openStudio(assetId, onClose) {
  closeStudio();
  const { ModelStudio } = await import("./studio/studio.js");
  studio = new ModelStudio({
    initialAssetId: assetId,
    onClose: onClose || (() => { closeStudio(); menuEl.classList.remove("hidden"); }),
  });
  menuEl.classList.add("hidden");
  await studio.open();
}
function closeStudio() {
  if (studio) { studio.close(); studio = null; }
}
document.getElementById("ms-studio").addEventListener("click", () => {
  mapSelectEl().classList.add("hidden");
  openStudio();
});

async function startGame() {
  if (!world || world.mapId !== getActiveMapId() || worldStale) {
    await rebuildWorld("正在构建所选地图…", false);
  }
  enterGame();
}

function enterGame() {
  menuEl.classList.add("hidden");
  hudEl.classList.remove("hidden");
  started = true;
  world.player.setEnabled(true);
  canvas.focus();
}

// return to the main menu from the big map: stop player control and show the
// menu again. World/city keep running in the background; pressing 进入街区
// resumes at the same spot.
function backToMenu() {
  closeBigMap();
  started = false;
  if (world && world.player.driving) world.player.exit();
  if (world) world.player.setEnabled(false);
  input.exitLock();
  clickPlay.classList.add("hidden");
  hudEl.classList.add("hidden");
  menuEl.classList.remove("hidden");
}

input.onLockChange = (locked) => {
  if (!started) return;
  if (locked) clickPlay.classList.add("hidden");
  else clickPlay.classList.remove("hidden");
};

function openBigMap() {
  bigOpen = true;
  bigmapEl().classList.remove("hidden");
  input.exitLock();
  clickPlay.classList.add("hidden");
  const title = bigmapEl().querySelector(".bm-head h3");
  if (title && world) title.innerHTML = `${escapeHtml(world.mapName)} <small>MAP</small>`;
  world.hud.showNotify(`${world ? world.mapName : "地图"} · 左键拖动平移 · 右键拖动旋转 · 滚轮以光标为中心缩放 · WASD 平移 · M 关闭`, 3000);
}
function closeBigMap() {
  bigOpen = false;
  bigmapEl().classList.add("hidden");
}
function bigmapEl() { return document.getElementById("bigmap"); }

// 无玩家时的取景回退点（避免每帧临时对象）
const FALLBACK_FOCUS = { x: -160, z: -24 };

// main update loop
engine.onUpdate((dt, time) => {
  const w = world;
  const focus = w && w.player ? w.player.pos : FALLBACK_FOCUS;
  env.update(dt, focus);
  if (w && w.city.readyState) {
    w.city.update(dt, time, env.night, focus);
    w.traffic.update(dt, focus);
    w.peds.update(dt, focus);
    w.billboards.update(dt, time, focus, engine.camera); // camera = 3D 裸眼虚拟眼睛
  }
  if (started && w) {
    if (input.pressed("KeyM")) { bigOpen ? closeBigMap() : openBigMap(); }
    if (input.pressed("Enter") && !bigOpen && w.chat) w.chat.toggleOpen(); // 呼出/收起频道聊天
    if (bigOpen) {
      const pan = 30 * dt / (w.hud._bigZoom || 1);
      if (input.down("KeyW")) w.hud.panBig(0, -pan);
      if (input.down("KeyS")) w.hud.panBig(0, pan);
      if (input.down("KeyA")) w.hud.panBig(-pan, 0);
      if (input.down("KeyD")) w.hud.panBig(pan, 0);
    } else {
      w.player.update(dt, input);
      if (input.pressed("KeyC")) w.player.resetView();
      if (input.pressed("KeyF")) {
        if (w.player.driving) w.player.exit();
        else { const v = w.player.enterPrompt(); if (v) w.player.enter(v); }
      }
    }
    w.hud.update(dt, fps);
  }
  engine.bloom.strength = 0.32 + env.night * 0.6;
  input.update();
  window.__frames = (window.__frames || 0) + 1;
  const fs = engine.frameStats;
  window.__calls = fs ? fs.calls : 0;
  window.__tris = fs ? fs.triangles : 0;
  // 分块调度里已统计可见块数，别在这里对全部 children 做 filter（每帧一个数组）
  window.__visible = w ? w.city.visibleChunks : 0;

  fpsFrames++;
  fpsAcc += dt;
  if (fpsAcc >= 0.5) {
    fps = fpsFrames / fpsAcc;
    fpsAcc = 0; fpsFrames = 0;
    window.__fps = fps;
    if (document.getElementById("fps")) document.getElementById("fps").classList.remove("hidden");
  }
});

// big map zoom is now handled by the HUD's own mouse/wheel handlers on #bigmap-canvas

boot();
