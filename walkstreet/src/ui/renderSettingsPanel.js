// 画面设置面板：档位一键切换 + 单项微调（全部即时生效，无需重启/重建世界）
import {
  PRESETS, getRenderSettings, updateRenderSettings, applyPreset, resetRenderSettings,
  onRenderSettingsChange,
} from "../config/renderSettings.js";

const PRESET_ORDER = ["low", "medium", "high", "ultra"];

const SCHEMA = [
  {
    group: "分辨率与视距",
    items: [
      { key: "renderScale", label: "渲染分辨率", hint: "着色分辨率倍数，最直接影响 GPU 负载", type: "range", min: 0.5, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
      { key: "renderDistance", label: "世界渲染距离", hint: "超出距离的街区完全不绘制（含阴影）", type: "range", min: 150, max: 2000, step: 50, fmt: (v) => `${v} m` },
      { key: "fpsCap", label: "帧率上限", hint: "降低上限可显著减少发热与耗电", type: "select", options: [[0, "不限"], [30, "30 FPS"], [60, "60 FPS"], [120, "120 FPS"]] },
    ],
  },
  {
    group: "光影",
    items: [
      { key: "shadows", label: "实时阴影", hint: "关闭后省掉整趟阴影渲染", type: "toggle" },
      { key: "shadowMapSize", label: "阴影精度", type: "select", options: [[512, "512"], [1024, "1K"], [2048, "2K"], [4096, "4K"]] },
      { key: "shadowDistance", label: "阴影覆盖范围", hint: "范围越小，同分辨率下阴影越清晰", type: "range", min: 40, max: 200, step: 5, fmt: (v) => `${v} m` },
      { key: "bloom", label: "泛光 Bloom", hint: "霓虹夜景辉光；关闭可省掉整套后处理", type: "toggle" },
    ],
  },
  {
    group: "人群与车流",
    items: [
      { key: "pedestrians", label: "行人数量", type: "range", min: 0, max: 320, step: 10 },
      { key: "pedestrianDistance", label: "行人显示距离", type: "range", min: 30, max: 400, step: 10, fmt: (v) => `${v} m` },
      { key: "traffic", label: "车流数量", type: "range", min: 0, max: 60, step: 2 },
      { key: "trafficDistance", label: "车辆显示距离", type: "range", min: 60, max: 800, step: 20, fmt: (v) => `${v} m` },
    ],
  },
  {
    group: "广告大屏",
    items: [
      { key: "billboardRadius", label: "屏幕激活半径", hint: "超出半径的屏完全定格（不轮播不重绘）；调大让更远的屏恢复更新，也加大解码竞争", type: "range", min: 50, max: 1200, step: 10, fmt: (v) => `${v} m` },
      { key: "videoDecode", label: "视频解码并发", hint: "半径内同时解码的视频内容池上限；0 = 全部暂停，调大更流畅但更耗 CPU / 带宽（直播流尤其）", type: "range", min: 0, max: 8, step: 1, fmt: (v) => (v === 0 ? "全部暂停" : `${v} 路`) },
    ],
  },
  {
    group: "界面",
    items: [
      { key: "hudFps", label: "HUD 刷新率", hint: "小地图 / 仪表 / 时钟的重绘频率", type: "range", min: 5, max: 30, step: 1, fmt: (v) => `${v} Hz` },
    ],
  },
];

export class RenderSettingsPanel {
  constructor() {
    this.root = document.getElementById("render-settings");
    this.listEl = document.getElementById("rs-list");
    this.statsEl = document.getElementById("rs-stats");
    this._controls = [];
    this._presetBtns = new Map();
    this._statsTimer = null;

    this._build();
    document.getElementById("rs-close").addEventListener("click", () => this.close());
    document.getElementById("rs-reset").addEventListener("click", () => resetRenderSettings());
    this.root.addEventListener("click", (e) => {
      if (e.target === this.root) this.close();
    });
    this._unsub = onRenderSettingsChange(() => this.sync());
    this.sync();
  }

  _build() {
    // 档位
    const seg = document.createElement("div");
    seg.className = "rs-presets";
    for (const name of PRESET_ORDER) {
      const p = PRESETS[name];
      const btn = document.createElement("button");
      btn.className = "rs-preset";
      btn.dataset.preset = name;
      btn.innerHTML = `<b>${p.label}</b><small>${p.hint}</small>`;
      btn.addEventListener("click", () => applyPreset(name));
      this._presetBtns.set(name, btn);
      seg.appendChild(btn);
    }
    this.listEl.appendChild(seg);

    for (const sec of SCHEMA) {
      const h = document.createElement("h5");
      h.className = "rs-sec";
      h.textContent = sec.group;
      this.listEl.appendChild(h);
      for (const item of sec.items) {
        this.listEl.appendChild(this._buildRow(item));
      }
    }
  }

  _buildRow(item) {
    const row = document.createElement("label");
    row.className = "rs-row";

    const head = document.createElement("div");
    head.className = "rs-head";
    const name = document.createElement("span");
    name.className = "rs-name";
    name.textContent = item.label;
    head.appendChild(name);

    let ctl;
    if (item.type === "range") {
      const val = document.createElement("b");
      val.className = "rs-val";
      head.appendChild(val);
      ctl = document.createElement("input");
      ctl.type = "range";
      ctl.min = item.min;
      ctl.max = item.max;
      ctl.step = item.step;
      ctl.addEventListener("input", () => {
        updateRenderSettings({ [item.key]: Number(ctl.value) });
      });
      row.appendChild(head);
      row.appendChild(ctl);
      this._controls.push({ item, el: ctl, val });
    } else if (item.type === "toggle") {
      ctl = document.createElement("button");
      ctl.type = "button";
      ctl.className = "rs-toggle";
      ctl.addEventListener("click", () => {
        const cur = getRenderSettings()[item.key];
        updateRenderSettings({ [item.key]: !cur });
      });
      head.appendChild(ctl);
      row.appendChild(head);
      this._controls.push({ item, el: ctl });
    } else {
      ctl = document.createElement("select");
      ctl.className = "rs-select";
      for (const [v, label] of item.options) {
        const o = document.createElement("option");
        o.value = String(v);
        o.textContent = label;
        ctl.appendChild(o);
      }
      ctl.addEventListener("change", () => {
        updateRenderSettings({ [item.key]: Number(ctl.value) });
      });
      head.appendChild(ctl);
      row.appendChild(head);
      this._controls.push({ item, el: ctl });
    }

    if (item.hint) {
      const hint = document.createElement("small");
      hint.className = "rs-hint";
      hint.textContent = item.hint;
      row.appendChild(hint);
    }
    return row;
  }

  sync() {
    const s = getRenderSettings();
    for (const [name, btn] of this._presetBtns) btn.classList.toggle("active", s.preset === name);
    for (const { item, el, val } of this._controls) {
      const v = s[item.key];
      if (item.type === "range") {
        el.value = String(v);
        if (val) val.textContent = item.fmt ? item.fmt(v) : String(v);
      } else if (item.type === "toggle") {
        el.classList.toggle("on", !!v);
        el.textContent = v ? "开" : "关";
      } else {
        el.value = String(v);
      }
    }
  }

  _tickStats() {
    if (!this.statsEl) return;
    const g = window.__game;
    const parts = [];
    if (window.__fps) parts.push(`${window.__fps.toFixed(0)} FPS`);
    const fs = g && g.engine && g.engine.frameStats;
    if (fs) {
      parts.push(`${fs.calls} draw call`);
      parts.push(`${(fs.triangles / 1000).toFixed(0)}K 三角面`);
    }
    if (g && g.city && g.city.chunks) parts.push(`分块 ${g.city.visibleChunks}/${g.city.chunks.length}`);
    this.statsEl.textContent = parts.join(" · ") || "—";
  }

  open() {
    this.root.classList.remove("hidden");
    this.sync();
    this._tickStats();
    if (!this._statsTimer) this._statsTimer = setInterval(() => this._tickStats(), 500);
  }

  close() {
    this.root.classList.add("hidden");
    if (this._statsTimer) {
      clearInterval(this._statsTimer);
      this._statsTimer = null;
    }
  }
}
