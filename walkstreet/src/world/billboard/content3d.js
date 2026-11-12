import * as THREE from "three/webgpu";
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
 *   url    GLB 模型地址（空 / "builtin://demo1" = 实验台 makeDemo() 同款内置 3D 演示1）
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
  const builtin = !url || url === "builtin://demo1";
  let dead = false, failed = false, active = true;

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

  /* —— 内容：实验台 makeDemo() 逐字复刻，或 GLB 模型（实验台 parseGLB 同款归一化） —— */
  let demoKnot = null, mixer = null, loadBoard = null, disposeModel = null;

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

  if (builtin) {
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
      if (dead || failed || !active) return;
      // 虚拟眼睛 = 观看者真实位置（实验台 state.track ? camera.position : HERO 的"跟随"档）
      if (DEBUG_3D === 3) _eye.copy(VC).addScaledVector(OUT, 20).setY(VC.y * 0.4);
      else if (focus && Number.isFinite(focus.x)) _eye.set(focus.x, EYE_H, focus.z);
      else _eye.copy(VC).addScaledVector(OUT, 20).setY(VC.y * 0.4);
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
    setActive(on) { active = !!on; },
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
