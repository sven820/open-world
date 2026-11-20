// 基准平面（y=0，地形下方那层网格画布）上的世界 X/Z 坐标轴线：
// 两条贯穿主轴（X 暖金沿 z=0、Z 冷蓝沿 x=0），画在基准面高度（-curveOffset - 0.35），
// 与基准网格同一平面。地形块（更高）会自然盖住中段，地形外红框区域清晰可见。
// 轴线延伸到与基准网格同样的外沿（±100km，覆盖相机 far 内全部可见区域）；
// 刻度短线只画在地图附近，避免几百条线拖慢渲染。
// 卫星底图开启时基准面隐藏，坐标轴一并隐藏（见 applyLayerVis / _toggleBasemap）。

import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

const AXIS_X = 0xffa83c; // X 轴（东）暖金
const AXIS_Z = 0x4fc3ff; // Z 轴（南）冷蓝
const DATUM_LIFT = -0.35; // 比基准面(-0.6)高 0.25m，避免共面 z-fighting
const EXT = 100000;       // 与 _buildDatumPlane 的外延一致（> 相机 far 50000）
const SEG = 2000;         // 曲率插值分段（与基准面网格同密度，误差 <0.1m）

function datumY(ed, x, z) {
  return DATUM_LIFT - (ed._curveOffset ? ed._curveOffset(x, z) : 0);
}

// 沿一串世界点画屏幕恒定像素宽的线（不叠加地形高度，固定在基准面）
function datumLine(ed, pts, widthPx, colorHex, opacity) {
  const geo = new LineGeometry();
  geo.setPositions(pts.flatMap((p) => [p.x, datumY(ed, p.x, p.z), p.z]));
  const mat = new LineMaterial({
    color: colorHex, linewidth: widthPx, transparent: true, opacity, depthWrite: false,
  });
  const size = ed._three.renderer.getSize(new THREE.Vector2());
  mat.resolution.set(size.x, size.y);
  const line = new Line2(geo, mat);
  line.userData.fatLine = true;
  line.renderOrder = 0; // 基准面参考层，低于内容
  return line;
}

// 重建基准面坐标标示组（范围变化后调用；签名去重避免拖动时反复重建）
export function buildAxisMarkers(ed) {
  if (!ed._three) return;
  const t = ed.map.terrain;
  const bb = t && Array.isArray(t.heights) && t.heights.length
    ? { x0: t.x0, x1: t.x1, z0: t.z0, z1: t.z1 }
    : (() => {
      const a = ed.map.area || {};
      const w = (a.w || 4000) / 2, d = (a.d || 4000) / 2;
      return { x0: (a.cx || 0) - w, x1: (a.cx || 0) + w, z0: (a.cz || 0) - d, z1: (a.cz || 0) + d };
    })();
  const a = ed.map.area || {};
  // 曲率中心变化会改变基准面高度（_curveOffset 以 area.cx/cz 为基准）→ 纳入签名
  const sig = [bb.x0, bb.x1, bb.z0, bb.z1, a.cx || 0, a.cz || 0].map(Math.round).join(",");
  if (ed._axisSig === sig && ed._axisGroup) return;
  ed._axisSig = sig;

  if (ed._axisGroup) {
    ed._three.scene.remove(ed._axisGroup);
    ed._axisGroup.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
  const g = new THREE.Group();
  g.userData.isAxis = true;

  // 主轴延伸到与基准网格同样的外沿（含原点两侧），按 SEG 分段贴合曲率
  const xLo = Math.min(bb.x0, 0) - EXT, xHi = Math.max(bb.x1, 0) + EXT;
  const zLo = Math.min(bb.z0, 0) - EXT, zHi = Math.max(bb.z1, 0) + EXT;
  const range = (lo, hi) => {
    const out = [];
    for (let v = lo; v < hi; v += SEG) out.push(v);
    out.push(hi);
    return out;
  };
  g.add(datumLine(ed, range(xLo, xHi).map((x) => ({ x, z: 0 })), 1.5, AXIS_X, 0.7));
  g.add(datumLine(ed, range(zLo, zHi).map((z) => ({ x: 0, z })), 1.5, AXIS_Z, 0.7));

  ed._axisGroup = g;
  ed._three.scene.add(g);
  // 应用当前显隐（图层开关 + 卫星底图互斥）
  if (ed._applyLayerVis) ed._applyLayerVis();
}
