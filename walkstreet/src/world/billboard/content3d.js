import * as THREE from "three/webgpu";
import { uniform, positionWorld, normalWorld, uv, mix, vec3 } from "three/tsl";
import { makeCanvas } from "../textures.js";
import { parseGLB } from "../../data/assetStore.js";

/* ---------------- 3D 裸眼内容源 —— rea/billboard-content-lab 移植版 ----------------
 * 架构与实验台（PULSE · 内容源实验台）一致：
 *   offAxis()           离轴投影矩阵（P·R·T，逐字同款）
 *   每面一块 RenderTarget，projCam 只看内容层（layer 隔离）
 *   frame() 主循环：临时换背景/雾 → 双路离轴渲染进 RT → 还原
 *
 * 与实验台的两处适配（不改变效果）：
 *   1. 场地常量(VC/OUT)换成本块屏的实际世界坐标；
 *   2. 每块 3D 内容独占一个 layer（1~30），多块屏 / 多个条目互不串扰。
 *
 * 内容条目 type 在 3D 屏上的去向（实验台「内容源」全量迁移）：
 *   model3d   demo1 内置环形装置 / demo2 12秒品牌广告 / calib 几何校准 / GLB 模型
 *   image/text/clock/ad/video/stream  复用 contentSource 的 2D 工厂生成纹理，
 *             贴到一块板子上放进 contentRoot 参与离轴取景（实验台 applyTexture 同款）
 *
 * 虚拟眼睛（立体感的根源，实验台 56891 行同款）：
 *   track=true  用真实取景相机位置（state.track ? camera.position : ...）
 *   track=false 固定最佳视点（实验台 HERO 档）
 *   眼睛位置钳制在安全区内：离轴预畸变对「眼睛在屏面附近 / 屏后」无意义，
 *   那种极端视锥就是画面整体拉花的来源。
 *
 * WebGPU 试验分支适配（相对 dev 版）：
 *   three/webgpu 单实例 + TSL；离轴投影按后端 z 范围区分；projCam / noticeCam
 *   显式对齐 renderer.coordinateSystem；demo2 金属罐 GLSL→TSL、Points→InstancedMesh；
 *   RenderTarget 基类；Frustum 剔除传入后端坐标系。
 *
 * 屏位级 3D 参数 d3（后台屏位绑定配置，实验台遛眼参数/显示开关同款）：
 *   depth   出屏深度（contentRoot.position = VC + OUT·depth）
 *   scale   尺寸（contentRoot.scale）
 *   spin    轻微摆动/自转（平面素材板永远不转：一转就被离轴拉成梯形）
 *   track   片源跟随当前视点（实时追踪）
 *   hud     右下角双路预览（管理器叠加层，见 billboardManager）
 *   helper  视线/眼位辅助线
 ---------------------------------------------------------------------- */

const NEAR = 0.12, FAR = 400;      // 实验台 frame() 同款
const RTW = 768, RTH = 512;        // 实验台 RT 尺寸同款
const EYE_H = 1.7;                 // 观看视点离地高度（实验台 HERO.y 同款）
const EYE_DIST = 30;               // 固定最佳视点：沿 OUT 方向离屏体的距离
const DESIGN_DIST = 22;            // 板子尺寸的设计视距（实验台 12×8 构图基准）
/* —— 试验分支诊断开关（URL ?bb3ddebug=N）——
 * 1 = 屏面显示 FACE A/B 测试图案（见 billboard.js，验证两面几何/UV/纹理分配）
 * 2 = RT 改用普通透视相机（绕开离轴投影，用于区分投影矩阵问题）
 * 3 = 虚拟眼睛固定在设计视点（忽略玩家相机，用于区分眼位问题）
 * 默认 0 = 正常离轴渲染。开启任一模式时片源缓存自动停用，避免掩盖问题。 */
export const DEBUG_3D =
  (typeof location !== "undefined" && /bb3ddebug=(\d)/.exec(location.search || ""))
    ? Number(RegExp.$1) : 0;
/* 屏面采样方向补偿（three r187 的后端差异）：
 * WebGL 回退后端 GLSLNodeBuilder.isFlipY()===true，TSL TextureNode 会对
 * isRenderTargetTexture 额外做一次 uv.flipY()；而离轴 RT 本身方向与 WebGLRenderer
 * 一致并不需要翻，多翻这一次会让屏面整幅画面上下颠倒。WGSL 后端不做该翻转。
 * billboard.js 的屏面纹理节点按此标志抵消（详见 billboard.js）。 */
let _glslRtFlip = false;
export function rtFlipNeeded() { return _glslRtFlip; }
const AD_BG = new THREE.Color(0x05101f); // 实验台 adBg 同款：RT 渲染期间的场景背景
const BUILTINS = ["demo1", "demo2", "calib"]; // dev 分支可用的内置 3D 内容

const clampN = (v, min, max, def) =>
  (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def);

/* -------- 片源渲染优化（与 PULSE 内容源实验台同款，按开放世界适配） --------
 * 1) 独立内容场景 adScene：原来两路离轴相机渲的是「整座城市」主 scene，靠
 *    layers 隔离只画 layer N 的内容层。three 的 projectObject 仍会递归遍历
 *    整棵场景树，且每帧把主 scene 的 background/fog 改掉再还原（fog 变化会让
 *    所有 fog 材质走 program 变更检查）。开放世界下这是迁移后变卡的主因。
 *    改为一张只装十几个内容对象的独立 Scene，世界坐标不变，画面等价。
 * 2) 脏标记缓存 rtNeedsRender：静态素材（图片/广告/文字/静态 GLB）片源不再
 *    每帧重渲两路 RT；眼位、纹理新帧、内容动画、状态变化才标脏。
 * 3) 视频 rVFC 驱动：requestVideoFrameCallback 按视频真实帧率标脏，带看门狗
 *    与不支持时回退每帧（实验台同款）。
 * 4) 视锥剔除：屏体不在取景相机视锥内时整帧不生成片源（HUD 预览开启时豁免）。
 * 说明：本项目 d3.track 默认 true（虚拟眼睛跟随真实相机），眼位变化必须重算
 *    离轴投影，这是物理必需；因此用「眼位差」而非实验台的无条件 true ——
 *    玩家静止时仍可命中缓存。要吃满缓存收益可在后台关掉「片源跟随当前视点」。
 ---------------------------------------------------------------------- */
const EYE_EPS2 = 0.02 * 0.02;          // 眼位变化阈值 2cm，超过才重算离轴矩阵
const VIDEO_WATCHDOG_MS = 600;         // rVFC 长时间无新帧的兜底重渲
const _frustum = new THREE.Frustum();  // 模块级复用，避免每帧分配
const _projScreen = new THREE.Matrix4();

/* 诊断计数（与 main.js 的 window.__frames / __calls 同款，方便实测 pass 收益）。
 * 不参与渲染逻辑，可在控制台随时查看：__rt3d.renders / skips / videoFrames。 */
const RT_STATS = { renders: 0, skips: 0, videoFrames: 0 };
if (typeof window !== "undefined") window.__rt3d = RT_STATS;

/* 实验台 §5 离轴投影（逐字同款，仅改 three 引用名）。
 * WebGPU 后端 z∈[0,1]、WebGL 后端 z∈[-1,1]，第 7 参决定投影矩阵第三行。 */
const _vr = new THREE.Vector3(), _vu = new THREE.Vector3(), _vn = new THREE.Vector3();
const _va = new THREE.Vector3(), _vb = new THREE.Vector3(), _vc = new THREE.Vector3();
const _P = new THREE.Matrix4(), _R = new THREE.Matrix4(), _Tm = new THREE.Matrix4(), _M = new THREE.Matrix4();
const _eye = new THREE.Vector3(), _look = new THREE.Vector3(), _rel = new THREE.Vector3();

function offAxis(pa, pb, pc, pe, near, far, webgpuCS) {
  _vr.subVectors(pb, pa).normalize(); _vu.subVectors(pc, pa).normalize();
  _vn.crossVectors(_vr, _vu).normalize();
  _va.subVectors(pa, pe); _vb.subVectors(pb, pe); _vc.subVectors(pc, pe);
  let d = -_vn.dot(_va); if (d < 0.05) d = 0.05;
  const l = _vr.dot(_va) * near / d, r = _vr.dot(_vb) * near / d,
    b = _vu.dot(_va) * near / d, t = _vu.dot(_vc) * near / d;
  let c, dd;
  if (webgpuCS) {
    c = -far / (far - near);
    dd = (-far * near) / (far - near);
  } else {
    c = -(far + near) / (far - near);
    dd = (-2 * far * near) / (far - near);
  }
  _P.set(
    2 * near / (r - l), 0, (r + l) / (r - l), 0,
    0, 2 * near / (t - b), (t + b) / (t - b), 0,
    0, 0, c, dd,
    0, 0, -1, 0,
  );
  _R.set(_vr.x, _vr.y, _vr.z, 0, _vu.x, _vu.y, _vu.z, 0, _vn.x, _vn.y, _vn.z, 0, 0, 0, 0, 1);
  _Tm.makeTranslation(-pe.x, -pe.y, -pe.z);
  return _M.copy(_P).multiply(_R).multiply(_Tm);
}

function setLayer(o, n) { o.traverse(function (c) { c.layers.set(n); }); return o; }

/* 多块 3D 内容各占一个 layer（主相机默认只开 layer 0，不会看到内容层） */
let _layerCursor = 1;
function allocLayer() { const l = _layerCursor; _layerCursor = (_layerCursor % 30) + 1; return l; }

/* 实验台 adBackTex() 同款：屏体内腔背板纹理（径向渐变 + 网格细线） */
function adBackTex() {
  const q = makeCanvas(512, 512), x = q.getContext("2d");
  const g = x.createRadialGradient(256, 230, 8, 256, 256, 320);
  g.addColorStop(0, "#12527a"); g.addColorStop(0.42, "#0a2244"); g.addColorStop(1, "#01040c");
  x.fillStyle = g; x.fillRect(0, 0, 512, 512);
  x.strokeStyle = "rgba(53,232,255,.10)"; x.lineWidth = 1;
  for (let i = 0; i <= 512; i += 32) {
    x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 512); x.stroke();
    x.beginPath(); x.moveTo(0, i); x.lineTo(512, i); x.stroke();
  }
  const t = new THREE.CanvasTexture(q);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ---------------- 屏内提示板（加载中 / 加载失败） ---------------- */

/** 简单折行：中文逐字、英文单词 / URL 整词，最多 5 行 */
function wrapText(ctx, text, maxW) {
  const tokens = String(text || "").replace(/\s+/g, " ").trim()
    .match(/[A-Za-z0-9_.\/:-]+|./g) || [];
  const lines = [];
  let cur = "";
  for (const tk of tokens) {
    const units = ctx.measureText(tk).width > maxW ? [...tk] : [tk];
    for (const u of units) {
      if (cur && ctx.measureText(cur + u).width > maxW) { lines.push(cur); cur = u; }
      else cur += u;
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 5);
}

function noticeBoard(message, sizeW, sizeH) {
  const c = makeCanvas(512, 288);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#04121e"; ctx.fillRect(0, 0, 512, 288);
  ctx.strokeStyle = "rgba(53,232,255,.35)"; ctx.lineWidth = 5;
  ctx.strokeRect(8, 8, 496, 272);
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = "#eafcff";
  ctx.font = "700 40px 'Noto Sans SC', 'Microsoft YaHei', sans-serif";
  ctx.fillText("PULSE", 256, 54);
  const fontSize = 23, lineH = fontSize * 1.5;
  ctx.font = `600 ${fontSize}px 'Noto Sans SC', 'Microsoft YaHei', sans-serif`;
  const lines = wrapText(ctx, message, 452);
  const top = 160 - (lines.length - 1) * lineH / 2;
  ctx.fillStyle = "#b9d6e4";
  lines.forEach((line, i) => ctx.fillText(line, 256, top + i * lineH));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(
    new THREE.PlaneGeometry(sizeW, sizeH),
    new THREE.MeshBasicMaterial({ map: t, side: THREE.DoubleSide, fog: false }),
  );
}

/** 解析 model3d 的 url：builtin:// 内置分流；其余一律当 GLB 地址发请求 */
function plan3dLoad(rawUrl) {
  const url = String(rawUrl || "").trim();
  if (!url) return { kind: "demo1" }; // 留空 = 内置 3D 演示1
  const m = /^builtin:\/\/([^/\s]+)\/?$/i.exec(url);
  if (m) {
    const id = m[1].toLowerCase();
    if (BUILTINS.includes(id)) return { kind: id };
    return { kind: "error", message: `未知内置 3D 内容 builtin://${id}｜可用：${BUILTINS.map((b) => "builtin://" + b).join(" / ")}` };
  }
  if (/^https?:\/\//i.test(url) || url.startsWith("/")) return { kind: "glb", url };
  return { kind: "error", message: "模型地址无效｜请填 http(s) 地址、/media/ 站内路径或 builtin:// 内置内容" };
}

function faceNormal(f) {
  // 与 quadGeom/offAxis 右手系一致：right(pb-pa) × up(pc-pa) = 屏面外法线
  return _vn.copy(f.pb).sub(f.pa).cross(_va.copy(f.pc).sub(f.pa)).normalize().clone();
}

/** 无 ctx（非 corner3d 屏 / 平贴模式 / 编辑器预览）：2D 静态占位纹理 */
export function make3dPlaceholder(it, W, H, line = "3D 裸眼内容仅支持 3D转角包柱屏") {
  const c = makeCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#0b1018"; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(46,196,230,.5)"; ctx.lineWidth = 4;
  ctx.strokeRect(6, 6, W - 12, H - 12);
  ctx.fillStyle = "#8fd8e8"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.font = `600 ${Math.round(Math.min(34, H * 0.09))}px 'Noto Sans SC', 'Microsoft YaHei', sans-serif`;
  ctx.fillText(line, W / 2, H / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return { texture: tex, kind: "static", dispose() { tex.dispose(); } };
}

function disposeTree(o) {
  o.traverse((n) => {
    if (n.geometry) n.geometry.dispose();
    if (n.material) {
      for (const m of Array.isArray(n.material) ? n.material : [n.material]) {
        if (m.map) m.map.dispose();
        m.dispose();
      }
    }
  });
}

/* ---------------- 3D 演示1：内置环形装置（实验台 makeDemo() 逐字） ---------------- */
function buildDemo1() {
  const g = new THREE.Group();
  const knot = new THREE.Mesh(
    new THREE.TorusKnotGeometry(2.0, 0.62, 140, 18),
    new THREE.MeshStandardMaterial({
      color: 0x2fd8f0, metalness: 0.55, roughness: 0.24,
      emissive: new THREE.Color(0x083c55), fog: false,
    }),
  );
  g.add(knot);
  [[3.4, 0x35e8ff], [4.6, 0xff3d9a], [5.8, 0x7fb0ff]].forEach(([r, col], i) => {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(r, 0.055, 6, 90),
      new THREE.MeshBasicMaterial({
        color: col, transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }),
    );
    ring.rotation.x = Math.PI / 2 + (i - 1) * 0.4;
    g.add(ring);
  });
  return { group: g, knot };
}

/* ---------------- 3D 演示2：12 秒品牌广告（WebGPU/TSL 适配版） ----------------
 * 时间轴与 dev 版逐式相同，两处后端适配：
 *   1. 金属罐体 GLSL ShaderMaterial → TSL 节点材质（WebGPU 后端编译不了 GLSL，
 *      NodeLibrary 也没有 ShaderMaterial 的注册节点）；
 *   2. 700 个 THREE.Points 星点 → 同 seed 的 InstancedMesh 小球
 *      （WebGPU 后端 Points 只有 1px，粒子会整片消失）。
 * 隧道 / 水花 / 光环 / 标签均保持 dev 版构图。 */
function buildDemo2(VC, OUT, gScale) {
  const root = new THREE.Group();       // 时间轴驱动：position / rotation 每帧改写
  const U2 = {
    eye: uniform(new THREE.Vector3()),
    time: uniform(0),
    alpha: uniform(1),
  };
  // 金属罐体：metalVS / metalFS 逐式 TSL 化
  const N = normalWorld.normalize();
  const V = U2.eye.sub(positionWorld).normalize();
  const L = vec3(0.45, 0.85, 0.65).normalize();
  const d = N.dot(L).max(0);
  const rim = V.dot(N).max(0).oneMinus().pow(2.1);
  const band = uv().y.mul(26).add(U2.time.mul(0.9)).sin().mul(0.5).add(0.5);
  const base = mix(vec3(0.12, 0.16, 0.22), vec3(0.88, 0.95, 1.0), d.mul(0.66).add(0.34)).add(band.mul(0.045));
  const metalMat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, transparent: true, fog: false });
  metalMat.toneMapped = false;   // 原 ShaderMaterial 输出不经 tone mapping
  metalMat.colorNode = base
    .add(rim.mul(vec3(0.0, 0.82, 1.0).mul(1.9)))
    .add(rim.mul(rim).mul(vec3(1.0, 0.14, 0.58).mul(0.85)));
  metalMat.opacityNode = U2.alpha;
  const can = new THREE.Mesh(new THREE.CylinderGeometry(2.8, 2.8, 7.4, 48, 1, false), metalMat);
  root.add(can);
  // PULSE 标签
  const lc = makeCanvas(1024, 512), lx = lc.getContext("2d");
  const lg = lx.createLinearGradient(0, 0, 1024, 512);
  lg.addColorStop(0, "#062033"); lg.addColorStop(0.5, "#0d4a63"); lg.addColorStop(1, "#1d0b33");
  lx.fillStyle = lg; lx.fillRect(0, 0, 1024, 512);
  lx.strokeStyle = "rgba(53,232,255,.65)"; lx.lineWidth = 14;
  for (let i = -512; i < 1536; i += 96) { lx.beginPath(); lx.moveTo(i, 512); lx.lineTo(i + 300, 0); lx.stroke(); }
  lx.fillStyle = "rgba(4,12,22,.82)"; lx.fillRect(90, 150, 844, 212);
  lx.fillStyle = "#eafcff"; lx.font = "bold 150px Arial"; lx.textAlign = "center"; lx.textBaseline = "middle";
  lx.fillText("PULSE", 512, 256);
  lx.fillStyle = "#35e8ff"; lx.font = "bold 30px Arial"; lx.fillText("E N E R G Y   /   3 D   C I T Y", 512, 420);
  const labelTex = new THREE.CanvasTexture(lc);
  labelTex.colorSpace = THREE.SRGBColorSpace;
  const label = new THREE.Mesh(
    new THREE.CylinderGeometry(2.815, 2.815, 4.5, 48, 1, true),
    new THREE.MeshBasicMaterial({ map: labelTex, side: THREE.DoubleSide, transparent: true, fog: false }),
  );
  root.add(label);
  // 上下银圈
  const rimMat = new THREE.MeshBasicMaterial({ color: 0xbfe6f2, fog: false });
  for (const y of [-3.75, 3.75]) {
    const r = new THREE.Mesh(new THREE.TorusGeometry(2.8, 0.12, 8, 48), rimMat);
    r.rotation.x = Math.PI / 2; r.position.y = y; root.add(r);
  }
  // 三个光环
  const rings = [];
  [[5.2, 0x35e8ff], [7.0, 0xff3d9a], [8.8, 0x3aa0ff]].forEach(([rr, col], i) => {
    const m = new THREE.MeshBasicMaterial({
      color: col, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
    });
    const r = new THREE.Mesh(new THREE.TorusGeometry(rr, 0.12, 6, 80), m);
    r.rotation.x = Math.PI / 2 + (i - 1) * 0.42;
    root.add(r);
    rings.push({ o: r, m, i });
  });
  // 水花
  const DN = 140;
  const dropMat = new THREE.MeshBasicMaterial({
    color: 0x8ff4ff, transparent: true, opacity: 1.0,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  });
  const drops = new THREE.InstancedMesh(new THREE.SphereGeometry(0.19, 7, 5), dropMat, DN);
  const dropSeed = [];
  for (let di = 0; di < DN; di++) {
    dropSeed.push({
      a: di * 2.39996, rad: 2.4 + Math.random() * 7.4,
      y: (Math.random() - 0.5) * 9, vy: 0.4 + Math.random() * 1.6, s: 0.5 + Math.random() * 1.8,
    });
  }
  root.add(drops);
  // 星点：WebGPU 下 Points 只有 1px，改用实例化小球（同 seed 同运动）
  const PN = 700, pseed = [];
  for (let pp = 0; pp < PN; pp++) {
    pseed.push({ a: Math.random() * Math.PI * 2, r: 3 + Math.random() * 13,
      y: (Math.random() - 0.5) * 14, s: 0.4 + Math.random() * 1.6 });
  }
  const sparkMat = new THREE.MeshBasicMaterial({
    color: 0x35e8ff, transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  });
  const sparks = new THREE.InstancedMesh(new THREE.SphereGeometry(0.16, 6, 4), sparkMat, PN);
  root.add(sparks);
  // 透视隧道：固定在屏体坐标（不随罐体位移），沿 OUT 方向往深处排 9 层线框
  const right = new THREE.Vector3(-OUT.z, 0, OUT.x); // OUT × Y（实验台对角线的通式）
  const tp = [];
  for (let ti = 0; ti < 9; ti++) {
    const dep = (-18 + ti * 3.2) * gScale, tscale = (5 + ti * 1.35) * gScale;
    const base = new THREE.Vector3(OUT.x * dep, 0, OUT.z * dep);
    const dx = right.clone().multiplyScalar(tscale), dy = new THREE.Vector3(0, tscale, 0);
    const c1 = base.clone().sub(dx).sub(dy), c2 = base.clone().add(dx).sub(dy),
      c3 = base.clone().add(dx).add(dy), c4 = base.clone().sub(dx).add(dy);
    for (const e of [[c1, c2], [c2, c3], [c3, c4], [c4, c1]]) tp.push(e[0].x, e[0].y, e[0].z, e[1].x, e[1].y, e[1].z);
  }
  const tg = new THREE.BufferGeometry();
  tg.setAttribute("position", new THREE.Float32BufferAttribute(tp, 3));
  const tunnel = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({
    color: 0x1a7f9e, transparent: true, opacity: 0.28, fog: false,
  }));
  tunnel.position.copy(VC);
  root.scale.setScalar(gScale);
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const dummy = new THREE.Object3D();
  // 12s 循环：0-2 汇聚 / 2-6 飞近 / 6-10 破屏 / 10-12 定格回收
  function update(t, eye) {
    const depth = t < 2 ? lerp(-15, -9, t / 2)
      : t < 6 ? lerp(-9, 0.5, (t - 2) / 4)
        : t < 10 ? lerp(0.5, 4.6, (t - 6) / 4)
          : lerp(4.6, -15, (t - 10) / 2);
    root.position.copy(VC).addScaledVector(OUT, depth * gScale);
    const appear = clamp01(t / 1.2) * (t > 10.6 ? clamp01((12 - t) / 1.4) : 1);
    U2.alpha.value = appear; dropMat.opacity = 1.0 * appear;
    sparkMat.opacity = 0.95 * appear; tunnel.material.opacity = 0.42 * appear;
    can.rotation.y = t * 0.62; label.rotation.y = can.rotation.y;
    can.rotation.z = Math.sin(t * 0.5) * 0.12; label.rotation.z = can.rotation.z;
    root.rotation.y = Math.sin(t * 0.35) * 0.10;
    for (const o of rings) {
      o.o.rotation.z = t * (0.35 + o.i * 0.22) * (o.i % 2 ? -1 : 1);
      o.o.rotation.x = Math.PI / 2 + (o.i - 1) * 0.42 + Math.sin(t * 0.6 + o.i) * 0.16;
      o.m.opacity = 0.95 * appear * (0.6 + 0.4 * Math.sin(t * 1.1 + o.i));
    }
    const burst = clamp01((t - 3) / 4) * (t > 10 ? clamp01((12 - t) / 2) : 1);
    for (let i = 0; i < DN; i++) {
      const d = dropSeed[i], a = d.a + t * 0.55 * d.vy, r = d.rad * (0.6 + burst * 1.15);
      dummy.position.set(Math.cos(a) * r, d.y + Math.sin(t * 1.3 + i) * 0.5 + burst * d.vy * 1.8, Math.sin(a) * r);
      dummy.scale.setScalar(d.s * appear * (0.5 + burst * 0.8));
      dummy.updateMatrix();
      drops.setMatrixAt(i, dummy.matrix);
    }
    drops.instanceMatrix.needsUpdate = true;
    for (let j = 0; j < PN; j++) {
      const p = pseed[j], a2 = p.a + t * 0.12 * p.s;
      dummy.position.set(
        Math.cos(a2) * p.r * (1 - burst * 0.25),
        p.y + Math.sin(t * 0.8 + j) * 0.35,
        Math.sin(a2) * p.r * (1 - burst * 0.25),
      );
      dummy.scale.setScalar(appear);
      dummy.updateMatrix();
      sparks.setMatrixAt(j, dummy.matrix);
    }
    sparks.instanceMatrix.needsUpdate = true;
    U2.time.value = t; U2.eye.value.copy(eye);
  }
  return { root, tunnel, update };
}

/* ---------------- 几何校准片（实验台 56446-56454 行移植） ---------------- */
function buildCalib() {
  const g = new THREE.Group();
  const cm = new THREE.LineBasicMaterial({ color: 0x35e8ff, transparent: true, opacity: 0.9, fog: false });
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(6.6, 6.6, 6.6)), cm));
  g.add(new THREE.LineSegments(
    new THREE.WireframeGeometry(new THREE.SphereGeometry(3.2, 14, 9)),
    new THREE.LineBasicMaterial({ color: 0xff3d9a, transparent: true, opacity: 0.6, fog: false }),
  ));
  const circ = new THREE.Mesh(
    new THREE.TorusGeometry(4.6, 0.045, 6, 80),
    new THREE.MeshBasicMaterial({ color: 0xffd45e, fog: false }),
  );
  circ.rotation.x = Math.PI / 2; g.add(circ);
  const grid = new THREE.GridHelper(20, 20, 0x35e8ff, 0x1a5a76);
  grid.position.y = -4.4; g.add(grid);
  return g;
}

/**
 * 3D 裸眼内容源工厂（corner3d 屏上所有内容类型的统一入口）。
 * @param {object} it    content 条目
 * @param {number} W,H   2D 纹理基准尺寸
 * @param {object} ctx   { renderer, scene, faces:[{pa,pb,pc,pd 世界坐标 Vector3}] }
 * @param {object|null} d3  屏位级 3D 参数 { depth, scale, spin, track, hud, helper }
 * @param {function|null} make2d  该条目的 2D 工厂（平面素材用；model3d 传 null）
 */
export function make3dContent(it, W, H, aspect, ctx, d3, make2d) {
  const faces = ctx && Array.isArray(ctx.faces) ? ctx.faces : null;
  const renderer = ctx && ctx.renderer;
  const scene = ctx && ctx.scene;
  if (!faces || faces.length < 2 || !renderer || !scene) return make3dPlaceholder(it, W, H);
  // 内容是离轴 RT 时才由屏面侧按后端决定要不要抵消 TextureNode 的额外 flipY
  _glslRtFlip = renderer.coordinateSystem === THREE.WebGLCoordinateSystem;

  // 出屏深度：条目级（素材属性，发布时合并）优先，屏位 d3.depth 兜底
  const depth = clampN(it.depth !== undefined ? it.depth : (d3 && d3.depth), 0, 10, 2.5);
  const scale = clampN(d3 && d3.scale, 0.4, 2, 1);
  const track = !(d3 && d3.track === false);
  const helperOn = !!(d3 && d3.helper);
  const spinOn = !(d3 && d3.spin === false);
  const isPlane = it.type !== "model3d"; // 平面素材板：永不自转（离轴会拉成梯形）
  const spin = spinOn && !isPlane;

  /* —— 场地常量（实验台 §1 的世界坐标版） —— */
  const layer = allocLayer();
  const OUT = faceNormal(faces[0]).add(faceNormal(faces[1])).normalize();
  const faceH = faces[0].pa.distanceTo(faces[0].pc);
  const faceW = faces[0].pa.distanceTo(faces[0].pb);
  // VC：转角棱线中点向屏体内收 2.8m/轴（实验台 VC=(2.5,10,2.5) 同款构图）
  const edge = faces[0].pb.clone().add(faces[0].pd).multiplyScalar(0.5);
  const VC = edge.clone().addScaledVector(OUT, -2.8 * Math.SQRT2);
  const gScale = Math.min(faceH / 8, 2.5); // 实验台原生比例按 12×8 屏设计，按屏高折算

  /* —— 每面一块 RT + projCam（只看内容层） —— */
  const projCam = new THREE.Camera();          // 裸 Camera + 手写离轴投影矩阵
  projCam.layers.set(layer);
  projCam.matrixAutoUpdate = false;
  // Renderer.js:3822 若发现 camera.coordinateSystem !== renderer.coordinateSystem，
  // 会置 projectionMatrixNeedsUpdate 并调用 camera.updateProjectionMatrix()；
  // 裸 Camera 没有该方法会直接抛错，手写矩阵也会被覆盖。必须提前对齐。
  projCam.coordinateSystem = renderer.coordinateSystem;
  // 诊断模式 2：普通透视相机（绕开离轴投影，用于区分投影矩阵问题）
  const dbgCam = DEBUG_3D === 2 ? new THREE.PerspectiveCamera(55, RTW / RTH, NEAR, FAR) : null;
  const rts = faces.map((f) => ({
    f,
    rt: new THREE.RenderTarget(RTW, RTH, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false,
    }),
  }));
  // 每面预计算：面中心 / 朝外法线（与 offAxis 的 _vn 同向：eye 在前则 dot>0），
  // 供「极端眼位正视降级」判定与降级相机定位用。
  {
    const _a = new THREE.Vector3(), _b = new THREE.Vector3();
    for (const r of rts) {
      r.center = new THREE.Vector3().add(r.f.pa).add(r.f.pb).add(r.f.pc).add(r.f.pd).multiplyScalar(0.25);
      r.normal = new THREE.Vector3()
        .crossVectors(_a.subVectors(r.f.pb, r.f.pa).normalize(), _b.subVectors(r.f.pc, r.f.pa).normalize())
        .normalize();
    }
  }
  /* —— 极端眼位正视降级 ——
   * 离轴预畸变的「窗口视」只在眼睛位于屏前合理锥角内才有意义。玩家爬高俯瞰、
   * 贴脸走过时，眼与面法线夹角过斜，从窗口望进去看到的主要是内容场景的
   * 背景：两面 RT 一面黑屏、一面把内容压成一条弯折带（俯视变形的根源，
   * dev / 实验台同样存在，属离轴投影物理特性而非渲染回归）。
   * 此时改用正视相机渲两面 RT，屏面退化为普通平面屏：任何角度看都是
   * 干净的内容画面；回到合理锥角后自动切回离轴。迟滞阈值防临界抖动。 */
  const FRONT_ENTER_COS = 0.5;   // 与任一面法线夹角 > 60°（贴脸走过）→ 进入正视降级
  const FRONT_EXIT_COS = 0.58;   // 全部面夹角 < ~55° → 切回离轴
  const FRONT_TOP_ENTER = 4;     // 眼高于屏顶 4m（俯瞰）→ 进入正视降级
  const FRONT_TOP_EXIT = 2.5;    // 降级后需降回屏顶 2.5m 以内才切回（迟滞）
  const FRONT_DIST = 24;         // 降级相机：沿面法线退距（fov 55° 下可容纳出屏内容）
  let frontalMode = false;
  const frontCam = new THREE.PerspectiveCamera(55, RTW / RTH, NEAR, FAR);
  frontCam.layers.set(layer);
  frontCam.coordinateSystem = renderer.coordinateSystem;

  /* —— 提示专用正交场景（加载中 / 失败时两面 RT 都画这张正对观众的图） —— */
  const noticeScene = new THREE.Scene();
  noticeScene.background = AD_BG;
  const noticeCam = new THREE.OrthographicCamera(-1.5, 1.5, 1, -1, 0.1, 10);
  noticeCam.position.set(0, 0, 2);
  noticeCam.lookAt(0, 0, 0);
  noticeCam.coordinateSystem = renderer.coordinateSystem;
  noticeCam.updateProjectionMatrix();

  /* —— 独立内容场景（性能关键）——
   * 旧实现直接把整座城市主 scene 交给 projCam 渲两遍，靠 layers 过滤。
   * three 的 projectObject 会无条件递归整棵场景树，几千个分块/建筑/行人
   * 每帧被遍历 2 次；而且每帧把主 scene 的 background/fog 改掉再还原，
   * fog 变化会让所有 fog 材质走 program 变更检查甚至重编译。
   * 这里改用一张只装内容层的 Scene：世界坐标不变、adScene 无变换、
   * offAxis 投影矩阵完全不变，画面等价，但遍历量从「整城」降到十几个对象，
   * 也彻底不用再碰主场景的背景/雾。 */
  const adScene = new THREE.Scene();
  adScene.background = AD_BG;
  adScene.fog = null;
  // 保持与主场景一致的 IBL 设置：游戏主场景目前未用 environment，
  // 但将来若接入 PMREM，金属材质（demo1 / GLB）的反射观感不会与原实现分叉。
  adScene.environment = scene.environment || null;
  adScene.environmentIntensity = scene.environmentIntensity ?? 1;

  /* —— 内容层：挂在独立场景，主相机（layer 0）看不到 —— */
  const contentRoot = new THREE.Group();
  contentRoot.scale.setScalar(scale);
  adScene.add(contentRoot);
  setLayer(contentRoot, layer);

  // 实验台 §6 bgBoard：内腔背板，内容后 19m，双面
  const bgBoard = new THREE.Mesh(
    new THREE.PlaneGeometry(46, 30),
    new THREE.MeshBasicMaterial({ map: adBackTex(), side: THREE.DoubleSide, fog: false }),
  );
  bgBoard.position.copy(VC).addScaledVector(OUT, -19);
  bgBoard.lookAt(_look.copy(VC).addScaledVector(OUT, 30));
  adScene.add(bgBoard);
  setLayer(bgBoard, layer);

  // 内容层灯光：环境光 1.15 + 广告主光 1.6（实验台 addLight 同款）
  const ambient = new THREE.AmbientLight(0xffffff, 1.15);
  ambient.layers.set(layer);
  adScene.add(ambient);
  const adSun = new THREE.DirectionalLight(0xffffff, 1.6);
  adSun.position.copy(VC).add(new THREE.Vector3(-10.5, 10, -10.5));
  adSun.target.position.copy(VC);
  adSun.layers.set(layer);
  adSun.target.layers.set(layer);
  adScene.add(adSun, adSun.target);

  /* —— 视线/眼位辅助线（layer 0，主相机可见；留在主场景）—— */
  const helper = new THREE.Group();
  helper.visible = false;
  const helperMat = new THREE.LineBasicMaterial({ color: 0x35e8ff, transparent: true, opacity: 0.55, depthTest: false });
  const helperPos = new Float32Array(faces.length * 4 * 2 * 3);
  const helperGeo = new THREE.BufferGeometry();
  helperGeo.setAttribute("position", new THREE.BufferAttribute(helperPos, 3));
  const helperLines = new THREE.LineSegments(helperGeo, helperMat);
  helperLines.renderOrder = 990;
  helperLines.frustumCulled = false;
  const eyeBall = new THREE.Mesh(
    new THREE.SphereGeometry(0.28, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0xffd45e, depthTest: false }),
  );
  eyeBall.renderOrder = 991;
  eyeBall.frustumCulled = false;
  helper.add(helperLines, eyeBall);
  scene.add(helper);

  /* —— 内容构建 —— */
  let demoKnot = null, mixer = null, loadBoard = null, dead = false;
  let demo2 = null, t2 = 0, innerUpdate = null, innerItem = null;
  let calibObj = null;
  let boardTex = null;                    // 平面素材纹理：用 version 捕捉异步加载/重绘
  const disposers = [];

  /* ---- 片源缓存状态（实验台 rtDirty / videoFrameDriven 同款） ---- */
  let rtDirty = true;                     // 首帧必渲
  let videoActive = false, videoFrameDriven = false, lastVideoFrame = 0;
  let videoCbId = 0, videoEl = null;
  let lastTexVersion = -1;
  const lastRtEye = new THREE.Vector3(Infinity, Infinity, Infinity);
  // 视频判定以 2D 工厂为准（占位/海报降级时 isVideo 仍为 true，但不会误判静态素材）

  const markRtDirty = () => { rtDirty = true; };
  const hasVideo = () => !!(innerItem && innerItem.isVideo);
  function rtNeedsRender() {
    if (DEBUG_3D) return true;         // 诊断模式强制每帧重渲，避免缓存掩盖问题
    if (rtDirty) return true;
    if (loadBoard) return false;           // 加载/失败提示板是静态的：只在标脏时画一次
    // 自带动画的内容（含内容根节点摆动）每帧都在变
    if (demo2 || demoKnot || calibObj || mixer || spin) return true;
    if (hasVideo()) {
      if (!videoActive) return false;      // 远距暂停解码 / 未连流：缓存最后一帧
      if (!videoFrameDriven) return true; // 浏览器不支持 rVFC：回退每帧
      return performance.now() - lastVideoFrame > VIDEO_WATCHDOG_MS; // 看门狗兜底
    }
    return false;                          // 静态图片 / 广告 / 文字 / 静态 GLB：靠事件标脏
  }
  /** 绑定视频真实帧回调：只有解码出新帧才重渲两路 RT，而不是跟着显示器刷新率 */
  function bindVideoFrames(v) {
    videoEl = v;
    videoFrameDriven = false;
    if (!v || typeof v.requestVideoFrameCallback !== "function") return;
    videoFrameDriven = true;
    lastVideoFrame = performance.now();
    const cb = () => {
      lastVideoFrame = performance.now();
      RT_STATS.videoFrames++;
      markRtDirty();
      try { videoCbId = v.requestVideoFrameCallback(cb); } catch { videoFrameDriven = false; }
    };
    try { videoCbId = v.requestVideoFrameCallback(cb); } catch { videoFrameDriven = false; }
  }

  /* —— 屏体视锥包围球（世界坐标）：屏不在取景视野内就不生成片源 —— */
  const hudOn = !!(d3 && d3.hud);
  let wasInView = true;
  const cullSphere = new THREE.Sphere();
  {
    const box = new THREE.Box3();
    for (const f of faces) for (const p of [f.pa, f.pb, f.pc, f.pd]) box.expandByPoint(p);
    box.getBoundingSphere(cullSphere);
    cullSphere.radius = cullSphere.radius * 1.3 + 8; // 屏体外沿 + 出屏内容 + 转身一帧余量
  }

  const showBoard = (message) => {
    if (loadBoard) { noticeScene.remove(loadBoard); disposeTree(loadBoard); }
    loadBoard = noticeBoard(message, 2.6, 2.6 * 288 / 512);
    noticeScene.add(loadBoard);
    markRtDirty();
  };
  const clearBoard = () => {
    if (loadBoard) { noticeScene.remove(loadBoard); disposeTree(loadBoard); loadBoard = null; }
    markRtDirty();
  };
  const fail = (message) => { if (!dead) showBoard(message); };

  if (it.type === "model3d") {
    const load = plan3dLoad(it.url);
    if (load.kind === "demo1") {
      const demo = buildDemo1();
      demoKnot = demo.knot;
      demo.group.scale.setScalar(gScale);
      contentRoot.add(demo.group);
      disposers.push(() => disposeTree(demo.group));
    } else if (load.kind === "demo2") {
      demo2 = buildDemo2(VC, OUT, gScale);
      adScene.add(demo2.root, demo2.tunnel);
      setLayer(demo2.root, layer);
      setLayer(demo2.tunnel, layer);
      disposers.push(() => {
        adScene.remove(demo2.root, demo2.tunnel);
        disposeTree(demo2.root);
        demo2.tunnel.geometry.dispose(); demo2.tunnel.material.dispose();
      });
    } else if (load.kind === "calib") {
      const calib = buildCalib();
      calib.position.copy(VC);
      calib.scale.setScalar(gScale);
      adScene.add(calib);
      setLayer(calib, layer);
      calibObj = calib; // 实验台同款：绕 Y 慢转 + 轻微俯仰摆动
      disposers.push(() => { adScene.remove(calib); disposeTree(calib); });
    } else if (load.kind === "glb") {
      showBoard("3D 模型加载中…");
      fetch(load.url, { mode: "cors" })
        .then((res) => {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.arrayBuffer();
        })
        .then((buf) => parseGLB(buf))
        .then((gltf) => {
          if (dead) return;
          clearBoard();
          const obj = gltf.scene || (gltf.scenes && gltf.scenes[0]);
          // 实验台 parseGLB 同款归一化：最大边 9.5，中心移到原点，双面、无雾
          const box = new THREE.Box3().setFromObject(obj);
          const size = box.isEmpty() ? new THREE.Vector3(1, 1, 1) : box.getSize(new THREE.Vector3());
          const c = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
          const maxDim = Math.max(size.x, size.y, size.z) || 1;
          const s = 9.5 / maxDim;
          obj.scale.setScalar(s);
          obj.position.set(-c.x * s, -c.y * s, -c.z * s);
          obj.traverse((n) => {
            if (n.isMesh && n.material) {
              for (const m of Array.isArray(n.material) ? n.material : [n.material]) { m.fog = false; m.side = THREE.DoubleSide; }
            }
          });
          const wrap = new THREE.Group();
          wrap.add(obj);
          wrap.scale.setScalar(gScale);
          contentRoot.add(wrap);
          setLayer(wrap, layer);
          if (gltf.animations && gltf.animations.length) {
            mixer = new THREE.AnimationMixer(obj);
            for (const clip of gltf.animations) mixer.clipAction(clip).play();
          }
          disposers.push(() => disposeTree(wrap));
          markRtDirty();              // 异步加载完成：片源内容变了，必须重渲两路 RT
        })
        .catch(() => fail("3D 模型加载失败｜检查地址、跨域 CORS 与文件格式（.glb）"));
    } else {
      fail(load.message);
    }
  } else {
    // 平面素材（image/text/clock/ad/video/stream）：复用 2D 工厂生成纹理，
    // 贴板放进 contentRoot 参与离轴取景（实验台 applyTexture 同款）
    const inner = make2d ? make2d() : null;
    if (!inner || !inner.texture) {
      fail("该内容在 3D 屏上不可用｜请检查节目单配置");
    } else {
    const tex = inner.texture;
    const img = tex.image;
    const srcAspect = (img && (img.videoWidth || img.width) && (img.videoHeight || img.height))
      ? (img.videoWidth || img.width) / (img.videoHeight || img.height) : aspect;
    // 实验台 applyTexture 同款：14×9 包围盒内按素材宽高比生成板子
    let bw = 14, bh = bw / srcAspect;
    if (bh > 9) { bh = 9; bw = bh * srcAspect; }
    bw *= gScale; bh *= gScale;
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(bw, bh),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true, fog: false }),
    );
    board.rotation.y = Math.atan2(OUT.x, OUT.z); // 板面正对出屏方向（实验台 -3π/4 的通式）
    // 板子按设计视距折算：出屏 depth 后从固定视点看仍约等于满屏
    const k = Math.max(0.3, Math.min(1, 1 - depth / DESIGN_DIST));
    board.scale.setScalar(k);
    contentRoot.add(board);
    disposers.push(() => { disposeTree(board); if (inner.dispose) try { inner.dispose(); } catch { /* 已释放 */ } });
    if (inner.kind === "animated" && inner.update) innerUpdate = inner.update.bind(inner);
    innerItem = inner;
    boardTex = tex;
    // 视频/直播：按真实帧率标脏（rVFC）；图片/文字的异步加载与重绘则靠 texture.version
    if (inner.isVideo) bindVideoFrames(inner.video || null);
    }
  }

  // 关键：同步构建的内容（demo1 环形装置 / 平面素材板）是在 setLayer(contentRoot)
  // 之后才 add 进来的 —— 新挂的子对象保持默认 layer 0，会被主相机直接画出来，
  // 叠在屏面内容上且不再更新（残留）。这里对整棵内容树重刷一次层。
  setLayer(contentRoot, layer);

  return {
    // 纹理 = 两面屏的 RT 纹理数组：billboard.js 的 onSwap 识别数组后按面分配
    texture: rts.map((r) => r.rt.texture),
    kind: "animated",
    is3d: true,
    rts,
    helper,
    isVideo: !!(it.type !== "model3d" && innerItem && innerItem.isVideo),
    video: it.type !== "model3d" && innerItem ? innerItem.video : undefined,
    /** 池调度：远距暂停解码 / 恢复播放。恢复时必须重渲，否则片源停在旧帧 */
    setActive(on) {
      videoActive = !!on;
      if (on) markRtDirty();
      if (innerItem && innerItem.setActive) innerItem.setActive(on);
    },
    setAudio(on) { if (innerItem && innerItem.setAudio) innerItem.setAudio(on); },
    /** 外部强制刷新片源（后台热更新 / 屏重新进入视野） */
    invalidate() { markRtDirty(); },
    /** 主循环：内容动画 + 双路离轴渲染（实验台 frame() 同款 + 片源缓存） */
    update(dt, time, focus, camera) {
      if (dead) return;

      // 虚拟眼睛：实时追踪 = 取景相机位置；固定 = 屏前最佳视点（实验台 HERO 档）
      if (DEBUG_3D === 3) {
        _eye.copy(VC).addScaledVector(OUT, EYE_DIST).setY(EYE_H);
      } else if (track && camera && camera.position && Number.isFinite(camera.position.x)) {
        _eye.copy(camera.position);
      } else {
        _eye.copy(VC).addScaledVector(OUT, EYE_DIST).setY(EYE_H);
      }
      // 眼睛安全区钳制：离轴预畸变只对「屏前合理位置」有意义，
      // 屏面附近/屏后的极端视锥会把整幅画面拉花（预畸变放大到无意义）
      _rel.subVectors(_eye, VC);
      const along = _rel.dot(OUT);
      const fixedAlong = Math.max(4, Math.min(EYE_DIST * 4, along));
      if (fixedAlong !== along) _eye.addScaledVector(OUT, fixedAlong - along);
      _rel.subVectors(_eye, VC);
      const lateral = _rel.addScaledVector(OUT, -_rel.dot(OUT)).length();
      if (lateral > 60) _eye.sub(VC).setLength(60).add(VC);

      // 视线/眼位辅助线：虚拟眼睛 → 两面屏四角（实验台 helper 同款，layer 0 主相机可见）
      if (helper.visible) {
        let o = 0;
        for (const r of rts) {
          for (const p of [r.f.pa, r.f.pb, r.f.pc, r.f.pd]) {
            helperPos[o++] = _eye.x; helperPos[o++] = _eye.y; helperPos[o++] = _eye.z;
            helperPos[o++] = p.x; helperPos[o++] = p.y; helperPos[o++] = p.z;
          }
        }
        helperGeo.attributes.position.needsUpdate = true;
        eyeBall.position.copy(_eye);
      }

      /* ---- 极端眼位判定：贴脸走过 / 俯瞰则整屏切正视降级（见上方 FRONT_* 注释） ----
       * 诊断模式 2（?bb3ddebug=2）豁免：它本身就要走离轴/透视对照路径。
       * 注意地面 45° 斜看（corner-on 经典观赏位）不在降级之列：判定除了
       * 夹角还要求眼睛明显高于屏顶，两个条件都带迟滞防临界抖动。 */
      if (!dbgCam) {
        let worstCos = 1, topY = -Infinity;
        for (const r of rts) {
          topY = Math.max(topY, r.f.pa.y, r.f.pb.y, r.f.pc.y, r.f.pd.y);
          _rel.subVectors(_eye, r.center);
          const len = _rel.length();
          const c2 = len > 1e-3 ? _rel.divideScalar(len).dot(r.normal) : 0;
          if (c2 < worstCos) worstCos = c2;
        }
        const offZone = frontalMode
          ? (worstCos < FRONT_EXIT_COS || _eye.y > topY + FRONT_TOP_EXIT)
          : (worstCos < FRONT_ENTER_COS || _eye.y > topY + FRONT_TOP_ENTER);
        if (offZone !== frontalMode) { frontalMode = offZone; markRtDirty(); }
      }

      /* ---- 视锥剔除：屏不在取景视野内就完全不生成片源 ----
       * 开放世界里一块屏可能长期在 300m 激活半径内、却始终背对玩家；
       * 提前 return 连 demo2 的 140 实例矩阵 / 700 点重算都省掉。
       * HUD 双路预览或辅助线开着时豁免（调试视图需要活着）。 */
      let inView = true;
      if (!hudOn && !helper.visible && camera && camera.isPerspectiveCamera) {
        camera.updateMatrixWorld();
        _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        _frustum.setFromProjectionMatrix(_projScreen, renderer.coordinateSystem);
        inView = _frustum.intersectsSphere(cullSphere);
      }
      if (inView && !wasInView) markRtDirty(); // 重新进入视野：立刻用最新眼位重建片源
      wasInView = inView;
      if (!inView) { RT_STATS.skips++; return; }

      // 2D 画布 / 视频帧刷新（clock、ticker、慢路径视频内部自带节流）
      if (innerUpdate) innerUpdate(dt, time);
      if (demo2) t2 = (t2 + dt) % 12;
      if (mixer) mixer.update(dt);

      /* ---- 脏标记：内容 / 眼位 / 纹理新帧 ---- */
      // 离轴投影矩阵随眼位变化，玩家走动时静态素材也必须跟着重算（物理必需）；
      // 站着不动则命中缓存。比实验台的「track 就无条件每帧渲」更精细。
      if (_eye.distanceToSquared(lastRtEye) > EYE_EPS2) markRtDirty();
      // texture.version 捕捉：图片异步加载完成、Canvas 重绘、VideoTexture 新帧、失败海报
      if (boardTex && boardTex.version !== lastTexVersion) {
        lastTexVersion = boardTex.version;
        markRtDirty();
      }

      if (!rtNeedsRender()) { RT_STATS.skips++; return; }
      RT_STATS.renders++;

      // 只有真正要渲 RT 的帧才更新 3D 内容变换（demo2 有 140 实例矩阵 + 700 点重算）
      contentRoot.position.copy(VC).addScaledVector(OUT, depth);
      contentRoot.rotation.y = spin ? Math.sin(time * 0.35) * 0.12 : 0;
      if (demo2) demo2.update(t2, _eye);
      else if (demoKnot) demoKnot.rotation.y = time * 0.55;
      // 几何校准片：绕 Y 慢转 + 轻微俯仰摆动（实验台 frame() 同款）
      if (calibObj) { calibObj.rotation.y = time * 0.32; calibObj.rotation.x = Math.sin(time * 0.4) * 0.08; }

      const savedShadow = renderer.shadowMap.autoUpdate;
      renderer.shadowMap.autoUpdate = false; // RT 渲染不重复生成阴影贴图
      const prevRT = renderer.getRenderTarget();
      if (loadBoard) {
        // 提示态：两面 RT 都画同一张正视提示图（静态，只在标脏时画一次）
        for (const r of rts) {
          renderer.setRenderTarget(r.rt);
          renderer.render(noticeScene, noticeCam);
        }
      } else if (frontalMode) {
        // 极端眼位正视降级：每面从自己的法线方向正视内容，两面画面一致、
        // 不随眼位畸变。相机固定（不随眼位），静态内容在降级期间命中缓存。
        const contentWorld = _look.copy(VC).addScaledVector(OUT, depth);
        for (const r of rts) {
          frontCam.position.copy(r.center).addScaledVector(r.normal, FRONT_DIST);
          frontCam.lookAt(contentWorld);
          frontCam.coordinateSystem = renderer.coordinateSystem;
          frontCam.updateProjectionMatrix();
          renderer.setRenderTarget(r.rt);
          renderer.render(adScene, frontCam);
        }
      } else {
        // 双路离轴：渲独立 adScene，不再碰主场景（背景/雾/整城遍历都省掉）
        const isWebGPU = renderer.coordinateSystem === THREE.WebGPUCoordinateSystem;
        // 每帧对齐一次：WebGPURenderer 初始化完成前后端可能切换，也防外部改回
        projCam.coordinateSystem = renderer.coordinateSystem;
        for (const r of rts) {
          if (dbgCam) {
            dbgCam.position.copy(VC).addScaledVector(OUT, 24);
            dbgCam.lookAt(contentRoot.position);
            dbgCam.coordinateSystem = renderer.coordinateSystem;
            dbgCam.updateProjectionMatrix();
            projCam.projectionMatrix.copy(dbgCam.projectionMatrix);
            projCam.projectionMatrixInverse.copy(dbgCam.projectionMatrix).invert();
          } else {
            const M = offAxis(r.f.pa, r.f.pb, r.f.pc, _eye, NEAR, FAR, isWebGPU);
            projCam.projectionMatrix.copy(M);
            projCam.projectionMatrixInverse.copy(M).invert();
          }
          renderer.setRenderTarget(r.rt);
          renderer.render(adScene, projCam);
        }
      }
      renderer.setRenderTarget(prevRT);
      renderer.shadowMap.autoUpdate = savedShadow;
      lastRtEye.copy(_eye);
      rtDirty = false;
    },
    dispose() {
      dead = true;
      videoActive = false;
      if (videoEl && videoCbId && typeof videoEl.cancelVideoFrameCallback === "function") {
        try { videoEl.cancelVideoFrameCallback(videoCbId); } catch { /* 已取消 */ }
      }
      videoCbId = 0;
      clearBoard();
      if (mixer) mixer.stopAllAction();
      for (const fn of disposers) { try { fn(); } catch { /* 已释放则忽略 */ } }
      adScene.remove(contentRoot, bgBoard, ambient, adSun, adSun.target);
      scene.remove(helper);
      disposeTree(contentRoot);
      bgBoard.geometry.dispose(); bgBoard.material.map.dispose(); bgBoard.material.dispose();
      helperLines.geometry.dispose(); helperMat.dispose();
      eyeBall.geometry.dispose(); eyeBall.material.dispose();
      for (const r of rts) r.rt.dispose();
    },
  };
}
