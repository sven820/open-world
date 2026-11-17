import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/* ---------------- 3D 转角包柱屏 · L 角圆角控制器（cornerArc） ----------------
 * 移植自 PULSE 内容源实验台「屏体几何 · 转角弧度」：屏面 = 两个平面段 +
 * 转角 1/4 圆柱弧，两面在弧的 45° 处接缝 —— 整块屏几何上连续，转角既没有
 * 柱体也没有屏缝。R = 0 时完全走原直角路径（方盒塔体 + 两块四边面片），
 * 与移植前的几何 / UV / 渲染数值一致，零回归。
 *
 * 改动这块之前请先读这四条约定：
 * 1) 3D 片源用统一公共视图基 M0 + 每路 clip 空间取景框 S（M = S·M0），
 *    不再按「原始虚拟平面」逐面做 offAxis；圆角只改屏体几何、不改共棱对位。
 * 2) 3D 模式下屏面 UV 与 RT 投影矩阵同源：逐顶点用同一个 M 投影
 *    （u,v = clip.xy / clip.w 归一化），弧段与 RT 矩阵永远不会不同步，
 *    共棱处也就不会出现 clamp 竖带。直角屏同样要走 updateProj（旧版跳过），
 *    因为 S 把 UV 贴进该路内容区域，不再是恒等 0..1。M 由 content3d.js 算出回传，
 *    本模块不重复推导，杜绝「算两遍算不一样」。
 * 3) 整屏平面模式（2D 内容）把两面拼成一张画布：A 面 u∈[0,0.5]、B 面 u∈[0.5,1]，
 *    u 沿屏面弧长分布，接缝正好落在圆角中点；平贴退化 / 每面整幅时 u∈[0,1]。
 * 4) 塔体 / 檐口跟着屏面轮廓共形退让（沿法线内缩 SCREEN_OFFSET），否则内凹的
 *    弧段会钻进方盒实体里被墙面挡住，转角处出现一条深色竖带。
 * ------------------------------------------------------------------------ */

const SCREEN_OFFSET = 0.08;   // 屏面凸出塔体（与 mounts.js 同名常量同值）
const TOWER_EXTRA = 1.4;      // 塔体宽 = 屏宽 + 1.4（与 mounts.js 一致）
const WALL_CLEARANCE = 0.5;   // 挂件屏面离宿主墙面的安装间隙（与 mounts.js 同值）
const ARC_SEG = 24;           // 单面弧段细分段数（两面合计 90°，共 48 段）
const PLANE_SEG = 16;         // 单面平面段细分段数（实验台 NA/NB=16 同款）
const NEAR = 0.12, FAR = 400; // 与 content3d.js 离轴相机同一组远近平面

const HOUSING_COLOR = 0x262a30;
const TRIM_COLOR = 0x8a93a2;

/** 后台「圆角半径（0~5 米）」范围 */
export const ARC_R_MAX = 5;
export const ARC_R_MIN = 0.25;  // 小于此半径按直角处理：塔体厚度会吃掉弧

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** 规整半径：非法值 / 0 / 过小 → 0（直角共棱）；过大 → 屏宽一半与 5m 取小 */
export function clampArcRadius(spec, r) {
  const maxR = Math.min(ARC_R_MAX, (spec && spec.w ? spec.w : 14) * 0.5);
  const v = typeof r === "number" && Number.isFinite(r) ? r : 0;
  if (v < ARC_R_MIN) return 0;
  return Math.min(maxR, v);
}

function housingMat() {
  return new THREE.MeshStandardMaterial({ color: HOUSING_COLOR, roughness: 0.85, metalness: 0.05 });
}
function trimMat() {
  return new THREE.MeshBasicMaterial({ color: TRIM_COLOR, toneMapped: false });
}

/* 屏面到塔体轴线的距离（与 mounts.js corner3dFaceDefs 同一算法） */
function cornerD(spec) {
  return (spec.w + TOWER_EXTRA) / 2 + SCREEN_OFFSET;
}

/** L 角屏面折线（局部 x-z，不含 y）：
 *  A 面 = 平段（x: -D+w → -D+R）+ 上四分之一弧（-90° → -135°）；
 *  B 面 = 下四分之一弧（-135° → -180°）+ 平段（z: -D+R → -D+w）。
 *  弧圆心 O=(-D+R, -D+R)，θ=-90° 与 A 面平段相切，θ=-180° 与 B 面平段相切，
 *  θ=-135° 是两路的分界（45° 接缝）。 */
function arcPolys(spec, R) {
  const D = cornerD(spec);
  const ox = -D + R, oz = -D + R;
  const pt = (t) => ({ x: ox + R * Math.cos(t), z: oz + R * Math.sin(t) });
  const x1 = -D + (spec.wA || spec.w), z1 = -D + (spec.wB || spec.w);
  const A = [], B = [];
  /* 平面段也必须细分：离轴 UV 是投影变换，屏面渲染时 GPU 按主相机 w 做透视
   * 校正插值，一条横跨 11 m 的大条带会把圆环 / 球网折成波浪。拆成等长小条带
   * 后每段 UV 跨度很小，插值误差可忽略。跳过与平面段端点重合的弧点，避免零长条带。 */
  for (let i = 0; i <= PLANE_SEG; i++) {
    A.push({ x: x1 + ((-D + R) - x1) * (i / PLANE_SEG), z: -D });
  }
  for (let i = 1; i <= ARC_SEG; i++) A.push(pt(-Math.PI / 2 - (Math.PI / 4) * (i / ARC_SEG)));
  for (let i = 0; i <= ARC_SEG; i++) B.push(pt(-Math.PI * 0.75 - (Math.PI / 4) * (i / ARC_SEG)));
  for (let i = 1; i <= PLANE_SEG; i++) {
    B.push({ x: -D, z: (-D + R) + (z1 - (-D + R)) * (i / PLANE_SEG) });
  }
  return { A, B, D, R };
}

/** 屏面折线采样点（局部坐标，上下沿各一圈）：给 content3d.js 求每路屏面在
 *  公共视图基 M0 下的 NDC 包围盒。必须与 _buildFaceStrips 用的折线逐点一致，
 *  否则取景框会偏，屏面 UV 与 RT 内容就会错开。 */
export function cornerArcSamples(spec, radius) {
  const R = clampArcRadius(spec, radius);
  if (!R) return null;
  const y0 = spec.y - spec.h / 2, y1 = spec.y + spec.h / 2;
  const { A, B } = arcPolys(spec, R);
  // 挂件模式：屏面几何会整体平移到转角棱线（资产锚点），采样点必须同步，
  // 否则 content3d 的取景框跟实际屏面对不上
  const sh = spec.attached ? cornerD(spec) - WALL_CLEARANCE : 0;
  const pack = (poly) => {
    const out = [];
    for (const p of poly) {
      out.push(new THREE.Vector3(p.x + sh, y0, p.z + sh), new THREE.Vector3(p.x + sh, y1, p.z + sh));
    }
    return out;
  };
  const res = [pack(A), pack(B)];
  res.radius = R;
  return res;
}

export class CornerArcScreen {
  /**
   * @param {{w:number,h:number,y:number,arc?:number}} spec 已归一化的屏体规格
   * @param {THREE.Material[]} mats 两面屏面材质 [A, B]
   * @param {{pos:[number,number], rot:number, refFaces:Array}} opts
   *   pos/rot 与 billboard.js 给 group 设置的定位一致；refFaces 是
   *   corner3dFaceDefs(spec) 的局部四角（未含 pos/rot），离轴取景的参考平面。
   */
  constructor(spec, mats, opts = {}) {
    this.spec = { w: spec.w, h: spec.h, y: spec.y, wA: spec.wA || spec.w, wB: spec.wB || spec.w };
    this.attached = !!spec.attached; // 组合挂件：不建自带塔体，屏面直接贴宿主楼角
    // 有塔体时屏面在塔体外侧 D 处；挂件没有塔体，把整块屏拉回资产锚点（转角棱线），
    // 否则自动贴墙后屏还悬在墙外 D≈屏宽/2 的地方
    this.shift = this.attached ? cornerD(this.spec) - WALL_CLEARANCE : 0;
    this.mats = [mats[0], mats[1] || mats[0]];
    const pos = opts.pos || [0, 0];
    this.pos = [pos[0] || 0, pos[1] || 0];
    this.rot = opts.rot || 0;
    this._cs = Math.cos(this.rot);
    this._sn = Math.sin(this.rot);
    this.refFaces = opts.refFaces || [];

    this.radius = 0;
    this._mode = "full";                 // full（每面整幅） | split（两面拼一张） | proj（离轴）
    this._projSeq = -1;                  // 最近一次写入的投影批次（由外部比对，避免重复写缓冲）
    this._records = [];                  // 屏面条带记录 { mesh, geo, face, attr, full, plane, proj }
    this._built = [];                    // 塔体 / 檐口 / 面片（本控制器自建，重建时释放）
    this._housing = null;
    this._trimMat = null;

    this.group = new THREE.Group();
    this.group.name = "corner3d-arc";
    this._rebuild(clampArcRadius(this.spec, spec.arc));
  }

  /* ---------------- 半径（后台热更新） ---------------- */

  /** 重建几何但保留材质 / 场景节点 / 轮播。
   *  @returns {boolean} true = 几何变了（尺寸变了才需要重建，调用方无需额外标脏 RT：
   *  参考平面没变、RT 内容不变，变的只有屏面顶点与 UV） */
  setRadius(r) {
    const next = clampArcRadius(this.spec, r);
    if (next === this.radius) return false;
    this._rebuild(next);
    return true;
  }

  /** 每面的屏面网格（直角 1 块；圆角多段条带）。几何重建后需重新取。 */
  faceMeshes() {
    const out = [[], []];
    for (const rec of this._records) out[rec.face].push(rec.mesh);
    return out;
  }

  /* ---------------- UV 模式 ---------------- */

  /** full = 每面整幅（平贴退化 / 2D 平贴）；split = 两面拼一张画布；proj = 离轴重投影 */
  setUvMode(mode) {
    const next = mode === "split" || mode === "proj" ? mode : "full";
    if (next === this._mode) return;
    this._mode = next;
    this._writeUv();
  }

  /** 用 content3d.js 渲染 RT 时的同一组矩阵逐顶点重写屏面 UV。
   *  @param {THREE.Matrix4[]} matrices [A 面, B 面]（世界坐标投影矩阵）
   *  @param {number} [seq] 矩阵批次号：同一批次不重复投影（省掉无谓的缓冲上传）
   *  直角屏同样需要：统一视图基 M = S·M0 下屏面四角不再恰好落在 UV 0..1，
   *  而是落在该路的内容区域 [0.5±fx/2, 0.5±fy/2]。 */
  updateProj(matrices, seq) {
    if (!matrices || matrices.length < 2) return;
    if (seq !== undefined && seq === this._projSeq) return;
    if (seq !== undefined) this._projSeq = seq;
    const [px, pz] = this.pos, cs = this._cs, sn = this._sn;
    let written = false;
    for (const rec of this._records) {
      const M = matrices[rec.face];
      const posAttr = rec.geom.attributes.position;
      const uv = rec.proj;
      if (!M || !posAttr || !uv) continue;
      for (let i = 0, n = posAttr.count; i < n; i++) {
        const lx = posAttr.getX(i), ly = posAttr.getY(i), lz = posAttr.getZ(i);
        _clip.set(px + lx * cs + lz * sn, ly, pz - lx * sn + lz * cs).applyMatrix4(M);
        uv[i * 2] = _clip.x * 0.5 + 0.5;
        uv[i * 2 + 1] = _clip.y * 0.5 + 0.5;
      }
      if (this._mode === "proj") {
        rec.attr.array.set(uv);
        written = true;
      }
    }
    if (written) for (const rec of this._records) rec.attr.needsUpdate = true;
  }

  _writeUv() {
    for (const rec of this._records) {
      const src = this._mode === "proj" ? rec.proj
        : this._mode === "split" ? rec.plane : rec.full;
      if (!src) continue;
      rec.attr.array.set(src);
      rec.attr.needsUpdate = true;
    }
  }

  /* ---------------- 几何构建 ---------------- */

  _rebuild(radius) {
    this.radius = radius;
    this._projSeq = -1;   // 新几何的 proj 数组还是 full 的拷贝，下一批矩阵必须无条件写入
    this._disposeBuilt();
    if (radius === 0) this._buildSharp();
    else this._buildArc(radius);
    if (this.shift) {
      for (const rec of this._records) this._shiftGeom(rec.geom);
      for (const m of this._built) if (m.geometry) this._shiftGeom(m.geometry);
    }
    this._writeUv();
  }

  _disposeBuilt() {
    for (const rec of this._records) {
      this.group.remove(rec.mesh);
      rec.geom.dispose();
    }
    this._records = [];
    for (const m of this._built) {
      this.group.remove(m);
      if (m.geometry) m.geometry.dispose();
    }
    this._built = [];
    if (this._housing) { this._housing.dispose(); this._housing = null; }
    if (this._trimMat) { this._trimMat.dispose(); this._trimMat = null; }
  }

  _addBuilt(m) {
    this._built.push(m);
    this.group.add(m);
    return m;
  }

  /** 挂件：几何顶点整体回移到转角棱线，UV 与投影矩阵不受平移影响 */
  _shiftGeom(geom) {
    const pos = geom.attributes.position;
    if (!pos) return;
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(i, pos.getX(i) + this.shift, pos.getY(i), pos.getZ(i) + this.shift);
    }
    pos.needsUpdate = true;
    if (geom.computeBoundingSphere) geom.computeBoundingSphere();
  }

  /** 直角路径：与移植前 mounts.js 的 corner3d 逐项一致（方盒塔体 + 檐口 + 两块面片） */
  _buildSharp() {
    const { w, h, y } = this.spec;
    const towerW = w + TOWER_EXTRA;
    const totalH = y + h / 2 + 0.6;
    if (!this.attached) {
      this._housing = housingMat();
      this._trimMat = trimMat();

      const box = new THREE.Mesh(new THREE.BoxGeometry(towerW, totalH, towerW), this._housing);
      box.name = "corner3d-housing";
      box.userData.bindingKey = "housing";
      box.position.set(0, totalH / 2, 0);
      box.castShadow = true; box.receiveShadow = true;
      this._addBuilt(box);

      const trim = new THREE.Mesh(new THREE.BoxGeometry(towerW + 0.3, 0.5, towerW + 0.3), this._trimMat);
      trim.name = "corner3d-trim";
      trim.userData.bindingKey = "trim";
      trim.position.set(0, totalH + 0.25, 0);
      trim.castShadow = false; trim.receiveShadow = true;
      this._addBuilt(trim);
    }

    const D = cornerD(this.spec);
    const y0 = y - h / 2, y1 = y + h / 2;
    const wa = this.spec.wA || w, wb = this.spec.wB || w;
    const x1 = -D + wa, z1 = -D + wb;
    // A 面朝 -Z（右缘 = 转角棱线）、B 面朝 -X（左缘 = 转角棱线），两面共享棱线 (-D,-D)
    const quads = [
      { face: 0, pa: [x1, -D], pb: [-D, -D] },
      { face: 1, pa: [-D, -D], pb: [-D, z1] },
    ];
    for (const q of quads) {
      // 直角面片横跨整面，必须细分：离轴 UV 是投影变换，单个大四边形会被
      // GPU 的三角形内线性插值折弯（圆环变椭圆 / 网格变弯），细分后误差可忽略。
      const geom = quadStrip(q.pa, q.pb, y0, y1, 16, 8);
      const mesh = new THREE.Mesh(geom, this.mats[q.face]);
      mesh.name = `corner3d-screen-${q.face === 0 ? "A" : "B"}`;
      mesh.userData.billboardScreen = true;
      mesh.userData.bindingKey = "screen";
      mesh.castShadow = false;
      this.group.add(mesh);
      if (this.attached) this._addAttachedBacking(geom);
      const attr = geom.attributes.uv;
      const { up, vp } = geom.userData, n = up.length;
      const full = new Float32Array(n * 2), plane = new Float32Array(n * 2);
      // 整屏平铺时两面按各自长度分配 UV，左右屏长度不同也不会把画面拉伸
      const fa = wa / (wa + wb);
      const off = q.face === 0 ? 0 : fa;
      const span = q.face === 0 ? fa : 1 - fa;
      for (let i = 0; i < n; i++) {
        full[i * 2] = up[i]; full[i * 2 + 1] = vp[i];
        plane[i * 2] = off + up[i] * span; plane[i * 2 + 1] = vp[i];
      }
      this._records.push({
        mesh, geom, face: q.face, attr,
        full, plane, proj: full.slice(),
      });
    }
  }

  /** 圆角路径：平面段 + 1/4 圆柱弧（A 面平→弧，B 面弧→平，接缝在弧中点） */
  _buildArc(R) {
    const { w, h, y } = this.spec;
    const totalH = y + h / 2 + 0.6;
    const half = (w + TOWER_EXTRA) / 2;
    const D = cornerD(this.spec);
    const y0 = y - h / 2, y1 = y + h / 2;
    const { A, B } = arcPolys(this.spec, R);

    this._buildFaceStrips(0, A, y0, y1);
    this._buildFaceStrips(1, B, y0, y1);
    if (!this.attached) this._buildRoundedTower(half, D, R, totalH);
  }

  _buildFaceStrips(faceIndex, poly, y0, y1) {
    // 弧长参数化：u 沿本面屏面等距展开（平面段与弧段同一密度，不压缩弧段纹理）
    const s = [0];
    for (let i = 1; i < poly.length; i++) {
      s.push(s[i - 1] + Math.hypot(poly[i].x - poly[i - 1].x, poly[i].z - poly[i - 1].z));
    }
    const total = s[s.length - 1] || 1;
    // 整屏平铺：A/B 按各自长度分配画布，左右屏不等长时画面不变形
    const wa = this.spec.wA || this.spec.w, wb = this.spec.wB || this.spec.w;
    const fa = wa / (wa + wb);
    const off = faceIndex === 0 ? 0 : fa;
    const span = faceIndex === 0 ? fa : 1 - fa;
    const geos = [], ups = [], vps = [], fulls = [], planes = [];

    for (let i = 0; i < poly.length - 1; i++) {
      const p0 = poly[i], p1 = poly[i + 1];
      const geom = quadStrip([p0.x, p0.z], [p1.x, p1.z], y0, y1);
      const u0 = s[i] / total, u1 = s[i + 1] / total;
      const { up, vp } = geom.userData, n = up.length;
      const full = new Float32Array(n * 2), plane = new Float32Array(n * 2);
      for (let k = 0; k < n; k++) {
        const u = u0 + (u1 - u0) * up[k];
        full[k * 2] = u; full[k * 2 + 1] = vp[k];
        plane[k * 2] = off + u * span; plane[k * 2 + 1] = vp[k];
      }
      geos.push(geom); ups.push(up); vps.push(vp); fulls.push(full); planes.push(plane);
    }

    // 细分留在顶点层（离轴 UV 需要密度），节点层按面合成 1 个 mesh：
    // mergeGeometries 自动偏移索引，三套 UV 按同一顶点序拼接，投影逻辑不变。
    const merged = geos.length > 1 ? mergeGeometries(geos) : geos[0];
    if (!merged) {
      // 属性集意外不一致时退回逐段网格，保证画面不缺
      for (let i = 0; i < geos.length; i++) this._addScreenMesh(geos[i], faceIndex, fulls[i], planes[i]);
      return;
    }
    for (const g of geos) if (g !== merged) g.dispose();
    merged.userData.up = concatF32(ups);
    merged.userData.vp = concatF32(vps);
    this._addScreenMesh(merged, faceIndex, concatF32(fulls), concatF32(planes));
  }

  /** 统一登记屏面：名字/绑定键在 setRadius 重建后也不会丢 */
  _addScreenMesh(geom, face, full, plane) {
    const mesh = new THREE.Mesh(geom, this.mats[face]);
    mesh.name = `corner3d-screen-${face === 0 ? "A" : "B"}`;
    mesh.userData.billboardScreen = true;
    mesh.userData.bindingKey = "screen";
    mesh.castShadow = false;
    this.group.add(mesh);
    if (this.attached) this._addAttachedBacking(geom);
    this._records.push({ mesh, geom, face, attr: geom.attributes.uv, full, plane, proj: full.slice() });
  }

  /** 挂件模式的薄背板：把屏面几何沿自身顶点法线往里推 0.16m，
   *  得到一层贴着屏面的不透明壳 —— 背面不再看穿，但不会像塔体那样鼓出一大块。
   *  front 面片仍走 FrontSide 显示内容，背板双面渲染挡住背侧视线。 */
  _addAttachedBacking(screenGeom) {
    const geom = screenGeom.clone();
    const pos = geom.attributes.position, nor = geom.attributes.normal;
    if (!nor) { geom.dispose(); return; }
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(i, pos.getX(i) - nor.getX(i) * 0.16, pos.getY(i), pos.getZ(i) - nor.getZ(i) * 0.16);
    }
    pos.needsUpdate = true;
    if (!this._housing) {
      // 与立面屏背板同色：恒定深灰蓝，不受夜间光照影响变纯黑
      this._housing = new THREE.MeshBasicMaterial({
        color: 0x3b4453, toneMapped: false, side: THREE.DoubleSide,
      });
    }
    const back = new THREE.Mesh(geom, this._housing);
    back.name = "corner3d-attached-backing";
    back.castShadow = true;
    back.receiveShadow = true;
    this._addBuilt(back);
  }

  /** 圆角塔体：屏面折线沿法线内缩 SCREEN_OFFSET 后的轮廓沿 Y 挤出 */
  _buildRoundedTower(half, D, R, totalH) {
    this._housing = housingMat();
    this._trimMat = trimMat();

    const tower = new THREE.Mesh(this._towerGeom(half, D, R - SCREEN_OFFSET, totalH, 0), this._housing);
    tower.name = "corner3d-housing";
    tower.userData.bindingKey = "housing";
    tower.castShadow = true; tower.receiveShadow = true;
    this._addBuilt(tower);

    // 檐口：同一轮廓外扩 0.15m、高 0.5m，叠在塔顶（直角路径同款比例）
    const trim = new THREE.Mesh(
      this._towerGeom(half + 0.15, D, R - SCREEN_OFFSET + 0.15, 0.5, totalH),
      this._trimMat,
    );
    trim.name = "corner3d-trim";
    trim.userData.bindingKey = "trim";
    trim.castShadow = false; trim.receiveShadow = true;
    this._addBuilt(trim);
  }

  /** 塔体轮廓（俯视 x-z）挤出：rt = 内缩后的圆角半径，与屏面弧同心 */
  _towerGeom(half, D, rtIn, height, baseY) {
    const rt = Math.max(0.02, rtIn);
    const ox = -D + this.radius, oz = -D + this.radius;
    const segs = ARC_SEG * 2;
    const pts = [];
    for (let i = 0; i <= segs; i++) {
      const t = -Math.PI + (Math.PI / 2) * (i / segs);   // -180° → -90°
      pts.push({ x: ox + rt * Math.cos(t), z: oz + rt * Math.sin(t) });
    }
    pts.push({ x: half, z: -half });
    pts.push({ x: half, z: half });
    pts.push({ x: -half, z: half });

    // three 的 Shape 在 XY 平面挤出：用 (x, -z) 建形，再绕 X 轴转 -90° 让挤出方向朝上
    const shape = new THREE.Shape();
    pts.forEach((p, i) => (i === 0 ? shape.moveTo(p.x, -p.z) : shape.lineTo(p.x, -p.z)));
    shape.closePath();
    const geom = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, steps: 1 });
    geom.rotateX(-Math.PI / 2);
    if (baseY) geom.translate(0, baseY, 0);
    geom.computeVertexNormals();
    return geom;
  }

  dispose() {
    this._disposeBuilt();
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}

const _clip = new THREE.Vector3();

const concatF32 = (arrays) => {
  const out = new Float32Array(arrays.reduce((n, a) => n + a.length, 0));
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
};

/** 一条竖直条带的细分网格（(su+1)×(sv+1) 顶点）：顶点序 pa(左下) → pb(右下)
 *  → pd(右上) → pc(左上)，与 mounts.js quadGeom 同一绕序（right×up = 屏面外法线）。
 *  离轴 UV 是投影变换（u = L(x)/w），GPU 在三角形内只做透视线性插值，单个大四边形
 *  会把圆环 / 网格折弯；横竖细分后误差可忽略。userData.up/vp 保存每个顶点的条带内
 *  参数，供 full / split / proj 三种 UV 共用。 */
function quadStrip(p0, p1, y0, y1, su = 4, sv = 8) {
  const geom = new THREE.BufferGeometry();
  const n = (su + 1) * (sv + 1);
  const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  const up = new Float32Array(n), vp = new Float32Array(n), idx = [];
  for (let j = 0; j <= sv; j++) {
    const tv = j / sv, y = y0 + (y1 - y0) * tv;
    for (let i = 0; i <= su; i++) {
      const tu = i / su, k = j * (su + 1) + i;
      pos[k * 3] = p0[0] + (p1[0] - p0[0]) * tu;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = p0[1] + (p1[1] - p0[1]) * tu;
      uv[k * 2] = tu; uv[k * 2 + 1] = tv;
      up[k] = tu; vp[k] = tv;
    }
  }
  for (let j = 0; j < sv; j++) {
    for (let i = 0; i < su; i++) {
      const a = j * (su + 1) + i, b = a + 1, c = a + su + 1, d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
  }
  geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geom.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geom.setIndex(idx);
  geom.computeVertexNormals();
  geom.userData.up = up;
  geom.userData.vp = vp;
  return geom;
}

export { NEAR as ARC_CAM_NEAR, FAR as ARC_CAM_FAR };
