import * as THREE from "three";
import { buildBillboardGroup } from "./mounts.js";
import { Playlist } from "./playlist.js";

/* ---------------- 大屏构建（运行时） ----------------
 * 只处理编辑器手动放置的 objects 记录 { type:"billboard", pos, rot, params:{mount,w,h,y} }
 * 并经承载形式注册表（mounts.js）构建；没有记录就不建屏。
 */

/** 屏幕材质：onBeforeCompile 注入第二张纹理 + uMix，实现单面片 shader 交叉淡入。
 *  保留 MeshBasicMaterial 的 toneMapped:false / 色彩空间 / Bloom 行为。 */
function screenMaterial() {
  const m = new THREE.MeshBasicMaterial({
    // 白色纯亮度会吃满夜景 Bloom（main.js 夜间 strength≈0.92）导致近景过曝
    color: 0xc4c4c4,
    toneMapped: false,
    side: THREE.DoubleSide,
    map: null,
  });
  m.userData.fadeShader = null;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNext = { value: null };
    shader.uniforms.uMix = { value: 0 };
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform sampler2D uNext;\nuniform float uMix;")
      .replace("#include <map_fragment>", `#include <map_fragment>
        if (uMix > 0.0) {
          vec4 nxt = texture2D(uNext, vMapUv);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuse * nxt.rgb, uMix);
        }`);
    m.userData.fadeShader = shader;
  };
  return m;
}

/** 交叉淡入控制器：过渡期间保持旧 map，用 uNext+uMix 混合，结束后换 map */
function createFade(mats, duration) {
  let next = null, mix = 0;
  const commit = () => {
    for (const m of mats) m.map = next;
    const sh = mats[0].userData.fadeShader;
    if (sh) sh.uniforms.uMix.value = 0;
    next = null; mix = 0;
  };
  return {
    /** @returns {boolean} true = 交给过渡处理，调用方不要立刻换 map */
    begin(prev, tex) {
      if (next) commit(); // 上一轮过渡尚未结束又被切：先落定
      const sh = mats[0].userData.fadeShader;
      if (duration <= 0 || !prev || prev === tex || !sh) return false;
      next = tex; mix = 0;
      sh.uniforms.uNext.value = tex;
      sh.uniforms.uMix.value = 0;
      return true;
    },
    advance(dt) {
      if (!next) return;
      mix = Math.min(1, mix + dt / duration);
      const sh = mats[0].userData.fadeShader;
      if (sh) sh.uniforms.uMix.value = mix;
      if (mix >= 1) commit();
    },
  };
}

/**
 * 构建一块可播放的大屏：承载形式几何 + 内容轮播 + 过渡。
 */
export function buildPlacedBillboard(city, item, pool, schedule, phase) {
  const screenMat = screenMaterial();
  const built = buildBillboardGroup(item, screenMat);
  const mats = built.screenMats;

  // 碰撞体按世界 AABB 注册（编辑器传 city=null 跳过）：四角包络，适配贴墙旋转
  if (city && city.colliders && built.collider) {
    const c = built.collider;
    const rot = item.rot || 0, cs = Math.cos(rot), sn = Math.sin(rot);
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const [lx, lz] of [[c.x0, c.z0], [c.x1, c.z0], [c.x1, c.z1], [c.x0, c.z1]]) {
      const wx = item.pos[0] + lx * cs + lz * sn;
      const wz = item.pos[1] - lx * sn + lz * cs;
      if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
      if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
    }
    city.colliders.add(minX, minZ, maxX, maxZ, c.top);
  }

  let fade = createFade(mats, (pool.cfg && pool.cfg.transition) || 0);
  let applied = false;
  const onSwap = (tex) => {
    const prev = mats[0].map;
    if (fade.begin(prev, tex)) return; // 过渡中：保持旧 map，由 shader 混合新图
    for (const m of mats) {
      m.map = tex;
      if (!applied) m.needsUpdate = true; // 首次 null→texture 需重编译 program
    }
    applied = true;
  };
  const playlist = new Playlist(pool, schedule, onSwap, phase, fade);

  const b = {
    id: item.id || "",
    name: item.name || "",
    group: built.group,
    x: item.pos[0], z: item.pos[1],
    screenMats: mats, playlist, pool,
    mount: built.spec.mount, w: built.spec.w, h: built.spec.h,
    aspect: built.spec.w / built.spec.h,
    // 编辑器里给这块屏单独配的内容；后台未绑定该屏位时回退到这里
    localContent: (item.params && item.params.content) || null,
    contentKey: "",
  };

  /** 后台发布内容热更新：只换内容池与轮播器，不重建几何 / 不动场景节点。
   *  过渡中的 shader uniform 先归零，避免新轮播接手后残留半透明混合。 */
  b.setContent = (newPool, newSchedule, key) => {
    const sh = mats[0].userData.fadeShader;
    if (sh) { sh.uniforms.uMix.value = 0; sh.uniforms.uNext.value = null; }
    fade = createFade(mats, (newPool.cfg && newPool.cfg.transition) || 0);
    // 沿用原轮播相位，但夹在新首条时长内，避免换配置后立刻又翻页
    const phase = Math.min(playlist.t, Math.max(0, (newSchedule[0]?.duration || 9) - 0.5));
    const next = new Playlist(newPool, newSchedule, onSwap, phase, fade);
    next.applyInitial();
    b.pool = newPool;
    b.playlist = next;
    b.contentKey = key;
  };

  return b;
}

/** 字符串 hash → 轮播相位（同一地图每次构建错开方式一致） */
export function phaseFor(id, fallback = 0) {
  const s = String(id || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return ((h % 1000) / 1000) * 8 + fallback;
}
