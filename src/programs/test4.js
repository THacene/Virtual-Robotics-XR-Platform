// ============================================================
//  test.js — Event-Driven Pick & Place (v2.0)
//
// ============================================================

(function () {

  async function loadModules() {
    const { RobotListener } = await import('/src/core/RobotListener.js');
    return { RobotListener };
  }

  // ══════════════════════════════════════════════════════════
  // ══════════════════════════════════════════════════════════

  const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, v));
  const radToDeg = r => r * 180 / Math.PI;
  const normalizeRad = a => Math.atan2(Math.sin(a), Math.cos(a));

  function localTargetFrom(ar, coords) {
    const base = ar.parts.base.group.position;
    const yaw = ar.baseState?.yaw ?? 0;
    const dx = coords.x - base.x;
    const dz = coords.z - base.z;
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    return {
      dx, dz,
      distance: Math.hypot(dx, dz),
      side: dx * cos - dz * sin,
      forward: dx * sin + dz * cos,
      targetYaw: Math.atan2(dx, dz),
      yaw,
    };
  }

  function solveArmAngles(ar, coords, target, overrides = {}) {
    const desc = ar.description;
    const baseOffY = ar.parts.constants.BASE_OFF;
    const l1 = desc.arm.shoulder.len;
    const palmD = desc.arm.palm?.d ?? 0.26;
    const fingerD = desc.finger?.d ?? 0.18;
    const frontDepth = Math.max(palmD, fingerD) / 2;
    const boxHalf = coords.half ?? desc.box?.half ?? 0.25;
    const approachOff = boxHalf + frontDepth + 0.04;

    const wristH = desc.arm.wrist?.h ?? 0;
    const l2 = desc.arm.elbow.len + wristH + 0.06;
    const maxReach = l1 + l2 - 0.04;
    const minReach = Math.abs(l1 - l2) + 0.04;

    let z = Math.max(0.2, target.forward - approachOff);
    let y = coords.y - baseOffY;

    const minY = overrides.minY ?? -0.15;
    if (y < minY) y = minY;

    let reach = Math.hypot(z, y);

    if (reach > maxReach) { const s = maxReach / reach; z *= s; y *= s; reach = maxReach; }
    else if (reach < minReach) { const s = minReach / Math.max(reach, 0.001); z *= s; y *= s; }

    const cosQ2 = clamp((reach * reach - l1 * l1 - l2 * l2) / (2 * l1 * l2), -1, 1);
    const bend = Math.acos(cosQ2);
    const limits = desc.joints?.limits ?? {};

    const shoulderMin = overrides.shoulderMin ?? -45;

    const score = s => {
      let penalty = 0;
      penalty += Math.max(0, (limits.shoulder?.min ?? -Infinity) - s.shoulder,
        s.shoulder - (limits.shoulder?.max ?? Infinity)) * 1000;
      penalty += Math.max(0, (limits.elbow?.min ?? -Infinity) - s.elbow,
        s.elbow - (limits.elbow?.max ?? Infinity)) * 1000;
      penalty += Math.abs(s.elbow - 55);
      if (s.shoulder < shoulderMin) penalty += (shoulderMin - s.shoulder) * 100;
      return penalty;
    };

    const best = [-bend, bend].map(q2 => {
      const q1 = Math.atan2(y, z) - Math.atan2(l2 * Math.sin(q2), l1 + l2 * Math.cos(q2));
      return { shoulder: 90 - radToDeg(q1), elbow: -radToDeg(q2) };
    }).sort((a, b) => score(a) - score(b))[0];

    const jl = (name, val) => {
      const lim = limits[name];
      return lim ? clamp(val, lim.min, lim.max) : val;
    };

    return {
      shoulder: jl('shoulder', Math.max(shoulderMin, best.shoulder)),
      elbow: jl('elbow', best.elbow),
      wrist: jl('wrist', -radToDeg(Math.atan2(target.side, Math.max(target.forward, 0.001))) * 0.5),
      maxReach,
      approachOff,
    };
  }

  function driveBaseTo(ar, goal, stopRadius = 0.18) {
    const base = ar.parts.base.group.position;
    const dx = goal.x - base.x, dz = goal.z - base.z;
    const dist = Math.hypot(dx, dz);
    if (dist < stopRadius) { ar.setDrive(0, 0); return true; }
    const yawErr = normalizeRad(Math.atan2(dx, dz) - (ar.baseState?.yaw ?? 0));
    const mv = ar.description.movement;
    ar.setDrive(
      Math.abs(yawErr) < 0.35 ? clamp(dist * 0.75, 0.18, mv.speed * 0.55) : 0,
      Math.abs(yawErr) < 0.04 ? 0 : clamp(yawErr * 1.7, -mv.turn, mv.turn)
    );
    return false;
  }

  // ══════════════════════════════════════════════════════════
  //
  //    idle → navigate → approach → closing → lift → carry → place → release → retract → done
  //
  //
  // ══════════════════════════════════════════════════════════

  function buildListener(RobotListener, robot, options = {}) {

    const TARGET_ID = options.target ?? 'box';
    const DROP_GOAL = options.dropAt ?? { x: -1.2, z: 2.2 };
    const onDone = options.onDone ?? (() => { });
    const logger = options.logger ?? ((msg, cls) => console.log(`[PickPlace] ${msg}`));

    // ────────────────────────────────────────────
    class PickPlaceListener extends RobotListener {

      constructor(robot) {
        super(robot, logger);
        this.controlsDrive = true;
        this._phase = 'idle';
        this._phaseAt = performance.now();
        this._finished = false;

        this._contact = { left: false, right: false };
        this._contactLockUntil = 0;

        this._autoGrabCancel = null;
        this._autoReleaseCancel = null;
        this._grabTime = 0;

        // ── Realistic grip offset ────────────────
        this._gripOffset = { x: 0, z: 0 };
        this._gripOffsetRenew = true;

        // ── Approach Stall Adaptation ────────────
        this._floorHitBaseline = 0;
        this._stallCount = 0;
        this._floorCount = 0;
        this._distReduction = 0;
        this._shoulderBoost = 0;
        this._adaptCooldown = 0;
      }

      get _ar() { return this.robot._robot3D; }

      get phase() { return this._phase; }

      _switchPhase(p) {
        if (this._phase === p) return;
        this._phase = p;
        this._phaseAt = performance.now();
        logger(`▶ PHASE → ${p}`, 'info');
      }

      _elapsed() { return performance.now() - this._phaseAt; }

      // ══════════════════════════════════════
      //  EVENT: onObjectDetected
      // ══════════════════════════════════════
      onObjectDetected(id, coords) {
        super.onObjectDetected?.(id, coords);
        if (id !== TARGET_ID) return;

        const ar = this._ar;
        if (!ar?.parts) return;

        if (this._finished || this._phase === 'done') {
          ar.setDrive(0, 0);
          return;
        }

        if (['lift', 'carry', 'place', 'release', 'retract'].includes(this._phase)) {
          this._runTransport(ar);
          return;
        }

        if (this.grabbed) {
          this._switchPhase('lift');
          return;
        }

        if (this._phase === 'closing') {
          ar.setDrive(0, 0);
          return;
        }

        // ── NAVIGATE / APPROACH ──────────────
        if (this._phase === 'idle') this._switchPhase('navigate');

        const offsetCoords = { ...coords };
        if (this._phase === 'navigate') {
          this._gripOffsetRenew = true;
        }
        if (this._phase === 'approach') {
          if (this._gripOffsetRenew) {
            const maxOff = 0.04;
            this._gripOffset.x = (Math.random() * 2 - 1) * maxOff;
            this._gripOffset.z = (Math.random() * 2 - 1) * maxOff;
            this._gripOffsetRenew = false;
            logger(`🎲 grip offset: x=${this._gripOffset.x.toFixed(3)} z=${this._gripOffset.z.toFixed(3)}`, 'info');
          }
          offsetCoords.x += this._gripOffset.x;
          offsetCoords.z += this._gripOffset.z;
        }

        const target = localTargetFrom(ar, offsetCoords);
        const mv = ar.description.movement;

        const ikOverrides = {
          minY: -0.15 - (this._stallCount * 0.05),
          shoulderMin: Math.max(-45, -15 - this._stallCount * 3 + this._shoulderBoost),
        };

        const angles = solveArmAngles(ar, offsetCoords, target, ikOverrides);
        const yawErr = normalizeRad(target.targetYaw - target.yaw);

        const basePrefDist = clamp(angles.maxReach + angles.approachOff - 0.3,
          1.0, angles.maxReach + angles.approachOff);
        const prefDist = Math.max(1.2, basePrefDist - this._distReduction);

        const fwdErr = target.forward - prefDist;
        const aligned = Math.abs(yawErr) < 0.22;

        let speed = 0;
        if (aligned && fwdErr > 0.02) {
          const ratio = clamp(fwdErr / 0.25, 0.15, 1);
          speed = clamp(fwdErr * 0.55 * ratio, 0.015, mv.speed * 0.45);
        }
        let turn = Math.abs(yawErr) < 0.04
          ? 0 : clamp(yawErr * 1.8, -mv.turn, mv.turn);

        // ── Stop base drive once arm is deployed in approach ──
        if (this._phase === 'approach') {
          speed = 0;
          turn = 0;
        }

        ar.setDrive(speed, turn);

        const canDeploy =
          target.forward <= prefDist + 0.22 &&
          Math.abs(yawErr) <= 0.32 &&
          Math.abs(target.side) <= (coords.half ?? 0.25) + 0.22;

        if (!canDeploy) {
          // If we are in approach but can no longer deploy (e.g. distReduction caused prefDist to drop),
          // we should either grab it if it's close, or revert to navigate.
          // Since it's often a scale visual issue, let's just let the stall handler deal with it
          // or switch back to navigate.
          if (this._phase === 'approach' && this._stallCount > 0) {
            // Let it continue to the stall logic or grab logic below
          } else {
            this.robot.moveArm('shoulder', 0);
            this.robot.moveArm('elbow', 0);
            this.robot.moveArm('wrist', 0);
            this._openFingers(ar, coords);
            ar.setSqueeze(0);
            this._switchPhase('navigate');
            return;
          }
        }

        if (this._phase !== 'approach') {
          this._floorHitBaseline = ar.diagnostics.floorCollisionCount;
        }
        this._switchPhase('approach');

        this.robot.moveArm('shoulder', angles.shoulder);
        this.robot.moveArm('elbow', angles.elbow);
        this.robot.moveArm('wrist', angles.wrist);
        this._openFingers(ar, coords);

        // ══════════════════════════════════════════
        //  ✅ FLOOR / STALL HANDLING
        //    • FLOOR (collision > 2): rapproche robot + lève épaule
        //    • STALL (2s sans contact): descend bras + rapproche
        // ══════════════════════════════════════════
        const now = performance.now();
        const approachTime = this._elapsed();
        const floorHits = ar.diagnostics.floorCollisionCount - this._floorHitBaseline;

        // ── FLOOR LIMIT → rapprocher + lever épaule (persistant) ──
        if (floorHits > 2 && now > this._adaptCooldown) {
          this._floorCount++;
          this._distReduction += 0.20;
          this._shoulderBoost += 8;
          this._adaptCooldown = now + 2000;
          this._floorHitBaseline = ar.diagnostics.floorCollisionCount;
          logger(`⚠️ Floor #${this._floorCount} → closer ${this._distReduction.toFixed(2)}m + shoulderBoost ${this._shoulderBoost}°`, 'warn');
          ar.setDrive(clamp(0.25, 0.1, mv.speed * 0.35), 0);
          this._phaseAt = now;
          this.robot.moveArm('shoulder', angles.shoulder + 8);
          return;
        }

        // ── STALL (2s sans contact) → descendre bras + rapprocher ──
        if (approachTime > 2000 && now > this._adaptCooldown) {
          this._stallCount++;
          this._distReduction += 0.20;
          this._adaptCooldown = now + 2000;
          logger(
            `🔧 Stall #${this._stallCount} → ` +
            `minY: ${ikOverrides.minY.toFixed(2)} shoulderMin: ${ikOverrides.shoulderMin}° ` +
            `closer: ${this._distReduction.toFixed(2)}m`,
            'warn'
          );
          ar.setDrive(clamp(0.25, 0.1, mv.speed * 0.35), 0);
          this._phaseAt = now;
          return;
        }

        // ── HARD TIMEOUT (15s) ──
        if (approachTime > 15000) {
          logger('⚠️ Approach hard timeout → reset', 'warn');
          this.robot.moveArm('shoulder', 0);
          this.robot.moveArm('elbow', 0);
          this.robot.moveArm('wrist', 0);
          ar.setDrive(-0.3, 0);
          this._distReduction = 0; this._stallCount = 0; this._floorCount = 0; this._shoulderBoost = 0;
          this._switchPhase('navigate');
          return;
        }

        // ── CONTACT DETECTED → autoGrab ──
        const sensorContact = this._contact.left || this._contact.right;
        const geoContact = this._isBoxInGrip(ar, coords);

        if (sensorContact || geoContact) {
          if (geoContact && !sensorContact) {
            logger('📐 Box detected geometrically between fingers → autoGrab', 'info');
          }
          this._distReduction = 0; this._stallCount = 0; this._floorCount = 0; this._shoulderBoost = 0;
          this._startAutoGrab();
        }
      }

      // ══════════════════════════════════════
      //  EVENT: onFingerTouch
      // ══════════════════════════════════════
      onFingerTouch(name, state, force, pointName) {
        if (name !== 'left' && name !== 'right') return;

        if (this._finished || ['place', 'release', 'retract', 'done'].includes(this._phase)) {
          this._contact[name] = false;
          return;
        }

        super.onFingerTouch?.(name, state, force, pointName);

        this._contact[name] = (state === 'start');
        if (state === 'start') {
          this._contactLockUntil = performance.now() + 900;
          this._ar?.setDrive(0, 0);
          logger(`👆 TOUCH: ${name}[${pointName ?? '?'}] f=${force.toFixed(2)}`, 'info');

          if (this._phase === 'approach' && !this._autoGrabCancel) {
            this._startAutoGrab();
          }
        } else {
          if (!this._contact.left && !this._contact.right) {
            this._contactLockUntil = performance.now() + 900;
          }
        }
      }

      // ══════════════════════════════════════
      //  EVENT: onGripRequest
      // ══════════════════════════════════════
      onGripRequest(state, data) {
        if (state === 'start' && (this._finished || ['place', 'release', 'retract', 'done'].includes(this._phase))) {
          this._ar?.setDrive(0, 0);
          this._ar?.setSqueeze(0);
          return;
        }

        // ══════════════════════════════════════
        // ══════════════════════════════════════
        if (state === 'end') {
          if (['lift', 'carry', 'place'].includes(this._phase)) {
            logger('🛡️ BLOCKED false release during ' + this._phase, 'warn');
            return;
          }

          if (this._grabTime && (performance.now() - this._grabTime < 2000)) {
            logger('🛡️ BLOCKED release during grace period', 'warn');
            return;
          }

          if (this._phase === 'release') {
            super.onGripRequest(state, data);
            this._contact.left = false;
            this._contact.right = false;
            this._contactLockUntil = 0;
            this.grabbed = false;
            this._autoReleaseCancel = null;
            logger('📦 RELEASED', 'info');
            this._switchPhase('retract');
            return;
          }

          logger('🛡️ BLOCKED unexpected release in phase: ' + this._phase, 'warn');
          return;
        }

        super.onGripRequest(state, data);

        if (state === 'start' && this.grabbed) {
          this._autoGrabCancel?.();
          this._autoGrabCancel = null;
          this._grabTime = performance.now();
          this._switchPhase('lift');
          logger('✅ GRAB SUCCESS → lift', 'ok');
        }
      }

      // ══════════════════════════════════════
      // ══════════════════════════════════════
      _startAutoGrab() {
        if (this._autoGrabCancel || this._phase === 'closing') return;
        if (!window.autoGrab) {
          logger('❌ autoGrab.js not loaded!', 'error');
          return;
        }

        this._switchPhase('closing');
        this._ar?.setDrive(0, 0);
        logger('🤖 autoGrab() started — closing fingers...', 'info');
        this._autoGrabCancel = window.autoGrab({ step: 1, interval: 80 });
      }

      // ══════════════════════════════════════
      // ══════════════════════════════════════
      _runTransport(ar) {
        ar.setSqueeze(1);

        if (this._phase === 'lift') {
          ar.setDrive(0, 0);
          this.robot.moveArm('shoulder', 22);
          this.robot.moveArm('elbow', 20);
          this.robot.moveArm('wrist', 0);
          if (this._elapsed() >= 1800) this._switchPhase('carry');
          return;
        }

        if (this._phase === 'carry') {
          this.robot.moveArm('shoulder', 22);
          this.robot.moveArm('elbow', 20);
          this.robot.moveArm('wrist', 0);

          const base = ar.parts.base.group.position;
          const targetYaw = Math.atan2(DROP_GOAL.x - base.x, DROP_GOAL.z - base.z);

          const desc = ar.description;
          const l1 = desc.arm?.shoulder?.len ?? 0.8;
          const l2 = (desc.arm?.elbow?.len ?? 0.8) + (desc.arm?.wrist?.h ?? 0);
          const maxReach = l1 + l2 - 0.04;
          const palmD = desc.arm.palm?.d ?? 0.26;
          const fingerD = desc.finger?.d ?? 0.18;
          const boxHalf = desc.box?.half ?? 0.25;
          const approachOff = boxHalf + (Math.max(palmD, fingerD) / 2) + 0.04;
          const dropPrefDist = Math.max(1.2, maxReach + approachOff - 0.3);

          const dropOffsetCoords = {
            x: DROP_GOAL.x - Math.sin(targetYaw) * dropPrefDist,
            y: DROP_GOAL.y ?? 0,
            z: DROP_GOAL.z - Math.cos(targetYaw) * dropPrefDist
          };

          if (driveBaseTo(ar, dropOffsetCoords, 0.18)) {
            this._switchPhase('place');
          }
          return;
        }

        if (this._phase === 'place') {
          ar.setDrive(0, 0);

          const desc = ar.description;
          const boxHalf = desc.box?.half ?? 0.25;

          // Use the ACTUAL drop goal coordinates so the IK perfectly matches the approach phase!
          const placeCoords = { x: DROP_GOAL.x, y: boxHalf, z: DROP_GOAL.z };
          const target = localTargetFrom(ar, placeCoords);

          const angles = solveArmAngles(ar, placeCoords, target, { minY: -0.15, shoulderMin: -90 });

          this.robot.moveArm('shoulder', angles.shoulder);
          this.robot.moveArm('elbow', angles.elbow);
          this.robot.moveArm('wrist', 0);

          // ── DYNAMIC DESCENT DETECTION ──
          // Track the actual physical movement of the hand!
          const palmG = ar.parts.palm.group;
          const palmWP = palmG.getWorldPosition(ar.parts.base.group.position.clone().set(0, 0, 0));

          this._lastPalmY = this._lastPalmY ?? palmWP.y;
          const diff = Math.abs(palmWP.y - this._lastPalmY);

          if (diff < 0.0015) {
            this._palmStableCount = (this._palmStableCount || 0) + 1;
          } else {
            this._palmStableCount = 0;
          }
          this._lastPalmY = palmWP.y;

          // Give it at least 2.5 seconds to start descending.
          // Once it has completely stopped moving for ~60 frames (1-2 seconds), it means it has reached the ground!
          // Ultimate fallback: 20 seconds.
          if ((this._elapsed() > 2500 && this._palmStableCount > 60) || this._elapsed() > 20000) {
            this._lastPalmY = null; // reset
            this._startAutoRelease();
          }
          return;
        }

        if (this._phase === 'release') {
          ar.setDrive(0, 0);
          if (!this.grabbed && this._elapsed() >= 2000) {
            this._switchPhase('retract');
          }
          return;
        }

        if (this._phase === 'retract') {
          ar.setDrive(0, 0);
          ar.setSqueeze(0);
          this.robot.moveArm('shoulder', 0);
          this.robot.moveArm('elbow', 0);
          this.robot.moveArm('wrist', 0);
          if (this._elapsed() >= 1500) {
            this._finished = true;
            this._switchPhase('done');
            logger('✅ MISSION COMPLETE', 'ok');
            onDone();
          }
          return;
        }

        ar.setDrive(0, 0);
      }

      // ══════════════════════════════════════
      // ══════════════════════════════════════
      _startAutoRelease() {
        if (this._autoReleaseCancel || this._phase === 'release') return;

        this._switchPhase('release');

        if (!window.autoRelease) {
          logger('⚠️ autoRelease.js not loaded → manual release', 'warn');
          this._ar?.setOpen(0.38);
          this._ar?.setSqueeze(0);
          this.robot.onGripRequest('end', {});
          return;
        }

        logger('🤖 autoRelease() started — opening fingers...', 'info');
        this._autoReleaseCancel = window.autoRelease({ step: 1, interval: 80 });

        setTimeout(() => {
          if (this._phase === 'release' && this.grabbed) {
            logger('⚠️ autoRelease timeout → force release', 'warn');
            this.robot.onGripRequest('end', {});
          }
        }, 8000);
      }

      // ══════════════════════════════════════
      // ══════════════════════════════════════
      _isBoxInGrip(ar, coords) {
        if (!coords || !ar?.parts) return false;
        const palmG = ar.parts.palm.group;

        const palmWP = palmG.getWorldPosition(ar.parts.base.group.position.clone().set(0, 0, 0));
        const palmWQ = palmG.getWorldQuaternion(ar.parts.base.group.quaternion.clone().set(0, 0, 0, 1));

        const bx = coords.x - palmWP.x;
        const by = coords.y - palmWP.y;
        const bz = coords.z - palmWP.z;

        const qx = -palmWQ.x, qy = -palmWQ.y, qz = -palmWQ.z, qw = palmWQ.w;
        // q * v * q^-1 (quaternion rotation)
        const ix = qw * bx + qy * bz - qz * by;
        const iy = qw * by + qz * bx - qx * bz;
        const iz = qw * bz + qx * by - qy * bx;
        const iw = -qx * bx - qy * by - qz * bz;
        const lx = ix * qw + iw * (-qx) + iy * (-qz) - iz * (-qy);
        const ly = iy * qw + iw * (-qy) + iz * (-qx) - ix * (-qz);
        const lz = iz * qw + iw * (-qz) + ix * (-qy) - iy * (-qx);

        const boxHalf = coords.half ?? ar.description.box?.half ?? 0.25;
        const fingerX = Math.abs(ar.parts.fingers.right.group.position.x);
        const fw = ar.FW ?? ar.parts.constants?.FW ?? 0.09;
        const innerX = Math.max(0, fingerX - fw / 2);
        const fh = ar.FH ?? ar.parts.constants?.FH ?? 0.6;
        const fd = ar.FD ?? ar.parts.constants?.FD ?? 0.18;

        const scale = ar.parts.base.group.scale.x || 1.0;

        // Moderate margins to guarantee grab if visually inside, but scaled correctly!
        const marginX = 0.2;
        const marginY = 0.2;
        const marginZ = 0.2;

        const limX = (innerX + boxHalf + marginX) * scale;
        const limY = (fh / 2 + boxHalf + marginY) * scale;
        const limZ = (fd / 2 + boxHalf + marginZ) * scale;

        const inGrip = Math.abs(lx) < limX && Math.abs(ly) < limY && Math.abs(lz) < limZ;

        // Log locally always to find out why it fails
        if (!inGrip) {
          this._lastGeoLog = this._lastGeoLog || 0;
          if (performance.now() - this._lastGeoLog > 1000) {
            console.log(`[GeoDebug] dist: ${Math.hypot(lx, ly, lz).toFixed(2)}m | lx:${lx.toFixed(2)}/${limX.toFixed(2)} ly:${ly.toFixed(2)}/${limY.toFixed(2)} lz:${lz.toFixed(2)}/${limZ.toFixed(2)} | box: ${coords.x.toFixed(2)},${coords.y.toFixed(2)},${coords.z.toFixed(2)} palm: ${palmWP.x.toFixed(2)},${palmWP.y.toFixed(2)},${palmWP.z.toFixed(2)}`);
            this._lastGeoLog = performance.now();
          }
        }

        return inGrip;
      }

      // ══════════════════════════════════════
      // ══════════════════════════════════════
      _openFingers(ar, coords) {
        const boxHalf = coords?.half ?? ar.description.box?.half ?? 0.25;
        const fw = ar.FW ?? ar.parts.constants?.FW ?? 0.09;
        const baseOpen = ar.description.finger?.openX ?? ar.FOPEN ?? 0.38;
        const minOpen = (ar.description.finger?.closeX ?? 0.295) + 0.01;
        const needed = boxHalf + fw / 2 + 0.04;
        const openVal = clamp(needed, minOpen, Math.max(baseOpen, needed));
        if (typeof ar.setOpen === 'function') ar.setOpen(openVal);

        const slider = document.getElementById('sOpen');
        if (slider) {
          const sliderVal = Math.round((openVal / 0.38) * 55);
          slider.value = clamp(sliderVal, 14, 55);
          slider.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }

      forceStop() {
        this._finished = true;
        this._switchPhase('done');
        this._autoGrabCancel?.();
        this._autoReleaseCancel?.();
        this._autoGrabCancel = null;
        this._autoReleaseCancel = null;
        this._ar?.setDrive(0, 0);
        this._ar?.setSqueeze(0);
        this.controlsDrive = false;
      }
    }
    // ────────────────────────────────────────────

    return PickPlaceListener;
  }

  // ══════════════════════════════════════════════════════════
  // ══════════════════════════════════════════════════════════

  function waitForRobot(timeoutMs = 10000) {
    const t0 = performance.now();
    return new Promise((resolve, reject) => {
      function tick() {
        if (window.robot?._robot3D && window.robot?.listener) {
          resolve(window.robot); return;
        }
        if (performance.now() - t0 > timeoutMs) {
          reject(new Error('[PickPlace] robot API not ready')); return;
        }
        requestAnimationFrame(tick);
      }
      tick();
    });
  }

  // ══════════════════════════════════════════════════════════
  // ══════════════════════════════════════════════════════════

  let _modules = null;
  let _ready = false;
  let _listener = null;

  async function initSDK() {
    if (_ready) return;
    _modules = await loadModules();
    _ready = true;
  }

  initSDK().catch(e => console.error('[PickPlace] init error:', e));

  // ══════════════════════════════════════════════════════════
  // ══════════════════════════════════════════════════════════

  window.pickAndPlace = async function (idbox = 1, droptarget = { x: -1.2, z: 2.2 }) {
    await initSDK();
    const robot = await waitForRobot();
    const { RobotListener } = _modules;

    _listener?.forceStop();

    const boxId = typeof idbox === 'number' ? idbox : parseInt(idbox, 10);
    if (!isNaN(boxId) && typeof window.setTargetBox === 'function') {
      window.setTargetBox(boxId);
    }

    const PickPlaceListener = buildListener(RobotListener, robot, {
      target: 'box',
      dropAt: droptarget,
      onDone: () => console.log('[PickPlace] 🎉 Done!'),
      logger: window.log ?? ((msg) => console.log(`[PickPlace] ${msg}`)),
    });

    const fresh = new PickPlaceListener(robot);
    robot.setListener(fresh);
    window._pickPlaceListener = fresh;
    _listener = fresh;

    console.log(`[PickPlace] ✅ Started → box #${idbox} drop at (${droptarget.x}, ${droptarget.z})`);
    console.log('[PickPlace] 📋 Use stopMission() to abort');

    return {
      status: () => _listener?.phase ?? 'idle',
      stop: () => _listener?.forceStop(),
    };
  };

  window.stopMission = function () {
    if (_listener) {
      _listener.forceStop();
      _listener = null;
    }
    const ar = window.robot?._robot3D;
    if (ar) { ar.setDrive(0, 0); ar.setSqueeze(0); }
    console.log('[PickPlace] 🛑 Stopped');
  };

  console.log('[PickPlace] ✅ Ready — type pickAndPlace() in console');

})();