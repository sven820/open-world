// 最小复现：取面道路构建是否挂起
import { polyCenterLine, buildCustomMap } from "../src/world/customMap.js";

console.log("step1: import ok");
const ribbon = [[-7, 0], [-7, 100], [7, 100], [7, 0]];
console.log("step2: polyCenterLine:", JSON.stringify(polyCenterLine(ribbon, 80)));

console.log("step3: buildCustomMap closed+marks ...");
const g = buildCustomMap(
  { features: { roads: [{ id: "r1", points: ribbon, width: 14, closed: true, lanes: 2, median: 0, sidewalk: 3 }], rivers: [] }, objects: [] },
  { add() {} },
);
console.log("step4: built, children =", g.group.children.length);
for (const c of g.group.children) {
  console.log("  -", c.type, c.material && c.material.color ? c.material.color.getHexString() : "-", c.geometry?.type, c.geometry?.attributes?.position?.count);
}
process.exit(0);
