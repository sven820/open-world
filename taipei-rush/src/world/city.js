import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  asphaltHalf, corridorHalf, LANE_W, districtAt,
  setMapData, activeRoadsX, activeRoadsZ, activeLandmarks,
  EXT_STEP_X, EXT_STEP_Z, mapBounds,
} from "../data/cityData.js";
import {
  Batch, ChunkedBatch, applyColor, scaleUV, boxAt, wallQuad, roofQuad, planeAt, signQuad, cylAt, icoAt,
} from "./batch.js";
import {
  makeFacades, makeStorefronts, makeSignAtlas, signTileRect,
  makeSidewalkTexture, makeAsphaltTexture, makeRoofTexture, makeTileStripTexture,
} from "./textures.js";
import { scooterParts, scooterParts as _sp } from "../entities/models.js";

const FLOOR_H = 3.15;
const GROUND_H = 4.0;

function rand(a, b) { return a + Math.random() * (b - a); }
function choice(arr) { return arr[(Math.random() * arr.length) | 0]; }

class ColliderGrid {
  constructor(cell = 24) {
    this.cell = cell;
    this.map = new Map();
  }
  key(ix, iz) { return ix * 73856093 ^ iz * 19349663; }
  add(x0, z0, x1, z1) {
    const c = this.cell;
    const i0 = Math.floor(x0 / c), i1 = Math.floor(x1 / c);
    const j0 = Math.floor(z0 / c), j1 = Math.floor(z1 / c);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = this.key(i, j);
      let arr = this.map.get(k);
      if (!arr) { arr = []; this.map.set(k, arr); }
      arr.push([x0, z0, x1, z1]);
    }
  }
  resolve(p, r) {
    const c = this.cell;
    const i0 = Math.floor((p.x - r) / c), i1 = Math.floor((p.x + r) / c);
    const j0 = Math.floor((p.z - r) / c), j1 = Math.floor((p.z + r) / c);
    const seen = new Set();
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const arr = this.map.get(this.key(i, j));
      if (!arr) continue;
      for (const b of arr) {
        if (seen.has(b)) continue;
        seen.add(b);
        const [x0, z0, x1, z1] = b;
        const nx = Math.max(x0, Math.min(p.x, x1));
        const nz = Math.max(z0, Math.min(p.z, z1));
        let dx = p.x - nx, dz = p.z - nz;
        const d2 = dx * dx + dz * dz;
        if (d2 < r * r) {
          if (d2 > 1e-6) {
            const d = Math.sqrt(d2);
            p.x = nx + (dx / d) * r;
            p.z = nz + (dz / d) * r;
          } else {
            // inside: push out on nearest face
            const pl = p.x - x0, pr = x1 - p.x, pt = p.z - z0, pb = z1 - p.z;
            const m = Math.min(pl, pr, pt, pb);
            if (m === pl) p.x = x0 - r;
            else if (m === pr) p.x = x1 + r;
            else if (m === pt) p.z = z0 - r;
            else p.z = z1 + r;
          }
        }
      }
    }
    return p;
  }
  // point-vs-building test (used for third-person camera collision)
  blocked(x, z, r) {
    const c = this.cell;
    const i0 = Math.floor((x - r) / c), i1 = Math.floor((x + r) / c);
    const j0 = Math.floor((z - r) / c), j1 = Math.floor((z + r) / c);
    const seen = new Set();
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const arr = this.map.get(this.key(i, j));
      if (!arr) continue;
      for (const b of arr) {
        if (seen.has(b)) continue; seen.add(b);
        const [x0, z0, x1, z1] = b;
        if (x > x0 && x < x1 && z > z0 && z < z1) return true;
        const nx = Math.max(x0, Math.min(x, x1));
        const nz = Math.max(z0, Math.min(z, z1));
        const dx = x - nx, dz = z - nz;
        if (dx * dx + dz * dz < r * r) return true;
      }
    }
    return false;
  }
}

export class City {
  // data: 用户自定义地图数据（roadsX/roadsZ/districts/landmarks/spawn）；null = 默认台北
  constructor(scene, data = null) {
    setMapData(data);
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.colliders = new ColliderGrid(24);
    this.sidewalkLoops = [];
    this.parked = [];
    this.intersections = [];
    this.edges = [];
    this.outgoing = new Map();
    this.trafficHeads = [];
    this.blocks = [];
    // ~3 km^2 world, centred on the authored downtown (195, -10):
    // width 2534 (X) x depth 1184 (Z) ≈ 3.0 km^2. Road grid is filled out
    // to these bounds in _buildRoads().
    // 用户地图：世界边界按其路网范围推导（四周留出延伸缓冲）
    this.bounds = data
      ? mapBounds(data.roadsX, data.roadsZ)
      : { minX: -1072, maxX: 1462, minZ: -602, maxZ: 582 };

    this.materials = {};
    this.facades = makeFacades();
    this.storefronts = makeStorefronts();
    this.signAtlas = makeSignAtlas();

    this.facadeBatches = this.facades.map(() => new ChunkedBatch(220));
    this.storefrontBatches = this.storefronts.map(() => new ChunkedBatch(220));
    this.roofBatch = new ChunkedBatch(220);
    this.signBatch = new ChunkedBatch(220);
    this.awningBatch = new ChunkedBatch(220);
    this.propBatch = new ChunkedBatch(220);      // vertex-coloured misc (tanks, poles, hedges, trees)
    this.markWhite = new ChunkedBatch(220);
    this.markYellow = new ChunkedBatch(220);
    this.platformBatch = new ChunkedBatch(220);
    this.lampGlassBatch = new ChunkedBatch(220);
    this.treeBatch = new ChunkedBatch(220);

    this.ready = this._init();
  }

  async _init() {
    const yieldFrame = () => new Promise((r) => setTimeout(r, 0));
    this._buildGround();
    this._buildRoads();
    await yieldFrame();
    await this._buildBlocksChunked();
    this._buildParkedScooters();
    await yieldFrame();
    this._buildTrafficHeads();
    this._finalize();
    this.readyState = true;
  }

  /* ---------------- ground ---------------- */
  _buildGround() {
    const outer = new THREE.Mesh(
      new THREE.PlaneGeometry(6000, 6000),
      new THREE.MeshStandardMaterial({ color: 0x2c322c, roughness: 1 })
    );
    outer.rotation.x = -Math.PI / 2;
    outer.position.y = -0.08;
    outer.receiveShadow = true;
    this.group.add(outer);

    const asphalt = makeAsphaltTexture();
    asphalt.repeat.set(180, 180);
    const b = this.bounds;
    const w = b.maxX - b.minX + 60;
    const d = b.maxZ - b.minZ + 60;
    const mat = new THREE.MeshStandardMaterial({ map: asphalt, color: 0xffffff, roughness: 0.95, metalness: 0.0 });
    const road = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
    road.rotation.x = -Math.PI / 2;
    road.position.set((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);
    road.receiveShadow = true;
    this.group.add(road);

    this.materials.asphalt = mat;
  }

  /* ---------------- road markings + medians ---------------- */
  _buildRoads() {
    const xs = activeRoadsX().slice().sort((a, b) => a.at - b.at);
    const zs = activeRoadsZ().slice().sort((a, b) => a.at - b.at);

    // Expand the road grid outward to fill the world bounds. The authored
    // downtown roads stay exactly as-is; ordinary "street" roads are appended
    // on each side so the procedural city scales to the configured map size.
    const GX = EXT_STEP_X, GZ = EXT_STEP_Z, b = this.bounds;
    let n = 0;
    const ext = (at) => ({ id: "ext" + (n++), at, kind: "street", lanes: 1, median: 0, sidewalk: 3 });
    while (xs[xs.length - 1].at < b.maxX) xs.push(ext(xs[xs.length - 1].at + GX));
    while (xs[0].at > b.minX) xs.unshift(ext(xs[0].at - GX));
    while (zs[zs.length - 1].at < b.maxZ) zs.push(ext(zs[zs.length - 1].at + GZ));
    while (zs[0].at > b.minZ) zs.unshift(ext(zs[0].at - GZ));

    this.roadsX = xs; this.roadsZ = zs;

    // intersections
    xs.forEach((rx, ix) => zs.forEach((rz, iz) => {
      this.intersections.push({ ix, iz, x: rx.at, z: rz.at, hx: asphaltHalf(rx), hz: asphaltHalf(rz) });
    }));

    // markings per segment
    for (let i = 0; i < xs.length; i++) {
      const rx = xs[i];
      const ah = asphaltHalf(rx);
      for (let j = 0; j < zs.length - 1; j++) {
        const za = zs[j].at + asphaltHalf(zs[j]);
        const zb = zs[j + 1].at - asphaltHalf(zs[j + 1]);
        if (zb - za < 8) continue;
        this._dashesVertical(rx.at, za, zb, rx);
        // outer edge lines
        for (const s of [-1, 1]) {
          this._solid(rx.at + s * (ah - 0.16), za, zb, 0, 0.14, this.markWhite, false);
        }
        if (rx.median > 0) this._medianVertical(rx, za, zb);
        else {
          this._solid(rx.at - 0.17, za, zb, 0, 0.1, this.markYellow);
          this._solid(rx.at + 0.17, za, zb, 0, 0.1, this.markYellow);
        }
      }
    }
    for (let j = 0; j < zs.length; j++) {
      const rz = zs[j];
      const ah = asphaltHalf(rz);
      for (let i = 0; i < xs.length - 1; i++) {
        const xa = xs[i].at + asphaltHalf(xs[i]);
        const xb = xs[i + 1].at - asphaltHalf(xs[i + 1]);
        if (xb - xa < 8) continue;
        this._dashesHorizontal(rz.at, xa, xb, rz);
        for (const s of [-1, 1]) {
          this._solid2(xa, xb, rz.at + s * (ah - 0.16), 0.14, this.markWhite);
        }
        if (rz.median > 0) this._medianHorizontal(rz, xa, xb);
        else {
          this._solid2(xa, xb, rz.at - 0.17, 0.1, this.markYellow);
          this._solid2(xa, xb, rz.at + 0.17, 0.1, this.markYellow);
        }
      }
    }

    // crosswalks + stop lines
    for (const it of this.intersections) {
      this._crosswalks(it);
    }

    // traffic graph edges
    for (let i = 0; i < xs.length; i++) {
      for (let j = 0; j < zs.length - 1; j++) {
        const a = { x: xs[i].at, z: zs[j].at, ix: i, iz: j };
        const b = { x: xs[i].at, z: zs[j + 1].at, ix: i, iz: j + 1 };
        this._addEdgePair(a, b, "z", xs[i]);
      }
    }
    for (let j = 0; j < zs.length; j++) {
      for (let i = 0; i < xs.length - 1; i++) {
        const a = { x: xs[i].at, z: zs[j].at, ix: i, iz: j };
        const b = { x: xs[i + 1].at, z: zs[j].at, ix: i + 1, iz: j };
        this._addEdgePair(a, b, "x", zs[j]);
      }
    }
  }

  _solid(x, z0, z1, y, w, batch, yAxis = false) {
    const g = new THREE.PlaneGeometry(w, z1 - z0);
    g.rotateX(-Math.PI / 2);
    g.translate(x, 0.018 + y, (z0 + z1) / 2);
    batch.add(g);
  }
  _solid2(x0, x1, z, w, batch) {
    const g = new THREE.PlaneGeometry(x1 - x0, w);
    g.rotateX(-Math.PI / 2);
    g.translate((x0 + x1) / 2, 0.018, z);
    batch.add(g);
  }
  _dashesVertical(x, z0, z1, road) {
    const ah = asphaltHalf(road);
    const inner = road.median / 2;
    const step = 9;
    for (let z = z0 + 2; z < z1 - 2; z += step) {
      const len = 3.2;
      for (const s of [-1, 1]) {
        for (let lane = 1; lane < road.lanes; lane++) {
          const off = inner + lane * LANE_W;
          const g = new THREE.PlaneGeometry(0.14, len);
          g.rotateX(-Math.PI / 2);
          g.translate(x + s * off, 0.02, z + len / 2);
          this.markWhite.add(g);
        }
      }
    }
  }
  _dashesHorizontal(z, x0, x1, road) {
    const inner = road.median / 2;
    const step = 9;
    for (let x = x0 + 2; x < x1 - 2; x += step) {
      const len = 3.2;
      for (const s of [-1, 1]) {
        for (let lane = 1; lane < road.lanes; lane++) {
          const off = inner + lane * LANE_W;
          const g = new THREE.PlaneGeometry(len, 0.14);
          g.rotateX(-Math.PI / 2);
          g.translate(x + len / 2, 0.02, z + s * off);
          this.markWhite.add(g);
        }
      }
    }
  }

  _medianVertical(road, z0, z1) {
    const w = road.median;
    const mw = Math.max(0.9, w - 1.4);
    const g = boxAt(w, 0.2, z1 - z0, road.at, 0.1, (z0 + z1) / 2);
    this.platformBatch.add(g);
    // hedge
    const h = boxAt(mw, 0.55, z1 - z0 - 2, road.at, 0.38, (z0 + z1) / 2);
    applyColor(h, 0x2f5426);
    this.propBatch.add(h);
    if (road.treeMedian) {
      for (let z = z0 + 8; z < z1 - 8; z += 16) this._addTree(road.at, z, 0.85);
    } else if (w >= 5) {
      for (let z = z0 + 12; z < z1 - 12; z += 22) this._addTree(road.at, z, 0.8);
    }
  }
  _medianHorizontal(road, x0, x1) {
    const w = road.median;
    const mw = Math.max(0.9, w - 1.4);
    const g = boxAt(x1 - x0, 0.2, w, (x0 + x1) / 2, 0.1, road.at);
    this.platformBatch.add(g);
    const h = boxAt(x1 - x0 - 2, 0.55, mw, (x0 + x1) / 2, 0.38, road.at);
    applyColor(h, 0x2f5426);
    this.propBatch.add(h);
    if (road.treeMedian) {
      for (let x = x0 + 8; x < x1 - 8; x += 16) this._addTree(x, road.at, 0.85);
    } else if (w >= 5) {
      for (let x = x0 + 12; x < x1 - 12; x += 22) this._addTree(x, road.at, 0.8);
    }
  }

  _crosswalks(it) {
    const { x, z, hx, hz } = it;
    const barW = 0.52, gap = 0.5, depth = 3.4;
    // north / south cross the vertical road
    for (const s of [-1, 1]) {
      const cz = z + s * (hz + 2.2);
      const span = hx * 2 - 1.0;
      const n = Math.floor(span / (barW + gap));
      for (let k = 0; k < n; k++) {
        const bx = x - span / 2 + k * (barW + gap) + barW / 2;
        const g = new THREE.PlaneGeometry(barW, depth);
        g.rotateX(-Math.PI / 2);
        g.translate(bx, 0.024, cz);
        this.markWhite.add(g);
      }
    }
    // east / west cross the horizontal road
    for (const s of [-1, 1]) {
      const cx = x + s * (hx + 2.2);
      const span = hz * 2 - 1.0;
      const n = Math.floor(span / (barW + gap));
      for (let k = 0; k < n; k++) {
        const bz = z - span / 2 + k * (barW + gap) + barW / 2;
        const g = new THREE.PlaneGeometry(depth, barW);
        g.rotateX(-Math.PI / 2);
        g.translate(cx, 0.024, bz);
        this.markWhite.add(g);
      }
    }
    // stop lines
    this._solid2(x - hx + 0.6, x - 0.6, z - hz - 4.4, 0.4, this.markWhite);
    this._solid2(x + 0.6, x + hx - 0.6, z + hz + 4.4, 0.4, this.markWhite);
  }

  _addEdgePair(a, b, axis, road) {
    const mk = (from, to, dir) => {
      const e = {
        id: `${from.x},${from.z}->${to.x},${to.z}`,
        from, to, axis, dir, road,
        length: Math.hypot(to.x - from.x, to.z - from.z),
        laneCount: road.lanes,
        median: road.median,
      };
      this.edges.push(e);
      const k = `${from.x},${from.z}`;
      let arr = this.outgoing.get(k);
      if (!arr) { arr = []; this.outgoing.set(k, arr); }
      arr.push(e);
    };
    mk(a, b, 1);
    mk(b, a, -1);
  }

  /* ---------------- blocks / buildings ---------------- */
  async _buildBlocksChunked() {
    const xs = this.roadsX, zs = this.roadsZ;
    const R_BY_TYPE = { taipei101: 42, tower: 28, cks: 68, station: 74, temple: 24, mrt: 11, gate: 12, redhouse: 13 };
    const landRects = activeLandmarks().map((l) => {
      const r = R_BY_TYPE[l.type] ?? 18;
      return { x0: l.x - r, x1: l.x + r, z0: l.z - r, z1: l.z + r };
    });
    this.landRects = landRects;
    const yieldFrame = () => new Promise((r) => setTimeout(r, 0));
    const totalBlocks = (xs.length - 1) * (zs.length - 1);
    let cnt = 0;

    for (let i = 0; i < xs.length - 1; i++) {
      for (let j = 0; j < zs.length - 1; j++) {
        const rx0 = xs[i], rx1 = xs[i + 1];
        const rz0 = zs[j], rz1 = zs[j + 1];
        const px0 = rx0.at + asphaltHalf(rx0);
        const px1 = rx1.at - asphaltHalf(rx1);
        const pz0 = rz0.at + asphaltHalf(rz0);
        const pz1 = rz1.at - asphaltHalf(rz1);
        if (px1 - px0 < 12 || pz1 - pz0 < 12) { cnt++; continue; }

        // sidewalk platform
        const w = px1 - px0, d = pz1 - pz0;
        const pg = boxAt(w, 0.16, d, (px0 + px1) / 2, 0.08, (pz0 + pz1) / 2);
        scaleUV(pg, w / 4, d / 4);
        this.platformBatch.add(pg);

        const bx0 = rx0.at + corridorHalf(rx0);
        const bx1 = rx1.at - corridorHalf(rx1);
        const bz0 = rz0.at + corridorHalf(rz0);
        const bz1 = rz1.at - corridorHalf(rz1);
        const district = districtAt((px0 + px1) / 2, (pz0 + pz1) / 2);

        if (bx1 - bx0 > 7 && bz1 - bz0 > 7) {
          this._fillBlock(bx0, bx1, bz0, bz1, district, landRects);
        }

        // pedestrian loop on the sidewalk band
        const inset = 2.0;
        const lx0 = px0 + inset, lx1 = px1 - inset, lz0 = pz0 + inset, lz1 = pz1 - inset;
        if (lx1 - lx0 > 3 && lz1 - lz0 > 3) {
          this.sidewalkLoops.push(this._rectLoop(lx0, lx1, lz0, lz1));
          this._streetProps(px0, px1, pz0, pz1, rx0, rx1, rz0, rz1);
        }
        this.blocks.push({ x0: px0, x1: px1, z0: pz0, z1: pz1 });
        cnt++;
        this.buildProgress = cnt / totalBlocks;
      }
      if (i % 1 === 0) await yieldFrame();
    }
  }

  // 距 (x, z) 最近的马路可行走点（出生点落在建筑内时的兜底吸附）
  nearestRoadPoint(x, z) {
    let best = null, bd = Infinity;
    for (const r of this.roadsX) {
      const d = Math.abs(x - r.at);
      if (d < bd) { bd = d; best = { x: r.at, z }; }
    }
    for (const r of this.roadsZ) {
      const d = Math.abs(z - r.at);
      if (d < bd) { bd = d; best = { x, z: r.at }; }
    }
    if (!best) return null;
    const p = { x: best.x, z: best.z };
    this.colliders.resolve(p, 1.2);
    return p;
  }

  _rectLoop(x0, x1, z0, z1) {    const pts = [
      { x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 },
    ];
    let total = 0;
    const segs = [];
    for (let i = 0; i < 4; i++) {
      const a = pts[i], b = pts[(i + 1) % 4];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      segs.push({ a, b, len, start: total });
      total += len;
    }
    return { pts, segs, total };
  }

  _streetProps(px0, px1, pz0, pz1, rx0, rx1, rz0, rz1) {
    // lamps & trees along the four platform edges
    const sides = [
      { axis: "x", at: pz0 + 0.9, a: px0 + 4, b: px1 - 4, rot: 0 },
      { axis: "x", at: pz1 - 0.9, a: px0 + 4, b: px1 - 4, rot: Math.PI },
      { axis: "z", at: px0 + 0.9, a: pz0 + 4, b: pz1 - 4, rot: Math.PI / 2 },
      { axis: "z", at: px1 - 0.9, a: pz0 + 4, b: pz1 - 4, rot: -Math.PI / 2 },
    ];
    for (const s of sides) {
      const len = s.b - s.a;
      if (len < 8) continue;
      // lamps every ~30m
      const nl = Math.max(1, Math.floor(len / 30));
      for (let k = 0; k < nl; k++) {
        const t = s.a + (len * (k + 0.5)) / nl;
        if (s.axis === "x") this._addLamp(t, s.at, s.rot);
        else this._addLamp(s.at, t, s.rot);
      }
      // trees every ~22m, offset inward
      if (Math.random() < 0.75) {
        const nt = Math.max(1, Math.floor(len / 24));
        for (let k = 0; k < nt; k++) {
          const t = s.a + (len * (k + 0.5)) / nt;
          if (s.axis === "x") this._addTree(t, s.at + (s.rot === 0 ? 1.4 : -1.4), 1);
          else this._addTree(s.at + (s.rot > 0 ? 1.4 : -1.4), t, 1);
        }
      }
    }
  }

  _addLamp(x, z, rot) {
    // pole
    this.propBatch.add(applyColor(cylAt(0.07, 0.09, 5.6, x, 2.8, z, 6), 0x4a4c50));
    // arm toward road
    const dx = Math.sin(rot) * 1.1, dz = Math.cos(rot) * 1.1;
    const arm = boxAt(0.1, 0.1, 1.5, x + dx, 5.55, z + dz);
    arm.rotateY(0);
    this.propBatch.add(applyColor(arm, 0x4a4c50));
    // lamp head (emissive)
    const head = new THREE.BoxGeometry(0.34, 0.14, 0.5);
    head.translate(x + Math.sin(rot) * 2.0, 5.46, z + Math.cos(rot) * 2.0);
    applyColor(head, 0xfff0c8);
    this.lampGlassBatch.add(head);
  }

  _addTree(x, z, scale = 1) {
    const h = (3.2 + Math.random() * 0.8) * scale;
    const trunk = cylAt(0.1 * scale, 0.15 * scale, h, x, h / 2 + 0.16, z, 5);
    applyColor(trunk, 0x4a3928);
    this.treeBatch.add(trunk);
    const g = new THREE.Color().setHSL(0.28 + Math.random() * 0.06, 0.42, 0.2 + Math.random() * 0.08);
    const c1 = icoAt((1.5 + Math.random() * 0.5) * scale, x, h + 0.9 * scale, z, 1, 1, 0.85, 1);
    applyColor(c1, g);
    this.treeBatch.add(c1);
    const c2 = icoAt((1.0 + Math.random() * 0.35) * scale, x + rand(-0.6, 0.6), h + 1.7 * scale, z + rand(-0.5, 0.5), 1, 1, 0.8, 1);
    applyColor(c2, g.clone().offsetHSL(0.01, 0, 0.05));
    this.treeBatch.add(c2);
  }

  _fillBlock(bx0, bx1, bz0, bz1, district, landRects) {
    const W = bx1 - bx0, D = bz1 - bz0;
    const dN = Math.min(rand(13, 18), D * 0.32);
    const dS = Math.min(rand(13, 18), D * 0.32);
    const dW = Math.min(rand(12, 17), W * 0.3);
    const dE = Math.min(rand(12, 17), W * 0.3);

    // north frontage
    this._lotsAlongX(bx0, bx1, bz0, dN, "n", district, landRects);
    // south frontage
    this._lotsAlongX(bx0, bx1, bz1 - dS, dS, "s", district, landRects);
    // west / east frontages
    this._lotsAlongZ(bz0 + dN, bz1 - dS, bx0, dW, "w", district, landRects);
    this._lotsAlongZ(bz0 + dN, bz1 - dS, bx1 - dE, dE, "e", district, landRects);

    // interior
    const cx0 = bx0 + dW, cx1 = bx1 - dE;
    const cz0 = bz0 + dN, cz1 = bz1 - dS;
    if (cx1 - cx0 > 6 && cz1 - cz0 > 6) {
      let x = cx0;
      while (x < cx1 - 4) {
        const w = Math.min(rand(8, 14), cx1 - x);
        let z = cz0;
        while (z < cz1 - 4) {
          const d = Math.min(rand(9, 15), cz1 - z);
          if (w > 4 && d > 4) this._addBuilding(x + 0.15, x + w - 0.15, z + 0.15, z + d - 0.15, null, district, landRects);
          z += d;
        }
        x += w;
      }
    }
  }

  _lotsAlongX(x0, x1, z0, depth, facing, district, landRects) {
    let x = x0;
    while (x < x1 - 5) {
      const w = Math.min(rand(8, 15), x1 - x);
      if (w > 5) {
        const zA = facing === "n" ? z0 : z0;
        this._addBuilding(x + 0.12, x + w - 0.12, zA, zA + depth, facing, district, landRects);
      }
      x += w;
    }
  }

  _lotsAlongZ(z0, z1, x0, depth, facing, district, landRects) {
    let z = z0;
    while (z < z1 - 5) {
      const d = Math.min(rand(8, 15), z1 - z);
      if (d > 5) {
        const xA = facing === "w" ? x0 : x0;
        this._addBuilding(xA, xA + depth, z + 0.12, z + d - 0.12, facing, district, landRects);
      }
      z += d;
    }
  }

  _pickFacade(district, floors, kind) {
    const idxByStyle = {
      ximending: [0, 3, 7, 8, 9, 10, 2],
      station: [3, 4, 7, 8, 1, 11],
      zhongshan: [0, 2, 5, 8, 9, 11, 1],
      wanhua: [0, 3, 7, 8, 4, 9],
      daan: [1, 2, 5, 11, 6],
      xinyi: [3, 5, 6, 11, 1],
      east: [3, 5, 6, 9, 10],
      central: [3, 4, 5, 8, 1],
      south: [0, 2, 7, 9, 10],
      river: [0, 7, 8],
    };
    const pool = idxByStyle[district.id] || [0, 1, 2, 5, 7];
    if (kind === "tower" || floors > 18) return 6;
    return choice(pool);
  }

  _addBuilding(x0, x1, z0, z1, facing, district, landRects) {
    if (x1 - x0 < 3 || z1 - z0 < 3) return;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    // exclusion zones (landmarks)
    for (const r of landRects) {
      if (x0 < r.x1 && x1 > r.x0 && z0 < r.z1 && z1 > r.z0) return;
    }

    const style = district.style || { floors: [3, 9], towers: 0.08, neon: 0.5, old: 0.5, shops: 0.85 };
    let floors;
    const nearXinyi = cx > 440 && cz > 90 && cz < 300;
    if (nearXinyi) floors = Math.random() < 0.22 ? Math.round(rand(16, 30)) : Math.round(rand(6, 14));
    else if (district.id === "ximending") floors = Math.round(rand(4, 9));
    else floors = Math.round(rand(style.floors[0], style.floors[1]));
    floors = Math.max(2, floors);

    const h = GROUND_H + (floors - 1) * FLOOR_H + rand(-0.2, 0.6);
    const variant = this._pickFacade(district, floors, null);
    const batch = this.facadeBatches[variant];
    const y0 = 0.16, y1 = y0 + h;

    batch.add(wallQuad("n", x0, x1, z0, z1, y0, y1));
    batch.add(wallQuad("s", x0, x1, z0, z1, y0, y1));
    batch.add(wallQuad("e", x0, x1, z0, z1, y0, y1));
    batch.add(wallQuad("w", x0, x1, z0, z1, y0, y1));

    // roof
    this.roofBatch.add(roofQuad(x0, x1, z0, z1, y1));
    // parapet
    const pc = 0xb5aea1;
    this.propBatch.add(applyColor(boxAt(x1 - x0 + 0.2, 0.5, 0.25, cx, y1 + 0.25, z0), pc));
    this.propBatch.add(applyColor(boxAt(x1 - x0 + 0.2, 0.5, 0.25, cx, y1 + 0.25, z1), pc));
    this.propBatch.add(applyColor(boxAt(0.25, 0.5, z1 - z0, x0, y1 + 0.25, cz), pc));
    this.propBatch.add(applyColor(boxAt(0.25, 0.5, z1 - z0, x1, y1 + 0.25, cz), pc));

    // roof clutter
    if (Math.random() < 0.55) {
      const tw = rand(0.9, 1.4);
      const tx = rand(x0 + 1.5, x1 - 1.5), tz = rand(z0 + 1.5, z1 - 1.5);
      this.propBatch.add(applyColor(cylAt(tw / 2, tw / 2, 1.2, tx, y1 + 0.85, tz, 8), 0x9aa0a4));
      this.propBatch.add(applyColor(boxAt(tw * 0.9, 0.12, tw * 0.9, tx, y1 + 1.5, tz), 0x7c8286));
    }
    if (Math.random() < 0.6) {
      const ax = rand(x0 + 1, x1 - 1), az = rand(z0 + 1, z1 - 1);
      this.propBatch.add(applyColor(boxAt(0.8, 0.6, 0.6, ax, y1 + 0.3, az), 0x8f8f8a));
    }
    if (floors > 7 && Math.random() < 0.35) {
      // stair penthouse
      this.propBatch.add(applyColor(boxAt(2.4, 2.0, 2.0, cx + rand(-1, 1), y1 + 1.0, cz + rand(-1, 1)), 0xa8a296));
    }

    // storefront + signs on street-facing side
    if (facing) {
      this._addStorefront(x0, x1, z0, z1, facing, district, variant);
    }

    this.colliders.add(x0, z0, x1, z1);
  }

  _addStorefront(x0, x1, z0, z1, facing, district, variant) {
    const isNS = facing === "n" || facing === "s";
    const width = isNS ? x1 - x0 : z1 - z0;
    if (width < 3.5) return;
    const sf = Math.floor(Math.random() * this.storefronts.length);
    const sfBatch = this.storefrontBatches[sf];
    const panelW = width - 0.5;
    const H = 3.6;
    const yC = 0.2 + H / 2;
    let g;
    if (facing === "n") {
      g = new THREE.PlaneGeometry(panelW, H);
      scaleUV(g, panelW / 6, 1);
      g.rotateY(Math.PI);
      g.translate((x0 + x1) / 2, yC, z0 - 0.06);
    } else if (facing === "s") {
      g = new THREE.PlaneGeometry(panelW, H);
      scaleUV(g, panelW / 6, 1);
      g.translate((x0 + x1) / 2, yC, z1 + 0.06);
    } else if (facing === "w") {
      g = new THREE.PlaneGeometry(panelW, H);
      scaleUV(g, panelW / 6, 1);
      g.rotateY(-Math.PI / 2);
      g.translate(x0 - 0.06, yC, (z0 + z1) / 2);
    } else {
      g = new THREE.PlaneGeometry(panelW, H);
      scaleUV(g, panelW / 6, 1);
      g.rotateY(Math.PI / 2);
      g.translate(x1 + 0.06, yC, (z0 + z1) / 2);
    }
    sfBatch.add(g);

    // awning
    const aw = Math.min(width - 1.2, 6.5);
    const acol = choice([0xd94a4a, 0x2f7a4a, 0x2a5a9a, 0xd98a2a, 0xffffff, 0xd94a8a]);
    let ag;
    const yA = 3.85;
    if (facing === "n") ag = boxAt(aw, 0.08, 1.25, (x0 + x1) / 2, yA, z0 - 0.65);
    else if (facing === "s") ag = boxAt(aw, 0.08, 1.25, (x0 + x1) / 2, yA, z1 + 0.65);
    else if (facing === "w") ag = boxAt(1.25, 0.08, aw, x0 - 0.65, yA, (z0 + z1) / 2);
    else ag = boxAt(1.25, 0.08, aw, x1 + 0.65, yA, (z0 + z1) / 2);
    this.awningBatch.add(applyColor(ag, acol));

    // horizontal sign above awning
    const sw = Math.min(width - 0.8, 7.5);
    const sh = 1.05;
    const sy = 4.95;
    const hIdx = Math.floor(Math.random() * 64);
    const r = signTileRect(hIdx);
    let sg;
    // NOTE: keep sign panel clearly in front of its backing box (front face at ±0.10)
    // to avoid z-fighting flicker / black lines.
    if (facing === "n") sg = signQuad(sw, sh, (x0 + x1) / 2, sy, z0 - 0.14, Math.PI, r.u0, r.v0, r.u1, r.v1);
    else if (facing === "s") sg = signQuad(sw, sh, (x0 + x1) / 2, sy, z1 + 0.14, 0, r.u0, r.v0, r.u1, r.v1);
    else if (facing === "w") sg = signQuad(sw, sh, x0 - 0.14, sy, (z0 + z1) / 2, -Math.PI / 2, r.u0, r.v0, r.u1, r.v1);
    else sg = signQuad(sw, sh, x1 + 0.14, sy, (z0 + z1) / 2, Math.PI / 2, r.u0, r.v0, r.u1, r.v1);
    this.signBatch.add(sg);
    // sign backing
    const bw = sw + 0.12;
    let bg;
    if (facing === "n") bg = boxAt(bw, sh + 0.12, 0.16, (x0 + x1) / 2, sy, z0 - 0.02);
    else if (facing === "s") bg = boxAt(bw, sh + 0.12, 0.16, (x0 + x1) / 2, sy, z1 + 0.02);
    else if (facing === "w") bg = boxAt(0.16, sh + 0.12, bw, x0 - 0.02, sy, (z0 + z1) / 2);
    else bg = boxAt(0.16, sh + 0.12, bw, x1 + 0.02, sy, (z0 + z1) / 2);
    this.propBatch.add(applyColor(bg, 0x2a2a2a));

    // vertical hanging sign
    if (Math.random() < 0.42) {
      const vIdx = 64 + Math.floor(Math.random() * 64);
      const vr = signTileRect(vIdx);
      const vw = 1.05, vh = 3.2;
      const vy = 6.6;
      const off = 0.72;
      let vg;
      if (facing === "n") vg = signQuad(vw, vh, x0 + 0.85, vy, z0 - off, Math.PI / 2, vr.u0, vr.v0, vr.u1, vr.v1);
      else if (facing === "s") vg = signQuad(vw, vh, x1 - 0.85, vy, z1 + off, Math.PI / 2, vr.u0, vr.v0, vr.u1, vr.v1);
      else if (facing === "w") vg = signQuad(vw, vh, x0 - off, vy, z1 - 0.85, 0, vr.u0, vr.v0, vr.u1, vr.v1);
      else vg = signQuad(vw, vh, x1 + off, vy, z0 + 0.85, 0, vr.u0, vr.v0, vr.u1, vr.v1);
      this.signBatch.add(vg);
    }
  }

  /* ---------------- parked scooters ---------------- */
  _buildParkedScooters() {
    const spots = [];
    const target = 760;
    const loops = this.sidewalkLoops;
    let guard = 0;
    while (spots.length < target && guard++ < 8000) {
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

    this.parkedMeshes = [];
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
      meshes[k].instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      meshes[k].castShadow = k === "body";
      meshes[k].receiveShadow = true;
      meshes[k].count = spots.length;
      this.group.add(meshes[k]);
      this.parkedMeshes.push(meshes[k]);
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
    this.parked = spots;
  }

  /* ---------------- traffic heads ---------------- */
  _buildTrafficHeads() {
    const heads = [];
    for (const it of this.intersections) {
      const xs = this.roadsX[it.ix], zs = this.roadsZ[it.iz];
      const hx = it.hx, hz = it.hz;
      const positions = [
        { x: it.x - hx - 1.3, z: it.z + hz + 1.3, axis: "z" },
        { x: it.x + hx + 1.3, z: it.z - hz - 1.3, axis: "z" },
        { x: it.x - hx - 1.3, z: it.z - hz - 1.3, axis: "x" },
        { x: it.x + hx + 1.3, z: it.z + hz + 1.3, axis: "x" },
      ];
      for (const p of positions) {
        // pole
        this.propBatch.add(applyColor(cylAt(0.06, 0.08, 3.9, p.x, 1.95 + 0.16, p.z, 6), 0x3c3e42));
        heads.push(p);
      }
    }
    this.trafficHeads = heads;
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
    this.group.add(inst);
    this.trafficInst = inst;
  }

  /* ---------------- finalize ---------------- */
  _finalize() {
    const facadeMats = this.facades.map((f) => new THREE.MeshStandardMaterial({
      map: f.map,
      emissiveMap: f.emissive,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0.0,
      roughness: 0.86,
      metalness: 0.02,
    }));
    this.facadeMaterials = facadeMats;
    this.facadeBatches.forEach((b, i) => {
      for (const mesh of b.build(facadeMats[i], { castShadow: true, receiveShadow: true })) this.group.add(mesh);
    });

    const sfMats = this.storefronts.map((s) => new THREE.MeshStandardMaterial({
      map: s.map,
      emissiveMap: s.emissive,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0.2,
      roughness: 0.55,
      metalness: 0.05,
    }));
    this.storefrontMaterials = sfMats;
    this.storefrontBatches.forEach((b, i) => {
      for (const mesh of b.build(sfMats[i], { castShadow: false, receiveShadow: true })) this.group.add(mesh);
    });

    const roofMat = new THREE.MeshStandardMaterial({ map: makeRoofTexture(), color: 0x9a968e, roughness: 0.92 });
    roofMat.map.repeat.set(1, 1);
    this.materials.roof = roofMat;
    for (const roof of this.roofBatch.build(roofMat, { receiveShadow: true })) this.group.add(roof);

    const signMat = new THREE.MeshStandardMaterial({
      map: this.signAtlas,
      emissiveMap: this.signAtlas,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0.5,
      roughness: 0.6,
      metalness: 0.0,
      side: THREE.DoubleSide,
      transparent: false,
      // pull signs slightly toward the camera in depth so they never z-fight
      // with the backing box or wall they sit on
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.signMaterial = signMat;
    for (const signs of this.signBatch.build(signMat, { castShadow: false, receiveShadow: false })) this.group.add(signs);

    const awnMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.0 });
    for (const awn of this.awningBatch.build(awnMat, { castShadow: true, receiveShadow: true })) this.group.add(awn);

    const propMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.05 });
    for (const props of this.propBatch.build(propMat, { castShadow: true, receiveShadow: true })) this.group.add(props);

    const treeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.0 });
    for (const trees of this.treeBatch.build(treeMat, { castShadow: true, receiveShadow: true })) this.group.add(trees);

    const platMat = new THREE.MeshStandardMaterial({ map: makeSidewalkTexture(), color: 0xffffff, roughness: 0.92, metalness: 0.0 });
    this.materials.platform = platMat;
    for (const plat of this.platformBatch.build(platMat, { castShadow: false, receiveShadow: true })) this.group.add(plat);

    const whiteMat = new THREE.MeshBasicMaterial({ color: 0xe8e8e2, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    for (const white of this.markWhite.build(whiteMat, { castShadow: false, receiveShadow: false })) this.group.add(white);
    const yellowMat = new THREE.MeshBasicMaterial({ color: 0xd8a524, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    for (const yellow of this.markYellow.build(yellowMat, { castShadow: false, receiveShadow: false })) this.group.add(yellow);

    this.lampMat = new THREE.MeshBasicMaterial({ color: 0x6a6458, toneMapped: false });
    for (const lamp of this.lampGlassBatch.build(this.lampMat, { castShadow: false, receiveShadow: false })) this.group.add(lamp);
  }

  nearestEdge(x, z) {
    let best = null, bd = Infinity;
    for (const e of this.edges) {
      const dx = e.to.x - e.from.x, dz = e.to.z - e.from.z;
      const l2 = dx * dx + dz * dz || 1;
      let t = ((x - e.from.x) * dx + (z - e.from.z) * dz) / l2;
      t = Math.max(0, Math.min(1, t));
      const px = e.from.x + dx * t, pz = e.from.z + dz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < bd) { bd = d; best = { edge: e, t, d }; }
    }
    if (!best) return null;
    const e = best.edge;
    let off, lane;
    if (e.axis === "z") {
      off = x - e.from.x;
      lane = Math.max(0, Math.min(e.laneCount - 1, Math.round((Math.abs(off) - e.median / 2 - 1.7) / 3.4)));
    } else {
      off = z - e.from.z;
      lane = Math.max(0, Math.min(e.laneCount - 1, Math.round((Math.abs(off) - e.median / 2 - 1.7) / 3.4)));
    }
    best.lane = lane;
    return best;
  }

  update(dt, time, night) {
    // emissive windows
    for (const m of this.facadeMaterials) m.emissiveIntensity = 0.02 + night * 1.25;
    for (const m of this.storefrontMaterials) m.emissiveIntensity = 0.12 + night * 1.35;
    if (this.signMaterial) this.signMaterial.emissiveIntensity = 0.45 + night * 1.45;
    if (this.lampMat) {
      const on = night > 0.34;
      this.lampMat.color.setHex(on ? 0xfff0c8 : 0x6a6458);
    }

    // traffic lights: 16s cycle, NS green then EW green
    const cyc = (time % 16 + 16) % 16;
    const nsGreen = cyc < 7;
    const nsYellow = cyc >= 7 && cyc < 8;
    const ewGreen = cyc >= 8.5 && cyc < 15;
    const ewYellow = cyc >= 15 && cyc < 16;
    this.lightState = { nsGreen, nsYellow, ewGreen, ewYellow, ns: nsGreen, ew: ewGreen };
    if (this.trafficInst && this.trafficHeads) {
      const col = new THREE.Color();
      for (let i = 0; i < this.trafficHeads.length; i++) {
        const h = this.trafficHeads[i];
        let c = 0x3a1010;
        if (h.axis === "z") {
          if (nsGreen) c = 0x22ff66; else if (nsYellow) c = 0xffcc33; else c = 0xff2a2a;
        } else {
          if (ewGreen) c = 0x22ff66; else if (ewYellow) c = 0xffcc33; else c = 0xff2a2a;
        }
        col.setHex(c);
        this.trafficInst.setColorAt(i, col);
      }
      if (this.trafficInst.instanceColor) this.trafficInst.instanceColor.needsUpdate = true;
    }
  }
}


