import * as THREE from "three";

/* ---------------- 3D 转角包柱屏 · L 角圆角控制器（cornerArc） ----------------
 * 移植自 PULSE 内容源实验台「屏体几何 · 转角弧度」：屏面 = 两个平面段 +
 * 转角 1/4 圆柱弧，两面在弧的 45° 处接缝 —— 整块屏几何上连续，转角既没有
 * 柱体也没有屏缝。R = 0 时完全走原直角路径（方盒塔体 + 两块四边面片），
 * 与移植前的几何 / UV / 渲染数值一致，零回归。
 *
 * 改动这块之前请先读这四条约定：
 * 1) 离轴相机仍按「原始虚拟平面」取景 —— 参考面恒为 corner3dFaceDefs 的直角
 *    四边形，圆角只改屏体几何、不改 3D 对位，所以 R=0 / R>0 的投影矩阵数值一致。
 * 2) 3D 模式下屏面 UV 与 RT 投影矩阵同源：逐顶点用同一个 M 投影
 *    （u,v = clip.xy / clip.w 归一化），弧段与 RT 矩阵永远不会不同步，
 *    共棱处也就不会出现 clamp 竖带。M 由 content3d.js 渲染 RT 时算出并回传
 *    （见 updateProj），本模块不重复推导，杜绝「算两遍算不一样」。
 * 3) 整屏平面模式（2D 内容）把两面拼成一张画布：A 面 u∈[0,0.5]、B 面 u∈[0.5,1]，
 *    u 沿屏面弧长分布，接缝正好落在圆角中点；平贴退化 / 每面整幅时 u∈[0,1]。
 * 4) 塔体 / 檐口跟着屏面轮廓共形退让（沿法线内缩 SCREEN_OFFSET），否则内凹的
 *    弧段会钻进方盒实体里被墙面挡住，转角处出现一条深色竖带。
 * ------------------------------------------------------------------------ */

const SCREEN_OFFSET = 0.08;   // 屏面凸出塔体（与 mounts.js 同名常量同值）
const TOWER_EXTRA = 1.4;      // 塔体宽 = 屏宽 + 1.4（与 mounts.js 一致）
const ARC_SEG = 10;           // 单面弧段细分段数（两面合计 90°，共 20 段）
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
  const A = [{ x: -D + spec.w, z: -D }];
  for (let i = 0; i <= ARC_SEG; i++) A.push(pt(-Math.PI / 2 - (Math.PI / 4) * (i / ARC_SEG)));
  const B = [];
  for (let i = 0; i <= ARC_SEG; i++) B.push(pt(-Math.PI * 0.75 - (Math.PI / 4) * (i / ARC_SEG)));
  B.push({ x: -D, z: -D + spec.w });
  return { A, B, D, R };
}

/** 弧段采样点（局部坐标，上下沿各一圈）：给 content3d.js 估算 RT 视锥需要
 *  外扩多少（over-scan）—— 平面段顶点本来就落在参考面上，不会越界；
 *  弧段顶点在不理想的视点下会算出 u<0 / u>1，越界部分被 clamp 拉成竖带。 */
export function cornerArcSamples(spec, radius) {
  const R = clampArcRadius(spec, radius);
  if (!R) return null;
  const y0 = spec.y - spec.h / 2, y1 = spec.y + spec.h / 2;
  const { A, B } = arcPolys(spec, R);
  const pack = (poly) => {
    const out = [];
    for (const p of poly) {
      out.push(new THREE.Vector3(p.x, y0, p.z), new THREE.Vector3(p.x, y1, p.z));
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
    this.spec = { w: spec.w, h: spec.h, y: spec.y };
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

  /** 用 content3d.js 渲染 RT 时的同一组离轴矩阵重写屏面 UV。
   *  @param {THREE.Matrix4[]} matrices [A 面, B 面]（世界坐标投影矩阵）
   *  @param {number} [seq] 矩阵批次号：同一批次不重复投影（省掉无谓的缓冲上传）
   *  只在圆角屏（R>0）有意义：直角面片本身就贴在参考面上，UV 恒等于 0..1。 */
  updateProj(matrices, seq) {
    if (!matrices || matrices.length < 2) return;
    if (this.radius === 0) return;       // 直角：proj 恒等于 full，零开销
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

  /** 直角路径：与移植前 mounts.js 的 corner3d 逐项一致（方盒塔体 + 檐口 + 两块面片） */
  _buildSharp() {
    const { w, h, y } = this.spec;
    const towerW = w + TOWER_EXTRA;
    const totalH = y + h / 2 + 0.6;
    this._housing = housingMat();
    this._trimMat = trimMat();

    const box = new THREE.Mesh(new THREE.BoxGeometry(towerW, totalH, towerW), this._housing);
    box.position.set(0, totalH / 2, 0);
    box.castShadow = true; box.receiveShadow = true;
    this._addBuilt(box);

    const trim = new THREE.Mesh(new THREE.BoxGeometry(towerW + 0.3, 0.5, towerW + 0.3), this._trimMat);
    trim.position.set(0, totalH + 0.25, 0);
    trim.castShadow = false; trim.receiveShadow = true;
    this._addBuilt(trim);

    const D = cornerD(this.spec);
    const y0 = y - h / 2, y1 = y + h / 2;
    const x1 = -D + w;
    // A 面朝 -Z（右缘 = 转角棱线）、B 面朝 -X（左缘 = 转角棱线），两面共享棱线 (-D,-D)
    const quads = [
      { face: 0, pa: [x1, -D], pb: [-D, -D] },
      { face: 1, pa: [-D, -D], pb: [-D, x1] },
    ];
    for (const q of quads) {
      const geom = quadStrip(q.pa, q.pb, y0, y1);
      const mesh = new THREE.Mesh(geom, this.mats[q.face]);
      mesh.castShadow = false;
      this.group.add(mesh);
      const attr = geom.attributes.uv;
      // 直角面片顶点全在参考平面上：离轴投影结果恒等于面片自身 UV(0..1)
      const full = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
      const off = q.face === 0 ? 0 : 0.5;
      const plane = new Float32Array([off, 0, off + 0.5, 0, off + 0.5, 1, off, 1]);
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
    this._buildRoundedTower(half, D, R, totalH);
  }

  _buildFaceStrips(faceIndex, poly, y0, y1) {
    // 弧长参数化：u 沿本面屏面等距展开（平面段与弧段同一密度，不压缩弧段纹理）
    const s = [0];
    for (let i = 1; i < poly.length; i++) {
      s.push(s[i - 1] + Math.hypot(poly[i].x - poly[i - 1].x, poly[i].z - poly[i - 1].z));
    }
    const total = s[s.length - 1] || 1;
    const off = faceIndex === 0 ? 0 : 0.5;   // 整屏平面：A 取画布左半、B 取右半

    for (let i = 0; i < poly.length - 1; i++) {
      const p0 = poly[i], p1 = poly[i + 1];
      const geom = quadStrip([p0.x, p0.z], [p1.x, p1.z], y0, y1);
      const mesh = new THREE.Mesh(geom, this.mats[faceIndex]);
      mesh.castShadow = false;
      this.group.add(mesh);
      const attr = geom.attributes.uv;

      const u0 = s[i] / total, u1 = s[i + 1] / total;
      const full = new Float32Array([u0, 0, u1, 0, u1, 1, u0, 1]);
      const plane = new Float32Array([
        off + u0 * 0.5, 0, off + u1 * 0.5, 0,
        off + u1 * 0.5, 1, off + u0 * 0.5, 1,
      ]);
      this._records.push({ mesh, geom, face: faceIndex, attr, full, plane, proj: full.slice() });
    }
  }

  /** 圆角塔体：屏面折线沿法线内缩 SCREEN_OFFSET 后的轮廓沿 Y 挤出 */
  _buildRoundedTower(half, D, R, totalH) {
    this._housing = housingMat();
    this._trimMat = trimMat();

    const tower = new THREE.Mesh(this._towerGeom(half, D, R - SCREEN_OFFSET, totalH, 0), this._housing);
    tower.castShadow = true; tower.receiveShadow = true;
    this._addBuilt(tower);

    // 檐口：同一轮廓外扩 0.15m、高 0.5m，叠在塔顶（直角路径同款比例）
    const trim = new THREE.Mesh(
      this._towerGeom(half + 0.15, D, R - SCREEN_OFFSET + 0.15, 0.5, totalH),
      this._trimMat,
    );
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

/** 一条竖直条带的四边形（4 顶点 + 索引）：顶点序 pa(左下) → pb(右下) → pd(右上) → pc(左上)，
 *  与 mounts.js quadGeom 同一绕序（right×up = 屏面外法线），UV 先给 0..1 由调用方覆写。 */
function quadStrip(p0, p1, y0, y1) {
  const geom = new THREE.BufferGeometry();
  const pos = [
    p0[0], y0, p0[1],
    p1[0], y0, p1[1],
    p1[0], y1, p1[1],
    p0[0], y1, p0[1],
  ];
  geom.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geom.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geom.setIndex([0, 1, 2, 0, 2, 3]);
  geom.computeVertexNormals();
  return geom;
}

export { NEAR as ARC_CAM_NEAR, FAR as ARC_CAM_FAR };
