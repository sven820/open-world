import * as THREE from "three/webgpu";
import { activeLandmarks } from "../data/cityData.js";
import { getMaterial } from "./materials.js";

function box(w, h, d, x, y, z, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}
function cyl(rt, rb, h, x, y, z, seg, mat, rot = 0) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
  m.position.set(x, y, z);
  m.rotation.y = rot;
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

// 材质统一取自标准材料库（全局共享实例，与描边建筑/程序化城市同一套材质槽）；
// 各地标独有的特殊材质（窗、灯笼、立柱等）仍在构建函数内就地创建
const GLASS_BY_HEX = {
  0x8a9aa6: "surface:glass-blue",
  0x7d93a6: "surface:glass-steel",
  0x9fb2c2: "surface:glass-pale",
  0xb8c2cc: "surface:glass-light",
  0x6f9bc4: "surface:glass-sky",
  0x3a4a58: "surface:glass-dark",
  0xc9a23a: "surface:gold",
};
const glassMat = (c) => getMaterial(GLASS_BY_HEX[c] || "surface:glass-steel");
const concreteMat = () => getMaterial("surface:concrete");
const redMat = () => getMaterial("surface:red");
const whiteMat = () => getMaterial("surface:plaster-white");
const blueRoofMat = () => getMaterial("surface:blue-roof");
const goldMat = () => getMaterial("surface:gold");

function addCollider(city, x0, z0, x1, z1, top) { city.colliders.add(x0, z0, x1, z1, top); }

export function buildLandmarks(scene, city) {
  const group = new THREE.Group();
  scene.add(group);
  city.landmarks = [];

  for (const l of activeLandmarks()) {
    const g = new THREE.Group();
    g.position.set(l.x, 0, l.z);
    g.rotation.y = l.rot;
    group.add(g);
    let collW = 20, collD = 20;
    // 碰撞体顶面高度（相机遮挡判断用；按各地标实际体量估算）
    let collTop = 28;
    if (l.type === "skytower") collW = collD = 40;
    if (l.type === "tower") collW = collD = 26;
    if (l.type === "station") collW = 70, collD = 40;
    if (l.type === "hall") collW = 60, collD = 60;
    if (l.type === "temple") collW = collD = 24;
    if (l.type === "redhouse") collW = collD = 24;
    if (l.type === "metro") collW = collD = 12;
    if (l.type === "gate") collW = collD = 14;

    if (l.type === "skytower") collTop = 130;
    else if (l.type === "tower") collTop = (l.h || 100) + 6;
    else if (l.type === "station") collTop = 34;
    else if (l.type === "hall") collTop = 40;
    else if (l.type === "temple") collTop = 20;
    else if (l.type === "redhouse") collTop = 15;
    else if (l.type === "metro") collTop = 18;
    else if (l.type === "gate") collTop = 18;

    if (l.type === "skytower") buildSkytower(g);
    else if (l.type === "tower") buildTower(g, l.h || 100);
    else if (l.type === "redhouse") buildRedHouse(g);
    else if (l.type === "temple") buildTemple(g);
    else if (l.type === "hall") buildHall(g);
    else if (l.type === "station") buildStation(g);
    else if (l.type === "metro") buildMetro(g);
    else if (l.type === "gate") buildGate(g);

    addCollider(city, l.x - collW / 2, l.z - collD / 2, l.x + collW / 2, l.z + collD / 2, collTop);
    city.landmarks.push(l);
  }
  return group;
}

function buildSkytower(g) {
  const s = 0.55;
  const S = (v) => v * s;
  // podium
  g.add(box(S(58), S(28), S(58), 0, S(14), 0, concreteMat()));
  // stacked tiers
  const tiers = 8;
  const baseR = 22, topR = 8;
  let y = S(28);
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const rb = baseR * (1 - t * 0.5);
    const rt = rb * 0.82;
    const h = S(26) * (1 - t * 0.18);
    const tier = cyl(S(rt), S(rb), h, 0, y + h / 2, 0, 4, glassMat(0x8a9aa6), Math.PI / 4);
    g.add(tier);
    // glowing rim
    const rim = new THREE.Mesh(new THREE.TorusGeometry(S(rb) * 1.02, S(0.5), 6, 4), goldMat());
    rim.rotation.x = Math.PI / 2; rim.rotation.z = Math.PI / 4;
    rim.position.y = y;
    g.add(rim);
    y += h - S(1.5);
  }
  // spire
  g.add(cyl(0.2, S(2), S(50), 0, y + S(25), 0, 8, goldMat()));
  g.add(cyl(0.05, 0.05, S(40), 0, y + S(68), 0, 6, glassMat(0xc9a23a)));
}

function buildTower(g, h) {
  const H = h || 100;
  g.add(box(26, H, 26, 0, H / 2, 0, glassMat(0x7d93a6)));
  // setback top
  g.add(box(18, H * 0.18, 18, 0, H + H * 0.09, 0, glassMat(0x9fb2c2)));
  g.add(cyl(0, 3, 10, 0, H + H * 0.2 + 5, 0, 8, glassMat(0xc9a23a)));
  // crown emissive strips
  for (let i = 0; i < 4; i++) {
    const strip = box(0.4, H * 0.9, 0.4, 12.5, H / 2, 12.5 * (i % 2 ? 1 : -1), glassMat(0x3a4a58));
    g.add(strip);
  }
}

function buildRedHouse(g) {
  const r = 11;
  const body = cyl(r, r, 8, 0, 4, 0, 8, redMat());
  g.add(body);
  // white trim
  g.add(cyl(r + 0.3, r + 0.3, 0.6, 0, 8, 0, 8, whiteMat()));
  // octagonal red roof
  const roof = cyl(0, r + 1.5, 5, 0, 10.5, 0, 8, redMat());
  g.add(roof);
  // base
  g.add(box(r * 2 + 2, 1.2, r * 2 + 2, 0, 0.6, 0, whiteMat()));
  // windows (emissive)
  const wm = getMaterial("surface:win-dark");
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    g.add(box(2.4, 2.2, 0.4, Math.cos(a) * r * 0.78, 5, Math.sin(a) * r * 0.78, wm));
  }
}

function buildTemple(g) {
  // main hall
  g.add(box(28, 12, 18, 0, 6, 0, redMat()));
  // columns
  const colMat = getMaterial("surface:brass");
  for (const sx of [-12, 12]) for (const sz of [-8, 8]) g.add(cyl(0.6, 0.6, 12, sx, 6, sz, 8, colMat));
  // swooping roof
  const roof1 = box(34, 1.5, 24, 0, 13, 0, blueRoofMat());
  g.add(roof1);
  const roof2 = box(30, 6, 20, 0, 17, 0, blueRoofMat());
  roof2.rotation.x = 0; roof2.scale.y = 1;
  g.add(roof2);
  // ridge
  g.add(box(34, 0.6, 24.4, 0, 20, 0, goldMat()));
  // steps
  g.add(box(30, 1, 22, 0, 0.5, 0, whiteMat()));
  // lanterns
  const lantern = getMaterial("surface:lantern");
  for (const sx of [-10, 10]) g.add(cyl(1.2, 1.2, 2, sx, 11, 10, 10, lantern));
}

function buildHall(g) {
  // white hall
  g.add(box(50, 20, 36, 0, 10, 0, whiteMat()));
  // blue hip roof
  const roof = cyl(0, 38, 12, 0, 26, 0, 4, blueRoofMat(), Math.PI / 4);
  g.add(roof);
  const roof2 = cyl(0, 30, 9, 0, 33, 0, 4, blueRoofMat(), Math.PI / 4);
  g.add(roof2);
  // base steps
  g.add(box(58, 2, 44, 0, 1, 0, whiteMat()));
  // entrance arch
  const gate = box(20, 16, 4, 0, 8, -22, whiteMat());
  g.add(gate);
  g.add(box(8, 8, 5, 0, 8, -22, getMaterial("surface:blue-paint")));
}

function buildStation(g) {
  g.add(box(64, 18, 34, 0, 9, 0, glassMat(0xb8c2cc)));
  // curved roof
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(20, 20, 66, 24, 1, false, 0, Math.PI), concreteMat());
  roof.rotation.z = Math.PI / 2;
  roof.scale.set(1, 1, 0.35);
  roof.position.y = 18;
  roof.castShadow = true;
  g.add(roof);
  g.add(box(70, 2, 40, 0, 1, 0, whiteMat()));
}

function buildMetro(g) {
  // round glass entrance kiosk
  g.add(cyl(4, 4, 5, 0, 2.5, 0, 12, glassMat(0x6f9bc4)));
  const top = cyl(4.4, 4, 0.6, 0, 5.2, 0, 12, getMaterial("surface:metro-red"));
  g.add(top);
  // sign
  const sign = box(6, 1.4, 0.3, 0, 4, 4.2, getMaterial("surface:sign-red"));
  g.add(sign);
}

function buildGate(g) {
  g.add(box(14, 8, 3, 0, 4, 0, redMat()));
  // roof
  g.add(box(18, 2, 5, 0, 9, 0, blueRoofMat()));
  g.add(box(14, 0.6, 3.4, 0, 11, 0, goldMat()));
  // side walls
  g.add(box(3, 7, 3, -7, 3.5, 0, redMat()));
  g.add(box(3, 7, 3, 7, 3.5, 0, redMat()));
}
