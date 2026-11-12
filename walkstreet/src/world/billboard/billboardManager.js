import * as THREE from "three/webgpu";
import { createContentPool, disposeContentPool } from "./contentSource.js";
import { buildPlacedBillboard, phaseFor } from "./billboard.js";
import { normalizeSpec, corner3dWorldFaces } from "./mounts.js";
import { defaultContent, normalizeContent, contentKey, scheduleFrom } from "./contentConfig.js";

/* ---------------- 广告大屏管理器 ----------------
 * 唯一来源：编辑器手动放置（map.objects 里 type==="billboard"）。
 * 默认街区 / 空白地图不会自动生成任何广告屏；没放屏时 screens 为空。
 * 承载形式、尺寸、朝向、内容都由地图记录决定。
 * 独立广告牌/转角塔体落点由 City 在建城阶段按路网/范围纠偏并预留建筑空地
 * （见 city.js billboardPlacements），这里只按 ID 取用，不改 ID / 朝向 / 内容。
 *
 * 性能调度：
 *  - 内容池按 (屏比, 配置哈希) 缓存，相同配置的屏共享同一视频元素与纹理；
 *  - 全局最多 MAX_VIDEO_DECODE 路同时解码，按玩家距离优先，其余 video.pause()；
 *  - 离开 ACTIVE_RADIUS 的屏暂停轮播/重绘/解码；
 *  - 音频策略：off 全静音（默认） / nearest 仅最近一块屏出声 / on 全部出声。
 */

const ACTIVE_RADIUS = 300;   // 屏幕轮播/重绘/视频解码的激活半径（米）
const MAX_VIDEO_DECODE = 2;  // 全局同时解码的视频路数上限
const ASPECT_STEP = 0.05;

export class BillboardManager {
  constructor(scene, city, renderer = null) {
    this.scene = scene;
    this.city = city;
    this.renderer = renderer;   // 3D 裸眼内容源离轴渲染需要
    this._pools = new Map();
    this._refs = new WeakMap();   // 内容池引用计数：热更新释放不再使用的视频 / 纹理
    this.external = null;         // 最近一次后台发布快照
    this.group = new THREE.Group();
    scene.add(this.group);
    this.screens = [];
    this._build(city);
  }

  /** 3D 裸眼上下文：renderer + 主场景（内容层放这里，layer 隔离）+ 两面屏世界坐标四角 */
  _ctxFor(spec, pos, rot = 0) {
    return { renderer: this.renderer, scene: this.scene, faces: corner3dWorldFaces(spec, pos, rot) };
  }

  _poolFor(aspect, rawContent, ctx = null, scope = "") {
    const key = Math.round(aspect / ASPECT_STEP) * ASPECT_STEP;
    const cfg = normalizeContent(rawContent) || defaultContent();
    // 含 3D 裸眼内容的池与具体屏绑定（离轴投影依赖该屏的几何/视点），不跨屏共享
    const fullKey = (scope ? scope + "|" : "") + contentKey(cfg, key);
    if (!this._pools.has(fullKey)) this._pools.set(fullKey, createContentPool(key, cfg, ctx));
    return this._pools.get(fullKey);
  }

  _scheduleFor(pool) { return scheduleFrom(pool.cfg || defaultContent()); }

  _keyFor(aspect, cfg) { return contentKey(cfg, Math.round(aspect / ASPECT_STEP) * ASPECT_STEP); }

  _acquire(pool) { this._refs.set(pool, (this._refs.get(pool) || 0) + 1); }

  _release(pool) {
    if (!pool) return;
    const n = (this._refs.get(pool) || 0) - 1;
    if (n > 0) { this._refs.set(pool, n); return; }
    this._refs.delete(pool);
    for (const [k, v] of this._pools) if (v === pool) { this._pools.delete(k); break; }
    if (pool._active) { pool.setActive(false); pool._active = false; }
    disposeContentPool(pool);
  }

  _register(b, pool) {
    this._acquire(pool);
    b.contentKey = this._keyFor(b.aspect, pool.cfg);
    const label = { standalone: "独立广告牌", facade: "建筑立面屏", corner: "转角包柱屏", corner3d: "3D转角包柱屏" }[b.mount] || b.mount;
    if (!b.name) b.name = `${this.screens.length + 1} 号屏 · ${label}（${b.w}×${b.h}）`;
    this.group.add(b.group);
    this.screens.push(b);
  }

  /** 立面屏自动贴墙：对齐法线、贴到墙外、沿墙夹紧避免撞墙角 */
  _snapFacade(item, spec) {
    if (!this.city.colliders || !this.city.colliders.nearestWall) return item;
    if (!item.params || item.params.autoSnap === false) return item;
    const minTop = Math.max(4, spec.y - spec.h / 2);
    const wall = this.city.colliders.nearestWall(item.pos[0], item.pos[1], 12, minTop);
    if (!wall) return item;
    const rot = Math.atan2(wall.nx, wall.nz);
    let px = wall.px, pz = wall.pz;
    const half = spec.w / 2 + 0.8;
    const lo = wall.min + half, hi = wall.max - half;
    const center = (wall.min + wall.max) / 2;
    if (wall.along === "x") px = lo <= hi ? Math.min(hi, Math.max(lo, px)) : center;
    else pz = lo <= hi ? Math.min(hi, Math.max(lo, pz)) : center;
    return { ...item, pos: [px, pz], rot };
  }

  /** 兜底（仅当 City 未提供 billboardPlacements，例如非 City 调用 / 老数据）：
   *  屏体水平包络若插进建筑，沿最浅方向推出并留 0.6m 间隙。
   *  正常链路已在建城阶段把屏体占位登记为建筑排除区，不会走到这里。 */
  _avoidBuildings(item, spec) {
    if (spec.mount === "facade") return item;
    const grid = this.city.colliders;
    if (!grid || !grid.overlaps) return item;
    const corner = spec.mount === "corner" || spec.mount === "corner3d";
    const halfW = corner ? (spec.w + 1.4) / 2 + 0.1 : spec.w / 2 + 0.5;
    const halfD = corner ? halfW : 0.8;
    // 屏底以下的矮碰撞体（树 5m / 路灯 6m）不会插到屏面；塔体落地按 7m 过滤
    const minTop = corner ? 7 : Math.max(7, spec.y - spec.h / 2 - 0.5);
    const rot = item.rot || 0, cs = Math.cos(rot), sn = Math.sin(rot);
    const GAP = 0.6;
    let px = item.pos[0], pz = item.pos[1];
    for (let pass = 0; pass < 6; pass++) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const [lx, lz] of [[-halfW, -halfD], [halfW, -halfD], [halfW, halfD], [-halfW, halfD]]) {
        const wx = px + lx * cs + lz * sn, wz = pz - lx * sn + lz * cs;
        if (wx < x0) x0 = wx; if (wx > x1) x1 = wx;
        if (wz < z0) z0 = wz; if (wz > z1) z1 = wz;
      }
      const hits = grid.overlaps(x0, z0, x1, z1, minTop);
      if (!hits.length) break;
      // 先处理重叠面积最大的那栋，一轮推一次，下一轮再处理其余
      let b = hits[0], best = 0;
      for (const r of hits) {
        const area = (Math.min(x1, r[2]) - Math.max(x0, r[0])) * (Math.min(z1, r[3]) - Math.max(z0, r[1]));
        if (area > best) { best = area; b = r; }
      }
      const moves = [
        [b[0] - GAP - x1, 0],  // 推到建筑 -X 侧
        [b[2] + GAP - x0, 0],  // 推到建筑 +X 侧
        [0, b[1] - GAP - z1],  // 推到建筑 -Z 侧
        [0, b[3] + GAP - z0],  // 推到建筑 +Z 侧
      ];
      moves.sort((a, c) => Math.abs(a[0] + a[1]) - Math.abs(c[0] + c[1]));
      px += moves[0][0]; pz += moves[0][1];
    }
    if (px === item.pos[0] && pz === item.pos[1]) return item;
    return { ...item, pos: [Math.round(px * 10) / 10, Math.round(pz * 10) / 10] };
  }

  _build(city) {
    // 只认地图里手动放置的记录；没有就一块都不建（默认街区亦然）
    const placed = ((city.data && city.data.objects) || []).filter((o) => o && o.type === "billboard");
    if (!placed.length) return;
    // 立面屏贴墙；落地屏用建城阶段算好的路缘落点（建筑空地已预留）。
    // placements 缺失时（老地图 / 非 City 调用）退回旧的「撞楼推开」兜底。
    const placements = city.billboardPlacements || null;
    const items = placed.map((item) => {
      const spec = normalizeSpec(item.params);
      if (spec.mount === "facade") return this._snapFacade(item, spec);
      const pos = placements && placements.get(item.id);
      return pos ? { ...item, pos } : this._avoidBuildings(item, spec);
    });
    items.forEach((item, i) => {
      const spec = normalizeSpec(item.params);
      // 3D 转角包柱屏：注入离轴渲染上下文并按屏隔离内容池
      const is3d = spec.mount === "corner3d";
      const ctx = is3d ? this._ctxFor(spec, item.pos, item.rot || 0) : null;
      const scope = is3d ? item.id : "";
      const pool = this._poolFor(spec.w / spec.h, item.params && item.params.content, ctx, scope);
      // 转角屏返回两块独立屏（转角A / 转角B），各自有独立材质与节目单；
      // 3D转角包柱屏是一体屏，只返回一块
      const screens = buildPlacedBillboard(city, item, pool, this._scheduleFor(pool), phaseFor(item.id, i * 1.7));
      screens.forEach((b, fi) => {
        this._register(b, pool);
        if (spec.mount === "corner") b.name = b.name + (fi === 0 ? " · 转角A" : " · 转角B");
      });
    });
    if (this.external) this.applyExternal(this.external);
    this._powerOn();
  }

  _powerOn() { for (const s of this.screens) s.playlist.applyInitial(); }

  /** 应用后台发布快照：按屏位 ID 匹配内容，未绑定的屏回退到地图内配置 / 默认节目单。
   *  返回 { applied, changed, screens }，供终端 ACK 上报。 */
  applyExternal(byId = {}) {
    this.external = byId || {};
    let applied = 0, changed = 0;
    for (const s of this.screens) {
      const has = !!(byId && byId[s.id]);
      const cfg = normalizeContent(has ? byId[s.id] : s.localContent) || defaultContent();
      const key = this._keyFor(s.aspect, cfg);
      if (has) applied++;
      if (s.contentKey === key) continue;   // 内容没变：不重建纹理 / 不打断视频
      const is3d = s.mount === "corner3d";
      const ctx = is3d ? this._ctxFor({ w: s.w, h: s.h, y: s.y }, [s.x, s.z], s.rot) : null;
      const scope = is3d ? s.id : "";
      const pool = this._poolFor(s.aspect, cfg, ctx, scope);
      if (pool === s.pool) continue;
      const old = s.pool;
      this._acquire(pool);
      s.setContent(pool, this._scheduleFor(pool), key);
      this._release(old);
      changed++;
    }
    return { applied, changed, screens: this.screens.length };
  }

  /** 每帧更新：轮播 / 动画 / 视频并发调度 / 音频策略 */
  update(dt, time, focus) {
    if (!this.screens.length) return;
    for (const pool of this._pools.values()) {
      pool._wanted = false;
      pool._dist = Infinity;
    }
    for (const s of this.screens) {
      const dx = s.x - focus.x, dz = s.z - focus.z;
      const d2 = dx * dx + dz * dz;
      const near = d2 < ACTIVE_RADIUS * ACTIVE_RADIUS;
      if (near && !s._near) s.playlist.wake();
      s._near = near;
      if (!near || !s.pool) continue;
      s.playlist.update(dt, true);
      s.playlist.focus = focus; // 3D 裸眼内容源据此取虚拟眼睛（翻页刷新也用）
      s.pool._wanted = true;
      if (d2 < s.pool._dist * s.pool._dist) s.pool._dist = Math.sqrt(d2);
      for (const item of s.pool) if (item.kind === "animated") item.update(dt, time, focus);
    }

    // 视频解码并发上限：按最近使用屏的距离排序，只放行前 MAX_VIDEO_DECODE 路
    const videoPools = [...this._pools.values()].filter((p) => p.hasVideo);
    videoPools.sort((a, b) => a._dist - b._dist);
    videoPools.forEach((p, i) => {
      const on = p._wanted && i < MAX_VIDEO_DECODE;
      if (p._active !== on) { p.setActive(on); p._active = on; }
    });

    // 音频：off 全静音；nearest 仅最近的一块屏出声；on 全部出声
    const audible = videoPools.filter((p) => p.cfg && p.cfg.audio !== "off" && p._active);
    const nearest = audible.length ? audible.reduce((a, b) => (a._dist <= b._dist ? a : b)) : null;
    for (const p of videoPools) {
      const mode = p.cfg && p.cfg.audio;
      const on = p._active && (mode === "on" || (mode === "nearest" && p === nearest));
      if (p._audio !== on) { p.setAudio(on); p._audio = on; }
    }
  }

  dispose() {
    this.scene.remove(this.group);
    for (const pool of this._pools.values()) disposeContentPool(pool);
    this._pools.clear();
    this._refs = new WeakMap();
    this.external = null;
    this.screens = [];
  }
}
