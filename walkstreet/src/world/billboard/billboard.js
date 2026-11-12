import * as THREE from "three";
import { buildBillboardGroup, normalizeSpec } from "./mounts.js";
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
    // 只渲染面片正面：独立广告牌/转角屏各有朝外的面片，
    // 立面屏贴墙单面，背面不显示内容（放反时也不会露出镜像文字），
    // 背面由 mounts.js 的实心机箱挡住，不会出现"看穿整块屏"
    side: THREE.FrontSide,
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
 * 构建一块（或多块）可播放的大屏：承载形式几何 + 内容轮播 + 过渡。
 * 转角包柱屏（corner）拆成两面，返回两个独立 screen（id 带 ::A / ::B 后缀），
 * 各自有独立材质与节目单，可分别绑定不同内容。
 * 3D转角包柱屏（corner3d）是一体屏：单 screen + 两块材质，一份节目单；
 * onSwap 收到数组纹理（各面离轴 RT）时按面分配，普通纹理两面共用。
 * @returns {Array} screen 数组
 */
export function buildPlacedBillboard(city, item, pool, schedule, basePhase) {
  const spec0 = normalizeSpec(item.params);
  const isCorner = spec0.mount === "corner";
  const isCorner3d = spec0.mount === "corner3d";
  const nMats = (isCorner || isCorner3d) ? 2 : 1; // corner3d 两面各需一块材质，分别接收各自的离轴 RT
  const mats = Array.from({ length: nMats }, () => screenMaterial());
  // 3D 转角屏：屏面亮度提到满白（实验台屏体亮度同款），避免 RT 内容被 0.77 灰压暗
  if (isCorner3d) for (const m of mats) m.color.setScalar(1);
  const built = buildBillboardGroup(item, mats);
  const suffixes = isCorner ? ["::A", "::B"] : [""];

  const out = [];
  built.faceGroups.forEach((fg, i) => {
    // corner3d：一面组带两块材质（一体的两个屏面），其余形式每面一块
    const faceMats = isCorner3d
      ? built.screenMats.slice()
      : [built.screenMats[i] || built.screenMats[0]];
    // 每个面独立成屏（坐标系与合并 group 一致：局部归零 + 外层按 item.pos/rot 定位）
    const group = new THREE.Group();
    group.add(fg); // 从合并 group 移出，独立成屏
    group.position.set(item.pos[0], 0, item.pos[1]);
    group.rotation.y = item.rot || 0;

    // 碰撞体按世界 AABB 注册（编辑器传 city=null 跳过）；转角两面同范围，仅注册一次
    if (city && city.colliders && built.collider && i === 0) {
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

    let applied = false;
    let fade = createFade(faceMats, (pool.cfg && pool.cfg.transition) || 0);
    // 数组纹理（3D 裸眼）= [面A RT, 面B RT] 按面分配；普通纹理分配到所有面
    const applyTex = (tex) => {
      const arr = Array.isArray(tex) ? tex : null;
      faceMats.forEach((m, mi) => {
        m.map = arr ? (arr[mi] || arr[0]) : tex;
        if (!applied) m.needsUpdate = true; // 首次 null→texture 需重编译 program
      });
      applied = true;
    };
    const onSwap = (tex) => {
      const prev = faceMats[0].map;
      if (fade.begin(prev, tex)) return; // 过渡中：保持旧 map，由 shader 混合新图
      applyTex(tex);
    };
    const playlist = new Playlist(pool, schedule, onSwap, phaseFor(item.id + suffixes[i], basePhase), fade);

    const b = {
      id: item.id + suffixes[i],
      name: item.name || "",
      group, x: item.pos[0], z: item.pos[1],
      rot: item.rot || 0,
      screenMats: faceMats, playlist, pool,
      mount: built.spec.mount, w: built.spec.w, h: built.spec.h, y: built.spec.y,
      aspect: built.spec.w / built.spec.h,
      // 编辑器里给这块屏单独配的内容；后台未绑定该屏位时回退到这里
      localContent: (item.params && item.params.content) || null,
      contentKey: "",
    };

    /** 后台发布内容热更新：只换内容池与轮播器，不重建几何 / 不动场景节点。
     *  过渡中的 shader uniform 先归零，避免新轮播接手后残留半透明混合。 */
    b.setContent = (newPool, newSchedule, key) => {
      for (const m of faceMats) {
        const sh = m.userData.fadeShader;
        if (sh) { sh.uniforms.uMix.value = 0; sh.uniforms.uNext.value = null; }
      }
      fade = createFade(faceMats, (newPool.cfg && newPool.cfg.transition) || 0);
      // 沿用原轮播相位，但夹在新首条时长内，避免换配置后立刻又翻页
      const phase = Math.min(playlist.t, Math.max(0, (newSchedule[0]?.duration || 9) - 0.5));
      const next = new Playlist(newPool, newSchedule, onSwap, phase, fade);
      next.applyInitial();
      b.pool = newPool;
      b.playlist = next;
      b.contentKey = key;
    };

    out.push(b);
  });
  return out;
}

/** 字符串 hash → 轮播相位（同一地图每次构建错开方式一致） */
export function phaseFor(id, fallback = 0) {
  const s = String(id || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return ((h % 1000) / 1000) * 8 + fallback;
}
