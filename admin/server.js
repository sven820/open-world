import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* WalkStreet 广告大屏内容管理后台 · 服务端（Node 内置模块，零依赖）
 * 主流数字标牌后台模式：素材库 → 节目单 → 屏位绑定 → 发布 → 终端拉取。
 * 数据用 JSON 文件持久化，素材落在 data/media/，方便本地演示。
 */
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const DATA = path.join(ROOT, "data");
const MEDIA = path.join(DATA, "media");
const STATE_FILE = path.join(DATA, "state.json");
const PORT = Number(process.env.PORT || 8787);
const MAX_BODY = 32 * 1024 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", // 动态 import 必须是 JS MIME，否则浏览器拒绝执行
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".mp4": "video/mp4", ".webm": "video/webm", ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t", ".m4s": "video/iso.mp4", ".ico": "image/x-icon",
};

const uid = (p = "id") => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/* ---------------- 演示素材（离线可用） ---------------- */
const DEMO_SVGS = {
  "demo-ad-1.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#132a4a"/><stop offset="1" stop-color="#2c7a90"/></linearGradient></defs><rect width="1200" height="675" fill="url(#g)"/><circle cx="1010" cy="130" r="220" fill="#37e6d5" opacity=".18"/><text x="70" y="310" font-family="Microsoft YaHei,sans-serif" font-size="130" font-weight="900" fill="#fff">潮汇坊 · 秋季新品</text><text x="74" y="410" font-family="Microsoft YaHei,sans-serif" font-size="46" fill="#9fe8e0">TIDE HUB AUTUMN COLLECTION</text><rect x="70" y="470" width="300" height="76" rx="38" fill="#ffd23f"/><text x="100" y="522" font-family="Microsoft YaHei,sans-serif" font-size="38" font-weight="700" fill="#1b1b22">限时 8 折起</text></svg>`,
  "demo-ad-2.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b0d2e"/><stop offset="1" stop-color="#a3245a"/></linearGradient></defs><rect width="800" height="800" fill="url(#g)"/><rect x="0" y="0" width="90" height="800" fill="#ffd23f"/><rect x="710" y="0" width="90" height="800" fill="#37e6d5"/><text x="400" y="370" text-anchor="middle" font-family="Microsoft YaHei,sans-serif" font-size="110" font-weight="900" fill="#ffe9f3">备用海报</text><text x="400" y="450" text-anchor="middle" font-family="sans-serif" font-size="38" fill="#ffb8d8">FALLBACK POSTER</text></svg>`,
  "demo-ad-3.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="450"><rect width="1600" height="450" fill="#101828"/><rect x="0" y="0" width="1600" height="12" fill="#37e6d5"/><text x="800" y="220" text-anchor="middle" font-family="Microsoft YaHei,sans-serif" font-size="96" font-weight="900" fill="#fff">超宽屏测试图 16 : 4.5</text><text x="800" y="310" text-anchor="middle" font-family="sans-serif" font-size="36" fill="#8fd8e8">WIDE FORMAT · FIT MODE TEST</text></svg>`,
};

function defaultState() {
  const now = new Date().toISOString();
  return {
    // 屏位完全由游戏端上报产生；后台不预置游戏里不存在的"示例屏位"
    screens: [],
    activeMap: null,
    media: [
      { id: "m-img-1", name: "秋季新品主视觉", type: "image", url: "/media/demo-ad-1.svg", createdAt: now },
      { id: "m-img-2", name: "备用海报（方图）", type: "image", url: "/media/demo-ad-2.svg", createdAt: now },
      { id: "m-img-3", name: "超宽屏测试图", type: "image", url: "/media/demo-ad-3.svg", createdAt: now },
      { id: "m-video-1", name: "演示视频 MP4（本地离线）", type: "video", url: "/media/demo-clip.mp4", createdAt: now },
      { id: "m-live-1", name: "演示直播流 HLS（本地离线）", type: "stream", url: "/media/live/live.m3u8", createdAt: now },
      { id: "m-video-ext", name: "示例视频（外链 · 需联网）", type: "video", url: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4", createdAt: now },
      { id: "m-live-ext", name: "示例直播流（外链 · 需联网）", type: "stream", url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8", createdAt: now },
      { id: "m-3d-demo1", name: "3D演示1（内置环形装置）", type: "model3d", url: "builtin://demo1", createdAt: now },
      { id: "m-3d-demo2", name: "3D演示2（品牌广告 · 12秒）", type: "model3d", url: "builtin://demo2", createdAt: now },
    ],
    playlists: [
      {
        id: "pl-default", name: "商圈轮播（默认）", fit: "auto", transition: 0.6, audio: "off", updatedAt: now,
        items: [
          { type: "ad", duration: 8, seed: 1 },
          { type: "image", url: "/media/demo-ad-1.svg", fallback: "", fit: "cover", duration: 8 },
          { type: "text", duration: 9, text: "潮汇坊 · 中央大道商圈 今日营业至 22:00   ◆   新品上市 全场 8 折起   ◆   " },
          { type: "clock", duration: 7, note: "晴 24°C" },
        ],
      },
      {
        id: "pl-video", name: "视频演示（含备用海报）", fit: "contain", transition: 0.8, audio: "off", updatedAt: now,
        items: [
          { type: "video", url: "/media/demo-clip.mp4", fallback: "/media/demo-ad-2.svg", fit: "contain", duration: 14 },
          { type: "image", url: "/media/demo-ad-3.svg", fallback: "", fit: "cover", duration: 8 },
        ],
      },
      {
        id: "pl-live", name: "直播演示（HLS + 降级）", fit: "contain", transition: 0.4, audio: "off", updatedAt: now,
        items: [
          { type: "stream", url: "/media/live/live.m3u8", fallback: "/media/demo-ad-2.svg", fit: "contain", duration: 30 },
          { type: "image", url: "/media/demo-ad-1.svg", fallback: "", fit: "cover", duration: 10 },
        ],
      },
      {
        id: "pl-3d-corner", name: "3D转角屏测试（3D裸眼演示1）", fit: "auto", transition: 0, audio: "off", updatedAt: now,
        items: [
          { type: "model3d", url: "builtin://demo1", depth: 2.5, duration: 16 },
        ],
      },
    ],
    published: { version: 0, publishedAt: null, screens: {} },
    ack: { version: 0, at: null },
  };
}

function ensureFiles() {
  fs.mkdirSync(MEDIA, { recursive: true });
  for (const [name, body] of Object.entries(DEMO_SVGS)) {
    const f = path.join(MEDIA, name);
    if (!fs.existsSync(f)) fs.writeFileSync(f, body, "utf8");
  }
  if (!fs.existsSync(STATE_FILE)) saveState(defaultState());
  const media = [
    ["demo-clip.mp4", "演示视频"],
    ["live/live.m3u8", "演示直播流"],
  ];
  for (const [f, label] of media) {
    if (!fs.existsSync(path.join(MEDIA, f))) console.warn(`[admin] 缺少${label} ${f}，相关节目单会降级到备用海报`);
  }
}
/** 内置 3D 演示素材 + 3D转角屏测试节目单：对已存在的 state.json 幂等补种 */
function ensureBuiltin(state) {
  let changed = false;
  const now = new Date().toISOString();
  if (!Array.isArray(state.media)) state.media = [];
  if (!state.media.some((m) => m.id === "m-3d-demo1")) {
    state.media.push({ id: "m-3d-demo1", name: "3D演示1（内置环形装置）", type: "model3d", url: "builtin://demo1", createdAt: now });
    changed = true;
  }
  if (!state.media.some((m) => m.id === "m-3d-demo2")) {
    state.media.push({ id: "m-3d-demo2", name: "3D演示2（品牌广告 · 12秒）", type: "model3d", url: "builtin://demo2", createdAt: now });
    changed = true;
  }
  if (!Array.isArray(state.playlists)) state.playlists = [];
  if (!state.playlists.some((p) => p.id === "pl-3d-corner")) {
    state.playlists.push({
      id: "pl-3d-corner", name: "3D转角屏测试（3D裸眼演示1）", fit: "auto", transition: 0, audio: "off", updatedAt: now,
      items: [{ type: "model3d", url: "builtin://demo1", depth: 2.5, duration: 16 }],
    });
    changed = true;
  }
  if (changed) saveState(state);
}
function loadState() {
  ensureFiles();
  try { const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); ensureBuiltin(s); return s; }
  catch { const s = defaultState(); saveState(s); return s; }
}
function saveState(s) {
  // 不调用 ensureFiles()：首次初始化时 ensureFiles → saveState → ensureFiles 会无限递归
  fs.mkdirSync(DATA, { recursive: true });
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), "utf8");
  fs.renameSync(tmp, STATE_FILE);
}

/* ---------------- 工具 ---------------- */
function cors(res, req) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
}
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": MIME[".json"] });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("请求体过大（上限 32MB）")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (e) { reject(new Error("JSON 解析失败：" + e.message)); }
    });
    req.on("error", reject);
  });
}
const baseOf = (req) => `http://${req.headers.host || `127.0.0.1:${PORT}`}`;
/** 把 /media/ 相对地址补成后台绝对地址，供游戏端跨域取用 */
function absolutize(url, base) {
  return typeof url === "string" && url.startsWith("/media/") ? base + url : url;
}
function playlistToContent(pl, base) {
  return {
    fit: pl.fit || "auto",
    transition: Number(pl.transition) || 0,
    audio: pl.audio || "off",
    items: (pl.items || []).map((it) => {
      const o = { ...it };
      if (o.url) o.url = absolutize(o.url, base);
      if (o.fallback) o.fallback = absolutize(o.fallback, base);
      return o;
    }),
  };
}
/** 当前工作区（未发布）快照；base="" 时保留 /media/ 相对地址便于持久化 */
function buildPublished(state, base) {
  const screens = {};
  for (const sc of state.screens) {
    const pl = state.playlists.find((p) => p.id === sc.playlistId);
    if (pl) screens[sc.id] = playlistToContent(pl, base);
  }
  return { version: state.published.version, publishedAt: state.published.publishedAt, screens };
}

/** 已发布快照对外输出：每次请求按当前 host 补绝对地址（终端可跨域取素材） */
function publicSnapshot(state, base) {
  const screens = {};
  for (const [id, cfg] of Object.entries(state.published.screens || {})) {
    screens[id] = {
      ...cfg,
      items: (cfg.items || []).map((it) => ({
        ...it,
        ...(it.url ? { url: absolutize(it.url, base) } : {}),
        ...(it.fallback ? { fallback: absolutize(it.fallback, base) } : {}),
      })),
    };
  }
  return { version: state.published.version, publishedAt: state.published.publishedAt, screens };
}

/** 工作区是否比已发布版本更新 */
function pendingOf(state) {
  return JSON.stringify(buildPublished(state, "").screens) !== JSON.stringify(state.published.screens || {});
}

/* ---------------- 静态资源（含视频 Range） ---------------- */
function serveStatic(req, res, u) {
  let rel = decodeURIComponent(u.pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const isMedia = rel.startsWith("/media/");
  const baseDir = isMedia ? MEDIA : PUBLIC;
  const file = path.join(baseDir, isMedia ? rel.slice("/media/".length) : rel.replace(/^\/+/, ""));
  const resolved = path.resolve(file);
  if (!resolved.startsWith(path.resolve(baseDir))) { res.writeHead(403); return res.end("Forbidden"); }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("404 Not Found: " + rel);
  }
  const ext = path.extname(resolved).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const size = fs.statSync(resolved).size;
  const range = req.headers.range;
  if (range && /^bytes=/.test(range)) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : size - 1;
    if (start >= size || end >= size) end = size - 1;
    if (start > end) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); return res.end(); }
    res.writeHead(206, {
      "Content-Type": type, "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes",
    });
    return fs.createReadStream(resolved, { start, end }).pipe(res);
  }
  res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes" });
  fs.createReadStream(resolved).pipe(res);
}

/* ---------------- API ---------------- */
async function handleApi(req, res, u) {
  const p = u.pathname, method = req.method, state = loadState(), base = baseOf(req);
  const body = method === "POST" || method === "PUT" ? await readBody(req) : {};

  if (p === "/api/health" && method === "GET") return json(res, 200, { ok: true, service: "walkstreet-admin", port: PORT });

  if (p === "/api/state" && method === "GET") {
    return json(res, 200, { ...state, pending: pendingOf(state), endpoint: base });
  }

  // 游戏端上报屏位清单：一次上报 = 该地图当前世界的"完整"屏位列表。
  // 因此同地图里本次没出现的旧屏位要回收，其它地图超过 5 分钟无心跳的也要清掉，
  // 否则切换地图后后台会一直堆着上一次世界的屏位。
  if (p === "/api/screens/report" && method === "POST") {
    const list = Array.isArray(body.screens) ? body.screens : [];
    const mapId = String(body.mapId || "default");
    const mapName = String(body.mapName || "默认街区 · 程序化城市");
    const sessionId = String(body.sessionId || "");
    const now = new Date().toISOString();
    const ids = new Set(list.map((s) => s && s.id).filter(Boolean));
    const STALE = 2 * 60 * 1000;

    let removed = 0;
    state.screens = state.screens.filter((x) => {
      if (!x.reported) return true; // 手动占位屏位由用户自己管理
      // 同一个终端（含旧版无 sessionId 的数据）：本次列表就是它的完整世界，立即回收旧屏位
      if (!x.sessionId || (sessionId && x.sessionId === sessionId)) {
        if (!ids.has(x.id)) removed++;
        return ids.has(x.id);
      }
      // 其它终端：超过 2 分钟没有心跳才清理（多标签 / 多浏览器互不干扰）
      const age = x.lastSeen ? Date.now() - new Date(x.lastSeen).getTime() : Infinity;
      if (age > STALE) { removed++; return false; }
      return true;
    });

    const round1 = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10) / 10 : undefined);
    const applyReported = (target, s) => {
      if (s.mount) target.mount = s.mount;
      if (s.w) target.w = s.w;
      if (s.h) target.h = s.h;
      const x = round1(s.x), z = round1(s.z);
      if (x !== undefined) target.x = x;
      if (z !== undefined) target.z = z;
      target.mapId = mapId;
      target.mapName = mapName;
      target.sessionId = sessionId || null;
      target.reported = true;
      target.lastSeen = now;
    };

    let added = 0;
    list.forEach((s, idx) => {
      if (!s || !s.id) return;
      const i = state.screens.findIndex((x) => x.id === s.id);
      if (i >= 0) applyReported(state.screens[i], s);
      else {
        // 3D转角包柱屏优先绑 3D 裸眼测试节目单；其余屏位轮流绑定演示节目单（图片/视频/直播各覆盖一批）
        const pl3d = state.playlists.find((p) => p.id === "pl-3d-corner") || null;
        const pl = s.mount === "corner3d" && pl3d ? pl3d
          : state.playlists.length ? state.playlists[state.screens.length % state.playlists.length] : null;
        const sc = {
          id: s.id, name: s.name || `${mapName} · ${idx + 1} 号屏`,
          mount: "standalone", w: 14, h: 8, playlistId: pl ? pl.id : "",
        };
        applyReported(sc, s);
        state.screens.push(sc);
        added++;
      }
    });
    state.activeMap = { mapId, mapName, sessionId: sessionId || null, at: now, count: list.length };
    saveState(state);
    return json(res, 200, { ok: true, added, removed, screens: state.screens.length });
  }

  // 清理无效屏位：手动占位屏位 + 非当前地图且已超过 2 分钟没心跳的上报屏位
  if (p === "/api/screens/prune" && method === "POST") {
    const before = state.screens.length;
    const active = state.activeMap;
    state.screens = state.screens.filter((x) => {
      if (!x.reported) return false;
      if (active && x.mapId === active.mapId && x.sessionId === active.sessionId) return true;
      return !!(x.lastSeen && Date.now() - new Date(x.lastSeen).getTime() < 2 * 60 * 1000);
    });
    saveState(state);
    return json(res, 200, { ok: true, removed: before - state.screens.length, screens: state.screens.length });
  }

  // 手动新增示例屏位（没有游戏端也能演示配置流程）
  if (p === "/api/screens" && method === "POST") {
    const id = String(body.id || uid("screen"));
    if (state.screens.some((x) => x.id === id)) return json(res, 400, { error: "屏位 ID 已存在" });
    const sc = {
      id, name: String(body.name || "新屏位").slice(0, 80), mount: body.mount || "standalone",
      w: Number(body.w) || 14, h: Number(body.h) || 8, mapName: "手动创建",
      playlistId: state.playlists[0] ? state.playlists[0].id : "",
      reported: false, lastSeen: null,
    };
    state.screens.push(sc);
    saveState(state);
    return json(res, 200, sc);
  }

  // 屏位编辑（改名 / 绑定节目单）
  let m = /^\/api\/screens\/([^/]+)$/.exec(p);
  if (m && method === "PUT") {
    const sc = state.screens.find((x) => x.id === decodeURIComponent(m[1]));
    if (!sc) return json(res, 404, { error: "屏位不存在" });
    if (typeof body.name === "string") sc.name = body.name.slice(0, 80);
    if (typeof body.playlistId === "string") sc.playlistId = body.playlistId;
    if (typeof body.w === "number") sc.w = body.w;
    if (typeof body.h === "number") sc.h = body.h;
    saveState(state);
    return json(res, 200, sc);
  }
  if (m && method === "DELETE") {
    const id = decodeURIComponent(m[1]);
    state.screens = state.screens.filter((x) => x.id !== id);
    saveState(state);
    return json(res, 200, { ok: true });
  }

  // 素材库：新增（URL 或 base64 上传）
  if (p === "/api/media" && method === "POST") {
    const type = ["image", "video", "stream", "model3d"].includes(body.type) ? body.type : "image";
    let url = String(body.url || "").trim();
    if (body.dataUrl && /^data:([^;]+);base64,/.test(body.dataUrl)) {
      const mime = /^data:([^;]+);base64,/.exec(body.dataUrl)[1];
      const ext = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/svg+xml": ".svg", "video/mp4": ".mp4", "video/webm": ".webm" }[mime] || ".bin";
      const name = `${uid("up")}${ext}`;
      fs.writeFileSync(path.join(MEDIA, name), Buffer.from(body.dataUrl.split(",")[1], "base64"));
      url = `/media/${name}`;
    }
    if (!url) return json(res, 400, { error: "缺少 URL 或上传内容" });
    const item = { id: uid("m"), name: String(body.name || "未命名素材").slice(0, 80), type, url, createdAt: new Date().toISOString() };
    state.media.push(item);
    saveState(state);
    return json(res, 200, item);
  }

  m = /^\/api\/media\/([^/]+)$/.exec(p);
  if (m && method === "DELETE") {
    const id = decodeURIComponent(m[1]);
    const item = state.media.find((x) => x.id === id);
    state.media = state.media.filter((x) => x.id !== id);
    if (item && item.url.startsWith("/media/")) {
      const f = path.join(MEDIA, item.url.slice("/media/".length));
      if (fs.existsSync(f)) { try { fs.unlinkSync(f); } catch {} }
    }
    saveState(state);
    return json(res, 200, { ok: true });
  }

  // 连通性测试：服务端探测，绕过浏览器 CORS 限制
  if (p === "/api/probe" && method === "POST") {
    const url = String(body.url || "").trim();
    if (!/^https?:\/\//i.test(url)) return json(res, 200, { ok: false, note: "仅支持 http(s) 地址" });
    try {
      let r = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(6000) });
      // 有些 CDN 禁用 HEAD，退回 Range GET 再探一次
      if (!r.ok && (r.status === 405 || r.status === 403 || r.status === 501)) {
        r = await fetch(url, { headers: { Range: "bytes=0-0" }, signal: AbortSignal.timeout(6000) });
      }
      return json(res, 200, {
        ok: r.ok, status: r.status,
        contentType: r.headers.get("content-type") || "",
        note: r.ok ? "可访问" : `HTTP ${r.status}`,
      });
    } catch (e) {
      return json(res, 200, { ok: false, note: "不可达：" + (e.name === "TimeoutError" ? "超时" : e.message) });
    }
  }

  // 节目单 upsert
  if (p === "/api/playlists" && method === "POST") {
    const pl = {
      id: String(body.id || uid("pl")),
      name: String(body.name || "新节目单").slice(0, 80),
      fit: body.fit || "auto", transition: Number(body.transition) || 0,
      audio: body.audio || "off", items: Array.isArray(body.items) ? body.items.slice(0, 16) : [],
      updatedAt: new Date().toISOString(),
    };
    const i = state.playlists.findIndex((x) => x.id === pl.id);
    if (i >= 0) state.playlists[i] = pl; else state.playlists.push(pl);
    saveState(state);
    return json(res, 200, pl);
  }
  m = /^\/api\/playlists\/([^/]+)$/.exec(p);
  if (m && method === "DELETE") {
    const id = decodeURIComponent(m[1]);
    state.playlists = state.playlists.filter((x) => x.id !== id);
    for (const sc of state.screens) if (sc.playlistId === id) sc.playlistId = "";
    saveState(state);
    return json(res, 200, { ok: true });
  }

  // 发布：冻结当前工作区为版本快照，终端只能拉到这一版
  if (p === "/api/publish" && method === "POST") {
    state.published = {
      version: state.published.version + 1,
      publishedAt: new Date().toISOString(),
      screens: buildPublished(state, "").screens,
    };
    saveState(state);
    return json(res, 200, publicSnapshot(state, base));
  }
  if (p === "/api/publish" && method === "GET") return json(res, 200, publicSnapshot(state, base));
  // 发布预览：不改版本号，看看当前工作区发出去会是什么
  if (p === "/api/publish/preview" && method === "GET") return json(res, 200, buildPublished(state, base));

  // 游戏端确认已拉取
  if (p === "/api/ack" && method === "POST") {
    state.ack = {
      version: Number(body.version) || 0, at: new Date().toISOString(),
      screens: Number(body.screens) || 0, client: String(body.client || "").slice(0, 60),
      mapName: String(body.mapName || "").slice(0, 80),
    };
    saveState(state);
    return json(res, 200, state.ack);
  }

  // 重置演示数据
  if (p === "/api/demo/reset" && method === "POST") {
    const s = defaultState(); saveState(s);
    return json(res, 200, { ok: true, state: { ...s, pending: pendingOf(s) } });
  }

  return json(res, 404, { error: "API 不存在：" + method + " " + p });
}

const server = http.createServer(async (req, res) => {
  cors(res, req);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const u = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
  try {
    if (u.pathname.startsWith("/api/")) await handleApi(req, res, u);
    else serveStatic(req, res, u);
  } catch (e) {
    console.error("[admin] 请求处理失败：", e);
    if (!res.headersSent) json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  ensureFiles();
  console.log(`\n  WalkStreet 广告大屏后台已启动\n  后台页面 : http://127.0.0.1:${PORT}/\n  发布接口 : http://127.0.0.1:${PORT}/api/publish\n  素材目录 : ${MEDIA}\n`);
});
