// 模型工坊（Model Studio）：模型资产的查看 / 材质绑定 / 参数建模工作台。
// 独立模块 —— 只依赖 assetStore（数据层）与 world/materials、world/assetMesh
// （共享渲染层），不 import 任何编辑器；编辑器通过 main.js 的回调跳转进来。

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import {
  listAssets, getAsset, putAsset, deleteAsset,
  importAssetFromGLB, exportAssetGLB, exportObjectGLB, renderThumb, saveAssetThumb,
  isMemoryOnly,
} from "../data/assetStore.js";
import { listMaterials, getMaterial } from "../world/materials.js";
import { getAssetTemplate, invalidateAssetTemplate } from "../world/assetMesh.js";
import "./studio.css";

export class ModelStudio {
  // opts: { initialAssetId?, onClose? }
  constructor(opts = {}) {
    this.opts = opts;
    this._disposed = false;
    this.workspace = null; // { asset, root, bindings, geometryDirty, isNew }
    this.sel = null;       // 当前选中的 Mesh
  }

  /* ---------------- 生命周期 ---------------- */

  async open() {
    this._buildDOM();
    this._buildScene();
    this._wireKeys();
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
          <span class="ms3-title">模型工坊 <small style="color:#7d8794">STUDIO</small></span>
          <button class="ms3-btn" id="ms3-mode-w" title="W">移动</button>
          <button class="ms3-btn" id="ms3-mode-e" title="E">旋转</button>
          <button class="ms3-btn" id="ms3-mode-r" title="R">缩放</button>
          <button class="ms3-btn primary" id="ms3-save">保存资产</button>
          <button class="ms3-btn" id="ms3-export">导出 GLB</button>
          <button class="ms3-btn" id="ms3-close">返回</button>
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
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.shadowMap.enabled = true;
    wrap.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1e23);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
    camera.position.set(28, 22, 32);
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.target.set(0, 8, 0);
    orbit.maxPolarAngle = Math.PI / 2 - 0.02;

    const hemi = new THREE.HemisphereLight(0xcfd8e6, 0x30353c, 1.1);
    const sun = new THREE.DirectionalLight(0xffffff, 2.4);
    sun.position.set(30, 50, 20);
    sun.castShadow = true;
    sun.shadow.camera.left = -80; sun.shadow.camera.right = 80;
    sun.shadow.camera.top = 80; sun.shadow.camera.bottom = -80;
    sun.shadow.mapSize.set(2048, 2048);
    const grid = new THREE.GridHelper(200, 100, 0x3a424c, 0x262c33);
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(100, 48).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x22272d, roughness: 1 }),
    );
    ground.position.y = -0.02;
    ground.receiveShadow = true;
    scene.add(hemi, sun, grid, ground);

    const tc = new TransformControls(camera, renderer.domElement);
    tc.addEventListener("dragging-changed", (e) => { orbit.enabled = !e.value; });
    tc.addEventListener("mouseUp", () => { this._geometryDirty = true; this._renderProps(); });
    scene.add(tc.getHelper());

    this._three = { renderer, scene, camera, orbit, tc, wrap };
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
        <small>${esc(a.category || "")} · ${srcZh}${a.meshCount ? " · " + a.meshCount + " mesh" : ""}</small></div>`;
      card.addEventListener("click", async () => {
        const fresh = await getAsset(a.id);
        if (fresh) await this._loadAsset(fresh);
      });
      box.appendChild(card);
    }
  }

  async _onImportFile(file) {
    if (!file) return;
    this._setStatus(`正在导入「${file.name}」…`);
    try {
      const asset = await importAssetFromGLB(file);
      this._setStatus(`已导入「${asset.name}」· ${asset.meshCount} 个网格 · 请在右侧绑定材质后保存`);
      await this._refreshAssetList();
      await this._loadAsset(asset);
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
    this._renderProps();
    this._refreshAssetList();
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
    this._workspaceRoot.clear();
    this.workspace = null;
    this._renderProps();
  }

  /* ---------------- 选择 / 变换 ---------------- */

  _select(obj) {
    this.sel = obj || null;
    const tc = this._three.tc;
    if (obj) tc.attach(obj);
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
    const selInfo = this.sel
      ? `<div class="ms3-field">
           <label>选中部件：${esc(this.sel.name || "(未命名 mesh)")}</label>
           <select id="ms3-mat"><option value="">（保留原材质 · 未绑定）</option>${this._materialOptions(this.workspace.bindings[this.sel.userData.bindingKey || this.sel.material.name])}</select>
         </div>
         <div class="ms3-row">
           <button class="ms3-btn" id="ms3-dup">复制</button>
           <button class="ms3-btn" id="ms3-mirror">镜像</button>
           <button class="ms3-btn" id="ms3-array">阵列</button>
           <button class="ms3-btn danger" id="ms3-del">删除</button>
         </div>`
      : `<div class="ms3-hint">点选画布中的部件或场景树条目后，可在此绑定标准材料库材质（换肤/夜间灯光全城生效）。</div>`;
    const cats = ["building", "prop", "vehicle", "custom"];
    box.innerHTML = `
      <div class="ms3-field"><label>名称</label><input id="ms3-name" value="${esc(a.name || "")}" maxlength="24" /></div>
      <div class="ms3-field"><label>分类</label><select id="ms3-cat">${cats.map((c) => `<option value="${c}"${a.category === c ? " selected" : ""}>${{ building: "建筑", prop: "道具", vehicle: "载具", custom: "自定义" }[c]}</option>`).join("")}</select></div>
      <div class="ms3-field"><label>来源</label><input value="${{ glb: "GLB 模型", traced: "描边建筑", studio: "参数建模" }[a.source] || a.source}" disabled /></div>
      ${a.unitSize ? `<div class="ms3-hint">包围盒：${a.unitSize.x} × ${a.unitSize.y} × ${a.unitSize.z} m（碰撞自动按放置缩放生成 AABB）</div>` : ""}
      <div style="margin-bottom:10px">
        <button class="ms3-btn" id="ms3-add-box" style="width:100%;margin-bottom:6px">＋ 添加部件 · 盒</button>
        <div class="ms3-row">
          <button class="ms3-btn" id="ms3-add-cyl">圆柱</button>
          <button class="ms3-btn" id="ms3-add-sph">球</button>
          <button class="ms3-btn" id="ms3-add-slab">薄板</button>
        </div>
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
    on("#ms3-dup", () => this._duplicateSelected());
    on("#ms3-mirror", () => this._mirrorSelected());
    on("#ms3-array", () => this._arraySelected());
    on("#ms3-del", () => this._deleteSelected());
    const matSel = box.querySelector("#ms3-mat");
    if (matSel) matSel.addEventListener("change", (e) => this._bindMaterial(e.target.value));
    this._renderTree();
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
    const walk = (obj, depth) => {
      for (const child of obj.children) {
        if (child === this._three.tc.getHelper()) continue;
        const key = child.userData ? child.userData.bindingKey : null;
        const bound = key && this.workspace.bindings[key];
        const item = document.createElement("div");
        item.className = "ms3-tree-item" + (child === this.sel ? " active" : "");
        item.style.paddingLeft = 8 + depth * 14 + "px";
        item.innerHTML = `${esc(child.name || child.type)}${child.isMesh && key ? `<span class="mat-chip${bound ? "" : " unbound"}">${esc(bound || key)}</span>` : ""}`;
        item.addEventListener("click", () => this._select(child));
        tree.appendChild(item);
        if (child.children.length) walk(child, depth + 1);
      }
    };
    walk(this.workspace.root, 0);
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
