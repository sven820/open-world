import { districtAt } from "../data/cityData.js";

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
    const x = c.getContext("2d");
    x.fillStyle = "#0c1218"; x.fillRect(0, 0, this.MM, this.MM);
    for (const bl of this.city.blocks) {
      const x0 = this._wx(bl.x0), x1 = this._wx(bl.x1);
      const z0 = this._wz(bl.z0), z1 = this._wz(bl.z1);
      x.fillStyle = "#1a222c";
      x.fillRect(x0, z0, x1 - x0, z1 - z0);
    }
    x.strokeStyle = "#3a4654";
    x.lineWidth = 2;
    for (const r of this.city.roadsX) { x.beginPath(); x.moveTo(this._wx(r.at), 0); x.lineTo(this._wx(r.at), this.MM); x.stroke(); }
    for (const r of this.city.roadsZ) { x.beginPath(); x.moveTo(0, this._wz(r.at)); x.lineTo(this.MM, this._wz(r.at)); x.stroke(); }
    x.strokeStyle = "#566375";
    x.lineWidth = 3.4;
    for (const r of this.city.roadsX) if (r.kind !== "street") { x.beginPath(); x.moveTo(this._wx(r.at), 0); x.lineTo(this._wx(r.at), this.MM); x.stroke(); }
    for (const r of this.city.roadsZ) if (r.kind !== "street") { x.beginPath(); x.moveTo(0, this._wz(r.at)); x.lineTo(this.MM, this._wz(r.at)); x.stroke(); }
    x.fillStyle = "#d94a4a";
    for (const l of this.city.landmarks) { x.beginPath(); x.arc(this._wx(l.x), this._wz(l.z), 3, 0, 7); x.fill(); }
    this.staticMap = c;
  }

  showNotify(text, ms = 2400) {
    this.elNotify.textContent = text;
    this.elNotify.classList.add("show");
    clearTimeout(this._nt);
    this._nt = setTimeout(() => this.elNotify.classList.remove("show"), ms);
  }

  update(dt, fps) {
    const h = this.env.hour;
    const hh = Math.floor(h);
    const mm = Math.floor((h - hh) * 60);
    this.elTime.textContent = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    const night = this.env.night;
    this.elWeather.textContent = night > 0.5 ? "夜" : "晴";

    const d = districtAt(this.player.pos.x, this.player.pos.z);
    if (this._lastD !== d.id) {
      this._lastD = d.id;
      this.elDistrictZh.textContent = d.zh;
      this.elDistrictEn.textContent = d.en;
      this.elDistrictSub.textContent = d.sub;
    }

    if (this.player.driving) {
      const kmh = Math.abs(this.player.driveSpeed) * 3.6 * 1.7;
      this.elSpeed.textContent = Math.round(kmh) + " km/h";
      this.elMode.textContent = this.player.inVehicle?.kind === "scooter" ? "機車" : "汽車";
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

    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.MM, this.MM);
    ctx.save();
    ctx.beginPath(); ctx.arc(this.MM / 2, this.MM / 2, this.R + 2, 0, 7); ctx.clip();
    ctx.drawImage(this.staticMap, 0, 0);
    if (this.city.traffic) {
      for (const ve of this.city.traffic.vehicles) {
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

    if (this.bigmapEl && !this.bigmapEl.classList.contains("hidden")) this._drawBig();

    if (this.fpsEl) this.fpsEl.textContent = "FPS " + fps.toFixed(0) + " · " + Math.round(this.player.pos.x) + "," + Math.round(this.player.pos.z);
  }

  panBig(dx, dz) {
    if (!this._bigScale) this._drawBig();
    this._bigCx -= dx; this._bigCz -= dz;
  }
  zoomBig(f) {
    this._bigZoom = Math.max(0.5, Math.min(6, (this._bigZoom || 1) * f));
  }

  _drawBig() {
    const cv = this.bigCanvas, ctx = this.bigCtx;
    const W = cv.width, H = cv.height;
    if (!this._bigScale) { this._bigScale = Math.min(W, H) / Math.max(this.b.maxX - this.b.minX, this.b.maxZ - this.b.minZ) * 0.92; this._bigCx = (this.b.minX + this.b.maxX) / 2; this._bigCz = (this.b.minZ + this.b.maxZ) / 2; }
    const sc = this._bigScale * (this._bigZoom || 1);
    const wx = (x) => W / 2 + (x - this._bigCx) * sc;
    const wz = (z) => H / 2 + (z - this._bigCz) * sc;
    ctx.fillStyle = "#070b10"; ctx.fillRect(0, 0, W, H);
    for (const bl of this.city.blocks) {
      ctx.fillStyle = "#171f29";
      ctx.fillRect(wx(bl.x0), wz(bl.z0), (bl.x1 - bl.x0) * sc, (bl.z1 - bl.z0) * sc);
    }
    ctx.strokeStyle = "#454f5e"; ctx.lineWidth = 1.4;
    for (const r of this.city.roadsX) { ctx.beginPath(); ctx.moveTo(wx(r.at), 0); ctx.lineTo(wx(r.at), H); ctx.stroke(); }
    for (const r of this.city.roadsZ) { ctx.beginPath(); ctx.moveTo(0, wz(r.at)); ctx.lineTo(W, wz(r.at)); ctx.stroke(); }
    ctx.fillStyle = "#d94a4a";
    for (const l of this.city.landmarks) { ctx.beginPath(); ctx.arc(wx(l.x), wz(l.z), 4, 0, 7); ctx.fill(); }
    const px = wx(this.player.pos.x), pz = wz(this.player.pos.z);
    ctx.fillStyle = "#a8ffb0";
    ctx.beginPath(); ctx.arc(px, pz, 5, 0, 7); ctx.fill();
    if (this.bigPosEl) this.bigPosEl.textContent = `${districtAt(this.player.pos.x, this.player.pos.z).zh} · X ${Math.round(this.player.pos.x)} Z ${Math.round(this.player.pos.z)}`;
  }
}
