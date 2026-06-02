// ============================================================
//  test2.js — Navigation with Collision Avoidance
//  ملف مستقل — لا يُعدِّل أي ملف قائم (يستعمل فقط API)
//
//  يستخدم onRobotDetected من Environment.js لمعرفة مواقع
//  الروبوتات الأخرى. إذا وجد روبوت في المسار → يُغيّر الطريق.
//
//  الاستخدام في Console:
//    moveTo(5, 3)               → يحرّك الروبوت إلى (x=5, z=3)
//    moveTo(-2, 4)              → إحداثيات أخرى
//    stopMove()                 → إيقاف فوري
//    moveStatus()               → الحالة الحالية + الموقع
// ============================================================

(function () {

  // ── استيراد RobotListener ──────────────────────────────
  async function loadModules() {
    const { RobotListener } = await import('/src/core/RobotListener.js');
    return { RobotListener };
  }

  // ══════════════════════════════════════════════════════════
  //  دوال هندسية مساعدة
  // ══════════════════════════════════════════════════════════

  const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, v));
  const normalizeRad = a => Math.atan2(Math.sin(a), Math.cos(a));

  /**
   * مسافة نقطة P من مقطع AB (في المستوي XZ)
   */
  function pointToSegmentDist(px, pz, ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz;
    if (len2 < 0.001) return Math.hypot(px - ax, pz - az);
    let t = ((px - ax) * dx + (pz - az) * dz) / len2;
    t = Math.max(0, Math.min(1, t));
    const projX = ax + t * dx, projZ = az + t * dz;
    return Math.hypot(px - projX, pz - projZ);
  }

  /**
   * يحسب نقطة التفاف حول عائق (ox,oz)
   * يختار الجانب الأقصر من الجانبين المتعامدين على المسار
   */
  function computeDetour(cx, cz, gx, gz, ox, oz, avoidRadius) {
    const dx = gx - cx, dz = gz - cz;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) return null;

    // اتجاه عمودي على المسار
    const perpX = -dz / len, perpZ = dx / len;

    const offset = avoidRadius + 1.5;    // هامش أمان
    const w1 = { x: ox + perpX * offset, z: oz + perpZ * offset };
    const w2 = { x: ox - perpX * offset, z: oz - perpZ * offset };

    // نختار النقطة التي تكون أقصر مجموع مسافات (ذهاب + إياب)
    const cost1 = Math.hypot(w1.x - cx, w1.z - cz) + Math.hypot(w1.x - gx, w1.z - gz);
    const cost2 = Math.hypot(w2.x - cx, w2.z - cz) + Math.hypot(w2.x - gx, w2.z - gz);

    return cost1 <= cost2 ? w1 : w2;
  }

  // ══════════════════════════════════════════════════════════
  //  NavListener — آلة الحالات للتنقل مع تجنب التصادم
  //
  //  المراحل:
  //    idle → moving → avoiding → arrived | stopped
  //
  //  الأحداث:
  //    onObjectDetected  ← tick كل frame (نستعمله كمحرك)
  //    onRobotDetected   ← مواقع الروبوتات الأخرى من Environment
  // ══════════════════════════════════════════════════════════

  function buildNavListener(RobotListener, robot, options = {}) {

    const GOAL = { x: options.goalX ?? 0, z: options.goalZ ?? 0 };
    const onDone = options.onDone ?? (() => { });
    const logger = options.logger ?? ((msg) => console.log(`[NavBot] ${msg}`));
    const STOP_RADIUS = 0.35;
    const CORRIDOR_WIDTH = 2.0;      // عرض الممر الآمن (قطر)
    const AVOID_RADIUS = 2.5;        // نصف قطر الالتفاف

    // ────────────────────────────────────────────
    class NavListener extends RobotListener {

      constructor(robot) {
        super(robot, logger);
        this.controlsDrive = true;      // يمنع لوحة المفاتيح
        this._phase = 'idle';
        this._phaseAt = performance.now();
        this._finished = false;

        // مواقع الروبوتات الأخرى (يُحدَّث كل frame)
        this._otherRobots = new Map();

        // نقاط الطريق: [waypoint1, waypoint2, ..., GOAL]
        this._waypoints = [{ ...GOAL }];
        this._wpIndex = 0;

        // حالة التجنب
        this._avoidCooldown = 0;          // مؤقت تبريد بعد كل detour
        this._avoidAttempts = 0;          // عدد محاولات الالتفاف
        this._maxAvoidAttempts = 12;      // أقصى عدد قبل الانتظار
        this._waitingForClear = false;    // هل ننتظر خلو المسار؟
        this._waitStartTime = 0;

        // بدء التنقل
        this._switchPhase('moving');
        logger(`🚀 Navigating → (${GOAL.x}, ${GOAL.z})`);
      }

      // ── وصول آمن للـ Robot3D ────────────────
      get _ar() { return this.robot._robot3D; }

      // ── إدارة الـ Phase ──────────────────────
      get phase() { return this._phase; }

      _switchPhase(p) {
        if (this._phase === p) return;
        this._phase = p;
        this._phaseAt = performance.now();
        logger(`▶ PHASE → ${p}`);
      }

      _elapsed() { return performance.now() - this._phaseAt; }

      // ══════════════════════════════════════
      //  COMPUTER VISION: convertit les
      //  détections caméra en obstacles virtuels
      // ══════════════════════════════════════
      _updateVisionObstacles() {
        const ar = this._ar;
        if (!ar?.parts) return;
        const v = window.__vision;
        if (!v) return;
        const now = performance.now();

        // Clean up old vision obstacles
        for (const [key, data] of this._otherRobots) {
          if (data._vision && now - data.lastSeen > 1000) {
            this._otherRobots.delete(key);
          }
        }

        if (!v.active) return;
        const detections = v.getDetections();
        for (let i = 0; i < detections.length; i++) {
          const d = detections[i];
          if (d.name !== 'robot') continue;
          const pos3d = v.estimate3DPosition(d);
          const key = `vision_robot_${i}`;
          this._otherRobots.set(key, {
            x: pos3d.x, z: pos3d.z,
            yaw: 0, speed: 0,
            lastSeen: now,
            _vision: true,
          });
        }
      }

      // ══════════════════════════════════════
      //  EVENT: onRobotDetected
      //  يُطلَق كل frame من Environment.js
      //  يحفظ مواقع الروبوتات الأخرى
      // ══════════════════════════════════════
      onRobotDetected(id, coords) {
        this._otherRobots.set(id, {
          x: coords.x,
          z: coords.z,
          yaw: coords.yaw,
          speed: coords.speed,
          lastSeen: performance.now()
        });
      }

      // ══════════════════════════════════════
      //  EVENT: onObjectDetected (tick)
      //  نستعمل هذا كـ "tick" لأنه يُطلَق كل frame
      // ══════════════════════════════════════
      onObjectDetected(id, coords) {
        const ar = this._ar;
        if (!ar?.parts) return;

        if (this._finished || this._phase === 'arrived' || this._phase === 'stopped') {
          ar.setDrive(0, 0);
          return;
        }

        this._updateVisionObstacles();
        this._navigate(ar);
      }

      // ══════════════════════════════════════
      //  المنطق الرئيسي: التنقل + تجنب التصادم
      // ══════════════════════════════════════
      _navigate(ar) {
        const base = ar.parts.base.group.position;
        const wp = this._waypoints[this._wpIndex] ?? GOAL;

        const dx = wp.x - base.x, dz = wp.z - base.z;
        const dist = Math.hypot(dx, dz);

        // ── وصلنا إلى النقطة الحالية ──
        if (dist < STOP_RADIUS) {
          if (this._wpIndex < this._waypoints.length - 1) {
            this._wpIndex++;
            logger(`📍 Waypoint ${this._wpIndex}/${this._waypoints.length} reached → next`);
            return;
          }
          // وصلنا إلى الهدف النهائي
          ar.setDrive(0, 0);
          this._finished = true;
          this._switchPhase('arrived');
          logger(`🏁 ARRIVED at (${GOAL.x.toFixed(1)}, ${GOAL.z.toFixed(1)})`);
          onDone();
          return;
        }

        // ══════════════════════════════════════
        //  فحص التصادم مع روبوتات أخرى
        // ══════════════════════════════════════
        const now = performance.now();

        if (now > this._avoidCooldown) {
          const blocker = this._findBlockingRobot(
            base.x, base.z, wp.x, wp.z
          );

          if (blocker) {
            // ── روبوت يسد الطريق ──

            // حد أقصى للمحاولات → انتظر حتى يتحرك
            if (this._avoidAttempts >= this._maxAvoidAttempts) {
              if (!this._waitingForClear) {
                this._waitingForClear = true;
                this._waitStartTime = now;
                logger(`⏳ Path blocked by ${blocker.id} — waiting for clear...`);
              }
              ar.setDrive(0, 0);
              this._switchPhase('waiting');

              // كل 3 ثوانٍ حاول مجدداً
              if (now - this._waitStartTime > 3000) {
                this._avoidAttempts = 0;
                this._waitingForClear = false;
                this._waypoints = [{ ...GOAL }];
                this._wpIndex = 0;
                this._switchPhase('moving');
                logger(`🔄 Retry — recalculating path`);
              }
              return;
            }

            // حساب نقطة التفاف
            const detour = computeDetour(
              base.x, base.z, GOAL.x, GOAL.z,
              blocker.x, blocker.z, AVOID_RADIUS
            );

            if (detour) {
              this._avoidAttempts++;
              this._waypoints = [detour, { ...GOAL }];
              this._wpIndex = 0;
              this._avoidCooldown = now + 1200;  // تبريد 1.2 ثانية
              this._switchPhase('avoiding');

              logger(
                `🔀 DETOUR #${this._avoidAttempts} → ` +
                `(${detour.x.toFixed(1)}, ${detour.z.toFixed(1)}) ` +
                `to avoid ${blocker.id} at (${blocker.x.toFixed(1)}, ${blocker.z.toFixed(1)})`
              );

              // توقف قصير ثم أكمل
              ar.setDrive(0, 0);
              return;
            }
          } else {
            // ── المسار واضح ──
            if (this._phase === 'avoiding' || this._phase === 'waiting') {
              // المسار أصبح حراً → أعد حساب المسار المباشر
              this._waypoints = [{ ...GOAL }];
              this._wpIndex = 0;
              this._avoidAttempts = 0;
              this._waitingForClear = false;
              this._switchPhase('moving');
              logger(`✅ Path clear → direct route`);
            }
          }
        }

        // ══════════════════════════════════════
        //  قيادة القاعدة نحو نقطة الطريق الحالية
        // ══════════════════════════════════════
        const yaw = ar.baseState?.yaw ?? 0;
        const targetYaw = Math.atan2(dx, dz);
        const yawErr = normalizeRad(targetYaw - yaw);
        const mv = ar.description.movement;

        // سرعة: فقط إذا الاتجاه صحيح
        let speed = 0;
        if (Math.abs(yawErr) < 0.40) {
          speed = clamp(dist * 0.55, 0.08, mv.speed * 0.65);
        }

        // دوران: تصحيح الاتجاه
        const turn = Math.abs(yawErr) < 0.04
          ? 0 : clamp(yawErr * 2.0, -mv.turn, mv.turn);

        ar.setDrive(speed, turn);

        // ── سجل الحالة كل ~2 ثانية ──
        const elMs = this._elapsed();
        if (elMs > 0 && Math.floor(elMs / 2000) !== Math.floor((elMs - 16) / 2000)) {
          const others = this._otherRobots.size;
          logger(
            `📡 dist=${dist.toFixed(1)}m | ` +
            `phase=${this._phase} | ` +
            `wp=${this._wpIndex + 1}/${this._waypoints.length} | ` +
            `robots nearby=${others}`
          );
        }
      }

      // ══════════════════════════════════════
      //  البحث عن روبوت يسد الطريق
      //  يفحص كل الروبوتات المعروفة:
      //    - هل هي قريبة من خط المسار (ضمن CORRIDOR_WIDTH)؟
      //    - هل هي بيننا وبين الهدف (ليست خلفنا)؟
      // ══════════════════════════════════════
      _findBlockingRobot(cx, cz, gx, gz) {
        const now = performance.now();
        const pathLen = Math.hypot(gx - cx, gz - cz);
        if (pathLen < 0.5) return null;     // قريب جداً، لا حاجة للفحص

        let closest = null;
        let closestDist = Infinity;

        for (const [id, data] of this._otherRobots) {
          // تجاهل البيانات القديمة (> 300ms)
          if (now - data.lastSeen > 300) continue;

          // مسافة النقطة من خط المسار
          const d = pointToSegmentDist(data.x, data.z, cx, cz, gx, gz);
          if (d >= CORRIDOR_WIDTH) continue;

          // تأكد أنه بيننا وبين الهدف (وليس خلفنا)
          const toRobot = Math.hypot(data.x - cx, data.z - cz);
          const robotToGoal = Math.hypot(data.x - gx, data.z - gz);

          // الروبوت يجب أن يكون:
          //   - أقرب إلينا من طول المسار + هامش
          //   - أقرب إلى الهدف من طول المسار + هامش (أي ليس خلفنا بعيداً)
          if (toRobot < pathLen + 1.0 && robotToGoal < pathLen + 1.0) {
            if (d < closestDist) {
              closestDist = d;
              closest = { id, x: data.x, z: data.z };
            }
          }
        }

        return closest;
      }

      // ── إيقاف من الخارج ─────────────────
      forceStop() {
        this._finished = true;
        this._switchPhase('stopped');
        this._ar?.setDrive(0, 0);
        this.controlsDrive = false;
        logger('🛑 Navigation stopped');
      }
    }
    // ────────────────────────────────────────────

    return NavListener;
  }

  // ══════════════════════════════════════════════════════════
  //  انتظار جهوزية الروبوت
  // ══════════════════════════════════════════════════════════

  function waitForRobot(timeoutMs = 10000) {
    const t0 = performance.now();
    return new Promise((resolve, reject) => {
      function tick() {
        if (window.robot?._robot3D && window.robot?.listener) {
          resolve(window.robot); return;
        }
        if (performance.now() - t0 > timeoutMs) {
          reject(new Error('[NavBot] robot API not ready')); return;
        }
        requestAnimationFrame(tick);
      }
      tick();
    });
  }

  // ══════════════════════════════════════════════════════════
  //  حالة الوحدة
  // ══════════════════════════════════════════════════════════

  let _modules = null;
  let _ready = false;
  let _listener = null;

  async function initSDK() {
    if (_ready) return;
    _modules = await loadModules();
    _ready = true;
  }

  initSDK().catch(e => console.error('[NavBot] init error:', e));

  // ══════════════════════════════════════════════════════════
  //  Public API — تُستدعى من Console
  // ══════════════════════════════════════════════════════════

  /**
   * moveTo(x, z)
   * يحرّك الروبوت النشط إلى الإحداثيات المعطاة
   * مع تجنب تلقائي للتصادم مع الروبوتات الأخرى
   *
   * @param {number} x - إحداثية X
   * @param {number} z - إحداثية Z
   */
  window.moveTo = async function (x, z) {
    if (typeof x !== 'number' || typeof z !== 'number') {
      console.error('[NavBot] ❌ Usage: moveTo(x, z)  — example: moveTo(5, 3)');
      return;
    }

    await initSDK();
    const robot = await waitForRobot();
    const { RobotListener } = _modules;

    // أوقف المهمة السابقة
    _listener?.forceStop();

    const NavListener = buildNavListener(RobotListener, robot, {
      goalX: x,
      goalZ: z,
      onDone: () => console.log('[NavBot] 🎉 Arrived!'),
      logger: window.log ?? ((msg) => console.log(`[NavBot] ${msg}`)),
    });

    const fresh = new NavListener(robot);
    robot.setListener(fresh);
    _listener = fresh;

    const pos = robot._robot3D.parts.base.group.position;
    console.log(`[NavBot] ✅ Moving: (${pos.x.toFixed(1)}, ${pos.z.toFixed(1)}) → (${x}, ${z})`);
    console.log('[NavBot] 📋 stopMove() to abort | moveStatus() to check');

    return {
      status: () => _listener?.phase ?? 'idle',
      stop: () => _listener?.forceStop(),
    };
  };

  /** إيقاف التنقل فوراً */
  window.stopMove = function () {
    if (_listener) {
      _listener.forceStop();
      _listener = null;
    }
    const ar = window.robot?._robot3D;
    if (ar) ar.setDrive(0, 0);
    console.log('[NavBot] 🛑 Stopped');
  };

  /** عرض الحالة الحالية */
  window.moveStatus = function () {
    const phase = _listener?.phase ?? 'idle';
    const ar = window.robot?._robot3D;
    const pos = ar?.parts?.base?.group?.position;
    if (pos) {
      console.log(
        `[NavBot] Phase: ${phase} | ` +
        `Position: (${pos.x.toFixed(2)}, ${pos.z.toFixed(2)})`
      );
    } else {
      console.log(`[NavBot] Phase: ${phase}`);
    }
    return phase;
  };

  console.log('[NavBot] ✅ Ready — type moveTo(x, z) in console');

})();
