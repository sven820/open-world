import * as THREE from "three/webgpu";
import { uniform, positionWorld, normalWorld, uv, mix, vec3 } from "three/tsl";
import { makeCanvas } from "../textures.js";
import { parseGLB } from "../../data/assetStore.js";

/* ---------------- 3D 裸眼内容源 —— rea/billboard-content-lab 逐字复刻 ----------------
 * 架构与实验台（PULSE · 内容源实验台 _template.html）完全一致，不做自行发挥：
 *
 *   实验台 §2  渲染器/场景：主相机只看 layer 0；projCam = new Camera() 只看 layer 1
 *   实验台 §4  L 形共棱屏体：两面屏面 quadGeom(pa,pb,pc,pd)，各自一块 WebGLRenderTarget
 *   实验台 §5  离轴投影 offAxis(pa,pb,pc,pe,near,far)（逐字同款投影矩阵）
 *   实验台 §6  内容层：contentRoot/bgBoard/灯光放主场景 layer 1，材质一律 fog:false
 *   实验台 frame() 主循环（992-1000 行）：
 *         场景背景/雾临时替换 → 双路离轴渲染进 RT → 还原
 *         contentRoot.position = VC + OUT·depth；rotation.y = sin(t·0.35)·0.12
 *         demoKnot.rotation.y = t·0.55
 *
 * 与实验台的仅有的两处适配（不改变效果）：
 *   1. 实验台的场地常量(VC/OUT/屏尺寸)换成本块屏的实际世界坐标：
 *      OUT = 两面外法线之和归一化（实验台 OUT=(-0.707,0,-0.707) 即此式的特例）；
 *      VC  = 转角棱线中点向屏体内收 2.8m/轴（实验台 VC=(2.5,10,2.5) 的构造方式）。
 *   2. 每块 3D 屏独占一个 layer（1~30），多块 3D 屏互不串扰；主相机默认只开 layer 0。
 *
 * 内容条目 type:"model3d"：
 *   url    GLB 模型地址；空 / "builtin://demo1" = 实验台 makeDemo() 同款内置 3D 演示1；
 *          "builtin://demo2" = 实验台 §6b 原版品牌广告（12 秒循环时间轴，自带深度，忽略通用 depth）
 *   depth  出屏深度（米，0~10）：contentRoot.position = VC + OUT·depth（同实验台滑杆）
 ---------------------------------------------------------------------- */

const NEAR = 0.12, FAR = 400;      // 实验台 frame() 同款
const RTW = 768, RTH = 512;        // 实验台 RT 尺寸同款
const EYE_H = 1.7;                 // 观看视点离地高度（玩家视高）

/* —— 诊断模式（URL 参数 ?bb3ddebug=N，配合 billboard.js 的测试图案）——
 * 1 = 屏面显示 FACE A/B 测试图案（billboard.js，验证两面屏几何/UV/分配）
 * 2 = RT 改用普通透视相机渲染（绕开离轴投影：若屏面内容恢复正常连贯，
 *     即离轴投影矩阵在 WebGPU 下有实锤问题）
 * 3 = 虚拟眼睛固定在默认位置（忽略玩家 focus：若屏面恢复 dev 的连贯画面，
 *     即 focus/eye 位置导致分裂） */
export const DEBUG_3D =
  (typeof location !== "undefined" && /bb3ddebug=(\d)/.exec(location.search || ""))
    ? Number(RegExp.$1) : 0;
const AD_BG = new THREE.Color(0x05101f); // 实验台 adBg 同款：RT 渲染期间的场景背景

/* 实验台 §5 离轴投影（_template.html 417-429 行逐字同款，仅改 three 引用名） */
const _vr = new THREE.Vector3(), _vu = new THREE.Vector3(), _vn = new THREE.Vector3();
const _va = new THREE.Vector3(), _vb = new THREE.Vector3(), _vc = new THREE.Vector3();
const _P = new THREE.Matrix4(), _R = new THREE.Matrix4(), _Tm = new THREE.Matrix4(), _M = new THREE.Matrix4();
const _eye = new THREE.Vector3(), _look = new THREE.Vector3();

function offAxis(pa, pb, pc, pe, near, far, webgpuCS) {
  _vr.subVectors(pb, pa).normalize(); _vu.subVectors(pc, pa).normalize();
  _vn.crossVectors(_vr, _vu).normalize();
  _va.subVectors(pa, pe); _vb.subVectors(pb, pe); _vc.subVectors(pc, pe);
  let d = -_vn.dot(_va); if (d < 0.05) d = 0.05;
  const l = _vr.dot(_va) * near / d, r = _vr.dot(_vb) * near / d,
    b = _vu.dot(_va) * near / d, t = _vu.dot(_vc) * near / d;
  // z 行按坐标系约定区分：WebGL z∈[-1,1]，WebGPU z∈[0,1]
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

/* 实验台 §6 setLayer 同款 */
function setLayer(o, n) { o.traverse(function (c) { c.layers.set(n); }); return o; }

/* 多块 3D 屏各占一个 layer（主相机默认只开 layer 0，不会看到内容层） */
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

/* 屏内提示板（加载中 / 失败提示） */
function noticeBoard(line, sizeW, sizeH) {
  const c = makeCanvas(512, 288);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#04121e"; ctx.fillRect(0, 0, 512, 288);
  ctx.strokeStyle = "rgba(53,232,255,.35)"; ctx.lineWidth = 5;
  ctx.strokeRect(8, 8, 496, 272);
  ctx.fillStyle = "#eafcff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.font = "700 44px 'Noto Sans SC', 'Microsoft YaHei', sans-serif";
  ctx.fillText("PULSE", 256, 100);
  ctx.fillStyle = "#b9d6e4";
  ctx.font = "600 26px 'Noto Sans SC', 'Microsoft YaHei', sans-serif";
  ctx.fillText(line, 256, 180);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(
    new THREE.PlaneGeometry(sizeW, sizeH),
    new THREE.MeshBasicMaterial({ map: t, side: THREE.DoubleSide, fog: false }),
  );
}

/* 无 ctx（非 corner3d 屏 / 编辑器预览）：静态占位画面 */
function make3dFallback(it, W, H, line) {
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

function faceNormal(f) {
  // 与实验台 quadGeom/offAxis 右手系一致：right(pb-pa) × up(pc-pa) = 屏面外法线
  return _vn.copy(f.pb).sub(f.pa).cross(_va.copy(f.pc).sub(f.pa)).normalize().clone();
}

/**
 * 3D 裸眼内容源工厂（contentSource.createContentPool 分发）。
 * @param {object} it   content 条目 { url, depth, duration }
 * @param {number} W,H  内容池位图基准尺寸（仅占位画面使用）
 * @param {object|null} ctx  { renderer, scene, faces:[{pa,pb,pc,pd 世界坐标 Vector3}] }
 */
export function makeModel3D(it, W, H, ctx) {
  const faces = ctx && Array.isArray(ctx.faces) ? ctx.faces : null;
  const renderer = ctx && ctx.renderer;
  const scene = ctx && ctx.scene;
  if (!faces || faces.length < 2 || !renderer || !scene) {
    return make3dFallback(it, W, H, "3D 裸眼内容仅支持 3D转角包柱屏");
  }

  const depth = Math.min(10, Math.max(0, Number(it.depth) || 2.5));
  const url = String(it.url || "").trim();
  const builtinDemo1 = !url || url === "builtin://demo1";
  const builtinDemo2 = url === "builtin://demo2";
  let dead = false, failed = false;

  /* —— 场地常量（实验台 §1 的世界坐标版） —— */
  const layer = allocLayer();
  // 出屏方向 OUT：两面外法线之和归一化（实验台 OUT=(-0.707,0,-0.707) 即此式特例）
  const OUT = faceNormal(faces[0]).add(faceNormal(faces[1])).normalize();
  // pc 在 pa 正上方（实验台 faceDefs 约定）：面宽 = pa→pb，面高 = pa→pc
  const faceH = faces[0].pa.distanceTo(faces[0].pc);
  const faceW = faces[0].pa.distanceTo(faces[0].pb);
  // VC：转角棱线中点向屏体内收 2.8m/轴（实验台 VC=(2.5,10,2.5) 同款构图）
  const edge = faces[0].pb.clone().add(faces[0].pd).multiplyScalar(0.5);
  const VC = edge.clone().addScaledVector(OUT, -2.8 * Math.SQRT2);

  /* —— 实验台 §4/§5：每面一块 RT + projCam（只看内容层） —— */
  const projCam = new THREE.Camera();          // 实验台同款：裸 Camera + 手写投影矩阵
  projCam.layers.set(layer);
  projCam.matrixAutoUpdate = false;
  // 诊断模式 2：普通透视相机（绕开离轴投影）
  const dbgCam = DEBUG_3D === 2 ? new THREE.PerspectiveCamera(55, RTW / RTH, NEAR, FAR) : null;
  let _dbgTick = 0;
  const rts = faces.map((f) => ({
    f,
    // RenderTarget 基类：WebGPU 与 WebGL 回退后端通用（WebGLRenderTarget 是 WebGL 专属包装）
    rt: new THREE.RenderTarget(RTW, RTH, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false,
    }),
  }));

  /* —— 实验台 §6 内容层：直接放主场景，主相机（layer 0）看不到 —— */
  const contentRoot = new THREE.Group();
  scene.add(contentRoot);
  setLayer(contentRoot, layer);

  // 实验台 §6 bgBoard：46×30 内腔背板，内容后 19m，双面
  const bgBoard = new THREE.Mesh(
    new THREE.PlaneGeometry(46, 30),
    new THREE.MeshBasicMaterial({ map: adBackTex(), side: THREE.DoubleSide, fog: false }),
  );
  bgBoard.position.copy(VC).addScaledVector(OUT, -19);
  bgBoard.lookAt(_look.copy(VC).addScaledVector(OUT, 30));
  scene.add(bgBoard);
  setLayer(bgBoard, layer);

  // 实验台 addLight(l,1)：内容层环境光 1.15 + 广告主光 1.6（offset 同实验台相对 VC 的方向）
  const ambient = new THREE.AmbientLight(0xffffff, 1.15);
  ambient.layers.set(layer);
  scene.add(ambient);
  const adSun = new THREE.DirectionalLight(0xffffff, 1.6);
  adSun.position.copy(VC).add(new THREE.Vector3(-10.5, 10, -10.5)); // 实验台 (-8,20,-8) 相对 VC=(2.5,10,2.5)
  adSun.target.position.copy(VC);
  adSun.layers.set(layer);
  adSun.target.layers.set(layer);
  scene.add(adSun, adSun.target);

  /* —— 内容：实验台 makeDemo() 逐字复刻，或 3D 演示 2（实验台 §6b），或 GLB 模型 —— */
  let demoKnot = null, mixer = null, loadBoard = null, disposeModel = null, demo2Tick = null;

  const showBoard = (line) => {
    if (loadBoard) { contentRoot.remove(loadBoard); disposeTree(loadBoard); }
    loadBoard = noticeBoard(line, Math.min(faceW * 0.6, 10), Math.min(faceH * 0.35, 5));
    contentRoot.add(loadBoard);
    setLayer(loadBoard, layer);
  };
  const clearBoard = () => {
    if (loadBoard) { contentRoot.remove(loadBoard); disposeTree(loadBoard); loadBoard = null; }
  };
  const fail = (line) => {
    if (failed || dead) return;
    failed = true;
    showBoard(line);
  };

  if (builtinDemo2) {
    /* —— 3D 演示 2：实验台 §6b 原版品牌广告（461-600 行）逐字复刻 ——
     * 12 秒循环时间轴（0-2 汇聚 / 2-6 飞近 / 6-10 破屏 / 10-12 回收），自带深度。
     * 仅有两处适配（不改变效果）：
     *   1. GLSL ShaderMaterial → TSL 节点材质（WebGPU 后端编译不了 GLSL，environment.js 同款处理）；
     *   2. 实验台 Points 粒子 → 同 seed 的实例化小球（WebGPU 后端 Points 只有 1px）。
     * 隧道水平方向用屏面实际方向替代实验台固定对角线 (.7071,0,-.7071)。 */
    const s = Math.min(faceH / 8, 2.5);   // 实验台按 12×8 屏设计；按实际屏高等比折算（同 demo1）
    const RIGHT = _va.copy(faces[0].pb).sub(faces[0].pa).normalize().clone(); // 屏面水平方向
    const U2 = {
      eye: uniform(new THREE.Vector3()),
      time: uniform(0),
      alpha: uniform(1),
    };
    // 金属罐体（metalVS/metalFS 逐式 TSL 化）
    const N = normalWorld.normalize();
    const V = U2.eye.sub(positionWorld).normalize();
    const L = vec3(0.45, 0.85, 0.65).normalize();
    const d = N.dot(L).max(0);
    const rim = V.dot(N).max(0).oneMinus().pow(2.1);
    const band = uv().y.mul(26).add(U2.time.mul(0.9)).sin().mul(0.5).add(0.5);
    const base = mix(vec3(0.12, 0.16, 0.22), vec3(0.88, 0.95, 1.0), d.mul(0.66).add(0.34)).add(band.mul(0.045));
    const metalMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, fog: false });
    metalMat.toneMapped = false;   // 原 ShaderMaterial 输出不经 tone mapping
    metalMat.colorNode = base.add(rim.mul(vec3(0.0, 0.82, 1.0).mul(1.9))).add(rim.mul(rim).mul(vec3(1.0, 0.14, 0.58).mul(0.85)));
    metalMat.opacityNode = U2.alpha;
    const can = new THREE.Mesh(new THREE.CylinderGeometry(2.8, 2.8, 7.4, 48, 1, false), metalMat);
    // 罐体标签（labelTex() 逐字）
    const q = makeCanvas(1024, 512), x = q.getContext("2d");
    const g = x.createLinearGradient(0, 0, 1024, 512);
    g.addColorStop(0, "#062033"); g.addColorStop(0.5, "#0d4a63"); g.addColorStop(1, "#1d0b33");
    x.fillStyle = g; x.fillRect(0, 0, 1024, 512);
    x.strokeStyle = "rgba(53,232,255,.65)"; x.lineWidth = 14;
    for (let i = -512; i < 1536; i += 96) { x.beginPath(); x.moveTo(i, 512); x.lineTo(i + 300, 0); x.stroke(); }
    x.fillStyle = "rgba(4,12,22,.82)"; x.fillRect(90, 150, 844, 212);
    x.fillStyle = "#eafcff"; x.font = "bold 150px Arial"; x.textAlign = "center"; x.textBaseline = "middle";
    x.fillText("PULSE", 512, 256);
    x.fillStyle = "#35e8ff"; x.font = "bold 30px Arial"; x.fillText("E N E R G Y   /   3 D   C I T Y", 512, 420);
    const labelTex = new THREE.CanvasTexture(q);
    labelTex.colorSpace = THREE.SRGBColorSpace;
    const label = new THREE.Mesh(
      new THREE.CylinderGeometry(2.815, 2.815, 4.5, 48, 1, true),
      new THREE.MeshBasicMaterial({ map: labelTex, side: THREE.DoubleSide, transparent: true, fog: false }),
    );
    const demo2Root = new THREE.Group();
    demo2Root.add(can, label);
    // 上下金属沿口
    const rimMat = new THREE.MeshBasicMaterial({ color: 0xbfe6f2, fog: false });
    for (const y of [-3.75, 3.75]) {
      const r = new THREE.Mesh(new THREE.TorusGeometry(2.8, 0.12, 8, 48), rimMat);
      r.rotation.x = Math.PI / 2; r.position.y = y; demo2Root.add(r);
    }
    // 三道轨道光环
    const rings = [];
    [[5.2, 0x35e8ff], [7.0, 0xff3d9a], [8.8, 0x3aa0ff]].forEach(([rr, col], i) => {
      const m = new THREE.MeshBasicMaterial({
        color: col, transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
      });
      const o = new THREE.Mesh(new THREE.TorusGeometry(rr, 0.12, 6, 80), m);
      o.rotation.x = Math.PI / 2 + (i - 1) * 0.42;
      demo2Root.add(o); rings.push({ o, m, i });
    });
    // 水花（实验台 InstancedMesh 同款）
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
    demo2Root.add(drops);
    // 环境粒子（实验台 THREE.Points → 实例化小球，同 seed 同运动）
    const PN = 700;
    const sparkMat = new THREE.MeshBasicMaterial({
      color: 0x35e8ff, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    const sparks = new THREE.InstancedMesh(new THREE.SphereGeometry(0.16, 6, 4), sparkMat, PN);
    const pseed = [];
    for (let pp = 0; pp < PN; pp++) {
      pseed.push({ a: Math.random() * Math.PI * 2, r: 3 + Math.random() * 13, y: (Math.random() - 0.5) * 14, s: 0.4 + Math.random() * 1.6 });
    }
    demo2Root.add(sparks);
    demo2Root.scale.setScalar(s);
    scene.add(demo2Root);
    setLayer(demo2Root, layer);   // 必须在所有子对象添加完毕后再设置图层（实验台 548 行同款）
    // 透视隧道固定在世界空间，不随罐体位移（实验台 533-547 行；dep/tscale 同乘 s 折算）
    const tunnelMat = new THREE.LineBasicMaterial({ color: 0x1a7f9e, transparent: true, opacity: 0.28, fog: false });
    const tp = [];
    for (let ti = 0; ti < 9; ti++) {
      const dep = (-18 + ti * 3.2) * s, tscale = (5 + ti * 1.35) * s;
      const tc = VC.clone().addScaledVector(OUT, dep);
      const dx = RIGHT.clone().multiplyScalar(tscale), dy = new THREE.Vector3(0, tscale, 0);
      const c1 = tc.clone().sub(dx).sub(dy), c2 = tc.clone().add(dx).sub(dy),
        c3 = tc.clone().add(dx).add(dy), c4 = tc.clone().sub(dx).add(dy);
      for (const [p1, p2] of [[c1, c2], [c2, c3], [c3, c4], [c4, c1]]) {
        tp.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
      }
    }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute("position", new THREE.Float32BufferAttribute(tp, 3));
    const tunnel = new THREE.LineSegments(tg, tunnelMat);
    scene.add(tunnel);
    setLayer(tunnel, layer);
    disposeModel = () => {
      scene.remove(demo2Root, tunnel);
      disposeTree(demo2Root);
      tunnel.geometry.dispose(); tunnelMat.dispose();
    };
    // 实验台 updateDemo2()（566-600 行）逐字复刻；t = 12 秒循环时间轴
    const dummy = new THREE.Object3D();
    const clamp01 = (v) => Math.min(1, Math.max(0, v));
    const lerp = (a, b, k) => a + (b - a) * k;
    demo2Tick = (t) => {
      const depth2 = t < 2 ? lerp(-15, -9, t / 2)
        : t < 6 ? lerp(-9, 0.5, (t - 2) / 4)
        : t < 10 ? lerp(0.5, 4.6, (t - 6) / 4)
        : lerp(4.6, -15, (t - 10) / 2);
      demo2Root.position.copy(VC).addScaledVector(OUT, depth2 * s);
      const appear = clamp01(t / 1.2) * (t > 10.6 ? clamp01((12 - t) / 1.4) : 1);
      U2.alpha.value = appear;
      dropMat.opacity = appear;
      sparkMat.opacity = 0.95 * appear;
      tunnelMat.opacity = 0.42 * appear;
      can.rotation.y = t * 0.62; label.rotation.y = can.rotation.y;
      can.rotation.z = Math.sin(t * 0.5) * 0.12; label.rotation.z = can.rotation.z;
      demo2Root.rotation.y = Math.sin(t * 0.35) * 0.10;
      rings.forEach((o, i) => {
        o.o.rotation.z = t * (0.35 + i * 0.22) * (i % 2 ? -1 : 1);
        o.o.rotation.x = Math.PI / 2 + (i - 1) * 0.42 + Math.sin(t * 0.6 + i) * 0.16;
        o.m.opacity = 0.95 * appear * (0.6 + 0.4 * Math.sin(t * 1.1 + i));
      });
      const burst = clamp01((t - 3) / 4) * (t > 10 ? clamp01((12 - t) / 2) : 1);
      for (let i = 0; i < DN; i++) {
        const dd = dropSeed[i], a = dd.a + t * 0.55 * dd.vy, r = dd.rad * (0.6 + burst * 1.15);
        dummy.position.set(Math.cos(a) * r, dd.y + Math.sin(t * 1.3 + i) * 0.5 + burst * dd.vy * 1.8, Math.sin(a) * r);
        dummy.scale.setScalar(dd.s * appear * (0.5 + burst * 0.8));
        dummy.updateMatrix(); drops.setMatrixAt(i, dummy.matrix);
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
        dummy.updateMatrix(); sparks.setMatrixAt(j, dummy.matrix);
      }
      sparks.instanceMatrix.needsUpdate = true;
      U2.time.value = t;
      U2.eye.value.copy(_eye);
    };
  } else if (builtinDemo1) {
    /* 实验台 makeDemo()（667-680 行）逐字：纽结 + 三道轨道光环 */
    const g = new THREE.Group();
    demoKnot = new THREE.Mesh(
      new THREE.TorusKnotGeometry(2.0, 0.62, 140, 18),
      new THREE.MeshStandardMaterial({
        color: 0x2fd8f0, metalness: 0.55, roughness: 0.24,
        emissive: new THREE.Color(0x083c55), fog: false,
      }),
    );
    g.add(demoKnot);
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
    // 实验台原生比例按 12×8 屏设计；按实际屏高等比折算（不改变构图）
    g.scale.setScalar(Math.min(faceH / 8, 2.5));
    contentRoot.add(g);
    setLayer(g, layer);
    disposeModel = () => disposeTree(g);
  } else {
    showBoard("3D 模型加载中…");
    fetch(url, { mode: "cors" })
      .then((res) => { if (!res.ok) throw new Error("HTTP " + res.status); return res.arrayBuffer(); })
      .then((buf) => parseGLB(buf))
      .then((gltf) => {
        if (dead) return;
        clearBoard();
        const obj = gltf.scene || (gltf.scenes && gltf.scenes[0]);
        // 实验台 parseGLB（686-704 行）同款归一化：最大边 9.5，中心移到原点，双面、无雾
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
        wrap.scale.setScalar(Math.min(faceH / 8, 2.5)); // 实验台 12×8 屏比例折算
        contentRoot.add(wrap);
        setLayer(wrap, layer);
        if (gltf.animations && gltf.animations.length) {
          mixer = new THREE.AnimationMixer(obj);
          for (const clip of gltf.animations) mixer.clipAction(clip).play();
        }
        disposeModel = () => disposeTree(wrap);
      })
      .catch(() => fail("GLB 模型加载失败（检查地址 / CORS）"));
  }

  return {
    // 纹理 = 两面屏的 RT 纹理数组：billboard.js 的 onSwap 识别数组后按面分配
    texture: rts.map((r) => r.rt.texture),
    kind: "animated",
    is3d: true,
    /** 实验台 frame() 主循环（963-1001 行）同款：内容动画 + 双路离轴渲染 */
    update(dt, time, focus) {
      if (mixer) mixer.update(dt);
      // 976-979 行同款
      contentRoot.position.copy(VC).addScaledVector(OUT, depth);
      contentRoot.rotation.y = Math.sin(time * 0.35) * 0.12;
      if (demoKnot) demoKnot.rotation.y = time * 0.55;
      // 不提供 setActive：池级 setActive 是「视频解码并发配额」开关（画面设置可调），
      // 混合节目单里只要带一个视频条目，3D 池排到配额之外就会被整池停用，
      // RT 不再重绘、屏面定格。3D 内容本就不解码视频，交给管理器的近距调度即可
      // （离得远时 update 根本不会被调用）。failed 时仍继续渲染，让提示板能上屏。
      if (dead) return;
      // 虚拟眼睛 = 观看者真实位置（实验台 state.track ? camera.position : HERO 的"跟随"档）
      if (DEBUG_3D === 3) _eye.copy(VC).addScaledVector(OUT, 20).setY(VC.y * 0.4);
      else if (focus && Number.isFinite(focus.x)) _eye.set(focus.x, EYE_H, focus.z);
      else _eye.copy(VC).addScaledVector(OUT, 20).setY(VC.y * 0.4);
      if (demo2Tick) demo2Tick(time % 12);   // 3D 演示 2：12 秒循环时间轴（实验台 state.time=(state.time+dt)%12 同款）
      // 992-1000 行同款：临时替换背景/雾 → 双路离轴渲染 → 还原
      const savedBg = scene.background, savedFog = scene.fog;
      scene.background = AD_BG; scene.fog = null;
      const savedShadow = renderer.shadowMap.autoUpdate;
      renderer.shadowMap.autoUpdate = false; // RT 渲染不重复生成阴影贴图（主渲染前恢复）
      const prevRT = renderer.getRenderTarget();
      // 裸 Camera 的投影矩阵按当前后端的坐标系约定构建（WebGPU z∈[0,1]）；
      // renderer.render 会按 camera.coordinateSystem 判断是否需要重建逆矩阵
      const isWebGPU = renderer.coordinateSystem === THREE.WebGPUCoordinateSystem;
      projCam.coordinateSystem = renderer.coordinateSystem;
      if (DEBUG_3D && (_dbgTick++ % 90 === 0)) {
        console.log("[bb3ddebug] mode=" + DEBUG_3D,
          "eye=", _eye.x.toFixed(1) + "," + _eye.y.toFixed(1) + "," + _eye.z.toFixed(1),
          "faceA.pa=", faces[0].pa.x.toFixed(1) + "," + faces[0].pa.y.toFixed(1) + "," + faces[0].pa.z.toFixed(1),
          "backend=", renderer.backend ? renderer.backend.constructor.name : "?",
          "cs=", renderer.coordinateSystem);
      }
      for (const r of rts) {
        if (dbgCam) {
          // 诊断模式 2：普通透视视角（正对内容中心），两块 RT 内容相同
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
        renderer.render(scene, projCam);
      }
      renderer.setRenderTarget(prevRT);
      renderer.shadowMap.autoUpdate = savedShadow;
      scene.background = savedBg; scene.fog = savedFog;
    },
    dispose() {
      dead = true;
      clearBoard();
      if (disposeModel) { try { disposeModel(); } catch (e) { /* 忽略 */ } }
      if (mixer) mixer.stopAllAction();
      scene.remove(contentRoot, bgBoard, ambient, adSun, adSun.target);
      disposeTree(contentRoot);
      bgBoard.geometry.dispose(); bgBoard.material.map.dispose(); bgBoard.material.dispose();
      for (const r of rts) r.rt.dispose();
    },
  };
}
