import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { makePedRig, pedPartGeometry, PED_PARTS } from "./models.js";

const skin = new THREE.MeshStandardMaterial({ color: 0xe8b98f, roughness: 0.85 });
const hair = new THREE.MeshStandardMaterial({ color: 0x1b1714, roughness: 0.8 });
const shirt = new THREE.MeshStandardMaterial({ color: 0x2f7a4a, roughness: 0.85 });
const pants = new THREE.MeshStandardMaterial({ color: 0x23252c, roughness: 0.9 });
const shoe = new THREE.MeshStandardMaterial({ color: 0x1c1c1e, roughness: 0.9 });
const cap = new THREE.MeshStandardMaterial({ color: 0xd94a4a, roughness: 0.8 });

const BONE_KEYS = [
  "Bip01 L Thigh", "Bip01 R Thigh", "Bip01 L Calf", "Bip01 R Calf",
  "Bip01 L UpperArm", "Bip01 R UpperArm", "Bip01 L Forearm", "Bip01 R Forearm",
  "Bip01 Spine2", "Bip01 Head",
];

const normBone = (s) => s.replace(/[\s_]/g, "").toLowerCase();

function matFor(name) {
  if (name === "hair") return hair;
  if (name === "head" || name.startsWith("arm")) return skin;
  if (name === "torso") return shirt;
  if (name === "hips" || name.startsWith("leg")) return pants;
  if (name.startsWith("shoe")) return shoe;
  return skin;
}

export class Player {
  constructor(scene, camera, city, renderer) {
    this.scene = scene;
    this.camera = camera;
    this.city = city;
    this.renderer = renderer;
    this.pos = new THREE.Vector3(-160, 0.16, -24);
    this.vel = new THREE.Vector3();
    this.yaw = -Math.PI / 2;
    this.pitch = -0.05;
    this.speed = 0;
    this.facing = -Math.PI / 2;
    this.vy = 0;
    this.grounded = true;
    this.inVehicle = null;
    this.driving = false;
    this.phase = 0;
    this.animTime = 0;
    this.radius = 0.35;
    this.enabled = false;

    // root is the single transform the movement code drives
    this.root = new THREE.Group();
    scene.add(this.root);

    // procedural fallback (shown until the glb avatar is ready)
    this.proc = makePedRig();
    this.root.add(this.proc.root);
    this.partMesh = {};
    for (const name of PED_PARTS) {
      const geo = pedPartGeometry(name);
      const m = new THREE.Mesh(geo, matFor(name));
      m.castShadow = true;
      this.proc[name].add(m);
      this.partMesh[name] = m;
    }
    const cmesh = new THREE.Mesh(new THREE.SphereGeometry(0.145, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.5), cap);
    cmesh.scale.set(1.02, 0.9, 1.02);
    cmesh.translateY(0.16);
    this.proc.head.add(cmesh);

    // glb avatar state
    this.avatar = null;
    this.bones = {};
    this.boneRest = {};
    this._q = new THREE.Quaternion();
    this._axZ = new THREE.Vector3(0, 0, 1);
    this._axX = new THREE.Vector3(1, 0, 0);

    this.groundY = 0.16;
    this.ready = this._loadAvatar();
  }

  async _loadAvatar() {
    try {
      const ktx2 = new KTX2Loader()
        .setTranscoderPath("/basis/")
        .detectSupport(this.renderer);
      const loader = new GLTFLoader()
        .setKTX2Loader(ktx2)
        .setMeshoptDecoder(MeshoptDecoder);
      if (MeshoptDecoder.ready) await MeshoptDecoder.ready;

      const gltf = await loader.loadAsync("/avatars/jie.glb");
      const model = gltf.scene;

      // normalize height and put feet on the ground plane
      const box = new THREE.Box3().setFromObject(model);
      const h = box.max.y - box.min.y;
      const targetH = 1.74;
      const s = h > 0.6 && h < 6 ? targetH / h : 1.08;
      model.scale.setScalar(s);
      model.position.y = -box.min.y * s;
      // source model faces -Z, our rig convention faces +Z
      model.rotation.y = Math.PI;

      model.traverse((o) => {
        if (o.isMesh || o.isSkinnedMesh) {
          o.castShadow = true;
          o.receiveShadow = false;
          o.frustumCulled = false;
        }
        if (o.isBone) {
          this.bones[o.name] = o;
          this.bones[normBone(o.name)] = o;
        }
      });
      for (const key of BONE_KEYS) {
        const b = this.bones[normBone(key)];
        if (b) {
          this.bones[key] = b;
          this.boneRest[key] = b.quaternion.clone();
        }
      }

      this.root.remove(this.proc.root);
      this.avatar = model;
      this.root.add(model);
    } catch (e) {
      console.warn("[player] glb avatar unavailable, keeping procedural rig:", e);
    }
  }

  setEnabled(v) { this.enabled = v; this.root.visible = v && !this.driving; }

  reset() {
    this.pos.set(-160, 0.16, -24);
    this.yaw = -Math.PI / 2; this.facing = -Math.PI / 2;
    this.root.position.copy(this.pos);
    this.root.rotation.y = this.yaw;
    this.camera.position.set(-160, 3, -34);
  }

  _poseProc(walkAmt) {
    const r = this.proc;
    const ph = this.phase;
    const a = walkAmt;
    const ls = Math.sin(ph) * 0.6 * a;
    r.legUL.rotation.x = ls;
    r.legUR.rotation.x = -ls;
    r.legFL.rotation.x = Math.max(0, -Math.sin(ph)) * 0.7 * a;
    r.legFR.rotation.x = Math.max(0, Math.sin(ph)) * 0.7 * a;
    r.armUL.rotation.x = -ls * 0.8;
    r.armUR.rotation.x = ls * 0.8;
    r.armFL.rotation.x = -0.12 + Math.max(0, ls * 0.8) * 0.35;
    r.armFR.rotation.x = -0.12 + Math.max(0, -ls * 0.8) * 0.35;
    r.armUL.rotation.z = -0.06; r.armUR.rotation.z = 0.06;
    r.torso.rotation.y = Math.sin(ph) * 0.05 * a;
    r.head.rotation.y = Math.sin(ph * 0.37) * 0.1;
  }

  _poseAvatar(walkAmt) {
    const ph = this.phase;
    const s = Math.sin(ph);
    const amt = walkAmt;
    const q = this._q;
    const set = (name, axis, ang) => {
      const b = this.bones[name];
      const rest = this.boneRest[name];
      if (!b || !rest) return;
      b.quaternion.copy(rest);
      if (ang) b.quaternion.multiply(q.setFromAxisAngle(axis, ang));
    };

    if (amt > 0.001) {
      const legA = 0.62 * amt;
      set("Bip01 L Thigh", this._axZ, s * legA);
      set("Bip01 R Thigh", this._axZ, -s * legA);
      set("Bip01 L Calf", this._axZ, -Math.max(0, -s) * 0.95 * amt);
      set("Bip01 R Calf", this._axZ, -Math.max(0, s) * 0.95 * amt);
      set("Bip01 L UpperArm", this._axZ, -s * 0.42 * amt);
      set("Bip01 R UpperArm", this._axZ, s * 0.42 * amt);
      set("Bip01 L Forearm", this._axZ, 0.14 * amt + Math.max(0, -s) * 0.22 * amt);
      set("Bip01 R Forearm", this._axZ, 0.14 * amt + Math.max(0, s) * 0.22 * amt);
      set("Bip01 Spine2", this._axX, Math.sin(ph) * 0.05 * amt);
      set("Bip01 Head", this._axX, -Math.sin(ph) * 0.03 * amt);
    } else {
      // idle: restore rest pose + gentle breathing
      const br = Math.sin(this.animTime * 1.6) * 0.016;
      set("Bip01 Spine2", this._axX, br);
      for (const k of BONE_KEYS) {
        if (k === "Bip01 Spine2") continue;
        const b = this.bones[k], rest = this.boneRest[k];
        if (b && rest) b.quaternion.copy(rest);
      }
    }
  }

  enterPrompt() {
    if (this.driving || !this.city) return null;
    let best = null, bd = 4.2;
    for (const v of this.city.traffic ? this.city.traffic.vehicles : []) {
      const d = Math.hypot(v.group.position.x - this.pos.x, v.group.position.z - this.pos.z);
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }

  enter(v) {
    if (!v) return;
    this.driving = true;
    this.inVehicle = v;
    this.root.visible = false;
    this.city.traffic.vehicles = this.city.traffic.vehicles.filter((x) => x !== v);
    this.driveYaw = v.group.rotation.y;
    this.driveSpeed = 0;
    this.drivePos = v.group.position.clone();
  }

  exit() {
    const v = this.inVehicle;
    if (!v) return;
    // place player beside vehicle
    const side = 2.4;
    const off = new THREE.Vector3(Math.cos(this.driveYaw) * side, 0, -Math.sin(this.driveYaw) * side);
    this.pos.set(v.group.position.x + off.x, this.groundY, v.group.position.z + off.z);
    this.city.colliders.resolve(this.pos, this.radius);
    this.driving = false;
    this.root.visible = true;
    // re-add to traffic at nearest edge
    const e = this.city.nearestEdge(this.drivePos.x, this.drivePos.z);
    if (e) { v.edge = e.edge; v.t = e.t; v.lane = e.lane; }
    this.city.traffic.vehicles.push(v);
    this.inVehicle = null;
    this.facing = this.driveYaw;
    this.yaw = this.driveYaw;
  }

  update(dt, input) {
    if (!this.enabled) return;
    this.animTime += dt;

    // mouse look (+ trackpad wheel for Mac gesture control)
    const mx = input.mouseDX, my = input.mouseDY;
    input.mouseDX = 0; input.mouseDY = 0;
    this.yaw -= mx * 0.0024 + input.wheelDX * 0.0016;
    this.pitch -= my * 0.0022 + input.wheelDY * 0.0014;
    this.pitch = Math.max(-0.55, Math.min(0.95, this.pitch));

    if (this.driving) {
      this._drive(dt, input);
    } else {
      this._walk(dt, input);
    }

    this._updateCamera();
  }

  _walk(dt, input) {
    const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    // camera screen-right (matches _updateCamera offset) = (-cos yaw, 0, sin yaw)
    const right = new THREE.Vector3(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
    const move = new THREE.Vector3();
    if (input.down("KeyW")) move.add(fwd);
    if (input.down("KeyS")) move.sub(fwd);
    if (input.down("KeyD")) move.add(right);
    if (input.down("KeyA")) move.sub(right);

    const sprint = input.down("ShiftLeft") || input.down("ShiftRight");
    const maxSpeed = sprint ? 6.4 : 3.4;
    let walkAmt = 0;
    if (move.lengthSq() > 0) {
      move.normalize();
      this.pos.x += move.x * maxSpeed * dt;
      this.pos.z += move.z * maxSpeed * dt;
      this.facing = Math.atan2(move.x, move.z);
      walkAmt = 1;
    }
    // collision
    this.city.colliders.resolve(this.pos, this.radius);

    // jump
    if (input.pressed("Space") && this.grounded) { this.vy = 6.2; this.grounded = false; }
    this.vy -= 22 * dt;
    this.pos.y += this.vy * dt;
    if (this.pos.y <= this.groundY) { this.pos.y = this.groundY; this.vy = 0; this.grounded = true; }

    // animation
    this.phase += dt * (walkAmt ? (sprint ? 13 : 9) : 0);
    const bob = walkAmt ? Math.abs(Math.sin(this.phase)) * 0.04 : 0;
    this.root.position.set(this.pos.x, this.pos.y + bob, this.pos.z);
    // smooth facing
    const cur = this.root.rotation.y;
    let diff = this.facing - cur;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.root.rotation.y = cur + diff * Math.min(1, dt * 12);
    if (this.avatar) this._poseAvatar(walkAmt);
    else this._poseProc(walkAmt);
    this.root.updateMatrixWorld(true);
  }

  _drive(dt, input) {
    const v = this.inVehicle;
    const accel = 14, brake = 22, maxF = 38, maxR = -10;
    if (input.down("KeyW")) this.driveSpeed += accel * dt;
    else if (input.down("KeyS")) this.driveSpeed -= brake * dt;
    else this.driveSpeed *= (1 - dt * 1.8);
    this.driveSpeed = Math.max(maxR - 6, Math.min(maxF, this.driveSpeed));

    const steer = (input.down("KeyA") ? 1 : 0) - (input.down("KeyD") ? 1 : 0);
    const hand = input.down("Space");
    const steerRate = (this.driveSpeed !== 0 ? 1.8 : 0) * (hand ? 2.4 : 1) * dt;
    this.driveYaw += steer * steerRate * Math.sign(this.driveSpeed || 1);

    const step = this.driveSpeed * dt;
    this.drivePos.x += Math.sin(this.driveYaw) * step;
    this.drivePos.z += Math.cos(this.driveYaw) * step;

    this.city.colliders.resolve(this.drivePos, v.userData.W * 0.5 + 0.3);
    v.group.position.set(this.drivePos.x, 0.02, this.drivePos.z);
    v.group.rotation.y = this.driveYaw;

    // update camera target height etc
    this.pos.copy(this.drivePos);
  }

  _updateCamera() {
    const cam = this.camera;
    if (this.driving) {
      const dist = 8.5, height = 3.6;
      const cp = new THREE.Vector3(
        this.drivePos.x - Math.sin(this.driveYaw) * dist * Math.cos(this.pitch * 0.4),
        this.drivePos.y + height - this.pitch * 3,
        this.drivePos.z - Math.cos(this.driveYaw) * dist * Math.cos(this.pitch * 0.4)
      );
      cam.position.lerp(cp, 0.18);
      const look = new THREE.Vector3(
        this.drivePos.x + Math.sin(this.driveYaw) * 6,
        this.drivePos.y + 2.2,
        this.drivePos.z + Math.cos(this.driveYaw) * 6
      );
      cam.lookAt(look);
      return;
    }
    const dist = 5.2, height = 2.4;
    const cp = new THREE.Vector3(
      this.pos.x - Math.sin(this.yaw) * dist * Math.cos(this.pitch),
      this.pos.y + height + Math.sin(this.pitch) * dist,
      this.pos.z - Math.cos(this.yaw) * dist * Math.cos(this.pitch)
    );
    cam.position.lerp(cp, 0.25);
    const look = new THREE.Vector3(
      this.pos.x + Math.sin(this.yaw) * 4,
      this.pos.y + 1.5,
      this.pos.z + Math.cos(this.yaw) * 4
    );
    cam.lookAt(look);
  }
}
