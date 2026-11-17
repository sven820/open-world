import { AvatarRig } from "./avatarRig.js";
import { PARAM_GROUPS, COLOR_PARAMS, PRESETS, defaultConfig, clampConfig, presetConfig, randomConfig } from "./faceParams.js";
import { AIStylist } from "./aiStylist.js";
import { ImageAvatarGenerator } from "./imageAvatar.js";
import { onAIConfigChange, configured, isVisionModel } from "../config/aiConfig.js";
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
  async _aiRefine() {
    if (this.busy) return;
    const input = $("#cc-ai-input", this.el);
    const text = input.value.trim();
    if (!text) { this._toast("先描述一下想要的样子，例如「大眼睛、瓜子脸、微笑」", true); input.focus(); return; }
    this.busy = true;
    const btn = $("#cc-ai-go", this.el);
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = "AI 思考中…";
    $("#cc-status", this.el).textContent = "AI 正在调整…";
    try {
      const res = await this.ai.refine(text, this.config);
      if (res.ok) {
        this._pushHistory();
        res.config.snapshot = this.config.snapshot;
        this.config = res.config;
        this._activePreset = null;
        this._applyAndSync();
        this._renderParams();
        input.value = "";
      }
      this._toast(res.message, !res.ok);
    } catch (e) {
      this._toast(`AI 调整失败：${e.message}`, true);
    } finally {
      this.busy = false;
      btn.disabled = false; btn.textContent = old;
      $("#cc-status", this.el).textContent = `已就绪 · ${this.rig ? this.rig.boneCount : 0} 根骨骼`;
    }
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
  _save() {
    try {
      if (this.rig) this.config.snapshot = this.rig.snapshot(128);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.config));
      if (typeof this.onSave === "function") this.onSave(clampConfig(this.config));
      this.close();
      window.dispatchEvent(new CustomEvent("ws:avatar-changed", { detail: this.config }));
    } catch (e) {
      this._toast(`保存失败：${e.message}`, true);
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
