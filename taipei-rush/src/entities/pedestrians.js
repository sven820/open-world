import * as THREE from "three";
import {
  PED_PARTS, pedPartGeometry, makePedRig,
  SKIN_TONES, HAIR_COLORS, CLOTH_COLORS, PANTS_COLORS,
} from "./models.js";

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
  constructor(scene, city, count = 230) {
    this.city = city;
    this.count = count;
    this.peds = [];
    this.rig = makePedRig();
    this.meshes = {};
    this._m = new THREE.Matrix4();
    this._v = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();

    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0.0 });
    const flat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0.0 });

    for (const name of PED_PARTS) {
      const geo = pedPartGeometry(name);
      const m = new THREE.InstancedMesh(geo, (name === "hair" || name === "shoeL" || name === "shoeR") ? flat : mat, count);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      scene.add(m);
      this.meshes[name] = m;
    }

    const loops = city.sidewalkLoops.filter((l) => l.total > 12);
    const col = new THREE.Color();
    for (let i = 0; i < count; i++) {
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
        skin: pick(SKIN_TONES),
        hair: pick(HAIR_COLORS),
        shirt: pick(CLOTH_COLORS),
        pants: pick(PANTS_COLORS),
        shoes: pick([0x1c1c1e, 0x2a2a2c, 0x6b5a45, 0xe8e8e8, 0x3a3a40]),
        bob: Math.random() * 6,
      };
      if (p.idle) p.pause = rand(1, 6);
      this.peds.push(p);

      // instance colours
      const set = (name, c) => this.meshes[name].setColorAt(i, col.setHex(c));
      set("head", p.skin);
      set("hair", p.hair);
      set("torso", p.shirt);
      set("hips", p.pants);
      set("armUL", p.skin); set("armUR", p.skin);
      set("armFL", p.skin); set("armFR", p.skin);
      set("legUL", p.pants); set("legUR", p.pants);
      set("legFL", p.pants); set("legFR", p.pants);
      set("shoeL", p.shoes); set("shoeR", p.shoes);
    }
    for (const name of PED_PARTS) {
      if (this.meshes[name].instanceColor) this.meshes[name].instanceColor.needsUpdate = true;
    }

    this._base = new THREE.Vector3();
    this._updateRigMatrices(0);
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

  _updateRigMatrices(dt) {
    const rig = this.rig;
    const m = this._m;
    for (let i = 0; i < this.peds.length; i++) {
      const p = this.peds[i];
      const pos = sampleLoop(p.loop, p.s);
      // when walking backwards, tangent flips
      const hx = pos.dx * p.dir;
      const hz = pos.dz * p.dir;
      const yaw = Math.atan2(hx, hz);
      const bob = p.pause > 0 ? 0 : Math.abs(Math.sin(p.phase)) * 0.035;
      rig.root.position.set(pos.x, 0.16 + bob, pos.z);
      rig.root.rotation.y = yaw;
      rig.root.scale.setScalar(p.scale);
      this._pose(p);
      rig.root.updateMatrixWorld(true);

      for (const name of PED_PARTS) {
        const obj = rig[_partMap[name]];
        this.meshes[name].setMatrixAt(i, obj.matrixWorld);
      }
    }
    for (const name of PED_PARTS) this.meshes[name].instanceMatrix.needsUpdate = true;
  }

  update(dt) {
    for (const p of this.peds) {
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
    this._updateRigMatrices(dt);
  }
}
