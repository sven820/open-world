import * as THREE from "three";
import {
  asphaltHalf, corridorHalf, LANE_W, districtAt,
  setMapData, activeRoadsX, activeRoadsZ, activeLandmarks,
  EXT_STEP_X, EXT_STEP_Z, extRoadSpec, genConfig,
} from "../data/cityData.js";
import {
  Batch, ChunkedBatch, applyColor, scaleUV, boxAt, wallQuad, roofQuad, planeAt, signQuad, cylAt, icoAt,
} from "./batch.js";
import {
  signTileRect,
  makeSidewalkTexture, makeAsphaltTexture, makeRoofTexture, makeTileStripTexture,
  ASPHALT_TILE,
} from "./textures.js";
import { getFacadeMaterials, getStorefrontMaterials, getSignMaterial } from "./materials.js";
import { buildCustomMap, worldBounds, pointInPoly, footprintAABB } from "./customMap.js";
import { getRenderSettings, onRenderSettingsChange } from "../config/renderSettings.js";
import {
  computeTraceJunctions, buildTraceCrosswalks,
} from "./cityTrace.js";
import {
  inTraceCorridor, streetProps, decorateOpenSpace,
} from "./cityProps.js";
import {
  buildParkedScooters, buildTrafficHeads,
} from "./cityStreetObjects.js";
import { ColliderGrid } from "./colliderGrid.js";

const FLOOR_H = 3.15;
const GROUND_H = 4.0;
// 街廓内部巷道（巷弄）净宽与切巷后允许的最小地块宽度。
// 巷道直通两侧人行道，是密集街廓里真正可以走进去的次级道路。
const ALLEY_W = 7;
const ALLEY_CELL = 16;

function rand(a, b) { return a + Math.random() * (b - a); }
function choice(arr) { return arr[(Math.random() * arr.length) | 0]; }

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
    // 用户地图：世界边界 = 路网范围 ∪ 描边内容 ∪ 地图范围（customMap.worldBounds，
    // 各留 120 缓冲）——延伸街道因此能铺满整张网格地图
    this.bounds = data
      ? worldBounds(data)
      : { minX: -1072, maxX: 1462, minZ: -602, maxZ: 582 };
    this.data = data || null;   // 供 HUD 读取描边/范围数据
    // 程序化生成参数（地图编辑器可调）：楼间距 / 绿植 / 路灯 倍率
    this.gen = genConfig(data);
    this.custom = null;         // buildCustomMap 结果（描边内容渲染数据）
    this.buildProgress = 0;     // 程序化城市分块生成进度（0~1，main.js 加载条轮询）
    // 3D 描边道路走廊预计算：程序化建筑避让 + 玩家脚底高度（路面 0.18 / 人行道 0.24）
    this.traceCorridors = [];
    const roadDefs = (data && data.features && data.features.roads) || [];
    for (let ri = 0; ri < roadDefs.length; ri++) {
      const r = roadDefs[ri];
      const ptsRaw = r.points || []; // 原始 [x,z] 数组（pointInPoly 需要）
      if (ptsRaw.length < 2) continue;
      const pts = ptsRaw.map(([x, z]) => ({ x, z }));
      const roadHalf = (r.width || 12) / 2;
      const sw = Math.min(Math.max(r.sidewalk ?? 3, 0), 12);
      const segs = [], samples = [];
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1];
        segs.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z });
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        const n = Math.max(1, Math.ceil(len / 3)); // ~3m 采样，供建筑矩形快速相交测试
        for (let k = 0; k < n; k++) samples.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
      }
      if (r.closed && pts.length > 2) {
        // 闭合面路补采样最后一条封边，否则封边一侧的走廊避让（建筑 / 街道家具）会漏
        const a = pts[pts.length - 1], b = pts[0];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        const n = Math.max(1, Math.ceil(len / 3));
        for (let k = 0; k < n; k++) samples.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
      }
      samples.push(pts[pts.length - 1]);
      this.traceCorridors.push({
        index: ri,   // data.features.roads 中的原始下标（customMap 侧按同一顺序遍历）
        pts: ptsRaw, closed: !!r.closed, segs, samples,
        roadHalf, edgeHalf: roadHalf + sw, keepHalf: roadHalf + sw + 1.5,
      });
    }
    // 拼接路块（3D 编辑器「路块拼接」）并入同一走廊体系：程序化建筑/绿植/街具
    // 避让拼接路（_rectHitsCorridor / inTraceCorridor），程序化路网与其求交得
    // 路口（斑马线 / 灯杆，见 computeTraceJunctions 的闭合面路分支）。
    // 每块 = 一个闭合矩形走廊（四角平口矩形，miter 端头外扩量忽略 —— 走廊本就
    // 外扩人行道+余量）；index 加 1e6 偏移，避免与 features.roads 的下标撞号
    // （customMap 按 roadIndex 给描边路开断口，拼接路是整块贴图不需要断口）
    const tileDefs = (data && data.features && data.features.roadTiles) || [];
    for (let ri = 0; ri < tileDefs.length; ri++) {
      const t = tileDefs[ri];
      const hl = (t.len || 3) / 2, hw = (t.w || 2) / 2;
      const s = Math.sin(t.rot || 0), c = Math.cos(t.rot || 0);
      // 本地 (lx, lz) → 世界：world = O + n·lx + f·lz（n=(cosθ,−sinθ) 侧向，f=(sinθ,cosθ) 前进向）
      const pts = [
        [t.x + hw * c + hl * s, t.z - hw * s + hl * c],
        [t.x - hw * c + hl * s, t.z + hw * s + hl * c],
        [t.x - hw * c - hl * s, t.z + hw * s - hl * c],
        [t.x + hw * c - hl * s, t.z - hw * s - hl * c],
      ];
      // 沿前进向 ~6m 采样：keepHalf 圆盘半径 ≥ 半宽+3.5m，6m 间距覆盖无缝
      const samples = [];
      const n = Math.max(1, Math.ceil((hl * 2) / 6));
      for (let k = 0; k <= n; k++) {
        const lz = -hl + (2 * hl * k) / n;
        samples.push({ x: t.x + lz * s, z: t.z + lz * c });
      }
      this.traceCorridors.push({
        index: 1e6 + ri, tile: t, pts, closed: true,
        segs: pts.map((p, i) => {
          const q = pts[(i + 1) % 4];
          return { ax: p[0], az: p[1], bx: q[0], bz: q[1] };
        }),
        samples,
        roadHalf: hw, edgeHalf: hw + 2, keepHalf: hw + 3.5,
      });
    }
    this.spawnPoint = null;     // 出生点：编辑器设置的 spawn 优先，未设置时用描边内容包围盒中心

    // 3D 描边建筑排除区：程序化建筑/绿植避让手绘建筑 footprint（含 2m 余量），
    // 防止自动生成的楼直接穿进/盖住用户描边放置的建筑
    this.traceBuildingRects = [];
    for (const o of (data && data.objects) || []) {
      if (o.type !== "building") continue;
      const box = footprintAABB(o);
      if (!box) continue;
      const M = 2;
      this.traceBuildingRects.push({ x0: box.minX - M, x1: box.maxX + M, z0: box.minZ - M, z1: box.maxZ + M });
    }

    // ---- 分块渲染调度（按需渲染）----
    // 几何在建城时一次性烘焙到世界坐标并合并成"每 220m 一格 × 每材质一个 Mesh"，
    // 这里给每个 Mesh 记下世界包围球，运行期按玩家距离开关 visible：
    // 看不见的格子直接不进渲染列表，也不进阴影 pass（draw call / 顶点全跳过）。
    this.chunks = [];
    this.visibleChunks = 0;
    this._streamCenter = null;
    this._streamDistance = -1;
    this._nightApplied = -1;
    this._lampOn = null;
    this._lightKey = "";
    this._unsubSettings = onRenderSettingsChange(() => {
      // 视距变化要立即重算，不能等玩家走动
      this._streamCenter = null;
    });

    this.materials = {};
    this.facades = getFacadeMaterials();       // 标准材料库的外墙材质（全局共享实例）
    this.storefronts = getStorefrontMaterials(); // 店面材质（同库共享）
    this.signMaterial = getSignMaterial();     // 招牌图集材质（同库共享）

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
    // 描边路 × 程序化横纵路的路口：斑马线必须赶在 _finalize 封批之前加进 markWhite
    this.traceJunctions = this._computeTraceJunctions();
    this._buildTraceCrosswalks();
    await yieldFrame();
    // 程序化城市按地图开关生成（默认台北始终生成；用户地图需在编辑器勾选）。
    // 未勾选时只保留手工路网、描边道路与 3D 编辑器放置的内容。
    if (this.gen.procedural) {
      await this._buildBlocksChunked();
      this._buildParkedScooters();
      this.buildProgress = 1;
    }
    await yieldFrame();
    this._buildTrafficHeads();
    // 3D 编辑器描边内容（道路/河流/建筑/树/路灯）渲染 + 碰撞注册
    const custom = buildCustomMap(this.data, this.colliders, this.traceJunctions);
    if (custom) {
      this.group.add(custom.group);
      this.custom = custom;
      // 出生点优先用编辑器设置的 spawn（含朝向 heading）；
      // 仅当未设置/坐标无效时，才退回描边内容包围盒中心（旧行为）
      const sp = this.data && this.data.spawn;
      this.spawnPoint = sp && Number.isFinite(sp.x) && Number.isFinite(sp.z) ? sp : custom.center;
    }
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
    outer.position.y = -0.5; // 与路面保持大间距，避免高空俯瞰时深度冲突闪块
    outer.receiveShadow = true;
    this.group.add(outer);

    const b = this.bounds;
    const w = b.maxX - b.minX + 60;
    const d = b.maxZ - b.minZ + 60;
    // 世界米制 planar uv（与描边路面 customMap.planarUV 同式）：横纵路地面与描边路
    // 共用同一张贴图同一世界相位，交接处颗粒/明暗斑/轮迹无缝衔接（此前 repeat 平铺
    // 与 planarUV 相位错开且 V 轴镜像，路缘两侧纹理对不上）
    const geo = new THREE.PlaneGeometry(w, d)
      .rotateX(-Math.PI / 2)
      .translate((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);
    const gpos = geo.attributes.position;
    const guv = new Float32Array(gpos.count * 2);
    for (let i = 0; i < gpos.count; i++) {
      guv[i * 2] = gpos.getX(i) / ASPHALT_TILE;
      guv[i * 2 + 1] = gpos.getZ(i) / ASPHALT_TILE;
    }
    geo.setAttribute("uv", new THREE.BufferAttribute(guv, 2));
    const mat = new THREE.MeshStandardMaterial({ map: makeAsphaltTexture(), color: 0xffffff, roughness: 0.95, metalness: 0.0 });
    const road = new THREE.Mesh(geo, mat);
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
    // 用户地图：延伸街默认不生成，地图数据 extRoads 勾选后才生成；默认台北不受限。
    // 拼接路：程序化城市开启时只补「边界路」—— 拼接路越出已有路网的外侧，每侧
    // 至多补一条边界大道（+120m 余量），横纵路因此延伸到与拼接路相交、沿线街区
    // 能生成；不按固定间距铺满网格（避免产生大片用户没画的街道）。
    // 显式勾选「程序化延伸街道」仍按固定间距铺满世界边界（既有行为）。
    const GX = EXT_STEP_X, GZ = EXT_STEP_Z, b = this.bounds;
    let n = 0;
    // 延伸路网分级：每 3 条升级为林荫大道，其余为街巷（规格见 extRoadSpec）。
    // 外围因此有主干路 / 次干路的层级，而不是一整片等宽窄巷 —— 从高处也能读出城市骨架。
    const ext = (at, step) => ({ id: "ext" + (n++), at, ...extRoadSpec(at, step) });
    if ((!this.data || !!this.data.extRoads) && xs.length && zs.length) {
      // guard：边界异常（Infinity/NaN 被污染）时比较恒真会死循环，单方向封顶 600 条
      let guard = 600;
      while (guard-- > 0 && xs[xs.length - 1].at < b.maxX) xs.push(ext(xs[xs.length - 1].at + GX, GX));
      guard = 600;
      while (guard-- > 0 && xs[0].at > b.minX) xs.unshift(ext(xs[0].at - GX, GX));
      guard = 600;
      while (guard-- > 0 && zs[zs.length - 1].at < b.maxZ) zs.push(ext(zs[zs.length - 1].at + GZ, GZ));
      guard = 600;
      while (guard-- > 0 && zs[0].at > b.minZ) zs.unshift(ext(zs[0].at - GZ, GZ));
    } else if (this.data && this.gen.procedural && xs.length && zs.length) {
      // 拼接路参与街区划分：整条拼接路完全越出某一侧路网时，贴其近端边缘补一条
      // 「虚拟边界路」（virtual: true）—— 不画标线 / 不产生路口 / 不进交通图，
      // 仅作为街区划分的外边界，让路网与拼接路之间的相交区域生成建筑（建筑由
      // 拼接路走廊自动避让）；横纵路的标线段自然延伸到拼接路边。
      const tiles = this.data.features.roadTiles || [];
      if (tiles.length) {
        let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
        for (const t of tiles) {
          const s = Math.sin(t.rot || 0), c = Math.cos(t.rot || 0);
          const ex = Math.abs(c) * ((t.w || 2) / 2) + Math.abs(s) * ((t.len || 3) / 2) + 3; // +3: 端头斜切外扩余量
          const ez = Math.abs(s) * ((t.w || 2) / 2) + Math.abs(c) * ((t.len || 3) / 2) + 3;
          if (t.x - ex < mnx) mnx = t.x - ex;
          if (t.x + ex > mxx) mxx = t.x + ex;
          if (t.z - ez < mnz) mnz = t.z - ez;
          if (t.z + ez > mxz) mxz = t.z + ez;
        }
        const vrt = (at, step) => ({ id: "vbk" + (n++), at, virtual: true, ...extRoadSpec(at, step) });
        const M = 2; // 虚拟边界贴拼接路近端边缘，建筑与路缘的间距由走廊避让负责
        // 仅当整条拼接路都在该侧路网之外时才补（跨界/在路网内部时既有街区 + 走廊避让已覆盖）
        if (mnx > xs[xs.length - 1].at) xs.push(vrt(mnx - M, GX));
        else if (mxx < xs[0].at) xs.unshift(vrt(mxx + M, GX));
        if (mnz > zs[zs.length - 1].at) zs.push(vrt(mnz - M, GZ));
        else if (mxz < zs[0].at) zs.unshift(vrt(mxz + M, GZ));
      }
    }

    this.roadsX = xs; this.roadsZ = zs;

    // intersections（虚拟边界路不产生路口/斑马线）
    xs.forEach((rx, ix) => zs.forEach((rz, iz) => {
      if (rx.virtual || rz.virtual) return;
      this.intersections.push({ ix, iz, x: rx.at, z: rz.at, hx: asphaltHalf(rx), hz: asphaltHalf(rz) });
    }));

    // markings per segment
    for (let i = 0; i < xs.length; i++) {
      const rx = xs[i];
      if (rx.virtual) continue; // 虚拟边界路不可见：不画标线
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
      if (rz.virtual) continue; // 虚拟边界路不可见：不画标线
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

    // traffic graph edges（虚拟边界路不进交通图：车流不会开上不可见的路）
    for (let i = 0; i < xs.length; i++) {
      if (xs[i].virtual) continue;
      for (let j = 0; j < zs.length - 1; j++) {
        if (zs[j].virtual || zs[j + 1].virtual) continue;
        const a = { x: xs[i].at, z: zs[j].at, ix: i, iz: j };
        const b = { x: xs[i].at, z: zs[j + 1].at, ix: i, iz: j + 1 };
        this._addEdgePair(a, b, "z", xs[i]);
      }
    }
    for (let j = 0; j < zs.length; j++) {
      if (zs[j].virtual) continue;
      for (let i = 0; i < xs.length - 1; i++) {
        if (xs[i].virtual || xs[i + 1].virtual) continue;
        const a = { x: xs[i].at, z: zs[j].at, ix: i, iz: j };
        const b = { x: xs[i + 1].at, z: zs[j].at, ix: i + 1, iz: j };
        this._addEdgePair(a, b, "x", zs[j]);
      }
    }
  }

  /* ---------------- trace-road junctions ---------------- */
  // 描边路（编辑器手绘折线）× 程序化横纵路：求交点（实现见 world/cityTrace.js）。
  _computeTraceJunctions() { return computeTraceJunctions(this); }

  // 路口斑马线（实现见 world/cityTrace.js）：四组，A 跨主路、B 跨被穿路，
  // 铺开范围按「带线与路边线真实交点」实测，斜交与变宽面路都能盖满。
  _buildTraceCrosswalks() { return buildTraceCrosswalks(this); }

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
          this._fillBlockArea(bx0, bx1, bz0, bz1, district, landRects);
        }

        // pedestrian loop on the sidewalk band
        const inset = 2.0;
        const lx0 = px0 + inset, lx1 = px1 - inset, lz0 = pz0 + inset, lz1 = pz1 - inset;
        if (lx1 - lx0 > 3 && lz1 - lz0 > 3) {
          this.sidewalkLoops.push(this._rectLoop(lx0, lx1, lz0, lz1));
          this._streetProps(px0, px1, pz0, pz1, rx0, rx1, rz0, rz1, bx0, bx1, bz0, bz1);
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

  // 点是否落在描边路走廊内（路面 + 人行道 + 1.5m 余量）。实现见 world/cityProps.js
  _inTraceCorridor(x, z) { return inTraceCorridor(this, x, z); }

  // 程序化绿植的描边路避让：手绘路穿过的街廓，建筑会被走廊避让跳过，
  // 但楼间缝/中庭/公园的绿植若照常放置，会从沥青路面下穿出来 —— 走廊内一律不放。
  // 描边建筑 footprint 内同理（会种在别人楼里）
  _corridorBlocked(x, z) {
    if (this.traceCorridors.length && this._inTraceCorridor(x, z)) return true;
    for (const r of this.traceBuildingRects) {
      if (x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) return true;
    }
    return false;
  }

  // 街区四缘的路灯/行道树/花坛（实现见 world/cityProps.js）
  _streetProps(px0, px1, pz0, pz1, rx0, rx1, rz0, rz1, bx0, bx1, bz0, bz1) {
    streetProps(this, px0, px1, pz0, pz1, rx0, rx1, rz0, rz1, bx0, bx1, bz0, bz1);
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
    if (this._corridorBlocked(x, z)) return;
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

  // 花坛：矮水泥边 + 两丛灌木（低面数，适合大量点缀）
  _addPlanter(x, z) {
    if (this._corridorBlocked(x, z)) return;
    const s = rand(0.8, 1.2);
    this.propBatch.add(applyColor(boxAt(s, 0.42, s, x, 0.37, z), 0x9a968b));
    const g = new THREE.Color().setHSL(0.27 + Math.random() * 0.06, 0.45, 0.3 + Math.random() * 0.06);
    this.propBatch.add(applyColor(icoAt(s * 0.4, x, 0.7, z, 0, 1, 0.9, 1), g));
    this.propBatch.add(applyColor(icoAt(s * 0.3, x + rand(-0.2, 0.2), 0.86, z + rand(-0.2, 0.2), 0, 1, 0.9, 1), g.clone().offsetHSL(0.01, 0, 0.05)));
  }

  // 绿篱：贴着楼山墙或围墙的一段灌木
  _addHedge(x, z) {
    if (this._corridorBlocked(x, z)) return;
    const len = rand(1.8, 3.2);
    const ry = Math.random() < 0.5 ? 0 : Math.PI / 2;
    this.propBatch.add(applyColor(boxAt(len, 0.55, 0.55, x, 0.435, z, ry), 0x3f7233));
  }

  // 灌木丛：两个低面数球体，成本低但能打散水泥地
  _addBush(x, z) {
    if (this._corridorBlocked(x, z)) return;
    const g = new THREE.Color().setHSL(0.28 + Math.random() * 0.06, 0.45, 0.28 + Math.random() * 0.07);
    this.propBatch.add(applyColor(icoAt(0.55, x, 0.55, z, 0, 1, 0.85, 1), g));
    this.propBatch.add(applyColor(icoAt(0.4, x + rand(-0.35, 0.35), 0.75, z + rand(-0.3, 0.3), 0, 1, 0.8, 1), g.clone().offsetHSL(0.01, 0, 0.04)));
  }

  // 庭院灯：比路灯矮，夜间和路灯一起点亮（同一盏灯罩材质）
  _addYardLamp(x, z) {
    if (this._corridorBlocked(x, z)) return;
    this.propBatch.add(applyColor(cylAt(0.05, 0.075, 3.0, x, 1.66, z, 6), 0x3f4246));
    const head = new THREE.SphereGeometry(0.2, 8, 6);
    head.translate(x, 3.2, z);
    applyColor(head, 0xfff0c8);
    this.lampGlassBatch.add(head);
  }

  // 街廓内空地随机点缀绿植与庭院灯（实现见 world/cityProps.js）
  _decorateOpenSpace(x0, x1, z0, z1) { decorateOpenSpace(this, x0, x1, z0, z1); }

  /* ---- 街廓布局：先切巷 / 判用途，再逐块铺建筑 ---- */

  // 一个街廓的生成方案：park = 公园（不建房）；city = 内部巷道 + 若干可建地块
  _blockPlan(x0, x1, z0, z1, district, landRects) {
    const W = x1 - x0, D = z1 - z0;
    // 地标 / 手绘描边内容所在的街廓保持原样：不开巷、不设公园，
    // 免得巷道或草坪压在地标广场和用户画的道路上
    if (landRects.some((r) => x0 < r.x1 && x1 > r.x0 && z0 < r.z1 && z1 > r.z0)) {
      return { program: "city", cells: [{ x0, x1, z0, z1 }], alleys: [] };
    }
    for (const c of this.traceCorridors) {
      if (this._rectHitsCorridor(x0, x1, z0, z1, c)) {
        return { program: "city", cells: [{ x0, x1, z0, z1 }], alleys: [] };
      }
    }
    // 各区分公园概率：住宅/河滨区多，西门町与车站这类高密度商圈不放
    // （保持出生点与既有地标街区的原貌）
    const parkChance = this.traceCorridors.length
      ? 0
      : ({ daan: 0.18, river: 0.2, south: 0.12, xinyi: 0.08, central: 0.07, east: 0.05, wanhua: 0.05, zhongshan: 0.04, station: 0.02, ximending: 0 }[district.id] ?? 0.055);
    if (parkChance > 0 && W > 30 && D > 30 && Math.random() < parkChance) {
      return { program: "park", cells: [], alleys: [] };
    }
    const cutsX = this._alleyCuts(x0, x1, 66);
    const cutsZ = this._alleyCuts(z0, z1, 62);
    const xs = this._splitSpan(x0, x1, cutsX);
    const zs = this._splitSpan(z0, z1, cutsZ);
    const cells = [];
    for (const [ax0, ax1] of xs) for (const [bz0, bz1] of zs) cells.push({ x0: ax0, x1: ax1, z0: bz0, z1: bz1 });
    const alleys = [];
    // 南北向巷直通街廓两端；东西向巷只铺在两条纵巷之间，避免交叠面 z-fighting
    for (const c of cutsX) alleys.push({ x0: c - ALLEY_W / 2, x1: c + ALLEY_W / 2, z0, z1 });
    for (const c of cutsZ) {
      for (const [ax0, ax1] of xs) alleys.push({ x0: ax0, x1: ax1, z0: c - ALLEY_W / 2, z1: c + ALLEY_W / 2 });
    }
    return { program: "city", cells, alleys };
  }

  // 沿一条边均匀切巷：返回巷道中心线；切完地块过窄就不开巷
  _alleyCuts(a0, a1, target) {
    const len = a1 - a0;
    const n = Math.floor(len / target);
    if (n < 1) return [];
    const step = len / (n + 1);
    if (step - ALLEY_W < ALLEY_CELL) return [];
    const cuts = [];
    for (let i = 1; i <= n; i++) cuts.push(a0 + step * i + rand(-0.08, 0.08) * step);
    return cuts;
  }

  // 按巷道中心线把一维区间切成若干地块区间
  _splitSpan(a0, a1, cuts) {
    const out = [];
    let prev = a0;
    for (const c of cuts) {
      out.push([prev, c - ALLEY_W / 2]);
      prev = c + ALLEY_W / 2;
    }
    out.push([prev, a1]);
    return out;
  }

  _fillBlockArea(bx0, bx1, bz0, bz1, district, landRects) {
    const plan = this._blockPlan(bx0, bx1, bz0, bz1, district, landRects);
    if (plan.program === "park") {
      this._parkBlock(bx0, bx1, bz0, bz1);
      return;
    }
    for (const a of plan.alleys) this._alleyFloor(a);
    for (const c of plan.cells) {
      // 同一地块共享高度系数：外围出现成片高矮错落的建筑群，
      // 而不是整片屋顶高度都差不多的"地毯"
      this._fillBlock(c.x0, c.x1, c.z0, c.z1, district, landRects, rand(0.78, 1.42));
    }
    // 手绘地图不自动点缀：会把绿植放到用户画的道路上
    if (!this.traceCorridors.length) this._decorateOpenSpace(bx0, bx1, bz0, bz1);
  }

  // 巷道地面：比人行道略深的沥青色，从空中也能读出一条可走的巷子
  _alleyFloor(a) {
    const g = boxAt(a.x1 - a.x0, 0.02, a.z1 - a.z0, (a.x0 + a.x1) / 2, 0.171, (a.z0 + a.z1) / 2);
    applyColor(g, 0x64686d);
    this.propBatch.add(g);
  }

  _fillBlock(bx0, bx1, bz0, bz1, district, landRects, bias = 1) {
    const W = bx1 - bx0, D = bz1 - bz0;
    const dN = Math.min(rand(13, 18), D * 0.34);
    const dS = Math.min(rand(13, 18), D * 0.34);
    const dW = Math.min(rand(12, 17), W * 0.32);
    const dE = Math.min(rand(12, 17), W * 0.32);

    // north frontage
    this._lotsAlongX(bx0, bx1, bz0, dN, "n", district, landRects, bias);
    // south frontage
    this._lotsAlongX(bx0, bx1, bz1 - dS, dS, "s", district, landRects, bias);
    // west / east frontages
    this._lotsAlongZ(bz0 + dN, bz1 - dS, bx0, dW, "w", district, landRects, bias);
    this._lotsAlongZ(bz0 + dN, bz1 - dS, bx1 - dE, dE, "e", district, landRects, bias);

    // interior：中间留一块中庭（采光 / 绿地 / 机车位），四周再围一圈背街建筑，
    // 不把街廓内部整块铺满屋顶
    const cx0 = bx0 + dW, cx1 = bx1 - dE;
    const cz0 = bz0 + dN, cz1 = bz1 - dS;
    const iw = cx1 - cx0, id = cz1 - cz0;
    if (iw < 5 || id < 5) return;

    const yardW = Math.min(iw - 5, rand(11, 24));
    const yardD = Math.min(id - 5, rand(9, 20));
    if (yardW > 9 && yardD > 8 && Math.random() < 0.7) {
      const yx0 = (cx0 + cx1) / 2 - yardW / 2, yx1 = yx0 + yardW;
      const yz0 = (cz0 + cz1) / 2 - yardD / 2, yz1 = yz0 + yardD;
      this._fillInterior(cx0, yx0, cz0, cz1, district, landRects, bias);
      this._fillInterior(yx1, cx1, cz0, cz1, district, landRects, bias);
      this._fillInterior(yx0, yx1, cz0, yz0, district, landRects, bias);
      this._fillInterior(yx0, yx1, yz1, cz1, district, landRects, bias);
      this._courtyard(yx0, yx1, yz0, yz1);
    } else {
      this._fillInterior(cx0, cx1, cz0, cz1, district, landRects, bias);
    }
  }

  _fillInterior(x0, x1, z0, z1, district, landRects, bias) {
    if (x1 - x0 < 5 || z1 - z0 < 5) return;
    let x = x0;
    while (x < x1 - 4) {
      const w = Math.min(rand(8, 14), x1 - x);
      let z = z0;
      while (z < z1 - 4) {
        const d = Math.min(rand(9, 15), z1 - z);
        if (w > 4 && d > 4) {
          // 背街建筑之间同样留缝，从空中看是一栋栋独立的楼
          const gx = Math.min(rand(0.9, 1.6), Math.max(0.1, (w - 6) * 0.45));
          const gz = Math.min(rand(0.9, 1.6), Math.max(0.1, (d - 6) * 0.45));
          this._addBuilding(x + gx, x + w - gx, z + gz, z + d - gz, null, district, landRects, bias);
        }
        z += d;
      }
      x += w;
    }
  }

  // 中庭：草地或水泥地 + 少量树木 / 杂物，玩家可以从巷道走进去
  _courtyard(x0, x1, z0, z1) {
    const w = x1 - x0, d = z1 - z0;
    if (w < 4 || d < 4) return;
    const g = boxAt(w, 0.04, d, (x0 + x1) / 2, 0.18, (z0 + z1) / 2);
    applyColor(g, Math.random() < 0.55 ? 0x40532f : 0x6d6a60);
    this.propBatch.add(g);
    const n = Math.round(Math.min(8, (w * d) / 70) * this.gen.greenDensity);
    for (let i = 0; i < n; i++) {
      const tx = rand(x0 + 1.2, x1 - 1.2), tz = rand(z0 + 1.2, z1 - 1.2);
      if (Math.random() < 0.65) this._addTree(tx, tz, rand(0.6, 0.9));
      else this.propBatch.add(applyColor(boxAt(1.2, 0.7, 0.8, tx, 0.51, tz), 0x8a8c86));
    }
  }

  // 公园 / 广场街廓：草坪 + 十字步道 + 中央广场 + 树 + 长椅，给密集街区留出呼吸空间
  _parkBlock(x0, x1, z0, z1) {
    const w = x1 - x0, d = z1 - z0;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    this.propBatch.add(applyColor(boxAt(w, 0.03, d, cx, 0.175, cz), 0x3d5a33));
    const pw = Math.min(3.2, Math.min(w, d) * 0.2);
    this.propBatch.add(applyColor(boxAt(pw, 0.02, d - 2, cx, 0.191, cz), 0xb6ad9c));
    this.propBatch.add(applyColor(boxAt(w - 2, 0.02, pw, cx, 0.192, cz), 0xb6ad9c));

    // 中央小广场 + 水池：避免整块草地空得像个操场
    const ps = Math.min(11, Math.min(w, d) * 0.34);
    this.propBatch.add(applyColor(boxAt(ps, 0.03, ps, cx, 0.196, cz), 0xc9c2b2));
    this.propBatch.add(applyColor(cylAt(1.2, 1.45, 0.55, cx, 0.48, cz, 12), 0x9aa0a4));

    const n = Math.round(Math.min(28, (w * d) / 80) * this.gen.greenDensity);
    for (let i = 0; i < n; i++) {
      const tx = rand(x0 + 2, x1 - 2), tz = rand(z0 + 2, z1 - 2);
      if (Math.abs(tx - cx) < Math.max(pw, ps / 2) + 1.6) continue;
      if (Math.abs(tz - cz) < Math.max(pw, ps / 2) + 1.6) continue;
      this._addTree(tx, tz, rand(0.85, 1.25));
    }
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const bx = cx + Math.cos(a) * (ps / 2 + 1.3);
      const bz = cz + Math.sin(a) * (ps / 2 + 1.3);
      this.propBatch.add(applyColor(boxAt(1.6, 0.42, 0.5, bx, 0.35, bz, a + Math.PI / 2), 0x8a6a45));
    }
    // 步道灯：沿十字步道间隔布置，夜间和路灯一起点亮（间距随路灯密度缩放）
    const ld = this.gen.lampDensity;
    if (ld > 0) {
      const step = 18 / ld;
      for (let z = z0 + 8; z < z1 - 8; z += step) {
        this._addYardLamp(cx + pw / 2 + 0.8, z);
        if (w > 60) this._addYardLamp(cx - pw / 2 - 0.8, z + step * 0.5);
      }
      for (let x = x0 + 8; x < x1 - 8; x += step) this._addYardLamp(x, cz - pw / 2 - 0.8);
    }
  }

  // 相邻建筑之间的半间距：多数为 1~2m（相邻两户合计 2~4m 的缝），
  // 少数留 2.5~4m（合计 5~8m 的侧院/防火巷），不再共用一面山墙
  _sideGap(w) {
    const cap = Math.max(0.1, (w - 4) * 0.42);
    return Math.min((Math.random() < 0.16 ? rand(2.5, 4.0) : rand(1.0, 2.0)) * this.gen.gapScale, cap);
  }

  _lotsAlongX(x0, x1, z0, depth, facing, district, landRects, bias = 1) {
    let x = x0;
    while (x < x1 - 5) {
      const w = Math.min(rand(8, 15), x1 - x);
      if (w > 5) {
        // 左右退缝：相邻建筑之间始终留出空地（不再是整排贴死）
        const g0 = this._sideGap(w), g1 = this._sideGap(w);
        // 前退线：一半的建筑后退 0.6~3.2m，街道立面有凹凸、不齐平
        const setback = Math.random() < 0.5 ? rand(0.6, Math.min(3.2, depth * 0.24)) : 0;
        // 临街面固定在该退线上，进深往背街方向微调
        const d = Math.max(3.2, depth * rand(0.86, 1.04) - setback);
        const zB = facing === "n" ? z0 + setback : z0 + depth - setback - d;
        this._addBuilding(x + g0, x + w - g1, zB, zB + d, facing, district, landRects, bias);
        // 楼间缝里随机放绿植（缝够宽时放棵小树），沿街因此有一条条绿带
        if (g1 > 0.9 && Math.random() < 0.45 * this.gen.greenDensity) {
          const gx = x + w, gz = zB + d * 0.5;
          if (g1 > 1.25 && Math.random() < 0.45) this._addTree(gx, gz, rand(0.45, 0.6));
          else this._addPlanter(gx, gz);
        }
      }
      x += w;
    }
  }

  _lotsAlongZ(z0, z1, x0, depth, facing, district, landRects, bias = 1) {
    let z = z0;
    while (z < z1 - 5) {
      const d = Math.min(rand(8, 15), z1 - z);
      if (d > 5) {
        const g0 = this._sideGap(d), g1 = this._sideGap(d);
        const setback = Math.random() < 0.5 ? rand(0.6, Math.min(3.2, depth * 0.24)) : 0;
        const dep = Math.max(3.2, depth * rand(0.86, 1.04) - setback);
        const xB = facing === "w" ? x0 + setback : x0 + depth - setback - dep;
        this._addBuilding(xB, xB + dep, z + g0, z + d - g1, facing, district, landRects, bias);
        if (g1 > 0.9 && Math.random() < 0.45 * this.gen.greenDensity) {
          const gz = z + d, gx = xB + dep * 0.5;
          if (g1 > 1.25 && Math.random() < 0.45) this._addTree(gx, gz, rand(0.45, 0.6));
          else this._addPlanter(gx, gz);
        }
      }
      z += d;
    }
  }

  // 建筑矩形是否触碰描边道路走廊；取面路另判“整体落在填充面内”
  _rectHitsCorridor(x0, x1, z0, z1, c) {
    for (const p of c.samples) {
      const dx = Math.max(x0 - p.x, 0, p.x - x1);
      const dz = Math.max(z0 - p.z, 0, p.z - z1);
      if (dx * dx + dz * dz <= c.keepHalf * c.keepHalf) return true;
    }
    if (c.closed) {
      for (const [px, pz] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) {
        if (pointInPoly(px, pz, c.pts)) return true;
      }
    }
    return false;
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

  _addBuilding(x0, x1, z0, z1, facing, district, landRects, bias = 1) {
    if (x1 - x0 < 3 || z1 - z0 < 3) return;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    // exclusion zones (landmarks)
    for (const r of landRects) {
      if (x0 < r.x1 && x1 > r.x0 && z0 < r.z1 && z1 > r.z0) return;
    }
    // 3D 描边建筑避让：程序化楼压进手绘建筑 footprint（含余量）则不放，
    // 该地块留下的空档由后续逐栋检测自然跳过，周边建筑照常生成
    for (const r of this.traceBuildingRects) {
      if (x0 < r.x1 && x1 > r.x0 && z0 < r.z1 && z1 > r.z0) return;
    }
    // 3D 描边道路走廊避让：建筑压住路面/人行道（含退让余量）则不放
    for (const c of this.traceCorridors) {
      if (this._rectHitsCorridor(x0, x1, z0, z1, c)) return;
    }

    const style = district.style || { floors: [3, 9], towers: 0.08, neon: 0.5, old: 0.5, shops: 0.85 };
    let floors;
    const nearXinyi = cx > 440 && cz > 90 && cz < 300;
    if (nearXinyi) floors = Math.random() < 0.22 ? Math.round(rand(16, 30)) : Math.round(rand(6, 14));
    else if (district.id === "ximending") floors = Math.round(rand(4, 9));
    else floors = Math.round(rand(style.floors[0], style.floors[1]));
    // 地块高度系数：同一片街区成团地高 / 低，天际线因此有起伏
    floors = Math.max(2, Math.min(40, Math.round(floors * bias)));

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

    this.colliders.add(x0, z0, x1, z1, y1);
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

  /* ---------------- parked scooters / traffic heads ---------------- */
  // 停放机车与红绿灯灯杆（实现见 world/cityStreetObjects.js）
  _buildParkedScooters() { buildParkedScooters(this); }

  _buildTrafficHeads() { buildTrafficHeads(this); }

  /* ---------------- chunk streaming ---------------- */
  // 把网格登记为可按距离调度的分块（几何已烘焙到世界坐标，包围球中心即世界位置）
  _addChunk(mesh) {
    const bs = mesh.geometry && mesh.geometry.boundingSphere;
    if (bs) this.chunks.push({ mesh, x: bs.center.x, z: bs.center.z, r: bs.radius, on: mesh.visible !== false });
    this.group.add(mesh);
    return mesh;
  }

  /** 外部对象（地标组、编辑器内容组）也纳入按需渲染调度 */
  registerStreamed(obj) {
    if (!obj) return obj;
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    if (!Number.isFinite(box.min.x)) return obj;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    this.chunks.push({
      mesh: obj,
      x: sphere.center.x,
      z: sphere.center.z,
      r: sphere.radius,
      on: obj.visible !== false,
    });
    return obj;
  }

  // 按需渲染：只保留玩家 renderDistance 内的分块。
  // 每次移动超过 ~6m 才重算（上千个分块，逐帧算没必要）。
  updateStream(focus) {
    if (!focus || !this.chunks.length) return;
    const distance = getRenderSettings().renderDistance;
    const cx = focus.x, cz = focus.z;
    const moved = !this._streamCenter ||
      Math.abs(cx - this._streamCenter.x) > 6 || Math.abs(cz - this._streamCenter.z) > 6 ||
      distance !== this._streamDistance;
    if (!moved) return;

    this._streamCenter = { x: cx, z: cz };
    this._streamDistance = distance;
    const showOut = distance * 1.12;   // 迟滞：离开用更远阈值，避免边界反复闪烁
    let visible = 0;
    for (const c of this.chunks) {
      const dx = c.x - cx, dz = c.z - cz;
      // 用"到包围球表面"的距离：大块（地标/整段道路）不会因为中心远而被误裁
      const d = Math.sqrt(dx * dx + dz * dz) - c.r * 0.6;
      const on = c.on ? d <= showOut : d <= distance;
      if (on !== c.on) {
        c.on = on;
        c.mesh.visible = on;
      }
      if (on) visible++;
    }
    this.visibleChunks = visible;
  }

  dispose() {
    if (this._unsubSettings) {
      this._unsubSettings();
      this._unsubSettings = null;
    }
    this.chunks = [];
  }

  /* ---------------- finalize ---------------- */
  _finalize() {
    // 外墙材质来自标准材料库（与描边建筑/地标共享实例）；
    // 夜间亮窗由 updateStream 直接改这批实例的 emissiveIntensity
    const facadeMats = this.facades;
    this.facadeMaterials = facadeMats;
    this.facadeBatches.forEach((b, i) => {
      for (const mesh of b.build(facadeMats[i], { castShadow: true, receiveShadow: true })) this._addChunk(mesh);
    });

    // 店面材质来自标准材料库（与描边建筑共享实例）；夜间店堂灯光
    // 由 updateStream 直接改这批实例的 emissiveIntensity
    const sfMats = this.storefronts;
    this.storefrontMaterials = sfMats;
    this.storefrontBatches.forEach((b, i) => {
      for (const mesh of b.build(sfMats[i], { castShadow: false, receiveShadow: true })) this._addChunk(mesh);
    });

    const roofMat = new THREE.MeshStandardMaterial({ map: makeRoofTexture(), color: 0x9a968e, roughness: 0.92 });
    roofMat.map.repeat.set(1, 1);
    this.materials.roof = roofMat;
    for (const roof of this.roofBatch.build(roofMat, { receiveShadow: true })) this._addChunk(roof);

    const signMat = this.signMaterial; // 材料库共享实例（含防 z-fighting 参数）
    for (const signs of this.signBatch.build(signMat, { castShadow: false, receiveShadow: false })) this._addChunk(signs);

    const awnMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.0 });
    for (const awn of this.awningBatch.build(awnMat, { castShadow: true, receiveShadow: true })) this._addChunk(awn);

    const propMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.05 });
    for (const props of this.propBatch.build(propMat, { castShadow: true, receiveShadow: true })) this._addChunk(props);

    const treeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.0 });
    for (const trees of this.treeBatch.build(treeMat, { castShadow: true, receiveShadow: true })) this._addChunk(trees);

    const platMat = new THREE.MeshStandardMaterial({ map: makeSidewalkTexture(), color: 0xffffff, roughness: 0.92, metalness: 0.0 });
    this.materials.platform = platMat;
    for (const plat of this.platformBatch.build(platMat, { castShadow: false, receiveShadow: true })) this._addChunk(plat);

    const whiteMat = new THREE.MeshBasicMaterial({ color: 0xe8e8e2, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    for (const white of this.markWhite.build(whiteMat, { castShadow: false, receiveShadow: false })) this._addChunk(white);
    const yellowMat = new THREE.MeshBasicMaterial({ color: 0xd8a524, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    for (const yellow of this.markYellow.build(yellowMat, { castShadow: false, receiveShadow: false })) this._addChunk(yellow);

    this.lampMat = new THREE.MeshBasicMaterial({ color: 0x6a6458, toneMapped: false });
    for (const lamp of this.lampGlassBatch.build(this.lampMat, { castShadow: false, receiveShadow: false })) this._addChunk(lamp);
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

  update(dt, time, night, focus) {
    // 按需渲染：只让玩家附近的分块参与绘制（含阴影 pass）
    this.updateStream(focus);

    // emissive windows：night 是连续插值，只有变化超过阈值才重写材质
    if (Math.abs(night - this._nightApplied) > 0.01) {
      this._nightApplied = night;
      const facadeEm = 0.02 + night * 1.25;
      for (const m of this.facadeMaterials) m.emissiveIntensity = facadeEm;
      const sfEm = 0.12 + night * 1.35;
      for (const m of this.storefrontMaterials) m.emissiveIntensity = sfEm;
      if (this.signMaterial) this.signMaterial.emissiveIntensity = 0.45 + night * 1.45;
      const lampOn = night > 0.34;
      if (lampOn !== this._lampOn) {
        this._lampOn = lampOn;
        if (this.lampMat) this.lampMat.color.setHex(lampOn ? 0xfff0c8 : 0x6a6458);
      }
    }

    // traffic lights: 16s cycle, NS green then EW green
    const cyc = (time % 16 + 16) % 16;
    const nsGreen = cyc < 7;
    const nsYellow = cyc >= 7 && cyc < 8;
    const ewGreen = cyc >= 8.5 && cyc < 15;
    const ewYellow = cyc >= 15 && cyc < 16;
    this.lightState = { nsGreen, nsYellow, ewGreen, ewYellow, ns: nsGreen, ew: ewGreen };

    // 灯色只有 4 种状态：只在状态切换时重写 instanceColor，
    // 否则每帧都要上传一整块 instance 颜色缓冲（上千个灯头）。
    const lightKey = (nsGreen ? 1 : 0) | (nsYellow ? 2 : 0) | (ewGreen ? 4 : 0) | (ewYellow ? 8 : 0);
    if (this.trafficInst && lightKey !== this._lightKey) {
      this._lightKey = lightKey;
      const headColor = (green, yellow) => (green ? 0x22ff66 : yellow ? 0xffcc33 : 0xff2a2a);
      const cZ = headColor(nsGreen, nsYellow);
      const cX = headColor(ewGreen, ewYellow);
      const col = this._lightColor || (this._lightColor = new THREE.Color());
      for (let i = 0; i < this.trafficHeads.length; i++) {
        col.setHex(this.trafficHeads[i].axis === "z" ? cZ : cX);
        this.trafficInst.setColorAt(i, col);
      }
      if (this.trafficInst.instanceColor) this.trafficInst.instanceColor.needsUpdate = true;
    }
  }
}


