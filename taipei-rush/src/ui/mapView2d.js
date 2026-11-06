// 2D 地图视图渲染：从 ui/mapEditor.js 抽出的画布绘制逻辑，
// 供地图编辑器（可编辑）与游戏内大地图（只读预览）共用同一套 2D 显示，
// 保证大地图上看到的就是地图编辑器里画的那张图。
import { asphaltHalf, EXT_STEP_X, EXT_STEP_Z, extRoadSpec } from "../data/cityData.js";
import { areaPoly, clipAxisLine, worldBounds, polyCenterLine } from "../world/customMap.js";

export const LM_ZH = {
  tower: "摩天楼", taipei101: "台北101", temple: "庙宇", redhouse: "红楼",
  cks: "纪念堂", station: "车站", mrt: "捷运站", gate: "城门",
};

// 世界实际路网 = 用户路 + 边缘自动延伸路（与 city.js _buildRoads 同规则）。
// ext 标记的路仅用于预览，不属于地图数据；extRoads 未勾选时不生成。
// 边界 = 路网 ∪ 描边内容 ∪ 地图范围（customMap.worldBounds）——延伸街铺满整张网格地图
export function editorGrid(map) {
  const b = worldBounds(map);
  const xs = [...map.roadsX].sort((a, b2) => a.at - b2.at);
  const zs = [...map.roadsZ].sort((a, b2) => a.at - b2.at);
  if (map.extRoads && xs.length && zs.length) {
    let n = 0;
    const ext = (at, step) => ({ id: "ext" + (n++), at, ...extRoadSpec(at, step), _ext: true });
    while (xs[xs.length - 1].at < b.maxX) xs.push(ext(xs[xs.length - 1].at + EXT_STEP_X, EXT_STEP_X));
    while (xs[0].at > b.minX) xs.unshift(ext(xs[0].at - EXT_STEP_X, EXT_STEP_X));
    while (zs[zs.length - 1].at < b.maxZ) zs.push(ext(zs[zs.length - 1].at + EXT_STEP_Z, EXT_STEP_Z));
    while (zs[0].at > b.minZ) zs.unshift(ext(zs[0].at - EXT_STEP_Z, EXT_STEP_Z));
  }
  return { xs, zs, bounds: b };
}

// 完整 2D 地图绘制：背景网格 → 城区 → 街廓/道路 → 3D 描边内容 → 图例/罗盘 → 地标/出生点。
// ctx/W/H：画布上下文与尺寸；cam：{ x, z, scale }（世界中心 + 米→像素）。
// opts.selected：编辑器当前选中项（只读预览不传，无高亮、不可点）；
// opts.grid：预计算的 editorGrid 结果（30Hz 重绘的大地图传入，避免每帧重算）；
// opts.showLegend/showCompass：编辑器专属 UI，大地图等只读预览关闭；
// opts.hideLabels：隐藏文字标注（路名/城区/地标名/出生点），小地图等小视野预览使用。
// 整体旋转由调用方自行 rotate ctx：本函数按画布对角线超绘背景/网格/道路，任意角度不露边。
export function drawMap2d(ctx, W, H, map, cam, opts = {}) {
  const sel = opts.selected || null;
  const s = cam.scale;
  const w2sX = (x) => (x - cam.x) * s + W / 2;
  const w2sY = (z) => (z - cam.z) * s + H / 2;
  const s2w = (px, py) => ({ x: (px - W / 2) / s + cam.x, z: (py - H / 2) / s + cam.z });
  const ext = Math.hypot(W, H) / 2; // 超绘半径：旋转后画布四角仍被覆盖
  const cx0 = W / 2, cz0 = H / 2;

  ctx.fillStyle = "#0b1014";
  ctx.fillRect(cx0 - ext, cz0 - ext, ext * 2, ext * 2);

  // background grid (100 m)
  ctx.strokeStyle = "rgba(255,255,255,0.045)";
  ctx.lineWidth = 1;
  const g = 100;
  const corner = s2w(cx0 - ext, cz0 - ext);
  const wx0 = Math.floor(corner.x / g) * g, wz0 = Math.floor(corner.z / g) * g;
  for (let x = wx0; w2sX(x) < cx0 + ext; x += g) { ctx.beginPath(); ctx.moveTo(w2sX(x), cz0 - ext); ctx.lineTo(w2sX(x), cz0 + ext); ctx.stroke(); }
  for (let z = wz0; w2sY(z) < cz0 + ext; z += g) { ctx.beginPath(); ctx.moveTo(cx0 - ext, w2sY(z)); ctx.lineTo(cx0 + ext, w2sY(z)); ctx.stroke(); }

  const grid = opts.grid || editorGrid(map);
  const xs = grid.xs, zs = grid.zs;

  // 道路/街区只显示在地图范围（网格地图）内，超出范围不渲染；无范围时不裁剪
  const areaPts = areaPoly(map);
  const inArea = (fn) => {
    if (!areaPts) { fn(); return; }
    const p = new Path2D();
    areaPts.forEach(([x, z], i) => (i ? p.lineTo(w2sX(x), w2sY(z)) : p.moveTo(w2sX(x), w2sY(z))));
    p.closePath();
    ctx.save();
    ctx.clip(p);
    fn();
    ctx.restore();
  };

  // districts (read-only outline)
  ctx.save();
  for (const d of map.districts) {
    const x0 = w2sX(d.minX), z0 = w2sY(d.minZ);
    const w = (d.maxX - d.minX) * s, h = (d.maxZ - d.minZ) * s;
    ctx.strokeStyle = "rgba(120,160,220,0.22)";
    ctx.setLineDash([6, 5]);
    ctx.strokeRect(x0, z0, w, h);
    ctx.setLineDash([]);
    if (s > 0.14 && !opts.hideLabels) {
      ctx.fillStyle = "rgba(150,180,225,0.4)";
      ctx.font = "600 11px Rajdhani, sans-serif";
      ctx.fillText(d.zh, x0 + 6, z0 + 14);
    }
  }
  ctx.restore();

  inArea(() => {
    // blocks derived between roads (含延伸区的程序化街廓)
    for (let i = 0; i < xs.length - 1; i++) {
      for (let j = 0; j < zs.length - 1; j++) {
        const px0 = xs[i].at + asphaltHalf(xs[i]), px1 = xs[i + 1].at - asphaltHalf(xs[i + 1]);
        const pz0 = zs[j].at + asphaltHalf(zs[j]), pz1 = zs[j + 1].at - asphaltHalf(zs[j + 1]);
        if (px1 - px0 < 12 || pz1 - pz0 < 12) continue;
        const extBlock = xs[i]._ext || xs[i + 1]._ext || zs[j]._ext || zs[j + 1]._ext;
        ctx.fillStyle = extBlock ? "#10151c" : "#161d26";
        ctx.fillRect(w2sX(px0), w2sY(pz0), (px1 - px0) * s, (pz1 - pz0) * s);
      }
    }

    // roads：用户编辑的路（亮色 + 路名）与自动延伸路（暗色）
    for (const r of xs) {
      const selHl = sel && sel.obj === r;
      const isExt = r._ext;
      ctx.strokeStyle = selHl ? "#f2c14e" : isExt ? "#232c37" : "#3d4a58";
      ctx.lineWidth = Math.max(isExt ? 1.5 : 2, asphaltHalf(r) * 2 * s);
      ctx.beginPath(); ctx.moveTo(w2sX(r.at), cz0 - ext); ctx.lineTo(w2sX(r.at), cz0 + ext); ctx.stroke();
      if (!isExt && s > 0.18) {
        ctx.strokeStyle = "rgba(255,255,255,0.28)";
        ctx.lineWidth = 1;
        ctx.setLineDash([8, 10]);
        ctx.beginPath(); ctx.moveTo(w2sX(r.at), cz0 - ext); ctx.lineTo(w2sX(r.at), cz0 + ext); ctx.stroke();
        ctx.setLineDash([]);
        const segs = areaPts ? clipAxisLine(areaPts, r.at, false) : null;
        if (!opts.hideLabels && (!areaPts || segs.length)) {
          ctx.fillStyle = "rgba(244,242,238,0.65)";
          ctx.font = "500 10px sans-serif";
          ctx.fillText(r.zh || r.id, w2sX(r.at) + 4, segs ? w2sY(segs[0][0]) + 12 : 14);
        }
      }
    }
    for (const r of zs) {
      const selHl = sel && sel.obj === r;
      const isExt = r._ext;
      ctx.strokeStyle = selHl ? "#f2c14e" : isExt ? "#232c37" : "#3d4a58";
      ctx.lineWidth = Math.max(isExt ? 1.5 : 2, asphaltHalf(r) * 2 * s);
      ctx.beginPath(); ctx.moveTo(cx0 - ext, w2sY(r.at)); ctx.lineTo(cx0 + ext, w2sY(r.at)); ctx.stroke();
      if (!isExt && s > 0.18) {
        ctx.strokeStyle = "rgba(255,255,255,0.28)";
        ctx.lineWidth = 1;
        ctx.setLineDash([8, 10]);
        ctx.beginPath(); ctx.moveTo(cx0 - ext, w2sY(r.at)); ctx.lineTo(cx0 + ext, w2sY(r.at)); ctx.stroke();
        ctx.setLineDash([]);
        const segs = areaPts ? clipAxisLine(areaPts, r.at, true) : null;
        if (!opts.hideLabels && (!areaPts || segs.length)) {
          ctx.fillStyle = "rgba(244,242,238,0.65)";
          ctx.font = "500 10px sans-serif";
          ctx.fillText(r.zh || r.id, segs ? w2sX(segs[0][0]) + 6 : 6, w2sY(r.at) - 4);
        }
      }
    }
  });

  // 3D 描边内容叠加（3D 编辑器管理的数据）：范围、河流、描边道路、建筑、树木
  const f = map.features;
  if (f) {
    if (map.area && map.area.pts) {
      ctx.strokeStyle = "#f2c14e";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([7, 5]);
      ctx.beginPath();
      map.area.pts.forEach(([x, z], i) => (i ? ctx.lineTo(w2sX(x), w2sY(z)) : ctx.moveTo(w2sX(x), w2sY(z))));
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#2e6f9f";
    for (const r of f.rivers || []) {
      ctx.lineWidth = Math.max(2, (r.width || 26) * s);
      ctx.beginPath();
      r.points.forEach(([x, z], i) => (i ? ctx.lineTo(w2sX(x), w2sY(z)) : ctx.moveTo(w2sX(x), w2sY(z))));
      ctx.stroke();
    }
    for (const r of f.roads || []) {
      const selHl = sel && sel.kind === "troad" && sel.obj === r;
      if (r.closed && r.points.length >= 3) {
        // 取面道路：2D 视图按填充多边形显示，选中时描金边
        ctx.fillStyle = selHl ? "rgba(242,193,78,0.28)" : "#2c3947";
        ctx.beginPath();
        r.points.forEach(([x, z], i) => (i ? ctx.lineTo(w2sX(x), w2sY(z)) : ctx.moveTo(w2sX(x), w2sY(z))));
        ctx.closePath();
        ctx.fill();
        if (selHl) {
          ctx.strokeStyle = "#f2c14e";
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        // 中心虚线：最小外接矩形长轴中线（直路取面 = 一条精确居中虚线）
        if (s > 0.18) {
          const cl = polyCenterLine(r.points, 80);
          if (cl) {
            ctx.strokeStyle = "rgba(255,255,255,0.28)";
            ctx.lineWidth = 1;
            ctx.setLineDash([8, 10]);
            ctx.beginPath();
            ctx.moveTo(w2sX(cl[0][0]), w2sY(cl[0][1]));
            ctx.lineTo(w2sX(cl[1][0]), w2sY(cl[1][1]));
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }
        continue;
      }
      ctx.strokeStyle = selHl ? "#f2c14e" : "#9aa8b8";
      ctx.lineWidth = Math.max(2, (r.width || 12) * s);
      ctx.beginPath();
      r.points.forEach(([x, z], i) => (i ? ctx.lineTo(w2sX(x), w2sY(z)) : ctx.moveTo(w2sX(x), w2sY(z))));
      ctx.stroke();
      // 中心虚线（与程序化道路同款，仅显示不参与编辑）
      if (s > 0.18) {
        ctx.strokeStyle = "rgba(255,255,255,0.28)";
        ctx.lineWidth = 1;
        ctx.setLineDash([8, 10]);
        ctx.beginPath();
        r.points.forEach(([x, z], i) => (i ? ctx.lineTo(w2sX(x), w2sY(z)) : ctx.moveTo(w2sX(x), w2sY(z))));
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // 拼接式路块（3D 编辑器放置）：旋转矩形示意（编辑在 3D 编辑器完成）
    ctx.fillStyle = "#56606e";
    for (const t of f.roadTiles || []) {
      ctx.save();
      ctx.translate(w2sX(t.x), w2sY(t.z));
      ctx.rotate(-(t.rot || 0)); // 世界 rotation.y → 屏幕 y 向下坐标系取反
      // 极小比例（小地图等）下按最小可视尺寸画成点状标记，避免路块完全消失
      const tw = Math.max(1.5, (t.w || 2) * s), tl = Math.max(1.5, (t.len || 3) * s);
      ctx.fillRect(-tw / 2, -tl / 2, tw, tl);
      if (s > 0.5) {
        ctx.strokeStyle = "rgba(255,255,255,0.22)";
        ctx.lineWidth = 1;
        ctx.strokeRect(-tw / 2, -tl / 2, tw, tl);
      }
      ctx.restore();
    }
    ctx.fillStyle = "#2c3947";
    ctx.strokeStyle = "#4b5b6e";
    ctx.lineWidth = 1;
    for (const b of map.objects || []) {
      if (b.type !== "building") continue;
      const fp = (b.params && b.params.footprint) || [];
      if (fp.length < 3) continue;
      const c0 = Math.cos(b.rot || 0), s0 = Math.sin(b.rot || 0);
      ctx.beginPath();
      fp.forEach(([x, z], i) => {
        const px = b.pos[0] + x * c0 + z * s0;
        const pz = b.pos[1] + -x * s0 + z * c0;
        if (i) ctx.lineTo(w2sX(px), w2sY(pz)); else ctx.moveTo(w2sX(px), w2sY(pz));
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.fillStyle = "#4d8a5c";
    for (const o of map.objects || []) {
      if (o.type !== "tree") continue;
      ctx.beginPath();
      ctx.arc(w2sX(o.pos[0]), w2sY(o.pos[1]), Math.max(2, 2.2 * s), 0, 7);
      ctx.fill();
    }
  }

  // legend（编辑器专属说明，只读预览关闭）
  if (opts.showLegend !== false) {
    ctx.fillStyle = "rgba(244,242,238,0.42)";
    ctx.font = "500 11px sans-serif";
    ctx.fillText("淡色道路与暗色街区 = 延伸街道（勾选后自动铺满地图范围） · 金色虚线框 = 3D 描边范围 · 亮色折线 = 3D 描边道路/河流（可点选编辑）", 14, H - 14);
  }

  // 指北针：2D 画布方位固定（上 = 北/-Z，右 = 东/+X，与数据约定和 3D 罗盘一致）。
  // 只读预览（大地图）有自己的旋转罗盘，这里不画
  if (opts.showCompass !== false) {
    const nx = W - 34, ny = 42, nr = 15;
    ctx.save();
    ctx.beginPath(); ctx.arc(nx, ny, nr, 0, 7);
    ctx.fillStyle = "rgba(13,20,28,0.78)"; ctx.fill();
    ctx.strokeStyle = "rgba(244,242,238,0.45)"; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = "#ff7a70";
    ctx.beginPath(); ctx.moveTo(nx, ny - nr + 3); ctx.lineTo(nx - 4, ny + 2); ctx.lineTo(nx + 4, ny + 2); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "rgba(244,242,238,0.85)";
    ctx.beginPath(); ctx.moveTo(nx, ny + nr - 3); ctx.lineTo(nx - 4, ny + 2); ctx.lineTo(nx + 4, ny + 2); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "rgba(244,242,238,0.85)"; ctx.font = "700 8px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("N", nx, ny - nr - 3);
    ctx.restore();
  }

  // landmarks
  for (const l of map.landmarks) {
    const selHl = sel && sel.obj === l;
    const x = w2sX(l.x), y = w2sY(l.z);
    ctx.beginPath();
    ctx.arc(x, y, selHl ? 9 : 6, 0, 7);
    ctx.fillStyle = selHl ? "#f2c14e" : l.type === "taipei101" ? "#ff6b6b" : "#c46bd6";
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (s > 0.18 && !opts.hideLabels) {
      ctx.fillStyle = "rgba(244,242,238,0.75)";
      ctx.font = "500 10px sans-serif";
      ctx.fillText(LM_ZH[l.type] || l.type, x + 8, y - 6);
    }
  }

  // spawn point
  const sp = map.spawn;
  if (sp) {
    const selHl = sel && sel.obj === sp;
    const x = w2sX(sp.x), y = w2sY(sp.z);
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.moveTo(0, -12); ctx.lineTo(9, 8); ctx.lineTo(0, 3); ctx.lineTo(-9, 8);
    ctx.closePath();
    ctx.fillStyle = selHl ? "#f2c14e" : "#4ade80";
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
    if (!opts.hideLabels) {
      ctx.fillStyle = "rgba(74,222,128,0.85)";
      ctx.font = "600 10px sans-serif";
      ctx.fillText("出生点", x + 10, y + 12);
    }
  }
}
