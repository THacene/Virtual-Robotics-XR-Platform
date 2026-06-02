import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160/build/three.module.js";
import * as CANNON from "https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js";
import { createRobot } from './createRobot.js';
import { GripController } from '../logic/GripController.js';

const FLOOR_LIMIT = 0.02;
const MAX_KINEMATIC_V = 4.0;

const STATUS_COLORS = {
  normal: 0x4DAAFF,  // Professional blue-white (industrial standard)
  slow: 0xFFB833,    // Warm amber warning
  estop: 0xFF3333,   // Red emergency
};

function sCurveStep(pos, vel, acc, target, maxVel, maxAcc, maxJerk, dt) {
  const err = target - pos;
  const dir = err >= 0 ? 1 : -1;
  const dist = Math.abs(err);
  const stopDist = vel * vel / (2 * maxAcc) + Math.abs(acc) * Math.abs(vel) / (2 * maxJerk);
  let desAcc;
  if (dist < 0.02 && Math.abs(vel) < 0.8) desAcc = 0;
  else if (dir * vel >= 0 && stopDist >= dist - 0.01) desAcc = -dir * maxAcc;
  else if (Math.abs(vel) < maxVel - 0.3) desAcc = dir * maxAcc;
  else desAcc = 0;
  const jerkStep = maxJerk * dt;
  acc += Math.max(-jerkStep, Math.min(jerkStep, desAcc - acc));
  acc = Math.max(-maxAcc, Math.min(maxAcc, acc));
  vel += acc * dt;
  vel = Math.max(-maxVel, Math.min(maxVel, vel));
  pos += vel * dt;
  if (dir > 0 && pos >= target) { pos = target; vel = 0; acc = 0; }
  if (dir < 0 && pos <= target) { pos = target; vel = 0; acc = 0; }
  return { pos, vel, acc };
}

export class Robot3D {
  constructor(description, ctx) {
    this.description = description;
    this.type = description.type ?? 'industrial';
    this.safety = description.safety ?? { enabled: false };

    this.parts = createRobot(description, ctx);

    const c = this.parts.constants;
    this.BH = c.BH;
    this.FW = c.FW; this.FH = c.FH; this.FD = c.FD;
    this.FCLOSE = c.FCLOSE;
    this.FOPEN = c.FOPEN;
    this.BASE_OFF = c.BASE_OFF;

    // مركز الثقل — يُستخدم في كل عمليات ضبط موضع الـ body
    this.COG_Y = c.COG_Y;

    // ✅ GripController — إدارة منطق القبض الذكي مع pdState instance
    this.gripController = new GripController(description);

    this.loadedMass = 0;  // كتلة الحمل الحالي
    this.loadedBoxPosition = null;  // ✅ موقع الصندوق المحمول

    this.jTarget = { base: 0, shoulder: 0, elbow: 0, wrist: 0 };
    this.jCurrent = { base: 0, shoulder: 0, elbow: 0, wrist: 0 };
    this.jVel = { base: 0, shoulder: 0, elbow: 0, wrist: 0 };
    this.jAcc = { base: 0, shoulder: 0, elbow: 0, wrist: 0 };
    this.jSnapshot = { jCurrent: {}, jVel: {}, jAcc: {} };

    this.baseState = { x: 0, z: 0, yaw: 0, speed: 0 };
    this.driveTargetSpeed = 0;
    this.driveTargetTurn = 0;

    this.curSqueeze = 0;
    this.sqTarget = 0;

    this.safetyMode = 'normal';
    this.eStopTimer = 0;
    this._lastStatusColor = null;

    const p = this.parts;
    const dist = description.selfCollision.minDist;
    this.SELF_COL_PAIRS = [
      { a: () => p.elbow.mesh, b: () => p.base.mesh, minDist: dist.elbowToBase, joints: ['elbow', 'shoulder'] },
      { a: () => p.wrist.mesh, b: () => p.shoulder.mesh, minDist: dist.wristToShoulder, joints: ['elbow', 'shoulder'] },
      { a: () => p.palm.mesh, b: () => p.base.mesh, minDist: dist.palmToBase, joints: ['elbow', 'shoulder'] },
      { a: () => p.elbow.mesh, b: () => p.shoulder.mesh, minDist: dist.elbowToShoulder, joints: ['elbow'] },
    ];

    this._prevPos = new Map();
    this._sc1 = new THREE.Vector3();
    this._sc2 = new THREE.Vector3();
    this._box3 = new THREE.Box3();

    this.baseSnapshot = { x: 0, z: 0, yaw: 0, speed: 0 };
    this._collisionLeafMeshes = null;
    this._tmpBoxA = new THREE.Box3();
    this._tmpBoxB = new THREE.Box3();
    this._overallBox = new THREE.Box3();
    this.diagnostics = {
      selfCollisionCount: 0,
      floorCollisionCount: 0,
      estopCount: 0,
      snapshotRevertCount: 0,
      lastEStopReason: null,
    };

    this._refreshStatusLight();
  }


  setPosition(x, z) {
    this.baseState.x = x;
    this.baseState.z = z;
    this.parts.base.group.position.set(x, 0, z);
    // الجسم الفيزيائي عند مركز الثقل
    this.parts.base.body.position.set(x, this.COG_Y, z);
  }

  moveJoint(name, degrees) {
    if (this.safetyMode === 'estop') return;
    const lim = this.description.joints.limits[name];
    if (!lim) return;
    this.jTarget[name] = Math.max(lim.min, Math.min(lim.max, degrees));
  }

  setDrive(speed, turn) {
    if (this.safetyMode === 'estop') {
      this.driveTargetSpeed = 0;
      this.driveTargetTurn = 0;
      return;
    }
    let s = speed, t = turn;
    if (this.safety.enabled) {
      const maxS = this.safety.maxLinearSpeed ?? Infinity;
      const maxT = this.safety.maxTurnRate ?? Infinity;
      s = Math.max(-maxS, Math.min(maxS, s));
      t = Math.max(-maxT, Math.min(maxT, t));
      if (this.safetyMode === 'slow') {
        const f = this.safety.slowDownFactor ?? 0.5;
        s *= f; t *= f;
      }
    }
    this.driveTargetSpeed = s;
    this.driveTargetTurn = t;
  }

  setSqueeze(v) { this.sqTarget = v; }
  setOpen(v) { this.FOPEN = v; }

  triggerEStop(reason = 'manual') {
    if (!this.safety.enabled || !this.safety.stopOnContact) return;
    this.safetyMode = 'estop';
    this.diagnostics.estopCount += 1;
    this.diagnostics.lastEStopReason = reason;
    this.eStopTimer = this.safety.eStopHoldSec ?? 1.0;
    this.driveTargetSpeed = 0;
    this.driveTargetTurn = 0;
    for (const k of ['base', 'shoulder', 'elbow', 'wrist']) {
      this.jTarget[k] = this.jCurrent[k];
      this.jVel[k] = 0; this.jAcc[k] = 0;
    }
    this._refreshStatusLight();
  }

  setSlowMode(on) {
    if (!this.safety.enabled) return;
    if (this.safetyMode === 'estop') return;
    this.safetyMode = on ? 'slow' : 'normal';
    this._refreshStatusLight();
  }

  isEStopped() { return this.safetyMode === 'estop'; }


  _refreshStatusLight() {
    const light = this.parts.base.statusLight;
    if (!light) return;
    const color = STATUS_COLORS[this.safetyMode] ?? STATUS_COLORS.normal;
    if (color === this._lastStatusColor) return;
    this._lastStatusColor = color;
    light.material.color.setHex(color);
    light.material.emissive.setHex(color);
  }

  _tickSafety(dt) {
    if (!this.safety.enabled) return;
    if (this.safetyMode === 'estop') {
      this.eStopTimer -= dt;
      if (this.eStopTimer <= 0) { this.safetyMode = 'normal'; this.eStopTimer = 0; }
    }
    this._refreshStatusLight();
  }

  saveSnapshot() {
    this.jSnapshot.jCurrent = { ...this.jCurrent };
    this.jSnapshot.jVel = { ...this.jVel };
    this.jSnapshot.jAcc = { ...this.jAcc };
    this.baseSnapshot.x = this.baseState.x;
    this.baseSnapshot.z = this.baseState.z;
    this.baseSnapshot.yaw = this.baseState.yaw;
    this.baseSnapshot.speed = this.baseState.speed;
  }

  restoreSnapshot() {
    this.jCurrent = { ...this.jSnapshot.jCurrent };
    this.jVel = { ...this.jSnapshot.jVel };
    this.jAcc = { ...this.jSnapshot.jAcc };
  }


  setLoadedBox(mass = 0, boxPosition = null) {
    this.loadedMass = mass;
    this.loadedBoxPosition = boxPosition;
    if (mass > 0 && boxPosition) {
      this.updatePhysicsBodyCOG(boxPosition);
    } else {
      this.updatePhysicsBodyCOG(null);  // إعادة للـ COG الثابت
    }
  }

  /**
   = (COG_base * mass_base + COG_box * Y_box) / (mass_base + mass_box)
   * 
   * @param {object} boxPosition - موقع الصندوق { x, y, z }
   * @returns {number} COG_Y الجديد
   */
  calculateDynamicCOG(boxPosition = null) {
    if (!boxPosition || this.loadedMass <= 0) {
      return this.parts.constants.COG_Y;  // العودة للـ COG الثابت إذا لا يوجد حمل
    }

    // كتلة القاعدة والذراع
    const baseMass = this.description.base.body.mass + this.description.base.turret.mass;
    const armMass = this.description.arm.shoulder.mass +
      this.description.arm.elbow.mass +
      this.description.arm.wrist.mass +
      this.description.arm.palm.mass;
    const totalBaseMass = baseMass + armMass;

    // موقع COG الثابت (في القاعدة)
    const cogStaticY = this.parts.constants.COG_Y;

    // حساب COG الديناميكي = (mass1 * y1 + mass2 * y2) / (mass1 + mass2)
    const totalMass = totalBaseMass + this.loadedMass;
    const dynamicCOG = (totalBaseMass * cogStaticY + this.loadedMass * boxPosition.y) / totalMass;

    return dynamicCOG;
  }


  updatePhysicsBodyCOG(boxPosition = null) {
    const newCOG_Y = this.calculateDynamicCOG(boxPosition);

    // تحديث موقع الجسم الفيزيائي
    const currentBase = this.parts.base.body.position;
    const yOffset = newCOG_Y - this.COG_Y;  // الفرق عن الـ COG القديم

    this.parts.base.body.position.y = newCOG_Y;
    this.COG_Y = newCOG_Y;  // تحديث الـ instance variable
  }

  updateJoints(dt) {
    const J = this.description.joints;

    // حساب عامل الحمل
    const totalMass = this.description.arm.shoulder.mass +
      this.description.arm.elbow.mass +
      this.description.arm.wrist.mass +
      this.description.arm.palm.mass;
    const loadFactor = 1.0 / (1.0 + (this.loadedMass / (totalMass * 0.5)));

    // مصدر وحيد لحدود المفاصل من description
    const limits = this.description.joints?.limits ?? {};

    // تحديث جميع المفاصل مع تأثر الحمل
    for (const k of ['shoulder', 'elbow', 'wrist']) {
      const adjustedMaxVel = J.maxVel[k] * loadFactor;
      const adjustedMaxAcc = J.maxAcc[k] * loadFactor;
      const adjustedMaxJerk = J.maxJerk[k] * loadFactor;

      const r = sCurveStep(
        this.jCurrent[k], this.jVel[k], this.jAcc[k], this.jTarget[k],
        adjustedMaxVel, adjustedMaxAcc, adjustedMaxJerk, dt
      );

      // تطبيق حدود المفصل (Joint Limits)
      let newPos = r.pos;
      let newVel = r.vel;

      // فحص الحدود
      if (limits[k]) {
        if (newPos > limits[k].max) {
          newPos = limits[k].max;
          newVel = 0;  // إيقاف الحركة عند الحد
        } else if (newPos < limits[k].min) {
          newPos = limits[k].min;
          newVel = 0;
        }
      }

      this.jCurrent[k] = newPos;
      this.jVel[k] = newVel;
      this.jAcc[k] = r.acc;
    }

    // تطبيق الحركة على الشبكة البصرية (مؤقت — للكشف عن اختراق الأرض)
    const p = this.parts;
    p.base.group.rotation.y = THREE.MathUtils.degToRad(this.jCurrent.base);
    p.shoulder.pivot.rotation.x = THREE.MathUtils.degToRad(this.jCurrent.shoulder);
    p.elbow.pivot.rotation.x = THREE.MathUtils.degToRad(this.jCurrent.elbow);
    p.wrist.pivot.rotation.y = THREE.MathUtils.degToRad(this.jCurrent.wrist);

    // ✅ Floor Guard: إذا اخترقت الأرض نُعيد الـ snapshot لـ shoulder/elbow/wrist فوراً
    const testMinY = this.checkFloorCollision();
    if (testMinY < FLOOR_LIMIT) {
      this.jCurrent.shoulder = this.jSnapshot.jCurrent.shoulder ?? this.jCurrent.shoulder;
      this.jCurrent.elbow = this.jSnapshot.jCurrent.elbow ?? this.jCurrent.elbow;
      this.jCurrent.wrist = this.jSnapshot.jCurrent.wrist ?? this.jCurrent.wrist;
      this.jVel.shoulder = 0; this.jAcc.shoulder = 0;
      this.jVel.elbow = 0; this.jAcc.elbow = 0;
      this.jVel.wrist = 0; this.jAcc.wrist = 0;
      this.jTarget.wrist = this.jCurrent.wrist;
      // نُعيد تطبيق الـ mesh بعد التصحيح
      p.shoulder.pivot.rotation.x = THREE.MathUtils.degToRad(this.jCurrent.shoulder);
      p.elbow.pivot.rotation.x = THREE.MathUtils.degToRad(this.jCurrent.elbow);
      p.wrist.pivot.rotation.y = THREE.MathUtils.degToRad(this.jCurrent.wrist);
    }

    this.updateJointMotors();
  }

  updateJointMotors() {
    const joints = this.parts.joints;
    if (!Array.isArray(joints) || joints.length === 0) return;

    const keyByIndex = ['shoulder', 'elbow', 'wrist'];
    for (let i = 0; i < joints.length; i++) {
      const joint = joints[i];
      const key = keyByIndex[i];
      if (!joint?.constraint || !key) continue;

      const motorSpeed = THREE.MathUtils.degToRad(this.jVel[key] ?? 0);
      const angle = joint.constraint.angle ?? 0; // rad
      const min = THREE.MathUtils.degToRad(joint.limits?.min ?? -180);
      const max = THREE.MathUtils.degToRad(joint.limits?.max ?? 180);

      let speed = motorSpeed;
      if (angle > max || angle < min) {
        speed = 0;
      }

      joint.constraint.enableMotor();
      joint.constraint.setMotorSpeed(speed);
    }
  }

  checkSelfCollision() {
    let worst = null;
    for (const pair of this.SELF_COL_PAIRS) {
      pair.a().getWorldPosition(this._sc1);
      pair.b().getWorldPosition(this._sc2);
      const dist = this._sc1.distanceTo(this._sc2);
      if (dist < pair.minDist && (!worst || dist < worst.dist)) worst = { pair, dist };
    }
    return worst;
  }

  resolveSelfCollision(blocked) {
    const { pair } = blocked;
    this.restoreSnapshot();
    for (const k of pair.joints) {
      this.jTarget[k] = this.jCurrent[k];
      this.jVel[k] = 0; this.jAcc[k] = 0;
    }
    for (const k of pair.joints) {
      const delta = (this.jTarget[k] - this.jSnapshot.jCurrent[k]) * 0.5;
      this.jCurrent[k] -= delta;
    }
  }

  meshMinY(mesh) {
    mesh.updateWorldMatrix(true, false);
    this._box3.setFromObject(mesh, false);
    return this._box3.min.y;
  }

  checkFloorCollision() {
    const p = this.parts;
    const parts = [p.shoulder.mesh, p.elbow.mesh, p.wrist.mesh, p.palm.mesh];
    p.fingers.left.group.traverse(c => { if (c.isMesh) parts.push(c); });
    p.fingers.right.group.traverse(c => { if (c.isMesh) parts.push(c); });
    let minY = Infinity;
    for (const m of parts) { const y = this.meshMinY(m); if (y < minY) minY = y; }
    return minY;
  }


  updateBaseMovement(dt) {
    const m = this.description.movement;
    const targetSpeed = this.driveTargetSpeed;
    const targetTurn = this.driveTargetTurn;
    const accel = targetSpeed !== 0 ? m.accel : m.decel;

    if (Math.abs(targetSpeed - this.baseState.speed) < accel * dt)
      this.baseState.speed = targetSpeed;
    else
      this.baseState.speed += Math.sign(targetSpeed - this.baseState.speed) * accel * dt;

    this.baseState.yaw += targetTurn * dt;
    this.baseState.x += Math.sin(this.baseState.yaw) * this.baseState.speed * dt;
    this.baseState.z += Math.cos(this.baseState.yaw) * this.baseState.speed * dt;

    const p = this.parts;

    // Visual group — عند سطح الأرض
    p.base.group.position.set(this.baseState.x, 0, this.baseState.z);
    p.base.group.rotation.y = this.baseState.yaw;

    // Physics body — عند مركز الثقل الحقيقي
    p.base.body.position.set(this.baseState.x, this.COG_Y, this.baseState.z);
    p.base.body.quaternion.setFromEuler(0, this.baseState.yaw, 0);
    p.base.body.velocity.set(
      Math.sin(this.baseState.yaw) * this.baseState.speed,
      0,
      Math.cos(this.baseState.yaw) * this.baseState.speed
    );
    p.base.body.aabbNeedsUpdate = true;

    p.base.trackState.offset += this.baseState.speed * dt * 0.5;

    // ⬇️ تحريك خامة المجنزرات (Tracks Texture UV)
    if (p.base.trackState.matTrack && p.base.trackState.matTrack.map) {
      p.base.trackState.matTrack.map.offset.y = p.base.trackState.offset * 2.5; // سرعة تحرك الخامة
    }

    // ⬇️ تدوير العجلات (Wheels rotation)
    if (p.base.trackState.wheels) {
      // إذا كانت الحركة للأمام (offset موجب)، فالدوران يجب أن يكون حول الـ X بـ سالب أو موجب ليوافق الواقع.
      // الدوران حول X: + = للأمام في فضاء Three.js
      const wheelRot = p.base.trackState.offset * 12.0; 
      for (const w of p.base.trackState.wheels) {
        w.rotation.x = wheelRot;
      }
    }

    // ⬇️ أضواء الرجوع الحمراء — تشتعل عند الرجوع للوراء (السرعة سالبة) مثل السيارات
    this._updateBrakeLights(dt);
  }

  /**
   * _updateBrakeLights — يتحكم بشدة توهج أضواء الرجوع الحمراء
   * تشتعل عندما يتحرك الروبوت للوراء (speed < 0)، وتنطفئ تدريجياً عند التوقف/التقدم
   */
  _updateBrakeLights(dt) {
    const lights = this.parts.base.brakeLights;
    if (!lights || lights.length === 0) return;

    const reversing = this.baseState.speed < -0.02;
    // شدة هدف: مضيئة بالكامل عند الرجوع، مطفأة عند غير ذلك
    const target = reversing ? 3.0 : 0.0; // زيادة الشدة لتبدو أقوى

    // انتقال ناعم (lerp) لتجنب الوميض الحاد
    if (this._brakeGlow === undefined) this._brakeGlow = 0;
    const rate = 12 * (dt || 0.016);
    this._brakeGlow += (target - this._brakeGlow) * Math.min(1, rate);
    if (this._brakeGlow < 0.001) this._brakeGlow = 0;

    for (const item of lights) {
      // Handle the new object structure {mat, light}
      const mat = item.mat || item;
      const lightSource = item.light;

      mat.emissiveIntensity = this._brakeGlow;
      // عند الإضاءة نجعل اللون الأساسي أحمر أكثر سطوعاً
      const lit = this._brakeGlow > 0.1;
      mat.color.setHex(lit ? 0xff2222 : 0x330000);

      // تشغيل مصدر الضوء الحقيقي (PointLight)
      if (lightSource) {
        lightSource.intensity = this._brakeGlow * 1.5; // قوة الإضاءة الفعلية على الأرض
      }
    }
  }


  syncKinematicPart(mesh, body) {
    mesh.updateWorldMatrix(true, false);
    const newPos = new THREE.Vector3(
      mesh.matrixWorld.elements[12],
      mesh.matrixWorld.elements[13],
      mesh.matrixWorld.elements[14]
    );
    const q = new THREE.Quaternion();
    q.setFromRotationMatrix(new THREE.Matrix4().extractRotation(mesh.matrixWorld));
    const key = body.id;
    if (this._prevPos.has(key)) {
      const prev = this._prevPos.get(key);
      const rawVx = (newPos.x - prev.x) * 60;
      const rawVy = (newPos.y - prev.y) * 60;
      const rawVz = (newPos.z - prev.z) * 60;
      const speed = Math.sqrt(rawVx * rawVx + rawVy * rawVy + rawVz * rawVz);
      const scale = speed > MAX_KINEMATIC_V ? MAX_KINEMATIC_V / speed : 1.0;
      body.velocity.set(rawVx * scale, rawVy * scale, rawVz * scale);
    } else {
      body.velocity.set(0, 0, 0);
    }
    this._prevPos.set(key, { x: newPos.x, y: newPos.y, z: newPos.z });
    body.position.copy(newPos);
    body.quaternion.copy(q);
    body.aabbNeedsUpdate = true;
    body.interpolatedPosition.copy(body.position);
    body.interpolatedQuaternion.copy(body.quaternion);
  }

  syncAllKinematic() {
    for (const part of this.parts.kB) {
      if (part.body.type === CANNON.Body.KINEMATIC)
        this.syncKinematicPart(part.mesh, part.body);
    }
  }

  updateFingers(dt) {
    // نستخدم FOPEN مباشرة كموضع للأصابع (نستغني عن curSqueeze/sqTarget)
    let xp = this.FOPEN;
    const minFingerX = this.BH + this.FW / 2 + 0.001;
    if (xp < minFingerX) xp = minFingerX;
    this.parts.fingers.left.group.position.x = -xp;
    this.parts.fingers.right.group.position.x = xp;
  }



  _getCollisionLeafMeshes() {
    if (this._collisionLeafMeshes) return this._collisionLeafMeshes;
    const out = [];
    this.parts.base.group.traverse(o => {
      if (o.isMesh && o.geometry) {
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        out.push(o);
      }
    });
    this._collisionLeafMeshes = out;
    return out;
  }

  _computeOverallBox(target) {
    target.makeEmpty();
    const meshes = this._getCollisionLeafMeshes();
    const tmp = this._tmpBoxA;
    for (const m of meshes) {
      m.updateWorldMatrix(true, false);
      tmp.copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld);
      target.union(tmp);
    }
    return target;
  }

  collidesWith(other) {
    const myBox = this._computeOverallBox(this._overallBox);
    const otherBox = other._computeOverallBox(other._overallBox);
    if (!myBox.intersectsBox(otherBox)) return false;
    const myMeshes = this._getCollisionLeafMeshes();
    const otherMeshes = other._getCollisionLeafMeshes();
    const a = this._tmpBoxA;
    const b = this._tmpBoxB;
    for (let i = 0; i < myMeshes.length; i++) {
      const ma = myMeshes[i];
      ma.updateWorldMatrix(true, false);
      a.copy(ma.geometry.boundingBox).applyMatrix4(ma.matrixWorld);
      if (!a.intersectsBox(otherBox)) continue;
      for (let j = 0; j < otherMeshes.length; j++) {
        const mb = otherMeshes[j];
        mb.updateWorldMatrix(true, false);
        b.copy(mb.geometry.boundingBox).applyMatrix4(mb.matrixWorld);
        if (a.intersectsBox(b)) return true;
      }
    }
    return false;
  }


  revertToSnapshot() {
    this.diagnostics.snapshotRevertCount += 1;
    this.restoreSnapshot();
    for (const k of ['base', 'shoulder', 'elbow', 'wrist']) {
      this.jTarget[k] = this.jCurrent[k];
      this.jVel[k] = 0; this.jAcc[k] = 0;
    }
    this.baseState.x = this.baseSnapshot.x;
    this.baseState.z = this.baseSnapshot.z;
    this.baseState.yaw = this.baseSnapshot.yaw;
    this.baseState.speed = 0;
    this.driveTargetSpeed = 0;
    this.driveTargetTurn = 0;

    const p = this.parts;
    p.base.group.position.set(this.baseState.x, 0, this.baseState.z);
    p.base.group.rotation.y = this.baseState.yaw;
    // Physics body عند CoG
    p.base.body.position.set(this.baseState.x, this.COG_Y, this.baseState.z);
    p.base.body.quaternion.setFromEuler(0, this.baseState.yaw, 0);
    p.base.body.velocity.set(0, 0, 0);
    p.base.body.angularVelocity.set(0, 0, 0);
    p.base.body.aabbNeedsUpdate = true;

    p.shoulder.pivot.rotation.x = THREE.MathUtils.degToRad(this.jCurrent.shoulder);
    p.elbow.pivot.rotation.x = THREE.MathUtils.degToRad(this.jCurrent.elbow);
    p.wrist.pivot.rotation.y = THREE.MathUtils.degToRad(this.jCurrent.wrist);

    this.syncAllKinematic();

    if (this.safety.enabled && this.safety.stopOnContact)
      this.triggerEStop('inter-robot');
  }

  pushAwayFrom(other, amount = 0.15) {
    const dx = this.baseState.x - other.baseState.x;
    const dz = this.baseState.z - other.baseState.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    let nx, nz;
    if (dist < 0.001) {
      nx = 1; nz = 0;
    } else {
      nx = dx / dist; nz = dz / dist;
    }
    this.baseState.x += nx * amount;
    this.baseState.z += nz * amount;
    other.baseState.x -= nx * amount;
    other.baseState.z -= nz * amount;
    this.driveTargetSpeed = 0;
    this.driveTargetTurn = 0;
    other.driveTargetSpeed = 0;
    other.driveTargetTurn = 0;
    const p = this.parts;
    p.base.group.position.set(this.baseState.x, 0, this.baseState.z);
    p.base.group.rotation.y = this.baseState.yaw;
    p.base.body.position.set(this.baseState.x, this.COG_Y, this.baseState.z);
    p.base.body.quaternion.setFromEuler(0, this.baseState.yaw, 0);
    p.base.body.aabbNeedsUpdate = true;
    const op = other.parts;
    op.base.group.position.set(other.baseState.x, 0, other.baseState.z);
    op.base.group.rotation.y = other.baseState.yaw;
    op.base.body.position.set(other.baseState.x, other.COG_Y, other.baseState.z);
    op.base.body.quaternion.setFromEuler(0, other.baseState.yaw, 0);
    op.base.body.aabbNeedsUpdate = true;
  }

  /** update — entry point لكل frame */
  update(dt) {
    this._tickSafety(dt);
    this.saveSnapshot();
    this.updateJoints(dt);

    const selfBlocked = this.checkSelfCollision();
    if (selfBlocked) {
      this.diagnostics.selfCollisionCount += 1;
      this.resolveSelfCollision(selfBlocked);
      this.updateJoints(dt);
      if (this.safety.enabled && this.safety.stopOnContact)
        this.triggerEStop('self-collision');
    }

    const minY = this.checkFloorCollision();
    const floorBlocked = minY < FLOOR_LIMIT;
    if (floorBlocked) {
      this.diagnostics.floorCollisionCount += 1;
      // نوقف velocity نحو الأرض ونرفع الـ target فوراً
      this.jVel.shoulder = 0; this.jAcc.shoulder = 0;
      this.jVel.elbow = 0; this.jAcc.elbow = 0;
      this.jVel.wrist = 0; this.jAcc.wrist = 0;
      this.jTarget.wrist = this.jCurrent.wrist;
      const lift = Math.max(5, (FLOOR_LIMIT - minY + 0.05) * 25);
      this.jTarget.shoulder = Math.min(85, this.jCurrent.shoulder + lift);
      this.jTarget.elbow = Math.max(-90, this.jCurrent.elbow - lift * 0.35);
      this.updateJoints(dt);
      this.driveTargetSpeed = 0;
      this.driveTargetTurn = 0;
    }

    this.updateBaseMovement(dt);
    this.syncAllKinematic();
    this.updateFingers(dt);

    return { selfBlocked, floorBlocked, safetyMode: this.safetyMode };
  }
}