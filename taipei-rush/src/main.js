import { Engine } from "./core/engine.js";
import { Environment } from "./core/environment.js";
import { Input } from "./core/input.js";
import { City } from "./world/city.js";
import { buildLandmarks } from "./world/landmarks.js";
import { Traffic } from "./entities/traffic.js";
import { PedestrianCrowd } from "./entities/pedestrians.js";
import { Player } from "./entities/player.js";
import { Hud } from "./ui/hud.js";
import {
  listMaps, getMap, createMap, saveMapData, deleteMap,
  getActiveMapId, setActiveMapId, resolveActiveMap,
} from "./data/mapStore.js";
import { MapEditor } from "./ui/mapEditor.js";

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
const hudEl = document.getElementById("hud");
const menuEl = document.getElementById("menu");
const clickPlay = document.getElementById("click-to-play");

let started = false;
let bigOpen = false;
let world = null;      // { mapId, mapName, city, landmarkGroup, traffic, peds, player, hud }
let worldStale = false; // 激活地图数据被编辑器修改过，进入游戏前需要重建
let editor = null;
let fps = 60, fpsAcc = 0, fpsFrames = 0;

function setProgress(p, stage) {
  ldFill.style.width = Math.round(p * 100) + "%";
  ldPct.textContent = Math.round(p * 100) + "%";
  if (stage) ldStage.textContent = stage;
}

// 主菜单「选择地图」按钮上的当前地图名
function updateMapButton() {
  const el = document.getElementById("btn-map-name");
  if (!el) return;
  const id = getActiveMapId();
  const m = id === "default" ? null : getMap(id);
  el.textContent = m ? m.name : "台北 · 默认地图";
  el.title = m ? `当前地图：${m.name}` : "当前地图：台北 · 默认地图";
}

/* ---------------- world build / dispose ---------------- */

async function buildWorld(mapData, mapId) {
  setProgress(0.2, "正在对齐街区坐标…");
  const city = new City(engine.scene, mapData);
  await city.ready;
  setProgress(0.5, "正在生成街廓与建筑…");
  await new Promise((r) => setTimeout(r, 30));
  setProgress(0.62, "正在布置店家招牌与街灯…");
  const landmarkGroup = buildLandmarks(engine.scene, city);
  setProgress(0.78, "正在唤醒行人与车流…");
  await new Promise((r) => setTimeout(r, 30));
  const traffic = new Traffic(engine.scene, city, 40);
  city.traffic = traffic;
  const peds = new PedestrianCrowd(engine.scene, city, 240);
  const player = new Player(engine.scene, engine.camera, city, engine.renderer);
  player.reset();
  await player.ready;
  const hud = new Hud(city, player, env);
  world = {
    mapId,
    mapName: mapData ? mapData.name : "台北 · 默认地图",
    city, landmarkGroup, traffic, peds, player, hud,
  };
  window.__game = { engine, env, city, traffic, peds, player, hud };
}

function disposeTree(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
      for (const k of Object.keys(m)) {
        const v = m[k];
        if (v && v.isTexture) v.dispose();
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
  safe(() => w.traffic.dispose());
  safe(() => w.peds.dispose());
  safe(() => w.player.dispose());
  safe(() => { engine.scene.remove(w.landmarkGroup); disposeTree(w.landmarkGroup); });
  safe(() => { engine.scene.remove(w.city.group); disposeTree(w.city.group); });
  window.__game = null;
}

// 按当前选择的地图重建世界；showMenu=false 时结束后保持 loader/菜单由调用方处理
async function rebuildWorld(stage, showMenu = true) {
  loader.classList.remove("hidden");
  menuEl.classList.add("hidden");
  hudEl.classList.add("hidden");
  setProgress(0.12, stage || "正在加载地图…");
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
}

async function boot() {
  setProgress(0.08, "正在对齐街区坐标…");
  const mapData = resolveActiveMap();
  await buildWorld(mapData, getActiveMapId());
  setProgress(1.0, "就绪");
  await new Promise((r) => setTimeout(r, 250));
  loader.classList.add("hidden");
  updateMapButton();
  menuEl.classList.remove("hidden");
  engine.start();
}

/* ---------------- UI wiring ---------------- */
document.getElementById("btn-start").addEventListener("click", startGame);
document.getElementById("btn-character").addEventListener("click", () => world && world.hud.showNotify("角色：阿杰 · 西门町长大，擅长骑车", 2600));
document.getElementById("btn-settings").addEventListener("click", () => world && world.hud.showNotify("设置：视角灵敏度 / 音量（示意）", 2600));
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
    { id: "default", name: "台北 · 默认地图", meta: "程序化城市 · 出厂预设", isDefault: true },
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
        ${it.isDefault ? "" : '<button class="ms-act danger" data-act="del">删除</button>'}
      </div>`;

    row.querySelector('[data-act="play"]').addEventListener("click", async () => {
      setActiveMapId(it.id);
      mapSelectEl().classList.add("hidden");
      if (!world || world.mapId !== it.id) {
        const name = it.name;
        await rebuildWorld(`正在进入「${name}」…`);
      }
      if (world) world.hud.showNotify(`已选择地图：${world.mapName} · 点击开始游戏进入`, 3000);
    });

    row.querySelector('[data-act="edit"]').addEventListener("click", () => {
      let map;
      if (it.isDefault) {
        map = createMap(document.getElementById("ms-name").value || "我的城市");
      } else {
        map = getMap(it.id);
      }
      mapSelectEl().classList.add("hidden");
      openEditor(map);
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

function onNewMap() {
  const nameEl = document.getElementById("ms-name");
  const map = createMap(nameEl.value);
  nameEl.value = "";
  mapSelectEl().classList.add("hidden");
  openEditor(map);
}

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
// menu again. World/city keep running in the background; pressing 开始游戏
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
  world.hud.showNotify("大台北地图 · 左键拖动平移 · 右键拖动旋转 · 滚轮缩放 · WASD 平移 · M 关闭", 3000);
}
function closeBigMap() {
  bigOpen = false;
  bigmapEl().classList.add("hidden");
}
function bigmapEl() { return document.getElementById("bigmap"); }

// main update loop
engine.onUpdate((dt, time) => {
  const w = world;
  env.update(dt, w && w.player ? w.player.pos : { x: -160, z: -24 });
  if (w && w.city.readyState) {
    w.city.update(dt, time, env.night);
    w.traffic.update(dt);
    w.peds.update(dt);
  }
  if (started && w) {
    if (input.pressed("KeyM")) { bigOpen ? closeBigMap() : openBigMap(); }
    if (bigOpen) {
      const pan = 30 * dt / (w.hud._bigZoom || 1);
      if (input.down("KeyW")) w.hud.panBig(0, -pan);
      if (input.down("KeyS")) w.hud.panBig(0, pan);
      if (input.down("KeyA")) w.hud.panBig(-pan, 0);
      if (input.down("KeyD")) w.hud.panBig(pan, 0);
    } else {
      w.player.update(dt, input);
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
  window.__calls = engine.renderer.info.render.calls;
  window.__tris = engine.renderer.info.render.triangles;
  window.__visible = w ? w.city.group.children.filter((o) => o.visible).length : 0;

  fpsFrames++;
  fpsAcc += dt;
  if (fpsAcc >= 0.5) { fps = fpsFrames / fpsAcc; fpsAcc = 0; fpsFrames = 0; if (document.getElementById("fps")) document.getElementById("fps").classList.remove("hidden"); }
});

// big map zoom is now handled by the HUD's own mouse/wheel handlers on #bigmap-canvas

boot();
