import * as THREE from "three";
import { makeCanvas } from "../textures.js";
import { parseGLB } from "../../data/assetStore.js";

/* ---------------- 3D 裸眼内容源 —— rea/billboard-content-lab 移植版 ----------------
 * 架构与实验台（PULSE · 内容源实验台）一致：
 *   offAxis()           离轴投影矩阵（P·R·T，逐字同款）
 *   每面一块 WebGLRenderTarget，projCam 只看内容层（layer 隔离）
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
 * 屏位级 3D 参数 d3（后台屏位绑定配置，实验台遛眼参数/显示开关同款）：
 *   depth   出屏深度（contentRoot.position = VC + OUT·depth）
 *   scale   尺寸（contentRoot.scale）
 *   spin    轻微摆动/自转（平面素材板永远不转：一转就被离轴拉成梯形）
 *   flat    平贴退化（直接贴屏，跳过离轴 —— 走普通 2D 管线，见 contentSource）
 *   track   片源跟随当前视点（实时追踪）
 *   hud     右下角双路预览（管理器叠加层，见 billboardManager）
 *   helper  视线/眼位辅助线
 ---------------------------------------------------------------------- */

const NEAR = 0.12, FAR = 400;      // 实验台 frame() 同款
const RTW = 768, RTH = 512;        // 实验台 RT 尺寸同款
const EYE_H = 1.7;                 // 观看视点离地高度（实验台 HERO.y 同款）
const EYE_DIST = 30;               // 固定最佳视点：沿 OUT 方向离屏体的距离
const DESIGN_DIST = 22;            // 板子尺寸的设计视距（实验台 12×8 构图基准）
const AD_BG = new THREE.Color(0x05101f); // 实验台 adBg 同款：RT 渲染期间的场景背景
const BUILTINS = ["demo1", "demo2", "calib"]; // dev 分支可用的内置 3D 内容

const clampN = (v, min, max, def) =>
  (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def);

/* 实验台 §5 离轴投影（逐字同款，仅改 three 引用名） */
const _vr = new THREE.Vector3(), _vu = new THREE.Vector3(), _vn = new THREE.Vector3();
const _va = new THREE.Vector3(), _vb = new THREE.Vector3(), _vc = new THREE.Vector3();
const _P = new THREE.Matrix4(), _R = new THREE.Matrix4(), _Tm = new THREE.Matrix4(), _M = new THREE.Matrix4();
const _eye = new THREE.Vector3(), _look = new THREE.Vector3(), _rel = new THREE.Vector3();

function offAxis(pa, pb, pc, pe, near, far) {
  _vr.subVectors(pb, pa).normalize(); _vu.subVectors(pc, pa).normalize();
  _vn.crossVectors(_vr, _vu).normalize();
  _va.subVectors(pa, pe); _vb.subVectors(pb, pe); _vc.subVectors(pc, pe);
  let d = -_vn.dot(_va); if (d < 0.05) d = 0.05;
  const l = _vr.dot(_va) * near / d, r = _vr.dot(_vb) * near / d,
    b = _vu.dot(_va) * near / d, t = _vu.dot(_vc) * near / d;
  _P.set(
    2 * near / (r - l), 0, (r + l) / (r - l), 0,
    0, 2 * near / (t - b), (t + b) / (t - b), 0,
    0, 0, -(far + near) / (far - near), -2 * far * near / (far - near),
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

/* ---------------- 3D 演示2：12 秒品牌广告（实验台 56304-56443 行移植） ---------------- */
function buildDemo2(VC, OUT, gScale) {
  const root = new THREE.Group();       // 时间轴驱动：position / rotation 每帧改写
  const uEye = { value: new THREE.Vector3() }, uTime = { value: 0 }, uAlpha = { value: 1 };
  const metalMat = new THREE.ShaderMaterial({
    uniforms: { uEye, uTime, uAlpha },
    vertexShader: [
      "varying vec3 vN; varying vec3 vW; varying vec2 vUv;",
      "void main(){ vUv=uv; vN=normalize(mat3(modelMatrix)*normal);",
      " vec4 w=modelMatrix*vec4(position,1.0); vW=w.xyz;",
      " gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }",
    ].join("\n"),
    fragmentShader: [
      "uniform vec3 uEye; uniform float uTime; uniform float uAlpha;",
      "varying vec3 vN; varying vec3 vW; varying vec2 vUv;",
      "void main(){ vec3 N=normalize(vN); vec3 V=normalize(uEye-vW);",
      " vec3 L=normalize(vec3(0.45,0.85,0.65));",
      " float d=max(dot(N,L),0.0); float rim=pow(1.0-max(dot(N,V),0.0),2.1);",
      " float band=0.5+0.5*sin(vUv.y*26.0+uTime*0.9);",
      " vec3 base=mix(vec3(0.12,0.16,0.22),vec3(0.88,0.95,1.0),0.34+0.66*d);",
      " base+=band*0.045;",
      " vec3 col=base+rim*vec3(0.0,0.82,1.0)*1.9+rim*rim*vec3(1.0,0.14,0.58)*0.85;",
      " gl_FragColor=vec4(col,uAlpha); }",
    ].join("\n"),
    side: THREE.DoubleSide,
  });
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
  const dummy = new THREE.Object3D();
  // 星点粒子
  const PN = 700, parr = new Float32Array(PN * 3), pseed = [];
  for (let pp = 0; pp < PN; pp++) {
    const aa = Math.random() * Math.PI * 2, rr = 3 + Math.random() * 13;
    pseed.push({ a: aa, r: rr, y: (Math.random() - 0.5) * 14, s: 0.4 + Math.random() * 1.6 });
    parr[pp * 3] = Math.cos(aa) * rr; parr[pp * 3 + 1] = (Math.random() - 0.5) * 14; parr[pp * 3 + 2] = Math.sin(aa) * rr;
  }
  const pg = new THREE.BufferGeometry();
  pg.setAttribute("position", new THREE.BufferAttribute(parr, 3));
  const particles = new THREE.Points(pg, new THREE.PointsMaterial({
    color: 0x35e8ff, size: 0.30, transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true, fog: false,
  }));
  root.add(particles);
  // 透视隧道：固定在屏体坐标（不随罐体位移），沿 OUT 方向往深处排 9 层线框
  const right = new THREE.Vector3(-OUT.z, 0, OUT.x); // OUT × Y（实验台 (0.7071,0,-0.7071) 的通式）
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
  // 12s 循环：0-2 汇聚 / 2-6 飞近 / 6-10 破屏 / 10-12 定格回收
  function update(t, eye) {
    const depth = t < 2 ? lerp(-15, -9, t / 2)
      : t < 6 ? lerp(-9, 0.5, (t - 2) / 4)
        : t < 10 ? lerp(0.5, 4.6, (t - 6) / 4)
          : lerp(4.6, -15, (t - 10) / 2);
    root.position.copy(VC).addScaledVector(OUT, depth * gScale);
    const appear = clamp01(t / 1.2) * (t > 10.6 ? clamp01((12 - t) / 1.4) : 1);
    uAlpha.value = appear; dropMat.opacity = 1.0 * appear;
    particles.material.opacity = 0.95 * appear; tunnel.material.opacity = 0.42 * appear;
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
    const pa = pg.attributes.position.array;
    for (let j = 0; j < PN; j++) {
      const p = pseed[j], a2 = p.a + t * 0.12 * p.s;
      pa[j * 3] = Math.cos(a2) * p.r * (1 - burst * 0.25);
      pa[j * 3 + 1] = p.y + Math.sin(t * 0.8 + j) * 0.35;
      pa[j * 3 + 2] = Math.sin(a2) * p.r * (1 - burst * 0.25);
    }
    pg.attributes.position.needsUpdate = true;
    uTime.value = t; uEye.value.copy(eye);
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
 * @param {object|null} d3  屏位级 3D 参数 { depth, scale, spin, flat, track, hud, helper }
 * @param {function|null} make2d  该条目的 2D 工厂（平面素材用；model3d 传 null）
 */
export function make3dContent(it, W, H, aspect, ctx, d3, make2d) {
  const faces = ctx && Array.isArray(ctx.faces) ? ctx.faces : null;
  const renderer = ctx && ctx.renderer;
  const scene = ctx && ctx.scene;
  if (!faces || faces.length < 2 || !renderer || !scene) return make3dPlaceholder(it, W, H);

  const depth = clampN(d3 && d3.depth !== undefined ? d3.depth : it.depth, 0, 10, 2.5);
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
  const projCam = new THREE.Camera();
  projCam.layers.set(layer);
  projCam.matrixAutoUpdate = false;
  const rts = faces.map((f) => ({
    f,
    rt: new THREE.WebGLRenderTarget(RTW, RTH, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false,
    }),
  }));

  /* —— 提示专用正交场景（加载中 / 失败时两面 RT 都画这张正对观众的图） —— */
  const noticeScene = new THREE.Scene();
  noticeScene.background = AD_BG;
  const noticeCam = new THREE.OrthographicCamera(-1.5, 1.5, 1, -1, 0.1, 10);
  noticeCam.position.set(0, 0, 2);
  noticeCam.lookAt(0, 0, 0);

  /* —— 内容层：直接放主场景，主相机（layer 0）看不到 —— */
  const contentRoot = new THREE.Group();
  contentRoot.scale.setScalar(scale);
  scene.add(contentRoot);
  setLayer(contentRoot, layer);

  // 实验台 §6 bgBoard：内腔背板，内容后 19m，双面
  const bgBoard = new THREE.Mesh(
    new THREE.PlaneGeometry(46, 30),
    new THREE.MeshBasicMaterial({ map: adBackTex(), side: THREE.DoubleSide, fog: false }),
  );
  bgBoard.position.copy(VC).addScaledVector(OUT, -19);
  bgBoard.lookAt(_look.copy(VC).addScaledVector(OUT, 30));
  scene.add(bgBoard);
  setLayer(bgBoard, layer);

  // 内容层灯光：环境光 1.15 + 广告主光 1.6（实验台 addLight 同款）
  const ambient = new THREE.AmbientLight(0xffffff, 1.15);
  ambient.layers.set(layer);
  scene.add(ambient);
  const adSun = new THREE.DirectionalLight(0xffffff, 1.6);
  adSun.position.copy(VC).add(new THREE.Vector3(-10.5, 10, -10.5));
  adSun.target.position.copy(VC);
  adSun.layers.set(layer);
  adSun.target.layers.set(layer);
  scene.add(adSun, adSun.target);

  /* —— 视线/眼位辅助线（layer 0，主相机可见；每帧从虚拟眼睛拉到两面屏角） —— */
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
  const disposers = [];

  const showBoard = (message) => {
    if (loadBoard) { noticeScene.remove(loadBoard); disposeTree(loadBoard); }
    loadBoard = noticeBoard(message, 2.6, 2.6 * 288 / 512);
    noticeScene.add(loadBoard);
  };
  const clearBoard = () => {
    if (loadBoard) { noticeScene.remove(loadBoard); disposeTree(loadBoard); loadBoard = null; }
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
      scene.add(demo2.root, demo2.tunnel);
      setLayer(demo2.root, layer);
      setLayer(demo2.tunnel, layer);
      disposers.push(() => {
        scene.remove(demo2.root, demo2.tunnel);
        disposeTree(demo2.root);
        demo2.tunnel.geometry.dispose(); demo2.tunnel.material.dispose();
      });
    } else if (load.kind === "calib") {
      const calib = buildCalib();
      calib.position.copy(VC);
      calib.scale.setScalar(gScale);
      scene.add(calib);
      setLayer(calib, layer);
      calibObj = calib; // 实验台同款：绕 Y 慢转 + 轻微俯仰摆动
      disposers.push(() => { scene.remove(calib); disposeTree(calib); });
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
    setActive(on) { if (innerItem && innerItem.setActive) innerItem.setActive(on); },
    setAudio(on) { if (innerItem && innerItem.setAudio) innerItem.setAudio(on); },
    /** 主循环：内容动画 + 双路离轴渲染（实验台 frame() 同款） */
    update(dt, time, focus, camera) {
      if (dead) return;
      if (mixer) mixer.update(dt);
      if (innerUpdate) innerUpdate(dt, time);
      if (demo2) { t2 = (t2 + dt) % 12; }
      contentRoot.position.copy(VC).addScaledVector(OUT, depth);
      contentRoot.rotation.y = spin ? Math.sin(time * 0.35) * 0.12 : 0;

      // 虚拟眼睛：实时追踪 = 取景相机位置；固定 = 屏前最佳视点（实验台 HERO 档）
      if (track && camera && camera.position && Number.isFinite(camera.position.x)) {
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

      if (demo2) demo2.update(t2, _eye);
      else if (demoKnot) demoKnot.rotation.y = time * 0.55;
      // 几何校准片：绕 Y 慢转 + 轻微俯仰摆动（实验台 frame() 同款）
      if (calibObj) { calibObj.rotation.y = time * 0.32; calibObj.rotation.x = Math.sin(time * 0.4) * 0.08; }

      // 提示态：两面 RT 都画同一张正视提示图，跳过离轴渲染；加载成功后自动恢复
      if (loadBoard) {
        const savedShadow = renderer.shadowMap.autoUpdate;
        renderer.shadowMap.autoUpdate = false;
        const prevRT = renderer.getRenderTarget();
        for (const r of rts) {
          renderer.setRenderTarget(r.rt);
          renderer.render(noticeScene, noticeCam);
        }
        renderer.setRenderTarget(prevRT);
        renderer.shadowMap.autoUpdate = savedShadow;
        return;
      }
      // 实验台 frame() 同款：临时替换背景/雾 → 双路离轴渲染 → 还原
      const savedBg = scene.background, savedFog = scene.fog;
      scene.background = AD_BG; scene.fog = null;
      const savedShadow = renderer.shadowMap.autoUpdate;
      renderer.shadowMap.autoUpdate = false; // RT 渲染不重复生成阴影贴图
      const prevRT = renderer.getRenderTarget();
      for (const r of rts) {
        const M = offAxis(r.f.pa, r.f.pb, r.f.pc, _eye, NEAR, FAR);
        projCam.projectionMatrix.copy(M);
        projCam.projectionMatrixInverse.copy(M).invert();
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
      if (mixer) mixer.stopAllAction();
      for (const fn of disposers) { try { fn(); } catch { /* 已释放则忽略 */ } }
      scene.remove(contentRoot, bgBoard, ambient, adSun, adSun.target, helper);
      disposeTree(contentRoot);
      bgBoard.geometry.dispose(); bgBoard.material.map.dispose(); bgBoard.material.dispose();
      helperLines.geometry.dispose(); helperMat.dispose();
      eyeBall.geometry.dispose(); eyeBall.material.dispose();
      for (const r of rts) r.rt.dispose();
    },
  };
}
