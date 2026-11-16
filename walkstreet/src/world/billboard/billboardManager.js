import * as THREE from "three";
import { createContentPool, disposeContentPool } from "./contentSource.js";
import { buildPlacedBillboard, phaseFor } from "./billboard.js";
import { normalizeSpec, corner3dWorldFaces, corner3dWorldArcSamples } from "./mounts.js";
import { defaultContent, normalizeContent, contentKey, scheduleFrom } from "./contentConfig.js";
import { getRenderSettings } from "../../config/renderSettings.js";
import { getAssetRecordSync } from "../../data/assetStore.js";
import { billboardParamsFor } from "../../data/billboardAsset.js";

/* ---------------- 广告大屏管理器 ----------------
 * 唯一来源：编辑器手动放置（map.objects 里 type==="billboard"）。
 * 默认街区 / 空白地图不会自动生成任何广告屏；没放屏时 screens 为空。
 * 承载形式、尺寸、朝向、内容都由地图记录决定。
 * 独立广告牌/转角塔体落点由 City 在建城阶段按路网/范围纠偏并预留建筑空地
 * （见 city.js billboardPlacements），这里只按 ID 取用，不改 ID / 朝向 / 内容。
 *
 * 性能调度：
 *  - 内容池按 (屏比, 配置哈希) 缓存，相同配置的屏共享同一视频元素与纹理；
 *  - 屏幕轮播/重绘/解码只在激活半径内进行（画面设置 billboardRadius，默认 300m），
 *    超出半径的屏零成本定格；
 *  - 半径内再按视频解码并发（画面设置 videoDecode，默认 2）以玩家距离优先放行，
 *    其余 video.pause()；
 *  - 音频策略：off 全静音（默认） / nearest 仅最近一块屏出声 / on 全部出声。
 */

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
    return {
      renderer: this.renderer,
      scene: this.scene,
      faces: corner3dWorldFaces(spec, pos, rot),
      // 圆角屏：真实屏面折线采样点（世界坐标），content3d 据此求每路 RT 取景框；
      // 直角屏（半径 0）为 null，改用参考面四角。
      arcPts: spec.arc > 0 ? corner3dWorldArcSamples(spec, pos, rot) : null,
    };
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

  /** 挂到别的建筑 / 资产模型上：宿主世界变换 + 局部偏移。
   *  广告牌实例只存 hostId 与局部偏移，宿主编排完全独立 —— 几何 / 内容 / 素材 / 后台四层不动。
   *  返回 null = 该对象未指定宿主（走原来的贴墙 / 落点逻辑）。 */
  _hostTransform(item, spec, city) {
    const hostId = item.hostId;
    if (!hostId || !city || !city.data) return null;
    const host = (city.data.objects || []).find((o) => o && o.id === hostId);
    if (!host) return null;
    let hx = 0, hz = 0;
    if (Array.isArray(host.pos)) {
      hx = host.pos[0]; hz = host.pos[1];
    } else if (host.params && Array.isArray(host.params.footprint) && host.params.footprint.length) {
      // 描边建筑：以 footprint 质心为锚点
      for (const [x, z] of host.params.footprint) { hx += x; hz += z; }
      hx /= host.params.footprint.length; hz /= host.params.footprint.length;
    }
    const hrot = host.rot || 0;
    const local = item.local || {};
    const lp = Array.isArray(local.pos) ? local.pos : [0, 0, 0];
    const c = Math.cos(hrot), s = Math.sin(hrot);
    const px = hx + lp[0] * c + (lp[2] || 0) * s;
    const pz = hz - lp[0] * s + (lp[2] || 0) * c;
    const dy = lp[1] || 0;
    const params = dy ? { ...item.params, y: (spec.y || 0) + dy } : item.params;
    return {
      ...item, pos: [px, pz], rot: hrot + (local.rot || 0), params,
      hostId, local: { ...local },
    };
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
    // 只认地图里手动放置的记录；没有就一块都不建（默认街区亦然）。
    // 新记录只存 { assetId, contentRef }，几何规格从资产库同步缓存读（预热阶段已填）；
    // 老记录内联 params 仍然兼容 —— 存量地图不会失效。
    const placed = ((city.data && city.data.objects) || []).filter((o) => o && o.type === "billboard");
    if (!placed.length) return;
    // 立面屏贴墙；落地屏用建城阶段算好的路缘落点（建筑空地已预留）。
    // placements 缺失时（老地图 / 非 City 调用）退回旧的「撞楼推开」兜底。
    const placements = city.billboardPlacements || null;
    const items = placed.map((raw) => {
      const asset = raw.assetId ? getAssetRecordSync(raw.assetId) : null;
      const item = {
        ...raw,
        params: billboardParamsFor(raw, asset),
        assetId: raw.assetId || null,
        hostId: raw.hostId || null,
      };
      const spec = normalizeSpec(item.params);
      // 挂到建筑 / 资产模型：宿主的变换就是广告牌的基准，跳过贴墙与避让
      const hosted = this._hostTransform(item, spec, city);
      if (hosted) return hosted;
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
  applyExternal(byId = {}, force = false) {
    this.external = byId || {};
    let applied = 0, changed = 0;
    for (const s of this.screens) {
      const has = !!(byId && byId[s.id]);
      const cfg = normalizeContent(has ? byId[s.id] : s.localContent) || defaultContent();
      const key = this._keyFor(s.aspect, cfg);
      if (has) applied++;
      // 转角弧度：模型资产是默认值；后台 d3.arc 只是临时校准覆盖（null = 跟随模型）。
      // 只重建屏体几何，参考平面不变 → RT 无需重渲，不会闪。
      const arcOverride = cfg.d3 ? cfg.d3.arc : null;
      const arcR = arcOverride == null ? (s.modelArc || 0) : arcOverride;
      if (s.setArc) s.setArc(arcR);
      if (!force && s.contentKey === key) continue;   // 内容没变：不重建纹理 / 不打断视频
      const is3d = s.mount === "corner3d";
      const ctx = is3d ? this._ctxFor({ w: s.w, h: s.h, y: s.y, arc: s.arcRadius != null ? s.arcRadius : arcR }, [s.x, s.z], s.rot) : null;
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

  /**
   * 每帧更新：轮播 / 动画 / 视频并发调度 / 音频策略（半径与解码路数都是画面设置热调）
   * @param {THREE.Camera|null} camera 取景相机 —— 3D 裸眼虚拟眼睛（实时追踪档）与双路预览布局用
   */
  update(dt, time, focus, camera = null) {
    if (!this.screens.length) return;
    // 屏幕激活半径（画面设置，每帧读取，改完立即生效）
    const activeRadius = Math.max(1, Math.round(getRenderSettings().billboardRadius ?? 300));
    for (const pool of this._pools.values()) {
      pool._wanted = false;
      pool._dist = Infinity;
    }
    for (const s of this.screens) {
      const dx = s.x - focus.x, dz = s.z - focus.z;
      const d2 = dx * dx + dz * dz;
      const near = d2 < activeRadius * activeRadius;
      if (near && !s._near) s.playlist.wake();
      s._near = near;
      if (!near || !s.pool) continue;
      s.playlist.focus = focus;
      s.playlist.eye = camera; // 换页 / 唤醒刷新同样用最新眼睛
      s.playlist.update(dt, true);
      s.pool._wanted = true;
      if (d2 < s.pool._dist * s.pool._dist) s.pool._dist = Math.sqrt(d2);
      // 3D 条目（离轴双路 RT）渲染开销大：只有当前轮播条目重绘；
      // 视线/眼位辅助线也只跟随当前条目
      const slot = s.playlist.schedule[s.playlist.cur];
      const curIdx = slot ? slot.idx : 0;
      for (let ii = 0; ii < s.pool.length; ii++) {
        const item = s.pool[ii];
        if (item.is3d) {
          if (item.helper) {
            item.helper.visible = ii === curIdx && !!(s.pool.cfg.d3 && s.pool.cfg.d3.helper);
          }
          if (ii !== curIdx || item.kind !== "animated") continue;
        }
        if (item.kind === "animated") {
          item.update(dt, time, focus, camera);
          // 圆角屏：用这一帧 RT 渲染所用的同一组离轴矩阵重投影屏面 UV。
          // 批次号相同则内部直接返回 —— 眼位不动 / 内容静止时零开销。
          if (s.arc && item.is3d && item.faceMatrices) {
            s.arc.updateProj(item.faceMatrices, item.projSeq);
          }
        }
      }
    }

    // 视频解码并发上限（画面设置热调，每帧读取，改完立即生效）：
    // 按最近使用屏的距离排序，只放行前 videoDecode 路
    const maxDecode = Math.max(0, Math.round(getRenderSettings().videoDecode ?? 2));
    const videoPools = [...this._pools.values()].filter((p) => p.hasVideo);
    videoPools.sort((a, b) => a._dist - b._dist);
    videoPools.forEach((p, i) => {
      const on = p._wanted && i < maxDecode;
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

    this._updateHud(camera);
  }

  _ensureHud(camera) {
    const g = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      const q = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false, toneMapped: false, fog: false }),
      );
      q.renderOrder = 999;
      q.frustumCulled = false;
      q.visible = false;
      g.add(q);
    }
    g.visible = false;
    camera.add(g);
    this._hud = g;
    this._hudCam = camera;
  }

  /** 右下角双路预览（实验台 hudScene 同款）：最多两块 3D 屏，各显示 A/B 两路离轴 RT */
  _updateHud(camera) {
    const wants = [];
    for (const s of this.screens) {
      const pool = s.pool;
      if (!pool || !pool.cfg || !pool.cfg.d3 || !pool.cfg.d3.hud) continue;
      const slot = s.playlist.schedule[s.playlist.cur];
      const it = slot ? pool[slot.idx] : null;
      if (it && it.is3d && Array.isArray(it.texture)) {
        // faceFit = 每路内容区域占 RT 的宽 / 高比例，预览要裁到同一块区域
        wants.push({ texs: it.texture, fit: it.faceFit });
      }
      if (wants.length >= 2) break;
    }
    if (!wants.length) { if (this._hud) this._hud.visible = false; return; }
    if (!this._hud) this._ensureHud(camera);
    if (this._hudCam !== camera) { // 世界重建后换了相机实例：重新挂载
      if (this._hud.parent) this._hud.parent.remove(this._hud);
      camera.add(this._hud);
      this._hudCam = camera;
    }
    const quads = this._hud.children;
    wants.forEach((w, si) => {
      const texs = w.texs;
      for (let fi = 0; fi < 2; fi++) {
        const q = quads[si * 2 + fi];
        q.visible = !!texs[fi];
        if (q.visible && q.material.map !== texs[fi]) { q.material.map = texs[fi]; q.material.needsUpdate = true; }
        if (!q.visible) continue;
        /* 实验台 applyHudUv 同款：预览裁到该路 RT 的内容区域，否则会显示
         * 大片清屏底色。几何 UV 先存一份原值，按 fx/fy 绕中心缩放；只在
         * 比例变化时写缓冲，静态片源不产生逐帧上传。 */
        const f = w.fit && w.fit[fi];
        const fx = f ? f.fx : 1, fy = f ? f.fy : 1;
        if (q.userData.cfx === fx && q.userData.cfy === fy) continue;
        q.userData.cfx = fx; q.userData.cfy = fy;
        const g = q.geometry, a = g.getAttribute("uv");
        if (!g.userData.uv0) g.userData.uv0 = Float32Array.from(a.array);
        const o = g.userData.uv0;
        for (let k = 0; k < o.length; k += 2) {
          a.array[k] = 0.5 + (o[k] - 0.5) * fx;
          a.array[k + 1] = 0.5 + (o[k + 1] - 0.5) * fy;
        }
        a.needsUpdate = true;
      }
    });
    for (let i = wants.length * 2; i < quads.length; i++) quads[i].visible = false;
    this._hud.visible = true;
    // 布局：右下角，每块屏两路并排，第二块屏叠在上方（按相机 fov / 宽高比换算）
    const hh = Math.tan((camera.fov / 2) * Math.PI / 180);
    const hw = hh * camera.aspect;
    const qw = hw * 0.17, qh = qw * (512 / 768), mx = hw * 0.025, my = hh * 0.035;
    quads.forEach((q, i) => {
      if (!q.visible) return;
      const si = Math.floor(i / 2), fi = i % 2;
      q.scale.set(qw, qh, 1);
      q.position.set(hw - mx - qw / 2 - fi * (qw + mx), -hh + my + qh / 2 + si * (qh + my), -1);
    });
  }

  dispose() {
    this.scene.remove(this.group);
    for (const pool of this._pools.values()) disposeContentPool(pool);
    this._pools.clear();
    this._refs = new WeakMap();
    this.external = null;
    this.screens = [];
    if (this._hud) { // 双路预览挂在相机上，随世界一起释放
      if (this._hud.parent) this._hud.parent.remove(this._hud);
      this._hud.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      this._hud = null;
      this._hudCam = null;
    }
  }
}
