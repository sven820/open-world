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
  isMemoryOnly,
} from "../data/assetStore.js";
import { listMaterials, getMaterial } from "../world/materials.js";
import { getAssetTemplate, invalidateAssetTemplate, updateAssetAnimations, playAssetClips, stopAssetMixer, getAssetClipNames } from "../world/assetMesh.js";
import { ensureBillboardAssets, BILLBOARD_TEMPLATES } from "../data/billboardAsset.js";
import { buildBillboardAssetObject, getCornerArc } from "../world/billboard/billboardAssetBridge.js";
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
    await ensureBillboardAssets(); // 首次进工坊自动播种四种广告牌模型资产
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
      this._geometryDirty = true;
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
      const srcZh = { glb: "GLB", traced: "描边", studio: "自建" }[a.source] || a.source;
      card.innerHTML = `
        ${a.thumb ? `<img src="${this._thumbUrls[a.id] || (this._thumbUrls[a.id] = URL.createObjectURL(a.thumb))}" />` : `<img src="" style="opacity:.2" />`}
        <div class="ms3-card-info"><b>${esc(a.name || "未命名")}</b>
        <small>${srcZh}${a.meshCount ? " · " + a.meshCount + " mesh" : ""}</small></div>
        <button class="ms3-card-del" title="删除资产">×</button>`;
      card.addEventListener("click", async () => {
        const fresh = await getAsset(a.id);
        if (fresh) await this._loadAsset(fresh);
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
    if (asset.source === "billboard" && tpl) {
      // 广告牌工作台直接用桥接产物（带 _cornerArc 控制器），而不是模板克隆 ——
      // 这样右侧改弧度可以原地 setRadius，无需重建模型 / 不丢朝向与材质。
      const fresh = buildBillboardAssetObject(asset);
      if (fresh) {
        // 不能用 tpl.clone() 的 rotation：three 的 clone 会把 π 欧拉角丢成 ~0，
        // 广告面就转到背面去了。fresh 由桥接产物构建，poseYaw 由资产数据直接写入。
        const inner = root.children[0];
        if (inner) root.remove(inner);
        root.add(fresh);
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
    const root = buildBillboardAssetObject(asset);
    if (!root) return;
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
      // 广告牌资产只存规格（mount + w/h/y/arc），几何由 MOUNTS 现场重建 ——
      // 不导出 GLB，避免把屏面占位材质固化进模型（每屏运行时要独立播内容）。
      const isBillboard = this.workspace.asset.source === "billboard";
      if (!isBillboard && (this.workspace.isNew || this.workspace.geometryDirty || this.workspace.needsExport)) {
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
    const cats = (this._groups || []).slice();
    if (a.category && !cats.some((g) => g.id === a.category)) cats.push({ id: a.category, name: a.category });
    box.innerHTML = `
      <div class="ms3-field"><label>名称</label><input id="ms3-name" value="${esc(a.name || "")}" maxlength="24" /></div>
      <div class="ms3-field"><label>分类</label><select id="ms3-cat">${cats.map((g) => `<option value="${esc(g.id)}"${a.category === g.id ? " selected" : ""}>${esc(g.name)}</option>`).join("")}</select></div>
      <div class="ms3-field"><label>来源</label><input value="${{ glb: "GLB 模型", traced: "描边建筑", studio: "参数建模", billboard: "广告牌模型" }[a.source] || a.source}" disabled /></div>
      ${isBillboard ? `<div class="ms3-hint">广告牌模型：几何由承载形式 + 屏体规格现场重建，不存 GLB。<b>内容 / 素材 / 后台内容源与模型完全解耦</b>——在地图编辑器选中广告牌后单独编辑显示内容，任意广告牌可挂到别的建筑模型上。</div>
        <div class="ms3-hint">${(() => { const b = a.billboard || {}; const s = b.spec || {}; return `承载形式：${b.mount || "?"} · 屏宽 ${s.w || "?"}m · 屏高 ${s.h || "?"}m · 屏心高度 ${s.y || "?"}m`; })()}</div>
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
    const arcInput = box.querySelector("#ms3-arc");
    if (arcInput) arcInput.addEventListener("input", () => {
      const r = +arcInput.value || 0;
      const label = box.querySelector("#ms3-arc-val");
      if (label) label.textContent = r.toFixed(1);
      arcInput.style.setProperty("--fill", `${Math.round((r / 5) * 100)}%`);
      this._setBillboardArc(r);
      this._setStatus(`转角弧度 ${r.toFixed(1)}m · 视口实时预览，保存资产后写入模型`);
    });
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
        const disp = child.name || (child.isMesh ? `Mesh #${++anon}` : child.type);
        const fullPath = `${path}/${disp}`;
        const item = document.createElement("div");
        item.className = "ms3-tree-item" + (child === this.sel ? " active" : "");
        item.style.paddingLeft = 8 + depth * 14 + "px";
        item.title = fullPath;
        item.innerHTML = `${hasKids
          ? `<span class="ms3-tree-toggle" title="展开/收起">${collapsed ? "▸" : "▾"}</span>`
          : `<span class="ms3-tree-dot"></span>`}${esc(disp)}${child.isMesh && key ? `<span class="mat-chip${bound ? "" : " unbound"}">${esc(bound || key)}</span>` : ""}`;
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
