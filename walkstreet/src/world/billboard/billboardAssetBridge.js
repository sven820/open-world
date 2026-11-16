// 广告牌资产 · 数据→渲染桥（对应 studio/tracedAsset.js 的定位）。
// 只有本文件 import three 与 mounts，data 层保持纯净。
//
// 用途：
//   1. 模型工坊缩略图 / 预览（editorScreenMaterial 占位画面）；
//   2. exportAssetGLB 现场重建几何；
//   3. 地图编辑器 billboard 对象（assetId 引用）的幽灵/预览网格。
//
// 屏面一律用独立占位材质（userData.shared），不进 materialBindings ——
// 每块屏运行时要播各自的内容；机箱 / 边框才允许绑库材质。

import * as THREE from "three";
import { getMount, normalizeSpec, editorScreenMaterial, editorCornerScreenMaterial } from "./mounts.js";
import { billboardSpecFromAsset, billboardParamsFor } from "../../data/billboardAsset.js";

/** 资产记录 → 可渲染的 Object3D（局部坐标，原点 = 底面中心，pos/rot 归零）。 */
export function buildBillboardAssetObject(asset, screenMat = null) {
  if (!asset || !asset.billboard) return null;
  const raw = billboardSpecFromAsset(asset);
  const spec = normalizeSpec(raw);
  // 3D 转角一体屏：用跨两面的全景占位画面，配合 split UV 读起来是一整块折角屏
  const sm = screenMat || (spec.mount === "corner3d" ? editorCornerScreenMaterial() : editorScreenMaterial());
  const built = getMount(spec.mount).build(spec, [sm, sm], { pos: [0, 0], rot: 0 });
  if (!screenMat && spec.mount === "corner3d" && built.cornerArc) built.cornerArc.setUvMode("split");

  const root = new THREE.Group();
  root.name = "billboard-asset";
  for (const fg of built.faceGroups || []) {
    fg.position.set(0, 0, 0);
    fg.rotation.y = 0;
    root.add(fg);
  }
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.includes(sm)) {
      o.userData.billboardScreen = true;
      o.userData.bindingKey = "screen";
      o.castShadow = false;
      o.receiveShadow = false;
    } else if (mats.some((m) => m.isMeshBasicMaterial)) {
      o.userData.bindingKey = "trim";
    } else {
      o.userData.bindingKey = "housing";
    }
  });
  // 展示朝向写在资产数据里（poseYaw），不在相机/代码里按类型硬编码。
  // 转角屏两面朝局部 -Z/-X → yaw=π 后正对默认 +X/+Z 机位；以后任何模型都靠这条数据。
  const yaw = +(asset.poseYaw || (asset.billboard && asset.billboard.poseYaw) || 0);
  if (yaw) root.rotation.y = yaw;
  // 圆角控制器挂在非可枚举属性上：clone()/userData 序列化不会带上它，
  // 但工坊里直接持有桥接产物时可以原地 setRadius，不重建整块模型。
  if (built.cornerArc) Object.defineProperty(root, "_cornerArc", { value: built.cornerArc, enumerable: false, configurable: true });
  root.userData.billboardSpec = { ...spec, autoSnap: raw.autoSnap, screenFaces: raw.screenFaces };
  root.userData.sharedTpl = true; // 模板几何/材质共享，宿主重建时不得 dispose
  return root;
}

/** 取 root 下的圆角控制器（工坊直接构建的广告牌模型才有；模板克隆没有） */
export function getCornerArc(root) {
  if (!root || !root.traverse) return null;
  let found = null;
  root.traverse((o) => { if (!found && o._cornerArc) found = o._cornerArc; });
  return found;
}

/** 地图 billboard 记录（可能只有 assetId）→ buildBillboardGroup 可吃的 item。 */
export function billboardItemFromRecord(item, asset) {
  if (!asset || !asset.billboard) return item;
  return { ...item, params: billboardParamsFor(item, asset) };
}
