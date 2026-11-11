// 拼接式路块工具：以基础路块单元（默认 3m×2m）在地图上逐块拼接道路。
// 网上同类玩法（TrackMania 式路块链 / 模块化 socket 磁吸 / 幽灵预览）的落地版：
//  · 每个路块有 A/B 两个连接端口（短边中点），端口空闲即可被新块磁吸贴紧
//  · 放置后「链条」粘滞在新块出口端口，连续单击即成链；Esc/Enter/按钮断开
//  · 方向 = 端口指向光标（链条延续时相对上一块限幅 ±90°，防止 180° 掉头叠回），
//    按「角度步进」量化（默认 15°，Shift 临时强制 15°）
//  · 相邻块转角处端头自动对接（圆弧转角 / miter 斜切，见 world/customMap.rtMiters）：
//    弯道外缘连续、内缘不重叠，路缘石/边线沿转角曲线连续转向
//  · 贴图为程序化 Canvas（world/textures.makeRoadTileTexture），编辑器与运行时共用
// 数据存 map.features.roadTiles: [{id, x, z, rot, len, w, style, lanes, zh, en,
// kind, sidewalk, median}]，rot 为弧度
// （rotation.y=θ 时前进方向 = (sinθ, cosθ)，与物件 rot 语义一致）。
// zh/en/kind/sidewalk/median 为整条拼接路的组级公共属性：随块存储（组是端口拓扑
// 的派生分组），组面板批量写入组内所有块，新块端口连通时自动继承。
// 全部以编辑器实例（ed）为第一参数（mixin 风格，同 measure.js）。

import * as THREE from "three";
import { uid } from "./util.js";
import { makeRoadTileTexture } from "../../world/textures.js";
import { rtPortPairs, rtMiters, rtTileQuadGeometry, rtEndKey } from "../../world/customMap.js";

export const TILE_STYLE_ZH = { dash: "白虚线", double: "双黄线", plain: "无标线" };

// 整条拼接路的组级公共属性（右侧组面板批量编辑，随块存储 —— 组是端口拓扑的
// 派生分组不落数据，属性只能落在块上）。新块放置时若端口与旧块连通则自动继承，
// 保证同一条路的属性一致。lanes 不在此列：它由放置参数决定且直接影响贴图车道线
const RT_GROUP_PROPS = ["zh", "en", "kind", "sidewalk", "median"];

// 端口占用判定半径（米）：两端口接近到此距离内视为已互连。
// 放置坐标 round 到 0.1m，取 0.35 覆盖舍入误差，避免同点重复吸附。
const PORT_EPS = 0.35;

// 路块 A/B 端口世界坐标（短边中点）
export function tilePorts(t) {
  const s = Math.sin(t.rot || 0), c = Math.cos(t.rot || 0);
  const hl = (t.len || 3) / 2;
  return [
    { key: "A", x: t.x - s * hl, z: t.z - c * hl },
    { key: "B", x: t.x + s * hl, z: t.z + c * hl },
  ];
}

// 空闲端口列表。仅在数据变化后算一次（脏缓存），鼠标移动只读缓存。
// 占用判定用 4m 网格桶空间哈希：端口只需与相邻 9 桶内的端口比距离，
// 整体 O(n) —— 之前 O(n²) 全对比较在块多时每次放置都会掉帧。
const PORT_CELL = 4; // 哈希格边长（> 2×PORT_EPS 保证邻桶覆盖）
function freePorts(ed) {
  if (!ed._rtPortsDirty && ed._rtFreePorts) return ed._rtFreePorts;
  const ports = [];
  for (const t of ed.map.features.roadTiles || []) {
    const s = Math.sin(t.rot || 0), c = Math.cos(t.rot || 0);
    const ps = tilePorts(t);
    // fx/fz = 端口「向外」方向（新块从该端口延伸时应朝的方向）：
    // A 端 = 逆前进（路向后延续），B 端 = 顺前进（路向前延续）
    ports.push({ x: ps[0].x, z: ps[0].z, fx: -s, fz: -c });
    ports.push({ x: ps[1].x, z: ps[1].z, fx: s, fz: c });
  }
  const buckets = new Map();
  const cellKey = (cx, cz) => cx + "," + cz;
  for (const p of ports) {
    const k = cellKey(Math.floor(p.x / PORT_CELL), Math.floor(p.z / PORT_CELL));
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = []));
    b.push(p);
  }
  const tooClose = (p) => {
    const cx = Math.floor(p.x / PORT_CELL), cz = Math.floor(p.z / PORT_CELL);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const b = buckets.get(cellKey(cx + i, cz + j));
        if (!b) continue;
        for (const q of b) {
          if (q !== p && Math.hypot(p.x - q.x, p.z - q.z) < PORT_EPS) return true;
        }
      }
    }
    return false;
  };
  const free = [];
  for (const p of ports) if (!tooClose(p)) free.push({ x: p.x, z: p.z, fx: p.fx, fz: p.fz });
  ed._rtFreePorts = free;
  ed._rtPortsDirty = false;
  return free;
}

// 数据变化后使端口缓存失效（放置/删除/重建时调用）
export function rtMarkDirty(ed) {
  ed._rtPortsDirty = true;
  ed._rtFreePorts = null;
}

// 计算幽灵路块状态 { x, z, yaw, anchor }：
//  · 链条粘滞中（_rtChain）：锚点 = 链端出口端口（方向始终由光标指示，距离不限）
//  · 落钉瞄准中（_rtPin）：锚点 = 钉住的入口点（自由放置两段式，见 rtPlace）
//  · 否则：磁吸半径内最近的空闲端口（半径随块长放大）
//  · 都没有：自由放置（锚点 = 光标，方向保持上次值）
export function rtGhostState(ed, pt, shiftKey) {
  const len = ed._rtLen;
  const R = Math.max(4, len * 1.2); // 磁吸半径
  const halfW = (ed._rtW || 2) * 0.35; // 链端走廊半宽 / 端口模糊半径
  let anchor = null;
  // 方向惯性区（保持上一块前进方向、不做端口抢占）：
  //  · 光标自上次放置后累计未移动 >0.5m（同坐标补发事件、原地连点）
  //  · 光标距链端 < 模糊半径（端口近旁方向无意义）
  //  · 光标在链端正后方且横向偏移 < 0.35 块宽（沿已放块走廊回挪/微调）
  //    旧版用「后方 1 块长半球」整片锁死，侧向扫很远都出不了区，
  //    表现为「鼠标要移动很大幅度才能转向」
  let inertia = false;
  if (ed._rtChain) {
    anchor = { x: ed._rtChain.x, z: ed._rtChain.z };
    const dxf = pt.x - anchor.x, dzf = pt.z - anchor.z;
    const dist = Math.hypot(dxf, dzf);
    const fwd = ed._rtYaw || 0;
    const behind = dxf * Math.sin(fwd) + dzf * Math.cos(fwd) < 0; // 光标在链端后方半球
    const lat = Math.abs(dxf * Math.cos(fwd) - dzf * Math.sin(fwd)); // 相对链方向的横向偏移
    // moved 与上次放置光标位置比累计位移（非单事件位移 —— 慢速拖动也要能转向）
    const moved = ed._rtLastMovePt && Math.hypot(pt.x - ed._rtLastMovePt.x, pt.z - ed._rtLastMovePt.z) > 0.5;
    if (!moved || dist < Math.max(2.5, halfW) || (behind && lat < halfW)) {
      inertia = true;
    } else {
      // 光标明确指向别处：明显更靠近其他空闲端口（< 到链端距离的一半，
      // 且在磁吸半径内）时锚点切过去 —— 保证随时可以分支到已有路网
      const dChain = dist;
      let bd = Math.min(R, dChain * 0.5);
      let best = null;
      for (const p of freePorts(ed)) {
        if (Math.hypot(p.x - anchor.x, p.z - anchor.z) < PORT_EPS) continue; // 链端自身跳过
        const d = Math.hypot(p.x - pt.x, p.z - pt.z);
        if (d < bd) { bd = d; best = p; }
      }
      if (best) anchor = { x: best.x, z: best.z, fx: best.fx, fz: best.fz };
    }
  } else if (ed._rtPin) {
    // 落钉瞄准（自由放置两段式，见 rtPlace）：入口点已钉住，方向 = 钉点 → 光标。
    // 首个路块由此获得明确的瞄准参考，不再只能 Q/E 盲转
    anchor = { x: ed._rtPin.x, z: ed._rtPin.z };
  } else {
    let bd = R;
    for (const p of freePorts(ed)) {
      const d = Math.hypot(p.x - pt.x, p.z - pt.z);
      if (d < bd) { bd = d; anchor = { x: p.x, z: p.z, fx: p.fx, fz: p.fz }; }
    }
  }
  // 方向参考点：吸附态 = 锚点（端口指向光标）；自由态 = 上次放置位置
  // （之前自由态方向完全固定 —— 块变大后用户感知「不能旋转」的主因）
  const ref = anchor || ed._rtLastRef;
  let yaw = ed._rtYaw || 0;
  if (ref && Math.hypot(pt.x - ref.x, pt.z - ref.z) > 1.5) {
    // 世界方向角 φ → rotation.y：forward=(sinθ,cosθ) ⟹ θ = π/2 − atan2(dz,dx)
    yaw = Math.PI / 2 - Math.atan2(pt.z - ref.z, pt.x - ref.x);
    if (yaw > Math.PI) yaw -= 2 * Math.PI;
    else if (yaw < -Math.PI) yaw += 2 * Math.PI;
    if (anchor && ed._rtChain && inertia) {
      // 惯性区内直接保持上一块的前进方向，否则放置后下一块反向 180° 叠回上一块
      yaw = ed._rtYaw || 0;
    } else if (anchor && anchor.fx !== undefined) {
      // 端口限幅：新块只能从锚端口「向外」延伸 ±90° —— 光标扫到端口后方时幽灵
      // 最多转到垂直，不会 180° 掉头叠回端口所属块（>150° 掉头无法焊接，只会
      // 留下方口尖角）；链端 = 延续上一块方向，磁吸/抢占端口 = 延续端口所属路
      const a0 = Math.atan2(anchor.fx, anchor.fz);
      let rel = yaw - a0;
      if (rel > Math.PI) rel -= 2 * Math.PI;
      else if (rel < -Math.PI) rel += 2 * Math.PI;
      if (rel > Math.PI / 2) rel = Math.PI / 2;
      else if (rel < -Math.PI / 2) rel = -Math.PI / 2;
      yaw = a0 + rel;
      if (yaw > Math.PI) yaw -= 2 * Math.PI;
      else if (yaw < -Math.PI) yaw += 2 * Math.PI;
    }
    let step = +ed._rtStep || 0;
    if (!step && shiftKey) step = 15; // 自由角度模式下 Shift 临时量化
    if (step > 0) {
      const r = (step * Math.PI) / 180;
      yaw = Math.round(yaw / r) * r;
    }
    ed._rtYaw = yaw;
  }
  let x = pt.x, z = pt.z;
  if (anchor) {
    // 新块入口端口对齐锚点：中心 = 锚点沿 yaw 前进半块长
    x = anchor.x + Math.sin(yaw) * len / 2;
    z = anchor.z + Math.cos(yaw) * len / 2;
  }
  return { x, z, yaw, anchor };
}

/* ---------------- 幽灵预览 ---------------- */

// 吸附端口指示环
function portRing() {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.5, 0.75, 24).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.95, depthWrite: false }),
  );
  ring.renderOrder = 6;
  ring.position.y = 0.12;
  return ring;
}

export function rtEnsureGhost(ed) {
  if (ed._rtGhost) return;
  const g = new THREE.Group();
  g.visible = false;
  ed._three.scene.add(g);
  ed._rtGhost = g;
  ed._rtGhostKey = "";
}

function rebuildGhostMesh(ed) {
  const g = ed._rtGhost;
  for (const ch of g.children.slice()) {
    g.remove(ch);
    if (ch.geometry) ch.geometry.dispose();
    if (ch.material) ch.material.dispose();
  }
  const mesh = buildRoadTileMesh(ed, { len: ed._rtLen, w: ed._rtW, style: ed._rtStyle, lanes: ed._rtLanes || 1 }, true);
  g.add(mesh, portRing());
  ed._rtGhostRing = g.children[1];
}

// 按 _rtGhostState 刷新幽灵（尺寸/样式变化时自动重建网格）
export function rtUpdateGhost(ed) {
  rtEnsureGhost(ed);
  const st = ed._rtGhostState;
  const g = ed._rtGhost;
  if (!st || ed.tool !== "place-road") { g.visible = false; return; }
  const key = `${ed._rtLen}x${ed._rtW}:${ed._rtStyle}:${ed._rtLanes || 1}`;
  if (g.userData.key !== key) {
    g.userData.key = key;
    rebuildGhostMesh(ed);
  }
  g.visible = true;
  g.position.set(st.x, -ed._curveOffset(st.x, st.z), st.z);
  g.rotation.y = st.yaw;
  g.children[1].visible = !!st.anchor;
  if (st.anchor) g.children[1].position.set(st.anchor.x - st.x, 0.12, st.anchor.z - st.z);
}

export function rtLeave(ed) {
  ed._rtChain = null;
  ed._rtPin = null;
  ed._rtGhostState = null;
  if (ed._rtGhost) ed._rtGhost.visible = false;
}

export function rtDisposeGhost(ed) {
  if (!ed._rtGhost) return;
  ed._three.scene.remove(ed._rtGhost);
  ed._rtGhost.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  ed._rtGhost = null;
  ed._rtGhostRing = null;
}

/* ---------------- 网格构建 ---------------- */

// 材质按 尺寸+样式 缓存（贴图在 textures.js 层缓存，材质仅编辑器内复用；
// _rebuildAll 会 dispose 材质本身，CanvasTexture 不随之销毁，可安全重建引用）
const tileMatCache = new Map();
function tileMaterial(t) {
  const key = `${t.len || 3}x${t.w || 2}:${t.style || "dash"}:${t.lanes || 1}`;
  let m = tileMatCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      map: makeRoadTileTexture(t.len || 3, t.w || 2, t.style || "dash", t.lanes || 1),
      roughness: 0.94, metalness: 0,
    });
    tileMatCache.set(key, m);
  }
  return m;
}

// 端头几何缓存：相邻块转角相同 → 端头参数一致 → 命中同一几何。
// 被 _rebuildAll dispose 是安全的：three 下次渲染自动重新上传
const tileGeoCache = new Map();
// 端记录 → 缓存键片段：复用 world/customMap.rtEndKey，端记录字段变化自动同步
function tileGeometry(ed, t, miters) {
  const len = t.len || 3, w = t.w || 2;
  const mi = miters ? miters.get(t.id) : rtMiters(ed.map.features.roadTiles || []).get(t.id) || null;
  const eA = mi && mi.a ? mi.a : null, eB = mi && mi.b ? mi.b : null;
  const key = `${len}x${w}:${rtEndKey(eA)}:${rtEndKey(eB)}`;
  let g = tileGeoCache.get(key);
  if (!g) {
    g = rtTileQuadGeometry(len, w, eA, eB, 0.06);
    if (tileGeoCache.size >= 96) tileGeoCache.delete(tileGeoCache.keys().next().value); // FIFO 防累积
    tileGeoCache.set(key, g);
  }
  return g;
}

// 单个路块网格：整块平面（贴图含路缘石/标线），中心为原点、沿本地 Z 前进。
// 端头按相邻块转角斜切（miter），弯道外缘连续、内缘不重叠。
// 编辑器层次：抬高到描边路条带（0.05）之上 1cm，避免重叠处 z-fighting
export function buildRoadTileMesh(ed, t, ghost = false, miters = null) {
  const len = t.len || 3, w = t.w || 2;
  const geo = ghost ? new THREE.PlaneGeometry(w, len).rotateX(-Math.PI / 2).translate(0, 0.06, 0) : tileGeometry(ed, t, miters);
  let mesh;
  if (ghost) {
    mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: makeRoadTileTexture(len, w, t.style || "dash", t.lanes || 1),
      color: 0x9fe8a0, transparent: true, opacity: 0.6, depthWrite: false,
    }));
    mesh.renderOrder = 5;
  } else {
    mesh = new THREE.Mesh(geo, tileMaterial(t));
    mesh.receiveShadow = true;
  }
  return mesh;
}

/* ---------------- 整条路（端口连通分组） ---------------- */

// 端口互相连通的路块集合 = 一条「拼接路」。分组是派生数据（每次由端口拓扑
// 现算，并查集 O(n·α)）：不落数据存储 —— 旧地图自动生效，单块删除/移动后
// 分组自动跟随拓扑（链断开即分成两条路，T 交叉合为一条）。
// 返回包含 t 的组（块数组，含 t 自身）。
export function rtRoadGroupOf(tiles, t) {
  const parent = new Map();
  for (const x of tiles) parent.set(x.id, x.id);
  const find = (id) => {
    let r = id;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(id) !== r) { const nx = parent.get(id); parent.set(id, r); id = nx; }
    return r;
  };
  for (const [a, b] of rtPortPairs(tiles)) {
    const ra = find(a.id), rb = find(b.id);
    if (ra !== rb) parent.set(ra, rb);
  }
  const root = find(t.id);
  return tiles.filter((x) => find(x.id) === root);
}

/* ---------------- 放置 / 会话 ---------------- */

export function rtPlace(ed, pt, shiftKey) {
  const st = ed._rtGhostState || rtGhostState(ed, pt, shiftKey);
  if (!ed.map.features.roadTiles) ed.map.features.roadTiles = [];
  // 自由放置两段式「落点 → 瞄准 → 放置」：无锚点（首个路块 / 远离端口）时第一击
  // 只钉住入口点 —— 幽灵随即从钉点延伸、绿环标记钉点，方向 = 钉点 → 光标，
  // 移动鼠标即瞄准；第二击才真正放置。首个路块因此能直观摆角度；
  // 磁吸端口 / 链条延续本就有锚点参考，保持单击直放不受影响
  if (!st.anchor && !ed._rtPin) {
    ed._rtPin = { x: Math.round(pt.x * 10) / 10, z: Math.round(pt.z * 10) / 10 };
    ed._rtLastMovePt = { x: pt.x, z: pt.z };
    ed._rtGhostState = rtGhostState(ed, pt, shiftKey);
    rtUpdateGhost(ed);
    ed.status("落点已钉住 · 移动鼠标瞄准方向 · 单击放置 · Esc 取消落点");
    return;
  }
  ed._rtPin = null; // 落钉确认放置 / 吸附直放都清除钉点（链条随即接管）
  // 吸附放置（链条延续/端口磁吸）保留全精度：入口端口必须精确落在锚点上 ——
  // 0.1m 舍入会让接缝两侧端口错位 2~5cm，是贴合缝的主要来源之一；
  // 自由放置仍吸 0.1m 网格保持坐标整洁。rot 同步用 1e-4 弧度量化
  const anchored = !!st.anchor;
  const q = (v) => Math.round(v * 1e4) / 1e4;
  const t = {
    id: uid(),
    x: anchored ? q(st.x) : Math.round(st.x * 10) / 10,
    z: anchored ? q(st.z) : Math.round(st.z * 10) / 10,
    rot: q(st.yaw),
    len: ed._rtLen,
    w: ed._rtW,
    style: ed._rtStyle,
    lanes: ed._rtLanes || 1,
  };
  // 链条为空 = 本次操作的新起点（首块 / 断链后再放 / 磁吸到其他空闲端口重开）：
  // 之前的操作记录作废（那些块从此归为「之前加的路」，一键清空不再触碰）
  if (!ed._rtChain || !ed._rtOpIds) ed._rtOpIds = [];
  ed._rtOpIds.push(t.id); // 记入本次操作：一键清空只移除这些块
  ed.map.features.roadTiles.push(t);
  // 端头斜切是新块与相邻块互相影响的：一次算好，重建新块与其端口相接的旧块
  const miters = rtMiters(ed.map.features.roadTiles);
  ed._makeWrapper("roadTile", t, buildRoadTileMesh(ed, t, false, miters));
  for (const [a, b] of rtPortPairs(ed.map.features.roadTiles)) {
    if (a !== t && b !== t) continue;
    const other = a === t ? b : a; // 与新块端口连通的旧块
    // 公共属性继承：端口连通 = 并入同一条拼接路，名称/英文/类型/人行道/分隔带
    // 从旧块继承（组面板批量编辑随块存的公共属性，同组保持一致）
    for (const k of RT_GROUP_PROPS) if (t[k] === undefined && other[k] !== undefined) t[k] = other[k];
    rtRebuildTile(ed, a === t ? b : a, miters);
  }
  rtMarkDirty(ed);
  ed._rtLastRef = { x: t.x, z: t.z }; // 自由放置时的方向参考点 = 上次块中心
  ed._rtLastMovePt = { x: pt.x, z: pt.z }; // 惯性基准 = 放置光标：累计移动 >0.5m 才解除方向惯性
  // 链条延续：粘滞到新块出口端口 B，下一块自动从此磁吸出发（全精度避免链端漂移）；
  // fx/fz = 该端口向外方向（= 本块前进向），供幽灵方向限幅用
  const b = tilePorts(t)[1];
  ed._rtChain = { x: q(b.x), z: q(b.z), fx: Math.sin(t.rot || 0), fz: Math.cos(t.rot || 0) };
  ed._pushUndo("放置路块");
  // 光标未动也立即按新链端刷新幽灵方向
  ed._rtGhostState = rtGhostState(ed, pt, shiftKey);
  rtUpdateGhost(ed);
  ed.status(`已放置路块（共 ${(ed.map.features.roadTiles || []).length}）· 本条道路 ${rtRoadGroupOf(ed.map.features.roadTiles, t).length} 块 · 链条延续中：Esc 断开，Ctrl+Z 撤销`);
  const el = document.getElementById("e3-props");
  if (el && el.querySelector("#ep-rt-break")) {
    el.querySelector("#ep-rt-break").disabled = false;
    const n = el.querySelector("#ep-rt-count"), c = el.querySelector("#ep-rt-chain"); // 轻量刷新统计（不整页重绘，避免打断输入）
    if (n) n.textContent = (ed.map.features.roadTiles || []).length;
    if (c) c.textContent = "延续中";
    const clr = el.querySelector("#ep-rt-clear");
    if (clr) { clr.disabled = false; clr.textContent = `一键清空本次操作（${ed._rtOpIds.length} 块）`; }
  }
}

// 重建单个路块网格（不选中/不附 gizmo）——相邻块转角变化时刷新其端头斜切
function rtRebuildTile(ed, t, miters = null) {
  const old = ed._wrappers.get(t.id);
  if (old) {
    ed._three.scene.remove(old.root);
    old.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    ed._wrappers.delete(t.id);
    for (const m of old.pickMeshes) ed._byPick.delete(m);
  }
  ed._makeWrapper("roadTile", t, buildRoadTileMesh(ed, t, false, miters));
}

// 只重建单个路块的网格（改样式/车道数用）：
// 之前走 _rebuildAll 全量重建，地图内容多时每次点面板按钮都卡一下
export function rtRebuildOne(ed, t) {
  rtRebuildTile(ed, t);
  const w = ed._wrappers.get(t.id);
  if (w) { ed.sel = w; ed._three.tc.attach(w.root); }
}

// 重建一组路块的网格（组面板批量改车道数等影响贴图的属性后调用）：
// 不走全量 _rebuildAll（地图大时卡顿），也不改变当前组选择 / 组 Gizmo
export function rtRebuildGroup(ed, tiles) {
  const miters = rtMiters(ed.map.features.roadTiles || []);
  for (const t of tiles) rtRebuildTile(ed, t, miters);
}

export function rtStart(ed) {
  ed._discardDraft();
  ed._select(null);
  ed._setTool("place-road");
  ed._rtPin = null;
  ed._rtMode = "place"; // 进入工具默认添加模式（编辑模式不跨会话保留）
  ed._rtOpIds = []; // 进入工具 = 新会话：之前的操作不可再一键清空（可用 Ctrl+Z）
  rtRenderPanel(ed);
  ed.status("路块拼接：单击落点、瞄准后再击放置 · 靠近空闲端口磁吸单击直放 · Esc 取消落点/断链/退出");
}

// 模式切换：place = 添加路块（幽灵跟随、单击放置）；edit = 编辑已放路块 / 整条路
// （无幽灵、单击不放置，改为拾取选中 + Gizmo 移动/旋转，Del 删除，Esc 逐级退回）。
export function rtSetMode(ed, mode) {
  if (ed._rtMode === mode) return;
  ed._rtMode = mode;
  ed._rtChain = null; // 切模式挂起链条：编辑打断链端，回添加后重新落点 / 磁吸
  ed._rtPin = null;
  ed._rtGhostState = null;
  rtUpdateGhost(ed); // edit 藏幽灵；place 状态空同样无害
  ed._select(null); // 面板经 _renderProps 拦截切到对应模式（place-road 无选中 → rtRenderPanel）
  if (mode === "edit") {
    ed.status("编辑模式：单击路块 / 整条路选中 · Gizmo 移动，W/E 切移动 / 旋转 · Del 删除 · Ctrl+Z 撤销 · Esc 返回添加");
  } else {
    ed.status("添加模式：单击落点、瞄准后再击放置 · 靠近空闲端口磁吸单击直放 · Esc 取消落点/断链/退出");
  }
}

// 一键清空本次操作：只移除本次链条操作（自上次链条起点）放置的路块，
// 之前加的路（更早的链条 / 其他路网 / 吸附到的旧路）不受影响。Ctrl+Z 可整体恢复。
export function rtClearCurrent(ed) {
  const set = new Set(ed._rtOpIds || []);
  if (!set.size) return;
  const tiles = ed.map.features.roadTiles || [];
  const removed = tiles.filter((t) => set.has(t.id)).length; // 撤销过的块不在数据里，按实际命中数报
  if (!removed) { ed._rtOpIds = []; rtRenderPanel(ed); return; }
  ed.map.features.roadTiles = tiles.filter((t) => !set.has(t.id));
  if (ed.sel && ed.sel.data && set.has(ed.sel.data.id)) { // 选中块被清时兜底取消选择
    ed._three.tc.detach();
    ed.sel = null;
    ed._clearGroupVisuals();
  }
  ed._rtChain = null; // 链端随块一起消失
  ed._rtPin = null;
  ed._rtOpIds = [];
  ed._rtGhostState = null;
  rtUpdateGhost(ed); // 状态已清：藏幽灵，下次移动按无链状态重算
  ed._rebuildAll(); // 剩余相邻块端头斜切按新拓扑重算（内含 rtMarkDirty）
  ed._pushUndo("清空本次操作");
  rtRenderPanel(ed);
  ed.status(`已清空本次操作（${removed} 块）· 之前加的路未受影响 · Ctrl+Z 可恢复`);
}

/* ---------------- 右侧参数面板 ---------------- */

export function rtRenderPanel(ed) {
  const el = document.getElementById("e3-props");
  const editMode = ed._rtMode === "edit";
  const modeBtn = (m, z) => `<button class="trace-seg${ed._rtMode === m ? " active" : ""}" data-rtmode="${m}">${z}</button>`;
  const styleBtn = ([k, z]) => `<button class="trace-seg${ed._rtStyle === k ? " active" : ""}" data-style="${k}">${z}</button>`;
  const numRow = (id, val, presets, attr, title) => `
    <div class="trace-wrow">
      ${presets.map((v) => `<button class="trace-w${ed[val] === v ? " active" : ""}" data-${attr}="${v}">${v}</button>`).join("")}
      <input id="${id}" type="number" min="${attr === "w" ? 6 : 1}" max="30" step="0.5" value="${ed[val]}" title="${title}" />
    </div>`;
  el.innerHTML = `
    <h4>路块拼接</h4>
    <div class="trace-row">${modeBtn("place", "添加路块")}${modeBtn("edit", "编辑 / 删除")}</div>
    ${editMode ? `
    <div class="me-stat">已放置路块 <b id="ep-rt-count">${(ed.map.features.roadTiles || []).length}</b></div>
    <p class="me-hint">编辑模式：不放置新路块。单击路块 = 单块编辑；端口连通的整条路单击 = 整条选中，可整体移动 / 旋转 / 删除，再点组内某块回到单块。Gizmo 拖动调整（W 移动 / E 旋转），单块松手自动吸附邻近端口。Del 删除选中 · Ctrl+Z 撤销 · 点空白处取消选择 · Esc 返回添加模式。</p>` : `
    <div class="trace-row">${Object.entries(TILE_STYLE_ZH).map(styleBtn).join("")}</div>
    <div class="me-stat">路块宽度（米，最小 6）</div>
    ${numRow("ep-rt-w", "_rtW", [6, 8, 10, 12], "w", "路块宽度（米，最小 6）")}
    <div class="me-stat">路块长度（米）</div>
    ${numRow("ep-rt-len", "_rtLen", [10, 15, 20, 30], "len", "路块长度（米）")}
    <div class="me-stat">角度步进（0 = 自由，Shift 临时 15°）</div>
    <div class="trace-wrow">
      ${[0, 5, 15, 45].map((v) => `<button class="trace-w${ed._rtStep === v ? " active" : ""}" data-step="${v}">${v === 0 ? "自由" : v + "°"}</button>`).join("")}
    </div>
    <div class="me-stat">每方向车道数（车道宽约 3.4m，块宽需足够）</div>
    <div class="trace-wrow">
      ${[1, 2, 3, 4].map((v) => `<button class="trace-w${(ed._rtLanes || 1) === v ? " active" : ""}" data-lanes="${v}">${v}</button>`).join("")}
    </div>
    <div class="me-stat">已放置路块 <b id="ep-rt-count">${(ed.map.features.roadTiles || []).length}</b> · 链条 <b id="ep-rt-chain">${ed._rtChain ? "延续中" : "未开始"}</b></div>
    <button class="me-btn" id="ep-rt-break" ${ed._rtChain ? "" : "disabled"}>断开链条（Esc / Enter）</button>
    <button class="me-btn" id="ep-rt-clear" ${(ed._rtOpIds || []).length ? "" : "disabled"}>一键清空本次操作${(ed._rtOpIds || []).length ? `（${ed._rtOpIds.length} 块）` : ""}</button>
    <p class="me-hint">自由放置两段式：单击钉住落点（绿环）→ 移动鼠标瞄准（方向 = 落点 → 光标，状态栏回显角度）→ 再击放置；Esc 取消落点。靠近空闲端口（短边中点）或链条延续时单击直放，方向 = 端口指向光标。方向按角度步进量化，自由模式 Shift 临时 15°；未落点时 Q / E 也可旋转。放置后从出口继续成链，Ctrl+Z 撤销上一块。「一键清空」只移除本次链条操作放置的路块，之前加的路不受影响，Ctrl+Z 可整体恢复。要编辑 / 删除已放路块，切到上方「编辑 / 删除」模式。</p>`}`;
  el.querySelectorAll("[data-rtmode]").forEach((b) => b.addEventListener("click", (e) => {
    e.currentTarget.blur();
    rtSetMode(ed, b.dataset.rtmode);
  }));
  if (editMode) return; // 编辑模式面板无其他交互元素
  const refreshGhost = () => {
    if (ed._rtGhostState) rtUpdateGhost(ed);
  };
  el.querySelectorAll("[data-style]").forEach((b) => b.addEventListener("click", () => { ed._rtStyle = b.dataset.style; rtRenderPanel(ed); refreshGhost(); }));
  el.querySelectorAll("[data-w]").forEach((b) => b.addEventListener("click", () => { ed._rtW = +b.dataset.w; rtRenderPanel(ed); refreshGhost(); }));
  el.querySelectorAll("[data-len]").forEach((b) => b.addEventListener("click", () => { ed._rtLen = +b.dataset.len; rtRenderPanel(ed); refreshGhost(); }));
  el.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => { ed._rtStep = +b.dataset.step; rtRenderPanel(ed); }));
  el.querySelectorAll("[data-lanes]").forEach((b) => b.addEventListener("click", () => { ed._rtLanes = +b.dataset.lanes; rtRenderPanel(ed); refreshGhost(); }));
  el.querySelector("#ep-rt-w").addEventListener("change", (e) => { ed._rtW = Math.min(30, Math.max(6, +e.target.value || 6)); rtRenderPanel(ed); refreshGhost(); });
  el.querySelector("#ep-rt-len").addEventListener("change", (e) => { ed._rtLen = Math.min(30, Math.max(1, +e.target.value || 3)); rtRenderPanel(ed); refreshGhost(); });
  el.querySelector("#ep-rt-break").addEventListener("click", (e) => {
    e.currentTarget.blur();
    ed._rtChain = null;
    ed.status("已断开链条：下一次单击将重新开始（靠近空闲端口仍会磁吸）");
    rtRenderPanel(ed);
  });
  el.querySelector("#ep-rt-clear").addEventListener("click", (e) => {
    e.currentTarget.blur();
    rtClearCurrent(ed);
  });
}
