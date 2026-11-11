import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { applyColor, boxAt, cylAt } from "../world/batch.js";

/* ================= shared materials ================= */
export const vehicleMat = new THREE.MeshStandardMaterial({
  vertexColors: true,
  metalness: 0.55,
  roughness: 0.38,
});
export const vehicleGlassMat = new THREE.MeshStandardMaterial({
  color: 0x18242e, metalness: 0.9, roughness: 0.14, transparent: true, opacity: 0.9,
});
export const lightMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
export const darkMat = new THREE.MeshStandardMaterial({ color: 0x1b1c1f, metalness: 0.3, roughness: 0.75 });
export const tyreMat = new THREE.MeshStandardMaterial({ color: 0x111214, metalness: 0.1, roughness: 0.92 });

function merged(parts) {
  const geos = parts.map(({ g, c }) => applyColor(g, c));
  const m = mergeGeometries(geos, false);
  geos.forEach((g) => g.dispose());
  return m;
}

/* ================= cars ================= */
export function buildCar(kind = "sedan", color = 0xcfcfcf, opts = {}) {
  const group = new THREE.Group();
  const isTaxi = kind === "taxi";
  const isSUV = kind === "suv";
  const isVan = kind === "van";
  const W = isVan ? 1.95 : isSUV ? 1.92 : 1.82;
  const L = isVan ? 4.9 : isSUV ? 4.7 : 4.45;
  const bodyH = isVan ? 1.05 : isSUV ? 0.85 : 0.66;
  const bodyY = 0.42 + bodyH / 2;

  const parts = [];
  parts.push({ g: boxAt(W, bodyH, L, 0, bodyY, 0), c: color });
  // lower skirt
  parts.push({ g: boxAt(W * 0.96, 0.24, L * 0.98, 0, 0.34, 0), c: 0x2a2b2f });
  if (isVan) {
    parts.push({ g: boxAt(W * 0.94, 1.25, L * 0.86, 0, 1.55, -0.1), c: color });
    // side windows
    parts.push({ g: boxAt(W * 0.96, 0.5, L * 0.62, 0, 1.78, -0.2), c: 0x18242e });
  } else {
    const cabinH = isSUV ? 0.72 : 0.52;
    const cabinL = isSUV ? 2.7 : 2.25;
    parts.push({ g: boxAt(W * 0.9, cabinH, cabinL, 0, 0.42 + bodyH + cabinH / 2, -0.18), c: color });
    // glass band
    parts.push({ g: boxAt(W * 0.92, cabinH * 0.62, cabinL * 0.92, 0, 0.42 + bodyH + cabinH * 0.55, -0.18), c: 0x16212b });
    // roof
    parts.push({ g: boxAt(W * 0.78, 0.09, cabinL * 0.8, 0, 0.42 + bodyH + cabinH + 0.02, -0.18), c: color });
  }
  // bumpers
  parts.push({ g: boxAt(W * 1.01, 0.2, 0.2, 0, 0.44, L / 2 - 0.02), c: 0x232428 });
  parts.push({ g: boxAt(W * 1.01, 0.2, 0.2, 0, 0.44, -L / 2 + 0.02), c: 0x232428 });

  // wheels
  const wr = isSUV || isVan ? 0.37 : 0.33;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const g = new THREE.CylinderGeometry(wr, wr, 0.26, 12);
    g.rotateZ(Math.PI / 2);
    g.translate(sx * (W / 2 - 0.06), wr, sz * (L / 2 - 0.85));
    parts.push({ g, c: 0x101114 });
    const rim = new THREE.CylinderGeometry(wr * 0.55, wr * 0.55, 0.27, 10);
    rim.rotateZ(Math.PI / 2);
    rim.translate(sx * (W / 2 - 0.06), wr, sz * (L / 2 - 0.85));
    parts.push({ g: rim, c: 0x9a9a9f });
  }

  if (isTaxi) {
    parts.push({ g: boxAt(0.62, 0.18, 0.3, 0, 0.42 + bodyH + (isSUV ? 0.72 : 0.52) + 0.18, -0.18), c: 0xffe36a });
  }

  const bodyGeo = merged(parts);
  const body = new THREE.Mesh(bodyGeo, vehicleMat);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // lights (basic emissive)
  const lg = [];
  const fy = 0.6;
  lg.push({ g: boxAt(0.34, 0.14, 0.06, -W * 0.32, fy, L / 2 + 0.01), c: 0xfff1c8 });
  lg.push({ g: boxAt(0.34, 0.14, 0.06, W * 0.32, fy, L / 2 + 0.01), c: 0xfff1c8 });
  lg.push({ g: boxAt(0.34, 0.12, 0.06, -W * 0.32, fy + 0.02, -L / 2 - 0.01), c: 0xff3322 });
  lg.push({ g: boxAt(0.34, 0.12, 0.06, W * 0.32, fy + 0.02, -L / 2 - 0.01), c: 0xff3322 });
  const lights = new THREE.Mesh(merged(lg), lightMat);
  group.add(lights);

  group.userData = { kind, W, L, height: 0.42 + bodyH + 0.7, wheelR: wr };
  return group;
}

export function buildBus(color = 0x2a6bc4) {
  const group = new THREE.Group();
  const W = 2.5, L = 11.2, H = 3.0;
  const parts = [];
  parts.push({ g: boxAt(W, H, L, 0, H / 2 + 0.34, 0), c: color });
  parts.push({ g: boxAt(W * 1.005, 0.5, L * 0.99, 0, 0.7, 0), c: 0xe8e8e8 });
  // window band
  parts.push({ g: boxAt(W * 1.01, 0.82, L * 0.9, 0, 2.12, 0), c: 0x16222c });
  // roof
  parts.push({ g: boxAt(W * 0.96, 0.16, L * 0.96, 0, H + 0.34, 0), c: 0xd8d8d8 });
  // doors
  parts.push({ g: boxAt(0.06, 1.9, 1.1, W / 2 + 0.01, 1.4, L * 0.28), c: 0x1c2b36 });
  parts.push({ g: boxAt(0.06, 1.9, 1.1, W / 2 + 0.01, 1.4, -L * 0.3), c: 0x1c2b36 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const g = new THREE.CylinderGeometry(0.46, 0.46, 0.3, 12);
    g.rotateZ(Math.PI / 2);
    g.translate(sx * (W / 2 - 0.05), 0.46, sz * (L / 2 - 1.9));
    parts.push({ g, c: 0x101114 });
  }
  const body = new THREE.Mesh(merged(parts), vehicleMat);
  body.castShadow = true; body.receiveShadow = true;
  group.add(body);

  const lg = [];
  lg.push({ g: boxAt(0.4, 0.2, 0.06, -W * 0.32, 0.85, L / 2 + 0.01), c: 0xfff1c8 });
  lg.push({ g: boxAt(0.4, 0.2, 0.06, W * 0.32, 0.85, L / 2 + 0.01), c: 0xfff1c8 });
  lg.push({ g: boxAt(0.4, 0.2, 0.06, -W * 0.32, 0.85, -L / 2 - 0.01), c: 0xff3322 });
  lg.push({ g: boxAt(0.4, 0.2, 0.06, W * 0.32, 0.85, -L / 2 - 0.01), c: 0xff3322 });
  group.add(new THREE.Mesh(merged(lg), lightMat));

  group.userData = { kind: "bus", W, L, height: H + 0.34, wheelR: 0.46 };
  return group;
}

export function buildScooter(color = 0x63c0a8) {
  const group = new THREE.Group();
  const parts = [];
  // floorboard
  parts.push({ g: boxAt(0.38, 0.1, 0.9, 0, 0.34, 0.05), c: 0x1d1e22 });
  // front shield
  const shield = new THREE.BoxGeometry(0.5, 0.72, 0.16);
  shield.rotateX(-0.16); shield.translate(0, 0.74, 0.62);
  parts.push({ g: shield, c: color });
  // rear body
  parts.push({ g: boxAt(0.42, 0.34, 0.78, 0, 0.52, -0.36), c: color });
  // seat
  parts.push({ g: boxAt(0.4, 0.14, 0.62, 0, 0.76, -0.28), c: 0x17181b });
  // rear delivery box
  parts.push({ g: boxAt(0.44, 0.36, 0.4, 0, 0.96, -0.66), c: optsBoxColor(color) });
  // handlebar
  parts.push({ g: boxAt(0.62, 0.06, 0.06, 0, 1.02, 0.62), c: 0x2a2b2f });
  // fork
  parts.push({ g: boxAt(0.08, 0.6, 0.08, 0, 0.5, 0.74), c: 0x55565c });
  // wheels
  const wr = 0.26;
  for (const z of [0.78, -0.66]) {
    const g = new THREE.CylinderGeometry(wr, wr, 0.12, 12);
    g.rotateZ(Math.PI / 2); g.translate(0, wr, z);
    parts.push({ g, c: 0x101114 });
  }
  // mirrors
  parts.push({ g: boxAt(0.03, 0.16, 0.03, -0.28, 1.14, 0.62), c: 0x2a2b2f });
  parts.push({ g: boxAt(0.03, 0.16, 0.03, 0.28, 1.14, 0.62), c: 0x2a2b2f });
  parts.push({ g: boxAt(0.12, 0.08, 0.04, -0.28, 1.22, 0.62), c: 0x77787c });
  parts.push({ g: boxAt(0.12, 0.08, 0.04, 0.28, 1.22, 0.62), c: 0x77787c });

  const body = new THREE.Mesh(merged(parts), vehicleMat);
  body.castShadow = true;
  group.add(body);
  const lg = [];
  lg.push({ g: boxAt(0.18, 0.1, 0.05, 0, 0.86, 0.71), c: 0xfff1c8 });
  lg.push({ g: boxAt(0.14, 0.08, 0.05, 0, 0.62, -0.76), c: 0xff3322 });
  group.add(new THREE.Mesh(merged(lg), lightMat));
  group.userData = { kind: "scooter", W: 0.62, L: 1.85, height: 1.3, wheelR: wr };
  return group;
}

function optsBoxColor(c) {
  const palette = [0x2f9e5f, 0x1f9e8f, 0xe04a8a, 0xd0402a, 0x2a6ad0];
  return palette[Math.floor(Math.random() * palette.length)];
}

/* ================= parked scooter parts ================= */
// returns geometries (origin at ground) + part kind
export function scooterParts() {
  const parts = [];
  parts.push({ kind: "body", g: boxAt(0.38, 0.1, 0.9, 0, 0.34, 0.05) });
  const shield = new THREE.BoxGeometry(0.5, 0.72, 0.16);
  shield.rotateX(-0.16); shield.translate(0, 0.74, 0.62);
  parts.push({ kind: "body", g: shield });
  parts.push({ kind: "body", g: boxAt(0.42, 0.34, 0.78, 0, 0.52, -0.36) });
  parts.push({ kind: "seat", g: boxAt(0.4, 0.14, 0.62, 0, 0.76, -0.28) });
  parts.push({ kind: "box", g: boxAt(0.44, 0.36, 0.4, 0, 0.96, -0.66) });
  parts.push({ kind: "dark", g: boxAt(0.62, 0.06, 0.06, 0, 1.02, 0.62) });
  parts.push({ kind: "dark", g: boxAt(0.08, 0.6, 0.08, 0, 0.5, 0.74) });
  for (const z of [0.78, -0.66]) {
    const g = new THREE.CylinderGeometry(0.26, 0.26, 0.12, 10);
    g.rotateZ(Math.PI / 2); g.translate(0, 0.26, z);
    parts.push({ kind: "dark", g });
  }
  parts.push({ kind: "dark", g: boxAt(0.03, 0.16, 0.03, -0.28, 1.14, 0.62) });
  parts.push({ kind: "dark", g: boxAt(0.03, 0.16, 0.03, 0.28, 1.14, 0.62) });
  parts.push({ kind: "light", g: boxAt(0.18, 0.1, 0.05, 0, 0.86, 0.71) });
  return parts;
}

/* ================= pedestrian rig ================= */
export const PED_PARTS = ["head", "hair", "torso", "hips", "armUL", "armUR", "armFL", "armFR", "legUL", "legUR", "legFL", "legFR", "shoeL", "shoeR"];

export function pedPartGeometry(name) {
  switch (name) {
    case "head": {
      const g = new THREE.SphereGeometry(0.125, 10, 8);
      g.scale(0.92, 1.12, 0.95);
      g.translate(0, 0.11, 0);
      return g;
    }
    case "hair": {
      const g = new THREE.SphereGeometry(0.135, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.62);
      g.scale(0.98, 1.05, 1.0);
      g.translate(0, 0.14, -0.005);
      return g;
    }
    case "torso": {
      const g = new THREE.BoxGeometry(0.4, 0.52, 0.23);
      g.translate(0, 0.22, 0);
      return g;
    }
    case "hips": return new THREE.BoxGeometry(0.33, 0.2, 0.22);
    case "armUL": case "armUR": {
      const g = new THREE.BoxGeometry(0.1, 0.3, 0.11);
      g.translate(0, -0.15, 0);
      return g;
    }
    case "armFL": case "armFR": {
      const g = new THREE.BoxGeometry(0.09, 0.28, 0.1);
      g.translate(0, -0.14, 0);
      return g;
    }
    case "legUL": case "legUR": {
      const g = new THREE.BoxGeometry(0.145, 0.4, 0.16);
      g.translate(0, -0.2, 0);
      return g;
    }
    case "legFL": case "legFR": {
      const g = new THREE.BoxGeometry(0.125, 0.4, 0.14);
      g.translate(0, -0.2, 0);
      return g;
    }
    case "shoeL": case "shoeR": {
      const g = new THREE.BoxGeometry(0.13, 0.09, 0.24);
      g.translate(0, -0.045, 0.05);
      return g;
    }
  }
}

export function makePedRig() {
  const root = new THREE.Object3D();
  const hips = new THREE.Object3D(); hips.position.y = 0.92; root.add(hips);
  const torso = new THREE.Object3D(); torso.position.y = 0.26; hips.add(torso);
  const head = new THREE.Object3D(); head.position.y = 0.42; torso.add(head);
  const hair = new THREE.Object3D(); hair.position.y = 0.02; head.add(hair);

  const armUL = new THREE.Object3D(); armUL.position.set(-0.255, 0.34, 0); torso.add(armUL);
  const armUR = new THREE.Object3D(); armUR.position.set(0.255, 0.34, 0); torso.add(armUR);
  const armFL = new THREE.Object3D(); armFL.position.y = -0.3; armUL.add(armFL);
  const armFR = new THREE.Object3D(); armFR.position.y = -0.3; armUR.add(armFR);

  const legUL = new THREE.Object3D(); legUL.position.set(-0.095, 0, 0); hips.add(legUL);
  const legUR = new THREE.Object3D(); legUR.position.set(0.095, 0, 0); hips.add(legUR);
  const legFL = new THREE.Object3D(); legFL.position.y = -0.4; legUL.add(legFL);
  const legFR = new THREE.Object3D(); legFR.position.y = -0.4; legUR.add(legFR);
  const shoeL = new THREE.Object3D(); shoeL.position.y = -0.4; legFL.add(shoeL);
  const shoeR = new THREE.Object3D(); shoeR.position.y = -0.4; legFR.add(shoeR);

  root.updateMatrixWorld(true);
  return { root, hips, torso, head, hair, armUL, armUR, armFL, armFR, legUL, legUR, legFL, legFR, shoeL, shoeR };
}

export const SKIN_TONES = [0xf1c9a5, 0xe8b98f, 0xd9a273, 0xc98a5c, 0xb87548, 0xf3d3b3, 0xa9663c];
export const HAIR_COLORS = [0x1b1714, 0x241a14, 0x2e211a, 0x3a2a1c, 0x121212, 0x4a3a2a, 0x6b5844, 0x9a8d7a];
export const CLOTH_COLORS = [
  0x2c2f36, 0x3d4450, 0x6c7078, 0x9aa0a8, 0xb9b4aa, 0xd8d3c8, 0xffffff,
  0x8f2f2f, 0xb5443a, 0x2f5c8f, 0x3a6ea5, 0x2f6b4f, 0x4d7a54, 0x7a4f8a,
  0xd06a8a, 0xd9a441, 0x5a4630, 0x2a2a2a, 0x7a2f4a, 0x2f6f7a,
];
export const PANTS_COLORS = [
  0x22252c, 0x2d3038, 0x3b3f48, 0x4a4e56, 0x22324a, 0x2e3b4f,
  0x3a3a3a, 0x55504a, 0x6b6357, 0x1c1c1e, 0x314a6b, 0x5a4a3a,
];
