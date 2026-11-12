import * as THREE from "three/webgpu";
import { makeCanvas, canvasTexture } from "../textures.js";
import { SHOP_NAMES, SHOP_SUBS } from "../../data/cityData.js";
import { defaultContent, normalizeContent, DEFAULT_TEXT } from "./contentConfig.js";
import { makeModel3D } from "./content3d.js";

/* ---------------- 广告大屏内容源 ----------------
 * 文字类（内置广告 / 滚动字幕 / 时钟）按屏比重新排版，字号按可用宽度收缩，不会裁切。
 * 媒体类（图片 / 视频 / 直播）：
 *   - contain / auto   → CanvasTexture，按 fit 绘制（可留黑边、可显示失败海报）
 *   - cover / stretch  → THREE.VideoTexture 零拷贝快路径（UV 变换实现裁切/拉伸）
 *   - 视频绘制用 requestVideoFrameCallback 按真实帧率，无轮询浪费
 *   - HLS(m3u8) 经 hls.js 低延迟播放；Safari 走原生 HLS
 *   - 失败自动切备用海报，永不黑屏
 * 池带 setActive（远距暂停解码）与 setAudio（音频策略）控制接口。
 ---------------------------------------------------------------------- */

const BASE_H = 512;
const SANS = "'Noto Sans SC', 'Microsoft YaHei', sans-serif";
const TIME_FONT = "'Segoe UI', 'Microsoft YaHei', sans-serif";

function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function fitFont(ctx, text, maxW, px, weight, family) {
  let size = Math.max(8, Math.round(px));
  ctx.font = `${weight} ${size}px ${family}`;
  const w = ctx.measureText(text).width;
  if (w > maxW && w > 0) {
    size = Math.max(8, Math.floor(size * maxW / w));
    ctx.font = `${weight} ${size}px ${family}`;
  }
  return size;
}

function drawFitted(ctx, img, W, H, fit, sw, sh) {
  ctx.fillStyle = "#080b12";
  ctx.fillRect(0, 0, W, H);
  if (!sw || !sh) return;
  const mode = fit === "auto" ? "contain" : fit;
  if (mode === "stretch") { ctx.drawImage(img, 0, 0, W, H); return; }
  const s = mode === "cover" ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
  const dw = sw * s, dh = sh * s;
  ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

function placeholder(ctx, W, H, line) {
  ctx.fillStyle = "#0b1018"; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(46,196,230,.5)"; ctx.lineWidth = 4;
  ctx.strokeRect(6, 6, W - 12, H - 12);
  ctx.fillStyle = "#8fd8e8"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  fitFont(ctx, line, W * 0.88, Math.min(34, H * 0.09), "600", SANS);
  ctx.fillText(line, W / 2, H / 2);
  ctx.textAlign = "left";
}

function canvasItem(W, H) {
  const c = makeCanvas(W, H);
  const ctx = c.getContext("2d");
  const tex = canvasTexture(c, { repeat: false, aniso: 8 });
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return {
    c, ctx, tex,
    flush() { tex.needsUpdate = true; },
    dispose() { tex.dispose(); },
  };
}

const AD_PALETTES = [
  { bg: ["#132a4a", "#2c5364"], fg: "#ffffff", accent: "#37e6d5" },
  { bg: ["#3b0d2e", "#8a1f4d"], fg: "#ffe9f3", accent: "#ffd23f" },
  { bg: ["#0d2b1e", "#1f6e4e"], fg: "#eafff3", accent: "#ffd23f" },
  { bg: ["#2b1206", "#a34a17"], fg: "#fff3e6", accent: "#3ddc97" },
  { bg: ["#16161f", "#3d3d5c"], fg: "#f2f2ff", accent: "#ff3d8b" },
  { bg: ["#4a3f2c", "#8a7a56"], fg: "#fdf3dd", accent: "#37e6d5" },
];
const BADGES = ["新品上市", "限时 8 折", "今日特惠", "全场 5 折起", "会员日", "开业酬宾"];

function paintAd(ctx, W, H, seed) {
  const r = rng(seed);
  const p = AD_PALETTES[(r() * AD_PALETTES.length) | 0];
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, p.bg[0]); g.addColorStop(1, p.bg[1]);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  ctx.globalAlpha = 0.18;
  ctx.fillStyle = p.accent;
  ctx.beginPath();
  ctx.moveTo(W * 0.55, 0); ctx.lineTo(W, 0); ctx.lineTo(W, H * 0.7); ctx.closePath(); ctx.fill();
  ctx.globalAlpha = 0.1;
  ctx.beginPath();
  ctx.moveTo(0, H); ctx.lineTo(0, H * 0.55); ctx.lineTo(W * 0.4, H); ctx.closePath(); ctx.fill();
  ctx.globalAlpha = 1;

  const name = SHOP_NAMES[(r() * SHOP_NAMES.length) | 0];
  const sub = SHOP_SUBS[(r() * SHOP_SUBS.length) | 0] + " · " + SHOP_SUBS[(r() * SHOP_SUBS.length) | 0];
  ctx.textBaseline = "middle"; ctx.textAlign = "center"; ctx.fillStyle = p.fg;
  fitFont(ctx, name, W * 0.88, Math.min(120, W / 6), "900", SANS);
  ctx.fillText(name, W / 2, H * 0.4);
  fitFont(ctx, sub, W * 0.9, Math.min(44, W / 16), "600", SANS);
  ctx.globalAlpha = 0.85;
  ctx.fillText(sub, W / 2, H * 0.62);
  ctx.globalAlpha = 1;

  const badge = BADGES[(r() * BADGES.length) | 0];
  const fs = Math.round(Math.min(32, W / 22));
  fitFont(ctx, badge, W * 0.5, fs, "800", SANS);
  const bw = badge.length * fs + 56, bh = fs + 28;
  ctx.fillStyle = p.accent;
  ctx.beginPath();
  ctx.roundRect(W / 2 - bw / 2, H * 0.78 - bh / 2, bw, bh, bh / 2);
  ctx.fill();
  ctx.fillStyle = p.bg[0];
  ctx.fillText(badge, W / 2, H * 0.78);

  ctx.globalAlpha = 0.5;
  ctx.fillStyle = p.fg;
  ctx.fillRect(0, H - 6, W, 6);
  ctx.globalAlpha = 1;
  ctx.textAlign = "left";
}

function makeAd(it, W, H) {
  const base = canvasItem(W, H);
  paintAd(base.ctx, W, H, it.seed || 1);
  base.flush();
  return { texture: base.tex, kind: "static", dispose: base.dispose };
}

function makeTicker(it, W, H) {
  const base = canvasItem(W, H);
  const text = it.text || DEFAULT_TEXT;
  let acc = 1;
  return {
    texture: base.tex,
    kind: "animated",
    update(dt, time) {
      acc += dt;
      if (acc < 0.05) return;
      acc = 0;
      const ctx = base.ctx;
      ctx.fillStyle = "#0c1018"; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#37e6d5"; ctx.fillRect(0, 0, W, 8);
      ctx.textBaseline = "middle"; ctx.textAlign = "center"; ctx.fillStyle = "#ffffff";
      fitFont(ctx, "TIDE HUB 潮汇坊", W * 0.9, Math.min(64, W / 12), "800", SANS);
      ctx.fillText("TIDE HUB 潮汇坊", W / 2, H * 0.3);
      ctx.textAlign = "left"; ctx.fillStyle = "#ffd23f";
      const tickFs = Math.round(Math.min(52, W / 16));
      ctx.font = `700 ${tickFs}px ${SANS}`;
      const tw = Math.max(1, ctx.measureText(text).width);
      const off = (time * 110) % tw;
      for (let x = -off; x < W; x += tw) ctx.fillText(text, x, H * 0.66);
      ctx.fillStyle = "rgba(255,255,255,0.25)"; ctx.fillRect(0, H * 0.47, W, 3);
      base.flush();
    },
    dispose() { base.dispose(); },
  };
}

function makeClock(it, W, H) {
  const base = canvasItem(W, H);
  const note = it.note || "晴 24°C";
  let lastSec = -1;
  return {
    texture: base.tex,
    kind: "animated",
    update(dt, time) {
      const d = new Date();
      const sec = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
      if (sec === lastSec) return;
      lastSec = sec;
      const ctx = base.ctx;
      ctx.fillStyle = "#101828"; ctx.fillRect(0, 0, W, H);
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, "rgba(46,196,230,0.25)"); grad.addColorStop(1, "rgba(46,196,230,0)");
      ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
      ctx.textBaseline = "middle"; ctx.textAlign = "left"; ctx.fillStyle = "#ffffff";
      const hh = String(d.getHours()).padStart(2, "0"), mm = String(d.getMinutes()).padStart(2, "0");
      fitFont(ctx, `${hh}:${mm}`, W * 0.88, Math.min(190, H * 0.38), "200", TIME_FONT);
      ctx.fillText(`${hh}:${mm}`, W * 0.06, H * 0.44);
      const wd = "日一二三四五六"[d.getDay()];
      const dateStr = `${d.getMonth() + 1}月${d.getDate()}日 星期${wd}`;
      ctx.fillStyle = "#8fd8e8";
      fitFont(ctx, dateStr, W * 0.55, Math.min(40, W / 20), "500", SANS);
      ctx.fillText(dateStr, W * 0.07, H * 0.72);
      ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.textAlign = "right";
      fitFont(ctx, note, W * 0.34, Math.min(44, W / 18), "600", SANS);
      ctx.fillText(note, W * 0.94, H * 0.72);
      ctx.textAlign = "left";
      base.flush();
    },
    dispose() { base.dispose(); },
  };
}

function makeImage(it, W, H) {
  const base = canvasItem(W, H);
  const ctx = base.ctx;
  const fail = (msg) => { placeholder(ctx, W, H, msg); base.flush(); };
  let alive = true;
  if (!it.url) fail("未设置图片地址（右侧内容配置里填 URL）");
  else {
    placeholder(ctx, W, H, "图片加载中…"); base.flush();
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { if (alive) { drawFitted(ctx, img, W, H, it.fit, img.naturalWidth, img.naturalHeight); base.flush(); } };
    img.onerror = () => { if (alive) fail("图片无法加载（检查地址 / CORS）"); };
    img.src = it.url;
  }
  return { texture: base.tex, kind: "static", dispose() { alive = false; base.dispose(); } };
}

/* ---------------- 视频 / 直播 ----------------
 * fast = cover/stretch → VideoTexture 零拷贝（UV 变换做裁切/拉伸）
 * slow = contain/auto  → CanvasTexture + rVFC，可留黑边、可显示失败海报
 */

/* 自动播放兜底：页面没有用户手势时 video.play() 可能被拒，屏面会永远停在占位帧。
 * 被拒绝的视频登记起来，等第一次点击 / 按键（例如点「进入街区」）统一重试。 */
const autoplayPending = new Set();
let autoplayBound = false;
function playVideo(video) {
  const p = video.play();
  if (!p || !p.catch) return;
  p.catch(() => {
    autoplayPending.add(video);
    if (autoplayBound) return;
    autoplayBound = true;
    const retry = () => {
      for (const v of autoplayPending) { const q = v.play(); if (q && q.catch) q.catch(() => {}); }
      autoplayPending.clear();
    };
    document.addEventListener("pointerdown", retry, { capture: true });
    document.addEventListener("keydown", retry, { capture: true });
  });
}

function makeVideo(it, W, H, aspect) {
  const base = canvasItem(W, H);
  const ctx = base.ctx;
  const fast = it.fit === "stretch" || it.fit === "cover";
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  // VOD 型 HLS（演示流）也要循环，否则播完就定格；真实无限直播流不受影响
  video.loop = true;
  video.playsInline = true;
  video.preload = "auto";

  let tex = base.tex, alive = true, active = false, ready = false, failed = false;
  let hls = null, frameId = 0, fallbackAcc = 0, loadTimer = null;
  const hasRVFC = typeof video.requestVideoFrameCallback === "function";

  placeholder(ctx, W, H, "视频加载中…"); base.flush();

  if (fast) {
    tex = new THREE.VideoTexture(video);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
  }

  const showPoster = (line) => {
    if (it.fallback) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        if (!alive) return;
        drawFitted(ctx, img, W, H, it.fit, img.naturalWidth, img.naturalHeight);
        base.flush();
        // 快路径：把 VideoTexture 的图源换成海报画布，并停用其 video 自动更新
        if (fast && tex !== base.tex) {
          tex.image = base.c;
          tex.update = () => {};
          tex.needsUpdate = true;
        }
      };
      img.onerror = () => { if (alive) { placeholder(ctx, W, H, line); base.flush(); } };
      img.src = it.fallback;
    } else {
      placeholder(ctx, W, H, line);
      base.flush();
      if (fast && tex !== base.tex) {
        tex.image = base.c;
        tex.update = () => {};
        tex.needsUpdate = true;
      }
    }
  };

  const fail = (line) => {
    if (failed || !alive) return;
    failed = true;
    showPoster(line);
  };

  const applyUV = () => {
    if (!fast || tex === base.tex) return;
    const sw = video.videoWidth, sh = video.videoHeight;
    if (!sw || !sh) return;
    if (it.fit === "stretch") { tex.repeat.set(1, 1); tex.offset.set(0, 0); }
    else { // cover：按源/屏宽高比居中裁切
      const S = sw / sh, A = aspect;
      if (S > A) { const k = A / S; tex.repeat.set(k, 1); tex.offset.set((1 - k) / 2, 0); }
      else { const k = S / A; tex.repeat.set(1, k); tex.offset.set(0, (1 - k) / 2); }
    }
    tex.needsUpdate = true;
  };

  const drawFrame = () => {
    if (!alive || !ready || video.readyState < 2) return;
    drawFitted(ctx, video, W, H, it.fit, video.videoWidth, video.videoHeight);
    base.flush();
  };

  // rVFC：按视频真实帧率绘制，暂停时不产生回调，零轮询浪费
  const pump = () => {
    if (!alive || !hasRVFC) return;
    frameId = video.requestVideoFrameCallback(() => {
      if (active && !failed) drawFrame();
      pump();
    });
  };

  video.addEventListener("loadeddata", () => {
    ready = true;
    if (loadTimer) { clearTimeout(loadTimer); loadTimer = null; }
    applyUV();
    if (!fast) drawFrame();
  });
  video.addEventListener("loadedmetadata", () => { applyUV(); if (active) resume(); });
  video.addEventListener("error", () => fail("视频无法加载（检查地址 / CORS）"));
  if (hasRVFC) pump();
  // 流卡住时不要永远停在「视频加载中…」
  loadTimer = setTimeout(() => {
    if (alive && !ready && !failed) fail("媒体加载超时 · 已切换备用内容");
  }, 12000);

  // HLS：只有 Safari 能可靠原生播放。Chrome/Edge 的 canPlayType 会返回 "maybe"，
  // 但实际不解码（readyState 有值、currentTime 恒为 0 的黑屏），必须走 hls.js。
  if (it.url && /\.m3u8(\?|#|$)/i.test(it.url)) {
    const ua = navigator.userAgent || "";
    const safariNative = /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|Edg|Android/i.test(ua);
    if (safariNative && video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = it.url;
    } else {
      import("hls.js").then(({ default: Hls }) => {
        if (!alive) return;
        if (!Hls.isSupported()) { fail("当前浏览器不支持 HLS 播放"); return; }
        hls = new Hls({ lowLatencyMode: true, liveSyncDurationCount: 2, backBufferLength: 30 });
        hls.loadSource(it.url);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => { if (active) resume(); });
        hls.on(Hls.Events.ERROR, (_e, data) => { if (data && data.fatal) fail("直播流中断 · 已切换备用内容"); });
      }).catch(() => fail("hls.js 加载失败 · 已切换备用内容"));
    }
  } else if (it.url) {
    video.src = it.url;
  } else {
    fail("未设置视频地址（右侧内容配置里填 URL）");
  }

  function resume() {
    if (!video || !alive || failed) return;
    playVideo(video);
  }

  return {
    texture: tex,
    kind: fast ? "static" : "animated",
    isVideo: true,
    video, // 便于控制台排查：readyState / currentTime / error
    update(dt, time) {
      if (fast || failed || !ready || !active) return;
      if (hasRVFC) return; // 已由 rVFC 驱动
      fallbackAcc += dt;
      if (fallbackAcc < 0.05) return; // 老浏览器回退 20fps
      fallbackAcc = 0;
      drawFrame();
    },
    setActive(on) {
      if (!alive) return;
      active = on;
      if (on) resume(); else video.pause();
    },
    setAudio(on) { if (alive) video.muted = !on; },
    dispose() {
      alive = false;
      autoplayPending.delete(video);
      if (loadTimer) { clearTimeout(loadTimer); loadTimer = null; }
      if (frameId && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameId);
      if (hls) { hls.destroy(); hls = null; }
      video.pause();
      video.removeAttribute("src");
      video.load();
      if (fast && tex !== base.tex) tex.dispose();
      base.dispose();
    },
  };
}

/**
 * 按配置生成内容池。返回数组，附带 setActive / setAudio / hasVideo 控制位。
 * @param {object|null} ctx 3D 裸眼上下文（仅 3D转角包柱屏注入）：
 *   { renderer, faces:[{pa,pb,pc,pd 世界坐标}] } —— 由 BillboardManager 提供
 */
export function createContentPool(aspect = 1.75, rawContent = null, ctx = null) {
  const cfg = normalizeContent(rawContent) || defaultContent();
  const H = BASE_H;
  const W = Math.max(384, Math.round(H * aspect));
  const pool = cfg.items.map((it) => {
    switch (it.type) {
      case "text": return makeTicker(it, W, H);
      case "clock": return makeClock(it, W, H);
      case "image": return makeImage(it, W, H);
      case "video":
      case "stream": return makeVideo(it, W, H, aspect);
      case "model3d": return makeModel3D(it, W, H, ctx);
      default: return makeAd(it, W, H);
    }
  });
  pool.cfg = cfg;
  pool.hasVideo = pool.some((c) => c.isVideo);
  pool.setActive = (on) => { for (const c of pool) if (c.setActive) c.setActive(on); };
  pool.setAudio = (on) => { for (const c of pool) if (c.setAudio) c.setAudio(on); };
  return pool;
}

export function disposeContentPool(pool) {
  if (!pool) return;
  pool.setActive(false);
  for (const item of pool) {
    if (item.dispose) { try { item.dispose(); } catch (e) { /* 已释放则忽略 */ } }
  }
}
