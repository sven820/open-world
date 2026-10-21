import { Engine } from "./core/engine.js";
import { Environment } from "./core/environment.js";
import { Input } from "./core/input.js";
import { City } from "./world/city.js";
import { buildLandmarks } from "./world/landmarks.js";
import { Traffic } from "./entities/traffic.js";
import { PedestrianCrowd } from "./entities/pedestrians.js";
import { Player } from "./entities/player.js";
import { Hud } from "./ui/hud.js";

window.__errs = [];
window.addEventListener("error", (e) => window.__errs.push(String(e.message) + " @" + (e.filename || "") + ":" + (e.lineno || "")));
window.addEventListener("unhandledrejection", (e) => window.__errs.push("promise:" + String(e.reason && e.reason.stack || e.reason)));

const canvas = document.getElementById("game-canvas");
canvas.tabIndex = 0; // make canvas focusable so keyboard input lands on the game
const engine = new Engine(canvas);
const input = new Input(canvas);
const env = new Environment(engine.scene, engine.renderer);
const city = new City(engine.scene);

const loader = document.getElementById("loader");
const ldFill = document.getElementById("ld-fill");
const ldPct = document.getElementById("ld-pct");
const ldStage = document.getElementById("ld-stage");
const hudEl = document.getElementById("hud");
const menuEl = document.getElementById("menu");
const clickPlay = document.getElementById("click-to-play");

let started = false;
let bigOpen = false;
let player, traffic, peds, hud;
let fps = 60, fpsAcc = 0, fpsFrames = 0;

function setProgress(p, stage) {
  ldFill.style.width = Math.round(p * 100) + "%";
  ldPct.textContent = Math.round(p * 100) + "%";
  if (stage) ldStage.textContent = stage;
}

async function boot() {
  setProgress(0.08, "正在对齐台北街区坐标…");
  await city.ready;
  setProgress(0.35, "正在生成街廓与建筑…");
  await new Promise((r) => setTimeout(r, 30));
  setProgress(0.62, "正在布置店家招牌与街灯…");
  buildLandmarks(engine.scene, city);
  setProgress(0.78, "正在唤醒行人与车流…");
  traffic = new Traffic(engine.scene, city, 40);
  city.traffic = traffic;
  peds = new PedestrianCrowd(engine.scene, city, 240);
  player = new Player(engine.scene, engine.camera, city, engine.renderer);
  player.reset();
  await player.ready;
  hud = new Hud(city, player, env);
  window.__game = { engine, env, city, traffic, peds, player, hud };
  setProgress(1.0, "就绪");
  await new Promise((r) => setTimeout(r, 250));
  loader.classList.add("hidden");
  menuEl.classList.remove("hidden");
  engine.start();
}

// ---- UI wiring ----
document.getElementById("btn-start").addEventListener("click", startGame);
document.getElementById("btn-character").addEventListener("click", () => hud.showNotify("角色：阿杰 · 西门町长大，擅长骑车", 2600));
document.getElementById("btn-settings").addEventListener("click", () => hud.showNotify("设置：视角灵敏度 / 音量（示意）", 2600));
document.getElementById("bm-close").addEventListener("click", closeBigMap);
clickPlay.addEventListener("click", () => { canvas.focus(); input.requestLock(); });
// clicking the game view (re)focuses the canvas so keyboard input keeps working
canvas.addEventListener("pointerdown", () => canvas.focus());
// click the minimap to open / close the big map (same as pressing M)
document.getElementById("minimap").addEventListener("click", (e) => {
  e.stopPropagation();
  bigOpen ? closeBigMap() : openBigMap();
});

function startGame() {
  menuEl.classList.add("hidden");
  hudEl.classList.remove("hidden");
  started = true;
  player.setEnabled(true);
  canvas.focus();
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
  hud.showNotify("大台北地图 · WASD 平移 · 滚轮缩放 · M 关闭", 2600);
}
function closeBigMap() {
  bigOpen = false;
  bigmapEl().classList.add("hidden");
}
function bigmapEl() { return document.getElementById("bigmap"); }

// main update loop
engine.onUpdate((dt, time) => {
  env.update(dt, player ? player.pos : { x: -160, z: -24 });
  if (city.readyState) {
    city.update(dt, time, env.night);
    traffic.update(dt);
    peds.update(dt);
  }
  if (started) {
    if (input.pressed("KeyM")) { bigOpen ? closeBigMap() : openBigMap(); }
    if (bigOpen) {
      const pan = 30 * dt / (hud._bigZoom || 1);
      if (input.down("KeyW")) hud.panBig(0, -pan);
      if (input.down("KeyS")) hud.panBig(0, pan);
      if (input.down("KeyA")) hud.panBig(-pan, 0);
      if (input.down("KeyD")) hud.panBig(pan, 0);
    } else {
      player.update(dt, input);
      if (input.pressed("KeyF")) {
        if (player.driving) player.exit();
        else { const v = player.enterPrompt(); if (v) player.enter(v); }
      }
    }
    hud.update(dt, fps);
  }
  engine.bloom.strength = 0.32 + env.night * 0.6;
  input.update();
  window.__frames = (window.__frames || 0) + 1;
  window.__calls = engine.renderer.info.render.calls;
  window.__tris = engine.renderer.info.render.triangles;
  window.__visible = city.group.children.filter((o) => o.visible).length;

  fpsFrames++;
  fpsAcc += dt;
  if (fpsAcc >= 0.5) { fps = fpsFrames / fpsAcc; fpsAcc = 0; fpsFrames = 0; if (document.getElementById("fps")) document.getElementById("fps").classList.remove("hidden"); }
});

// big map zoom
canvas.addEventListener("wheel", (e) => {
  if (!bigOpen) return;
  hud.zoomBig(e.deltaY < 0 ? 1.12 : 0.89);
}, { passive: true });

boot();
