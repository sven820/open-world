import * as THREE from "three";
import {
  PED_PARTS, pedPartGeometry, makePedRig,
  SKIN_TONES, HAIR_COLORS, CLOTH_COLORS, PANTS_COLORS,
} from "./models.js";
import { surfaceHeightAt } from "../world/terrain.js";

const _partMap = {
  head: "head", hair: "hair", torso: "torso", hips: "hips",
  armUL: "armUL", armUR: "armUR", armFL: "armFL", armFR: "armFR",
  legUL: "legUL", legUR: "legUR", legFL: "legFL", legFR: "legFR",
  shoeL: "shoeL", shoeR: "shoeR",
};

function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }
function rand(a, b) { return a + Math.random() * (b - a); }

function sampleLoop(loop, s) {
  let d = ((s % loop.total) + loop.total) % loop.total;
  for (const seg of loop.segs) {
    if (d <= seg.len) {
      const t = d / seg.len;
      return {
        x: seg.a.x + (seg.b.x - seg.a.x) * t,
        z: seg.a.z + (seg.b.z - seg.a.z) * t,
        dx: (seg.b.x - seg.a.x) / seg.len,
        dz: (seg.b.z - seg.a.z) / seg.len,
      };
    }
    d -= seg.len;
  }
  return { x: loop.pts[0].x, z: loop.pts[0].z, dx: 1, dz: 0 };
}

export class PedestrianCrowd {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../world/city.js').City} city
   * @param {number} capacity 实例化容量（按上限一次性分配，运行期只切换启用数量）
   */
  constructor(scene, city, capacity = 240) {
    this.scene = scene;
    this.city = city;
    this.capacity = capacity;
    this.count = capacity;          // 当前启用数量（画面设置可调）
    this.maxDistance = 140;         // 超出该距离的行人不进绘制列表
    this.drawn = 0;
    this.peds = [];
    this.rig = makePedRig();
    this.meshes = {};
    this._col = new THREE.Color();
    // slot -> ped：矩阵按距离压缩重排，只有"这个槽换了人"时才重写实例颜色
    this._slotPed = new Array(capacity).fill(null);

    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0.0 });
    const flat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0.0 });

    for (const name of PED_PARTS) {
      const geo = pedPartGeometry(name);
      const m = new THREE.InstancedMesh(geo, (name === "hair" || name === "shoeL" || name === "shoeR") ? flat : mat, capacity);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.castShadow = true;
      m.receiveShadow = true;
      // 实例矩阵每帧重排（按距离压缩），包围球不能反映真实范围，关掉视锥剔除自己管
      m.frustumCulled = false;
      m.count = 0;
      scene.add(m);
      this.meshes[name] = m;
    }

    const loops = city.sidewalkLoops.filter((l) => l.total > 12);
    for (let i = 0; i < capacity && loops.length; i++) {
      const loop = pick(loops);
      const p = {
        loop,
        s: Math.random() * loop.total,
        dir: Math.random() < 0.5 ? 1 : -1,
        speed: rand(1.05, 1.65),
        scale: rand(0.92, 1.07),
        phase: Math.random() * Math.PI * 2,
        pause: 0,
        idle: Math.random() < 0.06,
        bob: Math.random() * 6,
      };
      if (p.idle) p.pause = rand(1, 6);
      // 各部件配色在构建期算一次，运行期（槽位换人时）直接取用
      const skin = pick(SKIN_TONES), hair = pick(HAIR_COLORS);
      const shirt = pick(CLOTH_COLORS), pants = pick(PANTS_COLORS);
      const shoes = pick([0x1c1c1e, 0x2a2a2c, 0x6b5a45, 0xe8e8e8, 0x3a3a40]);
      p.colors = {
        head: skin, hair, torso: shirt, hips: pants,
        armUL: skin, armUR: skin, armFL: skin, armFR: skin,
        legUL: pants, legUR: pants, legFL: pants, legFR: pants,
        shoeL: shoes, shoeR: shoes,
      };
      this.peds.push(p);
    }

    this._updateRigMatrices(0, null);
  }

  /** 画面设置：启用人数（不重建实例，只改更新/绘制范围） */
  setActiveCount(n) {
    // 空地图（没有可用人行道）时 peds 可能为空，上限取三层最小值
    this.count = Math.max(0, Math.min(this.capacity, this.peds.length, n | 0));
    for (let i = this.count; i < this.capacity; i++) this._slotPed[i] = null;
  }

  /** 画面设置：行人显示距离 */
  setMaxDistance(d) {
    this.maxDistance = Math.max(20, d || 140);
  }

  dispose() {
    for (const name of Object.keys(this.meshes)) {
      const m = this.meshes[name];
      this.scene.remove(m);
      m.geometry.dispose();
      if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((mm) => mm.dispose());
    }
    this.meshes = {};
    this.peds = [];
    this._slotPed = [];
  }

  _pose(p) {
    const r = this.rig;
    const ph = p.phase;
    const amp = p.idle || p.pause > 0 ? 0.05 : 1;
    const legSwing = Math.sin(ph) * 0.62 * amp;
    const armSwing = Math.sin(ph) * 0.52 * amp;

    r.legUL.rotation.x = legSwing;
    r.legUR.rotation.x = -legSwing;
    r.legFL.rotation.x = Math.max(0, -Math.sin(ph)) * 0.7 * amp;
    r.legFR.rotation.x = Math.max(0, Math.sin(ph)) * 0.7 * amp;
    r.armUL.rotation.x = -armSwing;
    r.armUR.rotation.x = armSwing;
    r.armFL.rotation.x = -0.12 + Math.max(0, armSwing) * 0.35;
    r.armFR.rotation.x = -0.12 + Math.max(0, -armSwing) * 0.35;
    r.armUL.rotation.z = -0.06;
    r.armUR.rotation.z = 0.06;
    r.torso.rotation.y = Math.sin(ph) * 0.05 * amp;
    r.torso.rotation.z = Math.sin(ph * 0.5) * 0.015;
    r.head.rotation.y = Math.sin(ph * 0.37 + p.bob) * 0.12;
    r.head.rotation.x = 0;
  }

  _writeSlotColors(slot, p) {
    for (const name of PED_PARTS) this.meshes[name].setColorAt(slot, this._col.setHex(p.colors[name]));
  }

  // focus 为空 = 首次全量写（初始化）；否则按距离裁剪并把可见行人压缩到 0..n-1 槽位
  _updateRigMatrices(dt, focus) {
    const rig = this.rig;
    const slotPed = this._slotPed;
    const far2 = focus ? this.maxDistance * this.maxDistance : Infinity;
    let slot = 0;
    let colorDirty = false;

    for (let i = 0; i < this.count; i++) {
      const p = this.peds[i];
      if (!p) continue;
      const pos = sampleLoop(p.loop, p.s);
      if (focus) {
        const dx = pos.x - focus.x, dz = pos.z - focus.z;
        if (dx * dx + dz * dz > far2) continue;
      }
      if (slotPed[slot] !== p) {
        slotPed[slot] = p;
        this._writeSlotColors(slot, p);
        colorDirty = true;
      }

      // when walking backwards, tangent flips
      const hx = pos.dx * p.dir;
      const hz = pos.dz * p.dir;
      const yaw = Math.atan2(hx, hz);
      const bob = p.pause > 0 ? 0 : Math.abs(Math.sin(p.phase)) * 0.035;
      // 行人沿 sidewalkLoops 走：旧实现固定 y=0.16，坡地上整排人悬空或入地。
      // 与玩家 / 车辆共用 surfaceHeightAt，始终踩在地形 + 所在表面层高上。
      rig.root.position.set(pos.x, surfaceHeightAt(this.city.data, pos.x, pos.z, this.city) + bob, pos.z);
      rig.root.rotation.y = yaw;
      rig.root.scale.setScalar(p.scale);
      this._pose(p);
      rig.root.updateMatrixWorld(true);

      for (const name of PED_PARTS) {
        this.meshes[name].setMatrixAt(slot, rig[_partMap[name]].matrixWorld);
      }
      slot++;
    }

    this.drawn = slot;
    for (const name of PED_PARTS) {
      const mesh = this.meshes[name];
      mesh.count = slot;
      if (slot > 0) mesh.instanceMatrix.needsUpdate = true;
      if (colorDirty && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  update(dt, focus) {
    const n = Math.min(this.count, this.peds.length);
    for (let i = 0; i < n; i++) {
      const p = this.peds[i];
      if (!p) continue;
      if (p.pause > 0) {
        p.pause -= dt;
        continue;
      }
      const dist = p.speed * dt;
      p.s += dist * p.dir;
      p.phase += dist * 3.1;
      if (p.phase > 1e6) p.phase = 0;
      // occasional stop to look at a shop
      if (Math.random() < dt * 0.012) p.pause = rand(1.2, 4.5);
    }
    this._updateRigMatrices(dt, focus);
  }
}
