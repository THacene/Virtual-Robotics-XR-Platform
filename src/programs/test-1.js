// ============================================================
//  test.js — Event-Driven Pick & Place (v2.0)
//  ملف مستقل — لا يُعدِّل أي ملف قائم
//  يستخدم autoGrab.js و autoRelease.js
//
//  الاستخدام في Console:
//    pickAndPlace()                          → إعدادات افتراضية
//    pickAndPlace({ x: -1.2, z: 2.2 })      → تحديد نقطة الإفلات
//    stopMission()                           → إيقاف فوري
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
  const radToDeg = r => r * 180 / Math.PI;
  const normalizeRad = a => Math.atan2(Math.sin(a), Math.cos(a));

  /**
   * يحسب الهدف المحلي بالنسبة لقاعدة الروبوت
   */
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

  /**
   * حل عكسي مبسّط للذراع → { shoulder, elbow, wrist, maxReach, approachOff }
   */
  function solveArmAngles(ar, coords, target) {
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

    // ✅ حماية من تصادم الأرض
    // minY: الهدف لا ينزل أكثر من 0.15 تحت محور الكتف
    const minY = -0.15;
    if (y < minY) y = minY;

    let reach = Math.hypot(z, y);

    if (reach > maxReach) { const s = maxReach / reach; z *= s; y *= s; reach = maxReach; }
    else if (reach < minReach) { const s = minReach / Math.max(reach, 0.001); z *= s; y *= s; }

    const cosQ2 = clamp((reach * reach - l1 * l1 - l2 * l2) / (2 * l1 * l2), -1, 1);
    const bend = Math.acos(cosQ2);
    const limits = desc.joints?.limits ?? {};

    // ✅ score يعاقب الحلول التي تنزل الذراع كثيراً
    const score = s => {
      let penalty = 0;
      // عقوبة خروج من حدود المفاصل
      penalty += Math.max(0, (limits.shoulder?.min ?? -Infinity) - s.shoulder,
        s.shoulder - (limits.shoulder?.max ?? Infinity)) * 1000;
      penalty += Math.max(0, (limits.elbow?.min ?? -Infinity) - s.elbow,
        s.elbow - (limits.elbow?.max ?? Infinity)) * 1000;
      // تفضيل elbow حوالي 55°
      penalty += Math.abs(s.elbow - 55);
      // ✅ عقوبة كبيرة إذا shoulder منخفض (ذراع للأسفل = floor collision)
      if (s.shoulder < 15) penalty += (15 - s.shoulder) * 100;
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

    // ✅ shoulder لا ينزل تحت 15° لتجنب floor collision
    return {
      shoulder: jl('shoulder', Math.max(15, best.shoulder)),
      elbow: jl('elbow', best.elbow),
      wrist: jl('wrist', -radToDeg(Math.atan2(target.side, Math.max(target.forward, 0.001))) * 0.5),
      maxReach,
      approachOff,
    };
  }

  /**
   * يقود القاعدة نحو هدف — يُرجع true عند الوصول
   */
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
  //  PickPlaceListener — آلة الحالات (State Machine)
  //
  //  المراحل:
  //    idle → navigate → approach → closing → lift → carry → place → release → retract → done
  //
  //  الأحداث (Events):
  //    onObjectDetected  ← من Environment.js كل frame
  //    onFingerTouch     ← من FingerSensor.js عند التماس
  //    onGripRequest     ← من smartGripUpdate عند تأكيد القبض/الإفلات
  //
  //  التكامل:
  //    autoGrab()    ← لغلق الأصابع تدريجياً
  //    autoRelease() ← لفتح الأصابع تدريجياً
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
        this.controlsDrive = true;      // يمنع لوحة المفاتيح من التدخل
        this._phase = 'idle';
        this._phaseAt = performance.now();
        this._finished = false;

        // تتبع تماس الأصابع
        this._contact = { left: false, right: false };
        this._contactLockUntil = 0;

        // مراجع autoGrab / autoRelease
        this._autoGrabCancel = null;
        this._autoReleaseCancel = null;
        this._grabTime = 0;  // وقت آخر grab ناجح
      }

      // ── وصول آمن للـ Robot3D ────────────────
      get _ar() { return this.robot._robot3D; }

      // ── إدارة الـ Phase ──────────────────────
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
      //  يُطلَق كل frame من Environment.js
      // ══════════════════════════════════════
      onObjectDetected(id, coords) {
        super.onObjectDetected?.(id, coords);
        if (id !== TARGET_ID) return;

        const ar = this._ar;
        if (!ar?.parts) return;

        // تجاهل إذا انتهت المهمة
        if (this._finished || this._phase === 'done') {
          ar.setDrive(0, 0);
          return;
        }

        // مرحلة النقل
        if (['lift', 'carry', 'place', 'release', 'retract'].includes(this._phase)) {
          this._runTransport(ar);
          return;
        }

        // إذا ممسوك → انتقل للرفع
        if (this.grabbed) {
          this._switchPhase('lift');
          return;
        }

        // autoGrab يعمل → انتظر
        if (this._phase === 'closing') {
          ar.setDrive(0, 0);
          return;
        }

        // ── NAVIGATE / APPROACH ──────────────
        if (this._phase === 'idle') this._switchPhase('navigate');

        const target = localTargetFrom(ar, coords);
        const angles = solveArmAngles(ar, coords, target);
        const yawErr = normalizeRad(target.targetYaw - target.yaw);
        const mv = ar.description.movement;
        const prefDist = clamp(angles.maxReach + angles.approachOff - 0.3,
          2.6, angles.maxReach + angles.approachOff);
        const fwdErr = target.forward - prefDist;
        const aligned = Math.abs(yawErr) < 0.22;

        // قيادة القاعدة
        let speed = 0;
        if (aligned && fwdErr > 0.02) {
          const ratio = clamp(fwdErr / 0.25, 0.15, 1);
          speed = clamp(fwdErr * 0.55 * ratio, 0.015, mv.speed * 0.45);
        }
        const turn = Math.abs(yawErr) < 0.04
          ? 0 : clamp(yawErr * 1.8, -mv.turn, mv.turn);

        ar.setDrive(speed, turn);

        // فتح الأصابع والذراع عند الاقتراب
        const canDeploy =
          target.forward <= prefDist + 0.22 &&
          Math.abs(yawErr) <= 0.32 &&
          Math.abs(target.side) <= (coords.half ?? 0.25) + 0.22;

        if (!canDeploy) {
          // وضع محايد أثناء التنقل
          this.robot.moveArm('shoulder', 0);
          this.robot.moveArm('elbow', 0);
          this.robot.moveArm('wrist', 0);
          this._openFingers(ar, coords);
          ar.setSqueeze(0);
          this._switchPhase('navigate');
          return;
        }

        // نشر الذراع
        this._switchPhase('approach');
        this.robot.moveArm('shoulder', angles.shoulder);
        this.robot.moveArm('elbow', angles.elbow);
        this.robot.moveArm('wrist', angles.wrist);
        this._openFingers(ar, coords);

        // ✅ استرداد: إذا تعلقنا في approach أكثر من 4 ثوانٍ (floor limit)
        //    نرجع للخلف ونعيد المحاولة
        if (this._phase === 'approach' && this._elapsed() > 4000) {
          logger('⚠️ Approach stuck (floor limit?) → backing up', 'warn');
          this.robot.moveArm('shoulder', 0);
          this.robot.moveArm('elbow', 0);
          this.robot.moveArm('wrist', 0);
          ar.setDrive(-0.3, 0);  // ارجع للخلف قليلاً
          this._switchPhase('navigate');
          return;
        }

        // إذا الإصبع لمست → ابدأ autoGrab
        if (this._contact.left || this._contact.right) {
          this._startAutoGrab();
        }
      }

      // ══════════════════════════════════════
      //  EVENT: onFingerTouch
      //  يُطلَق من FingerSensor تلقائياً
      // ══════════════════════════════════════
      onFingerTouch(name, state, force, pointName) {
        if (name !== 'left' && name !== 'right') return;

        // إذا انتهت المهمة → تجاهل
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

          // ابدأ autoGrab إذا في مرحلة approach
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
      //  يُطلَق من smartGripUpdate في main.js
      // ══════════════════════════════════════
      onGripRequest(state, data) {
        // إذا انتهت المهمة → أوقف
        if (state === 'start' && (this._finished || ['place', 'release', 'retract', 'done'].includes(this._phase))) {
          this._ar?.setDrive(0, 0);
          this._ar?.setSqueeze(0);
          return;
        }

        // ══════════════════════════════════════
        //  حماية مراحل النقل من إشارات 'end' الخاطئة
        //  smartGripUpdate يرسل 'end' عندما الـ sensors تفقد التماس
        //  أثناء الرفع، لكن الصندوق مربوط فعلياً عبر applyGripOffset
        // ══════════════════════════════════════
        if (state === 'end') {
          // ✅ أثناء النقل → تجاهل تماماً (الصندوق مربوط)
          if (['lift', 'carry', 'place'].includes(this._phase)) {
            logger('🛡️ BLOCKED false release during ' + this._phase, 'warn');
            return;  // لا نفعل شيئاً — الصندوق آمن
          }

          // ✅ فترة سماح بعد الـ grab (2 ثانية)
          if (this._grabTime && (performance.now() - this._grabTime < 2000)) {
            logger('🛡️ BLOCKED release during grace period', 'warn');
            return;
          }

          // إذا في مرحلة release → نعالج الإفلات فعلاً
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

          // حالات أخرى → تجاهل
          logger('🛡️ BLOCKED unexpected release in phase: ' + this._phase, 'warn');
          return;
        }

        // ✅ state === 'start' → دع الكلاس الأساسي يقوم بالـ grab الفعلي
        super.onGripRequest(state, data);

        if (state === 'start' && this.grabbed) {
          // ألغِ autoGrab إذا لا يزال يعمل
          this._autoGrabCancel?.();
          this._autoGrabCancel = null;
          this._grabTime = performance.now();  // ✅ تسجيل وقت الـ grab
          this._switchPhase('lift');
          logger('✅ GRAB SUCCESS → lift', 'ok');
        }
      }

      // ══════════════════════════════════════
      //  autoGrab — يستدعي window.autoGrab()
      //  غلق الأصابع تدريجياً حتى يظهر GRAB الأخضر
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
      //  النقل: lift → carry → place → release → retract → done
      // ══════════════════════════════════════
      _runTransport(ar) {
        ar.setSqueeze(1);

        // ── LIFT: ارفع الذراع ──
        if (this._phase === 'lift') {
          ar.setDrive(0, 0);
          this.robot.moveArm('shoulder', 22);
          this.robot.moveArm('elbow', 20);
          this.robot.moveArm('wrist', 0);
          if (this._elapsed() >= 1800) this._switchPhase('carry');
          return;
        }

        // ── CARRY: قُد إلى نقطة الإفلات ──
        if (this._phase === 'carry') {
          this.robot.moveArm('shoulder', 22);
          this.robot.moveArm('elbow', 20);
          this.robot.moveArm('wrist', 0);
          if (driveBaseTo(ar, DROP_GOAL)) this._switchPhase('place');
          return;
        }

        // ── PLACE: أنزل الذراع ──
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

        // ── RELEASE: autoRelease يعمل ──
        if (this._phase === 'release') {
          ar.setDrive(0, 0);
          // ننتظر onGripRequest('end') أو timeout
          if (!this.grabbed && this._elapsed() >= 2000) {
            this._switchPhase('retract');
          }
          return;
        }

        // ── RETRACT: ارجع الذراع للوضع المحايد ──
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
      //  autoRelease — يستدعي window.autoRelease()
      //  فتح الأصابع تدريجياً حتى يختفي GRAB
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

        // timeout احتياطي
        setTimeout(() => {
          if (this._phase === 'release' && this.grabbed) {
            logger('⚠️ autoRelease timeout → force release', 'warn');
            this.robot.onGripRequest('end', {});
          }
        }, 8000);
      }

      // ══════════════════════════════════════
      //  فتح الأصابع بالمقدار المناسب
      // ══════════════════════════════════════
      _openFingers(ar, coords) {
        const boxHalf = coords?.half ?? ar.description.box?.half ?? 0.25;
        const fw = ar.FW ?? ar.parts.constants?.FW ?? 0.09;
        const baseOpen = ar.description.finger?.openX ?? ar.FOPEN ?? 0.38;
        const minOpen = (ar.description.finger?.closeX ?? 0.295) + 0.01;
        const needed = boxHalf + fw / 2 + 0.04;
        const openVal = clamp(needed, minOpen, Math.max(baseOpen, needed));
        if (typeof ar.setOpen === 'function') ar.setOpen(openVal);

        // مزامنة slider الواجهة (ضروري لـ autoGrab)
        const slider = document.getElementById('sOpen');
        if (slider) {
          const sliderVal = Math.round((openVal / 0.38) * 55);
          slider.value = clamp(sliderVal, 14, 55);
          slider.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }

      // ── للتوقف من الخارج ─────────────────
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
          reject(new Error('[PickPlace] robot API not ready')); return;
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

  initSDK().catch(e => console.error('[PickPlace] init error:', e));

  // ══════════════════════════════════════════════════════════
  //  Public API — تُستدعى من Console
  // ══════════════════════════════════════════════════════════

  /**
   * pickAndPlace(dropAt?)
   * يبدأ مهمة pick-and-place تلقائية
   * @param {object} dropAt - نقطة الإفلات { x, z }
   */
  window.pickAndPlace = async function (dropAt = { x: -1.2, z: 2.2 }) {
    await initSDK();
    const robot = await waitForRobot();
    const { RobotListener } = _modules;

    // أوقف المهمة السابقة
    _listener?.forceStop();

    const PickPlaceListener = buildListener(RobotListener, robot, {
      target: 'box',
      dropAt,
      onDone: () => console.log('[PickPlace] 🎉 Done!'),
      logger: window.log ?? ((msg) => console.log(`[PickPlace] ${msg}`)),
    });

    const fresh = new PickPlaceListener(robot);
    robot.setListener(fresh);
    window._pickPlaceListener = fresh;
    _listener = fresh;

    console.log(`[PickPlace] ✅ Started → drop at (${dropAt.x}, ${dropAt.z})`);
    console.log('[PickPlace] 📋 Use stopMission() to abort');

    return {
      status: () => _listener?.phase ?? 'idle',
      stop: () => _listener?.forceStop(),
    };
  };

  /** إيقاف المهمة فوراً */
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
