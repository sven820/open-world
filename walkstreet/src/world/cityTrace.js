// 描边路（编辑器手绘折线）× 程序化横纵路的路口逻辑：
// 路口求交（供斑马线 / 红绿灯灯位 / customMap 断口使用）+ 路口斑马线铺条。
// 函数均以 city 实例为第一参数（City 类做薄委托，保持调用面不变）。

import * as THREE from "three";
import { asphaltHalf } from "../data/cityData.js";
import {
  polyClipX, polyClipZ, polyDirNear, polyEdgeRange,
  lineHitT, polySpanOnLine, lineRoadSpanOnLine,
} from "./roadGeometry.js";

// 路口斑马线规格（描边路口与程序化路口一致）：条宽 / 间距（条+净空）/ 条长（行人带深）/ 路边外扩
export const CW_BAR = 0.52, CW_PITCH = CW_BAR + 0.5, CW_DEPTH = 3.4, CW_GAP = 0.2;

// 描边路（编辑器手绘折线）× 程序化横纵路：求交点。
// 结果同时供三处使用：路口斑马线、红绿灯灯位、customMap 里在路口断开人行道/标线。
export function computeTraceJunctions(city) {
  const out = [];
  const MIN_CROSS = 0.42;   // 交角过小（<25°）不当作路口，否则斑马线会被拉成一条长条
  const xs = city.roadsX || [], zs = city.roadsZ || [];
  const corridors = city.traceCorridors;

  // 一个路口 = 主路（方向 u，半宽 roadHalf）被另一条路（方向 v，半宽 progHalf）穿过。
  // 两张斑马线、四根灯杆、两条路的断口长度全都从这几个量推出来。
  const stats = { corridors: corridors.length, closedHandled: 0, candidates: 0, skippedAngle: 0, skippedKnown: 0, kept: 0 };
  const push = (o) => {
    const s = Math.abs(o.ux * o.vz - o.uz * o.vx);   // |sin 交角|
    if (s < MIN_CROSS) { stats.skippedAngle++; return; }
    stats.candidates++;
    o.mx = -o.vz; o.mz = o.vx;                       // 被穿路法线
    // 面路两侧边界不对称时（手绘变宽）按最宽一侧推 Effective 半宽：
    // 断口长度随之撑大，否则变宽处的主路断口盖不住斑马线带
    o.effHalf = Math.max(o.roadHalf, -(o.edgeNeg || 0), o.edgePos || 0);
    const tB = (o.effHalf + 2.2) / s;
    const spanB = Math.max(0, o.progHalf * 2 - 1.0);
    // 主路断口：盖住被穿路开口，以及横跨它的那组斑马线在主路方向上的铺开量。
    // A 组条始终落在车行道宽度内（不与人行道重叠），不需要额外计入。
    o.alongHalf = Math.max(
      o.progHalf / s + 1.5,
      tB * Math.abs(o.vx * o.ux + o.vz * o.uz) + (spanB / 2) * s + 1.5,
    );
    if (o.viaRoadIndex != null) {
      // 被穿的那条也是描边路：对称算它自己的断口与弧长
      const tA2 = (o.progHalf + 2.2) / s;
      o.viaAlongHalf = Math.max(
        o.progHalf / s + 1.5,
        tA2 * Math.abs(o.ux * o.vx + o.uz * o.vz) + (spanB / 2) * s + 1.5,
      );
    }
    out.push(o);
  };

  // 取面路（多边形填充）× 程序化横纵路：多边形没有中线，用最长边当车流方向，
  // 路口宽度取"多边形在与横路中心线相交处被切出的区段长度"。
  for (const c of corridors) {
    if (!c.closed) continue;
    const poly = c.pts;
    if (!poly || poly.length < 3) continue;
    stats.closedHandled++;
    // 横路沿 X 延伸（z = at）：取多边形在 z = at 上的内部 x 区段
    for (const road of zs) {
      for (const [x0, x1] of polyClipX(poly, road.at)) {
        const dir = polyDirNear(poly, road.at, true);
        // 切出来的是沿 X 的投影长度；斜路要乘方向分量才是垂直中线的真实路宽，
        // 否则斜得越厉害斑马线跨度越大（长边被拉成一条大斜带）。
        const w = (x1 - x0) * Math.abs(dir.uz);
        if (w < 6 || w > 160) continue;
        const progHalf = asphaltHalf(road);
        // 路口范围内两侧的实测边界：手绘面路宽度沿线会变（喇叭口 / 剪切形），
        // 只量中心线一条截线，B 组斑马线会压进变宽的路面、断口也盖不住路口
        const edges = polyEdgeRange(poly, (x0 + x1) / 2, road.at, dir, progHalf + 2.5, true);
        push({
          x: (x0 + x1) / 2, z: road.at, ux: dir.ux, uz: dir.uz,
          roadHalf: w / 2, progHalf,
          vx: 1, vz: 0, s: 0, roadIndex: c.index, poly,
          ...(edges || {}),
        });
      }
    }
    // 横路沿 Z 延伸（x = at）
    for (const road of xs) {
      for (const [z0, z1] of polyClipZ(poly, road.at)) {
        const dir = polyDirNear(poly, road.at, false);
        const w = (z1 - z0) * Math.abs(dir.ux);
        if (w < 6 || w > 160) continue;
        const progHalf = asphaltHalf(road);
        const edges = polyEdgeRange(poly, road.at, (z0 + z1) / 2, dir, progHalf + 2.5, false);
        push({
          x: road.at, z: (z0 + z1) / 2, ux: dir.ux, uz: dir.uz,
          roadHalf: w / 2, progHalf,
          vx: 0, vz: 1, s: 0, roadIndex: c.index, poly,
          ...(edges || {}),
        });
      }
    }
  }

  // 线形描边路 × 程序化横纵路
  for (const c of corridors) {
    if (c.closed) continue;
    let acc = 0;
    for (const seg of c.segs) {
      const dx = seg.bx - seg.ax, dz = seg.bz - seg.az;
      const len = Math.hypot(dx, dz);
      if (len < 1e-3) continue;
      const ux = dx / len, uz = dz / len;
      // 横路沿 X 延伸（v = (1,0)，z = at）
      if (Math.abs(dz) > 1e-6) {
        for (const road of zs) {
          const t = (road.at - seg.az) / dz;
          if (t < 0 || t > 1) continue;
          push({
            x: seg.ax + dx * t, z: road.at, ux, uz,
            roadHalf: c.roadHalf, progHalf: asphaltHalf(road),
            vx: 1, vz: 0, s: acc + t * len, roadIndex: c.index,
          });
        }
      }
      // 横路沿 Z 延伸（v = (0,1)，x = at）
      if (Math.abs(dx) > 1e-6) {
        for (const road of xs) {
          const t = (road.at - seg.ax) / dx;
          if (t < 0 || t > 1) continue;
          push({
            x: road.at, z: seg.az + dz * t, ux, uz,
            roadHalf: c.roadHalf, progHalf: asphaltHalf(road),
            vx: 0, vz: 1, s: acc + t * len, roadIndex: c.index,
          });
        }
      }
      acc += len;
    }
  }

  // 描边路 × 描边路：两张手绘路互相穿过时同样要成路口
  for (let i = 0; i < corridors.length; i++) {
    const A = corridors[i];
    if (A.closed) continue;
    for (let k = i + 1; k < corridors.length; k++) {
      const B = corridors[k];
      if (B.closed) continue;
      let saccA = 0;
      for (const sa of A.segs) {
        const rax = sa.bx - sa.ax, raz = sa.bz - sa.az;
        const alen = Math.hypot(rax, raz);
        if (alen < 1e-3) continue;
        let saccB = 0;
        for (const sb of B.segs) {
          const sbx = sb.bx - sb.ax, sbz = sb.bz - sb.az;
          const blen = Math.hypot(sbx, sbz);
          if (blen < 1e-3) { saccB += blen; continue; }
          const den = rax * sbz - raz * sbx;
          if (Math.abs(den) > 1e-6) {
            const qx = sb.ax - sa.ax, qz = sb.az - sa.az;
            const t = (qx * sbz - qz * sbx) / den;
            const u = (qx * raz - qz * rax) / den;
            if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
              push({
                x: sa.ax + rax * t, z: sa.az + raz * t,
                ux: rax / alen, uz: raz / alen,
                roadHalf: A.roadHalf, progHalf: B.roadHalf,
                vx: sbx / blen, vz: sbz / blen,
                s: saccA + t * alen, roadIndex: A.index,
                viaRoadIndex: B.index, viaS: saccB + u * blen,
              });
            }
          }
          saccB += blen;
        }
        saccA += alen;
      }
    }
  }

  // 去重：相邻线段在共享端点处会各产生一次交点
  const dedup = [];
  for (const j of out) {
    if (dedup.some((k) => Math.abs(k.x - j.x) < 1.5 && Math.abs(k.z - j.z) < 1.5)) continue;
    // 正好落在程序化路口内部的跳过 —— 那里本来就有斑马线和信号灯
    if (city.intersections.some((it) =>
      Math.abs(j.x - it.x) < it.hx + 2.5 && Math.abs(j.z - it.z) < it.hz + 2.5)) { stats.skippedKnown++; continue; }
    dedup.push(j);
  }
  stats.kept = dedup.length;
  city._junctionStats = stats;   // 控制台可直接查看路口为什么没生成
  return dedup;
}

// 路口斑马线：四组 —— A 两组横跨主路（铺在被穿路两侧边线外 0.2m，条的长轴顺主路方向），
// B 两组横跨被穿路（铺在主路两侧边线外 0.2m，条的长轴顺被穿路方向）。
// 条宽与间距同程序化路口 _crosswalks（0.52 / 0.5 / 深 3.4）。四组条整条同高 0.2：
// 高于描边路面（0.18）与人行道平台（0.16），不被任何路面吃掉；也不按路面分段贴地 ——
// 同一根条纹骑在两种高度的交接线上，斜视角下高低两段投影错开（视差），带会在交接处割裂。
// 铺开范围一律按「斑马线所在直线与路边线的真实交点」实测：
// - 斜交路口的斑马线带顺被穿路方向拉长（跨度 = 路宽 / sin交角）。
//   旧版按垂直路宽铺开，斜交时条在带上挤作一团、两端各缺一角，盖不到马路两边。
// - 面路（手绘多边形）宽度沿线会变（喇叭口 / 剪切形），每条带各自用所在位置的实测截线，
//   主路两侧边线也各用实测边界（edgeNeg/edgePos），条才贴住路面外、不被变宽的路面盖住。
export function buildTraceCrosswalks(city) {
  for (const j of city.traceJunctions || []) {
    const ux = j.ux, uz = j.uz;                            // 主路方向
    const nx = -uz, nz = ux;                               // 主路法线
    const mx = j.mx, mz = j.mz;                            // 被穿路法线
    const vx = j.vx, vz = j.vz;                            // 被穿路方向
    const yB = 0.2;

    // A 组：带线过 j + m·(±(progHalf+GAP))、方向 v；铺开范围 = 主路在该带线上的真实区间
    for (const s of [-1, 1]) {
      const o = { x: j.x + mx * s * (j.progHalf + CW_GAP), z: j.z + mz * s * (j.progHalf + CW_GAP) };
      const span = j.poly
        ? polySpanOnLine(j.poly, o, vx, vz)
        : lineRoadSpanOnLine(o, vx, vz, j.x, j.z, ux, uz, j.roadHalf);
      if (!span) continue;   // 路面到不了这条带线（急剧收窄）就不铺
      layZebra(city, o, vx, vz, ux, uz, span[0], span[1], 0.2);
    }

    // B 组：带线过 j + n·(±(边距+GAP))、方向 u；铺开范围 = 被穿路沥青在该带线上的真实区间。
    // 面路两侧边界不对称，各侧各用实测边界。整条 yB=0.2：斜交时条纹长轴一端会伸进
    // 主路描边路的路面（y=0.18），0.2 恰好浮在其上不被吃掉
    for (const s of [-1, 1]) {
      const lb = (s < 0 ? -(j.edgeNeg ?? j.roadHalf) : (j.edgePos ?? j.roadHalf)) + CW_GAP;
      const o = { x: j.x + nx * s * lb, z: j.z + nz * s * lb };
      const t1 = lineHitT(o.x, o.z, ux, uz, j.x + mx * j.progHalf, j.z + mz * j.progHalf, vx, vz);
      const t2 = lineHitT(o.x, o.z, ux, uz, j.x - mx * j.progHalf, j.z - mz * j.progHalf, vx, vz);
      if (t1 == null || t2 == null) continue;
      layZebra(city, o, ux, uz, vx, vz, Math.min(t1, t2), Math.max(t1, t2), yB);
    }
  }
}

// 在带线 L(τ) = o + τ·d 上铺一组斑马线条：τ 从 t0−GAP 到 t1+GAP（两端越过路边 0.2m），
// 每条长 CW_DEPTH、宽 CW_BAR、净间隔 0.5，长轴顺 (lx,lz)。
// 条数取整后的余量对称分到两端，斑马线带两头离路边一样近（余量全压一端会显得缺一条）
function layZebra(city, o, dx, dz, lx, lz, t0, t1, y) {
  const tMin = t0 - CW_GAP, tMax = t1 + CW_GAP;
  const span = tMax - tMin;
  const n = Math.floor(span / CW_PITCH);
  if (n < 1) return;
  const start = tMin + (span - ((n - 1) * CW_PITCH + CW_BAR)) / 2 + CW_BAR / 2;
  for (let k = 0; k < n; k++) {
    const off = start + k * CW_PITCH;
    city.markWhite.add(barGeo(o.x + dx * off, o.z + dz * off, lx, lz, CW_DEPTH, CW_BAR, y));
  }
}

// 任意方向的标线条：长轴沿 (dx,dz)，与 customMap 的 markQuad 同构
function barGeo(cx, cz, dx, dz, len, w, y) {
  const g = new THREE.PlaneGeometry(len + w * 0.6, w);
  g.rotateX(-Math.PI / 2);
  g.rotateY(Math.atan2(-dz, dx));
  g.translate(cx, y, cz);
  return g;
}
