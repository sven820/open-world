// 广告大屏占位边界可视化：3D 编辑器摆放/选中时画出「真正会占到的地面范围 + 高度笼」。
// 深蓝网格（0x22303e / 0x3a4a5c）与深色塔体几乎同色，单靠半透明盒看不出边界，
// 因此用高亮色填充 + 加粗边框 + 立柱/顶框，并按吸附/冲突状态换色。

import * as THREE from "three/webgpu";
import { footprintOf } from "../../world/billboard/placement.js";

export const BB_COLORS = {
  idle: 0x4ea8ff,     // 已放置、未选中：亮蓝（明显区别于深蓝网格）
  grid: 0x2ce8c0,     // 网格吸附 / 选中且合法：薄荷青
  road: 0xffc24d,     // 吸附路缘：琥珀
  invalid: 0xff4d5e,  // 压到建筑 / 道路 / 范围外：红
};

const BORDER_W = 0.35; // 地面边框世界宽度（米），比 1px 线在任意缩放下都清楚

function planeMat() {
  return new THREE.MeshBasicMaterial({
    color: BB_COLORS.grid, transparent: true, opacity: 0.16, depthWrite: false,
    depthTest: false, side: THREE.DoubleSide, toneMapped: false,
  });
}
function edgeMat() {
  return new THREE.MeshBasicMaterial({
    color: BB_COLORS.grid, transparent: true, opacity: 0.95, depthWrite: false,
    depthTest: false, toneMapped: false,
  });
}
function lineMat() {
  return new THREE.LineBasicMaterial({
    color: BB_COLORS.grid, transparent: true, opacity: 0.72, depthWrite: false,
    depthTest: false, toneMapped: false,
  });
}

function clear(group) {
  for (const c of group.children.slice()) {
    group.remove(c);
    if (c.geometry) c.geometry.dispose();
    if (c.material) c.material.dispose();
  }
}

function rebuild(group, f, key) {
  clear(group);
  const x0 = f.ox - f.hx, x1 = f.ox + f.hx;
  const z0 = f.oz - f.hz, z1 = f.oz + f.hz;

  const fill = new THREE.Mesh(new THREE.PlaneGeometry(f.hx * 2, f.hz * 2).rotateX(-Math.PI / 2), planeMat());
  fill.position.set(f.ox, 0.05, f.oz);
  fill.renderOrder = 20;
  group.add(fill);

  const mkEdge = (w, d, x, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.02, d), edgeMat());
    m.position.set(x, 0.1, z);
    m.renderOrder = 21;
    group.add(m);
  };
  mkEdge(f.hx * 2 + BORDER_W * 2, BORDER_W, f.ox, z0 - BORDER_W / 2);
  mkEdge(f.hx * 2 + BORDER_W * 2, BORDER_W, f.ox, z1 + BORDER_W / 2);
  mkEdge(BORDER_W, f.hz * 2, x0 - BORDER_W / 2, f.oz);
  mkEdge(BORDER_W, f.hz * 2, x1 + BORDER_W / 2, f.oz);

  // 四角立柱 + 顶部矩形：把「屏体到底有多高、会不会插进楼里」也画出来
  const corners = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
  const pos = [];
  for (const [x, z] of corners) pos.push(x, 0.1, z, x, f.top, z);
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4];
    pos.push(a[0], f.top, a[1], b[0], f.top, b[1]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  const cage = new THREE.LineSegments(geo, lineMat());
  cage.renderOrder = 22;
  group.add(cage);

  group.userData.key = key;
  group.userData.footprint = { ...f };
}

/** 刷新边界几何（尺寸/形式变化才重建）与状态色。 */
export function updateFootprintBoundary(group, item, colorHex = BB_COLORS.grid) {
  const f = footprintOf(item);
  const key = `${f.mount}|${f.hx}|${f.hz}|${f.ox}|${f.oz}|${f.top}`;
  if (group.userData.key !== key) rebuild(group, f, key);
  for (const c of group.children) c.material.color.setHex(colorHex);
  group.visible = true;
}

export function createFootprintBoundary() {
  const g = new THREE.Group();
  g.visible = false;
  g.userData.bbBoundary = true; // 不参与 _rebuildAll 的实体清理
  return g;
}

export function disposeFootprintBoundary(group) {
  if (!group) return;
  clear(group);
  if (group.parent) group.parent.remove(group);
}
