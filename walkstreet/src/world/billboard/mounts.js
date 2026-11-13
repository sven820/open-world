import * as THREE from "three";
import { makeCanvas } from "../textures.js";

/* ---------------- 广告大屏 · 承载形式注册表 ----------------
 * 每种承载形式（mount）描述屏体如何"立"在世界里：
 *   standalone —— 独立广告牌：底座 + 立柱 + 悬臂屏，屏底 ≥2.5m 可通行
 *   facade     —— 建筑立面屏：无立柱，贴附建筑外墙（pos 放在墙面上）
 *   corner     —— 转角包柱屏：楼角 L 形双面（横纵路口转角），两面是独立屏
 *   corner3d   —— 3D转角包柱屏：楼角 L 形一体屏，两面共享同一条转角棱线（无屏缝），
 *                 配合 content3d.js 的离轴投影可播出跨转角的 3D 裸眼画面
 * 后期新增形式：在 MOUNTS 里加一项即可，编辑器下拉与运行时自动识别。
 *
 * build(spec, screenMat) 统一返回：
 *   { group, screenMats, collider }   // collider 可为 null
 * 局部坐标约定：group 原点 = 地面落点，rotation.y = rot，
 * 屏面朝局部 +Z（corner 为 -Z/-X 两面）。
 * 单面屏（facade）必须自带不透明背板，否则 FrontSide 面片背面被剔除后会看穿。
 ---------------------------------------------------------------------- */

const HOUSING = 0x262a30;   // 塔体/边框深灰
const SCREEN_OFFSET = 0.08; // 屏面凸出背板的距离
const FACADE_STANDOFF = 0.9; // 立面屏屏面离墙距离（避开建筑凸窗/阳台等凸出物）

const clampN = (v, min, max, def) =>
  (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def);

// 屏面材质入参兼容「单材质 | 材质数组」：单面屏取 [0]，转角屏取 [0]/[1] 各自独立
const asMats = (m) => (Array.isArray(m) ? m : [m]);

function housingMat() {
  return new THREE.MeshStandardMaterial({ color: HOUSING, roughness: 0.85, metalness: 0.05 });
}
function trimMat() {
  return new THREE.MeshBasicMaterial({ color: 0x8a93a2, toneMapped: false });
}
// 单面屏背板：比机箱稍亮的恒定深灰蓝（不随光照变全黑），
// 从墙侧一眼能读出"这是一块实心设备背板"，而不是一个能看穿的洞
function backPanelMat() {
  return new THREE.MeshBasicMaterial({ color: 0x3b4453, toneMapped: false });
}
function mesh(geo, mat, x, y, z) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

/* 四边中空边框：仅用于前后各有一块朝外面片的双面屏（standalone），
 * 背面透出的是背侧那块屏面，不再出现"夜间整块纯黑矩形"。
 * 单面屏（facade）不能用它 —— 中间会漏空看穿。返回的 Group 以中心定位。 */
function frame(w, h, depth, mat) {
  const g = new THREE.Group();
  const t = 0.35; // 边框条宽
  g.add(mesh(new THREE.BoxGeometry(w, t, depth), mat, 0, h / 2 - t / 2, 0));
  g.add(mesh(new THREE.BoxGeometry(w, t, depth), mat, 0, -h / 2 + t / 2, 0));
  const vh = Math.max(0.1, h - t * 2);
  g.add(mesh(new THREE.BoxGeometry(t, vh, depth), mat, -w / 2 + t / 2, 0, 0));
  g.add(mesh(new THREE.BoxGeometry(t, vh, depth), mat, w / 2 - t / 2, 0, 0));
  return g;
}

export const MOUNTS = {
  /* —— 独立广告牌：底座 + 立柱 + 单面悬臂屏 —— */
  standalone: {
    label: "独立广告牌",
    defaults: { w: 12, h: 7, y: 10 },
    build(spec, mats) {
      const screenMat = mats[0];
      const w = spec.w, h = spec.h, y = spec.y;
      const bottom = y - h / 2;
      const group = new THREE.Group();
      // 底座 + 立柱
      group.add(mesh(new THREE.BoxGeometry(2.8, 0.6, 2.0), housingMat(), 0, 0.3, 0));
      group.add(mesh(new THREE.BoxGeometry(1.2, Math.max(0.5, bottom), 0.9), housingMat(), 0, Math.max(0.5, bottom) / 2, 0));
      // 中空边框（替代实心背板，含顶部檐口亮条）：背面透出屏面内容
      const frameG = frame(w + 0.8, h + 0.7, 0.5, housingMat());
      frameG.position.set(0, y, -0.25);
      group.add(frameG);
      const trim = mesh(new THREE.BoxGeometry(w + 1.0, 0.4, 0.55), trimMat(), 0, y + h / 2 + 0.35, -0.25);
      trim.castShadow = false;
      group.add(trim);
      // 屏面：前后两块共享同一材质（真双面屏，背面文字正向）
      const front = mesh(new THREE.PlaneGeometry(w, h), screenMat, 0, y, SCREEN_OFFSET);
      front.castShadow = false;
      const back = mesh(new THREE.PlaneGeometry(w, h), screenMat, 0, y, -0.5 - SCREEN_OFFSET);
      back.rotation.y = Math.PI;
      back.castShadow = false;
      group.add(front, back);
      // 碰撞：立柱 + 底座；屏底 <2.5m 时屏体整块挡人
      const collider = { x0: -1.6, z0: -1.1, x1: 1.6, z1: 1.1, top: y + h / 2 + 0.4 };
      if (bottom < 2.5) { collider.x0 = -w / 2 - 0.4; collider.x1 = w / 2 + 0.4; collider.z0 = -0.6; collider.z1 = 0.6; }
      return { faceGroups: [group], screenMats: [screenMat], collider };
    },
  },

  /* —— 建筑立面屏：无立柱，贴附外墙（pos = 墙面落点，屏向外凸出） —— */
  facade: {
    label: "建筑立面屏",
    defaults: { w: 14, h: 8, y: 9 },
    build(spec, mats) {
      const screenMat = mats[0];
      const w = spec.w, h = spec.h, y = spec.y;
      const group = new THREE.Group();
      // 屏面悬挑在墙外 STANDOFF 处（躲开建筑凸窗/雨棚/空调外机等墙面凸出物，
      // 否则凸出物会把屏面切开 —— 表现为"内容只能看到一部分"）。
      const screenZ = 0.3 + FACADE_STANDOFF;
      // 墙侧只留小安装座 + 细悬臂，不再放贴墙大框：侧面看不会像"第二块屏"
      const armZ = screenZ - 0.28;
      for (const sy of [y + h / 2 - 0.35, y - h / 2 + 0.35]) {
        group.add(mesh(new THREE.BoxGeometry(0.5, 0.5, 0.12), housingMat(), 0, sy, 0.06));
        group.add(mesh(new THREE.BoxGeometry(0.14, 0.14, armZ), housingMat(), 0, sy, armZ / 2));
      }
      // 实心机箱（替代四边中空框）：立面屏只有一张朝外的 FrontSide 面片，
      // 中空框会让中间那块直接透出后面的街景 —— 从墙侧/斜后方看整块屏是"透明"的。
      // 换成不透明箱体后背面是整块深灰背板；正面仍只露出 0.35m 边框（视觉不变）。
      const CABINET_DEPTH = 0.34;
      const cabinet = mesh(
        new THREE.BoxGeometry(w + 0.7, h + 0.7, CABINET_DEPTH),
        housingMat(), 0, y, screenZ - 0.04 - CABINET_DEPTH / 2,
      );
      group.add(cabinet);
      // 背板稍稍外凸、四周留 0.3m 机箱边框：背光时也不会黑成一团看不出形状
      const cabinetBackZ = screenZ - 0.04 - CABINET_DEPTH;
      const backPanel = mesh(
        new THREE.BoxGeometry(w + 0.1, h + 0.1, 0.04),
        backPanelMat(), 0, y, cabinetBackZ - 0.02,
      );
      backPanel.castShadow = false;
      group.add(backPanel);
      // 屏面贴在机箱正面外 0.04m，避免 z-fighting 且不遮挡四周边框
      const front = mesh(new THREE.PlaneGeometry(w, h), screenMat, 0, y, screenZ);
      front.castShadow = false;
      group.add(front);
      const collider = { x0: -w / 2 - 0.35, z0: -0.1, x1: w / 2 + 0.35, z1: screenZ + 0.1, top: y + h / 2 };
      return { faceGroups: [group], screenMats: [screenMat], collider };
    },
  },

  /* —— 转角包柱屏：楼角 L 形双面（两面是各自独立的屏，可绑定不同节目单） —— */
  corner: {
    label: "转角包柱屏",
    defaults: { w: 14, h: 8, y: 13 },
    build(spec, mats) {
      const w = spec.w, h = spec.h, y = spec.y;
      const towerW = w + 1.4;
      const totalH = y + h / 2 + 0.6; // 塔体从地面到屏顶 + 上边框
      const off = towerW / 2 + SCREEN_OFFSET;
      // 两面各自独立成组：每组自带一份塔体 + 檐口，便于运行时注册为两块独立屏
      const mkFace = (faceMat, rotY, px, pz) => {
        const g = new THREE.Group();
        g.add(mesh(new THREE.BoxGeometry(towerW, totalH, towerW), housingMat(), 0, totalH / 2, 0));
        const trim = mesh(new THREE.BoxGeometry(towerW + 0.3, 0.5, towerW + 0.3), trimMat(), 0, totalH + 0.25, 0);
        trim.castShadow = false;
        g.add(trim);
        const face = mesh(new THREE.PlaneGeometry(w, h), faceMat, px, y, pz);
        face.rotation.y = rotY;
        face.castShadow = false;
        g.add(face);
        return g;
      };
      // 朝局部 -Z（转角 A 面）与 -X（转角 B 面），各用独立材质
      const gA = mkFace(mats[0], Math.PI, 0, -off);
      const gB = mkFace(mats[1] || mats[0], -Math.PI / 2, -off, 0);
      const half = towerW / 2;
      const collider = { x0: -half, z0: -half, x1: half, z1: half, top: totalH };
      return { faceGroups: [gA, gB], screenMats: [mats[0], mats[1] || mats[0]], collider };
    },
  },

  /* —— 3D转角包柱屏：楼角 L 形一体屏（不分块）。
   * 两块屏面四边形在转角棱线 (-D,-D) 处共享同一顶点 —— 几何上无缝、转角处没有
   * 柱体也没有屏缝；整块屏只有一份节目单 / 一个后台屏位（不拆 ::A/::B）。
   * 内容管线：普通 2D 内容（图/视频/直播/文字）整屏平面展示 —— 两面拼成一张完整画布
   * 直接平铺（A 面取左半、B 面取右半 UV，不做离轴扭曲）；model3d / 勾选 3D 展示的素材
   * 经 content3d.js 离轴投影逐帧渲染到两面 RenderTarget，
   * 以真实观看视点为虚拟眼睛 → 跨转角视差连续，即 3D 裸眼效果。 —— */
  corner3d: {
    label: "3D转角包柱屏",
    defaults: { w: 14, h: 8, y: 13 },
    build(spec, mats) {
      const w = spec.w, h = spec.h, y = spec.y;
      const towerW = w + 1.4;
      const totalH = y + h / 2 + 0.6;
      const group = new THREE.Group();
      group.add(mesh(new THREE.BoxGeometry(towerW, totalH, towerW), housingMat(), 0, totalH / 2, 0));
      const trim = mesh(new THREE.BoxGeometry(towerW + 0.3, 0.5, towerW + 0.3), trimMat(), 0, totalH + 0.25, 0);
      trim.castShadow = false;
      group.add(trim);
      // 一体屏面：corner3dFaceDefs 给出两面四边形的局部四角（转角棱线处顶点重合）
      const matA = mats[0], matB = mats[1] || mats[0];
      for (const f of corner3dFaceDefs(spec)) {
        const face = new THREE.Mesh(quadGeom(f.pa, f.pb, f.pc, f.pd), f.i === 0 ? matA : matB);
        face.castShadow = false;
        group.add(face);
      }
      const half = towerW / 2;
      const collider = { x0: -half, z0: -half, x1: half, z1: half, top: totalH };
      return { faceGroups: [group], screenMats: [matA, matB], collider };
    },
  },
};

/* 手写四边形 BufferGeometry（与 rea/billboard-content-lab 同款）：
 * 顶点序 pa(左下) → pb(右下) → pd(右上)、pa → pd → pc(左上)，
 * UV 每面独立 0..1（左下为原点），法线朝观察者。 */
export function quadGeom(pa, pb, pc, pd) {
  const pos = [
    pa.x, pa.y, pa.z, pb.x, pb.y, pb.z, pd.x, pd.y, pd.z,
    pa.x, pa.y, pa.z, pd.x, pd.y, pd.z, pc.x, pc.y, pc.z,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
  g.computeVertexNormals();
  return g;
}

/** corner3d 两面屏面的局部四角（group 原点 = 地面落点，未含 pos/rot）。
 *  角点命名与实验台 quadGeom/offAxis 约定一致：
 *    pa = 左下(UV 0,0)、pb = 右下(UV 1,0)、pc = 左下正上方(UV 0,1)、pd = 右下正上方(UV 1,1)
 *  —— offAxis(pa,pb,pc) 的 up 向量取 pc-pa，必须保证 pc 在 pa 正上方，否则投影歪斜。
 *  A 面朝局部 -Z（纹理右缘 = 转角棱线）；B 面朝局部 -X（纹理左缘 = 转角棱线）；
 *  两面共享棱线 (-D, y, -D)，D = 塔体半宽 + 屏面外凸。 */
export function corner3dFaceDefs(spec) {
  const w = spec.w, h = spec.h, y = spec.y;
  const D = (w + 1.4) / 2 + SCREEN_OFFSET;
  const y0 = y - h / 2, y1 = y + h / 2;
  const x1 = -D + w, z1 = -D + w;
  return [
    { i: 0, pa: new THREE.Vector3(x1, y0, -D), pb: new THREE.Vector3(-D, y0, -D), pc: new THREE.Vector3(x1, y1, -D), pd: new THREE.Vector3(-D, y1, -D) },
    { i: 1, pa: new THREE.Vector3(-D, y0, -D), pb: new THREE.Vector3(-D, y0, z1), pc: new THREE.Vector3(-D, y1, -D), pd: new THREE.Vector3(-D, y1, z1) },
  ];
}

/** corner3d 两面屏面的世界坐标四角（含 pos/rot），供 content3d.js 离轴投影使用。
 *  旋转约定与 billboard.js 碰撞体一致：wx = x + lx*cs + lz*sn, wz = z - lx*sn + lz*cs */
export function corner3dWorldFaces(spec, pos, rot = 0) {
  const cs = Math.cos(rot), sn = Math.sin(rot);
  return corner3dFaceDefs(spec).map((f) => {
    const w2 = (p) => {
      const lx = p.x, lz = p.z;
      return new THREE.Vector3(pos[0] + lx * cs + lz * sn, p.y, pos[1] - lx * sn + lz * cs);
    };
    return { pa: w2(f.pa), pb: w2(f.pb), pc: w2(f.pc), pd: w2(f.pd) };
  });
}

export function getMount(id) { return MOUNTS[id] || MOUNTS.standalone; }

/* 规整 params：缺省取承载形式默认值，数值夹取安全范围 */
export function normalizeSpec(params = {}) {
  const known = MOUNTS[params.mount] ? params.mount : "standalone";
  const def = MOUNTS[known].defaults;
  return {
    mount: known,
    w: clampN(params.w, 4, 40, def.w),
    h: clampN(params.h, 2, 30, def.h),
    y: clampN(params.y, 3, 120, def.y),
  };
}

/**
 * 构建一块大屏（编辑器预览与运行时共用同一套几何）。
 * @param {{pos:[number,number], rot:number, params:object}} item 地图 objects 记录
 * @param {THREE.Material|THREE.Material[]} screenMat 屏面材质（内容由播放器运行时填 map）；
 *   单面屏取 [0]；转角屏取 [0]/[1]，两面各自独立。
 * @returns {{ group, faceGroups:THREE.Group[], screenMats:THREE.Material[], collider, spec }}
 *   group —— 合并后的整块（编辑器预览 / 放置幽灵用，已按 item.pos/rot 定位）；
 *   faceGroups —— 各面独立子组（局部坐标、无外层位移），运行时据此拆成多块独立屏。
 */
export function buildBillboardGroup(item, screenMat) {
  const spec = normalizeSpec(item.params);
  const built = getMount(spec.mount).build(spec, asMats(screenMat));
  const group = new THREE.Group();
  for (const fg of built.faceGroups) {
    fg.position.set(0, 0, 0);
    fg.rotation.y = 0;
    group.add(fg);
  }
  group.position.set(item.pos[0], 0, item.pos[1]);
  group.rotation.y = item.rot || 0;
  built.group = group;
  built.spec = spec;
  return built;
}

/* ---------------- 编辑器共享材质（userData.shared，避免随重建释放） ---------------- */
let _previewMat = null;
let _ghostMat = null;

// 预览屏面："广告大屏"占位画面（运行时换成真实节目）
export function editorScreenMaterial() {
  if (_previewMat) return _previewMat;
  const c = makeCanvas(512, 288);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#101828"; ctx.fillRect(0, 0, 512, 288);
  ctx.strokeStyle = "#2ec4e6"; ctx.lineWidth = 6; ctx.strokeRect(8, 8, 496, 272);
  ctx.fillStyle = "#2ec4e6"; ctx.textBaseline = "middle"; ctx.textAlign = "center";
  ctx.font = "800 64px 'Noto Sans SC', 'Microsoft YaHei', sans-serif";
  ctx.fillText("广告大屏", 256, 120);
  ctx.font = "600 34px 'Segoe UI', sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.65)";
  ctx.fillText("AD SCREEN", 256, 190);
  _previewMat = new THREE.MeshBasicMaterial({
    color: 0xc4c4c4, toneMapped: false, side: THREE.FrontSide, // 与运行时一致：背面不显示内容，由实心机箱遮挡
  });
  _previewMat.map = new THREE.CanvasTexture(c);
  _previewMat.map.colorSpace = THREE.SRGBColorSpace;
  _previewMat.userData.shared = true; // 编辑器全量重建时不 dispose
  return _previewMat;
}

// 放置幽灵：高亮青色。编辑器网格是深蓝灰（0x22303e / 0x3a4a5c），
// 深蓝半透明盒几乎融进网格看不出边界，故换成高明度 + 双面 + 略高不透明度；
// 颜色还会随「网格吸附 / 路缘吸附 / 与建筑或道路冲突」实时切换。
export function editorGhostMaterial() {
  if (_ghostMat) return _ghostMat;
  _ghostMat = new THREE.MeshBasicMaterial({
    color: 0x2ce8c0, transparent: true, opacity: 0.42, depthWrite: false,
    side: THREE.DoubleSide, toneMapped: false,
  });
  _ghostMat.userData.shared = true;
  return _ghostMat;
}
