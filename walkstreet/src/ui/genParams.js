// 程序化城市生成参数的勾选 + 滑杆（2D / 3D 地图编辑器共用）。
// 字段直接存在地图对象上：
//   procedural   是否自动生成程序化城市（勾选后才生成街区建筑 / 绿植 / 路灯）
//   gapScale     楼间距倍率（1 = 默认，相邻建筑的缝约 2~4m）
//   greenDensity 绿植密度倍率（0 = 不种）
//   lampDensity  路灯密度倍率（0 = 不装）
import { genConfig } from "../data/cityData.js";

const ROWS = [
  { key: "gapScale", label: "楼间距", min: 0.4, max: 2.2, step: 0.1 },
  { key: "greenDensity", label: "绿植密度", min: 0, max: 2.5, step: 0.1 },
  { key: "lampDensity", label: "路灯密度", min: 0, max: 2.5, step: 0.1 },
];

const fmt = (v) => `${v.toFixed(1)}×`;
const pct = (r, v) => Math.round(((v - r.min) / (r.max - r.min)) * 100);

// 生成开关 + 滑杆的 HTML（不含标题，由调用方决定放在哪个分区）
export function genParamsHtml(map, prefix) {
  const cfg = genConfig(map);
  const off = !cfg.procedural;
  const toggle = `<label class="me-check me-tiprow" data-tip="勾选后才会自动生成程序化城市（街区建筑、绿植、路灯、街边停车）；不勾选则只保留手工路网与 3D 编辑器里的描边内容。"><input id="${prefix}-procedural" type="checkbox" ${cfg.procedural ? "checked" : ""} /> 自动生成程序化城市</label>`;
  return toggle + ROWS.map((r) => {
    const v = cfg[r.key];
    return `<div class="me-slider">
          <div class="me-slider-head"><span>${r.label}</span><b id="${prefix}-${r.key}-val">${fmt(v)}</b></div>
          <input id="${prefix}-${r.key}-range" type="range" min="${r.min}" max="${r.max}" step="${r.step}" value="${v}"${off ? " disabled" : ""} style="--fill: ${pct(r, v)}%" />
        </div>`;
  }).join("");
}

// 绑定事件：勾选 / 拖动即写回 map（保存时随地图落库），onChange 用于标脏/重绘
export function bindGenParams(root, map, prefix, onChange) {
  if (!root) return;
  const toggle = root.querySelector(`#${prefix}-procedural`);
  const sliders = ROWS.map((r) => root.querySelector(`#${prefix}-${r.key}-range`)).filter(Boolean);
  const syncSliderState = () => {
    const on = genConfig(map).procedural; // 未写字段时按默认值（默认街区开启、用户地图显式关闭）
    for (const input of sliders) input.disabled = !on;
  };
  if (toggle) {
    toggle.addEventListener("change", () => {
      map.procedural = !!toggle.checked;
      syncSliderState();
      if (onChange) onChange("procedural", map.procedural);
    });
    syncSliderState();
  }
  for (const r of ROWS) {
    const input = root.querySelector(`#${prefix}-${r.key}-range`);
    if (!input) continue;
    const valEl = root.querySelector(`#${prefix}-${r.key}-val`);
    input.addEventListener("input", () => {
      const v = Math.min(r.max, Math.max(r.min, +input.value));
      map[r.key] = v;
      if (valEl) valEl.textContent = fmt(v);
      input.style.setProperty("--fill", `${pct(r, v)}%`);
      if (onChange) onChange(r.key, v);
    });
  }
}
