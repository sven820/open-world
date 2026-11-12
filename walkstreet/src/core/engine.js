import * as THREE from "three/webgpu";
import { pass, bloom, PostProcessing } from "three/webgpu";
import { getRenderSettings, onRenderSettingsChange } from "../config/renderSettings.js";

function pixelRatioFor(s) {
  const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
  const scale = s.renderScale ?? 1;
  const cap = s.maxPixelRatio ?? 1.75;
  return Math.max(0.5, Math.min(dpr, cap) * scale);
}

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    this.clock = new THREE.Clock();
    this.time = 0;
    this.dt = 0;
    this.updaters = [];
    this.settings = getRenderSettings();

    // WebGPU 渲染器（navigator.gpu 不可用时自动回退 WebGL2 后端）
    const renderer = new THREE.WebGPURenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
      stencil: false,
    });
    renderer.setPixelRatio(pixelRatioFor(this.settings));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = !!this.settings.shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // 手动重置统计：后处理链每个 pass 都会调用 renderer.render，
    // 自动重置会让 info 只剩最后一个全屏 pass 的 1 个 draw call（看不到真实负载）
    renderer.info.autoReset = false;
    this.renderer = renderer;
    // WebGPU 设备初始化是异步的：main.js 的 boot() 里 await engine.ready
    // 之后才构建世界 / 开渲染循环（GLTF/KTX2 的 detectSupport 也依赖已初始化的后端）
    this.ready = renderer.init();
    this._shadowEnabled = !!this.settings.shadows;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x9aa4b0, 0.0016);
    this.scene = scene;

    // near 0.5：透视深度精度 ∝ z²/near，near 过小会让高空俯瞰时地面各层
    // （outer/asphalt/描边层间距 0.05~0.5m）深度冲突(z-fighting)高频闪烁
    const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.5, 4200);
    camera.position.set(0, 8, 20);
    this.camera = camera;

    // 节点式后处理（WebGPU 原生管线，替代 WebGL 版 EffectComposer+UnrealBloomPass）：
    // 场景先渲进离屏 RT（线性空间），bloom 叠加后统一做 tone mapping + sRGB 输出
    const postProcessing = new PostProcessing(renderer);
    const scenePass = pass(scene, camera);
    this._sceneColor = scenePass.getTextureNode("output");
    this._bloomNode = bloom(this._sceneColor, 0.62, 0.55, 0.86);
    this.bloomEnabled = !!this.settings.bloom;
    postProcessing.outputNode = this.bloomEnabled
      ? this._sceneColor.add(this._bloomNode)
      : this._sceneColor;
    this.postProcessing = postProcessing;
    this.fpsCap = this.settings.fpsCap || 0;

    window.addEventListener("resize", () => this.resize());
    this.resize();
    onRenderSettingsChange((s) => this.applySettings(s));
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  /** 泛光强度热调（夜景增强），不触发管线重建 */
  setBloomStrength(v) {
    this._bloomNode.strength.value = v;
  }

  /** 应用渲染设置（分辨率缩放 / 阴影开关 / 泛光 / 帧率上限），可随时热切换。 */
  applySettings(s) {
    this.settings = s;

    const pr = pixelRatioFor(s);
    if (Math.abs(pr - this.renderer.getPixelRatio()) > 0.001) {
      this.renderer.setPixelRatio(pr);
    }
    this.resize();

    const shadows = !!s.shadows;
    if (shadows !== this._shadowEnabled) {
      this._shadowEnabled = shadows;
      this.renderer.shadowMap.enabled = shadows;
      // 阴影采样在材质编译期写死：运行时开关阴影必须重编材质，
      // 否则会残留/丢失阴影采样（画面全黑或阴影不消失）
      this.scene.traverse((o) => {
        if (!o.material) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.needsUpdate = true;
      });
    }

    const bloomOn = !!s.bloom;
    if (bloomOn !== this.bloomEnabled) {
      this.bloomEnabled = bloomOn;
      // 开泛光走 PostProcessing 链；关泛光时 render() 直接前向渲染（省离屏 RT）
      this.postProcessing.outputNode = bloomOn
        ? this._sceneColor.add(this._bloomNode)
        : this._sceneColor;
      this.postProcessing.needsUpdate = true;
    }
    this.fpsCap = s.fpsCap || 0;
  }

  onUpdate(fn) { this.updaters.push(fn); }

  render() {
    // 关泛光时直接前向渲染：省掉离屏 RT + 5 次降采样/模糊 pass
    if (this.bloomEnabled) this.postProcessing.render();
    else this.renderer.render(this.scene, this.camera);

    // 整帧（含阴影 pass 与全部后处理 pass）的统计快照，供 HUD/设置面板显示
    const r = this.renderer.info.render;
    this.frameStats = { calls: r.drawCalls, triangles: r.triangles };
  }

  start() {
    let last = 0;
    const loop = (now) => {
      this.raf = requestAnimationFrame(loop);
      // 帧率上限：raf 仍按屏幕刷新率跑，但只有累积够一帧间隔才真正更新+渲染
      if (this.fpsCap > 0 && now - last < 1000 / this.fpsCap - 0.5) return;
      last = now;
      this.dt = Math.min(this.clock.getDelta(), 0.05);
      this.time += this.dt;
      this.renderer.info.reset();
      for (const fn of this.updaters) fn(this.dt, this.time);
      this.render();
    };
    this.raf = requestAnimationFrame(loop);
  }
}
