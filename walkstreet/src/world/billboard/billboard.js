import * as THREE from "three/webgpu";
import { texture as tslTexture, uniform as tslUniform, mix as tslMix, uv, select } from "three/tsl";
import { buildBillboardGroup, normalizeSpec } from "./mounts.js";
import { Playlist } from "./playlist.js";
import { DEBUG_3D, rtFlipNeeded } from "./content3d.js";

/* 诊断模式 1：两面屏直接上测试图案（不经过 RT 内容），验证两面屏几何/UV/
 * 纹理分配是否正常。图案含网格（看变形/偏移）、"▲ TOP"（看上下颠倒）、
 * FACE A/B 大字（看两面分配）。只创建一次并缓存：早期版本每次 onSwap 都新建
 * CanvasTexture 且从不 dispose，换页会持续累积显存。 */
function makeDebugFaceTex(i) {
  const is3d = i >= 0; // 0/1 = RT 数组两面的测试图；2 = 普通 2D 内容（两面同图）
  const c = document.createElement("canvas");
  c.width = 768; c.height = 512;
  const x = c.getContext("2d");
  x.fillStyle = i === 0 ? "#7a1f1f" : i === 1 ? "#1f5a2a" : "#1f2a7a";
  x.fillRect(0, 0, 768, 512);
  x.strokeStyle = "rgba(255,255,255,0.35)";
  x.lineWidth = 2;
  for (let gx = 0; gx <= 768; gx += 64) { x.beginPath(); x.moveTo(gx, 0); x.lineTo(gx, 512); x.stroke(); }
  for (let gy = 0; gy <= 512; gy += 64) { x.beginPath(); x.moveTo(0, gy); x.lineTo(768, gy); x.stroke(); }
  x.fillStyle = "#ffffff";
  x.font = "bold 90px sans-serif"; x.textAlign = "center";
  x.fillText("▲ TOP", 384, 110);
  x.font = "bold 150px sans-serif";
  x.fillText(is3d ? (i === 0 ? "FACE A" : "FACE B") : "2D CONTENT", 384, 300);
  x.font = "bold 60px sans-serif";
  x.fillText(is3d ? (i === 0 ? "红=面A" : "绿=面B") : "蓝=普通2D内容", 384, 420);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
let _debugFaceTexs = null;
function debugFaceTexs() {
  if (!_debugFaceTexs) _debugFaceTexs = [makeDebugFaceTex(0), makeDebugFaceTex(1), makeDebugFaceTex(2)];
  return _debugFaceTexs;
}

/* ---------------- 大屏构建（运行时） ----------------
 * 只处理编辑器手动放置的 objects 记录 { type:"billboard", pos, rot, params:{mount,w,h,y} }
 * 并经承载形式注册表（mounts.js）构建；没有记录就不建屏。
 */

/* 白色占位纹理：TSL 纹理节点首次编译时不能是空值。
 * 注意必须每次新建：TextureNode 的 uniform hash = value.uuid，cur/nxt 若共用
 * 同一张占位纹理会被合并成一个纹理绑定，交叉淡入就永远只有一张图在生效。 */
function whiteTex() {
  const c = document.createElement("canvas");
  c.width = c.height = 2;
  const x = c.getContext("2d");
  x.fillStyle = "#fff";
  x.fillRect(0, 0, 2, 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 屏幕材质：TSL 节点混合（cur → next 按 uMix 交叉淡入），替代 dev 版
 *  的 onBeforeCompile GLSL 注入（WebGPU 不走 onBeforeCompile）。
 *  保留 toneMapped:false / 色彩空间 / Bloom 行为。
 *
 *  必须用 MeshBasicNodeMaterial：普通 MeshBasicMaterial 的 customProgramCacheKey()
 *  只看 onBeforeCompile + 材质属性，两块参数相同的屏面材质会算出同一个 key，
 *  WebGPU 的 NodeBuilderState 缓存因此复用同一份已编译节点图（连同 cur 纹理绑定），
 *  导致 3D转角屏两面采样同一张 RT —— 画面变成分开的左右两块。
 *  NodeMaterial 的 key 含 colorNode 节点图哈希，每块材质独立，绑定才各自生效。 */
function screenMaterial() {
  const m = new THREE.MeshBasicNodeMaterial({
    // 白色纯亮度会吃满夜景 Bloom（main.js 夜间 strength≈0.92）导致近景过曝
    color: 0xc4c4c4,
    toneMapped: false,
    // 只渲染面片正面：独立广告牌/转角屏各有朝外的面片，
    // 背面由 mounts.js 的实心机箱挡住，不会出现"看穿整块屏"
    side: THREE.FrontSide,
    map: null,
  });
  // 纹理节点换图 = 换 .value（uniform 更新，不触发管线重编）。
  // 离轴 RT 纹理在 WebGL 回退后端会被 TextureNode 自动 flipY 一次（GLSL 的
  // isFlipY()===true），但 RT 内容本身方向正确，多翻这一下会让整幅画面上下颠倒。
  // 这里用两个动态 uniform 选择 UV：命中 RT 时预先翻一次 Y，与 TextureNode 的
  // 自动翻转抵消；普通 Canvas / VideoTexture 走原 UV。select 是静态节点图 +
  // uniform 切换，不触发管线重编译；cur / nxt 各自独立，支持过渡期两类纹理混用。
  const curRT = tslUniform(0), nxtRT = tslUniform(0);
  const uvFor = (isRT) => select(isRT.greaterThan(0.5), uv().flipY(), uv());
  const cur = tslTexture(whiteTex(), uvFor(curRT));
  const nxt = tslTexture(whiteTex(), uvFor(nxtRT));
  const uMix = tslUniform(0);
  m.userData.fadeTex = { cur, nxt, uMix, curRT, nxtRT };
  // 亮度系数直接取 material.color：不能用 materialColor 节点 —— 它内部会把
  // material.map 一起采样，而 map 正是 cur 指向的那张图，画面会被平方压暗。
  m.colorNode = tslMix(cur.rgb, nxt.rgb, uMix).mul(tslUniform(m.color));
  return m;
}

/** 当前纹理是否需要屏面 UV 反向补偿：仅「离轴 RT 纹理 + WebGL 回退后端」 */
function rtCompensation(t) {
  return (t && t.isRenderTargetTexture === true && rtFlipNeeded()) ? 1 : 0;
}

/** 整屏平面展示 UV：两面拼成一张画布（实验台 applyPlaneUv 同款）。
 *  A 面取画布左半 u[0,0.5]，B 面取右半 u[0.5,1]；half=null 恢复整幅 u[0,1]。
 *  纯几何属性，与渲染后端无关。原始 UV 缓存在 mesh.userData.uv0。 */
function applyPlaneUV(mesh, half) {
  if (!mesh || !mesh.geometry || !mesh.geometry.attributes.uv) return;
  const attr = mesh.geometry.attributes.uv;
  if (!mesh.userData.uv0) mesh.userData.uv0 = attr.array.slice();
  const src = mesh.userData.uv0, dst = attr.array;
  for (let k = 0; k < src.length; k += 2) {
    const u = src[k];
    dst[k] = half === 0 ? u * 0.5 : half === 1 ? 0.5 + u * 0.5 : u;
    dst[k + 1] = src[k + 1];
  }
  attr.needsUpdate = true;
}

/** 交叉淡入控制器：过渡期间保持旧图（cur），按 uMix 混入新图（nxt），结束后换 map。
 *  纹理一律按面展开为 [面0, 面1, ...]（3D 裸眼 = 各面离轴 RT，普通内容 = 每面同张）；
 *  每块材质各有自己的 cur/nxt/uMix 节点，必须逐面写入 —— 此前只写 mats[0] 会让
 *  第二面永不混合；而把数组原样塞进 TSL 纹理节点会绑到无效采样单元，
 *  GPU 保留旧绑定 → 上一条内容的冻结帧永远残留在屏面上。 */
function createFade(mats, duration) {
  let nextTexs = null, mix = 0;
  const fadeOf = (m) => m.userData.fadeTex;
  const sameTexs = (a, b) => a === b || (!!a && !!b && a.length === b.length && a.every((t, i) => t === b[i]));
  const commit = () => {
    mats.forEach((m, mi) => {
      const t = nextTexs ? nextTexs[mi] : null;
      m.map = t;
      const f = fadeOf(m);
      if (f) {
        if (t) f.cur.value = t;
        f.curRT.value = rtCompensation(t);
        f.uMix.value = 0;
      }
    });
    nextTexs = null; mix = 0;
  };
  return {
    /** @returns {boolean} true = 交给过渡处理，调用方不要立刻换 map */
    begin(prev, tex, canFade = true) {
      if (nextTexs) commit(); // 上一轮过渡尚未结束又被切：先落定
      const fs = mats.map(fadeOf);
      if (!canFade || duration <= 0 || !prev || sameTexs(prev, tex) || fs.some((f) => !f)) return false;
      nextTexs = tex; mix = 0;
      fs.forEach((f, mi) => {
        f.nxt.value = tex[mi];
        f.nxtRT.value = rtCompensation(tex[mi]);
        f.uMix.value = 0;
      });
      return true;
    },
    advance(dt) {
      if (!nextTexs) return;
      mix = Math.min(1, mix + dt / duration);
      for (const f of mats.map(fadeOf)) if (f) f.uMix.value = mix;
      if (mix >= 1) commit();
    },
  };
}

/**
 * 构建一块（或多块）可播放的大屏：承载形式几何 + 内容轮播 + 过渡。
 * 转角包柱屏（corner）拆成两面，返回两个独立 screen（id 带 ::A / ::B 后缀）。
 * 3D转角包柱屏（corner3d）是一体屏：单 screen + 两块材质，一份节目单；
 * onSwap 收到数组纹理（各面离轴 RT）时按面分配，普通纹理两面共用；
 * 勾选「整屏平面展示」的素材带 planeFull 标记，两面 UV 各取半幅。
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

    let fade = createFade(faceMats, (pool.cfg && pool.cfg.transition) || 0);
    // 当前上屏纹理：按面展开（数组纹理 = [面A RT, 面B RT] 按面分配；普通纹理每面同张）
    let curTexs = null;
    // 整屏平面展示状态：true = 两面拼一张图（UV 对半拆），null = 尚未初始化
    let curPlane = null;
    // 3D转角屏的两面 mesh（整屏平面模式要改 UV），其余形式为空数组。
    // 注意 corner3d 的 faceGroups 只有 1 个组、两面 mesh 都在里面 —— 必须按材质跨组查找
    const faceMeshes = isCorner3d
      ? faceMats.map((m) => built.faceGroups
          .flatMap((g) => g.children)
          .find((c) => c.isMesh && c.material === m) || null)
      : [];
    const setPlaneUV = (on) => faceMeshes.forEach((fm, fi) => applyPlaneUV(fm, on ? fi : null));
    const toFaceTexs = (tex) => {
      const arr = Array.isArray(tex) ? tex : null;
      return faceMats.map((_, mi) => (arr ? (arr[mi] || arr[0] || null) : tex));
    };
    const applyTex = (texs) => {
      faceMats.forEach((m, mi) => {
        const t = texs[mi];
        m.map = t;
        const f = m.userData.fadeTex;
        if (f) {
          if (t) f.cur.value = t;
          f.curRT.value = rtCompensation(t);
        } // 节点混合走 fadeTex，map 仅作状态记录
      });
      curTexs = texs;
    };
    const onSwap = (tex) => {
      if (DEBUG_3D === 1) { // 诊断：测试图案替换 RT 内容（分配路径不变）
        const d = debugFaceTexs();
        applyTex(Array.isArray(tex) ? d.slice(0, 2) : toFaceTexs(d[2]));
        return;
      }
      // 整屏平面 ↔ 离轴/每面整幅 模式切换时改面 UV；UV 是几何属性，交叉淡入期间
      // 新旧纹理共用同一 UV，半幅 UV 会把旧图拉花 —— 模式不同时退化为硬切
      const plane = !Array.isArray(tex) && !!tex && tex.planeFull === true;
      const prevPlane = curPlane;
      if (plane !== curPlane) setPlaneUV(plane);
      curPlane = plane;
      const texs = toFaceTexs(tex);
      if (fade.begin(curTexs, texs, plane === prevPlane)) return; // 过渡中：保持旧 map，由节点混合新图
      applyTex(texs);
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
     *  过渡中的节点 uniform 先归零，避免新轮播接手后残留半透明混合。 */
    b.setContent = (newPool, newSchedule, key) => {
      for (const m of faceMats) {
        const f = m.userData.fadeTex;
        if (f) { f.uMix.value = 0; f.nxt.value = whiteTex(); f.nxtRT.value = 0; }
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
