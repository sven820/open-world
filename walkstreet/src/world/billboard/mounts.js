import * as THREE from "three";
import { makeCanvas } from "../textures.js";

/* ---------------- 广告大屏 · 承载形式注册表 ----------------
 * 每种承载形式（mount）描述屏体如何"立"在世界里：
 *   standalone —— 独立广告牌：底座 + 立柱 + 悬臂屏，屏底 ≥2.5m 可通行
 *   facade     —— 建筑立面屏：无立柱，贴附建筑外墙（pos 放在墙面上）
 *   corner     —— 转角包柱屏：楼角 L 形双面（横纵路口转角）
 * 后期新增形式：在 MOUNTS 里加一项即可，编辑器下拉与运行时自动识别。
 *
 * build(spec, screenMat) 统一返回：
 *   { group, screenMats, collider }   // collider 可为 null
 * 局部坐标约定：group 原点 = 地面落点，rotation.y = rot，
 * 屏面朝局部 +Z（corner 为 -Z/-X 两面）。
 ---------------------------------------------------------------------- */

const HOUSING = 0x262a30;   // 塔体/边框深灰
const SCREEN_OFFSET = 0.08; // 屏面凸出背板的距离
const FACADE_STANDOFF = 0.9; // 立面屏屏面离墙距离（避开建筑凸窗/阳台等凸出物）

const clampN = (v, min, max, def) =>
  (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def);

function housingMat() {
  return new THREE.MeshStandardMaterial({ color: HOUSING, roughness: 0.85, metalness: 0.05 });
}
function trimMat() {
  return new THREE.MeshBasicMaterial({ color: 0x8a93a2, toneMapped: false });
}
function mesh(geo, mat, x, y, z) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

/* 四边中空边框（替代实心背板）：屏面双面渲染时，背面透过边框直接
 * 看到屏面内容，不再出现"夜间整块纯黑矩形"。返回的 Group 以中心定位。 */
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
    build(spec, screenMat) {
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
      return { group, screenMats: [screenMat], collider };
    },
  },

  /* —— 建筑立面屏：无立柱，贴附外墙（pos = 墙面落点，屏向外凸出） —— */
  facade: {
    label: "建筑立面屏",
    defaults: { w: 14, h: 8, y: 9 },
    build(spec, screenMat) {
      const w = spec.w, h = spec.h, y = spec.y;
      const group = new THREE.Group();
      // 中空安装边框（贴墙面）：边框四条接触墙面
      const frameG = frame(w + 0.7, h + 0.7, 0.3, housingMat());
      frameG.position.set(0, y, 0.15);
      group.add(frameG);
      // 屏面悬挑在墙外 STANDOFF 处（躲开建筑凸窗/雨棚/空调外机等墙面凸出物，
      // 否则凸出物会把屏面切开 —— 表现为"内容只能看到一部分"），支撑连杆固定
      const screenZ = 0.3 + FACADE_STANDOFF;
      for (const sy of [y + h / 2 - 0.35, y - h / 2 + 0.35]) {
        group.add(mesh(new THREE.BoxGeometry(0.14, 0.14, FACADE_STANDOFF), housingMat(), 0, sy, 0.3 + FACADE_STANDOFF / 2));
      }
      // 屏面：前后两块共享同一材质。贴墙放正时背面屏贴墙隐藏；
      // 方向放反时露出的也是正向内容，不再是深色背板"黑屏"
      const front = mesh(new THREE.PlaneGeometry(w, h), screenMat, 0, y, screenZ);
      front.castShadow = false;
      const back = mesh(new THREE.PlaneGeometry(w, h), screenMat, 0, y, -SCREEN_OFFSET);
      back.rotation.y = Math.PI;
      back.castShadow = false;
      group.add(front, back);
      const collider = { x0: -w / 2 - 0.35, z0: -0.35, x1: w / 2 + 0.35, z1: screenZ + 0.1, top: y + h / 2 };
      return { group, screenMats: [screenMat], collider };
    },
  },

  /* —— 转角包柱屏：楼角 L 形双面（两面屏共享同一节目） —— */
  corner: {
    label: "转角包柱屏",
    defaults: { w: 14, h: 8, y: 13 },
    build(spec, screenMat) {
      const w = spec.w, h = spec.h, y = spec.y;
      const towerW = w + 1.4;
      const totalH = y + h / 2 + 0.6; // 塔体从地面到屏顶 + 上边框
      const group = new THREE.Group();
      group.add(mesh(new THREE.BoxGeometry(towerW, totalH, towerW), housingMat(), 0, totalH / 2, 0));
      const trim = mesh(new THREE.BoxGeometry(towerW + 0.3, 0.5, towerW + 0.3), trimMat(), 0, totalH + 0.25, 0);
      trim.castShadow = false;
      group.add(trim);
      // 两面屏：朝局部 -Z 与 -X（楼角两侧），共享同一张内容纹理
      const faceZ = mesh(new THREE.PlaneGeometry(w, h), screenMat, 0, y, -(towerW / 2 + SCREEN_OFFSET));
      faceZ.rotation.y = Math.PI;
      faceZ.castShadow = false;
      const faceX = mesh(new THREE.PlaneGeometry(w, h), screenMat, -(towerW / 2 + SCREEN_OFFSET), y, 0);
      faceX.rotation.y = -Math.PI / 2;
      faceX.castShadow = false;
      group.add(faceZ, faceX);
      const half = towerW / 2;
      const collider = { x0: -half, z0: -half, x1: half, z1: half, top: totalH };
      return { group, screenMats: [screenMat], collider };
    },
  },
};

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
 * @param {THREE.Material} screenMat 屏面材质（内容由播放器运行时填 map）
 * @returns {{ group, screenMats, collider, spec }}
 */
export function buildBillboardGroup(item, screenMat) {
  const spec = normalizeSpec(item.params);
  const built = getMount(spec.mount).build(spec, screenMat);
  built.group.position.set(item.pos[0], 0, item.pos[1]);
  built.group.rotation.y = item.rot || 0;
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
    color: 0xc4c4c4, toneMapped: false, side: THREE.DoubleSide, // 与运行时屏面一致：背面也显示内容
  });
  _previewMat.map = new THREE.CanvasTexture(c);
  _previewMat.map.colorSpace = THREE.SRGBColorSpace;
  _previewMat.userData.shared = true; // 编辑器全量重建时不 dispose
  return _previewMat;
}

// 放置幽灵：半透明蓝色整体（不区分细节，只看落点/朝向）
export function editorGhostMaterial() {
  if (_ghostMat) return _ghostMat;
  _ghostMat = new THREE.MeshBasicMaterial({
    color: 0x3a72b0, transparent: true, opacity: 0.35, depthWrite: false, toneMapped: false,
  });
  _ghostMat.userData.shared = true;
  return _ghostMat;
}
