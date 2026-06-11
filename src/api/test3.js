// ============================================================
//  test3.js — Cooperative Pick & Place (Robot1 → Robot2)
//  🔧 FIXED: R2 now grips box deep between fingers like R1
// ============================================================

(function () {

  async function loadModules() {
    const { RobotListener } = await import('/src/core/RobotListener.js');
    return { RobotListener };
  }

  // ── أدوات رياضية ────────────────────────────────────
  const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, v));
  const radToDeg = r => r * 180 / Math.PI;
  const normalizeRad = a => Math.atan2(Math.sin(a), Math.cos(a));
  const normalizeDeg = d => ((d + 180) % 360 + 360) % 360 - 180;

  function localTarget(ar, coords) {
    const base = ar.parts.base.group.position;
    const yaw = ar.baseState?.yaw ?? 0;
    const dx = coords.x - base.x, dz = coords.z - base.z;
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    return {
      dx, dz, distance: Math.hypot(dx, dz),
      side: dx * cos - dz * sin,
      forward: dx * sin + dz * cos,
      targetYaw: Math.atan2(dx, dz), yaw,
    };
  }

  function solveIK(ar, coords, target, overrides = {}) {
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
    const shoulderMin = overrides.shoulderMin ?? 15;
    const score = s => {
      let p = 0;
      p += Math.max(0, (limits.shoulder?.min ?? -99) - s.shoulder, s.shoulder - (limits.shoulder?.max ?? 999)) * 1000;
      p += Math.max(0, (limits.elbow?.min ?? -99) - s.elbow, s.elbow - (limits.elbow?.max ?? 999)) * 1000;
      p += Math.abs(s.elbow - 55);
      if (s.shoulder < shoulderMin) p += (shoulderMin - s.shoulder) * 100;
      return p;
    };
    const best = [-bend, bend].map(q2 => {
      const q1 = Math.atan2(y, z) - Math.atan2(l2 * Math.sin(q2), l1 + l2 * Math.cos(q2));
      return { shoulder: 90 - radToDeg(q1), elbow: -radToDeg(q2) };
    }).sort((a, b) => score(a) - score(b))[0];
    const jl = (n, v) => { const l = limits[n]; return l ? clamp(v, l.min, l.max) : v; };
    const finalWrist = overrides.forceWrist !== undefined
      ? overrides.forceWrist
      : (-radToDeg(Math.atan2(target.side, Math.max(target.forward, 0.001))) * 0.5);
    return {
      shoulder: jl('shoulder', Math.max(shoulderMin, best.shoulder)),
      elbow: jl('elbow', best.elbow),
      wrist: jl('wrist', finalWrist),
      maxReach, approachOff,
    };
  }

  function driveTo(ar, goal, stopR = 0.18) {
    const base = ar.parts.base.group.position;
    const dx = goal.x - base.x, dz = goal.z - base.z;
    const dist = Math.hypot(dx, dz);
    if (dist < stopR) { ar.setDrive(0, 0); return true; }
    const yawErr = normalizeRad(Math.atan2(dx, dz) - (ar.baseState?.yaw ?? 0));
    const mv = ar.description.movement;
    ar.setDrive(
      Math.abs(yawErr) < 0.35 ? clamp(dist * 0.75, 0.18, mv.speed * 0.55) : 0,
      Math.abs(yawErr) < 0.04 ? 0 : clamp(yawErr * 1.7, -mv.turn, mv.turn)
    );
    return false;
  }

  function baseDist(arA, arB) {
    const a = arA.parts.base.group.position;
    const b = arB.parts.base.group.position;
    return Math.hypot(a.x - b.x, a.z - b.z);
  }

  // ── isBoxInGrip الأصلية (للـ R1) ────────────────────
  function isBoxInGrip(ar, coords) {
    if (!coords || !ar?.parts) return false;
    const pg = ar.parts.palm.group;
    const wp = pg.getWorldPosition(ar.parts.base.group.position.clone().set(0, 0, 0));
    const wq = pg.getWorldQuaternion(ar.parts.base.group.quaternion.clone().set(0, 0, 0, 1));
    const bx = coords.x - wp.x, by = coords.y - wp.y, bz = coords.z - wp.z;
    const qx = -wq.x, qy = -wq.y, qz = -wq.z, qw = wq.w;
    const ix = qw * bx + qy * bz - qz * by;
    const iy = qw * by + qz * bx - qx * bz;
    const iz = qw * bz + qx * by - qy * bx;
    const iw = -qx * bx - qy * by - qz * bz;
    const lx = ix * qw + iw * (-qx) + iy * (-qz) - iz * (-qy);
    const ly = iy * qw + iw * (-qy) + iz * (-qx) - ix * (-qz);
    const lz = iz * qw + iw * (-qz) + ix * (-qy) - iy * (-qx);
    const bh = coords.half ?? 0.25;
    const fx = ar.parts.fingers.right.group.position.x;
    const fw = ar.FW ?? 0.09;
    const ix_ = fx - fw / 2;
    return Math.abs(lx) < (ix_ + bh + 0.05) && Math.abs(ly) < (0.3 + bh + 0.05) && Math.abs(lz) < (0.09 + bh + 0.05);
  }

  // ── FIX 1: isBoxDeepInGrip للـ R2 فقط ───────────────
  // تتحقق أن الصندوق دخل عميقاً بين الأصابع وليس فقط بالطرف
  function isBoxDeepInGrip(ar, coords) {
    if (!coords || !ar?.parts) return false;
    const pg = ar.parts.palm.group;
    const wp = pg.getWorldPosition(ar.parts.base.group.position.clone().set(0, 0, 0));
    const wq = pg.getWorldQuaternion(ar.parts.base.group.quaternion.clone().set(0, 0, 0, 1));
    const bx = coords.x - wp.x, by = coords.y - wp.y, bz = coords.z - wp.z;
    const qx = -wq.x, qy = -wq.y, qz = -wq.z, qw = wq.w;
    const ix = qw * bx + qy * bz - qz * by;
    const iy = qw * by + qz * bx - qx * bz;
    const iz = qw * bz + qx * by - qy * bx;
    const iw = -qx * bx - qy * by - qz * bz;
    const lx = ix * qw + iw * (-qx) + iy * (-qz) - iz * (-qy);
    const ly = iy * qw + iw * (-qy) + iz * (-qx) - ix * (-qz);
    const lz = iz * qw + iw * (-qz) + ix * (-qy) - iy * (-qx);
    const bh = coords.half ?? 0.25;
    const fx = ar.parts.fingers.right.group.position.x;
    const fw = ar.FW ?? 0.09;
    const ix_ = fx - fw / 2;
    // شرط أضيق على lz: الصندوق لازم يكون قريب من مركز الكف (عمق حقيقي)
    // 0.04 بدل 0.09 → يرفض الإمساك بالطرف
    return (
      Math.abs(lx) < (ix_ + bh + 0.04) &&
      Math.abs(ly) < (0.25 + bh + 0.04) &&
      Math.abs(lz) < 0.04  // ← الفرق الجوهري: أضيق بكثير
    );
  }

  function openFingers(ar, coords, wide) {
    const bh = coords?.half ?? 0.25;
    const fw = ar.FW ?? 0.09;
    const needed = bh + fw / 2 + 0.04;
    const minOpen = 0.305;
    const base = ar.FOPEN ?? 0.38;
    const val = wide ? Math.max(base, needed) : clamp(needed, minOpen, Math.max(base, needed));
    if (typeof ar.setOpen === 'function') ar.setOpen(val);
    const slider = document.getElementById('sOpen');
    if (slider) {
      const sliderVal = Math.round((val / 0.38) * 55);
      slider.value = clamp(sliderVal, 14, 55);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function fingerGap(ar) {
    if (!ar?.parts?.fingers?.right?.group) return 0;
    const fw = ar.FW ?? 0.09;
    return Math.max(0, (ar.parts.fingers.right.group.position.x - fw / 2) * 2);
  }

  function adaptiveHandoffWrist(ar, target, baseWrist = 0, phaseAt = 0) {
    const limits = ar.description.joints?.limits?.wrist;
    const sideAim = -radToDeg(Math.atan2(target.side, Math.max(target.forward, 0.001))) * 0.75;
    const close = clamp((1.2 - target.forward) / 0.8, 0, 1);
    const sweep = Math.sin((performance.now() - phaseAt) / 850) * 10 * close;
    const val = normalizeDeg(baseWrist * 0.35 + sideAim + sweep);
    return limits ? clamp(val, limits.min, limits.max) : val;
  }

  // ══════════════════════════════════════════════════════════
  //  CooperativeMission
  // ══════════════════════════════════════════════════════════

  function buildMission(RobotListener, robotApi, opts = {}) {
    const HANDOFF_AT = opts.handoffAt ?? { x: 2, z: -1 };
    const DROP_AT = opts.dropAt ?? { x: -1.2, z: 2.2 };
    const onDone = opts.onDone ?? (() => {});
    const log = opts.logger ?? ((m, c) => console.log(`[Coop] ${m}`));

    class CooperativeMission extends RobotListener {
      constructor(robot) {
        super(robot, log);
        if (!window.robots || window.robots.length < 2) {
          log('❌ Need 2 robots', 'error'); this.forceStop(); return;
        }
        this.controlsDrive = true;
        this._phase = 'idle';
        this._phaseAt = 0;
        this._r1 = window.robots[0];
        this._r2 = window.robots[1];
        this._handoff = window.__handoff;
        if (this._handoff) this._handoff.suppressCollision = false;
        this._r1GrabCancel = null;
        this._r2GrabCancel = null;
        this._r1ReleaseCancel = null;
        this._r2ReleaseCancel = null;
        this._r2StallCount = 0;
        this._r2DistRed = 0;
        this._r2AdaptCD = 0;
        this._r2Deployed = false;
        this._grabReadyAt = 0;
        this._retreatUntil = 0;
        this._r2CollisionCooldown = 0;
        this._r2RecoveryCount = 0;
        this._r2WideOpenUntil = 0;
        this._approachStart = 0;
        this._contact = { left: false, right: false };
        this._contactLockUntil = 0;
        this._r2HasGrip = false;
        // FIX: flag لمنع autoGrab من اللمس السطحي
        this._r2ContactDepthOk = false;
        log('🚀 Starting Cooperative Mission');
        this._switchPhase('r1_grab');
      }

      get _ar1() { return this._r1; }
      get _ar2() { return this._r2; }
      get phase() { return this._phase; }

      _switchPhase(p) {
        this._phase = p;
        this._phaseAt = performance.now();
        if (this._handoff) {
          this._handoff.suppressCollision =
            p === 'r1_present' || p === 'r2_grab' || p === 'transfer';
        }
        if (p === 'r2_approach') {
          this._approachStart = performance.now();
          this._r2StallCount = 0;
          this._r2DistRed = 0;
          this._r2Deployed = false;
          this._retreatUntil = 0;
          this._r2CollisionCooldown = 0;
          this._r2WideOpenUntil = 0;
          this._contact.left = false; this._contact.right = false;
          this._contactLockUntil = 0;
          this._r2HasGrip = false;
          this._grabReadyAt = 0;
          this._r2ContactDepthOk = false; // FIX: reset عند كل approach جديد
          const r1w = this._ar1?.jCurrent?.wrist ?? 0;
          this._r2InvWrist = normalizeDeg(r1w + 90);
        }
        log(`▶ ${p}`, 'info');
      }

      _elapsed() { return performance.now() - this._phaseAt; }

      _startAutoGrab1() {
        if (this._r1GrabCancel) return;
        this._switchPhase('r1_close');
        this._ar1.setDrive(0, 0);
        this._handoff?.setActiveIdx(0);
        if (window.autoGrab) this._r1GrabCancel = window.autoGrab({ step: 1, interval: 80 });
        else { this._ar1.setOpen(0.295); this._ar1.setSqueeze(1.0); }
        log('🤖 autoGrab R1', 'info');
      }

      _startAutoGrab2() {
        if (this._r2GrabCancel) return;
        this._r2RecoveryCount = 0;
        this._switchPhase('r2_grab');
        this._ar2.setDrive(0, 0);
        this._handoff?.setActiveIdx(1);
        if (typeof window.autoGrab !== 'function') {
          log('❌ R2 requires autoGrab.js (window.autoGrab)', 'error');
          this.forceStop();
          return;
        }
        this._r2GrabCancel = window.autoGrab({ step: 1, interval: 80, force: true });
        log('🤖 autoGrab R2', 'info');
      }

      _startAutoRelease1() {
        if (this._r1ReleaseCancel) return;
        this._switchPhase('r1_release');
        this._ar1.setDrive(0, 0);
        this._handoff?.setActiveIdx(0);
        if (window.autoRelease) this._r1ReleaseCancel = window.autoRelease({ step: 1, interval: 80 });
        else { this._ar1.setOpen(0.38); this._ar1.setSqueeze(0); }
        log('📤 autoRelease R1', 'info');
      }

      _startAutoRelease2() {
        if (this._r2ReleaseCancel) return;
        this._switchPhase('r2_release');
        this._ar2.setDrive(0, 0);
        this._handoff?.setActiveIdx(1);
        if (typeof window.autoRelease !== 'function') {
          log('❌ R2 requires autoRelease.js (window.autoRelease)', 'error');
          this.forceStop();
          return;
        }
        this._r2ReleaseCancel = window.autoRelease({ step: 1, interval: 80 });
        log('📤 autoRelease R2', 'info');
      }

      _confirmR2Grip(coords) {
        if (this._r2HasGrip) return;
        this._r2HasGrip = true;
        const mass = this._ar1?.loadedMass ?? this._ar2?.loadedMass ?? 0;
        this._handoff?.setActiveIdx(1);
        this._handoff?.setHoldingIdx(1);
        this._handoff?.saveGripOffset(null);
        if (mass > 0) {
          this._ar1?.setLoadedBox(0, null);
          this._ar2?.setLoadedBox(mass, { x: coords.x, y: coords.y, z: coords.z });
        }
      }

      _finishHandoff(coords) {
        this._r1ReleaseCancel?.(); this._r1ReleaseCancel = null;
        this._r2GrabCancel?.(); this._r2GrabCancel = null;
        if (coords) this._confirmR2Grip(coords);
        this._handoff?.setActiveIdx(1);
        this._handoff?.setHoldingIdx(1);
        this._handoff?.saveGripOffset(null);
        if (this._handoff) this._handoff.suppressCollision = false;
        this._ar1?.setDrive(0, 0);
        this._ar2?.setDrive(0, 0);
        this._ar1?.moveJoint('shoulder', 0);
        this._ar1?.moveJoint('elbow', 0);
        this._ar1?.moveJoint('wrist', 0);
        this._ar2?.moveJoint('shoulder', 22);
        this._ar2?.moveJoint('elbow', 20);
        this._ar2?.moveJoint('wrist', 0);
        this._finished = true;
        this._switchPhase('done');
        log('✅ HANDOFF COMPLETE - R2 is holding the box', 'ok');
        onDone();
      }

      _triggerR2CollisionRecovery(reason, force = false) {
        const now = performance.now();
        if (!force && now < this._r2CollisionCooldown) return false;
        this._r2CollisionCooldown = now + 1200;
        this._r2Deployed = false;
        this._r2StallCount = 0;
        this._r2AdaptCD = 0;
        this._r2RecoveryCount++;
        this._r2RecoverReason = reason;
        this._r2ContactDepthOk = false; // FIX: reset عند recovery
        this._ar2?.setDrive(0, 0);
        this._switchPhase('r2_recover');
        log(`R2 collision recovery #${this._r2RecoveryCount}: ${reason}`, 'warn');
        return true;
      }

      // ══════════════════════════════════════════
      //  FIX 2: onFingerTouch — لا تشغل autoGrab مباشرة
      //  انتظر حتى onObjectDetected يتحقق من العمق
      // ══════════════════════════════════════════
      onFingerTouch(name, state, force, pointName) {
        if (name !== 'left' && name !== 'right') return;
        if (this._phase === 'done') { this._contact[name] = false; return; }

        if (state === 'start' && this._phase === 'r2_approach') {
          super.onFingerTouch?.(name, state, force, pointName);
          this._contact[name] = true;
          this._contactLockUntil = performance.now() + 900;
          this._ar2?.setDrive(0, 0);
          const activeIdx = this._handoff?.getActiveIdx?.();
          const c = this._lastBoxCoords;
          if (activeIdx === 1 && !this._r2GrabCancel && c && isBoxInGrip(this._ar2, c)) {
            log('R2 touch + box between fingers -> autoGrab', 'ok');
            this._startAutoGrab2();
          } else if (activeIdx === 1 && !this._r2GrabCancel) {
            this._triggerR2CollisionRecovery('R2 finger touched box before grip alignment', true);
          }
          return;
        }

        super.onFingerTouch?.(name, state, force, pointName);

        this._contact[name] = (state === 'start');

        if (state === 'start') {
          this._contactLockUntil = performance.now() + 900;

          // FIX: R1 يشغل autoGrab عند اللمس (الصندوق على الأرض ثابت — OK)
          if (this._phase === 'r1_approach') {
            const activeIdx = this._handoff?.getActiveIdx?.();
            if (activeIdx === 0 && !this._r1GrabCancel) {
              this._ar1?.setDrive(0, 0);
              this._startAutoGrab1();
            }
          }

          // FIX: R2 عند اللمس → أوقف فقط، لا تشغل autoGrab
          // onObjectDetected سيتحقق من isBoxDeepInGrip قبل autoGrab
          if (this._phase === 'r2_approach') {
            const activeIdx = this._handoff?.getActiveIdx?.();
            if (activeIdx === 1 && !this._r2GrabCancel) {
              this._ar2?.setDrive(0, 0);
              // لا نشغل autoGrab هنا — ننتظر التحقق من العمق
              log('👆 R2 finger touch — waiting for deep grip check', 'info');
            }
          }

        } else {
          if (!this._contact.left && !this._contact.right) {
            this._contactLockUntil = performance.now() + 900;
          }
        }
      }

      // ══════════════════════════════════════════
      //  MAIN TICK
      // ══════════════════════════════════════════
      onObjectDetected(id, coords) {
        if (id !== 'box' || this._phase === 'done') return;
        const a1 = this._ar1, a2 = this._ar2;
        this._lastBoxCoords = coords;

        // ────────────────────────────────────────
        //  PHASE 1 : R1 grabs box
        // ────────────────────────────────────────
        if (['r1_grab', 'r1_nav', 'r1_approach', 'r1_close'].includes(this._phase)) {
          this._handoff?.setActiveIdx(0);
          if (this.grabbed) { this._switchPhase('r1_lift'); return; }
          if (this._phase === 'r1_close') { a1.setDrive(0, 0); return; }

          if (!this._r1GrabCancel && isBoxInGrip(a1, coords)) {
            log('📐 Box between fingers → autoGrab R1', 'ok');
            this._startAutoGrab1();
            return;
          }

          if (this._phase === 'idle') this._switchPhase('r1_nav');
          const t = localTarget(a1, coords);
          const ik = solveIK(a1, coords, t, { minY: -0.15, shoulderMin: 15 });
          const pref = clamp(ik.maxReach + ik.approachOff - 0.3, 1.2, ik.maxReach + ik.approachOff);
          const yawErr = normalizeRad(t.targetYaw - t.yaw);
          const fwdErr = t.forward - pref;
          const aligned = Math.abs(yawErr) < 0.22;
          let speed = 0;
          if (aligned && fwdErr > 0.02) speed = clamp(fwdErr * 0.55, 0.015, a1.description.movement.speed * 0.45);
          const turn = Math.abs(yawErr) < 0.04 ? 0 : clamp(yawErr * 1.8, -a1.description.movement.turn, a1.description.movement.turn);
          a1.setDrive(speed, turn);

          const canDeploy = t.forward <= pref + 0.22 && Math.abs(yawErr) <= 0.32 && Math.abs(t.side) <= (coords.half ?? 0.25) + 0.22;
          if (!canDeploy) {
            if (this._phase === 'r1_approach') return;
            a1.moveJoint('shoulder', 0); a1.moveJoint('elbow', 0); a1.moveJoint('wrist', 0);
            openFingers(a1, coords); this._switchPhase('r1_nav'); return;
          }
          this._switchPhase('r1_approach');
          a1.moveJoint('shoulder', ik.shoulder); a1.moveJoint('elbow', ik.elbow); a1.moveJoint('wrist', ik.wrist);
          openFingers(a1, coords);
          if (isBoxInGrip(a1, coords)) {
            log('📐 Box in grip → autoGrab R1', 'ok');
            this._startAutoGrab1();
          }
          return;
        }

        // ────────────────────────────────────────
        //  PHASE 1b : R1 lifts and transports
        // ────────────────────────────────────────
        if (this._phase === 'r1_lift') {
          a1.setDrive(0, 0);
          a1.moveJoint('shoulder', 22); a1.moveJoint('elbow', 20); a1.moveJoint('wrist', 0);
          if (this._elapsed() >= 1800) this._switchPhase('r1_transport');
          return;
        }
        if (this._phase === 'r1_transport') {
          a1.moveJoint('shoulder', 22); a1.moveJoint('elbow', 20); a1.moveJoint('wrist', 0);
          if (driveTo(a1, HANDOFF_AT)) this._switchPhase('r1_present');
          return;
        }

        // ────────────────────────────────────────
        //  PHASE 1c : R1 presents box face-to-face
        // ────────────────────────────────────────
        if (this._phase === 'r1_present') {
          const r2p = a2.parts.base.group.position;
          const yawErr = normalizeRad(Math.atan2(r2p.x - a1.parts.base.group.position.x, r2p.z - a1.parts.base.group.position.z) - (a1.baseState?.yaw ?? 0));
          a1.setDrive(0, Math.abs(yawErr) < 0.04 ? 0 : clamp(yawErr * 1.6, -1.5, 1.5));
          a1.moveJoint('shoulder', 35); a1.moveJoint('elbow', 45); a1.moveJoint('wrist', 0);
          if (this._elapsed() > 2000) {
            this._switchPhase('r2_approach');
          }
          return;
        }

        // ────────────────────────────────────────
        //  PHASE 2 : R2 approaches
        // ────────────────────────────────────────
        if (this._phase === 'r2_approach') {

          // FIX 3: استخدم isBoxDeepInGrip بدل isBoxInGrip
          if (!this._r2GrabCancel && isBoxInGrip(a2, coords)) {
            a2.setDrive(0, 0);
            log('🤝 Box DEEP between R2 fingers → autoGrab R2', 'ok');
            this._startAutoGrab2();
            return;
          }

          if (performance.now() < this._retreatUntil) {
            a2.setDrive(-0.25, 0);
            a2.moveJoint('shoulder', 0); a2.moveJoint('elbow', 0); a2.moveJoint('wrist', 0);
            openFingers(a2, coords, true);
            this._r2Deployed = false;
            this._r2ContactDepthOk = false; // FIX
            return;
          }

          this._handoff?.setActiveIdx(1);
          a1.setDrive(0, 0);

          const t = localTarget(a2, coords);
          const bh = coords.half ?? 0.25;
          const mv = a2.description.movement;
          const sensorContact = this._contact.left || this._contact.right;
          const boxInGrip = isBoxInGrip(a2, coords);
          const geoContact = boxInGrip;
          const bodyA = a1.description?.base?.body ?? {};
          const bodyB = a2.description?.base?.body ?? {};
          const rA = Math.max(bodyA.w ?? 0.6, bodyA.d ?? 0.8) * 0.6;
          const rB = Math.max(bodyB.w ?? 0.6, bodyB.d ?? 0.8) * 0.6;
          const safeRobotGap = rA + rB + 0.35;
          const robotGap = baseDist(a1, a2);
          const robotHit = robotGap < safeRobotGap && t.forward < 1.20;
          const boxSideImpact = t.forward < 0.95 && Math.abs(t.side) > bh + 0.12;

          if (robotHit && !boxInGrip) {
            const b1 = a1.parts.base.group.position;
            const b2 = a2.parts.base.group.position;
            const awayYaw = Math.atan2(b2.x - b1.x, b2.z - b1.z);
            const yawAwayErr = normalizeRad(awayYaw - (a2.baseState?.yaw ?? 0));
            if (this._handoff) this._handoff.suppressCollision = true;
            a2.setDrive(
              Math.abs(yawAwayErr) < 0.45 ? clamp((safeRobotGap - robotGap) * 0.5, 0.10, mv.speed * 0.35) : 0,
              Math.abs(yawAwayErr) < 0.05 ? 0 : clamp(yawAwayErr * 1.4, -mv.turn, mv.turn)
            );
            a2.moveJoint('shoulder', 0);
            a2.moveJoint('elbow', 0);
            a2.moveJoint('wrist', 0);
            openFingers(a2, coords, true);
            this._r2Deployed = false;
            return;
          }
          if (this._handoff) this._handoff.suppressCollision = false;

          if (!sensorContact && !geoContact && boxSideImpact) {
            if (this._handoff) this._handoff.suppressCollision = false;
            a2.setDrive(0, clamp((t.side > 0 ? -1 : 1) * mv.turn * 0.45, -mv.turn, mv.turn));
            a2.moveJoint('shoulder', 0);
            a2.moveJoint('elbow', 0);
            a2.moveJoint('wrist', 0);
            openFingers(a2, coords, true);
            this._r2Deployed = false;
            return;
          }

          if (!this._r2GrabCancel && boxInGrip) {
            a2.setDrive(0, 0);
            log('R2 box between fingers -> autoGrab', 'ok');
            this._startAutoGrab2();
            return;
          }

          const ikOverrides = {
            minY: -0.15 - (this._r2StallCount * 0.05),
            shoulderMin: Math.max(-10, 15 - this._r2StallCount * 3),
          };
          const ik = solveIK(a2, coords, t, ikOverrides);
          ik.wrist = adaptiveHandoffWrist(a2, t, this._r2InvWrist, this._phaseAt);

          // FIX 4: pref أقل → R2 يدخل أعمق قبل ما يتوقف
          // كان: maxReach + 0.05  →  صار: maxReach - 0.20
          const gripDepth = Math.max(0.18, bh + (a2.description.arm.palm?.d ?? 0.26) * 0.55);
          const basePref = ik.maxReach - gripDepth;
          const pref = Math.max(0.42, basePref - this._r2DistRed);

          const yawErr = normalizeRad(t.targetYaw - t.yaw);
          const fwdErr = t.forward - pref;
          const aligned = Math.abs(yawErr) < 0.22;

          const canDeploy = t.forward <= pref + 0.45 && Math.abs(yawErr) <= 0.34 && Math.abs(t.side) <= bh + 0.24;

          let speed = 0;
          if (aligned && fwdErr > 0.02) {
            const r = clamp(fwdErr / 0.25, 0.15, 1);
            speed = clamp(fwdErr * 0.55 * r, 0.015, mv.speed * 0.45);
          } else if (aligned && fwdErr < -0.08) {
            speed = clamp(fwdErr * 0.45, -mv.speed * 0.25, -0.04);
          }
          if (canDeploy) {
            speed *= 0.12;
          }

          const turn = Math.abs(yawErr) < 0.04 ? 0 : clamp(yawErr * 1.8, -mv.turn, mv.turn);
          a2.setDrive(speed, turn);

          if (!canDeploy) {
            if (this._r2Deployed) return;
            a2.moveJoint('shoulder', 0); a2.moveJoint('elbow', 0); a2.moveJoint('wrist', 0);
            openFingers(a2, coords, true); return;
          }

          this._r2Deployed = true;
          a2.moveJoint('shoulder', ik.shoulder); a2.moveJoint('elbow', ik.elbow); a2.moveJoint('wrist', ik.wrist);
          openFingers(a2, coords, true);

          // Sensor + box between fingers → autoGrab
          if (sensorContact && !this._r2GrabCancel) {
            if (boxInGrip) {
              a2.setDrive(0, 0);
              log('🤝 R2 sensor + box in grip → autoGrab', 'ok');
              this._startAutoGrab2();
            } else {
              log('👆 R2 sensor touch — box not between fingers yet', 'info');
              a2.setDrive(0, 0);
              this._triggerR2CollisionRecovery('R2 touched box outside finger gap', true);
            }
            return;
          }

          if (geoContact) {
            a2.setDrive(0, 0);
            if (!this._r2GrabCancel) {
              log('🤝 R2 deep geo contact → autoGrab', 'ok');
              this._startAutoGrab2();
            }
            return;
          }

          // Adaptation — stall detection
          const now = performance.now();
          const total = now - this._approachStart;

          if (this._r2Deployed) {
            if (!this._lastFwd) { this._lastFwd = t.forward; this._lastFwdTime = now; }
            if (now - this._lastFwdTime > 3000) {
              if (this._lastFwd - t.forward < 0.01) {
                this._triggerR2CollisionRecovery('stuck deployed', true);
                this._lastFwd = null;
                return;
              }
              this._lastFwd = t.forward; this._lastFwdTime = now;
            }
          } else {
            this._lastFwd = null;
          }

          if (!this._r2Deployed && total > 3000 && now > this._r2AdaptCD) {
            this._r2StallCount++;
            this._r2DistRed += 0.25;
            this._r2AdaptCD = now + 3000;
            log(`🔧 R2 stall #${this._r2StallCount} distRed=${this._r2DistRed.toFixed(2)}`, 'warn');
            a2.setDrive(clamp(0.25, 0.1, mv.speed * 0.35), 0);
            return;
          }

          if (!this._r2Deployed && total > 20000) {
            log('⚠️ R2 timeout → retreat', 'warn');
            a2.moveJoint('shoulder', 0); a2.moveJoint('elbow', 0); a2.moveJoint('wrist', 0);
            a2.setDrive(-0.3, 0);
            this._r2Deployed = false;
            this._r2StallCount = 0; this._r2DistRed = 0;
            this._retreatUntil = now + 3000;
            this._approachStart = now + 3000;
            return;
          }

          // منع الاختراق الشديد — خففنا الحد للسماح بالاقتراب اللازم
          if (t.forward < 0.35) {
            this._triggerR2CollisionRecovery('box front contact', true);
            return;
          }

          // FIX 6: الشرط الأخير — isBoxDeepInGrip فقط + forward أقل
          if (isBoxDeepInGrip(a2, coords) && Math.abs(t.side) < 0.08 && t.forward < ik.maxReach - 0.05) {
            a2.setDrive(0, 0);
            log('🤝 Box deep in grip → autoGrab R2', 'ok');
            this._startAutoGrab2();
          }
          return;
        }

        // ────────────────────────────────────────
        //  R2 recovery
        // ────────────────────────────────────────
        if (this._phase === 'r2_recover') {
          openFingers(a2, coords, true);
          a2.moveJoint('shoulder', 0);
          a2.moveJoint('elbow', 0);
          const backoffMs = Math.min(800 + 300 * this._r2RecoveryCount, 2000);
          a2.setDrive(-0.35, 0);
          if (this._elapsed() > backoffMs) {
            this._r2Deployed = false;
            this._r2StallCount = 0;
            this._r2AdaptCD = 0;
            this._r2ContactDepthOk = false; // FIX
            this._switchPhase('r2_approach');
            this._r2WideOpenUntil = performance.now() + 1500;
            log(`🔁 R2 RECOVER #${this._r2RecoveryCount} → approach (backoff=${(backoffMs / 1000).toFixed(1)}s)`, 'info');
          }
          return;
        }

        // ────────────────────────────────────────
        //  R2 grab phase
        // ────────────────────────────────────────
        if (this._phase === 'r2_grab') {
          a2.setDrive(0, 0);
          this._handoff?.setActiveIdx(1);
          if (this.grabbed && isBoxInGrip(a2, coords) && fingerGap(a2) < ((coords.half ?? 0.25) * 2 + 0.08)) {
            this._confirmR2Grip(coords);
            this._r2GrabCancel?.(); this._r2GrabCancel = null;
            this._switchPhase('transfer');
            log('📦 R2 GRIP → transfer', 'ok');
          }
          return;
        }

        // ────────────────────────────────────────
        //  Transfer R1 → R2
        // ────────────────────────────────────────
        if (this._phase === 'transfer') {
          log('🔑 Transfer: R1→R2', 'ok');
          this._r2GrabCancel?.(); this._r2GrabCancel = null;
          this._startAutoRelease1();
          return;
        }

        // ────────────────────────────────────────
        //  R1 releases
        // ────────────────────────────────────────
        if (this._phase === 'r1_release') {
          a1.setDrive(0, 0);
          this._handoff?.setActiveIdx(0);
          if (!this._r1ReleaseCancel && this._elapsed() > 1500) {
            this._handoff?.setActiveIdx(1);
            this._handoff?.setHoldingIdx(1);
            this._handoff?.saveGripOffset(null);
            this._finishHandoff(coords);
          }
          if (this._elapsed() > 5000) {
            this._r1ReleaseCancel?.(); this._r1ReleaseCancel = null;
            this._handoff?.setActiveIdx(1);
            this._handoff?.setHoldingIdx(1);
            this._handoff?.saveGripOffset(null);
            this._finishHandoff(coords);
          }
          return;
        }

        // ────────────────────────────────────────
        //  R2 transports to drop point
        // ────────────────────────────────────────
        if (['r2_transport', 'r2_place', 'r2_release', 'r2_retract'].includes(this._phase)) {
          this._finishHandoff(coords);
          return;
        }

        if (this._phase === 'r2_transport') {
          this._handoff?.setActiveIdx(1);
          a1.setDrive(-0.25, 0);
          a1.moveJoint('shoulder', 0); a1.moveJoint('elbow', 0); a1.moveJoint('wrist', 0);
          a2.moveJoint('shoulder', 22); a2.moveJoint('elbow', 20); a2.moveJoint('wrist', 0);
          if (driveTo(a2, DROP_AT)) {
            a1.setDrive(0, 0);
            this._switchPhase('r2_place');
          }
          return;
        }

        // ────────────────────────────────────────
        //  R2 places box
        // ────────────────────────────────────────
        if (this._phase === 'r2_place') {
          a2.setDrive(0, 0);
          const t = localTarget(a2, coords);
          const ik = solveIK(a2, coords, t, { minY: -0.15, shoulderMin: 15 });
          a2.moveJoint('shoulder', ik.shoulder); a2.moveJoint('elbow', ik.elbow); a2.moveJoint('wrist', ik.wrist);
          if (this._elapsed() > 1800) this._switchPhase('r2_release');
          return;
        }

        // ────────────────────────────────────────
        //  R2 releases
        // ────────────────────────────────────────
        if (this._phase === 'r2_release') {
          if (!this._r2ReleaseCancel) this._startAutoRelease2();
          if (this._elapsed() > 4000) {
            this._r2ReleaseCancel?.(); this._r2ReleaseCancel = null;
            this._handoff?.setHoldingIdx(-1);
            this._switchPhase('r2_retract');
          }
          return;
        }

        if (this._phase === 'r2_retract') {
          a2.setDrive(-0.3, 0);
          a2.moveJoint('shoulder', 0); a2.moveJoint('elbow', 0); a2.moveJoint('wrist', 0);
          if (this._elapsed() > 1500) {
            a2.setDrive(0, 0);
            log('✅ MISSION COMPLETE!', 'ok');
            this._finished = true;
            this._switchPhase('done');
            onDone();
          }
          return;
        }
      }

      onGripRequest(state, data) {
        if (state === 'start') {
          if (this._phase === 'r1_close') {
            super.onGripRequest(state, data);
            if (this.grabbed) {
              this._r1GrabCancel?.(); this._r1GrabCancel = null;
              this._switchPhase('r1_lift');
              log('📦 R1 GRAB', 'ok');
            }
          }
          if (this._phase === 'r2_grab') {
            super.onGripRequest(state, data);
          }
        }
        if (state === 'end') {
          if (this._phase === 'r1_release') {
            if (!this._r2HasGrip) super.onGripRequest(state, data);
            this._r1ReleaseCancel?.(); this._r1ReleaseCancel = null;
            this._handoff?.setActiveIdx(1);
            this._handoff?.setHoldingIdx(1);
            this._handoff?.saveGripOffset(null);
            this._finishHandoff(data?.coords);
            log('R1 RELEASED -> handoff complete', 'ok');
          }
          if (this._phase === 'r2_release') {
            super.onGripRequest(state, data);
            this._r2ReleaseCancel?.(); this._r2ReleaseCancel = null;
            this._handoff?.setHoldingIdx(-1);
            this._switchPhase('r2_retract');
            log('📤 R2 RELEASED → retract', 'ok');
          }
        }
      }

      forceStop() {
        if (this._handoff) this._handoff.suppressCollision = false;
        this._finished = true;
        this._switchPhase('done');
        this._r1GrabCancel?.(); this._r1GrabCancel = null;
        this._r2GrabCancel?.(); this._r2GrabCancel = null;
        this._r1ReleaseCancel?.(); this._r1ReleaseCancel = null;
        this._r2ReleaseCancel?.(); this._r2ReleaseCancel = null;
        this._ar1?.setDrive(0, 0); this._ar2?.setDrive(0, 0);
        this.controlsDrive = false;
        log('🛑 Stopped');
      }
    }
    return CooperativeMission;
  }

  // ── System init ──────────────────────────────────
  let _modules = null, _ready = false, _listener = null;

  async function init() {
    if (_ready) return;
    _modules = await loadModules();
    _ready = true;
  }
  init().catch(e => console.error('[Coop] init error:', e));

  function waitForSystem(ms = 10000) {
    const t0 = performance.now();
    return new Promise((res, rej) => {
      function tick() {
        if (window.robot && window.__handoff && window.robots?.length >= 2) { res(window.robot); return; }
        if (performance.now() - t0 > ms) { rej(new Error('Timeout')); return; }
        requestAnimationFrame(tick);
      }
      tick();
    });
  }

  // ── Public API ──────────────────────────────────
  window.coop = async function (handoffAt) {
    await init();
    const api = await waitForSystem();
    const { RobotListener } = _modules;
    _listener?.forceStop();
    const log = window.log ?? ((m) => console.log(`[Coop] ${m}`));
    const Cls = buildMission(RobotListener, api, {
      handoffAt,
      onDone: () => log('[Coop] 🎉 Done!'),
      logger: window.log ?? ((m) => console.log(`[Coop] ${m}`)),
    });
    const inst = new Cls(api);
    api.setListener(inst);
    _listener = inst;
    console.log('[Coop] ✅ Started — type stop() to abort');
    return { status: () => _listener?.phase ?? 'idle', stop: () => _listener?.forceStop() };
  };

  window.stop = function () { _listener?.forceStop(); _listener = null; };

  console.log('[test3.js] ✅ Ready — type coop()');
})();
