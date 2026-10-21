import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    this.clock = new THREE.Clock();
    this.time = 0;
    this.dt = 0;
    this.updaters = [];
    this.renderers = [];

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
      stencil: false,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.info.autoReset = true;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x9aa4b0, 0.0016);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.12, 4200);
    camera.position.set(0, 8, 20);
    this.camera = camera;

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.62, 0.55, 0.86);
    composer.addPass(this.bloom);
    composer.addPass(new OutputPass());
    this.composer = composer;

    window.addEventListener("resize", () => this.resize());
    this.resize();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  }

  onUpdate(fn) { this.updaters.push(fn); }

  start() {
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.dt = Math.min(this.clock.getDelta(), 0.05);
      this.time += this.dt;
      for (const fn of this.updaters) fn(this.dt, this.time);
      this.composer.render();
    };
    loop();
  }
}
