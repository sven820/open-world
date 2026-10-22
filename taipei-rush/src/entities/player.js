import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { makePedRig, pedPartGeometry, PED_PARTS } from "./models.js";
import { activeSpawn } from "../data/cityData.js";

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

// 共享加载器：每次重建世界都新建 KTX2/GLTF loader 会产生
// "Multiple active KTX2 loaders" 警告并偶发加载失败（退化成程序化模型）
let _sharedGLTF = null;
function sharedGLTFLoader(renderer) {
  if (!_sharedGLTF) {
    const ktx2 = new KTX2Loader().setTranscoderPath("/basis/").detectSupport(renderer);
    _sharedGLTF = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
  }
  return _sharedGLTF;
}

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
    this.camPanSX = 0;  // left-drag pan, stored in screen space (px) so it stays view-aligned
    this.camPanSY = 0;
    this.camDist = 5.2; this.minDist = 2.4; this.maxDist = 13;       // walk camera follow distance (wheel zoom)
    this.camDistDrive = 8.5; this.minDistDrive = 4; this.maxDistDrive = 20;

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
      const loader = sharedGLTFLoader(this.renderer);
      if (MeshoptDecoder.ready) await MeshoptDecoder.ready;

      let gltf;
      try {
        gltf = await loader.loadAsync("/avatars/jie.glb");
      } catch {
        // 一次重试：dev server 冷启动/瞬时网络问题导致的失败
        await new Promise((r) => setTimeout(r, 800));
        gltf = await loader.loadAsync("/avatars/jie.glb");
      }
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
    const s = activeSpawn();
    let x = s.x, z = s.z;
    // 兜底：出生点若落在建筑内（用户编辑地图后可能发生），吸附到最近的马路
    if (this.city && this.city.colliders && this.city.colliders.blocked(x, z, this.radius + 0.25)) {
      const p = this.city.nearestRoadPoint(x, z);
      if (p) { x = p.x; z = p.z; }
    }
    this.pos.set(x, 0.16, z);
    this.yaw = s.heading != null ? s.heading : -Math.PI / 2;
    this.facing = this.yaw;
    this.root.position.copy(this.pos);
    this.root.rotation.y = this.yaw;
    this.camera.position.set(x, 3, z - 10);
  }

  dispose() {
    this.setEnabled(false);
    this.scene.remove(this.root);
    this.root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    });
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

    // mouse look: left-drag pans, right-drag rotates (yaw/pitch)
    const mx = input.mouseDX, my = input.mouseDY;
    input.mouseDX = 0; input.mouseDY = 0;
    this.yaw -= mx * 0.0024;
    this.pitch += my * 0.0022;
    this.pitch = Math.max(-1.15, Math.min(1.2, this.pitch));

    // wheel → zoom the camera (change follow distance), not rotate
    if (input.wheelDY) {
      const step = input.wheelDY * 0.01;
      this.camDist = Math.max(this.minDist, Math.min(this.maxDist, this.camDist + step));
      this.camDistDrive = Math.max(this.minDistDrive, Math.min(this.maxDistDrive, this.camDistDrive + step));
    }

    // left-drag → pan (move) the map view; accumulate in screen space so the
    // direction always matches the cursor regardless of camera rotation
    const pdx = input.panDX, pdy = input.panDY;
    if (pdx || pdy) {
      this.camPanSX += pdx;
      this.camPanSY += pdy;
      const lim = 2400;
      this.camPanSX = Math.max(-lim, Math.min(lim, this.camPanSX));
      this.camPanSY = Math.max(-lim, Math.min(lim, this.camPanSY));
    }

    if (this.driving) {
      this._drive(dt, input);
    } else {
      this._roadAssist(dt, input);
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

  // Gentle "walk along the road" assist: while moving on foot and not actively
  // looking around, ease the view (and thus the movement direction) onto the
  // axis of the road the player is standing on. Without this, a camera that is
  // even slightly off the road makes W drift across lanes ("歪着走"). We only
  // nudge when already roughly aligned, so deliberately crossing a street or
  // walking off-road is never fought.
  _roadAssist(dt, input) {
    if (!this.city || this.driving) return;
    if (!(input.down("KeyW") || input.down("KeyS"))) return;
    if (input.mouseDX || input.mouseDY) return; // user is rotating the view
    const corridor = (r) => r.lanes * 3.4 + r.median / 2 + r.sidewalk + 1.5;
    const onAxis = (roads, p) => {
      let best = null, bd = Infinity;
      for (const r of roads || []) {
        const d = Math.abs(p - r.at);
        if (d < corridor(r) && d < bd) { bd = d; best = r; }
      }
      return best;
    };
    const rx = onAxis(this.city.roadsX, this.pos.x);
    const rz = onAxis(this.city.roadsZ, this.pos.z);
    const cands = [];
    if (rx) cands.push(0, Math.PI);            // vertical road runs along ±Z
    if (rz) cands.push(Math.PI / 2, -Math.PI / 2); // horizontal road runs along ±X
    if (!cands.length) return;
    const ang = (a) => {
      let d = a - this.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      return d;
    };
    let target = null, bd = Infinity;
    for (const c of cands) {
      const d = Math.abs(ang(c));
      if (d < bd) { bd = d; target = c; }
    }
    if (target === null || bd > 0.7) return; // too far off → likely intentional
    this.yaw += ang(target) * Math.min(1, dt * 1.6);
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

  // March a 2D ray from the player to the desired camera spot and return the
  // fraction of the distance that is clear of buildings (>= 0.14 so the camera
  // never collapses fully onto the player).
  _cameraHitXZ(ax, az, tx, tz, r) {
    const col = this.city && this.city.colliders;
    if (!col || !col.blocked) return 1;
    const dx = tx - ax, dz = tz - az;
    const len = Math.hypot(dx, dz);
    if (len < 0.001) return 1;
    const ux = dx / len, uz = dz / len;
    const step = 0.4;
    for (let d = step; d < len; d += step) {
      if (col.blocked(ax + ux * d, az + uz * d, r)) {
        return Math.max(0.14, (d - step) / len);
      }
    }
    return 1;
  }

  _updateCamera() {
    const cam = this.camera;
    // screen-relative pan offset, converted with the CURRENT yaw so it always
    // follows the view (grab-style: the world moves with the cursor)
    const k = 0.06;
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);   // camera screen-right on ground
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);   // camera forward on ground
    const offX = (rx * this.camPanSX + fx * this.camPanSY) * k;
    const offZ = (rz * this.camPanSX + fz * this.camPanSY) * k;
    let cp, look, lerpK;
    if (this.driving) {
      const dist = this.camDistDrive, height = 3.6;
      cp = new THREE.Vector3(
        this.drivePos.x - Math.sin(this.driveYaw) * dist * Math.cos(this.pitch * 0.4) + offX,
        this.drivePos.y + height - this.pitch * 3,
        this.drivePos.z - Math.cos(this.driveYaw) * dist * Math.cos(this.pitch * 0.4) + offZ
      );
      look = new THREE.Vector3(
        this.drivePos.x + Math.sin(this.driveYaw) * 6 + offX,
        this.drivePos.y + 2.2,
        this.drivePos.z + Math.cos(this.driveYaw) * 6 + offZ
      );
      lerpK = 0.18;
    } else {
      const dist = this.camDist, height = 2.4;
      cp = new THREE.Vector3(
        this.pos.x - Math.sin(this.yaw) * dist * Math.cos(this.pitch) + offX,
        this.pos.y + height + Math.sin(this.pitch) * dist,
        this.pos.z - Math.cos(this.yaw) * dist * Math.cos(this.pitch) + offZ
      );
      look = new THREE.Vector3(
        this.pos.x + Math.sin(this.yaw) * 4 + offX,
        this.pos.y + 1.5,
        this.pos.z + Math.cos(this.yaw) * 4 + offZ
      );
      lerpK = 0.25;
    }

    // keep the camera above the street: at strong upward pitch (and/or a
    // zoomed-out follow distance) sin(pitch)*dist would otherwise sink the
    // camera below the ground plane.
    const camFloor = this.pos.y + 0.8;
    if (cp.y < camFloor) cp.y = camFloor;

    // camera collision: if a building sits between the player and the desired
    // camera spot, pull the camera in to just in front of it. This stops the
    // camera from embedding in a building (which would make it vanish via
    // back-face culling). Shift the look target by the same delta so the view
    // direction is preserved (avoids staring point-blank at a wall).
    const f = this._cameraHitXZ(this.pos.x, this.pos.z, cp.x, cp.z, 0.6);
    if (f < 1) {
      const nx = this.pos.x + (cp.x - this.pos.x) * f;
      const nz = this.pos.z + (cp.z - this.pos.z) * f;
      const dx = nx - cp.x, dz = nz - cp.z;
      cp.x = nx; cp.z = nz;
      look.x += dx; look.z += dz;
    }

    cam.position.lerp(cp, lerpK);
    cam.lookAt(look);
  }
}
