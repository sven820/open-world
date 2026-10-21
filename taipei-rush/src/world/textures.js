import * as THREE from "three";
import { SHOP_NAMES, SHOP_SUBS, SIGN_COLORS } from "../data/cityData.js";

export function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function canvasTexture(canvas, { repeat = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
  }
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

function noise(ctx, w, h, amount = 10, alpha = 0.05) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * amount;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

/* ---------------- facade variants ---------------- */
// Each tile = 2 bays x 2 floors. One bay 3.2m, one floor 3.2m.
const FACADE_VARIANTS = [
  { id: "old-tile",   base: "#cfc3ae", trim: "#b3a58f", glass: "#3a4652", grill: true,  balcony: false, ac: true,  floors: 2, bays: 2 },
  { id: "apt-grey",   base: "#b9b7b1", trim: "#9b9993", glass: "#42505e", grill: false, balcony: true,  ac: true,  floors: 2, bays: 2 },
  { id: "apt-cream",  base: "#e0d6c2", trim: "#c9bda5", glass: "#3d4b58", grill: true,  balcony: true,  ac: true,  floors: 2, bays: 2 },
  { id: "office-blue",base: "#7f95a8", trim: "#6a7f92", glass: "#264058", grill: false, balcony: false, ac: false, floors: 2, bays: 2, glassy: 1 },
  { id: "brick-red",  base: "#9c5a4a", trim: "#824838", glass: "#33414d", grill: true,  balcony: false, ac: true,  floors: 2, bays: 2 },
  { id: "white-mod",  base: "#e9e5db", trim: "#cfc9bd", glass: "#374b5c", grill: false, balcony: true,  ac: false, floors: 2, bays: 2 },
  { id: "tower-glass",base: "#5f7d92", trim: "#4d6a7e", glass: "#1e364a", grill: false, balcony: false, ac: false, floors: 2, bays: 2, glassy: 1 },
  { id: "beige-old",  base: "#c2ad8e", trim: "#a89375", glass: "#38434e", grill: true,  balcony: false, ac: true,  floors: 2, bays: 2 },
  { id: "grey-old",   base: "#a7a49d", trim: "#8d8a83", glass: "#333f4a", grill: true,  balcony: false, ac: true,  floors: 2, bays: 2 },
  { id: "pink-tile",  base: "#d3a69c", trim: "#b98b81", glass: "#3b4650", grill: true,  balcony: true,  ac: true,  floors: 2, bays: 2 },
  { id: "green-tile", base: "#9aa892", trim: "#829076", glass: "#35414b", grill: true,  balcony: false, ac: true,  floors: 2, bays: 2 },
  { id: "modern-sand",base: "#cbb99a", trim: "#b09e80", glass: "#31424f", grill: false, balcony: true,  ac: false, floors: 2, bays: 2 },
];

export function makeFacades() {
  return FACADE_VARIANTS.map((v, vi) => {
    const S = 512;
    const c = makeCanvas(S, S);
    const e = makeCanvas(S, S);
    const ctx = c.getContext("2d");
    const ex = e.getContext("2d");
    ex.fillStyle = "#000"; ex.fillRect(0, 0, S, S);

    // base wall
    ctx.fillStyle = v.base; ctx.fillRect(0, 0, S, S);
    // tile joints
    ctx.strokeStyle = "rgba(0,0,0,0.10)"; ctx.lineWidth = 1;
    for (let y = 0; y <= S; y += 16) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(S, y); ctx.stroke(); }
    for (let x = 0; x <= S; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, S); ctx.stroke(); }
    // floor slabs
    ctx.fillStyle = v.trim;
    for (let f = 0; f < v.floors; f++) {
      ctx.fillRect(0, (f * S) / v.floors, S, 9);
    }
    // grime streaks
    for (let i = 0; i < 26; i++) {
      const x = Math.random() * S;
      const g = ctx.createLinearGradient(0, 0, 0, S);
      g.addColorStop(0, "rgba(40,35,30,0.0)");
      g.addColorStop(1, "rgba(40,35,30,0.10)");
      ctx.fillStyle = g;
      ctx.fillRect(x, Math.random() * S * 0.5, 2 + Math.random() * 8, S);
    }

    const bayW = S / v.bays;
    const floorH = S / v.floors;
    for (let b = 0; b < v.bays; b++) {
      for (let f = 0; f < v.floors; f++) {
        const x0 = b * bayW;
        const y0 = f * floorH;
        const w = bayW * (v.glassy ? 0.92 : 0.6);
        const h = floorH * (v.glassy ? 0.9 : 0.56);
        const wx = x0 + (bayW - w) / 2;
        const wy = y0 + floorH * 0.22;

        // window recess
        if (!v.glassy) {
          ctx.fillStyle = "rgba(0,0,0,0.18)";
          ctx.fillRect(wx - 4, wy - 4, w + 8, h + 8);
        }
        // frame
        ctx.fillStyle = v.trim;
        ctx.fillRect(wx - 3, wy - 3, w + 6, h + 6);
        // glass
        const gg = ctx.createLinearGradient(wx, wy, wx + w, wy + h);
        gg.addColorStop(0, v.glass);
        gg.addColorStop(0.45, "#5f7d92");
        gg.addColorStop(0.55, v.glass);
        gg.addColorStop(1, "#22303c");
        ctx.fillStyle = gg;
        ctx.fillRect(wx, wy, w, h);
        // mullion
        ctx.strokeStyle = "rgba(20,24,30,0.55)"; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(wx + w / 2, wy); ctx.lineTo(wx + w / 2, wy + h);
        ctx.stroke();

        // balcony
        if (v.balcony && !v.glassy) {
          ctx.fillStyle = "rgba(220,215,205,0.85)";
          ctx.fillRect(wx - 6, wy + h + 4, w + 12, 7);
          ctx.fillStyle = "rgba(60,60,60,0.35)";
          for (let k = 0; k < 8; k++) ctx.fillRect(wx - 4 + k * ((w + 8) / 8), wy + h - 16, 2, 20);
        }
        // window grille
        if (v.grill && !v.glassy) {
          ctx.strokeStyle = "rgba(70,72,72,0.7)"; ctx.lineWidth = 2;
          for (let k = 1; k < 4; k++) {
            ctx.beginPath(); ctx.moveTo(wx + (w / 4) * k, wy); ctx.lineTo(wx + (w / 4) * k, wy + h); ctx.stroke();
          }
          ctx.beginPath(); ctx.moveTo(wx, wy + h / 2); ctx.lineTo(wx + w, wy + h / 2); ctx.stroke();
        }
        // AC unit
        if (v.ac && Math.random() < 0.6) {
          ctx.fillStyle = "#b8b7b2";
          ctx.fillRect(wx + w * 0.62, wy + h + 6, 26, 18);
          ctx.fillStyle = "#8e8d88";
          ctx.fillRect(wx + w * 0.62 + 3, wy + h + 9, 20, 12);
        }

        // emissive: some windows lit
        if (Math.random() < 0.42) {
          const warm = Math.random() < 0.78;
          const grad = ex.createLinearGradient(wx, wy, wx, wy + h);
          if (warm) { grad.addColorStop(0, "#ffd9a0"); grad.addColorStop(1, "#b97a45"); }
          else { grad.addColorStop(0, "#cfe6ff"); grad.addColorStop(1, "#7fa4c6"); }
          ex.fillStyle = grad;
          ex.fillRect(wx + 2, wy + 2, w - 4, h - 4);
          // curtains / silhouettes
          ex.fillStyle = "rgba(0,0,0,0.45)";
          if (Math.random() < 0.5) ex.fillRect(wx + 2, wy + 2, (w - 4) * (0.15 + Math.random() * 0.25), h - 4);
          if (Math.random() < 0.3) ex.fillRect(wx + w * 0.45, wy + h * 0.4, w * 0.2, h * 0.6);
        }
      }
    }
    noise(ctx, S, S, 12, 0.04);
    return {
      map: canvasTexture(c),
      emissive: canvasTexture(e),
      id: v.id,
      base: v.base,
    };
  });
}

/* ---------------- storefronts ---------------- */
// tile 256x256 = one bay (~6m wide, 4m tall)
const STOREFRONT_STYLES = [
  { id: "convenience", glass: "#dfe9e4", light: "#eafff2", accent: "#2f9e5f", warm: 0.55 },
  { id: "cafe",        glass: "#3a2a22", light: "#ffca8a", accent: "#c98a4b", warm: 0.95 },
  { id: "fashion",     glass: "#2a2430", light: "#ffd0e6", accent: "#e04a8a", warm: 0.8 },
  { id: "restaurant",  glass: "#2c1f1a", light: "#ffb066", accent: "#d0402a", warm: 1.0 },
  { id: "pharmacy",    glass: "#e8f2f0", light: "#d8fff4", accent: "#1f9e8f", warm: 0.5 },
  { id: "salon",       glass: "#2a2230", light: "#e6c6ff", accent: "#8a4ad0", warm: 0.7 },
  { id: "bakery",      glass: "#3a2c20", light: "#ffd29a", accent: "#d08a3a", warm: 0.95 },
  { id: "electronics", glass: "#1e2630", light: "#9fd8ff", accent: "#2a6ad0", warm: 0.55 },
  { id: "shutter",     glass: "#8f8f8b", light: "#222222", accent: "#777", warm: 0.0 },
];

export function makeStorefronts() {
  return STOREFRONT_STYLES.map((v) => {
    const S = 256;
    const c = makeCanvas(S, S);
    const e = makeCanvas(S, S);
    const ctx = c.getContext("2d");
    const ex = e.getContext("2d");
    ctx.fillStyle = v.glass; ctx.fillRect(0, 0, S, S);
    ex.fillStyle = "#000"; ex.fillRect(0, 0, S, S);

    if (v.id === "shutter") {
      ctx.fillStyle = "#9a9a96"; ctx.fillRect(0, 0, S, S);
      ctx.strokeStyle = "rgba(0,0,0,0.18)";
      for (let y = 0; y < S; y += 7) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(S, y); ctx.stroke(); }
      ctx.fillStyle = "rgba(0,0,0,0.18)"; ctx.fillRect(0, S - 18, S, 18);
    } else {
      // interior warm wash
      const g = ctx.createLinearGradient(0, 0, 0, S);
      g.addColorStop(0, v.light); g.addColorStop(0.35, v.glass); g.addColorStop(1, "#12100e");
      ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);

      // glass panels
      ctx.strokeStyle = "rgba(10,14,18,0.65)"; ctx.lineWidth = 4;
      ctx.strokeRect(10, 22, S - 20, S - 46);
      ctx.beginPath(); ctx.moveTo(S * 0.62, 22); ctx.lineTo(S * 0.62, S - 24); ctx.stroke();
      // door
      ctx.fillStyle = "rgba(20,24,28,0.55)";
      ctx.fillRect(S * 0.66, 52, S * 0.26, S - 78);
      // reflections
      ctx.fillStyle = "rgba(255,255,255,0.10)";
      ctx.beginPath(); ctx.moveTo(20, 30); ctx.lineTo(90, 30); ctx.lineTo(40, S - 30); ctx.lineTo(16, S - 30); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(130, 30); ctx.lineTo(160, 30); ctx.lineTo(110, S - 30); ctx.lineTo(96, S - 30); ctx.closePath(); ctx.fill();

      // emissive interior
      const eg = ex.createLinearGradient(0, 0, 0, S);
      eg.addColorStop(0, v.light); eg.addColorStop(0.5, v.warm > 0.4 ? "#8a5a2a" : "#2a4a5a"); eg.addColorStop(1, "#000000");
      ex.fillStyle = eg; ex.globalAlpha = 0.9; ex.fillRect(12, 24, S - 24, S - 50); ex.globalAlpha = 1;
      // interior shelves / silhouettes
      ex.fillStyle = "rgba(0,0,0,0.55)";
      for (let i = 0; i < 4; i++) ex.fillRect(20, 70 + i * 30, S - 40, 6);
      // ceiling strip light
      ex.fillStyle = "#fff4d6"; ex.fillRect(14, 26, S - 28, 6);
      // accent band
      ctx.fillStyle = v.accent; ctx.fillRect(0, S - 16, S, 16);
      ex.fillStyle = v.accent; ex.globalAlpha = 0.6; ex.fillRect(0, S - 16, S, 16); ex.globalAlpha = 1;
    }
    noise(ctx, S, S, 8, 0.04);
    return { map: canvasTexture(c), emissive: canvasTexture(e), id: v.id, accent: v.accent };
  });
}

/* ---------------- sign atlas ---------------- */
// horizontal signs: rows 0-7 (8x8 = 64), vertical signs: rows 8-15
export const SIGN_ATLAS_COLS = 8;
export const SIGN_ATLAS_ROWS = 16;
export const SIGN_TILE = 256;

export function makeSignAtlas() {
  const W = SIGN_ATLAS_COLS * SIGN_TILE;
  const H = SIGN_ATLAS_ROWS * SIGN_TILE;
  const c = makeCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#111"; ctx.fillRect(0, 0, W, H);

  let idx = 0;
  const horizontal = SHOP_NAMES.length;
  const vertical = SHOP_NAMES.length;

  const font = '"PingFang TC","Noto Sans TC","Microsoft JhengHei","Heiti TC",sans-serif';

  // horizontal (rows 0..7), 64 tiles
  for (let i = 0; i < 64; i++) {
    const col = i % 8, row = Math.floor(i / 8);
    const x = col * SIGN_TILE, y = row * SIGN_TILE;
    const name = SHOP_NAMES[i % SHOP_NAMES.length];
    const bg = SIGN_COLORS[(i * 5 + 3) % SIGN_COLORS.length];
    const dark = bg === "#111111" || bg === "#0f766e" || bg === "#b91c1c";
    ctx.fillStyle = bg; ctx.fillRect(x, y, SIGN_TILE, SIGN_TILE);
    // border
    ctx.strokeStyle = dark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.35)";
    ctx.lineWidth = 10; ctx.strokeRect(x + 8, y + 8, SIGN_TILE - 16, SIGN_TILE - 16);
    // big name
    ctx.fillStyle = dark ? "#ffffff" : "#161616";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    let fs = 92;
    ctx.font = `900 ${fs}px ${font}`;
    while (ctx.measureText(name).width > SIGN_TILE - 34 && fs > 34) { fs -= 4; ctx.font = `900 ${fs}px ${font}`; }
    ctx.fillText(name, x + SIGN_TILE / 2, y + SIGN_TILE * 0.46);
    // sub line
    ctx.font = `600 26px ${font}`;
    ctx.globalAlpha = 0.8;
    ctx.fillText(SHOP_SUBS[i % SHOP_SUBS.length], x + SIGN_TILE / 2, y + SIGN_TILE * 0.78);
    ctx.globalAlpha = 1;
  }

  // vertical signs (rows 8..15), 64 tiles, text stacked
  for (let i = 0; i < 64; i++) {
    const col = i % 8, row = 8 + Math.floor(i / 8);
    const x = col * SIGN_TILE, y = row * SIGN_TILE;
    const name = SHOP_NAMES[(i + 7) % SHOP_NAMES.length];
    const bg = SIGN_COLORS[(i * 3 + 6) % SIGN_COLORS.length];
    const dark = bg === "#111111" || bg === "#0f766e" || bg === "#b91c1c";
    ctx.fillStyle = bg; ctx.fillRect(x, y, SIGN_TILE, SIGN_TILE);
    ctx.strokeStyle = dark ? "rgba(255,255,255,0.6)" : "rgba(0,0,0,0.4)";
    ctx.lineWidth = 10; ctx.strokeRect(x + 8, y + 8, SIGN_TILE - 16, SIGN_TILE - 16);
    ctx.fillStyle = dark ? "#ffffff" : "#151515";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const chars = [...name].slice(0, 4);
    const n = chars.length;
    const fs = n <= 2 ? 86 : n === 3 ? 70 : 58;
    ctx.font = `900 ${fs}px ${font}`;
    for (let k = 0; k < n; k++) {
      ctx.fillText(chars[k], x + SIGN_TILE / 2, y + SIGN_TILE * ((k + 0.5) / n));
    }
  }

  const tex = canvasTexture(c, { repeat: false });
  tex.anisotropy = 4;
  return tex;
}

// tile rect (u0,v0,u1,v1) in Three UV space (v flipped)
export function signTileRect(index) {
  const col = index % SIGN_ATLAS_COLS;
  const row = Math.floor(index / SIGN_ATLAS_COLS);
  const w = 1 / SIGN_ATLAS_COLS;
  const h = 1 / SIGN_ATLAS_ROWS;
  const u0 = col * w;
  const v1 = 1 - row * h;
  return { u0, v0: v1 - h, u1: u0 + w, v1 };
}

/* ---------------- ground textures ---------------- */
export function makeSidewalkTexture() {
  const S = 1024;
  const c = makeCanvas(S, S);
  const ctx = c.getContext("2d");
  // light, clean concrete base (like the original's bright sidewalk)
  ctx.fillStyle = "#d6d2ca"; ctx.fillRect(0, 0, S, S);
  // large square pavers (1m each, 4x4 per 4m texture) with barely-there tone shift
  const n = 4, step = S / n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = 198 + Math.random() * 17;
      ctx.fillStyle = `rgb(${v},${v - 3},${v - 9})`;
      ctx.fillRect(x * step, y * step, step, step);
    }
  }
  // very fine, low-contrast stone speckle
  for (let i = 0; i < 16000; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    const v = 178 + Math.random() * 66;
    ctx.fillStyle = `rgba(${v},${v - 2},${v - 7},${0.02 + Math.random() * 0.035})`;
    ctx.fillRect(x, y, 1, 1 + Math.random());
  }
  // thin, soft expansion seams every 1m (seam on tile edges → continuous across repeats)
  ctx.strokeStyle = "rgba(126,122,113,0.34)"; ctx.lineWidth = 2;
  for (let i = 0; i <= n; i++) {
    const p = i * step;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, S); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(S, p); ctx.stroke();
  }
  // subtle bevel highlight just inside each seam
  ctx.strokeStyle = "rgba(255,255,255,0.16)"; ctx.lineWidth = 1;
  for (let i = 0; i <= n; i++) {
    const p = i * step + 2;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, S); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(S, p); ctx.stroke();
  }
  return canvasTexture(c);
}

export function makeAsphaltTexture() {
  const S = 1024;
  const c = makeCanvas(S, S);
  const ctx = c.getContext("2d");
  // clean medium-grey asphalt (matches the original's smooth road)
  ctx.fillStyle = "#5b5d61"; ctx.fillRect(0, 0, S, S);
  // very fine, subtle grain only — no stains, cracks or heavy speckle
  for (let i = 0; i < 24000; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    const v = 64 + Math.random() * 88;
    ctx.fillStyle = `rgba(${v},${v},${v + 3},${0.02 + Math.random() * 0.05})`;
    const s = 1 + Math.random() * 1.6;
    ctx.fillRect(x, y, s, s);
  }
  // barely-visible large tonal variation so it isn't dead flat
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * S, y = Math.random() * S, r = 90 + Math.random() * 220;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, "rgba(255,255,255,0.012)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
  }
  return canvasTexture(c);
}

export function makeRoofTexture() {
  const S = 256;
  const c = makeCanvas(S, S);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#7e7b74"; ctx.fillRect(0, 0, S, S);
  noise(ctx, S, S, 20, 0.05);
  ctx.strokeStyle = "rgba(40,38,34,0.3)"; ctx.lineWidth = 2;
  for (let i = 0; i < 6; i++) { ctx.beginPath(); ctx.moveTo(0, i * 44); ctx.lineTo(S, i * 44); ctx.stroke(); }
  for (let i = 0; i < 30; i++) {
    ctx.fillStyle = `rgba(60,58,54,${0.05 + Math.random() * 0.1})`;
    ctx.fillRect(Math.random() * S, Math.random() * S, 4 + Math.random() * 30, 3 + Math.random() * 10);
  }
  return canvasTexture(c);
}

export function makeTileStripTexture() {
  // tactile paving yellow strip
  const S = 128;
  const c = makeCanvas(S, S);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#d9a526"; ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = "rgba(120,85,10,0.5)";
  for (let y = 8; y < S; y += 24) for (let x = 8; x < S; x += 24) ctx.fillRect(x, y, 10, 10);
  return canvasTexture(c);
}
