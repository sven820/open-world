import * as THREE from "three/webgpu";
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
    this.camPanX = 0;   // left-drag pan, stored in world meters (converted at
    this.camPanZ = 0;   // drag time) so zooming keeps the panned spot in place
    // 第三人称轨道相机：目标视距由滚轮设定（*Target），实际视距每帧指数逼近，
    // 缩放有惯性但跟手；轨道俯角随视距自动抬高，拉远 = 镜头升空俯瞰，而不是
    // 贴着地面水平飞出几百米（"视角飘走"的根因）。
    this.camDist = 5.4; this.camDistTarget = 5.4;
    this.minDist = 2.2; this.maxDist = 420;
    this.camDistDrive = 9; this.camDistDriveTarget = 9;
    this.minDistDrive = 3.6; this.maxDistDrive = 420;
    this._camClear = 1;      // 建筑遮挡收缩比例（1 = 无遮挡），平滑恢复避免抖动
    this._camLift = 0;       // 浏览时相机越过楼顶的抬升量（米）
    this._lookLock = 0;      // 刚旋转视角的余温：期间不触发"沿路对准"辅助
    this._resetT = 0;        // C 视角复位的过渡计时
    this._pitchTouched = false; // 玩家手动调过俯仰后，拉远不再用 autoMin 强行压住视角

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
    this.poseRest = null;   // 烘焙后的基准姿势（手臂下垂）
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._swingAxis = new THREE.Vector3();

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

      // 烘焙"动作基准姿势"：T-pose 模型把手臂一次性放到自然下垂（局部空间），
      // 之后每帧只叠加小幅摆动 —— 避免每帧大角度拉扯肩部蒙皮造成扭曲。
      model.updateMatrixWorld(true);
      this.poseRest = {};
      const drop = {
        "Bip01 L UpperArm": this._computeArmDrop("Bip01 L UpperArm"),
        "Bip01 R UpperArm": this._computeArmDrop("Bip01 R UpperArm"),
      };
      for (const key of BONE_KEYS) {
        const b = this.bones[key];
        if (!b) continue;
        let pose = this.boneRest[key].clone();
        const d = drop[key];
        if (d) {
          // poseLocal = parentWorldInv(rest 链) * dropWorld * restWorld
          const qp = new THREE.Quaternion();
          b.parent.getWorldQuaternion(qp);
          const restW = new THREE.Quaternion();
          b.getWorldQuaternion(restW);
          pose = qp.invert().multiply(d).multiply(restW);
        }
        this.poseRest[key] = pose;
      }

      this.root.remove(this.proc.root);
      this.avatar = model;
      this.root.add(model);
    } catch (e) {
      console.warn("[player] glb avatar unavailable, keeping procedural rig:", e);
    }
  }

  setEnabled(v) { this.enabled = v; this.root.visible = v && !this.driving; }

  // 视角复位（C 键）：视距回跟随近景、清取景偏移、俯仰归位 —— 拉到远景迷路时一键回来
  resetView() {
    this.camDistTarget = 5.4;
    this.camDistDriveTarget = 9;
    this._resetT = 0.5;   // 平滑过渡，避免镜头瞬间跳回
    this._pitchTouched = false; // 复位后重新交给"拉远自动抬升"接管
  }

  reset() {
    // 出生点：编辑器设置的 spawn（city.spawnPoint）优先，否则用默认地图出生点
    // （落在建筑内时下方兜底吸附马路）
    const s = (this.city && this.city.spawnPoint) || activeSpawn();
    let x = s.x, z = s.z;
    // 兜底：出生点若落在建筑内（用户编辑地图后可能发生），吸附到最近的马路
    if (this.city && this.city.colliders && this.city.colliders.blocked(x, z, this.radius + 0.25)) {
      const p = this.city.nearestRoadPoint(x, z);
      if (p) { x = p.x; z = p.z; }
    }
    this.groundY = this._groundHeightAt(x, z);
    this.pos.set(x, this.groundY, z);
    this.yaw = s.heading != null ? s.heading : -Math.PI / 2;
    this.facing = this.yaw;
    this.root.position.copy(this.pos);
    this.root.rotation.y = this.yaw;
    this.camPanX = 0; this.camPanZ = 0;
    this.camDist = this.camDistTarget = 5.4;
    this.camDistDrive = this.camDistDriveTarget = 9;
    this._camClear = 1;
    this._lookLock = 0;
    this._pitchTouched = false;
    this._updateCamera(0.016);
  }

  // 脚下表面高度：描边道路路面 0.18 / 人行道 0.24（渲染在平台之上，优先判定）；
  // 街廓人行道平台顶 0.16m；马路 0
  _groundHeightAt(x, z) {
    const city = this.city;
    if (!city) return 0;
    const corridors = city.traceCorridors;
    if (corridors && corridors.length) {
      let best = Infinity, bestC = null;
      for (const c of corridors) {
        for (const s of c.segs) {
          const dx = s.bx - s.ax, dz = s.bz - s.az;
          const len2 = dx * dx + dz * dz;
          const t = Math.min(1, Math.max(0, len2 ? ((x - s.ax) * dx + (z - s.az) * dz) / len2 : 0));
          const d = Math.hypot(x - (s.ax + dx * t), z - (s.az + dz * t));
          if (d < best) { best = d; bestC = c; }
        }
      }
      if (bestC) {
        if (best <= bestC.roadHalf) return 0.18;
        if (best <= bestC.edgeHalf) return 0.24;
      }
    }
    for (const b of city.blocks) {
      if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) return 0.16;
    }
    return 0;
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

  // 计算"把 T-pose 手臂放到自然下垂"所需的世界空间校正四元数
  _computeArmDrop(name) {
    const b = this.bones[name];
    if (!b) return null;
    this.root.updateMatrixWorld(true);
    const child = b.children.find((c) => c.isBone);
    if (!child) return null;
    b.updateWorldMatrix(true, false);
    child.updateWorldMatrix(false, false);
    const dir = new THREE.Vector3().setFromMatrixPosition(child.matrixWorld)
      .sub(new THREE.Vector3().setFromMatrixPosition(b.matrixWorld)).normalize();
    const target = new THREE.Vector3(0, -1, 0);
    if (dir.angleTo(target) < 0.35) return null; // 已接近下垂
    return new THREE.Quaternion().setFromUnitVectors(dir, target);
  }

  // 行走/待机动画：在烘焙基准姿势（手臂下垂）上叠加小幅摆动。
  // 轴与 _walk 的移动轴一致：right=(-cos f,0,sin f) 为角色右轴，
  // 绕 right 正角 = 肢体向前摆；绕 fwd 正角 = 向角色左侧偏（外张）。
  _poseAvatar(walkAmt) {
    const ph = this.phase;
    const s = Math.sin(ph);
    const amt = walkAmt;
    const right = this._swingAxis.set(-Math.cos(this.facing), 0, Math.sin(this.facing)).normalize();
    const fwd = this._v2.set(Math.sin(this.facing), 0, Math.cos(this.facing)).normalize();

    const setJ = (name, swingAng, outAng) => {
      const b = this.bones[name];
      const pr = this.poseRest && this.poseRest[name];
      if (!b || !pr) return;
      // 关节姿势的世界旋转 = 父世界 * 基准姿势；把世界摆动轴转到该局部系
      const qp = new THREE.Quaternion();
      b.parent.getWorldQuaternion(qp);
      const inv = qp.multiply(pr).invert();
      let extra = this._q.setFromAxisAngle(this._v.copy(right).applyQuaternion(inv), swingAng);
      if (outAng) {
        const qo = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3().copy(fwd).applyQuaternion(inv), outAng);
        extra = qo.multiply(extra);
      }
      b.quaternion.copy(pr).multiply(extra);
    };

    const legA = 0.58 * amt, armA = 0.42 * amt;
    const outL = 0.22, outR = -0.22;     // 手臂向外张（正角=向角色左侧）
    const fwdArm = 0.1;                  // 上臂略垂在身体前侧
    if (amt > 0.001) {
      // 腿：对侧交叉摆；膝盖只能向后弯（负角），且只弯摆动腿
      setJ("Bip01 L Thigh", s * legA);
      setJ("Bip01 R Thigh", -s * legA);
      setJ("Bip01 L Calf", -Math.max(0, s) * 0.8 * amt);
      setJ("Bip01 R Calf", -Math.max(0, -s) * 0.8 * amt);
      // 臂：外张 + 前张 + 与同侧腿反相摆动；肘部前屈（正角），前摆臂屈得更深
      setJ("Bip01 L UpperArm", fwdArm - s * armA, outL);
      setJ("Bip01 R UpperArm", fwdArm + s * armA, outR);
      setJ("Bip01 L Forearm", 0.3 + Math.max(0, -s) * 0.25 * amt);
      setJ("Bip01 R Forearm", 0.3 + Math.max(0, s) * 0.25 * amt);
      setJ("Bip01 Spine2", s * 0.04 * amt);
      setJ("Bip01 Head", -Math.sin(ph * 0.37) * 0.04 * amt);
    } else {
      // idle：四肢复位到基准姿势，手臂外张 + 肘部微屈 + 轻微呼吸
      for (const k of BONE_KEYS) {
        if (k === "Bip01 Spine2" || k === "Bip01 Head") continue;
        const b = this.bones[k], pr = this.poseRest && this.poseRest[k];
        if (b && pr) b.quaternion.copy(pr);
      }
      setJ("Bip01 L UpperArm", fwdArm, outL);
      setJ("Bip01 R UpperArm", fwdArm, outR);
      setJ("Bip01 L Forearm", 0.25);
      setJ("Bip01 R Forearm", 0.25);
      setJ("Bip01 Spine2", Math.sin(this.animTime * 1.6) * 0.02);
      setJ("Bip01 Head", Math.sin(this.animTime * 1.2) * 0.03);
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
    this._camClear = 1;
  }

  exit() {
    const v = this.inVehicle;
    if (!v) return;
    // place player beside vehicle
    const side = 2.4;
    const off = new THREE.Vector3(Math.cos(this.driveYaw) * side, 0, -Math.sin(this.driveYaw) * side);
    const gx = v.group.position.x + off.x, gz = v.group.position.z + off.z;
    this.groundY = this._groundHeightAt(gx, gz);
    this.pos.set(gx, this.groundY, gz);
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
    this._camClear = 1;
  }

  update(dt, input) {
    if (!this.enabled) return;
    this.animTime += dt;

    // mouse look: left-drag pans, right-drag rotates (yaw/pitch)
    const mx = input.mouseDX, my = input.mouseDY;
    input.mouseDX = 0; input.mouseDY = 0;
    if (mx || my) this._lookLock = 0.45;
    this._lookLock = Math.max(0, this._lookLock - dt);
    this.yaw -= mx * 0.0024;
    // 玩家一碰俯仰就交出控制权：否则远距离时 _orbitPitch 的 autoMin 会把
    // 向下拖动全部吃掉（表现为"拉远后俯仰调不动"）。
    if (Math.abs(my) > 1e-4) this._pitchTouched = true;
    this.pitch += my * 0.0022;
    this.pitch = Math.max(-1.05, Math.min(1.5, this.pitch));

    // C 视角复位：0.5s 内把俯仰与取景偏移平滑收回（与视距回缩同时进行）
    if (this._resetT > 0) {
      this._resetT = Math.max(0, this._resetT - dt);
      const k = Math.min(1, dt * 10);
      this.pitch += (-0.05 - this.pitch) * k;
      this.camPanX += (0 - this.camPanX) * k;
      this.camPanZ += (0 - this.camPanZ) * k;
    }

    // wheel → 只设定目标视距，由 _updateCamera 平滑逼近。
    // 单次滚动限幅，触控板/高精度滚轮不会一次跳几百米。
    if (input.wheelDY) {
      const dy = Math.max(-240, Math.min(240, input.wheelDY));
      const f = Math.exp(dy * 0.0016);
      if (this.driving) {
        this.camDistDriveTarget = Math.max(
          this.minDistDrive, Math.min(this.maxDistDrive, this.camDistDriveTarget * f)
        );
      } else {
        this.camDistTarget = Math.max(
          this.minDist, Math.min(this.maxDist, this.camDistTarget * f)
        );
      }
    }
    {
      const k = 1 - Math.exp(-dt * 9);   // 缩放惯性（帧率无关）
      this.camDist += (this.camDistTarget - this.camDist) * k;
      this.camDistDrive += (this.camDistDriveTarget - this.camDistDrive) * k;
    }

    // left-drag → pan（地图平移）。像素 → 世界米按"实际视距 + 俯角"换算：
    // 屏幕竖直方向的地面投影被透视压缩 1/sin(俯角)，不补偿的话俯瞰时上下拖比
    // 左右拖慢一拍（发涩）；补偿后水平/竖直速度一致，拖动才是 1:1 抓地。
    const pdx = input.panDX, pdy = input.panDY;
    if (pdx || pdy) {
      const viewDist = this.driving ? this.camDistDrive : this.camDist;
      const p = this._orbitPitch(viewDist);
      // 用相机到注视点的"实际距离"换算，而不是刻度的视距：
      // 浏览时相机会被抬到楼顶上方（_camLift），视野变大，拖动速度必须同步放大，
      // 否则拖半天只挪一点、很快就顶到限幅（"地图挪不动"的根源）。
      const horiz = Math.max(0.001, viewDist * this._camClear * Math.cos(p));
      const vert = viewDist * Math.sin(p) + this._camLift;
      const effDist = Math.hypot(horiz, vert);
      const vh = (typeof window !== "undefined" && window.innerHeight) || 800;
      const kH = Math.max(
        (2 * effDist * Math.tan((this.camera.fov * Math.PI) / 360)) / Math.max(1, vh),
        0.028
      );
      // 近景跟随：水平/竖直同速（均匀取景偏移，可控）；
      // 拉远后（地图模式）：竖直方向按 1/sin(俯角) 补偿地面透视压缩 → 1:1 抓地
      const mapW = Math.min(1, Math.max(0, (effDist - 15) / 45));
      const kV = kH + (kH / Math.max(0.4, Math.sin(Math.max(0.1, p))) - kH) * mapW;
      const yaw = this.driving ? this.driveYaw : this.yaw;
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);  // camera screen-right on ground
      const fx = Math.sin(yaw), fz = Math.cos(yaw);   // camera forward on ground
      // 左右/上下都用摄像机式（鼠标往左拖 → 地图内容往右走；往下拖 → 内容往上走）
      this.camPanX += rx * pdx * kH + fx * pdy * kV;
      this.camPanZ += rz * pdx * kH + fz * pdy * kV;
      // 偏移限幅用固定的视距档位（不能用会被抬升影响的 effDist，否则相机一离开楼群
      // 限幅就骤降、把已拖出的偏移压回去）。给足余量，基本可按整张地图自由平移。
      const lim = Math.max(2400, viewDist * 10);
      const l = Math.hypot(this.camPanX, this.camPanZ);
      if (l > lim) { const f = lim / l; this.camPanX *= f; this.camPanZ *= f; }
    }

    // 平移回中：只在角色真正移动/行驶时收回——静止浏览时镜头不会自己滑走
    {
      const moving = this.driving
        ? Math.abs(this.driveSpeed) > 0.6
        : (input.down("KeyW") || input.down("KeyA") || input.down("KeyS") || input.down("KeyD"));
      if (moving) {
        const d = this.driving ? this.camDistDrive : this.camDist;
        const far = Math.min(1, Math.max(0, (d - 10) / 40)); // 近景立即回中，远景保持浏览位置
        const decay = Math.exp(-dt * (1 - far) * 2.4);
        this.camPanX *= decay;
        this.camPanZ *= decay;
      }
    }

    if (this.driving) {
      this._drive(dt, input);
    } else {
      this._roadAssist(dt, input);
      this._walk(dt, input);
    }

    this._updateCamera(dt);
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

    // jump / ground follow（马路 0，人行道 0.16）
    const g = this._groundHeightAt(this.pos.x, this.pos.z);
    this.groundY = g;
    if (input.pressed("Space") && this.grounded) { this.vy = 6.2; this.grounded = false; }
    this.vy -= 22 * dt;
    this.pos.y += this.vy * dt;
    if (this.pos.y <= g) { this.pos.y = g; this.vy = 0; this.grounded = true; }

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
    if (this._lookLock > 0) return; // user just rotated the view: don't fight it
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

  // 轨道俯角：视距越大，默认俯角越高（12m 内完全由玩家控制，约 210m 时到 64°）。
  // 这条联动是"拉远不飘"的核心：相机沿视距升空俯瞰，而不是贴着地面水平飞出。
  // 但它只作为"玩家还没动过俯仰"时的默认值 —— 一旦玩家自己拖过俯仰，
  // autoMin 就退出，否则远距离时它是个硬下限，向下拖动会被完全吃掉。
  _orbitPitch(dist) {
    const user = this.pitch + 0.2;                        // 基础肩后俯角
    const t = Math.min(1, Math.max(0, (dist - 12) / 150));
    const autoMin = 0.1 + t * 1.05;                       // 12→162m：肩后 → 高空俯瞰
    if (this._pitchTouched) {
      // 接管后只兜底"相机别贴地"：视距越远，要求的最小俯角略高，
      // 12m 内完全放开（-0.12），60m 起约 3.4°（dist=420 时相机仍有 ~25m 高）。
      const minByHeight = -0.12 + Math.min(1, Math.max(0, (dist - 12) / 48)) * 0.18;
      return Math.max(minByHeight, Math.min(1.45, user));
    }
    return Math.max(-0.12, Math.min(1.45, Math.max(user, autoMin)));
  }

  // 3D 采样：从注视点到相机位置之间是否有建筑挡住（考虑楼高，高空俯瞰不误判）。
  // 返回可用的视距比例（>= 0.14，保证相机不会完全贴到角色脸上）。
  _cameraClearFraction(px, py, pz, cx, cy, cz, viewDist) {
    const col = this.city && this.city.colliders;
    if (!col || !col.blocked) return 1;
    // 超过跟随距离就是"地图浏览相机"：自由飞行，不做建筑避让。
    // 否则拖动地图时相机会被沿途的楼反复拽近/弹开（一顿一顿、还会突然跳到楼顶）。
    if (viewDist > 30) return 1;
    // 注视点落在地图上的建筑范围内（俯瞰时把地图拖到楼上）：此时不是"角色被挡"，
    // 不做遮挡 —— 否则一拖到楼上，相机就会猛地收缩到楼顶，像突然跳到建筑上
    if (col.blocked(px, pz, 0.05, py)) return 1;
    const dx = cx - px, dy = cy - py, dz = cz - pz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.8) return 1;
    const steps = Math.min(56, Math.max(12, Math.ceil(len)));
    for (let i = 2; i <= steps; i++) {
      const t = i / steps;
      if (col.blocked(px + dx * t, pz + dz * t, 0.5, py + dy * t)) {
        // 二分细化遮挡边界，并留 0.4m 余量，保证相机不贴进墙面
        let a = (i - 1) / steps, b = t;
        for (let k = 0; k < 6; k++) {
          const m = (a + b) * 0.5;
          if (col.blocked(px + dx * m, pz + dz * m, 0.5, py + dy * m)) b = m; else a = m;
        }
        return Math.max(0.14, a - 0.4 / len);
      }
    }
    return 1;
  }

  _updateCamera(dt) {
    const cam = this.camera;
    const driving = this.driving;
    const dist = driving ? this.camDistDrive : this.camDist;
    const base = driving ? this.drivePos : this.pos;
    const yaw = driving ? this.driveYaw : this.yaw;
    const eyeH = driving ? 1.9 : 1.55;   // 注视点高度（角色胸口 / 车内）

    // 注视点 = 角色 + 左键平移偏移（pivot 不动，缩放围绕它，屏幕中心不滑走）
    const px = base.x + this.camPanX;
    const py = base.y + eyeH;
    const pz = base.z + this.camPanZ;

    const pitch = this._orbitPitch(dist);
    const horiz = dist * Math.cos(pitch);
    const vert = dist * Math.sin(pitch);
    const cx = px - Math.sin(yaw) * horiz;
    const cyBase = py + vert;
    const cz = pz - Math.cos(yaw) * horiz;

    // 拖动地图 / 拉远浏览时相机是"自由观察相机"：不做建筑避让。
    // 否则一拖到楼旁就被拽近、贴墙，表现出来就是"拖不动"。
    const panDist = Math.hypot(this.camPanX, this.camPanZ);
    const exploring = dist > 30 || panDist > 3;

    // 浏览时相机若正好在楼体范围内：平滑抬到该楼顶之上（越过楼飞）——
    // 既不穿模看到楼内部，也不会贴墙。用"未抬升的机位"算目标，避免自我反馈抖动。
    let liftTarget = 0;
    const col = this.city && this.city.colliders;
    if (exploring && col && col.topAt) {
      const top = col.topAt(cx, cz, 0.8);
      if (top + 1.5 > cyBase) liftTarget = Math.min(180, top + 1.5 - cyBase);
    }
    this._camLift += (liftTarget - this._camLift) * (1 - Math.exp(-dt * 7));
    const cy = cyBase + this._camLift;

    // 建筑遮挡：被挡就沿"注视点 → 相机"这条视线拉近，方向不变。
    // 收缩也要平滑（快但不瞬移），拉伸慢一点，避免画面"跳"。
    const clearWanted = exploring
      ? 1
      : this._cameraClearFraction(px, py, pz, cx, cyBase, cz, dist);
    const kUp = 1 - Math.exp(-dt * 4);
    const kDown = 1 - Math.exp(-dt * 18);
    this._camClear += (clearWanted - this._camClear) *
      (clearWanted < this._camClear ? kDown : kUp);
    const f = this._camClear;

    let fx = px + (cx - px) * f;
    let fy = py + (cy - py) * f;
    let fz = pz + (cz - pz) * f;
    const floor = base.y + 0.7;           // 永远不钻到地面以下
    if (fy < floor) fy = floor;

    cam.position.set(fx, fy, fz);
    // 朝向与轨道角一致（略更水平一点），角色稳定落在画面中心偏下；
    // 相机被抬高越楼时同步下压一点视线，避免只盯着地平线
    const lookPitch = Math.max(-0.9, Math.min(1.45, pitch - 0.06 + this._camLift * 0.006));
    cam.rotation.set(-lookPitch, yaw + Math.PI, 0, "YXZ");

    // 高空俯瞰：按相机高度抬高 near。深度精度 ∝ z²/near，相机离地 400m 时
    // near=0.5 的精度只有 ~2cm，描边路面与其标线（间距 1cm）会 z-fighting 闪。
    // 抬高 near 后精度提升一到两个数量级，条纹/闪块消失（低空时仍是 0.5，不影响近景）。
    const camH = Math.max(1, cam.position.y - base.y);
    const nearWant = Math.min(24, Math.max(0.5, camH * 0.04));
    if (Math.abs(nearWant - cam.near) > cam.near * 0.06) {
      cam.near = nearWant;
      cam.updateProjectionMatrix();
    }

    // 高空俯瞰：按相机实际高度衰减雾密度（环境每帧先重置，这里在其后覆盖），
    // 否则视距拉远后全被雾吞掉，看不出城市布局
    if (this.scene && this.scene.fog) {
      const h = Math.max(0, cam.position.y - 30);
      this.scene.fog.density *= Math.exp(-h / 260);
    }
  }
}
