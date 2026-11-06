// assetStore（数据层）导出描边资产时的几何重建桥。
// 单独一个小文件是为了依赖方向干净：data 层不直接 import 渲染层的大模块，
// 只在导出时动态 import 这里；这里再转调 world/assetMesh 的共享构建函数。
import { buildTracedObject } from "../world/assetMesh.js";

export function buildTracedAssetObject(asset) {
  return buildTracedObject(asset);
}
