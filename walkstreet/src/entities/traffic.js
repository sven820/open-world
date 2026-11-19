import * as THREE from "three";
import { buildCar, buildBus, buildScooter } from "./models.js";
import { surfaceHeightAt } from "../world/terrain.js";

const CAR_COLORS = [0xe8e8e8, 0x1b1c20, 0xb8bcc2, 0x8a1f24, 0x1f3f7a, 0x2c5a3a, 0xd8d2c4, 0x6a6f78, 0x9a4a1f];
const BUS_COLORS = [0x2a6bc4, 0x2f8a4a, 0xd07a1f];
const SCOOTER_COLORS = [0x63c0a8, 0xd8d8d8, 0x2a2b30, 0xd94a4a, 0x2a5a9a, 0xe8b84a, 0xe86a9a];

function pick(a) { return a[(Math.random() * a.length) | 0]; }
function rand(a, b) { return a + Math.random() * (b - a); }
function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export class Traffic {
  /** @param {number} capacity 实例上限（构建期一次性创建，运行期只切换启用数量） */
  constructor(scene, city, capacity = 38) {
    this.scene = scene;
    this.city = city;
    this.vehicles = [];
    this.night = 0;
    this.active = capacity;
    this.maxDistance = 280;

    const edges = city.edges.filter((e) => e.length > 25);
    for (let i = 0; i < capacity && edges.length; i++) {
      const e = pick(edges);
      const roll = Math.random();
      let group, kind, baseSpeed, len;
      if (roll < 0.12) {
        group = buildBus(pick(BUS_COLORS));
        kind = "bus"; baseSpeed = rand(8, 11); len = 11.2;
      } else if (roll < 0.4) {
        group = buildScooter(pick(SCOOTER_COLORS));
        kind = "scooter"; baseSpeed = rand(11, 15); len = 1.9;
      } else {
        const taxi = Math.random() < 0.22;
        group = buildCar(taxi ? "taxi" : pick(["sedan", "sedan", "suv", "van"]), taxi ? 0xe8c22a : pick(CAR_COLORS));
        kind = taxi ? "taxi" : "car"; baseSpeed = rand(10, 15); len = group.userData.L;
      }
      scene.add(group);
      const lanes = e.laneCount;
      const lane = kind === "scooter" ? 0 : Math.floor(Math.random() * lanes);
      const v = {
        group, kind, edge: e, t: rand(0.08, 0.92), lane,
        speed: baseSpeed, maxSpeed: baseSpeed, len,
        yaw: 0, yawTarget: 0, lat: 0, latTarget: 0,
        stopTimer: 0, waitOffset: Math.random() * 6,
      };
      this.vehicles.push(v);
      this._place(v, 0);
    }
  }

  /** 画面设置：启用车流数量（不重建几何，只切换模拟/绘制范围） */
  setActiveCount(n) {
    this.active = Math.max(0, Math.min(this.vehicles.length, n | 0));
    for (let i = this.active; i < this.vehicles.length; i++) this.vehicles[i].group.visible = false;
  }

  /** 画面设置：车辆显示距离 */
  setMaxDistance(d) {
    this.maxDistance = Math.max(40, d || 280);
  }

  dispose() {
    for (const v of this.vehicles) {
      this.scene.remove(v.group);
      v.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      });
    }
    this.vehicles = [];
  }

  _laneOffset(edge, lane) {
    return edge.median / 2 + 1.7 + lane * 3.4;
  }
  _laneOffsetScooter(edge) {
    return edge.median / 2 + 0.95;
  }

  _sample(v) {
    const e = v.edge;
    const dx = e.to.x - e.from.x;
    const dz = e.to.z - e.from.z;
    const sgn = Math.sign(dx !== 0 ? dx : dz);
    const off = v.kind === "scooter" ? this._laneOffsetScooter(e) : this._laneOffset(e, v.lane);
    let x, z;
    if (e.axis === "z") {
      x = e.from.x + (-sgn) * off;
      z = e.from.z + dz * v.t;
    } else {
      z = e.from.z + sgn * off;
      x = e.from.x + dx * v.t;
    }
    return { x, z, dx, dz };
  }

  _place(v, dt) {
    const p = this._sample(v);
    const dx = v.edge.to.x - v.edge.from.x;
    const dz = v.edge.to.z - v.edge.from.z;
    const targetYaw = Math.atan2(dx, dz);
    v.yawTarget = targetYaw;
    if (dt > 0) {
      v.yaw += wrapAngle(v.yawTarget - v.yaw) * Math.min(1, dt * 6);
    } else {
      v.yaw = v.yawTarget;
    }
    // 统一表面高度（地形塑形 + 路面层高）：旧实现只采车身中心且不加路面偏移，
    // 长车在纵坡上前后轮悬空 / 入地，与描边路重叠时还会陷进路面 16cm。
    const city = this.city, data = city.data;
    const len = Math.hypot(dx, dz) || 1;
    const half = Math.min(4, (v.len || 4) / 2);
    const hx = (dx / len) * half, hz = (dz / len) * half;
    const h = surfaceHeightAt(data, p.x, p.z, city);
    const hF = surfaceHeightAt(data, p.x + hx, p.z + hz, city);
    const hB = surfaceHeightAt(data, p.x - hx, p.z - hz, city);
    const pitch = Math.atan2(hB - hF, 2 * half); // 车头朝局部 +Z：前高 → 抬头
    v.group.position.set(p.x, h + 0.02, p.z);
    v.group.rotation.set(pitch, v.yaw, 0, "YXZ");
  }

  _lightFor(axis) {
    const s = this.city.lightState;
    if (!s) return true;
    if (axis === "z") return s.nsGreen;
    return s.ewGreen;
  }

  _pickNext(v) {
    const node = v.edge.to;
    const key = `${node.x},${node.z}`;
    const outs = this.city.outgoing.get(key) || [];
    const cur = v.edge;
    const cx = cur.to.x - cur.from.x;
    const cz = cur.to.z - cur.from.z;
    const cl = Math.hypot(cx, cz) || 1;
    const candidates = outs.filter((e) => !(e.to.x === cur.from.x && e.to.z === cur.from.z));
    const list = candidates.length ? candidates : outs;
    if (!list.length) return cur;
    let total = 0;
    const weights = list.map((e) => {
      const dx = e.to.x - e.from.x;
      const dz = e.to.z - e.from.z;
      const l = Math.hypot(dx, dz) || 1;
      const dot = (cx / cl) * (dx / l) + (cz / cl) * (dz / l);
      // prefer straight, allow turns
      const w = Math.max(0.15, Math.pow(Math.max(0, dot), 3) * 5 + 0.55);
      total += w;
      return w;
    });
    let r = Math.random() * total;
    for (let i = 0; i < list.length; i++) {
      r -= weights[i];
      if (r <= 0) return list[i];
    }
    return list[list.length - 1];
  }

  update(dt, focus) {
    const vs = this.vehicles;
    const fx = focus ? focus.x : 0;
    const fz = focus ? focus.z : 0;
    const far2 = this.maxDistance * this.maxDistance;
    // simple car-following: slow if another vehicle ahead on same edge/lane
    for (let i = 0; i < this.active; i++) {
      const v = vs[i];
      let target = v.maxSpeed;
      const e = v.edge;
      const distLeft = (1 - v.t) * e.length;
      if (!this._lightFor(e.axis) && distLeft < 15) {
        target = 0;
      }
      for (let j = 0; j < this.active; j++) {
        const o = vs[j];
        if (o === v || o.edge !== e || o.lane !== v.lane) continue;
        if (o.t > v.t) {
          const gap = (o.t - v.t) * e.length;
          if (gap < 11) target = Math.min(target, Math.max(0, (gap - 5) * 1.6));
        }
      }
      // accelerate / brake
      if (v.speed < target) v.speed = Math.min(target, v.speed + dt * 6);
      else v.speed = Math.max(target, v.speed - dt * 14);

      if (v.speed > 0.05) {
        v.t += (v.speed * dt) / e.length;
        if (v.t >= 1) {
          const over = (v.t - 1) * e.length;
          v.edge = this._pickNext(v);
          v.t = Math.min(0.5, over / v.edge.length);
          if (v.kind !== "scooter" && Math.random() < 0.18) {
            v.lane = Math.floor(Math.random() * Math.max(1, v.edge.laneCount));
          }
        }
      }
      this._place(v, dt);
      // 距离裁剪：远处的车不画（也不进阴影 pass），逻辑仍按需停在原地
      const dx = v.group.position.x - fx;
      const dz = v.group.position.z - fz;
      v.group.visible = !focus || dx * dx + dz * dz <= far2;
    }
    // vehicles cast shadows; sun follows handled by environment
  }
}
