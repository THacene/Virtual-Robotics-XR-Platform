// ============================================================
//  test.js — Event-Driven Pick & Place (v3.0)
//  ✅ تخطيط مسار A* على شبكة: مسار كامل حول كل العوائق،
//     إعادة تخطيط دورية للروبوتات المتحركة، متحكم قيادة مجرّب
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


  // ══════════════════════════════════════════════════════════
  //
  //    idle → navigate → approach → closing → lift → carry → place → release → retract → done
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

        // ── A* Path Planning State ───────────────
        this._path = null;
        this._pathIdx = 0;
        this._pathGoal = null;
        this._plannedAt = 0;
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
      //  جمع كل العوائق (روبوتات + صناديق)
      // ══════════════════════════════════════
      _collectObstacles(goal) {
        const out = [];
        const add = (id, x, z, radius) => {
          // العائق الملاصق للهدف = الهدف نفسه (الصندوق المستهدف / نقطة الإسقاط)
          if (Math.hypot(x - goal.x, z - goal.z) < 0.7) return;
          out.push({ id, x, z, radius });
        };

        if (window.__robots) {
          for (const r of window.__robots) {
            if (r === this._ar) continue;
            const p = r.parts.base.group.position;
            add(r.description.name || 'robot', p.x, p.z, 1.3);
          }
        }
        if (window.__boxes) {
          const targetId = window.targetBoxId;
          for (const b of window.__boxes) {
            if (String(b.id) === String(targetId) || b.body.position.y > 0.4) continue;
            add('box_' + b.id, b.body.position.x, b.body.position.z, 0.6);
          }
        }
        return out;
      }

      // ══════════════════════════════════════
      //  ✅ v3 — A* Grid Path Planner
      // ══════════════════════════════════════
      _planPath(ar, goal) {
        const CELL = 0.5, R = 14;                 // ساحة من -14 إلى +14 متر
        const N = Math.round((R * 2) / CELL);
        const blocked = new Uint8Array(N * N);
        const toCell = v => clamp(Math.round((v + R) / CELL), 0, N - 1);

        // حجب خلايا العوائق (منتفخة بنصف عرض الروبوت)
        const obstacles = this._collectObstacles(goal);
        for (const ob of obstacles) {
          const rad = ob.radius + 0.6;
          const ci = toCell(ob.x), cj = toCell(ob.z), cr = Math.ceil(rad / CELL);
          for (let i = ci - cr; i <= ci + cr; i++) {
            for (let j = cj - cr; j <= cj + cr; j++) {
              if (i < 0 || j < 0 || i >= N || j >= N) continue;
              if (Math.hypot(i * CELL - R - ob.x, j * CELL - R - ob.z) < rad) blocked[i * N + j] = 1;
            }
          }
        }

        const base = ar.parts.base.group.position;
        const si = toCell(base.x), sj = toCell(base.z);
        const gi = toCell(goal.x), gj = toCell(goal.z);

        // حرّر خلايا البداية والهدف (قد تقع داخل منطقة منتفخة)
        const free = (ci, cj, r) => {
          for (let i = ci - r; i <= ci + r; i++)
            for (let j = cj - r; j <= cj + r; j++)
              if (i >= 0 && j >= 0 && i < N && j < N) blocked[i * N + j] = 0;
        };
        free(si, sj, 1); free(gi, gj, 1);

        // ── A* بثمانية اتجاهات ──
        const open = [[0, si, sj]];
        const g = new Float32Array(N * N).fill(Infinity);
        const parent = new Int32Array(N * N).fill(-1);
        g[si * N + sj] = 0;
        let found = false;

        while (open.length) {
          let bi = 0;
          for (let k = 1; k < open.length; k++) if (open[k][0] < open[bi][0]) bi = k;
          const [, ci, cj] = open.splice(bi, 1)[0];
          if (ci === gi && cj === gj) { found = true; break; }
          for (let di = -1; di <= 1; di++) {
            for (let dj = -1; dj <= 1; dj++) {
              if (!di && !dj) continue;
              const ni = ci + di, nj = cj + dj;
              if (ni < 0 || nj < 0 || ni >= N || nj >= N || blocked[ni * N + nj]) continue;
              const cost = g[ci * N + cj] + Math.hypot(di, dj);
              if (cost < g[ni * N + nj]) {
                g[ni * N + nj] = cost;
                parent[ni * N + nj] = ci * N + cj;
                open.push([cost + Math.hypot(ni - gi, nj - gj), ni, nj]);
              }
            }
          }
        }
        if (!found) return null;

        // استرجاع المسار
        const cells = [];
        let cur = gi * N + gj;
        while (cur !== -1) { cells.push(cur); cur = parent[cur]; }
        cells.reverse();

        // تبسيط المسار بفحص خط الرؤية
        const los = (a, b) => {
          const ai = Math.floor(a / N), aj = a % N;
          const bi2 = Math.floor(b / N), bj = b % N;
          const steps = Math.max(Math.abs(bi2 - ai), Math.abs(bj - aj)) * 2;
          for (let s = 1; s < steps; s++) {
            const i = Math.round(ai + (bi2 - ai) * s / steps);
            const j = Math.round(aj + (bj - aj) * s / steps);
            // ✅ فحص الخلية + 8 جيران → الاختصار يحافظ على مسافة أمان من الزوايا
            for (let di = -1; di <= 1; di++) {
              for (let dj = -1; dj <= 1; dj++) {
                const ii = i + di, jj = j + dj;
                if (ii >= 0 && jj >= 0 && ii < N && jj < N && blocked[ii * N + jj]) return false;
              }
            }
          }
          return true;
        };


        const pts = [cells[0]];
        let a = 0;
        while (a < cells.length - 1) {
          let next = a + 1;
          for (let k = cells.length - 1; k > a; k--) {
            if (los(cells[a], cells[k])) { next = k; break; }
          }
          pts.push(cells[next]); a = next;
        }

        const path = pts.slice(1).map(c => ({ x: Math.floor(c / N) * CELL - R, z: (c % N) * CELL - R }));
        if (path.length) path[path.length - 1] = { x: goal.x, z: goal.z };
        else path.push({ x: goal.x, z: goal.z });
        return path;
      }

      // ══════════════════════════════════════
      //  ✅ v3 — تتبع المسار بمتحكم القيادة الأصلي المجرّب
      // ══════════════════════════════════════
      // ══════════════════════════════════════
      //  ✅ v3.1 — تتبع المسار: أسرع + استمرارية بلا توقف
      // ══════════════════════════════════════
      _driveWithDetour(ar, finalGoal, stopRadius = 0.18, speedMult = 1.0) {
        const base = ar.parts.base.group.position;
        const now = performance.now();

        const goalDist = Math.hypot(finalGoal.x - base.x, finalGoal.z - base.z);
        if (goalDist < stopRadius) { ar.setDrive(0, 0); this._path = null; return true; }

        // إعادة التخطيط: كل 2.5 ثانية أو عند تحرك الهدف   ✅ كان 1.5
        const goalMoved = !this._pathGoal ||
          Math.hypot(this._pathGoal.x - finalGoal.x, this._pathGoal.z - finalGoal.z) > 0.5;
        if (!this._path || goalMoved || now - this._plannedAt > 2500) {
          this._path = this._planPath(ar, finalGoal);
          this._pathGoal = { x: finalGoal.x, z: finalGoal.z };
          this._pathIdx = 0;
          this._plannedAt = now;
          if (!this._path) {
            ar.setDrive(0, 0);
            logger('⏳ No path available — waiting for clearance...', 'warn');
            return false;
          }
          // ✅ تخطَّ النقاط التي نحن عندها أصلاً → لا توقف وانطلاق بعد كل تخطيط
          while (this._pathIdx < this._path.length - 1 &&
            Math.hypot(this._path[this._pathIdx].x - base.x,
              this._path[this._pathIdx].z - base.z) < 0.6) {
            this._pathIdx++;
          }
        }

        // النقطة الحالية على المسار
        let wp = this._path[Math.min(this._pathIdx, this._path.length - 1)];
        const isLast = this._pathIdx >= this._path.length - 1;
        if (Math.hypot(wp.x - base.x, wp.z - base.z) < (isLast ? stopRadius : 0.45)) {
          if (!isLast) {
            this._pathIdx++;
            wp = this._path[this._pathIdx];
          } else {
            ar.setDrive(0, 0); this._path = null; return true;
          }
        }

        // ── قيادة أسرع ──   ✅ كان: عتبة 0.4 / ضرب 0.75 / حد 0.18-0.55 / دوران 1.7
        const targetYaw = Math.atan2(wp.x - base.x, wp.z - base.z);
        const yawErr = normalizeRad(targetYaw - (ar.baseState?.yaw ?? 0));
        const mv = ar.description.movement;

        let driveSpeed = 0;
        if (Math.abs(yawErr) < 0.5) {
          driveSpeed = clamp(Math.hypot(wp.x - base.x, wp.z - base.z) * 0.8,
            0.25, mv.speed * 0.75 * speedMult);
        }
        const turnSpeed = Math.abs(yawErr) < 0.04 ? 0 : clamp(yawErr * 2.2, -mv.turn, mv.turn);

        ar.setDrive(driveSpeed, turnSpeed);
        return false;
      }


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

        const basePrefDist = clamp(angles.maxReach + angles.approachOff - 0.3,
          1.0, angles.maxReach + angles.approachOff);
        const prefDist = Math.max(1.0, basePrefDist - this._distReduction);

        const yawErr = normalizeRad(target.targetYaw - target.yaw);

        // ── Navigate Phase (A* routing) ──
        if (this._phase === 'navigate') {
          this._driveWithDetour(ar, offsetCoords, prefDist + 0.1, 1.0);
        } else {
          ar.setDrive(0, 0);
        }

        const canDeploy =
          target.forward <= prefDist + 0.35 &&
          Math.abs(yawErr) <= 0.32 &&
          Math.abs(target.side) <= (coords.half ?? 0.25) + 0.22;

        if (!canDeploy) {
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
        // ══════════════════════════════════════════
        const now = performance.now();
        const approachTime = this._elapsed();
        const floorHits = ar.diagnostics.floorCollisionCount - this._floorHitBaseline;

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

          if (this._driveWithDetour(ar, dropOffsetCoords, 0.18, 1.0)) {
            this._switchPhase('place');
          }
          return;
        }

        if (this._phase === 'place') {
          ar.setDrive(0, 0);

          const desc = ar.description;
          const boxHalf = desc.box?.half ?? 0.25;

          const placeCoords = { x: DROP_GOAL.x, y: boxHalf, z: DROP_GOAL.z };
          const target = localTargetFrom(ar, placeCoords);

          const angles = solveArmAngles(ar, placeCoords, target, { minY: -0.15, shoulderMin: -90 });

          this.robot.moveArm('shoulder', angles.shoulder);
          this.robot.moveArm('elbow', angles.elbow);
          this.robot.moveArm('wrist', 0);

          // ── DYNAMIC DESCENT DETECTION ──
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

          if ((this._elapsed() > 2500 && this._palmStableCount > 60) || this._elapsed() > 20000) {
            this._lastPalmY = null;
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

        const marginX = 0.2;
        const marginY = 0.2;
        const marginZ = 0.2;

        const limX = (innerX + boxHalf + marginX) * scale;
        const limY = (fh / 2 + boxHalf + marginY) * scale;
        const limZ = (fd / 2 + boxHalf + marginZ) * scale;

        const inGrip = Math.abs(lx) < limX && Math.abs(ly) < limY && Math.abs(lz) < limZ;

        if (!inGrip && Math.hypot(lx, ly, lz) < 1.5) {
          this._lastGeoLog = this._lastGeoLog || 0;
          if (performance.now() - this._lastGeoLog > 1500) {
            console.log(`[GeoDebug] lx:${lx.toFixed(2)}/${limX.toFixed(2)} ly:${ly.toFixed(2)}/${limY.toFixed(2)} lz:${lz.toFixed(2)}/${limZ.toFixed(2)}`);
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

  window.pickAndPlaceZone = async function (idbox = 1, zoneName = 'A') {
    const ZONES = {
      'A': { x: -5, z: 5 },
      'B': { x: 5, z: 5 },
      'C': { x: -5, z: -5 },
      'D': { x: 5, z: -5 }
    };
    
    const baseTarget = ZONES[zoneName] || ZONES['A'];
    let targetX = baseTarget.x;
    let targetZ = baseTarget.z;

    // Dynamic Drop Location: Check if the spot is blocked by other boxes
    if (window.__boxes) {
      let isBlocked = true;
      let attempt = 0;
      while (isBlocked && attempt < 20) { // Safety limit
        isBlocked = false;
        for (const b of window.__boxes) {
          if (b.id === idbox) continue; // ignore the box we are currently moving
          // If another box is within 0.55m of our target, it's blocked!
          const d = Math.hypot(b.body.position.x - targetX, b.body.position.z - targetZ);
          if (d < 0.55) {
            isBlocked = true;
            targetX += 0.6; // Shift target to the right and try again
            break;
          }
        }
        attempt++;
      }
    }

    const finalTarget = { x: targetX, z: targetZ };
    console.log(`[PickPlaceZone] 🗺️ Mapping Zone ${zoneName} to coordinates (${finalTarget.x.toFixed(2)}, ${finalTarget.z.toFixed(2)})`);
    return await window.pickAndPlace(idbox, finalTarget);
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
