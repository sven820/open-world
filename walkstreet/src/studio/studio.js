// 模型工坊（Model Studio）：模型资产的查看 / 材质绑定 / 参数建模工作台。
// 独立模块 —— 只依赖 assetStore（数据层）与 world/materials、world/assetMesh
// （共享渲染层），不 import 任何编辑器；编辑器通过 main.js 的回调跳转进来。

import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import {
  listAssets, getAsset, putAsset, deleteAsset,
  importAssetFromGLB, exportAssetGLB, exportObjectGLB, renderThumb, saveAssetThumb,
  isMemoryOnly,
} from "../data/assetStore.js";
import { listMaterials, getMaterial } from "../world/materials.js";
import { getAssetTemplate, invalidateAssetTemplate, updateAssetAnimations, playAssetClips, stopAssetMixer, getAssetClipNames } from "../world/assetMesh.js";
import "./studio.css";

export class ModelStudio {
  // opts: { initialAssetId?, onClose? }
  constructor(opts = {}) {
    this.opts = opts;
    this._disposed = false;
    this.workspace = null; // { asset, root, bindings, geometryDirty, isNew }
    this.sel = null;       // 当前选中的 Mesh
    this._previewMode = "day"; // 视口预览模式：day / night（昼/夜光照预设）
  }

  /* ---------------- 生命周期 ---------------- */

  async open() {
    this._buildDOM();
    this._buildScene();
    this._wireKeys();
    try {
      await this._threeReady; // WebGPU 设备就绪（含 IBL 生成）后再开渲染循环
    } catch (e) {
      console.error("[studio] 渲染器初始化失败：", e);
    }
    await this._refreshAssetList();
    if (isMemoryOnly()) this._setStatus("注意：IndexedDB 不可用，资产仅保存在内存中（刷新即丢）");
    if (this.opts.initialAssetId) {
      const a = await getAsset(this.opts.initialAssetId);
      if (a) await this._loadAsset(a);
      else this._setStatus("未找到指定资产，已打开空工作台");
    }
    this._raf = requestAnimationFrame(this._tick);
  }

  close() {
    if (this._disposed) return; // onClose 可能再调 closeStudio()→close()，防重入死循环
    this._disposed = true;
    cancelAnimationFrame(this._raf);
    if (this._lightbarOutside) {
      document.removeEventListener("pointerdown", this._lightbarOutside);
      this._lightbarOutside = null;
    }
    if (this._iblTex) { this._iblTex.dispose(); this._iblTex = null; }
    if (this._tc) this._tc.dispose();
    if (this._orbit) this._orbit.dispose();
    if (this._renderer) this._renderer.dispose();
    for (const u of Object.values(this._thumbUrls || {})) URL.revokeObjectURL(u);
    if (this._el) this._el.remove();
    // 关键：通知宿主恢复入口 UI（主菜单）。不回调的话菜单停留在 hidden，
    // 用户关掉工坊后只剩底层游戏世界
    if (this.opts.onClose) this.opts.onClose();
  }

  _buildDOM() {
    const el = document.createElement("div");
    el.id = "model-studio";
    el.innerHTML = `
      <div class="ms3-side left">
        <h4>模型资产库 <span class="ms3-badge" id="ms3-count"></span></h4>
        <div class="ms3-scroll">
          <div class="ms3-field">
            <button class="ms3-btn primary" id="ms3-import" style="width:100%">导入 GLB 模型</button>
            <input type="file" id="ms3-file" accept=".glb,.gltf" style="display:none" />
          </div>
          <div class="ms3-field">
            <button class="ms3-btn" id="ms3-new" style="width:100%">＋ 新建参数模型</button>
          </div>
          <input id="ms3-search" placeholder="搜索资产…" class="ms3-search" style="width:100%;box-sizing:border-box;background:#14171a;color:#d8dce2;border:1px solid #343b44;border-radius:6px;padding:6px 8px;font-size:13px;margin-bottom:8px" />
          <div id="ms3-list"></div>
        </div>
      </div>
      <div class="ms3-canvas-wrap">
        <div class="ms3-topbar">
          <span class="ms3-title">模型工坊 <small>STUDIO</small></span>
          <div class="ms3-tb-sep"></div>
          <div class="ms3-tb-group" role="group" aria-label="变换工具">
            <button class="ms3-tbtn active" id="ms3-mode-w" title="移动 (W)">
              <svg viewBox="0 0 16 16"><path d="M8 1.5v13M1.5 8h13M8 1.5L6.2 3.3M8 1.5l1.8 1.8M8 14.5l-1.8-1.8m1.8 1.8l1.8-1.8M1.5 8l1.8-1.8M1.5 8l1.8 1.8M14.5 8l-1.8-1.8m1.8 1.8l-1.8 1.8"/></svg>
              <span>移动</span><kbd>W</kbd>
            </button>
            <button class="ms3-tbtn" id="ms3-mode-e" title="旋转 (E)">
              <svg viewBox="0 0 16 16"><path d="M13.5 8A5.5 5.5 0 1 1 12 4.1"/><path d="M12.4 1.4v3h3"/></svg>
              <span>旋转</span><kbd>E</kbd>
            </button>
            <button class="ms3-tbtn" id="ms3-mode-r" title="缩放 (R)">
              <svg viewBox="0 0 16 16"><rect x="2" y="8.5" width="5.5" height="5.5" rx="1"/><path d="M9 7l4.8-4.8M13.8 2.2h-3.2m3.2 0v3.2"/></svg>
              <span>缩放</span><kbd>R</kbd>
            </button>
          </div>
          <div class="ms3-tb-spacer"></div>
          <div class="ms3-tb-group" id="ms3-tb-right">
            <button class="ms3-btn primary" id="ms3-save" title="保存到资产库 (Ctrl+S)">保存资产</button>
            <button class="ms3-btn" id="ms3-export" title="导出为 .glb 文件">导出 GLB</button>
            <div class="ms3-tb-sep"></div>
            <button class="ms3-btn" id="ms3-close">返回</button>
          </div>
        </div>
        <div class="ms3-status" id="ms3-status">左键旋转视角 · 滚轮缩放 · 右键平移 · 点选部件编辑</div>
      </div>
      <div class="ms3-side">
        <h4>属性 <span id="ms3-asset-badge"></span></h4>
        <div class="ms3-scroll" id="ms3-props">
          <div class="ms3-empty">从左侧资产库选择一个资产<br>或导入 GLB / 新建参数模型开始设计</div>
        </div>
      </div>`;
    document.body.appendChild(el);
    this._el = el;

    el.querySelector("#ms3-close").addEventListener("click", () => this.close());
    el.querySelector("#ms3-import").addEventListener("click", () => el.querySelector("#ms3-file").click());
    el.querySelector("#ms3-file").addEventListener("change", (e) => this._onImportFile(e.target.files[0]));
    el.querySelector("#ms3-new").addEventListener("click", () => this._newWorkspace());
    el.querySelector("#ms3-save").addEventListener("click", () => this._save());
    el.querySelector("#ms3-export").addEventListener("click", () => this._export());
    el.querySelector("#ms3-search").addEventListener("input", () => this._refreshAssetList());
    for (const [id, mode] of [["#ms3-mode-w", "translate"], ["#ms3-mode-e", "rotate"], ["#ms3-mode-r", "scale"]]) {
      el.querySelector(id).addEventListener("click", () => this._setMode(mode));
    }
  }

  _buildScene() {
    const wrap = this._el.querySelector(".ms3-canvas-wrap");
    // WebGPU 渲染器（不可用时自动回退 WebGL2）
    const renderer = new THREE.WebGPURenderer({ antialias: true });
    renderer.shadowMap.enabled = true;
    wrap.appendChild(renderer.domElement);
    // 后端就绪后生成 IBL（PMREM 预滤波需要渲染设备）：RoomEnvironment 经
    // PMREM 预滤波 → 每个方向都有光（背光面不死黑）、金属/光泽材质有真实反射；
    // 与四盏灯独立，面板可单独开关
    this._threeReady = renderer.init().then(() => {
      // addons 的 RoomEnvironment 内部 PointLight 来自核心 'three' 构建，与
      // three/webgpu 构建的同名类不是同一实例，WebGPU 光照节点按类匹配不到
      // （LightsNode 警告）→ 换成 webgpu 构建的同参 PointLight
      const roomEnv = new RoomEnvironment();
      const stale = [];
      roomEnv.traverse((o) => { if (o.isPointLight) stale.push(o); });
      for (const old of stale) {
        const l = new THREE.PointLight(old.color, old.intensity, old.distance, old.decay);
        l.position.copy(old.position);
        roomEnv.add(l);
        roomEnv.remove(old);
      }
      const pmrem = new THREE.PMREMGenerator(renderer);
      this._iblTex = pmrem.fromScene(roomEnv, 0.04).texture;
      pmrem.dispose();
      // IBL 默认关闭（面板里手动开）；贴图已就绪，打开是零成本切换
    });
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1e23);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
    camera.position.set(28, 22, 32);
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.target.set(0, 8, 0);
    orbit.maxPolarAngle = Math.PI / 2 - 0.02;

    const hemi = new THREE.HemisphereLight(0xcfd8e6, 0x3a4046, 1.15); // 地面色提亮，背光面不再死黑
    const sun = new THREE.DirectionalLight(0xffffff, 2.4);
    sun.position.set(30, 50, 20);
    sun.castShadow = true;
    sun.shadow.camera.left = -80; sun.shadow.camera.right = 80;
    sun.shadow.camera.top = 80; sun.shadow.camera.bottom = -80;
    sun.shadow.mapSize.set(2048, 2048);
    // 反向补光：太阳对角弱光（不投影），背光面有基本层次
    const fill = new THREE.DirectionalLight(0xdfe8f2, 0.55);
    fill.position.set(-24, 18, -30);
    // 相机随行补光：方向始终沿视线，转到任何角度面向相机的面都可读
    const camFill = new THREE.DirectionalLight(0xffffff, 0.35);
    camFill.position.set(0.4, 0.6, 1);
    const camFillTarget = new THREE.Object3D();
    camFillTarget.position.set(0, 0, -1);
    camera.add(camFill, camFillTarget);
    camFill.target = camFillTarget;
    scene.add(camera); // 相机挂灯必须把相机加进场景才生效
    const grid = new THREE.GridHelper(200, 100, 0x3a424c, 0x262c33);
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(100, 48).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x22272d, roughness: 1 }),
    );
    ground.position.y = -0.02;
    ground.receiveShadow = true;
    this._ground = ground; // 昼/夜预设需同步调地面颜色
    scene.add(hemi, sun, fill, grid, ground);

    const tc = new TransformControls(camera, renderer.domElement);
    tc.addEventListener("dragging-changed", (e) => { orbit.enabled = !e.value; });
    tc.addEventListener("mouseUp", () => { this._geometryDirty = true; this._renderProps(); });
    scene.add(tc.getHelper());

    this._three = { renderer, scene, camera, orbit, tc, wrap };
    this._lights = { hemi, sun, fill, camFill }; // 供光照工具条勾选
    this._buildLightBar(wrap);
    this._workspaceRoot = new THREE.Group();
    scene.add(this._workspaceRoot);
    this._resize();
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(wrap);
  }

  _resize() {
    const { renderer, camera, wrap } = this._three;
    const w = wrap.clientWidth || 800, h = wrap.clientHeight || 600;
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  _tick = () => {
    if (this._disposed) return;
    this._raf = requestAnimationFrame(this._tick);
    const { orbit, renderer, scene, camera, tc } = this._three;
    orbit.update();
    if (tc.dragging) this._syncDrag();
    // GLB 内建动画（如小火车）随实例播放
    this._clock = this._clock || new THREE.Clock();
    updateAssetAnimations(this._clock.getDelta());
    renderer.render(scene, camera);
  };

  /* ---------------- 资产库面板 ---------------- */

  async _refreshAssetList() {
    const kw = this._el.querySelector("#ms3-search").value.trim();
    const list = await listAssets({ keyword: kw });
    const box = this._el.querySelector("#ms3-list");
    this._thumbUrls = this._thumbUrls || {};
    box.innerHTML = "";
    this._el.querySelector("#ms3-count").textContent = String(list.length);
    if (!list.length) {
      box.innerHTML = `<div class="ms3-empty">还没有资产。<br>导入 GLB 或新建参数模型。</div>`;
      return;
    }
    for (const a of list) {
      const card = document.createElement("div");
      card.className = "ms3-card" + (this.workspace && this.workspace.asset.id === a.id ? " active" : "");
      const srcZh = { glb: "GLB", traced: "描边", studio: "自建" }[a.source] || a.source;
      card.innerHTML = `
        ${a.thumb ? `<img src="${this._thumbUrls[a.id] || (this._thumbUrls[a.id] = URL.createObjectURL(a.thumb))}" />` : `<img src="" style="opacity:.2" />`}
        <div class="ms3-card-info"><b>${esc(a.name || "未命名")}</b>
        <small>${esc(a.category || "")} · ${srcZh}${a.meshCount ? " · " + a.meshCount + " mesh" : ""}</small></div>
        <button class="ms3-card-del" title="删除资产">×</button>`;
      card.addEventListener("click", async () => {
        const fresh = await getAsset(a.id);
        if (fresh) await this._loadAsset(fresh);
      });
      card.querySelector(".ms3-card-del").addEventListener("click", (e) => {
        e.stopPropagation(); // 别触发卡片载入
        this._deleteAsset(a.id, a.name || "未命名");
      });
      box.appendChild(card);
    }
  }

  async _deleteAsset(id, name) {
    if (!confirm(`确定删除资产「${name}」？该操作不可恢复。`)) return;
    try {
      await deleteAsset(id);
      invalidateAssetTemplate(id); // 模板缓存同步失效
      if (this._thumbUrls && this._thumbUrls[id]) {
        URL.revokeObjectURL(this._thumbUrls[id]);
        delete this._thumbUrls[id];
      }
      if (this.workspace && this.workspace.asset.id === id) this._clearWorkspace();
      await this._refreshAssetList();
      this._setStatus(`已删除「${name}」`);
    } catch (e) {
      console.error(e);
      this._setStatus("删除失败：" + (e && e.message ? e.message : e));
    }
  }

  async _onImportFile(file) {
    if (!file) return;
    this._setStatus(`正在导入「${file.name}」…`);
    try {
      const asset = await importAssetFromGLB(file);
      this._setStatus(`已导入「${asset.name}」· ${asset.meshCount} 个网格 · 请在右侧绑定材质后保存`);
      await this._loadAsset(asset);
      // 导入即出缩略图（复用刚载入的工作台几何；否则列表卡片一直空图，
      // 要等用户手动点保存才有图）
      if (this.workspace && this.workspace.root.children.length) {
        try {
          const thumb = await renderThumb(this.workspace.root.clone(true));
          await saveAssetThumb(asset.id, thumb);
        } catch (e) {
          console.warn("[studio] 缩略图生成失败:", e);
        }
      }
      await this._refreshAssetList();
    } catch (e) {
      console.error(e);
      this._setStatus("导入失败：" + (e && e.message ? e.message : "GLB 解析错误"));
    }
  }

  /* ---------------- 工作台 ---------------- */

  async _loadAsset(asset) {
    this._clearWorkspace();
    const tpl = await getAssetTemplate(asset);
    const root = new THREE.Group();
    root.name = "asset-root";
    if (tpl) {
      const inst = tpl.clone();
      // 描边资产：标记绑定键（wall/roof），供材质绑定 UI 与保存回写用
      if (asset.source === "traced") {
        inst.traverse((o) => {
          if (o.isMesh) o.userData.bindingKey = isRoofMesh(o) ? "roof" : "wall";
        });
      }
      root.add(inst);
      // GLB 内建动画（如小火车）在工作台同步演示；配置随资产记录（勾选片段/倍速）
      this._clipNames = getAssetClipNames(asset.id);
      this._wsMixer = playAssetClips(asset.id, root, asset.animation);
    } else {
      this._clipNames = [];
      this._wsMixer = null;
    }
    const bindings = { ...(asset.materialBindings || {}) };
    let needsExport = false;
    if (tpl && asset.source === "glb") {
      // 旧版导出的 GLB 材质无名，绑定键对不上：按 mesh 遍历序把绑定表
      // 逐个迁回（本工作台导出的 mesh 顺序 = 绑定键插入顺序，可靠对应），
      // 保存时材质名会随重导出写回 GLB，自此往返闭环
      const unnamed = [];
      root.traverse((o) => { if (o.isMesh && !o.userData.bindingKey) unnamed.push(o); });
      if (unnamed.length) {
        const entries = Object.entries(bindings);
        unnamed.forEach((mesh, i) => {
          if (i < entries.length) {
            mesh.userData.bindingKey = entries[i][0];
            const lib = entries[i][1] && getMaterial(entries[i][1]);
            if (lib) mesh.material = lib;
          } else {
            mesh.userData.bindingKey = `mesh:${i + 1}`;
          }
        });
        needsExport = true;
      }
    }
    this.workspace = {
      asset,
      root,
      bindings,
      geometryDirty: false,
      needsExport, // 绑定变化也要重导 GLB（材质名写进 GLB 才能往返）
      isNew: false,
    };
    this._workspaceRoot.add(root);
    this._applyNightEmissive(); // 夜景预览模式下，新载入资产的自发光立即生效
    this._renderProps();
    this._refreshAssetList();
    if (!tpl) {
      this._setStatus(`警告：「${asset.name}」几何加载失败（见控制台），工作台为空`);
      return;
    }
    this._frameView();
    this._setStatus(`已载入「${asset.name}」· 左侧场景树点选部件，右侧换材质；改完记得保存`);
  }

  _newWorkspace() {
    this._clearWorkspace();
    const root = new THREE.Group();
    root.name = "asset-root";
    this.workspace = {
      asset: { name: "新模型", category: "custom", source: "studio", materialBindings: {}, unitSize: { x: 0, y: 0, z: 0 } },
      root,
      bindings: {},
      geometryDirty: false,
      isNew: true,
    };
    this._workspaceRoot.add(root);
    this._partSeq = 0;
    this._renderProps();
    this._setStatus("空白工作台：用「＋ 添加部件」开始搭建，保存时自动生成 GLB");
  }

  _clearWorkspace() {
    this._deselect();
    stopAssetMixer(this._wsMixer);
    this._wsMixer = null;
    this._clipNames = [];
    this._workspaceRoot.clear();
    this.workspace = null;
    this._renderProps();
  }

  // 相机对准当前工作台模型（任意尺寸都能进画面；空场景回默认位）
  _frameView() {
    const { camera, orbit } = this._three;
    const box = new THREE.Box3().setFromObject(this._workspaceRoot);
    if (box.isEmpty()) {
      camera.position.set(28, 22, 32);
      orbit.target.set(0, 8, 0);
      orbit.update();
      return;
    }
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const d = Math.max(sphere.radius, 1) / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.2;
    const dir = new THREE.Vector3(0.7, 0.55, 0.7).normalize();
    camera.position.copy(sphere.center).addScaledVector(dir, d);
    camera.near = Math.max(d / 1000, 0.1);
    camera.far = Math.max(d * 20, 5000);
    camera.updateProjectionMatrix();
    orbit.target.copy(sphere.center);
    orbit.update();
  }

  /* ---------------- 选择 / 变换 ---------------- */

  _select(obj) {
    this.sel = obj || null;
    const tc = this._three.tc;
    if (obj) { tc.attach(obj); this._expandTo(obj); }
    else tc.detach();
    this._renderProps();
    this._renderTree();
  }

  _deselect() { this._select(null); }

  _setMode(mode) {
    this._three.tc.setMode(mode);
    for (const [id, m] of [["#ms3-mode-w", "translate"], ["#ms3-mode-e", "rotate"], ["#ms3-mode-r", "scale"]]) {
      this._el.querySelector(id).classList.toggle("active", m === mode);
    }
  }

  _syncDrag() {
    // 拖拽部件时禁止沉到地面以下（y≥0），松手后标记几何已变
    if (this.sel && this.sel.position.y < 0) this.sel.position.y = 0;
  }

  _wireKeys() {
    this._keyHandler = (e) => {
      if (this._disposed || this._el.classList.contains("hidden")) return;
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
      if (e.key === "w" || e.key === "W") this._setMode("translate");
      else if (e.key === "e" || e.key === "E") this._setMode("rotate");
      else if (e.key === "r" || e.key === "R") this._setMode("scale");
      else if (e.key === "Escape") this._deselect();
      else if (e.key === "Delete" || e.key === "Backspace") this._deleteSelected();
      else if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); this._save(); }
    };
    window.addEventListener("keydown", this._keyHandler);
    // 点选部件（射线拾取）
    this._el.querySelector("canvas").addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || this._three.tc.dragging) return;
      const { raycaster, camera } = { raycaster: new THREE.Raycaster(), camera: this._three.camera };
      const r = this._three.renderer.domElement.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1,
      ), camera);
      const hits = raycaster.intersectObjects(this._workspaceRoot.children, true);
      const hit = hits.find((h) => h.object.isMesh);
      this._select(hit ? hit.object : null);
    });
  }

  /* ---------------- 参数建模（P2） ---------------- */

  _addPrimitive(kind) {
    if (!this.workspace) return;
    const mats = {
      box: () => new THREE.BoxGeometry(4, 4, 4),
      cylinder: () => new THREE.CylinderGeometry(2, 2, 5, 16),
      sphere: () => new THREE.SphereGeometry(2.5, 20, 14),
      slab: () => new THREE.BoxGeometry(8, 0.4, 8),
    };
    const mesh = new THREE.Mesh(mats[kind](), new THREE.MeshStandardMaterial({
      color: 0xb8b2a6, roughness: 0.85, name: this._nextPartKey(),
    }));
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData.bindingKey = mesh.material.name;
    mesh.position.set(0, kind === "slab" ? 0.2 : 2, 0);
    mesh.name = `${kind}-${++this._partSeq}`;
    this.workspace.root.add(mesh);
    this.workspace.geometryDirty = true;
    this._select(mesh);
    this._setStatus(`已添加 ${mesh.name} · W 移动 / E 旋转 / R 缩放 · Delete 删除`);
  }

  _nextPartKey() { return `part:${(this._partSeq || 0) + 1}`; }

  _duplicateSelected() {
    if (!this.sel) return;
    const copy = this.sel.clone();
    copy.material = this.sel.material;
    copy.position.x += 3;
    copy.name = this.sel.name + "-copy";
    copy.userData = { ...this.sel.userData, bindingKey: this._nextPartKey() };
    copy.material = this.sel.material.clone();
    copy.material.name = copy.userData.bindingKey;
    this.workspace.root.add(copy);
    this.workspace.geometryDirty = true;
    this._select(copy);
  }

  _deleteSelected() {
    if (!this.sel || !this.workspace) return;
    this.workspace.root.remove(this.sel);
    this.workspace.geometryDirty = true;
    this._deselect();
    this._renderTree();
    this._setStatus("已删除部件");
  }

  /* ---------------- 阵列 / 镜像（M5，纯 three 实现不引 CSG 依赖） ---------------- */

  // 以选中部件为种子，按其包围盒尺寸 +0.5m 间距复制 3×3 阵列
  _arraySelected() {
    if (!this.sel || !this.workspace) return;
    const src = this.sel;
    const box = new THREE.Box3().setFromObject(src);
    const size = box.isEmpty() ? new THREE.Vector3(4, 0, 4) : box.getSize(new THREE.Vector3());
    const sx = size.x + 0.5, sz = size.z + 0.5;
    let n = 0;
    for (let ix = -1; ix <= 1; ix++) {
      for (let iz = -1; iz <= 1; iz++) {
        if (!ix && !iz) continue;
        const copy = this._clonePart(src, src.name + `-a${++n}`);
        copy.position.x += ix * sx;
        copy.position.z += iz * sz;
        this.workspace.root.add(copy);
      }
    }
    this.workspace.geometryDirty = true;
    this._renderTree();
    this._setStatus(`已生成 3×3 阵列（+8 个部件）· 各部件可单独选中调整`);
  }

  // 沿选中部件自身中心的 X 轴镜像复制（几何级镜像：翻绕序 + 翻法线，材质保持共享）
  _mirrorSelected() {
    if (!this.sel || !this.workspace) return;
    const src = this.sel;
    const copy = this._clonePart(src, src.name + "-mirror");
    copy.geometry = mirroredGeometry(src.geometry);
    const box = new THREE.Box3().setFromObject(src);
    const c = box.isEmpty() ? 0 : box.getCenter(new THREE.Vector3()).x;
    copy.position.x = 2 * c - src.position.x;
    this.workspace.root.add(copy);
    this.workspace.geometryDirty = true;
    this._renderTree();
    this._setStatus("已镜像复制部件");
  }

  _clonePart(src, name) {
    const copy = src.clone();
    copy.name = name;
    copy.userData = { ...src.userData, bindingKey: this._nextPartKey() };
    copy.material = src.material.clone();
    copy.material.name = copy.userData.bindingKey;
    return copy;
  }

  /* ---------------- 材质绑定 ---------------- */

  _bindMaterial(libId) {
    if (!this.sel) return;
    const key = this.sel.userData.bindingKey || this.sel.material.name || "unnamed";
    this.sel.userData.bindingKey = key;
    if (libId) {
      const lib = getMaterial(libId);
      if (!lib) return;
      this.sel.material = lib;
      this.workspace.bindings[key] = libId;
    } else {
      delete this.workspace.bindings[key];
      this._setStatus("已解除绑定（保留原材质，保存后固定进 GLB）");
      return;
    }
    this.workspace.needsExport = true; // 绑定变了 → GLB 里的材质名需要重写
    this._renderTree();
    this._renderProps();
    this._setStatus(`已绑定「${key}」→ ${libId}`);
  }

  /* ---------------- 保存 / 导出 ---------------- */

  async _save() {
    if (!this.workspace) return;
    const nameInput = this._el.querySelector("#ms3-name");
    if (nameInput) this.workspace.asset.name = nameInput.value.trim() || "未命名";
    const catInput = this._el.querySelector("#ms3-cat");
    if (catInput) this.workspace.asset.category = catInput.value;
    this.workspace.asset.materialBindings = { ...this.workspace.bindings };

    try {
      if (this.workspace.isNew || this.workspace.geometryDirty || this.workspace.needsExport) {
        // 几何/绑定有变（或新建）：整个工作台导出为 GLB，资产升级为 glb 存储。
        // 导出副本把每个 mesh 的材质改名为绑定键（part:1 / wall / roof）——
        // 共享库实例没有名字，直接导出会让 GLB 往返丢失绑定关系
        this.workspace.asset.glb = await exportObjectGLB(this._exportRoot());
        this.workspace.asset.source = "glb";
        this.workspace.asset.traced = undefined;
        const box = new THREE.Box3().setFromObject(this.workspace.root);
        if (!box.isEmpty()) {
          const s = box.getSize(new THREE.Vector3());
          this.workspace.asset.unitSize = { x: +s.x.toFixed(2), y: +s.y.toFixed(2), z: +s.z.toFixed(2) };
        }
        this.workspace.geometryDirty = false;
        this.workspace.needsExport = false;
        this.workspace.isNew = false;
      }
      const saved = await putAsset(this.workspace.asset);
      this.workspace.asset.id = saved.id;
      invalidateAssetTemplate(saved.id);
      // 缩略图：克隆工作台（renderThumb 会把对象加进临时场景）
      const thumb = await renderThumb(this.workspace.root.clone(true));
      await saveAssetThumb(saved.id, thumb);
      this._setStatus(`已保存「${saved.name}」· 可在 3D 地图编辑器的「我的模型」中放置`);
      this._refreshAssetList();
      this._renderProps();
    } catch (e) {
      console.error(e);
      this._setStatus("保存失败：" + (e && e.message ? e.message : e));
    }
  }

  async _export() {
    if (!this.workspace) return;
    try {
      let blob;
      if (this.workspace.geometryDirty || this.workspace.needsExport || this.workspace.isNew) {
        blob = await exportObjectGLB(this._exportRoot());
      } else {
        blob = await exportAssetGLB(this.workspace.asset.id);
      }
      if (!blob) { this._setStatus("该资产没有可导出的几何"); return; }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${this.workspace.asset.name || "model"}.glb`;
      a.click();
      URL.revokeObjectURL(a.href);
      this._setStatus("已导出 GLB");
    } catch (e) {
      this._setStatus("导出失败：" + e);
    }
  }

  // 导出用工作台副本：mesh 材质克隆并改名为绑定键，供重导入时按名匹配
  _exportRoot() {
    const copy = this.workspace.root.clone(true);
    copy.traverse((o) => {
      if (!o.isMesh) return;
      const key = o.userData.bindingKey;
      if (!key) return;
      const m = o.material.clone();
      m.name = key;
      o.material = m;
    });
    return copy;
  }

  /* ---------------- 右侧面板 ---------------- */

  _renderProps() {
    const box = this._el.querySelector("#ms3-props");
    const badge = this._el.querySelector("#ms3-asset-badge");
    if (!this.workspace) {
      badge.textContent = "";
      box.innerHTML = `<div class="ms3-empty">从左侧资产库选择一个资产<br>或导入 GLB / 新建参数模型开始设计</div>`;
      return;
    }
    const a = this.workspace.asset;
    badge.textContent = a.name || "";
    // 选中对象可能是 Group（无材质）：材质绑定/夜景控件仅对 mesh 显示
    const selMat = this.sel && this.sel.material ? this.sel.material : null;
    const selKey = this.sel ? ((this.sel.userData && this.sel.userData.bindingKey) || (selMat && selMat.name)) : null;
    const partCfg = selKey && a.nightGlow && a.nightGlow.parts && a.nightGlow.parts[selKey];
    const partShared = this.sel && this.sel.material && this.sel.material.userData && this.sel.material.userData.shared;
    const selInfo = this.sel
      ? `<div class="ms3-field">
           <label>选中部件：${esc(this.sel.name || "(未命名 mesh)")}${this.sel.isMesh ? "" : "（组）"}</label>
           <div class="ms3-row"><input id="ms3-part-name" value="${esc(this.sel.name || "")}" maxlength="32" placeholder="部件名称" /><button class="ms3-btn" id="ms3-part-rename">改名</button></div>
           ${selMat ? `<select id="ms3-mat"><option value="">（保留原材质 · 未绑定）</option>${this._materialOptions(this.workspace.bindings[selKey])}</select>` : `<div class="ms3-hint">组节点：展开/收起子部件、整组重命名；材质绑定请选具体 mesh。</div>`}
         </div>
         <div class="ms3-row">
           <button class="ms3-btn" id="ms3-dup">复制</button>
           <button class="ms3-btn" id="ms3-mirror">镜像</button>
           <button class="ms3-btn" id="ms3-array">阵列</button>
           <button class="ms3-btn danger" id="ms3-del">删除</button>
         </div>
         ${!selMat
           ? `<div class="ms3-hint">组节点不参与材质/夜景设置。</div>`
           : partShared
           ? `<div class="ms3-hint">该部件已绑定标准材质，夜景亮度跟随材质库，不支持单独调整。</div>`
           : `${(() => {
               const on = partCfg ? partCfg.on !== false : true;
               const st = partCfg ? partCfg.strength : ((a.nightGlow && a.nightGlow.strength != null) ? a.nightGlow.strength : 0.7);
               return `
         <h4 style="border:none;padding-left:0">部件夜景</h4>
         <div class="ms3-field"><label>模式</label><select id="ms3-pg-mode">
           <option value=""${!partCfg ? " selected" : ""}>跟随全局</option>
           <option value="custom"${partCfg ? " selected" : ""}>单独调整</option>
         </select></div>
         <div class="ms3-field"${partCfg ? "" : ` style="opacity:.45;pointer-events:none"`}>
           <label class="ms3-check" style="border:none;padding:2px 0"><input type="checkbox" id="ms3-pg-on" ${on ? "checked" : ""} />夜间发光</label>
           <label>发光强度 <span id="ms3-pg-val">${st}</span></label>
           <input id="ms3-pg-strength" type="range" min="0" max="2" step="0.05" value="${st}" />
         </div>`; })()}`}`
      : `<div class="ms3-hint">点选画布中的部件或场景树条目后，可在此绑定标准材料库材质（换肤/夜间灯光全城生效）。</div>`;
    const cats = ["building", "prop", "vehicle", "custom"];
    box.innerHTML = `
      <div class="ms3-field"><label>名称</label><input id="ms3-name" value="${esc(a.name || "")}" maxlength="24" /></div>
      <div class="ms3-field"><label>分类</label><select id="ms3-cat">${cats.map((c) => `<option value="${c}"${a.category === c ? " selected" : ""}>${{ building: "建筑", prop: "道具", vehicle: "载具", custom: "自定义" }[c]}</option>`).join("")}</select></div>
      <div class="ms3-field"><label>来源</label><input value="${{ glb: "GLB 模型", traced: "描边建筑", studio: "参数建模" }[a.source] || a.source}" disabled /></div>
      ${a.unitSize ? `<div class="ms3-hint">包围盒：${a.unitSize.x} × ${a.unitSize.y} × ${a.unitSize.z} m（碰撞自动按放置缩放生成 AABB）</div>` : ""}
      ${this._clipNames && this._clipNames.length ? `
      <h4 style="border:none;padding-left:0">动画 <small style="color:#7d8794">${this._clipNames.length} 个片段</small></h4>
      ${this._clipNames.map((c) => `<label class="ms3-check"><input type="checkbox" data-clip="${esc(c.name)}" ${this._clipOn(c.name) ? "checked" : ""} />${esc(c.name)}<small style="margin-left:auto;color:#7d8794">${c.duration}s</small></label>`).join("")}
      <div class="ms3-field"><label>播放速度 <span id="ms3-anim-speed-val">${((a.animation && a.animation.speed) || 1)}×</span></label><input id="ms3-anim-speed" type="range" min="0.25" max="3" step="0.05" value="${((a.animation && a.animation.speed) || 1)}" /></div>` : ""}
      ${this._glowMats().length ? (() => {
        const cfg = a.nightGlow || {};
        const on = cfg.on !== false;
        const st = cfg.strength != null ? cfg.strength : 0.7;
        return `
      <h4 style="border:none;padding-left:0">夜景自发光</h4>
      <label class="ms3-check"><input type="checkbox" id="ms3-glow-on" ${on ? "checked" : ""} />夜间发光（贴图亮部点亮）</label>
      <div class="ms3-field"><label>发光强度 <span id="ms3-glow-val">${st}</span></label><input id="ms3-glow-strength" type="range" min="0" max="2" step="0.05" value="${st}" /></div>`;
      })() : ""}
      <div style="margin-bottom:10px">
        <button class="ms3-btn" id="ms3-add-box" style="width:100%;margin-bottom:6px">＋ 添加部件 · 盒</button>
        <div class="ms3-row">
          <button class="ms3-btn" id="ms3-add-cyl">圆柱</button>
          <button class="ms3-btn" id="ms3-add-sph">球</button>
          <button class="ms3-btn" id="ms3-add-slab">薄板</button>
        </div>
        <div class="ms3-hint">部件类型：盒/圆柱/球/薄板 = 参数化基础体，适合搭建筑体块；GLB 导入的部件 = 原模型网格。每个部件有绑定键，用于绑材质与夜景亮度。</div>
      </div>
      <h4 style="border:none;padding-left:0">场景部件</h4>
      <div id="ms3-tree" style="margin-bottom:10px"></div>
      ${selInfo}`;
    // wire
    const on = (id, fn) => { const n = box.querySelector(id); if (n) n.addEventListener("click", fn); };
    on("#ms3-add-box", () => this._addPrimitive("box"));
    on("#ms3-add-cyl", () => this._addPrimitive("cylinder"));
    on("#ms3-add-sph", () => this._addPrimitive("sphere"));
    on("#ms3-add-slab", () => this._addPrimitive("slab"));
    // 部件重命名：写节点 name，保存时随 GLB 重导出持久化（绑定键不变，材质关系不丢）
    const renameInput = box.querySelector("#ms3-part-name");
    const renameBtn = box.querySelector("#ms3-part-rename");
    if (renameInput && renameBtn) {
      const applyRename = () => {
        const v = renameInput.value.trim();
        if (!v || !this.sel) { renameInput.value = this.sel ? (this.sel.name || "") : ""; return; }
        const old = this.sel.name;
        this.sel.name = v;
        this.workspace.geometryDirty = true; // 节点名随 GLB 重导出写回
        this._renderTree();
        this._setStatus(`已重命名「${old}」→「${v}」· 保存资产后写入 GLB`);
      };
      renameBtn.addEventListener("click", applyRename);
      renameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") applyRename(); });
    }
    on("#ms3-dup", () => this._duplicateSelected());
    on("#ms3-mirror", () => this._mirrorSelected());
    on("#ms3-array", () => this._arraySelected());
    on("#ms3-del", () => this._deleteSelected());
    const matSel = box.querySelector("#ms3-mat");
    if (matSel) matSel.addEventListener("change", (e) => this._bindMaterial(e.target.value));
    // 动画配置：勾选片段 / 调速度 → 实时重启工作台预览；写入资产记录后「保存」持久化
    const speedInput = box.querySelector("#ms3-anim-speed");
    if (speedInput) {
      const applyAnim = () => {
        const checked = [...box.querySelectorAll("input[data-clip]:checked")].map((n) => n.dataset.clip);
        const speed = +speedInput.value || 1;
        const enabled = checked.length === this._clipNames.length ? null : checked; // 全选 = 不限（后续新片段自动生效）
        this.workspace.asset.animation = { enabled, speed };
        box.querySelector("#ms3-anim-speed-val").textContent = speed + "×";
        stopAssetMixer(this._wsMixer);
        this._wsMixer = playAssetClips(this.workspace.asset.id, this.workspace.root, this.workspace.asset.animation);
        this._setStatus(`动画配置：${checked.length}/${this._clipNames.length} 片段 · ${speed}× · 点「保存资产」持久化`);
      };
      box.querySelectorAll("input[data-clip]").forEach((n) => n.addEventListener("change", applyAnim));
      speedInput.addEventListener("input", applyAnim);
    }
    // 夜景自发光：改动即时把工作台材质调到对应夜间亮度（工坊内 = 静态夜晚预览），
    // 写入资产记录后「保存」持久化；游戏内按实际夜色系数自动过渡
    const glowOn = box.querySelector("#ms3-glow-on");
    if (glowOn) {
      const applyGlow = () => {
        const on = glowOn.checked;
        const s = +box.querySelector("#ms3-glow-strength").value;
        this.workspace.asset.nightGlow = { on, strength: s };
        box.querySelector("#ms3-glow-val").textContent = String(s);
        this._applyNightEmissive(); // 夜景预览下即时反映；白天模式仅记录配置
        this._setStatus(`夜景发光：${on ? "开 · 强度 " + s : "关"}（在「☀ 环境」面板切到夜晚预览）· 保存持久化`);
      };
      glowOn.addEventListener("change", applyGlow);
      box.querySelector("#ms3-glow-strength").addEventListener("input", applyGlow);
    }
    // 部件级夜景：单独调整的部件克隆独立材质（slider 连续拖动只克隆一次），
    // 配置写 nightGlow.parts[绑定键]；「跟随全局」删配置并同步回全局值
    const pgMode = box.querySelector("#ms3-pg-mode");
    if (pgMode && this.sel) {
      const applyPart = () => {
        const custom = pgMode.value === "custom";
        const key = this.sel.userData.bindingKey || this.sel.material.name;
        const a2 = this.workspace.asset;
        a2.nightGlow = a2.nightGlow || { on: true, strength: 0.7 };
        a2.nightGlow.parts = a2.nightGlow.parts || {};
        let cfg;
        if (custom) {
          cfg = { on: box.querySelector("#ms3-pg-on").checked, strength: +box.querySelector("#ms3-pg-strength").value };
          a2.nightGlow.parts[key] = cfg;
        } else {
          delete a2.nightGlow.parts[key];
          cfg = { on: a2.nightGlow.on !== false, strength: a2.nightGlow.strength != null ? a2.nightGlow.strength : 0.7 };
        }
        let m = this.sel.material;
        if (m && m.emissiveMap && !(m.userData && m.userData.shared)) {
          if (!(m.userData && m.userData.partGlowKey === key)) {
            const c = m.clone();
            c.userData.partGlowKey = key;
            this.sel.material = c;
            m = c;
          }
          this._applyNightEmissive(); // 夜景预览下即时反映（含部件覆盖）
        }
        this._setStatus(custom
          ? `部件夜景：单独调整 · 强度 ${cfg.strength} · 保存后生效到游戏`
          : `部件夜景：跟随全局`);
      };
      pgMode.addEventListener("change", applyPart);
      box.querySelector("#ms3-pg-on").addEventListener("change", applyPart);
      box.querySelector("#ms3-pg-strength").addEventListener("input", applyPart);
    }
    this._renderTree();
  }

  // 视口光照工具条：默认只显示一个「☀ 光照」按钮，点击下拉展开勾选面板
  // （与选中/资产无关，独立于属性面板的刷新——renderProps 重渲染不会重建此条）
  _buildLightBar(wrap) {
    const defs = [
      ["sun", "主光（含投影）"],
      ["fill", "反向补光"],
      ["camFill", "相机补光"],
      ["hemi", "环境光"],
      ["ibl", "环境反射 IBL"],
    ];
    const bar = document.createElement("div");
    bar.className = "ms3-lightbar";
    bar.innerHTML = `
      <button class="ms3-light-toggle" id="ms3-light-toggle" title="视口环境（预览模式 + 灯组细调）">☀ 环境</button>
      <div class="ms3-lightbar-panel" id="ms3-light-panel" hidden>
        <div class="ms3-lb-mode">
          <button class="ms3-lb-mode-btn" data-pm="day" title="白天光照">☀ 白天</button>
          <button class="ms3-lb-mode-btn" data-pm="night" title="夜景预览（自发光生效）">🌙 夜晚</button>
        </div>
        <div class="ms3-lb-sep"></div>
        ${defs.map(([k, full]) =>
          `<label class="ms3-lb-row"><input type="checkbox" data-light="${k}" /><span>${full}</span></label>`).join("")}
      </div>`;
    // 挂进顶栏右侧文件操作组最前（光照下拉 → 保存/导出/返回），
    // 作为流内元素不会遮住其他按钮
    const right = wrap.querySelector("#ms3-tb-right");
    const topbar = wrap.querySelector(".ms3-topbar");
    (right || topbar || wrap).prepend(bar);
    const toggle = bar.querySelector("#ms3-light-toggle");
    const panel = bar.querySelector("#ms3-light-panel");
    // 面板顶部的昼/夜分段是预览模式的唯一入口
    for (const b of bar.querySelectorAll(".ms3-lb-mode-btn")) {
      b.addEventListener("click", () => this._setPreviewMode(b.dataset.pm));
    }
    const sync = () => {
      for (const b of bar.querySelectorAll(".ms3-lb-mode-btn")) {
        b.classList.toggle("active", b.dataset.pm === this._previewMode);
      }
      for (const box of panel.querySelectorAll("input[data-light]")) {
        const k = box.dataset.light;
        box.checked = k === "ibl"
          ? this._three.scene.environment === this._iblTex
          : !!this._lights[k]?.visible;
      }
      toggle.classList.toggle("active", [...panel.querySelectorAll("input")].some(b => b.checked));
    };
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      panel.hidden = !panel.hidden;
      if (!panel.hidden) sync();
    });
    // 点击面板外部自动收起；存引用便于 close() 移除监听
    this._lightbarOutside = (e) => {
      if (!panel.hidden && !bar.contains(e.target)) panel.hidden = true;
    };
    document.addEventListener("pointerdown", this._lightbarOutside);
    for (const box of panel.querySelectorAll("input[data-light]")) {
      box.addEventListener("change", () => {
        const k = box.dataset.light;
        if (k === "ibl") {
          this._three.scene.environment = box.checked ? this._iblTex : null;
        } else {
          const l = this._lights[k];
          if (l) l.visible = box.checked;
        }
        sync();
      });
    }
    sync();
  }

  /* ---------------- 昼/夜预览（对齐游戏内的昼夜机制） ---------------- */

  // 切换白天/夜景预览；唯一入口是「☀ 环境」面板顶部的昼/夜分段
  _setPreviewMode(mode) {
    if (this._previewMode === mode) return;
    this._previewMode = mode;
    const panel = this._el.querySelector("#ms3-light-panel");
    if (panel) {
      for (const b of panel.querySelectorAll(".ms3-lb-mode-btn")) {
        b.classList.toggle("active", b.dataset.pm === mode);
      }
    }
    this._applyLightPreset();
    this._applyNightEmissive();
    this._setStatus(mode === "night"
      ? "夜景预览：材质自发光按资产「夜景」配置点亮 · 可在右侧面板调强度后保存"
      : "白天预览：完整日光照明 · 自发光关闭（与游戏内白昼一致）");
  }

  // 昼/夜两套光照预设。夜晚 = 月光冷色低强度 + 暗背景；白天 = 建场时的默认值。
  // IBL 反射用 scene.environmentIntensity 压暗（three r163+），不必动勾选状态
  _applyLightPreset() {
    const { scene, renderer } = this._three;
    const { sun, fill, camFill, hemi } = this._lights;
    const night = this._previewMode === "night";
    if (night) {
      scene.background.set(0x0b0e12);
      this._ground.material.color.set(0x12161c);
      sun.color.set(0x7d8fb8); sun.intensity = 0.4;
      hemi.color.set(0x2a3450); hemi.groundColor.set(0x161a20); hemi.intensity = 0.3;
      fill.color.set(0x8fa4cc); fill.intensity = 0.22;
      camFill.color.set(0xaebad2); camFill.intensity = 0.12;
      renderer.toneMappingExposure = 0.85;
      scene.environmentIntensity = 0.25;
    } else {
      scene.background.set(0x1a1e23);
      this._ground.material.color.set(0x22272d);
      sun.color.set(0xffffff); sun.intensity = 2.4;
      hemi.color.set(0xcfd8e6); hemi.groundColor.set(0x3a4046); hemi.intensity = 1.15;
      fill.color.set(0xdfe8f2); fill.intensity = 0.55;
      camFill.color.set(0xffffff); camFill.intensity = 0.35;
      renderer.toneMappingExposure = 1;
      scene.environmentIntensity = 1;
    }
  }

  // 把资产夜景配置应用到工作台材质（白天恒为 0，夜晚按配置点亮）——
  // 与 assetMesh.applyGlowCfg 白天 emissiveIntensity=0 的游戏行为一致。
  // 部件级覆盖：带 partGlowKey 的克隆材质读 nightGlow.parts[key]
  _applyNightEmissive() {
    const night = this._previewMode === "night";
    const a = this.workspace && this.workspace.asset;
    for (const m of this._glowMats()) {
      let on = a && a.nightGlow ? a.nightGlow.on !== false : true;
      let st = a && a.nightGlow && a.nightGlow.strength != null ? a.nightGlow.strength : 0.7;
      const pk = m.userData && m.userData.partGlowKey;
      const pcfg = pk && a && a.nightGlow && a.nightGlow.parts && a.nightGlow.parts[pk];
      if (pcfg) { on = pcfg.on !== false; st = pcfg.strength; }
      m.emissiveIntensity = night && on ? st : 0;
    }
  }

  // 片段当前是否启用：无配置 = 全部启用；有配置看 enabled 名单
  _clipOn(name) {
    const cfg = this.workspace && this.workspace.asset.animation;
    return !cfg || !cfg.enabled || cfg.enabled.includes(name);
  }

  // 工作台中具备夜市发光能力的材质（模板构建时已设 emissiveMap 的共享材质）
  _glowMats() {
    const mats = new Set();
    if (this.workspace) {
      this.workspace.root.traverse((o) => {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (m && m.emissiveMap) mats.add(m);
        }
      });
    }
    return [...mats];
  }

  _materialOptions(selected) {
    return listMaterials()
      .map((m) => `<option value="${m.id}"${m.id === selected ? " selected" : ""}>${esc(m.name)}</option>`)
      .join("");
  }

  _renderTree() {
    const tree = this._el.querySelector("#ms3-tree");
    if (!tree || !this.workspace) return;
    tree.innerHTML = "";
    this._treeCollapsed = this._treeCollapsed || new Set(); // 收起状态（按对象 uuid）
    const helper = this._three.tc.getHelper();
    const walk = (obj, depth) => {
      for (const child of obj.children) {
        if (child === helper) continue;
        const hasKids = child.children.some((c) => c !== helper);
        const collapsed = this._treeCollapsed.has(child.uuid);
        const key = child.userData ? child.userData.bindingKey : null;
        const bound = key && this.workspace.bindings[key];
        const item = document.createElement("div");
        item.className = "ms3-tree-item" + (child === this.sel ? " active" : "");
        item.style.paddingLeft = 8 + depth * 14 + "px";
        item.innerHTML = `${hasKids
          ? `<span class="ms3-tree-toggle" title="展开/收起">${collapsed ? "▸" : "▾"}</span>`
          : `<span class="ms3-tree-dot"></span>`}${esc(child.name || child.type)}${child.isMesh && key ? `<span class="mat-chip${bound ? "" : " unbound"}">${esc(bound || key)}</span>` : ""}`;
        item.addEventListener("click", () => this._select(child));
        if (hasKids) {
          item.querySelector(".ms3-tree-toggle").addEventListener("click", (e) => {
            e.stopPropagation(); // 别触发选中
            collapsed ? this._treeCollapsed.delete(child.uuid) : this._treeCollapsed.add(child.uuid);
            this._renderTree();
          });
        }
        tree.appendChild(item);
        if (hasKids && !collapsed) walk(child, depth + 1);
      }
    };
    walk(this.workspace.root, 0);
  }

  // 选中部件时自动展开其祖先链（画布点选深层部件也能在树里看到）
  _expandTo(obj) {
    this._treeCollapsed = this._treeCollapsed || new Set();
    for (let p = obj.parent; p; p = p.parent) this._treeCollapsed.delete(p.uuid);
  }

  _setStatus(msg) {
    const el = this._el && this._el.querySelector("#ms3-status");
    if (el) el.textContent = msg;
  }
}

/* ---------------- helpers ---------------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
// 描边资产的挤出几何：屋顶是 ShapeGeometry，墙体是 ExtrudeGeometry
function isRoofMesh(mesh) {
  return mesh.geometry && mesh.geometry.type === "ShapeGeometry";
}

// 几何级 X 镜像：缩放 -1 后翻三角绕序（索引几何）、法线由 applyMatrix4 自动翻。
// 相比 scale.x=-1 的实例镜像，绕序修正后的几何不会内外翻面，材质可继续共享。
function mirroredGeometry(src) {
  const g = src.clone();
  g.scale(-1, 1, 1);
  if (g.index) {
    const idx = g.index.array;
    for (let i = 0; i < idx.length; i += 3) {
      const t = idx[i + 1];
      idx[i + 1] = idx[i + 2];
      idx[i + 2] = t;
    }
    g.index.needsUpdate = true;
  }
  g.computeBoundingSphere();
  return g;
}
