// 模型工坊（Model Studio）：模型资产的查看 / 材质绑定 / 参数建模工作台。
// 独立模块 —— 只依赖 assetStore（数据层）与 world/materials、world/assetMesh
// （共享渲染层），不 import 任何编辑器；编辑器通过 main.js 的回调跳转进来。

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import {
  listAssets, getAsset, putAsset, deleteAsset,
  listGroups, putGroup,
  importAssetFromGLB, exportAssetGLB, exportObjectGLB, renderThumb, saveAssetThumb,
  isMemoryOnly, normalizeParts, newPartId,
} from "../data/assetStore.js";
import { listMaterials, getMaterial } from "../world/materials.js";
import { getAssetTemplate, invalidateAssetTemplate, updateAssetAnimations, playAssetClips, stopAssetMixer, getAssetClipNames, buildTracedObject } from "../world/assetMesh.js";
import { ensureBillboardAssets, BILLBOARD_TEMPLATES } from "../data/billboardAsset.js";
import { buildBillboardAssetObject, buildCompositeScreenNode, getCornerArc } from "../world/billboard/billboardAssetBridge.js";
import { analyzeSurfaces, fitScreenToModel, refineFitOnModel } from "./surfaceFit.js";
import "./studio.css";

export class ModelStudio {
  // opts: { initialAssetId?, onClose? }
  constructor(opts = {}) {
    this.opts = opts;
    this._disposed = false;
    this.workspace = null; // { asset, root, bindings, geometryDirty, isNew }
    this.sel = null;       // 当前选中的 Mesh
    this._previewMode = "day"; // 视口预览模式：day / night（昼/夜光照预设）
    this._autoFit = true;      // 广告屏拖入时自动找单面墙 / L 形转角并适配尺寸
    this._surfacesCache = null;
  }

  /* ---------------- 生命周期 ---------------- */

  async open() {
    this._buildDOM();
    this._buildScene();
    this._wireKeys();
    await ensureBillboardAssets(); // 首次进工坊自动播种四种广告牌模型资产
    await this._refreshAssetList();
    this._updateDropHint();
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
    if (this._three && this._three.tc) this._three.tc.dispose();
    if (this._selBox) { this._selBox.geometry.dispose(); this._selBox.material.dispose(); }
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
          <input type="file" id="ms3-file" accept=".glb,.gltf" style="display:none" />
          <div style="display:flex;gap:6px;margin-bottom:8px">
            <input id="ms3-search" placeholder="搜索资产…" class="ms3-search" style="flex:1;min-width:0;background:#14171a;color:#d8dce2;border:1px solid #343b44;border-radius:6px;padding:6px 8px;font-size:13px" />
            <button class="ms3-btn" id="ms3-add-group" title="新增分组" style="flex:none;padding:6px 10px">＋</button>
          </div>
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
            <button class="ms3-btn" id="ms3-cover" title="只重拍列表封面：不重新保存模型 / 不导出几何">更新封面</button>
            <button class="ms3-btn" id="ms3-export" title="导出为 .glb 文件">导出 GLB</button>
            <div class="ms3-tb-sep"></div>
            <button class="ms3-btn" id="ms3-close">返回</button>
          </div>
        </div>
        <div class="ms3-sel-label" id="ms3-sel-label"></div>
        <div class="ms3-drop-hint" id="ms3-drop-hint" hidden>
          <b>把左侧模型拖到这里</b>
          <span>打开任意建筑模型，再把广告屏资产拖进画布即可自由组合<br>拖到模型表面会自动贴墙，也可用右侧面板精调位姿</span>
        </div>
        <div class="ms3-status" id="ms3-status">左键旋转视角 · 滚轮缩放 · 右键平移 · 点选部件编辑（青色框 = 当前部件）</div>
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
    el.querySelector("#ms3-file").addEventListener("change", (e) => {
      const file = e.target.files[0];
      const cat = this._pendingImportCat;
      e.target.value = ""; // 允许重复选同一文件
      this._onImportFile(file, cat);
    });
    el.querySelector("#ms3-save").addEventListener("click", () => this._save());
    el.querySelector("#ms3-cover").addEventListener("click", () => this._updateCover());
    el.querySelector("#ms3-export").addEventListener("click", () => this._export());
    el.querySelector("#ms3-search").addEventListener("input", () => this._refreshAssetList());
    el.querySelector("#ms3-add-group").addEventListener("click", () => this._editGroup(null));
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

    // 变换轴挂在一个「代理轴心」上：广告牌子网格的局部原点都在底面中心，
    // 直接 attach 网格会让所有部件的坐标轴重叠在同一处。代理轴心放到选中
    // 部件的几何包围盒中心，再把它的位移/旋转/缩放增量换算回部件自身变换。
    const pivot = new THREE.Object3D();
    pivot.name = "__ms3_gizmo_pivot";
    scene.add(pivot);
    this._gizmoPivot = pivot;

    const tc = new TransformControls(camera, renderer.domElement);
    // three r187 的 TransformControls 只派发 mouseDown/mouseUp，没有 dragging-changed
    tc.addEventListener("mouseDown", () => { orbit.enabled = false; this._beginGizmoDrag(); });
    tc.addEventListener("objectChange", () => this._applyGizmoDelta());
    tc.addEventListener("mouseUp", () => {
      orbit.enabled = true;
      this._endGizmoDrag();
      // 拖的是组合部件：只回写 parts 位姿，底座几何没变，不用重导 GLB
      if (this.sel && this.sel.userData && this.sel.userData.compositePart) this._syncCompositeParts();
      else if (this.workspace) {
        this.workspace.geometryDirty = true;
        this._surfacesCache = null; // 底座几何变了，立面候选要重算
      }
      this._renderProps();
    });
    scene.add(tc.getHelper());

    // 选中描边：世界空间包围盒 + 名称浮标（见 _updateSelOverlay），始终可见
    const selBox = new THREE.Box3Helper(new THREE.Box3(), 0x35e0ff);
    selBox.material.depthTest = false;
    selBox.material.depthWrite = false;
    selBox.material.transparent = true;
    selBox.material.opacity = 0.95;
    selBox.renderOrder = 999;
    selBox.visible = false;
    scene.add(selBox);
    this._selBox = selBox;

    // IBL 环境光照：RoomEnvironment 经 PMREM 预滤波 → 每个方向都有光（背光面
    // 不死黑）、金属/光泽材质有真实反射；与四盏灯独立，面板可单独开关
    const pmrem = new THREE.PMREMGenerator(renderer);
    this._iblTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    // IBL 默认关闭（面板里手动开）；贴图已就绪，打开是零成本切换
    scene.environment = null;

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
    const { orbit, renderer, scene, camera } = this._three;
    orbit.update();
    this._updateSelOverlay();
    // GLB 内建动画（如小火车）随实例播放
    this._clock = this._clock || new THREE.Clock();
    updateAssetAnimations(this._clock.getDelta());
    renderer.render(scene, camera);
  };

  /* ---------------- 资产库面板 ---------------- */

  /** 转角弧度：直接改圆角控制器，只重建屏体/机箱几何 —— 不动场景节点、朝向、材质与 UV 模式 */
  _setBillboardArc(radius) {
    const a = this.workspace && this.workspace.asset;
    if (!a || !a.billboard) return;
    const r = Math.max(0, Math.min(5, +radius || 0));
    a.billboard.spec = { ...(a.billboard.spec || {}), arc: r };
    const ctl = getCornerArc(this.workspace.root);
    if (ctl) ctl.setRadius(r); // 内部 _rebuild 会保留 mats / group / split UV / poseYaw
    invalidateAssetTemplate(a.id); // 地图编辑器 / 缩略图下次取模板用新弧度
    this._applyNightEmissive();
    this._renderTree();
  }

  /** 广告牌资产自身的规格编辑（与组合部件同一套字段） */
  _billboardAssetSpecHtml(a) {
    const b = a.billboard || {};
    const s = b.spec || {};
    const w = +s.w || 14, h = +s.h || 8, y = +s.y || 9;
    const isCorner = b.mount === "corner" || b.mount === "corner3d";
    const label = { standalone: "独立广告牌", facade: "建筑立面屏", corner: "转角包柱屏", corner3d: "3D 转角包柱屏" }[b.mount] || b.mount || "?";
    const field = (id, labelText, value, min, max, step) =>
      `<label>${labelText}(m) <input id="ba-${id}" type="number" step="${step}" min="${min}" max="${max}" value="${+(+value).toFixed(2)}" /></label>`;
    return `<div class="ms3-part-editor">
      <div class="ms3-part-editor-head">屏体规格 <span>${esc(label)}</span></div>
      <div class="ms3-part-grid">
        ${field("w", "屏宽", w, 4, 40, 0.1)}
        ${field("h", "屏高", h, 2, 30, 0.1)}
        ${isCorner ? `${field("wa", "左屏长", s.wA || w, 4, 40, 0.1)}${field("wb", "右屏长", s.wB || w, 4, 40, 0.1)}` : ""}
        ${field("y", "离地高度", y, 3, 120, 0.5)}
      </div>
      <div class="ms3-hint">${isCorner ? "左右屏长分别控制两面屏；" : ""}改动即时重建预览，点「保存资产」后写入模型，引用它的组合同步更新。</div>
    </div>`;
  }

  /** 广告牌资产改规格：替换工作台底座节点（保留已挂的组合部件），标记待保存 */
  _setBillboardSpec(key, value) {
    const a = this.workspace && this.workspace.asset;
    if (!a || !a.billboard) return;
    a.billboard.spec = { ...(a.billboard.spec || {}), [key]: value };
    const holder = this.workspace.root.children.find((c) => c.userData && c.userData.compositeHolder) || this.workspace.root;
    const oldBase = holder.children.find((c) => !(c.userData && c.userData.compositePart));
    const fresh = buildBillboardAssetObject(a);
    if (!fresh) return;
    if (oldBase) holder.remove(oldBase);
    holder.add(fresh);
    this.workspace.geometryDirty = true;
    invalidateAssetTemplate(a.id);
    this._applyNightEmissive();
    this._renderTree();
    this._setStatus(`屏体规格已改（${key}=${value}）· 画布实时预览，保存资产后写入模型`);
  }

  /** 当前视口机位（相机相对 orbit 目标的方向），保存时给缩略图用 */
  _thumbDirection() {
    const t = this._three;
    if (!t || !t.camera || !t.orbit) return null;
    return t.camera.position.clone().sub(t.orbit.target);
  }

  /** 缩略图已重新生成：丢弃旧 objectURL，下次列表渲染才会显示新图 */
  _invalidateThumb(id) {
    if (!this._thumbUrls || !id) return;
    if (this._thumbUrls[id]) URL.revokeObjectURL(this._thumbUrls[id]);
    delete this._thumbUrls[id];
  }

  /** 按当前视口重拍封面并落库。只写缩略图字段，不碰模型几何 / 规格，不失效模板。 */
  async _renderCover(assetId) {
    const thumb = await renderThumb(this.workspace.root.clone(true), { direction: this._thumbDirection() });
    await saveAssetThumb(assetId, thumb);
    this._invalidateThumb(assetId);
    if (this.workspace.asset.id === assetId) this.workspace.asset.thumb = thumb;
    return thumb;
  }

  /** 顶栏「更新封面」：资产必须已保存过（有 id）才有封面可更新 */
  async _updateCover() {
    if (!this.workspace || !this.workspace.asset || !this.workspace.asset.id) {
      this._setStatus("请先「保存资产」建立记录，再更新封面");
      return;
    }
    this._setStatus("正在重拍封面…");
    try {
      await this._renderCover(this.workspace.asset.id);
      await this._refreshAssetList();
      this._setStatus(`封面已更新（模型未改动）· ${this.workspace.asset.name || ""}`);
    } catch (e) {
      console.error(e);
      this._setStatus("封面更新失败：" + (e && e.message ? e.message : e));
    }
  }

  async _refreshAssetList() {
    const kw = this._el.querySelector("#ms3-search").value.trim();
    const [list, groups] = await Promise.all([listAssets({ keyword: kw }), listGroups()]);
    this._groups = groups;
    const box = this._el.querySelector("#ms3-list");
    this._thumbUrls = this._thumbUrls || {};
    box.innerHTML = "";
    this._el.querySelector("#ms3-count").textContent = String(list.length);
    if (!list.length) {
      box.innerHTML = `<div class="ms3-empty">还没有资产。<br>悬停分组可导入 GLB / 新建参数模型。</div>`;
      return;
    }
    // 按用户分组归类（category = 分组 id；不在分组表里的归入「其他」）
    const byId = new Map(groups.map((g) => [g.id, g]));
    const buckets = new Map();
    for (const a of list) {
      const gid = byId.has(a.category) ? a.category : "other";
      if (!buckets.has(gid)) buckets.set(gid, []);
      buckets.get(gid).push(a);
    }
    this._collapsedGroups = this._collapsedGroups || new Set();
    const makeCard = (a, parent) => {
      const card = document.createElement("div");
      card.className = "ms3-card" + (this.workspace && this.workspace.asset.id === a.id ? " active" : "");
      // 组合模式：左侧资产可拖进画布作为子部件（引用资产 ID，不复制几何）
      card.draggable = true;
      card.title = "单击打开模型 · 拖到画布 / 点 ＋ 加入当前模型的组合";
      card.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/x-model-asset", a.id);
        e.dataTransfer.effectAllowed = "copy";
        this._dragAssetId = a.id;
        card.classList.add("dragging");
        this._setStatus(`把「${a.name || "未命名"}」拖到画布 · 松手即加入组合（吸附模型表面）`);
      });
      card.addEventListener("dragend", () => {
        this._dragAssetId = null;
        card.classList.remove("dragging");
        this._el.querySelector(".ms3-canvas-wrap")?.classList.remove("drag-over");
      });
      const srcZh = { glb: "GLB", traced: "描边", studio: "自建", billboard: "广告屏" }[a.source] || a.source;
      card.innerHTML = `
        ${a.thumb ? `<img src="${this._thumbUrls[a.id] || (this._thumbUrls[a.id] = URL.createObjectURL(a.thumb))}" />` : `<img src="" style="opacity:.2" />`}
        <div class="ms3-card-info"><b>${esc(a.name || "未命名")}</b>
        <small>${srcZh}${a.meshCount ? " · " + a.meshCount + " mesh" : ""}${a.composite ? " · 组合" : ""}</small></div>
        <button class="ms3-card-add" title="加入当前模型的组合（也可直接拖到画布）">＋</button>
        <button class="ms3-card-del" title="删除资产">×</button>`;
      card.addEventListener("click", async () => {
        const fresh = await getAsset(a.id);
        if (fresh) await this._loadAsset(fresh);
      });
      card.querySelector(".ms3-card-add").addEventListener("click", async (e) => {
        e.stopPropagation(); // 别触发卡片载入
        const fresh = await getAsset(a.id);
        if (fresh) await this._addAssetToCanvas(fresh);
      });
      card.querySelector(".ms3-card-del").addEventListener("click", (e) => {
        e.stopPropagation(); // 别触发卡片载入
        this._deleteAsset(a.id, a.name || "未命名");
      });
      parent.appendChild(card);
    };
    const renderGroups = (gid) => {
      const g = gid === "other" ? null : byId.get(gid);
      const items = buckets.get(gid);
      if (!items) return;
      const collapsed = this._collapsedGroups.has(gid);
      const header = document.createElement("div");
      header.className = "ms3-group" + (collapsed ? " collapsed" : "");
      header.innerHTML = `
        <span class="ms3-group-arrow">▸</span>
        ${g ? `<span class="ms3-group-dot" style="background:${esc(g.color || "#5d6672")}"></span>` : ""}
        <b>${esc(g ? g.name : "其他")}</b>
        <small>${items.length}</small>
        ${g ? `
        <button class="ms3-group-act" data-act="import" title="导入 GLB 到「${esc(g.name)}」">⇪</button>
        <button class="ms3-group-act" data-act="new" title="在「${esc(g.name)}」中新建参数模型">＋</button>
        <button class="ms3-group-act" data-act="billboard" title="在「${esc(g.name)}」中新建广告牌模型资产">▣</button>
        <button class="ms3-group-edit" title="编辑分组">✎</button>` : ""}`;
      const body = document.createElement("div");
      body.className = "ms3-group-body";
      if (collapsed) body.style.display = "none";
      header.addEventListener("click", () => {
        const willCollapse = body.style.display !== "none";
        body.style.display = willCollapse ? "none" : "";
        header.classList.toggle("collapsed", willCollapse);
        if (willCollapse) this._collapsedGroups.add(gid);
        else this._collapsedGroups.delete(gid);
      });
      if (g) {
        header.querySelector(".ms3-group-edit").addEventListener("click", (e) => {
          e.stopPropagation(); // 别触发折叠
          this._editGroup(g);
        });
        header.querySelector('[data-act="import"]').addEventListener("click", (e) => {
          e.stopPropagation(); // 别触发折叠
          this._pendingImportCat = g.id;
          this._el.querySelector("#ms3-file").click();
        });
        header.querySelector('[data-act="new"]').addEventListener("click", (e) => {
          e.stopPropagation();
          this._newWorkspace(g.id);
        });
        header.querySelector('[data-act="billboard"]').addEventListener("click", (e) => {
          e.stopPropagation();
          this._newBillboardWorkspace(g.id);
        });
      }
      box.appendChild(header);
      box.appendChild(body);
      for (const a of items) makeCard(a, body);
    };
    for (const g of groups) renderGroups(g.id);
    renderGroups("other");
  }

  // 分组新增 / 编辑属性（名称、颜色）。group 为 null 表示新增。
  _editGroup(group) {
    const isNew = !group;
    const g = group ? { ...group } : { id: null, name: "", color: "#3a72b0" };
    const ov = document.createElement("div");
    ov.className = "ms3-dialog-mask";
    ov.innerHTML = `
      <div class="ms3-dialog">
        <h4>${isNew ? "新增分组" : "编辑分组"}</h4>
        <div class="ms3-field"><label>名称</label><input id="ms3-g-name" value="${esc(g.name)}" maxlength="16" placeholder="分组名称" /></div>
        <div class="ms3-field"><label>颜色</label><input id="ms3-g-color" type="color" value="${esc(g.color || "#3a72b0")}" /></div>
        <div class="ms3-row" style="justify-content:flex-end">
          <button class="ms3-btn" id="ms3-g-cancel">取消</button>
          <button class="ms3-btn primary" id="ms3-g-ok">保存</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.querySelector("#ms3-g-cancel").addEventListener("click", close);
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
    ov.querySelector("#ms3-g-ok").addEventListener("click", async () => {
      const nameInput = ov.querySelector("#ms3-g-name");
      const name = nameInput.value.trim();
      if (!name) { nameInput.focus(); return; }
      g.name = name;
      g.color = ov.querySelector("#ms3-g-color").value;
      try {
        await putGroup(g);
        close();
        this._setStatus(isNew ? `已新增分组「${name}」` : `分组「${name}」已更新`);
        await this._refreshAssetList();
        this._renderProps(); // 右侧「分类」下拉同步新分组
      } catch (e) {
        console.error(e);
        this._setStatus("分组保存失败：" + (e && e.message ? e.message : e));
      }
    });
    ov.querySelector("#ms3-g-name").focus();
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

  async _onImportFile(file, category) {
    if (!file) return;
    this._setStatus(`正在导入「${file.name}」…`);
    try {
      const asset = await importAssetFromGLB(file, { category: category || "custom" });
      this._setStatus(`已导入「${asset.name}」· ${asset.meshCount} 个网格 · 请在右侧绑定材质后保存`);
      await this._loadAsset(asset);
      // 导入即出缩略图（复用刚载入的工作台几何；否则列表卡片一直空图，
      // 要等用户手动点保存才有图）
      if (this.workspace && this.workspace.root.children.length) {
        try {
          await this._renderCover(asset.id);
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
          if (o.isMesh && !isInsideCompositePart(o)) o.userData.bindingKey = isRoofMesh(o) ? "roof" : "wall";
        });
      }
      root.add(inst);
      // 组合里的广告屏部件：模板 clone 会丢掉 poseYaw 欧拉角（π→0）与圆角控制器，
      // 屏面会转到背面。按子资产重建纯屏占位，保证工坊里所见即所得。
      await this._refreshCompositeScreens(root, normalizeParts(asset.parts));
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
      root.traverse((o) => {
        if (o.isMesh && !o.userData.bindingKey && !isInsideCompositePart(o)) unnamed.push(o);
      });
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
    if (asset.source === "billboard" && tpl) {
      // 广告牌工作台直接用桥接产物（带 _cornerArc 控制器），而不是模板克隆 ——
      // 这样右侧改弧度可以原地 setRadius，无需重建模型 / 不丢朝向与材质。
      const fresh = buildBillboardAssetObject(asset);
      if (fresh) {
        // 不能用 tpl.clone() 的 rotation：three 的 clone 会把 π 欧拉角丢成 ~0，
        // 广告面就转到背面去了。fresh 由桥接产物构建，poseYaw 由资产数据直接写入。
        const inner = root.children[0];
        if (inner && inner.userData && inner.userData.compositeHolder) {
          // 组合资产：保留容器（里面还有挂上去的部件），只换掉底座节点
          const base = inner.children.find((c) => !(c.userData && c.userData.compositePart));
          if (base) inner.remove(base);
          inner.add(fresh);
        } else {
          if (inner) root.remove(inner);
          root.add(fresh);
        }
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

  _newWorkspace(category) {
    this._clearWorkspace();
    const root = new THREE.Group();
    root.name = "asset-root";
    this.workspace = {
      asset: { name: "新模型", category: category || "custom", source: "studio", materialBindings: {}, unitSize: { x: 0, y: 0, z: 0 } },
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

  /** 新建广告牌模型资产：只建规格（mount+尺寸），不写死任何内容/素材/后台配置 */
  _newBillboardWorkspace(category) {
    const hint = BILLBOARD_TEMPLATES.map((t, i) => `${i + 1} ${t.name}`).join("\n");
    const raw = window.prompt(`新建哪种广告牌模型？\n${hint}`, "1");
    const idx = Math.max(0, Math.min(BILLBOARD_TEMPLATES.length - 1, (parseInt(raw, 10) || 1) - 1));
    const t = BILLBOARD_TEMPLATES[idx];
    this._clearWorkspace();
    const asset = {
      name: t.name,
      category: category || "billboard",
      tags: ["广告牌", t.name],
      source: "billboard",
      poseYaw: t.poseYaw || 0,
      billboard: {
        mount: t.mount,
        spec: { ...t.spec },
        autoSnap: t.mount === "facade",
        screenFaces: t.screenFaces,
      },
      materialBindings: {},
      pivot: "base-center",
      collider: { mode: "aabb" },
      unitSize: { x: t.mount === "corner" || t.mount === "corner3d" ? t.spec.w + 1.4 : t.spec.w + 0.8, y: t.spec.y + t.spec.h / 2 + 0.6, z: 2 },
    };
    const base = buildBillboardAssetObject(asset);
    if (!base) return;
    // 与组合资产模板同构：零变换工作台根 → 组合容器（底座与拖入的部件都是它的子节点），
    // 这样带 poseYaw 的屏体不会把组合部件的坐标系一起转掉
    const root = new THREE.Group();
    root.name = "asset-root";
    const holder = new THREE.Group();
    holder.name = "composite-root";
    holder.userData.compositeHolder = true;
    holder.add(base);
    root.add(holder);
    this.workspace = { asset, root, bindings: { screen: "" }, geometryDirty: false, isNew: true };
    this._workspaceRoot.add(root);
    this._renderProps();
    this._frameView();
    this._setStatus(`已载入广告牌模型「${t.name}」· 保存后可在地图编辑器放置；内容/素材/后台与模型完全解耦`);
  }

  _clearWorkspace() {
    this._deselect();
    stopAssetMixer(this._wsMixer);
    this._wsMixer = null;
    this._clipNames = [];
    this._workspaceRoot.clear();
    this.workspace = null;
    this._surfacesCache = null;
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
    // 相机永远用同一个机位；模型朝向由资产自身的 poseYaw 决定（见 billboardAssetBridge）。
    // 新增任何模型都不用在这里加 if —— 该转的是模型，不是相机。
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
    // 组合部件内部的网格一律归到整个组合组：Gizmo / 删除 / 右侧面板都以整块部件
    // 为单位，也避免误改子资产模板的共享材质
    if (obj) obj = compositeRootOf(obj) || obj;
    this.sel = obj || null;
    const tc = this._three.tc;
    tc.detach();
    this._gizmoDragging = false;
    this._pivotStart = null;
    this._objStartWorld = null;
    if (obj) {
      this._focusGizmoPivot(obj);
      tc.attach(this._gizmoPivot);
      this._expandTo(obj);
    }
    this._updateSelOverlay();
    this._renderProps();
    this._renderTree();
  }

  _deselect() { this._select(null); }

  /** 变换轴心放到选中部件的真实几何中心，而不是模型底面原点 */
  _focusGizmoPivot(obj) {
    const pivot = this._gizmoPivot;
    const box = new THREE.Box3().setFromObject(obj);
    pivot.position.copy(box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3()));
    pivot.quaternion.identity();
    pivot.scale.set(1, 1, 1);
    pivot.updateMatrixWorld(true);
    obj.updateWorldMatrix(true, false);
    this._pivotStart = pivot.matrixWorld.clone();
    this._objStartWorld = obj.matrixWorld.clone();
  }

  _beginGizmoDrag() {
    const obj = this.sel;
    if (!obj) return;
    // 每次拖拽都从当前状态取基准：参数重建几何后增量也不会错位
    obj.updateWorldMatrix(true, false);
    this._gizmoPivot.updateMatrixWorld(true);
    this._objStartWorld = obj.matrixWorld.clone();
    this._pivotStart = this._gizmoPivot.matrixWorld.clone();
    this._gizmoDragging = true;
  }

  /** 把代理轴心的位移/旋转/缩放换算回部件自身变换，保持原父子层级 */
  _applyGizmoDelta() {
    if (!this._gizmoDragging || !this.sel || !this._pivotStart || !this._objStartWorld) return;
    const obj = this.sel, pivot = this._gizmoPivot;
    pivot.updateMatrixWorld(true);
    const delta = pivot.matrixWorld.clone().multiply(this._pivotStart.clone().invert());
    let world = delta.multiply(this._objStartWorld);
    obj.updateWorldMatrix(true, false);
    obj.matrix.copy(obj.parent.matrixWorld.clone().invert()).multiply(world);
    obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
    obj.updateMatrixWorld(true);
    // 禁止沉到地面以下：抬升部件与轴心并同步基准，避免下一次增量跳变
    const box = new THREE.Box3().setFromObject(obj);
    if (!box.isEmpty() && box.min.y < 0) {
      const lift = new THREE.Matrix4().makeTranslation(0, -box.min.y, 0);
      world = lift.multiply(world);
      obj.matrix.copy(obj.parent.matrixWorld.clone().invert()).multiply(world);
      obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
      obj.updateMatrixWorld(true);
      pivot.position.y -= box.min.y;
      pivot.updateMatrixWorld(true);
      this._pivotStart.copy(pivot.matrixWorld);
      this._objStartWorld.copy(world);
    }
  }

  _endGizmoDrag() {
    this._gizmoDragging = false;
    if (this.sel) this._focusGizmoPivot(this.sel);
  }

  /** 选中描边 + 名称浮标：每帧跟随，点中哪个部件一眼可辨 */
  _updateSelOverlay() {
    const label = this._el.querySelector("#ms3-sel-label");
    const helper = this._selBox;
    if (!label || !helper) return;
    const obj = this.sel;
    if (!obj || !this.workspace || !obj.parent) {
      helper.visible = false;
      label.style.display = "none";
      return;
    }
    const box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty()) {
      helper.visible = false;
      label.style.display = "none";
      return;
    }
    helper.box.copy(box).expandByScalar(0.06);
    helper.visible = true;
    const { camera, renderer } = this._three;
    camera.updateMatrixWorld();
    const p = box.getCenter(new THREE.Vector3()).project(camera);
    if (p.z > 1) { label.style.display = "none"; return; }
    const r = renderer.domElement.getBoundingClientRect();
    const wrap = this._el.querySelector(".ms3-canvas-wrap").getBoundingClientRect();
    label.textContent = obj.name || obj.type;
    label.style.display = "block";
    label.style.left = `${r.left - wrap.left + (p.x * 0.5 + 0.5) * r.width}px`;
    label.style.top = `${r.top - wrap.top + (-p.y * 0.5 + 0.5) * r.height}px`;
  }

  _setMode(mode) {
    this._three.tc.setMode(mode);
    for (const [id, m] of [["#ms3-mode-w", "translate"], ["#ms3-mode-e", "rotate"], ["#ms3-mode-r", "scale"]]) {
      this._el.querySelector(id).classList.toggle("active", m === mode);
    }
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

    // 组合模式：把左侧资产拖进画布成为子部件。
    // 落点优先吸附到已有模型表面（贴墙挂屏），没命中就落在地面网格。
    const wrap = this._el.querySelector(".ms3-canvas-wrap");
    wrap.addEventListener("dragover", (e) => {
      if (!this._dragAssetId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      wrap.classList.add("drag-over");
    });
    wrap.addEventListener("dragleave", (e) => {
      if (e.target === wrap || !wrap.contains(e.relatedTarget)) wrap.classList.remove("drag-over");
    });
    wrap.addEventListener("drop", async (e) => {
      e.preventDefault();
      wrap.classList.remove("drag-over");
      const id = e.dataTransfer.getData("text/x-model-asset") || this._dragAssetId;
      this._dragAssetId = null;
      if (!id) return;
      const child = await getAsset(id);
      if (!child) { this._setStatus("找不到该资产"); return; }
      if (!this.workspace) this._newWorkspace("custom");
      const { point, rotY } = this._pickDropPoint(e.clientX, e.clientY);
      await this._addCompositePart(child, point, rotY);
    });
  }

  /** 屏幕坐标 → 画布落点：优先吸附已有模型表面（贴墙挂屏），否则落在地面。
   *  忽略组合部件自己的占位屏，往已有屏附近拖时仍然吸到它后面的墙。 */
  _pickDropPoint(clientX, clientY) {
    const rect = this._three.renderer.domElement.getBoundingClientRect();
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    ), this._three.camera);
    let point = null, rotY = 0;
    const targets = this._workspaceRoot.children.filter((o) => !isInsideCompositePart(o));
    const hits = rc.intersectObjects(targets, true)
      .filter((h) => h.object.isMesh && !isInsideCompositePart(h.object));
    if (hits.length) {
      const h = hits[0];
      point = h.point.clone();
      const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : null;
      if (n && Math.abs(n.y) < 0.7) {
        rotY = Math.atan2(n.x, n.z);       // 屏面 +Z 对齐墙面外法线
        point.addScaledVector(n, 0.12);    // 只留一点避免 Z-fighting，不悬在墙外
      }
    }
    if (!point) {
      const p = new THREE.Vector3();
      if (rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p)) point = p;
    }
    return { point: point || new THREE.Vector3(0, 0, 0), rotY };
  }

  /** 卡片上的「＋」：不拖拽也能加入，落点取当前视口中心 */
  async _addAssetToCanvas(child) {
    if (!child) return;
    if (!this.workspace) this._newWorkspace("custom");
    const rect = this._three.renderer.domElement.getBoundingClientRect();
    const { point, rotY } = this._pickDropPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    await this._addCompositePart(child, point, rotY, false); // 点 ＋ 时选面积最大的面
  }

  /** 对已选中的广告屏部件重新找面适配（改了模型 / 想换一面时用） */
  async _refitSelected() {
    const sel = this.sel;
    if (!sel || !sel.userData || !sel.userData.compositePart || sel.userData.compositePart.role !== "billboard") return;
    const d = sel.userData.compositePart;
    const child = await getAsset(d.assetId);
    if (!child || !child.billboard) { this._setStatus("找不到该广告屏资产"); return; }
    if (!this._surfacesCache) this._surfacesCache = analyzeSurfaces(this.workspace.root);
    let fit = fitScreenToModel(this._surfacesCache, child, sel.position.clone());
    if (!fit) { this._setStatus("当前模型上没找到合适的单面墙或转角面"); return; }
    // 分析结果再对着渲染出来的模型实测一遍，屏不会伸到墙面以外
    fit = refineFitOnModel(this.workspace.root, fit, child, sel.position.clone());
    const local = this._partsContainer().worldToLocal(fit.point.clone());
    sel.position.copy(local);
    sel.rotation.y = fit.rotY;
    sel.scale.setScalar(1); // 规格已含最终尺寸
    d.spec = { ...(fit.spec || d.spec), mount: child.billboard.mount };
    const fresh = buildCompositeScreenNode(child, d.spec);
    if (fresh) { for (const c of sel.children.slice()) sel.remove(c); sel.add(fresh); }
    this._syncCompositeParts();
    this._renderProps();
    this._setStatus(`已按落点重新适配到${fit.surface.type === "corner" ? "L 形转角" : "单面墙"} · 屏 ${d.spec.w}×${d.spec.h}m · 离地 ${d.spec.y}m`);
  }

  /** 屏幕规格改了：按新规格重建占位屏，离地高度同步到部件锚点 */
  async _rebuildCompositeScreen(sel) {
    const d = sel && sel.userData && sel.userData.compositePart;
    if (!d || !d.spec) return;
    // 左右屏长不能超过所挂墙面的可用长度：超了自动收缩到与墙等宽
    let wallNote = "";
    if (d.spec.mount === "corner" || d.spec.mount === "corner3d") {
      if (!this._surfacesCache) this._surfacesCache = analyzeSurfaces(this.workspace.root);
      const near = this._surfacesCache.corners.slice()
        .sort((a, b) => a.center.distanceToSquared(sel.position) - b.center.distanceToSquared(sel.position))[0];
      if (near) {
        const limA = Math.max(4, near.lenA - 1.6), limB = Math.max(4, near.lenB - 1.6);
        if (d.spec.wA > limA || d.spec.wB > limB) {
          d.spec.wA = +Math.min(d.spec.wA, limA).toFixed(2);
          d.spec.wB = +Math.min(d.spec.wB, limB).toFixed(2);
          wallNote = ` · 已按墙面可用长度收缩到 ${d.spec.wA}m / ${d.spec.wB}m`;
        }
      }
    }
    const child = await getAsset(d.assetId);
    if (!child || !child.billboard) return;
    const fresh = buildCompositeScreenNode(child, d.spec);
    if (!fresh) return;
    for (const c of sel.children.slice()) sel.remove(c);
    sel.add(fresh);
    sel.scale.setScalar(1);
    sel.position.y = d.spec.y; // 离地高度就是锚点（屏心）高度
    this._syncCompositeParts();
    this._renderProps();
    this._setStatus(`「${d.name}」规格已更新${wallNote} · 保存后随模型生效`);
  }

  /* ---------------- 组合资产（任意模型 + 任意广告屏） ---------------- */

  /** 组合容器：已加载资产用模板里的零变换容器，空白工作台用工作台根。
   *  parts 恒为容器的「直接子节点」，坐标以资产底面中心为原点 —— 与
   *  assetMesh 重建模板、BillboardManager 运行时挂屏的坐标系完全一致。 */
  _partsContainer() {
    if (!this.workspace) return null;
    const holder = this.workspace.root.children.find((c) => c.userData && c.userData.compositeHolder);
    return holder || this.workspace.root;
  }

  /** 从场景节点回写 parts（位姿以节点变换为准，Gizmo / 面板改完立即同步） */
  _syncCompositeParts() {
    const container = this._partsContainer();
    if (!container) return [];
    const prev = normalizeParts(this.workspace.asset.parts);
    const byId = new Map(prev.map((p) => [p.id, p]));
    const out = [];
    for (const o of container.children) {
      const d = o.userData && o.userData.compositePart;
      if (!d) continue;
      const base = byId.get(d.id) || {};
      out.push({
        ...base, ...d,
        name: String(o.name || "").replace(/^组合\s*·\s*/, "") || d.name || "组合部件",
        pos: [+o.position.x.toFixed(3), +o.position.y.toFixed(3), +o.position.z.toFixed(3)],
        rotY: +o.rotation.y.toFixed(4),
        scale: +o.scale.x.toFixed(4),
      });
    }
    this.workspace.asset.parts = out;
    return out;
  }

  /** 载入已保存的组合资产：按子资产重建屏幕占位（clone 会丢 poseYaw / 圆角控制器） */
  async _refreshCompositeScreens(root, parts) {
    const holder = root.children.find((c) => c.userData && c.userData.compositeHolder) || root;
    for (const p of parts) {
      if (p.role !== "billboard") continue;
      const target = holder.children.find((o) => o.userData && o.userData.compositePart && o.userData.compositePart.id === p.id);
      if (!target) continue;
      const child = await getAsset(p.assetId);
      if (!child || !child.billboard) continue;
      const fresh = buildCompositeScreenNode(child, p.spec);
      if (!fresh) continue;
      for (const c of target.children.slice()) target.remove(c);
      target.add(fresh);
    }
  }

  async _addCompositePart(child, worldPoint, rotY = 0, autoFitHint = true) {
    if (!this.workspace || !child) return;
    const curId = this.workspace.asset.id;
    if (child.id === curId) { this._setStatus("不能把资产组合到它自己里"); return; }
    const childParts = normalizeParts(child.parts);
    if (curId && childParts.some((p) => p.assetId === curId)) {
      this._setStatus("会形成循环引用：该资产已经包含当前模型"); return;
    }
    if (childParts.some((p) => p.role === "billboard")) {
      this._setStatus("该资产里已有组合广告屏，暂不支持嵌套组合；请直接拖入单个广告屏模型"); return;
    }
    const isScreen = child.source === "billboard" && !!child.billboard;
    // 广告屏自动适配：按资产类型（单面 / L 形转角）挑最合适的墙面，
    // 落点、朝向与缩放一次配好；分析失败则退回原来的「拖到哪贴哪」。
    // 必须在构建占位屏之前算好规格 —— 占位屏几何要按它来生成
    let fit = null;
    if (isScreen && this._autoFit !== false) {
      if (!this._surfacesCache) this._surfacesCache = analyzeSurfaces(this.workspace.root);
      fit = fitScreenToModel(this._surfacesCache, child, autoFitHint ? worldPoint : null);
      if (fit) {
        // 再按实际渲染几何实测墙段：屏宽高、中心都以「射线量到的连续墙面」为准
        fit = refineFitOnModel(this.workspace.root, fit, child, autoFitHint ? worldPoint : null);
        worldPoint = fit.point.clone();
        rotY = fit.rotY;
      }
    }
    if (isScreen && !fit && (child.billboard.mount === "corner" || child.billboard.mount === "corner3d")) {
      rotY += Math.PI; // 转角屏几何基准朝 -Z/-X，手动贴墙时转过来
    }
    // 没自动适配且拖到空地时给一个合理高度（贴墙时落点本身就有高度）
    if (isScreen && worldPoint.y < 1) worldPoint.y = +(child.billboard?.spec?.y || 9);
    let node;
    if (isScreen) {
      // 占位屏必须按适配后的规格构建：不带 spec 会永远渲染资产默认尺寸，
      // 画布上看起来就是「屏比墙面大」，而保存的 parts.spec 却是对的
      node = buildCompositeScreenNode(child, fit ? fit.spec : null); // 纯屏（无自带塔体）+ 屏心对齐
    } else if (child.source === "traced" && child.traced) {
      node = buildTracedObject(child);
    } else {
      const tpl = await getAssetTemplate(child);
      node = tpl ? tpl.clone() : null;
    }
    if (!node) {
      node = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), new THREE.MeshBasicMaterial({ color: 0x3a72b0, wireframe: true }));
      this._setStatus(`「${child.name || "部件"}」几何不可用，已放置占位框`);
    }
    const container = this._partsContainer();
    container.updateWorldMatrix(true, false);
    const local = container.worldToLocal(worldPoint.clone());
    const g = new THREE.Group();
    g.name = `组合 · ${child.name || "部件"}`;
    // spec 里已经是最终屏幕尺寸，节点不再叠加缩放（否则工坊预览会二次缩小）
    const scale = 1;
    g.position.copy(local);
    g.rotation.y = rotY;
    g.scale.setScalar(scale);
    const s0 = (child.billboard && child.billboard.spec) || {};
    g.userData.compositePart = {
      id: newPartId(), assetId: child.id, name: child.name || "部件",
      role: isScreen ? "billboard" : "prop",
      pos: [local.x, local.y, local.z], rotY, scale, content: null,
      spec: isScreen ? {
        ...(fit ? fit.spec : {
          w: s0.w || 14, h: s0.h || 8, y: s0.y || 9,
          wA: s0.wA || s0.w || 14, wB: s0.wB || s0.w || 14,
        }),
        mount: child.billboard.mount,
      } : null,
    };
    g.userData.sharedTpl = true; // 几何/材质与子资产模板共享，重建时不要 dispose
    g.add(node);
    container.add(g);
    this._syncCompositeParts(); // 只改 parts，不标 geometryDirty：底座 GLB 不用重导
    this._select(g);
    const fitMsg = fit
      ? `已按落点适配到${fit.surface.type === "corner" ? "L 形转角" : "单面墙"}（屏 ${fit.spec.w}×${fit.spec.h}m · 离地 ${fit.spec.y}m）· `
      : "";
    this._setStatus(`${fitMsg}已把「${child.name || "部件"}」加入「${this.workspace.asset.name || "新模型"}」· W/E/R 可微调 · 内容由后台按屏位配置`);
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
    if (!this.sel || !this.workspace) return;
    const src = this.sel;
    const isPart = !!(src.userData && src.userData.compositePart);
    const copy = this._clonePart(src, src.name + "-copy");
    copy.position.x += 3;
    (src.parent || this.workspace.root).add(copy);
    if (isPart) this._syncCompositeParts();
    else this.workspace.geometryDirty = true;
    this._select(copy);
    this._setStatus(isPart ? "已复制组合部件：引用同一个子资产，可单独设内容与位姿" : "已复制部件");
  }

  _deleteSelected() {
    if (!this.sel || !this.workspace) return;
    const obj = this.sel;
    const isPart = !!(obj.userData && obj.userData.compositePart);
    if (obj.parent) obj.parent.remove(obj); // 组合部件挂在容器下，不一定是工作台根的直接子
    if (isPart) this._syncCompositeParts();
    else this.workspace.geometryDirty = true;
    this._deselect(); // 内部会重绘属性面板与场景树
    this._setStatus(isPart ? "已从组合中移除该部件" : "已删除部件");
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
    const parent = src.parent || this.workspace.root;
    for (let ix = -1; ix <= 1; ix++) {
      for (let iz = -1; iz <= 1; iz++) {
        if (!ix && !iz) continue;
        const copy = this._clonePart(src, src.name + `-a${++n}`);
        copy.position.x += ix * sx;
        copy.position.z += iz * sz;
        parent.add(copy);
      }
    }
    if (src.userData && src.userData.compositePart) this._syncCompositeParts();
    else this.workspace.geometryDirty = true;
    this._renderTree();
    this._setStatus(`已生成 3×3 阵列（+8 个部件）· 各部件可单独选中调整`);
  }

  // 沿选中部件自身中心的 X 轴镜像复制（几何级镜像：翻绕序 + 翻法线，材质保持共享）
  _mirrorSelected() {
    if (!this.sel || !this.workspace) return;
    const src = this.sel;
    if ((src.userData && src.userData.compositePart) || !src.geometry) {
      this._setStatus("组合部件（引用子资产）请用「复制」；几何镜像只支持工作台基础体"); return;
    }
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
    copy.userData = { ...src.userData };
    if (copy.userData.compositePart) {
      // 组合部件：新实例 id，避免两个部件共用同一条 parts 记录
      copy.userData.compositePart = { ...copy.userData.compositePart, id: newPartId() };
    } else if (src.isMesh && src.material) {
      copy.userData.bindingKey = this._nextPartKey();
      copy.material = src.material.clone();
      copy.material.name = copy.userData.bindingKey;
    }
    return copy;
  }

  /* ---------------- 材质绑定 ---------------- */

  _bindMaterial(libId) {
    if (!this.sel || !this.sel.material) return; // 组合部件是 Group，材质跟随子资产
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
    const parts = this._syncCompositeParts();
    const hasParts = parts.length > 0;
    this.workspace.asset.parts = parts;
    if (hasParts) this.workspace.asset.composite = true;
    else delete this.workspace.asset.composite;

    try {
      // 广告牌资产只存规格（mount + w/h/y/arc），几何由 MOUNTS 现场重建 ——
      // 不导出 GLB，避免把屏面占位材质固化进模型（每屏运行时要独立播内容）。
      const isBillboard = this.workspace.asset.source === "billboard";
      const baseDirty = this.workspace.isNew || this.workspace.geometryDirty || this.workspace.needsExport;
      if (hasParts) {
        // 组合资产：子部件只存引用。底座几何真有变化时才重导 GLB，
        // 导出副本递归剔除组合部件（否则子资产改了不同步、屏也没法独立播内容）。
        // 只加/移/拖动屏幕不会标底座脏，原 GLB（含动画与材质）原样保留。
        if (!isBillboard && baseDirty && hasNonPartMesh(this.workspace.root)) {
          this.workspace.asset.glb = await exportObjectGLB(this._exportRoot(true));
          this.workspace.asset.source = "glb";
          this.workspace.asset.traced = undefined;
        }
        const box = new THREE.Box3().setFromObject(this.workspace.root);
        if (!box.isEmpty()) {
          const s = box.getSize(new THREE.Vector3());
          this.workspace.asset.unitSize = { x: +s.x.toFixed(2), y: +s.y.toFixed(2), z: +s.z.toFixed(2) };
        }
        this.workspace.geometryDirty = false;
        this.workspace.needsExport = false;
        this.workspace.isNew = false;
      } else if (!isBillboard && baseDirty) {
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
      await this._renderCover(saved.id); // 旧 objectURL 已在内部失效，列表显示新图
      this._setStatus(hasParts
        ? `已保存「${saved.name}」· ${parts.length} 个组合部件 · 放置到地图后屏位由后台统一配置内容`
        : `已保存「${saved.name}」· 可在 3D 地图编辑器的「我的模型」中放置`);
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
      if (normalizeParts(this.workspace.asset.parts).length) {
        // 组合资产：导出「画布所见」的完整外形（含占位屏）供备份 / Blender 二次加工；
        // 资产库内部仍只存底座 GLB + parts 引用，不影响运行时的动态组合
        blob = await exportObjectGLB(this._exportRoot(false));
      } else if (this.workspace.geometryDirty || this.workspace.needsExport || this.workspace.isNew) {
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
  // excludeParts=true：组合资产只导出「底座模型」，子部件以 parts 引用保存，
  // 不把占位屏 / 子模型几何烘进 GLB（否则子资产改了不会同步、屏也没法播内容）。
  _exportRoot(excludeParts = false) {
    const copy = this.workspace.root.clone(true);
    if (excludeParts) {
      // 组合部件可能嵌在模板容器里，必须递归剔除（含嵌套的子树）
      const rm = [];
      copy.traverse((o) => { if (o.userData && o.userData.compositePart) rm.push(o); });
      for (const o of rm) if (o.parent) o.parent.remove(o);
      // 底座已按资产根（底面中心）坐标系摆好：模板重建时不要再 alignBaseCenter，
      // 否则 GLB 往返会把底座平移，parts 的局部坐标就对不上了
      copy.userData.compositeBase = true;
    }
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

  /** 组合部件面板：列表 + 选中部件的位姿/内容/删除，友好地管理动态组合 */
  _partsPanelHtml() {
    if (!this.workspace) return "";
    const parts = normalizeParts(this.workspace.asset.parts);
    const sel = this.sel && this.sel.userData && this.sel.userData.compositePart ? this.sel : null;
    const d = sel ? sel.userData.compositePart : null;
    const rows = parts.length ? parts.map((p) => `
      <div class="ms3-part-row${d && d.id === p.id ? " active" : ""}" data-part="${esc(p.id)}" title="点击选中画布中的该部件">
        <span class="ms3-part-icon${p.role === "billboard" ? " screen" : ""}">${p.role === "billboard" ? "▣" : "▧"}</span>
        <b>${esc(p.name || "部件")}</b>
        <span class="ms3-part-role">${p.role === "billboard" ? "广告屏" : "模型"}</span>
        <button class="ms3-part-del" data-del="${esc(p.id)}" title="从组合中移除">×</button>
      </div>`).join("") : `<div class="ms3-part-empty">还没有组合部件<br><small>打开任意建筑模型，把左侧广告屏拖到画布<br>或点资产卡片上的 ＋</small></div>`;
    const sp = d && d.role === "billboard"
      ? (d.spec || { w: 14, h: 8, y: 9, wA: 14, wB: 14 })
      : null;
    const isCorner = sp && (sp.mount === "corner" || sp.mount === "corner3d");
    const editor = sel ? `
      <div class="ms3-part-editor">
        <div class="ms3-part-editor-head">正在编辑 <b>${esc(d.name || "部件")}</b>
          <span>${sp ? "广告屏 · 内容由后台配置" : "模型 · 引用子资产"}</span></div>
        ${sp ? `
        <div class="ms3-part-grid">
          <label>屏宽(m) <input id="ps-w" type="number" step="0.1" min="4" max="40" value="${+(+sp.w).toFixed(2)}" /></label>
          <label>屏高(m) <input id="ps-h" type="number" step="0.1" min="2" max="30" value="${+(+sp.h).toFixed(2)}" /></label>
          ${isCorner ? `
          <label>左屏长(m) <input id="ps-wa" type="number" step="0.1" min="4" max="40" value="${+(+sp.wA).toFixed(2)}" /></label>
          <label>右屏长(m) <input id="ps-wb" type="number" step="0.1" min="4" max="40" value="${+(+sp.wB).toFixed(2)}" /></label>` : ""}
          <label>离地高度(m) <input id="ps-y" type="number" step="0.5" min="3" max="120" value="${+(+sp.y).toFixed(2)}" /></label>
        </div>
        <div class="ms3-hint">${isCorner
          ? "左右屏长可分别设置，平铺画面按长度比例分配。"
          : "屏宽 / 屏高决定画面尺寸。"}位置由自动找面确定，不用填坐标；改完即时更新画布，保存后随模型生效。</div>` : `<div class="ms3-hint">模型部件引用子资产的几何与材质，位置由自动找面确定。</div>`}
        <div class="ms3-row">
          ${sp ? `<button class="ms3-btn" id="ms3-part-refit">重新找面适配</button>` : ""}
          <button class="ms3-btn" id="ms3-part-dup">复制部件</button>
        </div>
        <button class="ms3-btn danger" id="ms3-part-remove" style="width:100%;margin-top:6px">移除该部件</button>
      </div>` : "";
    return `<h4 class="ms3-part-title">组合部件 <small>${parts.length}</small></h4>
      <label class="ms3-check" style="border:none;padding:0 0 6px"><input type="checkbox" id="ms3-autofit" ${this._autoFit ? "checked" : ""} />拖入广告屏时自动找面并适配尺寸</label>
      <div class="ms3-hint">任意模型 + 任意广告屏自由组合：左侧资产可拖进画布（或点 ＋）。部件存资产引用，改一次子模型全城同步。<b>模型层只定义屏位与规格，播放内容由后台统一配置。</b></div>
      <div class="ms3-part-list">${rows}</div>${editor}`;
  }

  _wirePartsPanel(box) {
    const autoFit = box.querySelector("#ms3-autofit");
    if (autoFit) autoFit.addEventListener("change", () => {
      this._autoFit = autoFit.checked;
      this._setStatus(autoFit.checked
        ? "自动适配已开启：拖入广告屏会自动靠到单面墙 / L 形转角并按面积适配大小"
        : "自动适配已关闭：广告屏将放在拖放位置，可用 W/E/R 与右侧数值手动调整");
    });
    const findPart = (id) => {
      const container = this._partsContainer();
      return container && container.children.find((o) => o.userData && o.userData.compositePart && o.userData.compositePart.id === id);
    };
    for (const row of box.querySelectorAll(".ms3-part-row")) {
      row.addEventListener("click", (e) => {
        if (e.target.closest(".ms3-part-del")) return;
        const found = findPart(row.dataset.part);
        if (found) this._select(found);
      });
    }
    for (const btn of box.querySelectorAll(".ms3-part-del")) {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const found = findPart(btn.dataset.del);
        if (!found) return;
        if (found.parent) found.parent.remove(found);
        if (this.sel === found) this._deselect();
        this._syncCompositeParts();
        this._renderProps();
        this._setStatus("已从组合中移除该部件");
      });
    }
    const sel = this.sel && this.sel.userData && this.sel.userData.compositePart ? this.sel : null;
    if (!sel) return;
    // 广告屏部件：只编辑屏幕规格（宽 / 高 / 左右屏长 / 离地高度），
    // 落点与朝向由自动找面决定，不再暴露模型本地坐标
    for (const [id, key, min, max] of [
      ["#ps-w", "w", 4, 40], ["#ps-h", "h", 2, 30],
      ["#ps-wa", "wA", 4, 40], ["#ps-wb", "wB", 4, 40],
      ["#ps-y", "y", 3, 120],
    ]) {
      const n = box.querySelector(id);
      if (!n) continue;
      n.addEventListener("change", () => {
        const d = sel.userData.compositePart;
        if (!d.spec) return;
        d.spec = { ...d.spec, [key]: Math.min(max, Math.max(min, +n.value || min)) };
        this._rebuildCompositeScreen(sel);
      });
    }
    const rm = box.querySelector("#ms3-part-remove");
    if (rm) rm.addEventListener("click", () => this._deleteSelected());
    const dup = box.querySelector("#ms3-part-dup");
    if (dup) dup.addEventListener("click", () => this._duplicateSelected());
    const refit = box.querySelector("#ms3-part-refit");
    if (refit) refit.addEventListener("click", () => this._refitSelected());
  }

  _renderProps() {
    const box = this._el.querySelector("#ms3-props");
    const badge = this._el.querySelector("#ms3-asset-badge");
    this._updateDropHint();
    if (!this.workspace) {
      badge.textContent = "";
      box.innerHTML = `<div class="ms3-empty">从左侧资产库选择一个资产<br>或导入 GLB / 新建参数模型开始设计</div>`;
      return;
    }
    const a = this.workspace.asset;
    const isBillboard = a.source === "billboard";
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
           ${selMat ? `<select id="ms3-mat"><option value="">（保留原材质 · 未绑定）</option>${this._materialOptions(this.workspace.bindings[selKey])}</select>`
             : this.sel.userData && this.sel.userData.compositePart
               ? `<div class="ms3-hint">组合部件：几何与材质跟随子资产（改一次子模型全城同步）；在下方调整屏幕规格，播放内容由后台统一配置。</div>`
               : `<div class="ms3-hint">组节点：展开/收起子部件、整组重命名；材质绑定请选具体 mesh。</div>`}
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
    const cats = (this._groups || []).slice();
    if (a.category && !cats.some((g) => g.id === a.category)) cats.push({ id: a.category, name: a.category });
    box.innerHTML = `
      <div class="ms3-field"><label>名称</label><input id="ms3-name" value="${esc(a.name || "")}" maxlength="24" /></div>
      <div class="ms3-field"><label>分类</label><select id="ms3-cat">${cats.map((g) => `<option value="${esc(g.id)}"${a.category === g.id ? " selected" : ""}>${esc(g.name)}</option>`).join("")}</select></div>
      <div class="ms3-field"><label>来源</label><input value="${{ glb: "GLB 模型", traced: "描边建筑", studio: "参数建模", billboard: "广告牌模型" }[a.source] || a.source}" disabled /></div>
      ${isBillboard ? `<div class="ms3-hint">广告牌模型：几何由承载形式 + 屏体规格现场重建，不存 GLB。<b>内容 / 素材 / 后台内容源与模型完全解耦</b>——模型层只定义屏位规格，播放内容由后台统一配置。</div>
        ${this._billboardAssetSpecHtml(a)}
        ${isBillboard && a.billboard && a.billboard.mount === "corner3d" ? `
        <div class="ms3-field"><label>转角弧度 · 圆角半径（米）<span id="ms3-arc-val">${(+((a.billboard.spec || {}).arc) || 0).toFixed(1)}</span></label>
          <input id="ms3-arc" type="range" min="0" max="5" step="0.1" value="${(+((a.billboard.spec || {}).arc) || 0)}" style="--fill:${Math.round(((+((a.billboard.spec || {}).arc) || 0) / 5) * 100)}%" />
          <div class="ms3-hint">0 = 直角共棱；大于 0 时转角过渡成 1/4 圆柱弧。拖动即改模型几何，保存资产后随模型生效；后台「圆角半径覆盖」留空即跟随这里。</div>
        </div>` : ""}` : ""}
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
      ${isBillboard ? "" : `
      <div style="margin-bottom:10px">
        <button class="ms3-btn" id="ms3-add-box" style="width:100%;margin-bottom:6px">＋ 添加部件 · 盒</button>
        <div class="ms3-row">
          <button class="ms3-btn" id="ms3-add-cyl">圆柱</button>
          <button class="ms3-btn" id="ms3-add-sph">球</button>
          <button class="ms3-btn" id="ms3-add-slab">薄板</button>
        </div>
        <div class="ms3-hint">部件类型：盒/圆柱/球/薄板 = 参数化基础体，适合搭建筑体块；GLB 导入的部件 = 原模型网格。每个部件有绑定键，用于绑材质与夜景亮度。</div>
      </div>`}
      ${this._partsPanelHtml()}
      <h4 style="border:none;padding-left:0">场景部件</h4>
      <div id="ms3-tree" style="margin-bottom:10px"></div>
      ${selInfo}`;
    // wire
    this._wirePartsPanel(box);
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
    const arcInput = box.querySelector("#ms3-arc");
    if (arcInput) arcInput.addEventListener("input", () => {
      const r = +arcInput.value || 0;
      const label = box.querySelector("#ms3-arc-val");
      if (label) label.textContent = r.toFixed(1);
      arcInput.style.setProperty("--fill", `${Math.round((r / 5) * 100)}%`);
      this._setBillboardArc(r);
      this._setStatus(`转角弧度 ${r.toFixed(1)}m · 视口实时预览，保存资产后写入模型`);
    });
    // 广告牌资产自身的屏幕规格：与组合部件同一套字段，改动即时重建预览
    for (const [id, key, min, max] of [
      ["#ba-w", "w", 4, 40], ["#ba-h", "h", 2, 30],
      ["#ba-wa", "wA", 4, 40], ["#ba-wb", "wB", 4, 40],
      ["#ba-y", "y", 3, 120],
    ]) {
      const n = box.querySelector(id);
      if (!n) continue;
      n.addEventListener("change", () => {
        this._setBillboardSpec(key, Math.min(max, Math.max(min, +n.value || min)));
        this._renderProps();
      });
    }
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
    let anon = 0; // 未命名 mesh 的序号：避免一列「Mesh」分不清是哪一个
    const walk = (obj, depth, path) => {
      for (const child of obj.children) {
        if (child === helper) continue;
        const hasKids = child.children.some((c) => c !== helper);
        const collapsed = this._treeCollapsed.has(child.uuid);
        const key = child.userData ? child.userData.bindingKey : null;
        const bound = key && this.workspace.bindings[key];
        const cp = child.userData ? child.userData.compositePart : null;
        const disp = child.name || (child.isMesh ? `Mesh #${++anon}` : child.type);
        const fullPath = `${path}/${disp}`;
        const item = document.createElement("div");
        item.className = "ms3-tree-item" + (child === this.sel ? " active" : "");
        item.style.paddingLeft = 8 + depth * 14 + "px";
        item.title = fullPath;
        item.innerHTML = `${hasKids
          ? `<span class="ms3-tree-toggle" title="展开/收起">${collapsed ? "▸" : "▾"}</span>`
          : `<span class="ms3-tree-dot"></span>`}${esc(disp)}${cp ? `<span class="ms3-tree-chip${cp.role === "billboard" ? " screen" : ""}">${cp.role === "billboard" ? "广告屏" : "组合模型"}</span>` : ""}${child.isMesh && key ? `<span class="mat-chip${bound ? "" : " unbound"}">${esc(bound || key)}</span>` : ""}`;
        item.addEventListener("click", () => this._select(child));
        if (hasKids) {
          item.querySelector(".ms3-tree-toggle").addEventListener("click", (e) => {
            e.stopPropagation(); // 别触发选中
            collapsed ? this._treeCollapsed.delete(child.uuid) : this._treeCollapsed.add(child.uuid);
            this._renderTree();
          });
        }
        tree.appendChild(item);
        if (hasKids && !collapsed) walk(child, depth + 1, fullPath);
      }
    };
    walk(this.workspace.root, 0, this.workspace.asset.name || "模型");
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

  /** 空白工作台时才显示「拖资产到这里」引导，避免挡住已有模型 */
  _updateDropHint() {
    const hint = this._el && this._el.querySelector("#ms3-drop-hint");
    if (!hint) return;
    hint.hidden = !!(this.workspace && this.workspace.root.children.length);
  }
}

/* ---------------- helpers ---------------- */

/** 命中的网格若属于组合部件，返回整个组合组（点选 / Gizmo / 删除的最小单位） */
function compositeRootOf(obj) {
  for (let o = obj; o; o = o.parent) {
    if (o.userData && o.userData.compositePart) return o;
  }
  return null;
}
function isInsideCompositePart(obj) { return !!compositeRootOf(obj); }

/** 工作台里是否存在「非组合部件」的底座网格（决定保存时要不要重导底座 GLB） */
function hasNonPartMesh(root) {
  let found = false;
  root.traverse((o) => {
    if (!found && o.isMesh && !isInsideCompositePart(o)) found = true;
  });
  return found;
}

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
