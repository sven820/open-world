import * as THREE from "three";
import { buildCar, buildBus, buildScooter } from "./models.js";

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
  constructor(scene, city, count = 38) {
    this.scene = scene;
    this.city = city;
    this.vehicles = [];
    this.night = 0;

    const edges = city.edges.filter((e) => e.length > 25);
    for (let i = 0; i < count; i++) {
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
    v.group.position.set(p.x, 0.02, p.z);
    v.group.rotation.y = v.yaw;
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

  update(dt) {
    const vs = this.vehicles;
    // simple car-following: slow if another vehicle ahead on same edge/lane
    for (const v of vs) {
      let target = v.maxSpeed;
      const e = v.edge;
      const distLeft = (1 - v.t) * e.length;
      if (!this._lightFor(e.axis) && distLeft < 15) {
        target = 0;
      }
      for (const o of vs) {
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
    }
    // vehicles cast shadows; sun follows handled by environment
  }
}
