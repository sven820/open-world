// 描边道路标线/分隔带逻辑验证（node 直跑，无需浏览器）：
//   node scripts/test-trace-road.mjs
import { buildCustomMap, polyCenterLine, pointInPoly } from "../src/world/customMap.js";

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? "PASS" : "FAIL") + "  " + msg); if (!cond) fails++; };
const colliders = { add() {} };
const matColors = (g) => g.group.children.map((m) => (m.material && m.material.color ? m.material.color.getHex() : null));
const vertsOf = (g, hex) => {
  const m = g.group.children.find((c) => c.material && c.material.color && c.material.color.getHex() === hex);
  return m ? m.geometry.attributes.position.count : 0;
};
const treeCount = (g) => g.group.children.filter((c) => c.isGroup && Math.abs(c.scale.x - 0.8) < 1e-6).length;

// ---- 1. pointInPoly ----
const ribbon = [[-7, 0], [-7, 100], [7, 100], [7, 0]];
ok(pointInPoly(0, 50, ribbon) === true, "pointInPoly: 面内点判定为内");
ok(pointInPoly(20, 50, ribbon) === false, "pointInPoly: 面外点判定为外");

// ---- 2. polyCenterLine：直取面路 ----
const cl = polyCenterLine(ribbon, 80);
ok(!!cl, "polyCenterLine: 直取面路有中轴线");
if (cl) {
  ok(Math.abs(cl[0][0]) < 0.01 && Math.abs(cl[1][0]) < 0.01, "polyCenterLine: 中线居中 (x≈0)");
  ok(Math.hypot(cl[1][0] - cl[0][0], cl[1][1] - cl[0][1]) > 80, "polyCenterLine: 中线纵贯整条路 (>80m)");
}

// ---- 3. 取面道路 + 双黄线（lanes 2, median 0）----
const g1 = buildCustomMap(
  { features: { roads: [{ id: "r1", points: ribbon, width: 14, closed: true, lanes: 2, median: 0, sidewalk: 3 }], rivers: [] }, objects: [] },
  colliders,
);
const c1 = matColors(g1);
ok(c1.includes(0xe8e8e2), "取面路: 生成白色车道虚线");
ok(c1.includes(0xd8a524), "取面路: median=0 生成双黄线");
ok(!c1.includes(0x2f5426), "取面路: median=0 无分隔带绿篱");
const dashVerts = vertsOf(g1, 0xe8e8e2);
ok(dashVerts >= 22 * 4 && dashVerts % 4 === 0, `取面路: 白虚线两侧各 ~11 段 (顶点数 ${dashVerts})`);
const yellowVerts = vertsOf(g1, 0xd8a524);
ok(yellowVerts === 8, `取面路: 双黄线两条 (顶点数 ${yellowVerts})`);
// 虚线应位于中线两侧 ±3.4m：抽样合并几何顶点的 x 分布
{
  const m = g1.group.children.find((c) => c.material && c.material.color && c.material.color.getHex() === 0xe8e8e2);
  const arr = m.geometry.attributes.position.array;
  let near34 = 0;
  for (let i = 0; i < arr.length; i += 3) if (Math.abs(Math.abs(arr[i]) - 3.4) < 0.3) near34++;
  ok(near34 > 0, "取面路: 虚线位于 ±3.4m（固定车道宽）");
}

// ---- 4. 取面道路 + 分隔带（median 6, lanes 2）----
const g2 = buildCustomMap(
  { features: { roads: [{ id: "r2", points: ribbon, width: 20, closed: true, lanes: 2, median: 6, sidewalk: 3 }], rivers: [] }, objects: [] },
  colliders,
);
const c2 = matColors(g2);
ok(c2.includes(0x9aa2ab), "取面路: median>0 生成基座");
ok(c2.includes(0x2f5426), "取面路: median>0 生成绿篱");
ok(!c2.includes(0xd8a524), "取面路: median>0 无双黄线");
ok(treeCount(g2) === 4, `取面路: 分隔带行道树 4 棵 (中线 95.8m, 12+22k; 实际 ${treeCount(g2)})`);
// 分隔带基座应居中对称于中线且宽 6m（盒体顶点只在 ±3m 侧缘）
{
  const bed = g2.group.children.find((c) => c.material && c.material.color && c.material.color.getHex() === 0x9aa2ab);
  const arr = bed.geometry.attributes.position.array;
  let maxAbsX = 0, sumX = 0, n = 0;
  for (let i = 0; i < arr.length; i += 3) {
    maxAbsX = Math.max(maxAbsX, Math.abs(arr[i]));
    sumX += arr[i]; n++;
  }
  ok(Math.abs(sumX / n) < 0.01, "取面路: 分隔带居中于中线（顶点 x 均值≈0）");
  ok(maxAbsX <= 3.01, `取面路: 分隔带宽 6m (半宽 ${maxAbsX.toFixed(2)}m)`);
}

// ---- 5. 线形描边路：路缘线 + 固定 3.4m 虚线 + 双黄线 ----
const line = [[0, 0], [0, 100]];
const g3 = buildCustomMap(
  { features: { roads: [{ id: "r3", points: line, width: 12, lanes: 2, median: 0, sidewalk: 3 }], rivers: [] }, objects: [] },
  colliders,
);
const c3 = matColors(g3);
ok(c3.filter((c) => c === 0x9aa2ab).length === 2, "线形路: 两侧人行道 2 条");
ok(c3.includes(0xe8e8e2) && c3.includes(0xd8a524), "线形路: 白虚线 + 双黄线");
{
  // 宽 12（half 6）：固定车道宽 3.4 → 虚线 ±3.4；车道 3 时第二条 6.8 > 6-0.35 不画
  const m = g3.group.children.find((c) => c.material && c.material.color && c.material.color.getHex() === 0xe8e8e2);
  const arr = m.geometry.attributes.position.array;
  let at34 = 0, atEdge = 0;
  for (let i = 0; i < arr.length; i += 3) {
    if (Math.abs(Math.abs(arr[i]) - 3.4) < 0.3) at34++;
    if (Math.abs(Math.abs(arr[i]) - 5.84) < 0.3) atEdge++;
  }
  ok(at34 > 0, "线形路: 虚线位于 ±3.4m");
  ok(atEdge > 0, "线形路: 路缘实线位于 ±(half-0.16)");
  const g4 = buildCustomMap(
    { features: { roads: [{ id: "r4", points: line, width: 12, lanes: 3, median: 0, sidewalk: 3 }], rivers: [] }, objects: [] },
    colliders,
  );
  const m4 = g4.group.children.find((c) => c.material && c.material.color && c.material.color.getHex() === 0xe8e8e2);
  ok(m4.geometry.attributes.position.count === m.geometry.attributes.position.count,
    "线形路: lanes=3 且宽度不足时第二条虚线不画（与 lanes=2 相同顶点数）");
}

// ---- 6. lanes=3 宽度足够（width 24）→ 两条虚线每侧 ----
{
  const g5 = buildCustomMap(
    { features: { roads: [{ id: "r5", points: line, width: 24, lanes: 3, median: 0, sidewalk: 3 }], rivers: [] }, objects: [] },
    colliders,
  );
  const m5 = g5.group.children.find((c) => c.material && c.material.color && c.material.color.getHex() === 0xe8e8e2);
  // 虚线 ±3.4、±6.8 + 路缘 ±11.84：顶点数应多于 lanes=2 的情况
  const m2 = g3.group.children.find((c) => c.material && c.material.color && c.material.color.getHex() === 0xe8e8e2);
  ok(m5.geometry.attributes.position.count > m2.geometry.attributes.position.count, "线形路: lanes=3 宽度足够 → 虚线更多");
}

console.log(fails === 0 ? "\n全部通过" : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
