// 地球曲率渲染补偿（编辑器 3D 与运行时渲染共用）：
// 地图数据始终保持局部 ENU 平面米制坐标（x 东 / z 南），游戏逻辑、碰撞、
// 存档全部按平面坐标工作；仅在渲染层把顶点/物件按所在位置下沉，
// 使编辑内容与 Cesium 球面影像贴合，消除"平面盖在球面上"的观感。
//
// 下垂量 drop(d) = d² / 2R（R=地球半径）：
//   1km → 0.08m   2km → 0.31m   2.83km(4km 板角) → 0.63m
// 数值很小但足以让网格线随影像透视下弯。
export const EARTH_R = 6371000; // 米

export function dropAt(x, z) {
  return (x * x + z * z) / (2 * EARTH_R);
}

// 给 BufferGeometry 施加曲率下沉（顶点须位于 x/z 水平面、y 为高度）
export function bendGeometry(geo) {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, pos.getY(i) - dropAt(pos.getX(i), pos.getZ(i)));
  }
  pos.needsUpdate = true;
  return geo;
}
