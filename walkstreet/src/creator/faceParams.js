import * as THREE from "three";

/* ------------------------------------------------------------------ *
 * 捏脸参数内核
 *
 * 设计参照游戏捏脸系统的通用做法：用一组 0~100 的语义参数驱动角色骨骼
 * 的局部变换（缩放 / 位移 / 旋转）与材质颜色。50 为模型原始中性值。
 *
 * 本项目自带角色（jie.glb / wen.glb）来自 3ds Max Biped 体系，带有 28 根
 * 面部骨骼（眼 / 鼻 / 颧 / 下颌 / 唇 / 眉 / 咬肌），因此采用「骨骼捏脸」
 * 路线；若将来接入带 morph target 的 VRM / ARKit 模型，可在
 * avatarRig.js 的 morph 桥接层直接映射，参数定义无需改动。
 * ------------------------------------------------------------------ */

const B = (n) => `Bip01 ${n}`;
// GLTFLoader 会把节点名里的空格规范成下划线（Bip01 LEye → Bip01_LEye），
// 因此骨骼查找统一走「去空格/下划线 + 小写」的规范化键。
const normBone = (s) => s.replace(/[\s_]/g, "").toLowerCase();
export const NEUTRAL = 50;

const AXIS = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

/* ------------------------------------------------------------------ *
 * 参数表
 * targets 中 f 为「参数从中性走到极值」时的变换量：
 *   scale    → 乘以 (1 + f * t)，t ∈ [-1, 1]
 *   position → 在骨骼局部轴上平移 f * t（模型单位，头部约 0.1 量级）
 *   rotation → 绕骨骼局部轴旋转 f * t 弧度
 * ------------------------------------------------------------------ */
export const PARAM_GROUPS = [
  {
    id: "face", label: "脸型", hint: "调整脸部轮廓与骨骼结构",
    params: [
      { id: "faceWidth", label: "脸部宽窄", min: 0, max: 100, step: 1, def: 50,
        targets: [
          { bone: B("LMasseter"), op: "scale", axis: "z", f: 0.30 },
          { bone: B("RMasseter"), op: "scale", axis: "z", f: 0.30 },
          { bone: B("LCheek"), op: "scale", axis: "z", f: 0.16 },
          { bone: B("RCheek"), op: "scale", axis: "z", f: 0.16 },
        ] },
      { id: "cheekBone", label: "颧骨高低", min: 0, max: 100, step: 1, def: 50,
        targets: [
          { bone: B("LCheek"), op: "position", axis: "y", f: 0.010 },
          { bone: B("RCheek"), op: "position", axis: "y", f: 0.010 },
        ] },
      { id: "jawWidth", label: "下颌宽窄", min: 0, max: 100, step: 1, def: 50,
        targets: [
          { bone: B("MJaw"), op: "scale", axis: "z", f: 0.26 },
          { bone: B("LMasseter"), op: "scale", axis: "z", f: 0.10 },
          { bone: B("RMasseter"), op: "scale", axis: "z", f: 0.10 },
        ] },
      { id: "chinLength", label: "下巴长短", min: 0, max: 100, step: 1, def: 50,
        targets: [
          { bone: B("MJaw"), op: "position", axis: "y", f: -0.012 },
          { bone: B("MBottomLip"), op: "position", axis: "y", f: -0.003 },
        ] },
      { id: "faceLength", label: "脸部长短", min: 0, max: 100, step: 1, def: 50,
        targets: [
          { bone: B("Head"), op: "scale", axis: "y", f: 0.14 },
        ] },
      { id: "chinPoint", label: "下巴尖度", min: 0, max: 100, step: 1, def: 50,
        targets: [
          { bone: B("MJaw"), op: "scale", axis: "z", f: -0.16 },
        ] },
    ],
  },
  {
    id: "eyes", label: "眼睛", hint: "眼睛大小、间距与神态",
    params: [
      { id: "eyeSize", label: "眼睛大小", min: 0, max: 100, step: 1, def: 50,
        targets: [
          { bone: B("LEye"), op: "scale", axis: "x", f: 0.16 },
          { bone: B("LEye"), op: "scale", axis: "y", f: 0.14 },
          { bone: B("REye"), op: "scale", axis: "x", f: 0.16 },
          { bone: B("REye"), op: "scale", axis: "y", f: 0.14 },
          { bone: B("LEyeBlinkTop"), op: "position", axis: "y", f: 0.005 },
          { bone: B("REyeBlinkTop"), op: "position", axis: "y", f: 0.005 },
          { bone: B("LEyeBlinkBottom"), op: "position", axis: "y", f: -0.003 },
          { bone: B("REyeBlinkBottom"), op: "position", axis: "y", f: -0.003 },
        ] },
      { id: "eyeSpacing", label: "眼睛间距", min: 0, max: 100, step: 1, def: 50,
        targets: [
          { bone: B("LEye"), op: "position", axis: "z", f: 0.006 },
          { bone: B("REye"), op: "position", axis: "z", f: -0.006 },
        ] },
      { id: "eyeHeight", label: "眼睛高低", min: 0, max: 100, step: 1, def: 50,
        targets: [
          { bone: B("LEye"), op: "position", axis: "y", f: 0.008 },
          { bone: B("REye"), op: "position", axis: "y", f: 0.008 },
        ] },
      { id: "eyeTilt", label: "眼睛倾斜", min: 0, max: 100, step: 1, def: 50,
        targets: [
          { bone: B("LEye"), op: "rotation", axis: "z", f: -0.12 },
          { bone: B("REye"), op: "rotation", axis: "z", f: 0.12 },
        ] },
      { id: "eyelidOpen", label: "眼睑开合", min: 0, max: 100, step: 1, def: 50,
        targets: [
          { bone: B("LEyeBlinkTop"), op: "position", axis: "y", f: 0.008 },
          { bone: B("REyeBlinkTop"), op: "position", axis: "y", f: 0.008 },
          { bone: B("LEyeBlinkBottom"), op: "position", axis: "y", f: -0.005 },
          { bone: B("REyeBlinkBottom"), op: "position", axis: "y", f: -0.005 },
        ] },
    ],
  },
  {
    id: "brows", label: "眉毛", hint: "眉形与眉眼距离",
    params: [
      { id: "browHeight", label: "眉毛高低", min: 0, max: 100, step: 1, def: 50,
        targets: [
          { bone: B("LInnerEyebrow"), op: "position", axis: "y", f: 0.012 },
          { bone: B("RInnerEyebrow"), op: "position", axis: "y", f: 0.012 },
          { bone: B("LOuterEyebrow"), op: "position", axis: "y", f: 0.010 },
          { bone: B("ROuterEyebrow"), op: "position", axis: "y", f: 0.010 },
        ] },
      { id: "browSpacing", label: "眉毛间距", min: 0, max: 100, step: 1, def: 50,
        targets: [
          { bone: B("LInnerEyebrow"), op: "position", axis: "z", f: 0.006 },
          { bone: B("RInnerEyebrow"), op: "position", axis: "z", f: -0.006 },
        ] },
      { id: "browThickness", label: "眉毛粗细", min: 0, max: 100, step: 1, def: 50,
        targets: [
          { bone: B("LInnerEyebrow"), op: "scale", axis: "y", f: 0.30 },
          { bone: B("RInnerEyebrow"), op: "scale", axis: "y", f: 0.30 },
          { bone: B("LOuterEyebrow"), op: "scale", axis: "y", f: 0.30 },
          { bone: B("ROuterEyebrow"), op: "scale", axis: "y", f: 0.30 },
        ] },
      { id: "browArch", label: "眉峰弧度", min: 0, max: 100, step: 1, def: 50,
        targets: [
          { bone: B("LOuterEyebrow"), op: "position", axis: "y", f: -0.012 },
          { bone: B("ROuterEyebrow"), op: "position", axis: "y", f: -0.012 },
          { bone: B("MMiddleEyebrow"), op: "position", axis: "y", f: 0.008 },
        ] },
    ],
  },
  {
    id: "nose", label: "鼻子", hint: "鼻梁、鼻翼与鼻尖",
    params: [
      { id: "noseHeight", label: "鼻梁高低", min: 0, max: 100, step: 1, def: 50,
        targets: [
          { bone: B("MNose"), op: "position", axis: "x", f: 0.010 },
        ] },
      { id: "noseWidth", label: "鼻翼宽窄", min: 0, max: 100, step: 1, def: 50,
        targets: [
          { bone: B("MNose"), op: "scale", axis: "z", f: 0.22 },
        ] },
      { id: "noseLength", label: "鼻子长短", min: 0, max: 100, step: 1, def: 50,
        targets: [
          { bone: B("MNose"), op: "position", axis: "y", f: -0.010 },
        ] },
    ],
  },
  {
    id: "mouth", label: "嘴巴", hint: "唇形、嘴角与笑意",
    params: [
      { id: "mouthWidth", label: "嘴巴宽窄", min: 0, max: 100, step: 1, def: 50,
        targets: [
          { bone: B("LMouthCorner"), op: "position", axis: "z", f: 0.008 },
          { bone: B("RMouthCorner"), op: "position", axis: "z", f: -0.008 },
          { bone: B("LCaninus"), op: "position", axis: "z", f: 0.004 },
          { bone: B("RCaninus"), op: "position", axis: "z", f: -0.004 },
        ] },
      { id: "lipThickness", label: "嘴唇厚薄", min: 0, max: 100, step: 1, def: 50,
        targets: [
          { bone: B("MUpperLip"), op: "scale", axis: "y", f: 0.30 },
          { bone: B("MBottomLip"), op: "scale", axis: "y", f: 0.30 },
          { bone: B("LUpperlip"), op: "scale", axis: "y", f: 0.22 },
          { bone: B("RUpperlip"), op: "scale", axis: "y", f: 0.22 },
        ] },
      { id: "mouthHeight", label: "嘴巴高低", min: 0, max: 100, step: 1, def: 50,
        targets: [
          { bone: B("MUpperLip"), op: "position", axis: "y", f: 0.008 },
          { bone: B("MBottomLip"), op: "position", axis: "y", f: 0.008 },
          { bone: B("LMouthCorner"), op: "position", axis: "y", f: 0.008 },
          { bone: B("RMouthCorner"), op: "position", axis: "y", f: 0.008 },
        ] },
      { id: "smile", label: "嘴角上扬", min: 0, max: 100, step: 1, def: 50,
        targets: [
          { bone: B("LMouthCorner"), op: "position", axis: "y", f: 0.012 },
          { bone: B("RMouthCorner"), op: "position", axis: "y", f: 0.012 },
          { bone: B("LCheek"), op: "position", axis: "y", f: 0.004 },
          { bone: B("RCheek"), op: "position", axis: "y", f: 0.004 },
        ] },
    ],
  },
];

/* 颜色类参数不驱动骨骼，由 applyFaceParams 单独处理 */
export const COLOR_PARAMS = [
  { id: "skinTone", label: "肤色", type: "gradient", min: 0, max: 100, step: 1, def: 50,
    stops: ["#f9e6d6", "#f2d2b6", "#e8b98f", "#c98c63", "#98593a"] },
  { id: "hairColor", label: "发色", type: "swatch", min: 0, max: 100, step: 1, def: 8,
    swatches: ["#14100e", "#33210f", "#5b3a21", "#8a5a2b", "#c79a5b", "#a3322a", "#3a5f8a", "#7a4a8c", "#cf6f9b", "#d9d5cd"] },
];

export const ALL_PARAMS = [
  ...PARAM_GROUPS.flatMap((g) => g.params),
  ...COLOR_PARAMS,
];
export const PARAM_MAP = Object.fromEntries(ALL_PARAMS.map((p) => [p.id, p]));
export const SHAPE_PARAM_IDS = PARAM_GROUPS.flatMap((g) => g.params.map((p) => p.id));

/* ------------------------------------------------------------------ *
 * 配置工具
 * ------------------------------------------------------------------ */
export function defaultConfig(avatar = "/avatars/jie.glb") {
  const params = {};
  for (const p of ALL_PARAMS) params[p.id] = p.def;
  return { version: 1, avatar, name: "自定义角色", params };
}

export function clampConfig(cfg) {
  const base = defaultConfig(cfg && cfg.avatar);
  if (!cfg || typeof cfg !== "object") return base;
  const out = { version: 1, avatar: cfg.avatar || base.avatar, name: cfg.name || base.name, params: {} };
  for (const p of ALL_PARAMS) {
    let v = cfg.params && cfg.params[p.id];
    v = Number(v);
    if (!Number.isFinite(v)) v = p.def;
    out.params[p.id] = Math.min(p.max, Math.max(p.min, v));
  }
  return out;
}

export function configSignature(cfg) {
  return SHAPE_PARAM_IDS.map((id) => cfg.params[id]).join(",") + "|" + cfg.params.skinTone + "|" + cfg.params.hairColor;
}

/* ------------------------------------------------------------------ *
 * 预设：覆盖部分参数，其余回落到中性值
 * ------------------------------------------------------------------ */
export const PRESETS = [
  { id: "default", label: "原始", desc: "模型出厂样貌", emoji: "◎", params: {} },
  { id: "sweet", label: "甜美", desc: "圆眼小脸 · 微笑", emoji: "◕",
    params: { faceWidth: 40, chinPoint: 66, cheekBone: 58, eyeSize: 68, eyeSpacing: 45, eyelidOpen: 62, browHeight: 58, browThickness: 40, noseHeight: 42, noseWidth: 43, lipThickness: 58, smile: 74, skinTone: 30, hairColor: 8 } },
  { id: "handsome", label: "英俊", desc: "剑眉挺鼻 · 方下颌", emoji: "◆",
    params: { faceWidth: 62, chinPoint: 40, cheekBone: 62, jawWidth: 62, eyeSize: 46, eyeSpacing: 56, browHeight: 40, browThickness: 64, browArch: 34, noseHeight: 72, noseWidth: 58, mouthWidth: 58, lipThickness: 40, smile: 42, skinTone: 42, hairColor: 1 } },
  { id: "anime", label: "动漫", desc: "大眼尖脸 · 夸张", emoji: "✦",
    params: { faceWidth: 32, chinPoint: 82, cheekBone: 44, faceLength: 38, eyeSize: 90, eyeSpacing: 40, eyelidOpen: 78, browThickness: 30, noseHeight: 30, noseWidth: 30, mouthWidth: 38, lipThickness: 44, smile: 60, skinTone: 22, hairColor: 6 } },
  { id: "mature", label: "成熟", desc: "狭长眼 · 轮廓分明", emoji: "◇",
    params: { faceWidth: 56, faceLength: 64, cheekBone: 56, jawWidth: 56, eyeSize: 38, eyeHeight: 42, eyelidOpen: 38, browHeight: 36, browThickness: 54, noseHeight: 66, noseLength: 62, lipThickness: 46, smile: 40, skinTone: 48, hairColor: 2 } },
  { id: "soft", label: "温润", desc: "柔和五官 · 淡妆", emoji: "◡",
    params: { faceWidth: 46, cheekBone: 46, eyeSize: 56, eyeTilt: 58, browHeight: 52, browThickness: 44, browArch: 60, noseHeight: 46, noseWidth: 46, lipThickness: 52, smile: 58, skinTone: 34, hairColor: 3 } },
];

export function presetConfig(preset, avatar) {
  const cfg = defaultConfig(avatar);
  for (const [id, v] of Object.entries(preset.params || {})) {
    if (PARAM_MAP[id]) cfg.params[id] = v;
  }
  cfg.name = preset.label;
  return cfg;
}

export function randomConfig(avatar) {
  const cfg = defaultConfig(avatar);
  for (const id of SHAPE_PARAM_IDS) {
    const p = PARAM_MAP[id];
    cfg.params[id] = Math.round(p.def + (Math.random() * 2 - 1) * 18);
  }
  cfg.params.skinTone = Math.round(12 + Math.random() * 70);
  cfg.params.hairColor = Math.floor(Math.random() * COLOR_PARAMS[1].swatches.length * 10);
  cfg.name = "随机形象";
  return cfg;
}

/* ------------------------------------------------------------------ *
 * 骨架快照 + 应用
 * ------------------------------------------------------------------ */
export function captureRigState(root) {
  root.updateMatrixWorld(true);
  const bones = new Map();
  const materials = [];
  const morphs = [];
  const modelQuat = root.getWorldQuaternion(new THREE.Quaternion());
  root.traverse((o) => {
    if (o.isBone) {
      // 面部骨骼（Biped 体系）局部轴常绕 Z 旋转 ~90°，直接用局部轴做位移
      // 会错向。这里缓存「模型空间 → 父骨骼局部空间」的旋转，让参数可以按
      // 直观的模型空间方向（X 前后 / Y 上下 / Z 左右）描述。
      const parentQuat = o.parent ? o.parent.getWorldQuaternion(new THREE.Quaternion()) : modelQuat.clone();
      const toParentLocal = parentQuat.invert().multiply(modelQuat);
      const entry = {
        bone: o,
        position: o.position.clone(),
        quaternion: o.quaternion.clone(),
        scale: o.scale.clone(),
        toParentLocal,
      };
      bones.set(o.name, entry);
      bones.set(normBone(o.name), entry);
    }
    if (o.isMesh || o.isSkinnedMesh) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m, i) => {
        if (m && m.color) materials.push({ mesh: o, index: i, name: m.name || "", color: m.color.clone(), material: m });
      });
      if (o.morphTargetInfluences && o.morphTargetInfluences.length) {
        morphs.push({ mesh: o, base: o.morphTargetInfluences.slice() });
      }
    }
  });
  return { bones, materials, morphs };
}

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

/**
 * 把配置应用到骨架快照上。此函数只依赖 three.js 对象，不依赖 DOM，
 * 因此捏脸预览与游戏内角色共用同一套逻辑。
 */
export function applyFaceParams(rest, config) {
  if (!rest) return;
  const cfg = clampConfig(config);

  for (const s of rest.bones.values()) {
    s.bone.position.copy(s.position);
    s.bone.quaternion.copy(s.quaternion);
    s.bone.scale.copy(s.scale);
  }
  for (const m of rest.morphs) {
    for (let i = 0; i < m.mesh.morphTargetInfluences.length; i++) {
      m.mesh.morphTargetInfluences[i] = m.base[i] || 0;
    }
  }

  for (const p of PARAM_GROUPS.flatMap((g) => g.params)) {
    const value = cfg.params[p.id];
    // 归一化到 [-1, 1]（0~100，中性 50）
    const amount = (value - p.def) / 50;
    if (Math.abs(amount) < 1e-6) continue;
    for (const tg of p.targets) {
      const s = rest.bones.get(tg.bone) || rest.bones.get(normBone(tg.bone));
      if (!s) continue;
      const d = tg.f * amount;
      if (tg.op === "scale") {
        s.bone.scale[tg.axis] = Math.max(0.02, s.scale[tg.axis] * (1 + d));
      } else if (tg.op === "position") {
        // axis 表示模型空间方向；旋转到骨骼父空间后再叠加，避免局部轴旋转导致错向
        _v.copy(AXIS[tg.axis]).multiplyScalar(d).applyQuaternion(s.toParentLocal);
        s.bone.position.copy(s.position).add(_v);
      } else if (tg.op === "rotation") {
        _q.setFromAxisAngle(AXIS[tg.axis], d);
        s.bone.quaternion.copy(s.quaternion).multiply(_q);
      }
    }
  }

  // 肤色：沿渐变色带插值，乘到 head / body 材质（保留原贴图细节）
  const skinC = gradientColor(COLOR_PARAMS[0].stops, cfg.params.skinTone / 100);
  const hairC = new THREE.Color(COLOR_PARAMS[1].swatches[Math.min(COLOR_PARAMS[1].swatches.length - 1, Math.floor(cfg.params.hairColor / 100 * COLOR_PARAMS[1].swatches.length))]);
  for (const m of rest.materials) {
    const n = m.name.toLowerCase();
    if (n === "head" || n === "body" || n.includes("skin") || n.includes("face")) {
      // 贴图本身带皮肤细节，基色作为整体色调乘子（0.9 保留少量原始暗部）
      m.material.color.copy(skinC).multiplyScalar(0.9);
    } else if (n === "hair" || n.includes("hair")) {
      m.material.color.copy(hairC);
    }
  }

  // 预留：若接入带 morph target 的 VRM / ARKit 模型，可在此把参数映射到 influence
  for (const m of rest.morphs) void m;
}

function gradientColor(stops, t) {
  const x = Math.max(0, Math.min(0.99999, t)) * (stops.length - 1);
  const i = Math.floor(x);
  return new THREE.Color(stops[i]).lerp(new THREE.Color(stops[i + 1]), x - i);
}

/* ------------------------------------------------------------------ *
 * AI 用的可读描述
 * ------------------------------------------------------------------ */
export function describeConfig(cfg) {
  const lines = [];
  for (const g of PARAM_GROUPS) {
    const items = g.params.map((p) => `${p.label}=${cfg.params[p.id]}`).join("，");
    lines.push(`${g.label}：${items}`);
  }
  const skin = COLOR_PARAMS[0], hair = COLOR_PARAMS[1];
  lines.push(`肤色档位=${cfg.params.skinTone}/100（0 白皙 → 100 小麦偏深）`);
  lines.push(`发色档位=${cfg.params.hairColor}/100（0 黑 → 100 银）`);
  void skin; void hair;
  return lines.join("\n");
}

export const AI_PARAM_SCHEMA = ALL_PARAMS.map((p) => {
  if (p.type === "swatch") return `${p.id}（${p.label}，0-100 整数，色板索引）`;
  return `${p.id}（${p.label}，0-100 整数，默认 ${p.def}）`;
}).join("；");
