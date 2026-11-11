import * as THREE from "three";
import { createContentPool, disposeContentPool } from "./contentSource.js";
import { buildPlacedBillboard, phaseFor } from "./billboard.js";
import { normalizeSpec } from "./mounts.js";
import { defaultContent, normalizeContent, contentKey, scheduleFrom } from "./contentConfig.js";

/* ---------------- 广告大屏管理器 ----------------
 * 唯一来源：编辑器手动放置（map.objects 里 type==="billboard"）。
 * 默认街区 / 空白地图不会自动生成任何广告屏；没放屏时 screens 为空。
 * 承载形式、尺寸、朝向、内容都由地图记录决定。
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
  constructor(scene, city) {
    this.scene = scene;
    this.city = city;
    this._pools = new Map();
    this._refs = new WeakMap();   // 内容池引用计数：热更新释放不再使用的视频 / 纹理
    this.external = null;         // 最近一次后台发布快照
    this.group = new THREE.Group();
    scene.add(this.group);
    this.screens = [];
    this._build(city);
  }

  _poolFor(aspect, rawContent) {
    const key = Math.round(aspect / ASPECT_STEP) * ASPECT_STEP;
    const cfg = normalizeContent(rawContent) || defaultContent();
    const fullKey = contentKey(cfg, key);
    if (!this._pools.has(fullKey)) this._pools.set(fullKey, createContentPool(key, cfg));
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
    const label = { standalone: "独立广告牌", facade: "建筑立面屏", corner: "转角包柱屏" }[b.mount] || b.mount;
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

  _build(city) {
    // 只认地图里手动放置的记录；没有就一块都不建（默认街区亦然）
    const placed = ((city.data && city.data.objects) || []).filter((o) => o && o.type === "billboard");
    if (!placed.length) return;
    // 先批量算贴墙（此时未注册大屏碰撞体，避免屏与屏互相吸附）
    const items = placed.map((item) => {
      const spec = normalizeSpec(item.params);
      return spec.mount === "facade" ? this._snapFacade(item, spec) : item;
    });
    items.forEach((item, i) => {
      const spec = normalizeSpec(item.params);
      const pool = this._poolFor(spec.w / spec.h, item.params && item.params.content);
      const b = buildPlacedBillboard(city, item, pool, this._scheduleFor(pool), phaseFor(item.id, i * 1.7));
      this._register(b, pool);
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
      const pool = this._poolFor(s.aspect, cfg);
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
      s.pool._wanted = true;
      if (d2 < s.pool._dist * s.pool._dist) s.pool._dist = Math.sqrt(d2);
      for (const item of s.pool) if (item.kind === "animated") item.update(dt, time);
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
