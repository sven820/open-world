// 城市点景实体：停放机车（人行道环线采样 + InstancedMesh 批渲染）
// 与路口红绿灯灯杆（程序化路口四角 + 描边路口四角）。
// 函数以 city 实例为第一参数（City 类做薄委托）。

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { applyColor, cylAt } from "./batch.js";
import { scooterParts } from "../entities/models.js";

function choice(arr) { return arr[(Math.random() * arr.length) | 0]; }

// 停放机车：沿人行道环线随机停靠（车头朝向环线圆心），描边路走廊内不放。
// 五个部件（车身/座椅/尾箱/暗件/灯罩）各一个 InstancedMesh，一次上传静态渲染。
export function buildParkedScooters(city) {
  const spots = [];
  const target = 760;
  const loops = city.sidewalkLoops;
  let guard = 0;
  while (spots.length < target && loops.length && guard++ < 8000) {
    const loop = choice(loops);
    const seg = choice(loop.segs);
    // loop centroid
    const cxm = (loop.pts[0].x + loop.pts[2].x) / 2;
    const czm = (loop.pts[0].z + loop.pts[2].z) / 2;
    const t = Math.random();
    const x = seg.a.x + (seg.b.x - seg.a.x) * t;
    const z = seg.a.z + (seg.b.z - seg.a.z) * t;
    // inward direction = toward loop centre
    let nx = cxm - x, nz = czm - z;
    const nl = Math.hypot(nx, nz) || 1;
    nx /= nl; nz /= nl;
    // near the kerb: step outward from the walking line
    const px = x - nx * 1.0;
    const pz = z - nz * 1.0;
    // 描边路走廊内不放：路口转角的人行道环线会穿过手绘道路
    if (city._inTraceCorridor(px, pz)) continue;
    const rot = Math.atan2(nx, nz);
    spots.push({ x: px, z: pz, rot });
  }

  const kinds = new Map();
  for (const p of scooterParts()) {
    if (!kinds.has(p.kind)) kinds.set(p.kind, []);
    kinds.get(p.kind).push(p.g);
  }
  const geos = {};
  for (const [k, arr] of kinds) geos[k] = arr.length === 1 ? arr[0] : mergeGeometries(arr, false);

  city.parkedMeshes = [];
  const caps = { body: spots.length, seat: spots.length, box: spots.length, dark: spots.length, light: spots.length };
  const meshes = {};
  const mats = {
    body: new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.45, roughness: 0.45 }),
    seat: new THREE.MeshStandardMaterial({ color: 0x17181b, roughness: 0.8 }),
    box: new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.2, roughness: 0.6 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x202227, roughness: 0.8 }),
    light: new THREE.MeshBasicMaterial({ color: 0xfff1c8 }),
  };
  for (const k of Object.keys(caps)) {
    meshes[k] = new THREE.InstancedMesh(geos[k], mats[k], caps[k]);
    // 停放机车是静态的：固定上传一次，避免驱动把它当成每帧会变的动态缓冲
    meshes[k].instanceMatrix.setUsage(THREE.StaticDrawUsage);
    meshes[k].castShadow = k === "body";
    meshes[k].receiveShadow = true;
    meshes[k].count = spots.length;
    city.group.add(meshes[k]);
    city.parkedMeshes.push(meshes[k]);
  }
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3(1, 1, 1);
  const pos = new THREE.Vector3();
  const bodyColors = [0x63c0a8, 0xd8d8d8, 0x2a2b30, 0xd94a4a, 0x2a5a9a, 0xe8b84a, 0x8a4ad0, 0xe86a9a, 0x4a8a4a];
  const boxColors = [0x2f9e5f, 0x1f9e8f, 0xe04a8a, 0xd0402a, 0x2a6ad0, 0xe8b84a];
  const col = new THREE.Color();

  spots.forEach((p, i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.rot);
    pos.set(p.x, 0.16, p.z);
    m.compose(pos, q, s);
    for (const k of Object.keys(meshes)) meshes[k].setMatrixAt(i, m);
    meshes.body.setColorAt(i, col.setHex(choice(bodyColors)));
    meshes.box.setColorAt(i, col.setHex(choice(boxColors)));
    meshes.seat.setColorAt(i, col.setHex(0x17181b));
    meshes.dark.setColorAt(i, col.setHex(0x202227));
    meshes.light.setColorAt(i, col.setHex(0xfff1c8));
  });
  for (const k of Object.keys(meshes)) {
    meshes[k].instanceMatrix.needsUpdate = true;
    if (meshes[k].instanceColor) meshes[k].instanceColor.needsUpdate = true;
  }
  city.parked = spots;
}

// 路口红绿灯灯杆与灯头（InstancedMesh）：程序化路口四角 + 描边路路口四角。
// 相位归属按道路走向映射到南北 / 东西，供交通系统取用 city.trafficHeads。
export function buildTrafficHeads(city) {
  const heads = [];
  for (const it of city.intersections) {
    const hx = it.hx, hz = it.hz;
    const positions = [
      { x: it.x - hx - 1.3, z: it.z + hz + 1.3, axis: "z" },
      { x: it.x + hx + 1.3, z: it.z - hz - 1.3, axis: "z" },
      { x: it.x - hx - 1.3, z: it.z - hz - 1.3, axis: "x" },
      { x: it.x + hx + 1.3, z: it.z + hz + 1.3, axis: "x" },
    ];
    for (const p of positions) {
      // pole
      city.propBatch.add(applyColor(cylAt(0.06, 0.08, 3.9, p.x, 1.95 + 0.16, p.z, 6), 0x3c3e42));
      heads.push(p);
    }
  }
  // 描边路 × 横纵路的路口：四角灯杆，分别沿描边路法线、横路法线外扩 1.3m
  // （面路两侧变宽时按实测边界外扩，杆子不落进路面）
  for (const j of city.traceJunctions || []) {
    const nx = -j.uz, nz = j.ux;
    const mx = j.mx, mz = j.mz;
    const lbPos = (j.edgePos ?? j.roadHalf) + 1.3, lbNeg = -(j.edgeNeg ?? j.roadHalf) + 1.3;
    // 相位归属：按两条路各自的大方向近似映射到南北 / 东西相位，与程序化路口共用同一循环
    const axisRoad = Math.abs(j.uz) >= Math.abs(j.ux) ? "z" : "x";
    const axisVia = Math.abs(j.vz) >= Math.abs(j.vx) ? "z" : "x";
    const corners = [
      { sn: -1, sm: 1, axis: axisRoad },
      { sn: 1, sm: -1, axis: axisRoad },
      { sn: -1, sm: -1, axis: axisVia },
      { sn: 1, sm: 1, axis: axisVia },
    ];
    for (const c of corners) {
      const lb = c.sn < 0 ? lbNeg : lbPos;
      const px = j.x + nx * c.sn * lb + mx * c.sm * (j.progHalf + 1.3);
      const pz = j.z + nz * c.sn * lb + mz * c.sm * (j.progHalf + 1.3);
      city.propBatch.add(applyColor(cylAt(0.06, 0.08, 3.9, px, 1.95 + 0.16, pz, 6), 0x3c3e42));
      heads.push({ x: px, z: pz, axis: c.axis });
    }
  }
  city.trafficHeads = heads;
  const geo = new THREE.BoxGeometry(0.26, 0.62, 0.22);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const inst = new THREE.InstancedMesh(geo, mat, heads.length);
  const m = new THREE.Matrix4();
  heads.forEach((p, i) => {
    m.makeTranslation(p.x, 3.6, p.z);
    inst.setMatrixAt(i, m);
    inst.setColorAt(i, new THREE.Color(0x1a1a1a));
  });
  inst.instanceMatrix.needsUpdate = true;
  city.group.add(inst);
  city.trafficInst = inst;
}
