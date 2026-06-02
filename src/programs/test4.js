// ============================================================
//  test4.js — Vision-Guided Pick & Place with Collision Avoidance
//
//  API:  pickAndPlaceVision(idBox, dropTarget)
//        pickAndPlaceVision(1, {x: -1.2, z: 2.2})
//
//  Features:
//    1. Camera vision to locate the box
//    2. IK-based approach with proper angle & finger opening
//    3. autoGrab.js integration for secure grip
//    4. Vision-based collision avoidance during transport
//    5. Smart drop placement (avoids obstacles near drop zone)
//    6. autoRelease.js integration for clean release
//
//  Console:
//    pickAndPlaceVision(1)              // box #1 → default drop
//    pickAndPlaceVision(3, {x:5, z:3})  // box #3 → custom drop
//    stopVisionMission()                // abort
//    visionStatus()                     // current phase + info
// ============================================================

(function () {

  async function loadModules() {
    const { RobotListener } = await import('/src/core/RobotListener.js');
    return { RobotListener };
  }

  // ══════════════════════════════════════════════════════════
  //  Math Utilities
  // ══════════════════════════════════════════════════════════

  const clamp   = (v, mn, mx) => Math.max(mn, Math.min(mx, v));
  const radToDeg = r => r * 180 / Math.PI;
  const normalizeRad = a => Math.atan2(Math.sin(a), Math.cos(a));

  // ── Local target info relative to robot base ──
  function localTarget(ar, coords) {
    const base = ar.parts.base.group.position;
    const yaw  = ar.baseState?.yaw ?? 0;
    const dx   = coords.x - base.x;
    const dz   = coords.z - base.z;
    const sin  = Math.sin(yaw), cos = Math.cos(yaw);
    return {
      dx, dz,
      distance:  Math.hypot(dx, dz),
      side:      dx * cos - dz * sin,
      forward:   dx * sin + dz * cos,
      targetYaw: Math.atan2(dx, dz),
      yaw,
    };
  }

  // ── 2-link IK solver ──
  function solveIK(ar, coords, target, overrides = {}) {
    const desc    = ar.description;
    const baseOffY = ar.parts.constants.BASE_OFF;
    const l1      = desc.arm.shoulder.len;
    const palmD   = desc.arm.palm?.d ?? 0.26;
    const fingerD = desc.finger?.d ?? 0.18;
    const frontDepth = Math.max(palmD, fingerD) / 2;
    const boxHalf = coords.half ?? desc.box?.half ?? 0.25;
    const approachOff = boxHalf + frontDepth + 0.04;
    const wristH  = desc.arm.wrist?.h ?? 0;
    const l2      = desc.arm.elbow.len + wristH + 0.06;
    const maxReach = l1 + l2 - 0.04;
    const minReach = Math.abs(l1 - l2) + 0.04;

    let z = Math.max(0.2, target.forward - approachOff);
    let y = coords.y - baseOffY;
    const minY = overrides.minY ?? -0.15;
    if (y < minY) y = minY;

    let reach = Math.hypot(z, y);
    if (reach > maxReach) {
      const s = maxReach / reach; z *= s; y *= s; reach = maxReach;
    } else if (reach < minReach) {
      const s = minReach / Math.max(reach, 0.001); z *= s; y *= s;
    }

    const cosQ2 = clamp((reach * reach - l1 * l1 - l2 * l2) / (2 * l1 * l2), -1, 1);
    const bend  = Math.acos(cosQ2);
    const limits = desc.joints?.limits ?? {};
    const shoulderMin = overrides.shoulderMin ?? 15;

    const score = s => {
      let p = 0;
      p += Math.max(0, (limits.shoulder?.min ?? -99) - s.shoulder,
                       s.shoulder - (limits.shoulder?.max ?? 999)) * 1000;
      p += Math.max(0, (limits.elbow?.min ?? -99) - s.elbow,
                       s.elbow - (limits.elbow?.max ?? 999)) * 1000;
      p += Math.abs(s.elbow - 55);
      if (s.shoulder < shoulderMin) p += (shoulderMin - s.shoulder) * 100;
      return p;
    };

    const best = [-bend, bend].map(q2 => {
      const q1 = Math.atan2(y, z) - Math.atan2(l2 * Math.sin(q2), l1 + l2 * Math.cos(q2));
      return { shoulder: 90 - radToDeg(q1), elbow: -radToDeg(q2) };
    }).sort((a, b) => score(a) - score(b))[0];

    const jl = (n, v) => {
      const l = limits[n];
      return l ? clamp(v, l.min, l.max) : v;
    };

    return {
      shoulder: jl('shoulder', Math.max(shoulderMin, best.shoulder)),
      elbow:    jl('elbow', best.elbow),
      wrist:    jl('wrist', -radToDeg(Math.atan2(target.side, Math.max(target.forward, 0.001))) * 0.5),
      maxReach,
      approachOff,
    };
  }

  // ── Drive base toward a goal ──
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

  // ── Point-to-segment distance (XZ plane) ──
  function pointToSegDist(px, pz, ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz;
    if (len2 < 0.001) return Math.hypot(px - ax, pz - az);
    let t = ((px - ax) * dx + (pz - az) * dz) / len2;
    t = clamp(t, 0, 1);
    return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
  }

  // ── Compute detour waypoint around obstacle ──
  function computeDetour(cx, cz, gx, gz, ox, oz, radius) {
    const dx = gx - cx, dz = gz - cz;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) return null;
    const perpX = -dz / len, perpZ = dx / len;
    const off = radius + 1.5;
    const w1 = { x: ox + perpX * off, z: oz + perpZ * off };
    const w2 = { x: ox - perpX * off, z: oz - perpZ * off };
    const c1 = Math.hypot(w1.x - cx, w1.z - cz) + Math.hypot(w1.x - gx, w1.z - gz);
    const c2 = Math.hypot(w2.x - cx, w2.z - cz) + Math.hypot(w2.x - gx, w2.z - gz);
    return c1 <= c2 ? w1 : w2;
  }

  // ── Check if box is between robot fingers ──
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
    return (
      Math.abs(lx) < (ix_ + bh + 0.05) &&
      Math.abs(ly) < (0.3 + bh + 0.05) &&
      Math.abs(lz) < (0.09 + bh + 0.05)
    );
  }

  // ── Open fingers to accommodate box ──
  function openFingers(ar, coords, wide = false) {
    const bh     = coords?.half ?? 0.25;
    const fw     = ar.FW ?? 0.09;
    const needed = bh + fw / 2 + 0.04;
    const minOpen = 0.305;
    const base   = ar.FOPEN ?? 0.38;
    const val    = wide ? Math.max(base, needed) : clamp(needed, minOpen, Math.max(base, needed));
    if (typeof ar.setOpen === 'function') ar.setOpen(val);
    const slider = document.getElementById('sOpen');
    if (slider) {
      const sliderVal = Math.round((val / 0.38) * 55);
      slider.value = clamp(sliderVal, 14, 55);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // ── Open fingers fully (maximum opening) ──
  function openFingersFull(ar) {
    const maxOpen = ar.FOPEN ?? 0.38;
    if (typeof ar.setOpen === 'function') ar.setOpen(maxOpen);
    const slider = document.getElementById('sOpen');
    if (slider) {
      slider.value = 55;
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // ══════════════════════════════════════════════════════════
  //  Vision Helpers
  // ══════════════════════════════════════════════════════════

  // Get box position from vision system
  function visionFindBox(boxId) {
    const v = window.__vision;
    if (!v || !v.active) return null;
    const dets = v.getDetections();
    for (const d of dets) {
      if (d.name === 'box' && d.boxId === boxId) {
        return { x: d.worldX, y: d.worldY, z: d.worldZ, distance: d.distance };
      }
    }
    return null;
  }

  // Get all obstacles (robots + non-target boxes) from vision
  function visionGetObstacles(excludeBoxId) {
    const v = window.__vision;
    if (!v || !v.active) return [];
    const dets = v.getDetections();
    const obstacles = [];
    for (const d of dets) {
      if (d.name === 'robot') {
        obstacles.push({ type: 'robot', x: d.worldX, z: d.worldZ, dist: d.distance, radius: 2.0 });
      }
      if (d.name === 'box' && d.boxId !== excludeBoxId) {
        obstacles.push({ type: 'box', x: d.worldX, z: d.worldZ, dist: d.distance, radius: 0.8 });
      }
    }
    return obstacles;
  }

  // Check if a position has obstacles nearby
  function isPositionBlocked(x, z, obstacles, clearRadius = 1.2) {
    for (const ob of obstacles) {
      if (Math.hypot(ob.x - x, ob.z - z) < clearRadius) return true;
    }
    return false;
  }

  // Find nearest clear spot around a blocked position
  function findClearSpot(x, z, obstacles, clearRadius = 1.2) {
    if (!isPositionBlocked(x, z, obstacles, clearRadius)) return { x, z };
    // Try concentric rings
    for (let r = 0.8; r <= 4.0; r += 0.6) {
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 6) {
        const cx = x + r * Math.cos(a);
        const cz = z + r * Math.sin(a);
        if (!isPositionBlocked(cx, cz, obstacles, clearRadius)) {
          return { x: cx, z: cz };
        }
      }
    }
    return { x, z }; // fallback: original position
  }

  // Find blocking obstacle on path
  function findBlockingObstacle(cx, cz, gx, gz, obstacles, corridorWidth = 2.0) {
    const pathLen = Math.hypot(gx - cx, gz - cz);
    if (pathLen < 0.5) return null;
    let closest = null, closestDist = Infinity;
    for (const ob of obstacles) {
      const d = pointToSegDist(ob.x, ob.z, cx, cz, gx, gz);
      if (d >= corridorWidth) continue;
      const toOb = Math.hypot(ob.x - cx, ob.z - cz);
      const obToGoal = Math.hypot(ob.x - gx, ob.z - gz);
      if (toOb < pathLen + 1.0 && obToGoal < pathLen + 1.0) {
        if (d < closestDist) {
          closestDist = d;
          closest = ob;
        }
      }
    }
    return closest;
  }

  // ══════════════════════════════════════════════════════════
  //  VisionPickPlaceListener
  //
  //  Phases:
  //    idle → vision_scan → navigate → approach → descend →
  //    closing → lift → transport → place_scan → place →
  //    release → retract → done
  // ══════════════════════════════════════════════════════════

  function buildListener(RobotListener, robot, options = {}) {

    const TARGET_BOX_ID = options.boxId ?? 1;
    const DROP_GOAL     = options.dropAt ?? { x: -1.2, z: 2.2 };
    const onDone        = options.onDone ?? (() => {});
    const logger        = options.logger ?? ((msg, cls) => console.log(`[VisionPP] ${msg}`));

    class VisionPickPlaceListener extends RobotListener {

      constructor(robot) {
        super(robot, logger);
        this.controlsDrive = true;
        this._phase   = 'idle';
        this._phaseAt = performance.now();
        this._finished = false;

        // Finger contact state
        this._contact = { left: false, right: false };
        this._contactLockUntil = 0;

        // Auto-grab/release cancel handles
        this._autoGrabCancel    = null;
        this._autoReleaseCancel = null;
        this._grabTime = 0;

        // Approach adaptation
        this._stallCount    = 0;
        this._distReduction = 0;
        this._shoulderBoost = 0;
        this._adaptCooldown = 0;
        this._floorHitBaseline = 0;
        this._floorCount = 0;

        // Vision scan state
        this._scanStartTime = 0;
        this._scanRotations = 0;
        this._lastVisionPos = null;
        this._visionConfirm = 0;

        // Navigation collision avoidance
        this._waypoints      = [];
        this._wpIndex        = 0;
        this._avoidCooldown  = 0;
        this._avoidAttempts  = 0;
        this._maxAvoidAttempts = 12;
        this._waitingForClear = false;
        this._waitStartTime  = 0;

        // Drop placement
        this._actualDrop = { ...DROP_GOAL };

        // Last known box coords
        this._lastBoxCoords = null;

        // Begin
        this._switchPhase('vision_scan');
        logger(`🚀 Vision Pick & Place → Box #${TARGET_BOX_ID} drop at (${DROP_GOAL.x}, ${DROP_GOAL.z})`);
      }

      get _ar() { return this.robot._robot3D; }
      get phase() { return this._phase; }

      _switchPhase(p) {
        if (this._phase === p) return;
        this._phase   = p;
        this._phaseAt = performance.now();
        logger(`▶ PHASE → ${p}`, 'info');
      }

      _elapsed() { return performance.now() - this._phaseAt; }

      // ══════════════════════════════════════
      //  EVENT: onObjectDetected (main tick)
      // ══════════════════════════════════════
      onObjectDetected(id, coords) {
        super.onObjectDetected?.(id, coords);
        if (id !== 'box') return;

        const ar = this._ar;
        if (!ar?.parts) return;

        if (this._finished || this._phase === 'done') {
          ar.setDrive(0, 0);
          return;
        }

        this._lastBoxCoords = coords;

        // ── Transport & place phases ──
        if (['lift', 'transport', 'place_scan', 'place', 'release', 'retract'].includes(this._phase)) {
          this._runTransport(ar, coords);
          return;
        }

        // ── Already grabbed ──
        if (this.grabbed) {
          this._switchPhase('lift');
          return;
        }

        // ── Closing phase - wait for autoGrab ──
        if (this._phase === 'closing') {
          ar.setDrive(0, 0);
          return;
        }

        // ── Vision scan phase ──
        if (this._phase === 'vision_scan') {
          this._runVisionScan(ar, coords);
          return;
        }

        // ── Navigate & Approach ──
        this._runApproach(ar, coords);
      }

      // ══════════════════════════════════════
      //  PHASE: Vision Scan
      //  Use camera to locate the target box
      // ══════════════════════════════════════
      _runVisionScan(ar, coords) {
        const mv = ar.description.movement;

        // Try vision first
        const visionPos = visionFindBox(TARGET_BOX_ID);

        if (visionPos) {
          // Vision found the box - confirm with multiple frames
          if (!this._lastVisionPos) {
            this._lastVisionPos = visionPos;
            this._visionConfirm = 1;
            logger(`👁️ Vision spotted Box #${TARGET_BOX_ID} at (${visionPos.x.toFixed(1)}, ${visionPos.z.toFixed(1)}) dist=${visionPos.distance.toFixed(1)}m`, 'info');
          } else {
            const drift = Math.hypot(
              visionPos.x - this._lastVisionPos.x,
              visionPos.z - this._lastVisionPos.z
            );
            if (drift < 0.5) {
              this._visionConfirm++;
            } else {
              this._lastVisionPos = visionPos;
              this._visionConfirm = 1;
            }
          }

          // After 3 stable frames, lock on
          if (this._visionConfirm >= 3) {
            ar.setDrive(0, 0);
            logger(`✅ Vision confirmed Box #${TARGET_BOX_ID} at (${visionPos.x.toFixed(1)}, ${visionPos.z.toFixed(1)})`, 'ok');
            this._switchPhase('navigate');
            return;
          }
        }

        // Slow rotation to scan environment
        if (!this._scanStartTime) this._scanStartTime = performance.now();
        const scanElapsed = performance.now() - this._scanStartTime;

        // Rotate slowly to scan
        ar.setDrive(0, mv.turn * 0.3);
        this._scanRotations = scanElapsed / 8000; // ~8s per rotation

        // After 2 full rotations without vision, fall back to onObjectDetected coords
        if (this._scanRotations > 2) {
          logger('⚠️ Vision scan timeout — using sensor data as fallback', 'warn');
          ar.setDrive(0, 0);
          this._switchPhase('navigate');
          return;
        }

        // Log progress
        if (Math.floor(scanElapsed / 2000) !== Math.floor((scanElapsed - 16) / 2000)) {
          logger(`🔍 Scanning... rotation ${this._scanRotations.toFixed(1)}/2`, 'info');
        }
      }

      // ══════════════════════════════════════
      //  Navigate & Approach toward box
      // ══════════════════════════════════════
      _runApproach(ar, coords) {
        if (this._phase === 'idle') this._switchPhase('navigate');

        // ── Vision-based collision avoidance during approach ──
        const obstacles = visionGetObstacles(TARGET_BOX_ID);
        const base = ar.parts.base.group.position;
        const now  = performance.now();

        if (this._phase === 'navigate' && now > this._avoidCooldown) {
          const blocker = findBlockingObstacle(
            base.x, base.z, coords.x, coords.z, obstacles, 2.0
          );
          if (blocker) {
            if (this._avoidAttempts >= this._maxAvoidAttempts) {
              if (!this._waitingForClear) {
                this._waitingForClear = true;
                this._waitStartTime = now;
                logger(`⏳ Path to box blocked by ${blocker.type} — waiting...`, 'warn');
              }
              ar.setDrive(0, 0);
              if (now - this._waitStartTime > 3000) {
                this._avoidAttempts = 0;
                this._waitingForClear = false;
                logger('🔄 Retry path to box', 'info');
              }
              return;
            }
            const detour = computeDetour(
              base.x, base.z, coords.x, coords.z,
              blocker.x, blocker.z, blocker.radius ?? 2.0
            );
            if (detour) {
              this._avoidAttempts++;
              this._avoidCooldown = now + 1200;
              logger(`🔀 DETOUR #${this._avoidAttempts} → (${detour.x.toFixed(1)}, ${detour.z.toFixed(1)}) to avoid ${blocker.type}`, 'info');
              // Drive toward detour briefly
              const dYaw = normalizeRad(Math.atan2(detour.x - base.x, detour.z - base.z) - (ar.baseState?.yaw ?? 0));
              const mv = ar.description.movement;
              ar.setDrive(
                Math.abs(dYaw) < 0.4 ? mv.speed * 0.5 : 0,
                Math.abs(dYaw) < 0.04 ? 0 : clamp(dYaw * 2.0, -mv.turn, mv.turn)
              );
              return;
            }
          } else {
            if (this._avoidAttempts > 0) {
              this._avoidAttempts = 0;
              this._waitingForClear = false;
              logger('✅ Path to box clear', 'ok');
            }
          }
        }

        // ── IK & Approach logic ──
        const target = localTarget(ar, coords);
        const mv = ar.description.movement;

        const ikOverrides = {
          minY:        -0.15 - (this._stallCount * 0.05),
          shoulderMin: Math.max(-10, 15 - this._stallCount * 3 + this._shoulderBoost),
        };

        const angles   = solveIK(ar, coords, target, ikOverrides);
        const yawErr   = normalizeRad(target.targetYaw - target.yaw);

        const basePrefDist = clamp(
          angles.maxReach + angles.approachOff - 0.3,
          2.6, angles.maxReach + angles.approachOff
        );
        const prefDist = Math.max(1.2, basePrefDist - this._distReduction);

        const fwdErr  = target.forward - prefDist;
        const aligned = Math.abs(yawErr) < 0.22;

        let speed = 0;
        if (aligned && fwdErr > 0.02) {
          const ratio = clamp(fwdErr / 0.25, 0.15, 1);
          speed = clamp(fwdErr * 0.55 * ratio, 0.015, mv.speed * 0.45);
        }
        let turn = Math.abs(yawErr) < 0.04
          ? 0 : clamp(yawErr * 1.8, -mv.turn, mv.turn);

        // Stop base when close enough in approach
        if (this._phase === 'approach' && fwdErr < 0.10) {
          speed = 0;
          turn  = 0;
        }

        ar.setDrive(speed, turn);

        const canDeploy =
          target.forward <= prefDist + 0.22 &&
          Math.abs(yawErr) <= 0.32 &&
          Math.abs(target.side) <= (coords.half ?? 0.25) + 0.22;

        if (!canDeploy) {
          if (this._phase === 'approach') return;
          // Retract arm while navigating
          this.robot.moveArm('shoulder', 0);
          this.robot.moveArm('elbow', 0);
          this.robot.moveArm('wrist', 0);
          openFingersFull(ar);  // ← Fingers fully open before approach
          ar.setSqueeze(0);
          this._switchPhase('navigate');
          return;
        }

        // ── Deploy arm ──
        if (this._phase !== 'approach') {
          this._floorHitBaseline = ar.diagnostics.floorCollisionCount;
        }
        this._switchPhase('approach');

        // Open fingers FULLY before descending
        openFingersFull(ar);

        // Deploy arm toward the box
        this.robot.moveArm('shoulder', angles.shoulder);
        this.robot.moveArm('elbow', angles.elbow);
        this.robot.moveArm('wrist', angles.wrist);

        // ── Stall / floor adaptation ──
        const approachTime = this._elapsed();
        const floorHits = ar.diagnostics.floorCollisionCount - this._floorHitBaseline;

        if (floorHits > 2 && now > this._adaptCooldown) {
          this._floorCount++;
          this._distReduction += 0.20;
          this._shoulderBoost += 8;
          this._adaptCooldown = now + 2000;
          this._floorHitBaseline = ar.diagnostics.floorCollisionCount;
          logger(`⚠️ Floor #${this._floorCount} → closer ${this._distReduction.toFixed(2)}m + shoulder +${this._shoulderBoost}°`, 'warn');
          ar.setDrive(clamp(0.25, 0.1, mv.speed * 0.35), 0);
          this._phaseAt = now;
          this.robot.moveArm('shoulder', angles.shoulder + 8);
          return;
        }

        if (approachTime > 2000 && now > this._adaptCooldown) {
          this._stallCount++;
          this._distReduction += 0.20;
          this._adaptCooldown = now + 2000;
          logger(`🔧 Stall #${this._stallCount} → closer ${this._distReduction.toFixed(2)}m`, 'warn');
          ar.setDrive(clamp(0.25, 0.1, mv.speed * 0.35), 0);
          this._phaseAt = now;
          return;
        }

        if (approachTime > 15000) {
          logger('⚠️ Approach hard timeout → reset', 'warn');
          this.robot.moveArm('shoulder', 0);
          this.robot.moveArm('elbow', 0);
          this.robot.moveArm('wrist', 0);
          ar.setDrive(-0.3, 0);
          this._distReduction = 0;
          this._stallCount = 0;
          this._floorCount = 0;
          this._shoulderBoost = 0;
          this._switchPhase('navigate');
          return;
        }

        // ── Contact → autoGrab ──
        const sensorContact = this._contact.left || this._contact.right;
        const geoContact    = isBoxInGrip(ar, coords);

        if (sensorContact || geoContact) {
          if (geoContact && !sensorContact) {
            logger('📐 Box detected geometrically between fingers', 'info');
          }
          this._distReduction = 0;
          this._stallCount = 0;
          this._floorCount = 0;
          this._shoulderBoost = 0;
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

        if (state === 'end') {
          if (['lift', 'transport', 'place', 'place_scan'].includes(this._phase)) {
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
          logger('✅ GRAB SUCCESS → lift', 'ok');
          this._switchPhase('lift');
        }
      }

      // ══════════════════════════════════════
      //  AutoGrab — close fingers via autoGrab.js
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
      //  Transport phases (lift → transport → place → release → retract)
      // ══════════════════════════════════════
      _runTransport(ar, coords) {
        ar.setSqueeze(1);

        // ── LIFT ──
        if (this._phase === 'lift') {
          ar.setDrive(0, 0);
          this.robot.moveArm('shoulder', 22);
          this.robot.moveArm('elbow', 20);
          this.robot.moveArm('wrist', 0);
          if (this._elapsed() >= 1800) {
            // Before transport, check drop zone with vision
            this._switchPhase('transport');
            // Reset nav state for transport
            this._avoidAttempts = 0;
            this._avoidCooldown = 0;
            this._waitingForClear = false;
          }
          return;
        }

        // ── TRANSPORT with vision collision avoidance ──
        if (this._phase === 'transport') {
          this.robot.moveArm('shoulder', 22);
          this.robot.moveArm('elbow', 20);
          this.robot.moveArm('wrist', 0);

          const base = ar.parts.base.group.position;
          const goal = this._actualDrop;
          const mv   = ar.description.movement;
          const now  = performance.now();

          // ── Vision-based collision avoidance ──
          const obstacles = visionGetObstacles(TARGET_BOX_ID);

          if (now > this._avoidCooldown) {
            const blocker = findBlockingObstacle(
              base.x, base.z, goal.x, goal.z, obstacles, 2.0
            );

            if (blocker) {
              if (this._avoidAttempts >= this._maxAvoidAttempts) {
                if (!this._waitingForClear) {
                  this._waitingForClear = true;
                  this._waitStartTime = now;
                  logger(`⏳ Transport blocked by ${blocker.type} — waiting...`, 'warn');
                }
                ar.setDrive(0, 0);
                if (now - this._waitStartTime > 3000) {
                  this._avoidAttempts = 0;
                  this._waitingForClear = false;
                  logger('🔄 Retry transport path', 'info');
                }
                return;
              }

              const detour = computeDetour(
                base.x, base.z, goal.x, goal.z,
                blocker.x, blocker.z, blocker.radius ?? 2.0
              );
              if (detour) {
                this._avoidAttempts++;
                this._avoidCooldown = now + 1200;
                logger(`🔀 Transport DETOUR #${this._avoidAttempts} around ${blocker.type} → (${detour.x.toFixed(1)}, ${detour.z.toFixed(1)})`, 'info');
                // Drive toward detour
                const dYaw = normalizeRad(Math.atan2(detour.x - base.x, detour.z - base.z) - (ar.baseState?.yaw ?? 0));
                ar.setDrive(
                  Math.abs(dYaw) < 0.4 ? mv.speed * 0.5 : 0,
                  Math.abs(dYaw) < 0.04 ? 0 : clamp(dYaw * 2.0, -mv.turn, mv.turn)
                );
                return;
              }
            } else if (this._avoidAttempts > 0) {
              this._avoidAttempts = 0;
              this._waitingForClear = false;
              logger('✅ Transport path clear', 'ok');
            }
          }

          // Drive to drop target
          if (driveBaseTo(ar, goal)) {
            this._switchPhase('place_scan');
          }
          return;
        }

        // ── PLACE_SCAN — check if drop zone is clear ──
        if (this._phase === 'place_scan') {
          ar.setDrive(0, 0);
          const obstacles = visionGetObstacles(TARGET_BOX_ID);
          const goal = this._actualDrop;

          if (isPositionBlocked(goal.x, goal.z, obstacles, 0.8)) {
            const clear = findClearSpot(goal.x, goal.z, obstacles, 0.8);
            if (clear.x !== goal.x || clear.z !== goal.z) {
              logger(`⚠️ Drop zone blocked → relocated to (${clear.x.toFixed(1)}, ${clear.z.toFixed(1)})`, 'warn');
              this._actualDrop = clear;
              // Need to drive to new spot
              this._switchPhase('transport');
              return;
            }
          }

          logger(`📍 Drop zone clear at (${goal.x.toFixed(1)}, ${goal.z.toFixed(1)})`, 'ok');

          // Short delay then place
          if (this._elapsed() >= 800) {
            this._switchPhase('place');
          }
          return;
        }

        // ── PLACE — lower box ──
        if (this._phase === 'place') {
          ar.setDrive(0, 0);
          this.robot.moveArm('shoulder', 62);
          this.robot.moveArm('elbow', 68);
          this.robot.moveArm('wrist', 0);
          if (this._elapsed() >= 1800) {
            this._startAutoRelease();
          }
          return;
        }

        // ── RELEASE ──
        if (this._phase === 'release') {
          ar.setDrive(0, 0);
          if (!this.grabbed && this._elapsed() >= 2000) {
            this._switchPhase('retract');
          }
          return;
        }

        // ── RETRACT ──
        if (this._phase === 'retract') {
          ar.setDrive(0, 0);
          ar.setSqueeze(0);
          this.robot.moveArm('shoulder', 0);
          this.robot.moveArm('elbow', 0);
          this.robot.moveArm('wrist', 0);
          if (this._elapsed() >= 1500) {
            this._finished = true;
            this._switchPhase('done');
            logger('✅ VISION MISSION COMPLETE', 'ok');
            onDone();
          }
          return;
        }

        ar.setDrive(0, 0);
      }

      // ══════════════════════════════════════
      //  AutoRelease — open fingers via autoRelease.js
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

        // Safety timeout
        setTimeout(() => {
          if (this._phase === 'release' && this.grabbed) {
            logger('⚠️ autoRelease timeout → force release', 'warn');
            this.robot.onGripRequest('end', {});
          }
        }, 8000);
      }

      // ══════════════════════════════════════
      //  Force Stop
      // ══════════════════════════════════════
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
        logger('🛑 Vision mission stopped');
      }
    }

    return VisionPickPlaceListener;
  }

  // ══════════════════════════════════════════════════════════
  //  System Initialization
  // ══════════════════════════════════════════════════════════

  function waitForRobot(timeoutMs = 10000) {
    const t0 = performance.now();
    return new Promise((resolve, reject) => {
      function tick() {
        if (window.robot?._robot3D && window.robot?.listener) {
          resolve(window.robot); return;
        }
        if (performance.now() - t0 > timeoutMs) {
          reject(new Error('[VisionPP] robot API not ready')); return;
        }
        requestAnimationFrame(tick);
      }
      tick();
    });
  }

  let _modules  = null;
  let _ready    = false;
  let _listener = null;

  async function initSDK() {
    if (_ready) return;
    _modules = await loadModules();
    _ready   = true;
  }

  initSDK().catch(e => console.error('[VisionPP] init error:', e));

  // ══════════════════════════════════════════════════════════
  //  Public API — Console Commands
  // ══════════════════════════════════════════════════════════

  /**
   * pickAndPlaceVision(idBox, dropTarget)
   *
   * Vision-guided pick & place:
   *  1. Camera scans for box by id
   *  2. Navigates with collision avoidance
   *  3. Opens fingers fully, descends, uses autoGrab
   *  4. Lifts & transports with vision collision avoidance
   *  5. Smart drop placement (avoids obstacles)
   *  6. Uses autoRelease to place box
   *
   * @param {number} idBox       - Box ID (1-20)
   * @param {object} dropTarget  - {x, z} drop coordinates
   */
  window.pickAndPlaceVision = async function (idBox = 1, dropTarget = { x: -1.2, z: 2.2 }) {
    await initSDK();
    const robot = await waitForRobot();
    const { RobotListener } = _modules;

    // Stop previous mission
    _listener?.forceStop();

    // Set target box in the system
    const boxId = typeof idBox === 'number' ? idBox : parseInt(idBox, 10);
    if (!isNaN(boxId) && typeof window.setTargetBox === 'function') {
      window.setTargetBox(boxId);
    }

    // Ensure vision is active
    const vision = window.__vision;
    if (vision && !vision.active) {
      vision.start();
      console.log('[VisionPP] 📷 Camera vision auto-started');
    }

    const Listener = buildListener(RobotListener, robot, {
      boxId:  boxId,
      dropAt: dropTarget,
      onDone: () => console.log('[VisionPP] 🎉 Mission complete!'),
      logger: window.log ?? ((msg) => console.log(`[VisionPP] ${msg}`)),
    });

    const fresh = new Listener(robot);
    robot.setListener(fresh);
    window._visionPPListener = fresh;
    _listener = fresh;

    console.log(`[VisionPP] ✅ Started → Box #${boxId} → drop at (${dropTarget.x}, ${dropTarget.z})`);
    console.log('[VisionPP] 📋 stopVisionMission() to abort | visionStatus() to check');

    return {
      status: () => _listener?.phase ?? 'idle',
      stop:   () => _listener?.forceStop(),
    };
  };

  /** Stop mission immediately */
  window.stopVisionMission = function () {
    if (_listener) {
      _listener.forceStop();
      _listener = null;
    }
    const ar = window.robot?._robot3D;
    if (ar) { ar.setDrive(0, 0); ar.setSqueeze(0); }
    console.log('[VisionPP] 🛑 Stopped');
  };

  /** Show current status */
  window.visionStatus = function () {
    const phase = _listener?.phase ?? 'idle';
    const ar = window.robot?._robot3D;
    const pos = ar?.parts?.base?.group?.position;
    const vision = window.__vision;
    const dets = vision?.getDetections()?.length ?? 0;
    if (pos) {
      console.log(
        `[VisionPP] Phase: ${phase} | ` +
        `Position: (${pos.x.toFixed(2)}, ${pos.z.toFixed(2)}) | ` +
        `Vision detections: ${dets}`
      );
    } else {
      console.log(`[VisionPP] Phase: ${phase} | Vision detections: ${dets}`);
    }
    return phase;
  };

  console.log('[VisionPP] ✅ Ready — type pickAndPlaceVision(boxId, {x, z}) in console');

})();
