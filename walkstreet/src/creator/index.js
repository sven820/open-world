import { AvatarRig } from "./avatarRig.js";
import { PARAM_GROUPS, COLOR_PARAMS, PRESETS, PARAM_MAP, defaultConfig, clampConfig, presetConfig, randomConfig } from "./faceParams.js";
import { AIStylist } from "./aiStylist.js";
import { ImageAvatarGenerator, prepareImage } from "./imageAvatar.js";
import { onAIConfigChange, configured, isVisionModel } from "../config/aiConfig.js";
import { gatewayAvailable, invokeAbility } from "../ai/wsAiClient.js";
import "./creator.css";

const STORAGE_KEY = "ws_creator_avatar";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const AVATARS = [
  { url: "/avatars/jie.glb", name: "阿杰", detail: "精细面部骨骼 · 男", fine: true },
  { url: "/avatars/wen.glb", name: "阿雯", detail: "精细面部骨骼 · 女", fine: true },
  { url: "/avatars/casual-f.glb", name: "休闲女", detail: "基础骨骼", fine: false },
  { url: "/avatars/casual-m.glb", name: "休闲男", detail: "基础骨骼", fine: false },
  { url: "/avatars/student-f.glb", name: "学生女", detail: "基础骨骼", fine: false },
  { url: "/avatars/student-m.glb", name: "学生男", detail: "基础骨骼", fine: false },
  { url: "/avatars/office-f.glb", name: "职员女", detail: "基础骨骼", fine: false },
  { url: "/avatars/office-m.glb", name: "职员男", detail: "基础骨骼", fine: false },
  { url: "/avatars/police.glb", name: "警员", detail: "基础骨骼", fine: false },
  { url: "/avatars/auntie.glb", name: "阿姨", detail: "基础骨骼", fine: false },
  { url: "/avatars/uncle.glb", name: "大叔", detail: "基础骨骼", fine: false },
  { url: "/avatars/elder-f.glb", name: "老奶奶", detail: "基础骨骼", fine: false },
  { url: "/avatars/elder-m.glb", name: "老爷爷", detail: "基础骨骼", fine: false },
  { url: "/avatars/vendor.glb", name: "摊主", detail: "基础骨骼", fine: false },
];

export function loadSavedAvatar() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? clampConfig(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export class CharacterCreator {
  constructor({ onSave } = {}) {
    this.el = document.getElementById("character-creator");
    this.onSave = onSave;
    this.rig = null;
    this.ai = new AIStylist();
    this.imageGen = new ImageAvatarGenerator(this.ai);
    this.imageFile = null;
    this.config = loadSavedAvatar() || defaultConfig();
    this.history = [];
    this.future = [];
    this.activeTab = PARAM_GROUPS[0].id;
    this.busy = false;
    this._bound = false;
    this._toastTimer = 0;
    // AI 栏附件：{ kind: 'image' | 'model', file, name }
    this._aiAttach = null;
    this._aiModelObjectUrl = null;
  }

  get canvas() { return $("#cc-canvas", this.el); }

  open() {
    this.el.classList.remove("hidden");
    if (!this.rig) this.rig = new AvatarRig(this.canvas);
    if (!this._bound) { this._bind(); this._bound = true; }
    this.rig.start();
    this._renderAvatars();
    this._renderPresets();
    this._renderTabs();
    this._renderParams();
    this._syncUI();
    this._loadAvatar(this.config.avatar);
  }

  close() {
    this.el.classList.add("hidden");
    if (this.rig) this.rig.stop();
  }

  async _loadAvatar(url) {
    if (!this.rig) return;
    const status = $("#cc-status", this.el);
    const loading = $("#cc-loading", this.el);
    loading.classList.remove("hidden");
    status.textContent = "模型加载中…";
    try {
      await this.rig.load(url);
      this.config.avatar = url;
      this.rig.apply(this.config);
      const fine = this.rig.boneCount || 0;
      status.textContent = `已就绪 · ${fine} 根骨骼`;
      $("#cc-bone-info", this.el).textContent = fine > 40 ? `${fine} 根骨骼 · 支持精细捏脸` : `${fine} 根骨骼 · 基础调整`;
      this._renderAvatars();
    } catch (e) {
      status.textContent = "模型加载失败";
      this._toast(`角色加载失败：${e.message}`, true);
    } finally {
      loading.classList.add("hidden");
    }
  }

  /* -------------------- UI 构建 -------------------- */
  _renderAvatars() {
    const box = $("#cc-avatar-list", this.el);
    box.innerHTML = AVATARS.map((a) => `
      <button class="cc-avatar ${a.url === this.config.avatar ? "active" : ""}" data-avatar="${a.url}" title="${escapeHtml(a.detail)}">
        <span class="cc-avatar-dot ${a.fine ? "fine" : ""}"></span>
        <span class="cc-avatar-name">${escapeHtml(a.name)}</span>
        <small>${a.fine ? "精细" : "基础"}</small>
      </button>`).join("");
  }

  _renderPresets() {
    const box = $("#cc-preset-list", this.el);
    box.innerHTML = PRESETS.map((p) => `
      <button class="cc-preset ${p.id === this._activePreset ? "active" : ""}" data-preset="${p.id}">
        <span class="cc-preset-emoji">${p.emoji}</span>
        <span class="cc-preset-info"><b>${escapeHtml(p.label)}</b><small>${escapeHtml(p.desc)}</small></span>
      </button>`).join("");
  }

  _renderTabs() {
    const box = $("#cc-tabs", this.el);
    box.innerHTML = PARAM_GROUPS.map((g) => `<button class="cc-tab ${g.id === this.activeTab ? "active" : ""}" data-tab="${g.id}">${escapeHtml(g.label)}</button>`).join("");
  }

  _renderParams() {
    const group = PARAM_GROUPS.find((g) => g.id === this.activeTab) || PARAM_GROUPS[0];
    const box = $("#cc-params", this.el);
    let html = `<div class="cc-group-hint">${escapeHtml(group.hint || "")}</div>`;
    for (const p of group.params) {
      const v = this.config.params[p.id];
      html += `<div class="cc-param" data-id="${p.id}">
        <div class="cc-param-head"><label>${escapeHtml(p.label)}</label><output>${v}</output></div>
        <input type="range" min="${p.min}" max="${p.max}" step="${p.step}" value="${v}" data-param="${p.id}" />
        <div class="cc-param-ticks"><span>${p.min}</span><span>中性 ${p.def}</span><span>${p.max}</span></div>
      </div>`;
    }
    if (this.activeTab === "face") {
      for (const c of COLOR_PARAMS) {
        const v = this.config.params[c.id];
        html += `<div class="cc-param cc-color-param" data-id="${c.id}">
          <div class="cc-param-head"><label>${escapeHtml(c.label)}</label><output>${v}</output></div>
          ${c.type === "swatch"
            ? `<div class="cc-swatches">${c.swatches.map((col, i) => `<button class="cc-swatch ${Math.floor(v / 100 * c.swatches.length) === i ? "active" : ""}" data-swatch="${i}" data-color="${c.id}" style="background:${col}" title="${col}"></button>`).join("")}</div>`
            : `<input type="range" min="${c.min}" max="${c.max}" step="${c.step}" value="${v}" data-param="${c.id}" class="cc-skin-range" />`}
        </div>`;
      }
    }
    box.innerHTML = html;
  }

  _syncUI() {
    $("#cc-name-badge", this.el).textContent = this.config.name || "自定义角色";
    $("#cc-undo", this.el).disabled = !this.history.length;
    $("#cc-redo", this.el).disabled = !this.future.length;
  }

  /* -------------------- 事件 -------------------- */
  _bind() {
    const el = this.el;

    $("#cc-close", el).addEventListener("click", () => this.close());
    $("#cc-cancel", el).addEventListener("click", () => this.close());

    $("#cc-avatar-list", el).addEventListener("click", (e) => {
      const btn = e.target.closest("[data-avatar]");
      if (!btn) return;
      const url = btn.dataset.avatar;
      if (url === this.config.avatar) return;
      this._pushHistory();
      this.config.avatar = url;
      this._loadAvatar(url);
    });

    $("#cc-preset-list", el).addEventListener("click", (e) => {
      const btn = e.target.closest("[data-preset]");
      if (!btn) return;
      const preset = PRESETS.find((p) => p.id === btn.dataset.preset);
      if (!preset) return;
      this._pushHistory();
      const next = presetConfig(preset, this.config.avatar);
      next.snapshot = this.config.snapshot;
      this.config = next;
      this._activePreset = preset.id;
      this._applyAndSync();
      this._renderPresets();
      this._toast(`已应用「${preset.label}」预设`);
    });

    $("#cc-tabs", el).addEventListener("click", (e) => {
      const btn = e.target.closest("[data-tab]");
      if (!btn) return;
      this.activeTab = btn.dataset.tab;
      this._renderTabs();
      this._renderParams();
    });

    const paramsBox = $("#cc-params", el);
    paramsBox.addEventListener("input", (e) => {
      const id = e.target.dataset.param;
      if (!id) return;
      this.config.params[id] = Number(e.target.value);
      const out = e.target.closest(".cc-param").querySelector("output");
      if (out) out.textContent = e.target.value;
      if (this.rig) this.rig.apply(this.config);
      this._activePreset = null;
      this._renderPresets();
    });
    paramsBox.addEventListener("change", (e) => {
      if (e.target.dataset.param) this._pushHistory();
    });
    paramsBox.addEventListener("click", (e) => {
      const sw = e.target.closest("[data-swatch]");
      if (!sw) return;
      this._pushHistory();
      this.config.params[sw.dataset.color] = Number(sw.dataset.swatch) * 10 + 5;
      this._applyAndSync();
      this._renderParams();
    });

    $$("[data-view]", el).forEach((btn) => btn.addEventListener("click", () => {
      $$("[data-view]", el).forEach((b) => b.classList.toggle("active", b === btn));
      if (this.rig) this.rig.setView(btn.dataset.view);
    }));

    $("#cc-random", el).addEventListener("click", () => {
      this._pushHistory();
      const r = randomConfig(this.config.avatar);
      r.snapshot = this.config.snapshot;
      this.config = r;
      this._activePreset = null;
      this._applyAndSync();
      this._renderParams();
      this._toast("已随机生成一张新脸，可继续微调");
    });

    $("#cc-reset", el).addEventListener("click", () => {
      this._pushHistory();
      const d = defaultConfig(this.config.avatar);
      d.snapshot = this.config.snapshot;
      this.config = d;
      this._activePreset = "default";
      this._applyAndSync();
      this._renderParams();
      this._toast("已恢复模型原始样貌");
    });

    $("#cc-undo", el).addEventListener("click", () => this._undo());
    $("#cc-redo", el).addEventListener("click", () => this._redo());
    $("#cc-save", el).addEventListener("click", () => this._save());

    $("#cc-ai-go", el).addEventListener("click", () => this._aiRefine());
    $("#cc-ai-input", el).addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); this._aiRefine(); }
    });
    // AI 栏附件：图片（以图捏脸）/ GLB 模型（自定义角色），支持点击、粘贴、拖入
    $("#cc-ai-attach", el).addEventListener("click", () => $("#cc-ai-file", el).click());
    const aiFileInput = $("#cc-ai-file", el);
    aiFileInput.addEventListener("change", () => {
      const f = aiFileInput.files && aiFileInput.files[0];
      if (f) this._setAiAttach(f);
      aiFileInput.value = "";
    });
    $("#cc-ai-input", el).addEventListener("paste", (e) => {
      const items = e.clipboardData && e.clipboardData.files;
      if (items && items.length && items[0].type.startsWith("image/")) {
        e.preventDefault();
        this._setAiAttach(items[0]);
      }
    });
    const aiBar = $("#cc-ai-bar", el);
    aiBar.addEventListener("dragover", (e) => { e.preventDefault(); aiBar.classList.add("dragover"); });
    aiBar.addEventListener("dragleave", () => aiBar.classList.remove("dragover"));
    aiBar.addEventListener("drop", (e) => {
      e.preventDefault();
      aiBar.classList.remove("dragover");
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) this._setAiAttach(f);
    });

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || el.classList.contains("hidden")) return;
      const imageModal = $("#cc-image-modal", el);
      if (imageModal && !imageModal.classList.contains("hidden")) imageModal.classList.add("hidden");
      else this.close();
    });

    // AI 配置在「设置 → AI 设置」里统一修改，这里订阅变化刷新引擎提示
    this._unsubAI = onAIConfigChange(() => this._updateImageSource());

    /* ---- 以图生成 ---- */
    $("#cc-image-open", el).addEventListener("click", () => this._openImagePanel());
    $("#cc-image-modal-close", el).addEventListener("click", () => $("#cc-image-modal", el).classList.add("hidden"));
    $("#cc-image-clear", el).addEventListener("click", () => this._clearImage());
    $("#cc-image-go", el).addEventListener("click", () => this._imageGenerate());

    const drop = $("#cc-image-drop", el);
    const fileInput = $("#cc-image-file", el);
    drop.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      fileInput.click();
    });
    fileInput.addEventListener("change", () => {
      if (fileInput.files && fileInput.files[0]) this._setImageFile(fileInput.files[0]);
    });
    ["dragenter", "dragover"].forEach((evt) => drop.addEventListener(evt, (e) => {
      e.preventDefault(); e.stopPropagation(); drop.classList.add("dragover");
    }));
    ["dragleave", "drop"].forEach((evt) => drop.addEventListener(evt, (e) => {
      e.preventDefault(); e.stopPropagation(); drop.classList.remove("dragover");
    }));
    drop.addEventListener("drop", (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) this._setImageFile(f);
    });
    document.addEventListener("paste", (e) => {
      if ($("#cc-image-modal", el).classList.contains("hidden")) return;
      const item = [...((e.clipboardData && e.clipboardData.items) || [])].find((i) => i.type.startsWith("image/"));
      if (item) {
        const f = item.getAsFile();
        if (f) { this._setImageFile(f); this._toast("已粘贴剪贴板图片"); }
      }
    });
  }

  _applyAndSync() {
    this.config = clampConfig(this.config);
    if (this.rig) this.rig.apply(this.config);
    this._syncUI();
    this._renderPresets();
    $("#cc-name-badge", this.el).textContent = this.config.name || "自定义角色";
  }

  /* -------------------- 历史 -------------------- */
  _pushHistory() {
    this.history.push(JSON.stringify(this.config));
    if (this.history.length > 50) this.history.shift();
    this.future.length = 0;
    this._syncUI();
  }

  _undo() {
    if (!this.history.length) return;
    this.future.push(JSON.stringify(this.config));
    this.config = JSON.parse(this.history.pop());
    this._applyAndSync();
    this._renderParams();
    this._renderAvatars();
  }

  _redo() {
    if (!this.future.length) return;
    this.history.push(JSON.stringify(this.config));
    this.config = JSON.parse(this.future.pop());
    this._applyAndSync();
    this._renderParams();
    this._renderAvatars();
  }

  /* -------------------- AI -------------------- */

  /** AI 栏附件：选择/粘贴/拖入文件 */
  _setAiAttach(file) {
    const isImage = file.type && file.type.startsWith("image/");
    const isModel = /\.(glb|gltf)$/i.test(file.name || "");
    if (!isImage && !isModel) { this._toast("仅支持图片（png/jpg/webp）或 GLB/GLTF 模型文件", true); return; }
    if (file.size > 20 * 1024 * 1024) { this._toast("文件过大（>20MB），请压缩后再试", true); return; }
    this._clearAiAttach();
    this._aiAttach = { kind: isImage ? "image" : "model", file, name: file.name || "剪贴板图片" };
    this._renderAiChip();
    this._toast(isImage ? "已添加图片：AI 修改将按照片生成样貌" : "已添加模型：点击「AI 修改」载入为自定义角色");
  }

  _renderAiChip() {
    const chip = $("#cc-ai-chip", this.el);
    if (!this._aiAttach) { chip.classList.add("hidden"); chip.innerHTML = ""; return; }
    const kindLabel = this._aiAttach.kind === "image" ? "图片" : "模型";
    chip.innerHTML = `<i>${kindLabel}</i><b>${escapeHtml(this._aiAttach.name)}</b><span class="cc-ai-chip-x" title="移除">✕</span>`;
    chip.classList.remove("hidden");
    chip.querySelector(".cc-ai-chip-x").addEventListener("click", () => this._clearAiAttach());
  }

  _clearAiAttach() {
    this._aiAttach = null;
    this._renderAiChip();
  }

  async _aiRefine() {
    if (this.busy) return;
    const input = $("#cc-ai-input", this.el);
    const text = input.value.trim();

    // 附件路由：模型文件 → 直接载入为自定义角色；图片 → 以图捏脸（文字作为补充要求）
    if (this._aiAttach && this._aiAttach.kind === "model") {
      try { this._applyModelFile(this._aiAttach.file); } finally { this._clearAiAttach(); }
      input.value = "";
      return;
    }
    if (this._aiAttach && this._aiAttach.kind === "image") {
      await this._withAiBusy(() => this._aiRefineImage(this._aiAttach.file, text), input, text);
      this._clearAiAttach();
      return;
    }

    if (!text) { this._toast("先描述一下想要的样子，例如「大眼睛、瓜子脸、微笑」", true); input.focus(); return; }
    await this._withAiBusy(() => this.ai.refine(text, this.config), input, text, true);
  }

  /** AI 调用公共外壳：busy 状态、按钮态、结果应用 */
  async _withAiBusy(taskPromiseFn, input, text, clearOnOk = false) {
    this.busy = true;
    const btn = $("#cc-ai-go", this.el);
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = "AI 思考中…";
    $("#cc-status", this.el).textContent = "AI 正在调整…";
    try {
      const res = await taskPromiseFn();
      if (res && res.ok && res.config) {
        this._pushHistory();
        res.config.snapshot = this.config.snapshot;
        this.config = res.config;
        this._activePreset = null;
        this._applyAndSync();
        this._renderParams();
        if (clearOnOk && input) input.value = "";
      }
      this._toast(res ? res.message : "未返回结果", !(res && res.ok));
    } catch (e) {
      this._toast(`AI 调整失败：${e.message}`, true);
    } finally {
      this.busy = false;
      btn.disabled = false; btn.textContent = old;
      $("#cc-status", this.el).textContent = `已就绪 · ${this.rig ? this.rig.boneCount : 0} 根骨骼`;
    }
  }

  /** 附件为图片：网关 image-avatar（vision）优先，回退旧直连/本地分析 */
  async _aiRefineImage(file, extraPrompt) {
    try {
      if (await gatewayAvailable()) {
        const img = await prepareImage(file);
        const data = await invokeAbility("image-avatar", {
          imageBase64: img.base64,
          extraPrompt: extraPrompt || "",
          currentConfig: this.config,
        });
        const changes = data && data.changes && typeof data.changes === "object" ? data.changes : null;
        if (data && data.ok !== false && changes && Object.keys(changes).length) {
          const cfg = clampConfig(this.config);
          for (const [id, raw] of Object.entries(changes)) {
            const p = PARAM_MAP[id];
            if (!p) continue;
            const v = Number(raw);
            if (!Number.isFinite(v)) continue;
            cfg.params[id] = Math.min(p.max, Math.max(p.min, Math.round(v)));
          }
          cfg.name = "照片形象";
          return { ok: true, source: "gateway", message: data.reply || "已按照片调整参数", config: cfg };
        }
        if (data && data.ok === false) {
          return { ok: false, message: data.reply || "照片中未识别出有效特征" };
        }
        // 网关返回无效结果 → 走旧路径
      }
    } catch (e) {
      // 网关不可用/失败 → 走旧路径（localRefine 式兜底在旧生成器里）
    }
    // 旧路径：直连视觉模型 / 本地图像分析（Key 在浏览器，历史行为保留）
    return this.imageGen.generate(file, this.config, { extraPrompt: extraPrompt || "" });
  }

  /** 附件为 GLB/GLTF：载入为自定义基础角色（非 AI 流程） */
  _applyModelFile(file) {
    if (this._aiModelObjectUrl) URL.revokeObjectURL(this._aiModelObjectUrl);
    const url = URL.createObjectURL(file);
    this._aiModelObjectUrl = url;
    this.config.name = file.name.replace(/\.(glb|gltf)$/i, "") || "自定义模型";
    // _loadAvatar 会写 config.avatar 并触发 rig.apply；骨骼数决定精细/基础调整
    this._loadAvatar(url);
    this._toast(`已载入自定义模型「${this.config.name}」${this.rig && this.rig.boneCount > 40 ? "" : "（未检测到精细面部骨骼，仅支持基础调整）"}`);
  }

  /* -------------------- 以图生成 -------------------- */
  _openImagePanel() {
    this._updateImageSource();
    $("#cc-image-modal", this.el).classList.remove("hidden");
  }

  _updateImageSource() {
    const el = $("#cc-image-source", this.el);
    const c = this.ai.config;
    const vm = c.visionModel || "";
    if (!configured()) {
      el.textContent = "引擎：本地图像分析（浏览器内提取肤色发色；在设置 → AI 设置中配置视觉模型可精确匹配五官）";
    } else if (isVisionModel(vm)) {
      el.textContent = `引擎：视觉大模型 ${vm}（照片将发送给你配置的服务商）`;
    } else {
      el.textContent = `引擎：本地图像分析（当前视觉模型 ${vm || c.model} 未识别为图片模型，可在设置 → AI 设置中调整）`;
    }
  }

  _setImageFile(file) {
    if (!file || !file.type.startsWith("image/")) { this._toast("请选择图片文件", true); return; }
    if (file.size > 12 * 1024 * 1024) { this._toast("图片请小于 12MB", true); return; }
    this.imageFile = file;
    const url = URL.createObjectURL(file);
    const preview = $("#cc-image-preview", this.el);
    preview.src = url;
    preview.classList.remove("hidden");
    $("#cc-image-placeholder", this.el).classList.add("hidden");
  }

  _clearImage() {
    this.imageFile = null;
    const preview = $("#cc-image-preview", this.el);
    preview.classList.add("hidden");
    if (preview.src && preview.src.startsWith("blob:")) URL.revokeObjectURL(preview.src);
    preview.removeAttribute("src");
    $("#cc-image-placeholder", this.el).classList.remove("hidden");
    $("#cc-image-file", this.el).value = "";
  }

  async _imageGenerate() {
    if (this.busy) return;
    if (!this.imageFile) { this._toast("请先选择一张人物照片", true); return; }
    this.busy = true;
    const btn = $("#cc-image-go", this.el);
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = "正在生成…";
    $("#cc-status", this.el).textContent = "AI 正在按照片生成角色…";
    try {
      const extra = $("#cc-image-extra", this.el).value.trim();
      const res = await this.imageGen.generate(this.imageFile, this.config, { extraPrompt: extra });
      if (res.ok) {
        this._pushHistory();
        res.config.snapshot = this.config.snapshot;
        this.config = res.config;
        this._activePreset = null;
        this._applyAndSync();
        this._renderParams();
        $("#cc-image-modal", this.el).classList.add("hidden");
      }
      this._toast(res.message, !res.ok);
    } catch (e) {
      this._toast(`生成失败：${e.message}`, true);
    } finally {
      this.busy = false;
      btn.disabled = false; btn.textContent = old;
      $("#cc-status", this.el).textContent = `已就绪 · ${this.rig ? this.rig.boneCount : 0} 根骨骼`;
    }
  }

  /* -------------------- 保存 -------------------- */
  async _save() {
    try {
      if (this.rig) this.config.snapshot = this.rig.snapshot(128);
      await this._persistAvatarIfLocal();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.config));
      if (typeof this.onSave === "function") this.onSave(clampConfig(this.config));
      this.close();
      window.dispatchEvent(new CustomEvent("ws:avatar-changed", { detail: this.config }));
    } catch (e) {
      this._toast(`保存失败：${e.message}`, true);
    }
  }

  /**
   * 自定义模型（附件上传的 GLB）的持久化：blob URL 重启后失效。
   * ≤4MB 的模型转 dataURL 一并存储；过大的模型只保留本次会话内的 blob 引用，
   * 并提示用户重启后会回退到原基础模型（参数仍会保存）。
   */
  async _persistAvatarIfLocal() {
    if (!this.config.avatar || !this.config.avatar.startsWith("blob:")) return;
    if (!this._aiAttach || this._aiAttach.kind !== "model") return;
    const file = this._aiAttach.file;
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error("模型文件读取失败"));
      r.readAsDataURL(file);
    });
    if (dataUrl.length <= 4_000_000) {
      this.config.avatar = dataUrl;
    } else {
      this._toast("模型文件过大（>3MB），已保存参数；模型仅本次会话有效，重启后回退原基础模型", true);
    }
  }

  _toast(msg, isError = false) {
    const t = $("#cc-toast", this.el);
    t.textContent = msg;
    t.classList.toggle("error", isError);
    t.classList.remove("hidden");
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
  }
}
