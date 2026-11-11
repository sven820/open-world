import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const _c = new THREE.Color();

export function applyColor(geo, color) {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  _c.set(color);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = _c.r; arr[i * 3 + 1] = _c.g; arr[i * 3 + 2] = _c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return geo;
}

export function scaleUV(geo, su, sv) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  }
  uv.needsUpdate = true;
  return geo;
}

export function setUVRect(geo, u0, v0, u1, v1) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  }
  uv.needsUpdate = true;
  return geo;
}

export class Batch {
  constructor() { this.geoms = []; }
  add(geo) {
    if (!geo) return this;
    if (geo.index) {
      const ng = geo.toNonIndexed();
      geo.dispose();
      geo = ng;
    }
    this.geoms.push(geo);
    return this;
  }
  get size() { return this.geoms.length; }
  merge() {
    if (!this.geoms.length) return null;
    const g = mergeGeometries(this.geoms, false);
    this.geoms.forEach((x) => x.dispose());
    this.geoms = [];
    return g;
  }
  build(material, { castShadow = false, receiveShadow = true } = {}) {
    const g = this.merge();
    if (!g) return null;
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, material);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
  }
}

/**
 * Like Batch, but splits geometry into fixed-size spatial cells so each cell
 * becomes its own mesh with a tight bounding sphere. This lets frustum culling
 * actually drop off-screen chunks — essential once the city is large, otherwise
 * every merged mesh spans the whole map and is always drawn.
 */
export class ChunkedBatch {
  constructor(cell = 220) { this.cell = cell; this.cells = new Map(); this.geomsCount = 0; }
  _key(x, z) {
    return Math.floor(x / this.cell) * 100000 + Math.floor(z / this.cell);
  }
  add(geo) {
    if (!geo) return this;
    if (geo.index) {
      const ng = geo.toNonIndexed();
      geo.dispose();
      geo = ng;
    }
    const p = geo.attributes.position;
    // cheap centroid: midpoint of first and last vertex (good for boxes & strips)
    const x = (p.getX(0) + p.getX(p.count - 1)) * 0.5;
    const z = (p.getZ(0) + p.getZ(p.count - 1)) * 0.5;
    const k = this._key(x, z);
    let arr = this.cells.get(k);
    if (!arr) { arr = []; this.cells.set(k, arr); }
    arr.push(geo);
    this.geomsCount++;
    return this;
  }
  get size() { return this.geomsCount; }
  // returns an array of meshes (one per non-empty cell)
  build(material, { castShadow = false, receiveShadow = true } = {}) {
    const meshes = [];
    for (const geoms of this.cells.values()) {
      const g = mergeGeometries(geoms, false);
      geoms.forEach((x) => x.dispose());
      if (!g) continue;
      g.computeBoundingSphere();
      // pad the sphere a little so geometry that straddles a cell edge is not
      // wrongly culled when its own cell is just outside the frustum
      if (g.boundingSphere) g.boundingSphere.radius += 30;
      const mesh = new THREE.Mesh(g, material);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      meshes.push(mesh);
    }
    return meshes;
  }
}

/** vertical wall quad. dir: 'n','s','e','w'. Rect x0..x1,z0..z1, y0..y1 */
export function wallQuad(dir, x0, x1, z0, z1, y0, y1, uScale = 1, vScale = 1) {
  const w = dir === "n" || dir === "s" ? x1 - x0 : z1 - z0;
  const h = y1 - y0;
  const g = new THREE.PlaneGeometry(w, h, 1, 1);
  scaleUV(g, (w / 6.4) * uScale, (h / 6.4) * vScale);
  if (dir === "s") {
    g.rotateY(0);
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, z1);
  } else if (dir === "n") {
    g.rotateY(Math.PI);
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, z0);
  } else if (dir === "e") {
    g.rotateY(Math.PI / 2);
    g.translate(x1, (y0 + y1) / 2, (z0 + z1) / 2);
  } else {
    g.rotateY(-Math.PI / 2);
    g.translate(x0, (y0 + y1) / 2, (z0 + z1) / 2);
  }
  return g;
}

export function roofQuad(x0, x1, z0, z1, y, uScale = 1, vScale = 1) {
  const w = x1 - x0, d = z1 - z0;
  const g = new THREE.PlaneGeometry(w, d, 1, 1);
  scaleUV(g, (w / 4) * uScale, (d / 4) * vScale);
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
  return g;
}

export function boxAt(w, h, d, x, y, z, ry = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}

export function planeAt(w, h, x, y, z, ry = 0, rx = 0) {
  const g = new THREE.PlaneGeometry(w, h);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}

export function signQuad(w, h, x, y, z, ry, u0, v0, u1, v1) {
  const g = new THREE.PlaneGeometry(w, h);
  setUVRect(g, u0, v0, u1, v1);
  g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}

export function cylAt(rt, rb, h, x, y, z, seg = 8) {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg, 1);
  g.translate(x, y, z);
  return g;
}

export function icoAt(r, x, y, z, detail = 1, sx = 1, sy = 1, sz = 1) {
  const g = new THREE.IcosahedronGeometry(r, detail);
  g.scale(sx, sy, sz);
  g.translate(x, y, z);
  return g;
}
