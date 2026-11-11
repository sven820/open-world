// 程序化城市的街道小件布置：路灯 / 行道树 / 花坛 / 绿篱 / 灌木 / 庭院灯，
// 以及描边路走廊避让判定。函数以 city 实例为第一参数（City 类做薄委托）。

import { pointInPoly } from "./customMap.js";

function rand(a, b) { return a + Math.random() * (b - a); }

// 点是否落在描边路走廊内（路面 + 人行道 + 1.5m 余量）。
// 建筑有 _rectHitsCorridor 避让，但沿街小件（路灯 / 行道树 / 花坛）此前没有 ——
// 会正好杵在手绘道路和路口斑马线上
export function inTraceCorridor(city, x, z) {
  for (const c of city.traceCorridors) {
    for (const p of c.samples) {
      const dx = x - p.x, dz = z - p.z;
      if (dx * dx + dz * dz <= c.keepHalf * c.keepHalf) return true;
    }
    if (c.closed && pointInPoly(x, z, c.pts)) return true;
  }
  return false;
}

// 街区四缘的街道家具：沿人行道带布路灯与行道树，店门口摆花坛。
// 密度由地图编辑器的 路灯/绿植 倍率控制；描边路走廊内一律不放。
export function streetProps(city, px0, px1, pz0, pz1, rx0, rx1, rz0, rz1, bx0, bx1, bz0, bz1) {
  // 路灯 / 绿植密度倍率（地图编辑器可调）
  const ld = city.gen.lampDensity, gd = city.gen.greenDensity;
  // lamps & trees along the four platform edges
  const sides = [
    { axis: "x", at: pz0 + 0.9, a: px0 + 4, b: px1 - 4, rot: 0 },
    { axis: "x", at: pz1 - 0.9, a: px0 + 4, b: px1 - 4, rot: Math.PI },
    { axis: "z", at: px0 + 0.9, a: pz0 + 4, b: pz1 - 4, rot: Math.PI / 2 },
    { axis: "z", at: px1 - 0.9, a: pz0 + 4, b: pz1 - 4, rot: -Math.PI / 2 },
  ];
  for (const s of sides) {
    const len = s.b - s.a;
    if (len < 8) continue;
    // 路灯：默认每 30m 一盏，路灯密度倍率越高间距越短；描边路走廊内不放
    if (ld > 0) {
      const nl = Math.max(1, Math.floor((len * ld) / 30));
      for (let k = 0; k < nl; k++) {
        const t = s.a + (len * (k + 0.5)) / nl;
        if (s.axis === "x") {
          if (!inTraceCorridor(city, t, s.at)) city._addLamp(t, s.at, s.rot);
        } else {
          if (!inTraceCorridor(city, s.at, t)) city._addLamp(s.at, t, s.rot);
        }
      }
    }
    // 行道树：默认每 24m 一棵，数量与出现概率都随绿植密度缩放；描边路走廊内不放
    if (gd > 0 && Math.random() < Math.min(1, 0.75 * gd)) {
      const nt = Math.max(1, Math.floor((len * gd) / 24));
      for (let k = 0; k < nt; k++) {
        const t = s.a + (len * (k + 0.5)) / nt;
        if (s.axis === "x") {
          const tz = s.at + (s.rot === 0 ? 1.4 : -1.4);
          if (!inTraceCorridor(city, t, tz)) city._addTree(t, tz, 1);
        } else {
          const tx = s.at + (s.rot > 0 ? 1.4 : -1.4);
          if (!inTraceCorridor(city, tx, t)) city._addTree(tx, t, 1);
        }
      }
    }
  }

  // 店门口的绿植：沿建筑立面随机摆花坛（间隔、放不放都随机）；描边路走廊内不放
  if (gd <= 0) return;
  const fronts = [
    { horiz: true, at: bz0 - 0.75, a: bx0 + 2.5, b: bx1 - 2.5 },
    { horiz: true, at: bz1 + 0.75, a: bx0 + 2.5, b: bx1 - 2.5 },
    { horiz: false, at: bx0 - 0.75, a: bz0 + 2.5, b: bz1 - 2.5 },
    { horiz: false, at: bx1 + 0.75, a: bz0 + 2.5, b: bz1 - 2.5 },
  ];
  for (const f of fronts) {
    if (f.b - f.a < 8) continue;
    const step = rand(8, 15) / Math.max(0.25, gd);
    for (let t = f.a + 2; t < f.b - 2; t += step) {
      if (Math.random() > Math.min(1, 0.34 * gd)) continue;
      if (f.horiz) {
        if (!inTraceCorridor(city, t, f.at)) city._addPlanter(t, f.at);
      } else {
        if (!inTraceCorridor(city, f.at, t)) city._addPlanter(f.at, t);
      }
    }
  }
}

// 街廓内空地（楼间缝、巷口、中庭边缘）随机点缀绿植与庭院灯。
// 只在没有建筑的位置生成，密度很低，避免挤占通行空间。
export function decorateOpenSpace(city, x0, x1, z0, z1) {
  const gd = city.gen.greenDensity, ld = city.gen.lampDensity;
  if (gd <= 0 && ld <= 0) return;
  // 采样密度按较大的那个倍率走；类别按 绿植 / 路灯 各自权重抽取
  const gate = Math.min(0.9, 0.22 * Math.max(gd, ld));
  const total = 0.95 * gd + 0.05 * ld;
  const step = 10;
  for (let gx = x0 + 3; gx < x1 - 3; gx += step) {
    for (let gz = z0 + 3; gz < z1 - 3; gz += step) {
      if (Math.random() > gate) continue;
      const px = gx + rand(-3.2, 3.2), pz = gz + rand(-3.2, 3.2);
      if (px < x0 + 1.2 || px > x1 - 1.2 || pz < z0 + 1.2 || pz > z1 - 1.2) continue;
      // 留出 0.85m 余量：太小的地方是两栋楼贴太近，不放东西
      if (city.colliders.blocked(px, pz, 0.85)) continue;
      const r = Math.random() * total;
      if (r < 0.42 * gd) city._addHedge(px, pz);
      else if (r < 0.72 * gd) city._addPlanter(px, pz);
      else if (r < 0.86 * gd) city._addBush(px, pz);
      else if (r < 0.95 * gd) {
        // 树冠宽，需要更大的净空
        if (!city.colliders.blocked(px, pz, 1.7)) city._addTree(px, pz, rand(0.55, 0.8));
        else city._addPlanter(px, pz);
      } else city._addYardLamp(px, pz);
    }
  }
}
