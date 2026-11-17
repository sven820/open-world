import * as THREE from "three";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { sharedGLTFLoader } from "../entities/player.js";
import { captureRigState, applyFaceParams } from "./faceParams.js";

// 复用游戏角色的 GLTF/KTX2 加载器：角色贴图走 KHR_texture_basisu，
// 且多个 KTX2Loader 实例会各自创建 worker 池并互相告警。
const sharedLoader = (renderer) => sharedGLTFLoader(renderer);

/**
 * 捏脸专用 3D 预览。独立 renderer / scene / camera，不干扰主游戏引擎。
 */
export class AvatarRig {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: true, preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.05, 100);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.enablePan = false;
    this.controls.minDistance = 0.55;
    this.controls.maxDistance = 3.2;
    this.controls.minPolarAngle = 0.45;
    this.controls.maxPolarAngle = Math.PI - 0.55;
    this.controls.target.set(0, 1.52, 0);

    this._setupLights();
    this._setupStage();

    this.model = null;
    this.rest = null;
    this.running = false;
    this._raf = 0;
    this._trace = null;
    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(canvas.parentElement || canvas);

    this._loop = this._loop.bind(this);
    this.resize();
  }

  _setupLights() {
    this.scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x2a2233, 1.25));
    const key = new THREE.DirectionalLight(0xfff1e0, 2.2);
    key.position.set(1.4, 2.6, 2.2);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x9fc4ff, 0.95);
    fill.position.set(-1.8, 1.4, 1.2);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffcaa0, 1.4);
    rim.position.set(-0.6, 1.8, -2.2);
    this.scene.add(rim);
  }

  _setupStage() {
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.9, 64),
      new THREE.MeshBasicMaterial({ color: 0x14161d, transparent: true, opacity: 0.55, depthWrite: false })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.002;
    this.scene.add(disc);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.88, 0.9, 64),
      new THREE.MeshBasicMaterial({ color: 0xe0231e, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.003;
    this.scene.add(ring);
    this._trace = { disc, ring };
  }

  resize() {
    const parent = this.canvas.parentElement || this.canvas;
    const w = Math.max(1, parent.clientWidth || this.canvas.clientWidth || 640);
    const h = Math.max(1, parent.clientHeight || this.canvas.clientHeight || 640);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  async load(url) {
    const loader = sharedLoader(this.renderer);
    if (MeshoptDecoder.ready) await MeshoptDecoder.ready;
    const gltf = await loader.loadAsync(url);
    const model = gltf.scene;

    const box = new THREE.Box3().setFromObject(model);
    const height = box.max.y - box.min.y;
    const s = height > 0.6 && height < 6 ? 1.74 / height : 1;
    model.scale.setScalar(s);
    model.position.y = -box.min.y * s;
    model.rotation.y = Math.PI;

    let boneCount = 0;
    model.traverse((o) => {
      if (o.isBone) boneCount++;
      if (o.isMesh || o.isSkinnedMesh) {
        o.castShadow = false;
        o.receiveShadow = false;
        o.frustumCulled = false;
      }
    });
    this.boneCount = boneCount;

    if (this.model) this.scene.remove(this.model);
    this.model = model;
    this.scene.add(model);
    this.rest = captureRigState(model);
    this.setView("front");
    return model;
  }

  apply(config) {
    if (!this.rest) return;
    applyFaceParams(this.rest, config);
  }

  setView(view) {
    const t = this.controls.target;
    if (view === "front") {
      t.set(0, 1.52, 0);
      this.camera.position.set(0, 1.56, 1.15);
    } else if (view === "side") {
      t.set(0, 1.52, 0);
      this.camera.position.set(1.15, 1.56, 0);
    } else if (view === "back") {
      t.set(0, 1.52, 0);
      this.camera.position.set(0, 1.56, -1.15);
    } else if (view === "upper") {
      t.set(0, 1.58, 0);
      this.camera.position.set(0.35, 1.72, 0.85);
    }
    this.controls.update();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.resize();
    this._loop();
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
  }

  _loop() {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._loop);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  snapshot(maxSize = 128) {
    try {
      this.renderer.render(this.scene, this.camera);
      const src = this.canvas;
      const scale = Math.min(1, maxSize / Math.max(src.width, src.height));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(src.width * scale));
      c.height = Math.max(1, Math.round(src.height * scale));
      c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
      return c.toDataURL("image/webp", 0.82);
    } catch {
      return "";
    }
  }

  dispose() {
    this.stop();
    this._resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
  }
}
