import * as THREE from "three";

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const SKY_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vDir;
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform vec3 uBottom;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uMoonDir;
  uniform float uNight;
  uniform float uSunSize;

  void main() {
    float h = vDir.y;
    vec3 col;
    if (h > 0.0) {
      float t = pow(clamp(h, 0.0, 1.0), 0.55);
      col = mix(uHorizon, uTop, t);
    } else {
      col = mix(uHorizon, uBottom, clamp(-h * 3.2, 0.0, 1.0));
    }

    // sun / moon glow
    float sd = max(dot(normalize(vDir), normalize(uSunDir)), 0.0);
    float glow = pow(sd, 90.0) * 1.6 + pow(sd, 9.0) * 0.28;
    col += uSunColor * glow * (1.0 - uNight * 0.85);

    // moon
    float md = max(dot(normalize(vDir), normalize(uMoonDir)), 0.0);
    float moonGlow = pow(md, 260.0) * 2.4 + pow(md, 22.0) * 0.12;
    col += vec3(0.72, 0.8, 1.0) * moonGlow * uNight;

    // sun disc
    float disc = smoothstep(0.9985 - uSunSize, 0.9995, sd);
    col += uSunColor * disc * 2.2 * (1.0 - uNight * 0.9);

    gl_FragColor = vec4(col, 1.0);
  }
`;

function lerpColor(a, b, t, out) {
  out.r = a.r + (b.r - a.r) * t;
  out.g = a.g + (b.g - a.g) * t;
  out.b = a.b + (b.b - a.b) * t;
  return out;
}

const PRESETS = {
  night: { top: 0x070c1e, hor: 0x151d31, bot: 0x0a0d16, fog: 0x141a28, sun: 0x2a3352, hemiSky: 0x2a3552, hemiGround: 0x11131a, hemi: 0.42 },
  dawn:  { top: 0x2a3f78, hor: 0xe6a08f, bot: 0x2b2a35, fog: 0x9a8890, sun: 0xffc9a8, hemiSky: 0x7c88b4, hemiGround: 0x3a3230, hemi: 0.6 },
  day:   { top: 0x2f6fc4, hor: 0xcfe2f2, bot: 0x8c99a4, fog: 0xb9c9d6, sun: 0xfff2dc, hemiSky: 0xbdd6ef, hemiGround: 0x6b6458, hemi: 0.95 },
  dusk:  { top: 0x3b3a70, hor: 0xf2a58e, bot: 0x3a2f3a, fog: 0xc08c86, sun: 0xffb27a, hemiSky: 0x9a7d92, hemiGround: 0x3b302c, hemi: 0.62 },
};

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
    this.skyUniforms = {
      uTop: { value: new THREE.Color(0x3b3a70) },
      uHorizon: { value: new THREE.Color(0xf2a58e) },
      uBottom: { value: new THREE.Color(0x3a2f3a) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uSunColor: { value: new THREE.Color(0xffb27a) },
      uNight: { value: 0 },
      uSunSize: { value: 0.0006 },
    };
    const skyMat = new THREE.ShaderMaterial({
      uniforms: this.skyUniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.sky = new THREE.Mesh(skyGeo, skyMat);
    this.sky.renderOrder = -1000;
    scene.add(this.sky);

    // stars
    const starCount = 1400;
    const starPos = new Float32Array(starCount * 3);
    const starSizes = new Float32Array(starCount);
    for (let i = 0; i < starCount; i++) {
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const R = 3000;
      starPos[i * 3] = Math.cos(th) * r * R;
      starPos[i * 3 + 1] = Math.abs(u) * R * 0.95 + 40;
      starPos[i * 3 + 2] = Math.sin(th) * r * R;
      starSizes[i] = 1 + Math.random() * 2.2;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
    starGeo.setAttribute("aSize", new THREE.BufferAttribute(starSizes, 1));
    this.starMat = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0 } },
      vertexShader: `
        attribute float aSize; varying float vS;
        void main(){ vS = aSize; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_PointSize = aSize*(320.0/-mv.z); gl_Position = projectionMatrix*mv; }
      `,
      fragmentShader: `
        varying float vS; uniform float uOpacity;
        void main(){ vec2 p = gl_PointCoord-0.5; float d = length(p); float a = smoothstep(0.5,0.0,d); gl_FragColor = vec4(vec3(0.85,0.9,1.0), a*uOpacity); }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.stars = new THREE.Points(starGeo, this.starMat);
    this.stars.renderOrder = -900;
    scene.add(this.stars);

    // lights
    this.hemi = new THREE.HemisphereLight(0x9a7d92, 0x3b302c, 0.7);
    scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xffb27a, 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.near = 1; sc.far = 520; sc.left = -95; sc.right = 95; sc.top = 95; sc.bottom = -95;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.6;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.ambient = new THREE.AmbientLight(0x8899bb, 0.16);
    scene.add(this.ambient);

    this.moonLight = new THREE.DirectionalLight(0x8fa6d8, 0.0);
    scene.add(this.moonLight);

    this._tmpV = new THREE.Vector3();
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
    const topA = new THREE.Color(a.top), topB = new THREE.Color(b.top);
    lerpColor(topA, topB, t, ca.top);
    lerpColor(new THREE.Color(a.hor), new THREE.Color(b.hor), t, ca.hor);
    lerpColor(new THREE.Color(a.bot), new THREE.Color(b.bot), t, ca.bot);
    lerpColor(new THREE.Color(a.fog), new THREE.Color(b.fog), t, ca.fog);
    lerpColor(new THREE.Color(a.sun), new THREE.Color(b.sun), t, ca.sun);

    this.skyUniforms.uTop.value.copy(ca.top);
    this.skyUniforms.uHorizon.value.copy(ca.hor);
    this.skyUniforms.uBottom.value.copy(ca.bot);

    // night factor: 1 when sun well below horizon
    const sunDir = this.sunDirection();
    const elev = sunDir.y;
    const night = 1 - THREE.MathUtils.smoothstep(elev, -0.12, 0.16);
    this.night = night;
    this.skyUniforms.uNight.value = night;
    this.skyUniforms.uSunDir.value.copy(sunDir);
    this.skyUniforms.uSunColor.value.copy(ca.sun);
    this.skyUniforms.uMoonDir.value.set(-sunDir.x, -sunDir.y, -sunDir.z).normalize();

    this.starMat.uniforms.uOpacity.value = night * night * 0.9;

    // fog
    this.scene.fog.color.copy(ca.fog);
    this.scene.fog.density = 0.00105 + night * 0.0007;
    this.renderer.setClearColor(ca.fog, 1);

    // lights
    const lightUp = THREE.MathUtils.smoothstep(elev, -0.05, 0.28);
    this.sun.intensity = 0.35 + lightUp * 2.4;
    this.sun.color.copy(ca.sun);
    this.hemi.intensity = THREE.MathUtils.lerp(a.hemi, b.hemi, t);
    this.hemi.color.setHex(a.hemiSky).lerp(new THREE.Color(b.hemiSky), t);
    this.hemi.groundColor.setHex(a.hemiGround).lerp(new THREE.Color(b.hemiGround), t);
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

    this.bloomStrength = this.bloomStrength; // cosmetic
  }
}
