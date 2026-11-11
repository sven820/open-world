import { activeDistricts, activeLandmarks, activeRoadsX, activeRoadsZ, activeSpawn, districtAt } from "../data/cityData.js";
import { getRenderSettings } from "../config/renderSettings.js";
import { drawMap2d, editorGrid } from "./mapView2d.js";

export class Hud {
  constructor(city, player, environment) {
    this.city = city;
    this.player = player;
    this.env = environment;

    this.elTime = document.getElementById("hud-time");
    this.elWeather = document.getElementById("hud-weather");
    this.elMoney = document.getElementById("hud-money");
    this.elDistrictZh = document.getElementById("hud-district-zh");
    this.elDistrictEn = document.getElementById("hud-district-en");
    this.elDistrictSub = document.getElementById("hud-district-sub");
    this.elHp = document.getElementById("hud-hp");
    this.elSpeed = document.getElementById("hud-speed");
    this.elMode = document.getElementById("hud-mode");
    this.elPrompt = document.getElementById("hud-prompt");
    this.elNotify = document.getElementById("notify");
    this.canvas = document.getElementById("minimap");
    this.ctx = this.canvas.getContext("2d");
    this.bigCanvas = document.getElementById("bigmap-canvas");
    this.bigCtx = this.bigCanvas.getContext("2d");
    this.bigmapEl = document.getElementById("bigmap");
    this.bigPosEl = document.getElementById("bm-pos");
    this.fpsEl = document.getElementById("fps");

    // 大地图内容复用 2D 地图编辑器的绘制（只读预览）：取当前激活地图数据。
    // 默认街区没有存储的地图对象，用 cityData 的激活数据拼一个同构结构
    //（extRoads 与 city.js 的默认行为一致：无自定义地图时延伸街道开启）
    this.mapData = city.data || {
      roadsX: activeRoadsX(), roadsZ: activeRoadsZ(),
      districts: activeDistricts(), landmarks: activeLandmarks(),
      spawn: activeSpawn(), extRoads: true,
      features: null, objects: [], area: null,
    };
    this._mapGrid = editorGrid(this.mapData); // 延伸路网派生只算一次（30Hz 重绘共用）

    // big map mouse interaction state
    this._bigRot = 0;       // map view rotation (radians), like open-world game maps
    this._bmDrag = null;    // { x, y, btn } while dragging on the big map
    this._bindBigMapMouse();

    this.MM = 220;
    this.R = 104;
    this.b = city.bounds;
    this.cx = (this.b.minX + this.b.maxX) / 2;
    this.cz = (this.b.minZ + this.b.maxZ) / 2;
    this.scale = (2 * this.R) / Math.max(this.b.maxX - this.b.minX, this.b.maxZ - this.b.minZ);
    this._buildStatic();
  }

  _wx(x) { return this.MM / 2 + (x - this.cx) * this.scale; }
  _wz(z) { return this.MM / 2 + (z - this.cz) * this.scale; }

  _buildStatic() {
    const c = document.createElement("canvas");
    c.width = this.MM; c.height = this.MM;
    // 静态底图与大地图共用同一套 2D 编辑器渲染（mapView2d，只读预览）：
    // 街廓/道路/描边道路/河流/拼接路块/建筑/树木/地标显示全部一致；
    // 小地图视野小，hideLabels 隐藏文字标注只留图形
    drawMap2d(c.getContext("2d"), this.MM, this.MM, this.mapData,
      { x: this.cx, z: this.cz, scale: this.scale },
      { grid: this._mapGrid, showLegend: false, showCompass: false, hideLabels: true });
    this.staticMap = c;
  }

  showNotify(text, ms = 2400) {
    this.elNotify.textContent = text;
    this.elNotify.classList.add("show");
    clearTimeout(this._nt);
    this._nt = setTimeout(() => this.elNotify.classList.remove("show"), ms);
  }

  update(dt, fps) {
    // HUD 是 2D canvas + DOM：小地图每帧整块重绘（220² + 静态底图 + 车流点）没必要，
    // 按设置的刷新率降频；车速/上车提示这类"跟手"信息仍每帧更新。
    const interval = 1 / Math.max(4, getRenderSettings().hudFps || 12);
    this._acc = (this._acc || 0) + dt;
    const slow = this._acc >= interval;
    if (slow) this._acc = 0;

    if (this.player.driving) {
      const kmh = Math.abs(this.player.driveSpeed) * 3.6 * 1.7;
      this.elSpeed.textContent = Math.round(kmh) + " km/h";
      this.elMode.textContent = this.player.inVehicle?.kind === "scooter" ? "摩托车" : "汽车";
      document.getElementById("speedo").classList.remove("hidden");
      document.getElementById("sp-num").textContent = Math.round(kmh);
      const arc = document.getElementById("sp-arc");
      arc.style.strokeDasharray = `${Math.min(245, kmh * 1.4)} 327`;
    } else {
      this.elSpeed.textContent = "徒步";
      this.elMode.textContent = "ON FOOT";
      document.getElementById("speedo").classList.add("hidden");
    }

    const v = this.player.enterPrompt();
    if (v && !this.player.driving) this.elPrompt.classList.remove("hidden");
    else this.elPrompt.classList.add("hidden");

    // 大地图打开时单独按 30Hz 重绘：比 HUD 常规刷新跟手，拖动/滚轮另有即时重绘
    if (this.bigmapEl && !this.bigmapEl.classList.contains("hidden")) {
      this._bigAcc = (this._bigAcc || 0) + dt;
      if (this._bigAcc >= 1 / 30) {
        this._bigAcc = 0;
        this._drawBig();
      }
    }

    // 以下都是低频信息：时钟 / 区名 / 小地图 / FPS 读数
    if (!slow) return;

    const h = this.env.hour;
    const hh = Math.floor(h);
    const mm = Math.floor((h - hh) * 60);
    this.elTime.textContent = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    this.elWeather.textContent = this.env.night > 0.5 ? "夜" : "晴";

    const d = districtAt(this.player.pos.x, this.player.pos.z);
    if (this._lastD !== d.id) {
      this._lastD = d.id;
      this.elDistrictZh.textContent = d.zh;
      this.elDistrictEn.textContent = d.en;
      this.elDistrictSub.textContent = d.sub;
    }

    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.MM, this.MM);
    ctx.save();
    ctx.beginPath(); ctx.arc(this.MM / 2, this.MM / 2, this.R + 2, 0, 7); ctx.clip();
    ctx.drawImage(this.staticMap, 0, 0);
    if (this.city.traffic) {
      const vs = this.city.traffic.vehicles;
      const n = this.city.traffic.active ?? vs.length;
      for (let i = 0; i < n; i++) {
        const ve = vs[i];
        const mx = this._wx(ve.group.position.x), mz = this._wz(ve.group.position.z);
        ctx.fillStyle = ve.kind === "scooter" ? "#7fd6ff" : ve.kind === "bus" ? "#ffd24a" : "#ff7a7a";
        ctx.fillRect(mx - 1, mz - 1, 2.2, 2.2);
      }
    }
    const px = this._wx(this.player.pos.x), pz = this._wz(this.player.pos.z);
    const yaw = this.player.driving ? this.player.driveYaw : this.player.facing;
    ctx.save();
    ctx.translate(px, pz);
    ctx.rotate(-yaw + Math.PI);
    ctx.fillStyle = "#a8ffb0";
    ctx.beginPath();
    ctx.moveTo(0, -6); ctx.lineTo(4, 5); ctx.lineTo(-4, 5); ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.restore();

    if (this.fpsEl) this.fpsEl.textContent = "FPS " + fps.toFixed(0) + " · " + Math.round(this.player.pos.x) + "," + Math.round(this.player.pos.z);
  }

  panBig(dx, dz) {
    if (!this._bigScale) this._drawBig();
    this._bigCx -= dx; this._bigCz -= dz;
  }
  zoomBig(f) {
    this._bigZoom = Math.max(0.12, Math.min(8, (this._bigZoom || 1) * f));
  }
  rotateBig(d) { this._bigRot += d; }

  _bindBigMapMouse() {
    const cv = this.bigCanvas;
    const overlay = this.bigmapEl;
    overlay.style.cursor = "grab";
    // keep handler references so dispose() can remove them (world rebuild)
    this._bh = {
      ctx: (e) => e.preventDefault(),
      down: (e) => {
        this._bmDrag = { x: e.clientX, y: e.clientY, btn: e.button };
        overlay.style.cursor = e.button === 2 ? "crosshair" : "grabbing";
      },
      up: () => {
        this._bmDrag = null;
        overlay.style.cursor = "grab";
      },
      move: (e) => {
        if (!this._bmDrag) return;
        const dx = e.clientX - this._bmDrag.x;
        const dy = e.clientY - this._bmDrag.y;
        this._bmDrag.x = e.clientX; this._bmDrag.y = e.clientY;
        if (!this._bigScale) this._drawBig();
        const sc = this._bigScale * (this._bigZoom || 1);
        const rect = cv.getBoundingClientRect();
        const kx = cv.width / rect.width;   // CSS px → canvas px
        const ky = cv.height / rect.height;
        if (this._bmDrag.btn === 2) {
          // right button (hold) → rotate the map view (open-world style)
          this._bigRot += dx * 0.006;
        } else {
          // left-drag → pan; convert screen delta to world delta (inverse of map rotation)
          const c = Math.cos(-this._bigRot), s = Math.sin(-this._bigRot);
          const cdx = dx * kx, cdy = dy * ky;
          this._bigCx -= (c * cdx - s * cdy) / sc;
          this._bigCz -= (s * cdx + c * cdy) / sc;
        }
        // 拖动期间立即重绘（HUD 常规刷新已降频，交互必须跟手）
        this._drawBig();
      },
      wheel: (e) => {
        e.preventDefault();
        if (!this._bigScale) this._drawBig();
        // 以光标为锚点缩放：缩放前后光标下的那个世界点保持不动（专业地图手感）
        const rect = cv.getBoundingClientRect();
        const px = (e.clientX - rect.left) * (cv.width / rect.width);
        const py = (e.clientY - rect.top) * (cv.height / rect.height);
        const c = Math.cos(this._bigRot), s = Math.sin(this._bigRot);
        const dx = px - cv.width / 2, dy = py - cv.height / 2;
        const rx = c * dx + s * dy;          // 光标的反旋转偏移（世界方向 * sc）
        const ry = -s * dx + c * dy;
        const dy0 = Math.max(-200, Math.min(200, e.deltaY));
        const sc0 = this._bigScale * (this._bigZoom || 1);
        this.zoomBig(Math.exp(-dy0 * 0.0015));
        const sc1 = this._bigScale * (this._bigZoom || 1);
        if (sc1 !== sc0) {
          this._bigCx += rx / sc0 - rx / sc1;
          this._bigCz += ry / sc0 - ry / sc1;
        }
        this._drawBig();   // 滚轮缩放同样要即时反馈
      },
    };
    overlay.addEventListener("contextmenu", this._bh.ctx);
    overlay.addEventListener("mousedown", this._bh.down);
    window.addEventListener("mouseup", this._bh.up);
    window.addEventListener("mousemove", this._bh.move);
    overlay.addEventListener("wheel", this._bh.wheel, { passive: false });
  }

  dispose() {
    if (!this._bh) return;
    this.bigmapEl.removeEventListener("contextmenu", this._bh.ctx);
    this.bigmapEl.removeEventListener("mousedown", this._bh.down);
    window.removeEventListener("mouseup", this._bh.up);
    window.removeEventListener("mousemove", this._bh.move);
    this.bigmapEl.removeEventListener("wheel", this._bh.wheel);
    this._bh = null;
  }

  _drawBig() {
    const cv = this.bigCanvas, ctx = this.bigCtx;
    const W = cv.width, H = cv.height;
    if (!this._bigScale) { this._bigScale = Math.min(W, H) / Math.max(this.b.maxX - this.b.minX, this.b.maxZ - this.b.minZ) * 0.92; this._bigCx = (this.b.minX + this.b.maxX) / 2; this._bigCz = (this.b.minZ + this.b.maxZ) / 2; }
    const sc = this._bigScale * (this._bigZoom || 1);
    ctx.save();
    ctx.fillStyle = "#0b1014"; ctx.fillRect(0, 0, W, H);
    // rotate the whole map around the screen center
    ctx.translate(W / 2, H / 2);
    ctx.rotate(this._bigRot);
    ctx.translate(-W / 2, -H / 2);
    // 地图内容直接复用 2D 地图编辑器的绘制（只读预览：不传 selected，
    // 关闭图例/罗盘，不可点选编辑）；玩家位置与指北针仍由 HUD 叠加
    drawMap2d(ctx, W, H, this.mapData, { x: this._bigCx, z: this._bigCz, scale: sc },
      { grid: this._mapGrid, showLegend: false, showCompass: false });
    const px = W / 2 + (this.player.pos.x - this._bigCx) * sc;
    const pz = H / 2 + (this.player.pos.z - this._bigCz) * sc;
    ctx.fillStyle = "#a8ffb0";
    ctx.beginPath(); ctx.arc(px, pz, 5, 0, 7); ctx.fill();
    ctx.restore();
    // rotating north compass (shows current view angle)
    const cx = 46, cy = 46, R = 22;
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(this._bigRot);
    ctx.strokeStyle = "rgba(255,255,255,.5)"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, 7); ctx.stroke();
    ctx.fillStyle = "#d94a4a"; ctx.beginPath();
    ctx.moveTo(0, -R + 4); ctx.lineTo(6, 4); ctx.lineTo(-6, 4); ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.fillStyle = "rgba(255,255,255,.7)"; ctx.font = "600 11px 'Noto Sans SC', sans-serif"; ctx.textAlign = "center";
    ctx.fillText("N", cx, cy + R + 14);
    ctx.textAlign = "left";
    if (this.bigPosEl) this.bigPosEl.textContent = `${districtAt(this.player.pos.x, this.player.pos.z).zh} · X ${Math.round(this.player.pos.x)} Z ${Math.round(this.player.pos.z)}`;
  }
}
