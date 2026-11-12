import * as THREE from "three/webgpu";
import { uniform, positionLocal, mix, vec3 } from "three/webgpu";
import { getRenderSettings, onRenderSettingsChange } from "../config/renderSettings.js";

/* 天空：TSL 节点材质（WebGPU/WebGL 双后端可编译，替代原 GLSL ShaderMaterial）。
 * 逻辑与原 SKY_VERT/SKY_FRAG 一致：vDir = normalize(局部坐标)（球心即 mesh 原点），
 * 按高度做三段渐变 + 太阳/月亮辉光 + 太阳圆盘。 */
function skyColorNode(U) {
  const dir = positionLocal.normalize();
  const h = dir.y;
  // 纯表达式树：select() 条件节点不能作为 addAssign 的赋值目标，只能逐级 add
  let col = h.greaterThan(0).select(
    mix(U.hor, U.top, h.clamp(0, 1).pow(0.55)),
    mix(U.hor, U.bot, h.mul(-1).mul(3.2).clamp(0, 1)),
  );
  // sun glow
  const sd = dir.dot(U.sunDir).max(0);
  const glow = sd.pow(90).mul(1.6).add(sd.pow(9).mul(0.28));
  col = col.add(U.sunColor.mul(glow).mul(U.night.mul(-0.85).add(1)));
  // moon glow
  const md = dir.dot(U.moonDir).max(0);
  const moonGlow = md.pow(260).mul(2.4).add(md.pow(22).mul(0.12));
  col = col.add(vec3(0.72, 0.8, 1.0).mul(moonGlow).mul(U.night));
  // sun disc：smoothstep(0.9985 - uSunSize, 0.9995, sd)
  const disc = sd.smoothstep(U.sunSize.mul(-1).add(0.9985), 0.9995);
  col = col.add(U.sunColor.mul(disc).mul(2.2).mul(U.night.mul(-0.9).add(1)));
  return col;
}

/* 星空：WebGPU 后端对 THREE.Points 只支持 1px 点（无 gl_PointSize 等价物），
 * 改为把星点烘焙成 equirect 贴图铺在背面球体上（半径略小于天空穹顶 3200）。 */
function makeStarTexture() {
  const W = 2048, H = 1024;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  for (let i = 0; i < 1400; i++) {
    // 球面均匀分布：纬度按 acos 反变换（equirect 线性采样会让两极过密）
    const u = Math.random(), th = Math.random() * Math.PI * 2;
    const phi = Math.acos(1 - 2 * u);
    const x = (th / (Math.PI * 2)) * W;
    const y = (phi / Math.PI) * H;
    const big = Math.random() < 0.08;
    const r = big ? 1.4 + Math.random() * 1.2 : 0.6 + Math.random() * 0.9;
    const a = 0.35 + Math.random() * 0.65;
    if (big) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 3);
      g.addColorStop(0, `rgba(200,215,255,${a})`);
      g.addColorStop(0.4, `rgba(160,185,255,${a * 0.35})`);
      g.addColorStop(1, "rgba(160,185,255,0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r * 3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = `rgba(217,228,255,${a})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function lerpColor(a, b, t, out) {
  out.r = a.r + (b.r - a.r) * t;
  out.g = a.g + (b.g - a.g) * t;
  out.b = a.b + (b.b - a.b) * t;
  return out;
}

// 颜色预先转成 THREE.Color：update() 每帧跑，不能在里面 new Color（GC 抖动）
const PRESETS = {
  night: { top: 0x070c1e, hor: 0x151d31, bot: 0x0a0d16, fog: 0x141a28, sun: 0x2a3352, hemiSky: 0x2a3552, hemiGround: 0x11131a, hemi: 0.42 },
  dawn:  { top: 0x2a3f78, hor: 0xe6a08f, bot: 0x2b2a35, fog: 0x9a8890, sun: 0xffc9a8, hemiSky: 0x7c88b4, hemiGround: 0x3a3230, hemi: 0.6 },
  day:   { top: 0x2f6fc4, hor: 0xcfe2f2, bot: 0x8c99a4, fog: 0xb9c9d6, sun: 0xfff2dc, hemiSky: 0xbdd6ef, hemiGround: 0x6b6458, hemi: 0.95 },
  dusk:  { top: 0x3b3a70, hor: 0xf2a58e, bot: 0x3a2f3a, fog: 0xc08c86, sun: 0xffb27a, hemiSky: 0x9a7d92, hemiGround: 0x3b302c, hemi: 0.62 },
};
for (const key of Object.keys(PRESETS)) {
  const p = PRESETS[key];
  for (const k of ["top", "hor", "bot", "fog", "sun", "hemiSky", "hemiGround"]) {
    p[k] = new THREE.Color(p[k]);
  }
}

export class Environment {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.hour = 13.5;
    this.speed = 0.035; // hours per second (~ 11.5 min full day)
    this.night = 0;

    this._c = {
      top: new THREE.Color(), hor: new THREE.Color(), bot: new THREE.Color(),
      fog: new THREE.Color(), sun: new THREE.Color(),
    };

    const skyGeo = new THREE.SphereGeometry(3200, 40, 24);
    // TSL uniform：update() 里 .value.copy() 推进，与原 uniforms 写法一致
    this.skyU = {
      top: uniform(new THREE.Color(0x3b3a70)),
      hor: uniform(new THREE.Color(0xf2a58e)),
      bot: uniform(new THREE.Color(0x3a2f3a)),
      sunDir: uniform(new THREE.Vector3(0, 1, 0)),
      moonDir: uniform(new THREE.Vector3(0, -1, 0)),
      sunColor: uniform(new THREE.Color(0xffb27a)),
      night: uniform(0),
      sunSize: uniform(0.0006),
    };
    const skyMat = new THREE.MeshBasicMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      // 原 ShaderMaterial 输出不经 tone mapping，保持一致
    });
    skyMat.toneMapped = false;
    skyMat.colorNode = skyColorNode(this.skyU);
    this.sky = new THREE.Mesh(skyGeo, skyMat);
    this.sky.renderOrder = -1000;
    scene.add(this.sky);

    // stars：星图球（背面），透明度随夜晚系数
    const starMat = new THREE.MeshBasicMaterial({
      map: makeStarTexture(),
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    starMat.toneMapped = false;
    starMat.opacity = 0;
    this.starMat = starMat;
    this.stars = new THREE.Mesh(new THREE.SphereGeometry(2900, 48, 24), starMat);
    this.stars.renderOrder = -900;
    scene.add(this.stars);

    // lights
    this.hemi = new THREE.HemisphereLight(0x9a7d92, 0x3b302c, 0.7);
    scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xffb27a, 2.2);
    this.sun.castShadow = true;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.ambient = new THREE.AmbientLight(0x8899bb, 0.16);
    scene.add(this.ambient);

    this.moonLight = new THREE.DirectionalLight(0x8fa6d8, 0.0);
    scene.add(this.moonLight);

    this._tmpV = new THREE.Vector3();
    this._shadowKey = "";

    this.applyShadowSettings(getRenderSettings());
    onRenderSettingsChange((s) => this.applyShadowSettings(s));
  }

  /** 阴影质量热切换：贴图分辨率与投影相机范围（范围越小，同样分辨率越清晰也越省） */
  applyShadowSettings(s) {
    const size = Math.max(512, Math.round(s.shadowMapSize || 2048));
    const half = Math.max(30, s.shadowDistance || 95);
    const key = `${size}|${half}`;
    if (key === this._shadowKey) return;
    this._shadowKey = key;

    this.sun.castShadow = !!s.shadows;
    const shadow = this.sun.shadow;
    if (shadow.mapSize.x !== size) {
      shadow.mapSize.set(size, size);
      // 分辨率变化必须丢弃旧的 RT，否则 three 会继续用旧尺寸
      if (shadow.map) {
        shadow.map.dispose();
        shadow.map = null;
      }
    }
    const sc = shadow.camera;
    sc.left = -half;
    sc.right = half;
    sc.top = half;
    sc.bottom = -half;
    sc.near = 1;
    sc.far = half * 5.5;
    sc.updateProjectionMatrix();
  }

  setHour(h) { this.hour = ((h % 24) + 24) % 24; }

  sunDirection(out = this._tmpV) {
    const h = this.hour;
    // sun rises 6, sets 18; elevation peaks at noon
    const ang = ((h - 6) / 12) * Math.PI;
    const y = Math.sin(ang);
    const x = Math.cos(ang) * 0.72;
    const z = Math.cos(ang) * 0.42;
    return out.set(x, y, z).normalize();
  }

  update(dt, focus) {
    this.hour = (this.hour + this.speed * dt) % 24;
    const h = this.hour;

    // pick blend preset
    let a, b, t;
    if (h < 5.2) { a = PRESETS.night; b = PRESETS.dawn; t = THREE.MathUtils.smoothstep(h, 4.2, 5.2); }
    else if (h < 7.0) { a = PRESETS.dawn; b = PRESETS.day; t = THREE.MathUtils.smoothstep(h, 5.4, 7.0); }
    else if (h < 16.4) { a = PRESETS.day; b = PRESETS.day; t = 0; }
    else if (h < 18.0) { a = PRESETS.day; b = PRESETS.dusk; t = THREE.MathUtils.smoothstep(h, 16.4, 18.0); }
    else if (h < 19.4) { a = PRESETS.dusk; b = PRESETS.night; t = THREE.MathUtils.smoothstep(h, 18.1, 19.4); }
    else { a = PRESETS.night; b = PRESETS.night; t = 0; }

    const ca = this._c;
    lerpColor(a.top, b.top, t, ca.top);
    lerpColor(a.hor, b.hor, t, ca.hor);
    lerpColor(a.bot, b.bot, t, ca.bot);
    lerpColor(a.fog, b.fog, t, ca.fog);
    lerpColor(a.sun, b.sun, t, ca.sun);

    this.skyU.top.value.copy(ca.top);
    this.skyU.hor.value.copy(ca.hor);
    this.skyU.bot.value.copy(ca.bot);

    // night factor: 1 when sun well below horizon
    const sunDir = this.sunDirection();
    const elev = sunDir.y;
    const night = 1 - THREE.MathUtils.smoothstep(elev, -0.12, 0.16);
    this.night = night;
    this.skyU.night.value = night;
    this.skyU.sunDir.value.copy(sunDir);
    this.skyU.sunColor.value.copy(ca.sun);
    this.skyU.moonDir.value.set(-sunDir.x, -sunDir.y, -sunDir.z).normalize();

    this.starMat.opacity = night * night * 0.9;

    // fog
    this.scene.fog.color.copy(ca.fog);
    this.scene.fog.density = 0.00105 + night * 0.0007;
    this.renderer.setClearColor(ca.fog, 1);

    // lights
    const lightUp = THREE.MathUtils.smoothstep(elev, -0.05, 0.28);
    this.sun.intensity = 0.35 + lightUp * 2.4;
    this.sun.color.copy(ca.sun);
    this.hemi.intensity = THREE.MathUtils.lerp(a.hemi, b.hemi, t);
    this.hemi.color.copy(a.hemiSky).lerp(b.hemiSky, t);
    this.hemi.groundColor.copy(a.hemiGround).lerp(b.hemiGround, t);
    this.moonLight.intensity = night * 0.42;
    this.moonLight.position.set(-sunDir.x * 200, 180, -sunDir.z * 200);

    // sun position follows focus so shadows stay tight
    const fx = focus ? focus.x : 0;
    const fz = focus ? focus.z : 0;
    this.sun.position.set(fx + sunDir.x * 190, Math.max(24, sunDir.y * 230), fz + sunDir.z * 190);
    this.sun.target.position.set(fx, 0, fz);
    this.sun.target.updateMatrixWorld();

    // sky follows camera
    if (focus) {
      this.sky.position.set(fx, 0, fz);
      this.stars.position.set(fx, 0, fz);
    }
  }
}
