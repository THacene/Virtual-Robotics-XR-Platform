// ============================================================
//  test2.js — Navigation with A* Collision Avoidance (v2.2)
//  ملف مستقل — لا يُعدِّل أي ملف قائم (يستعمل فقط API)
//
//  يخطط مساراً كاملاً على شبكة حول كل العوائق (روبوتات + صناديق)
//  ويعيد التخطيط دورياً لمواكبة الروبوتات المتحركة.
//
//  ✅ v2.2: إزالة تكرار عوائق الرؤية + استمرارية بلا توقف + قيادة أسرع
//
//  الاستخدام في Console:
//    moveTo(5, 3)               → يحرّك الروبوت إلى (x=5, z=3)
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
  //  دوال مساعدة
  // ══════════════════════════════════════════════════════════

  const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, v));
  const normalizeRad = a => Math.atan2(Math.sin(a), Math.cos(a));

  // ══════════════════════════════════════════════════════════
  //  NavListener — تنقل بمخطط A*
  //
  //  المراحل:
  //    idle → moving → arrived | stopped
  // ══════════════════════════════════════════════════════════

  function buildNavListener(RobotListener, robot, options = {}) {

    const GOAL = { x: options.goalX ?? 0, z: options.goalZ ?? 0 };
    const onDone = options.onDone ?? (() => { });
    const logger = options.logger ?? ((msg) => console.log(`[NavBot] ${msg}`));
    const STOP_RADIUS = 0.35;

    // ────────────────────────────────────────────
    class NavListener extends RobotListener {

      constructor(robot) {
        super(robot, logger);
        this.controlsDrive = true;
        this._phase = 'idle';
        this._phaseAt = performance.now();
        this._finished = false;

        // مواقع الروبوتات الأخرى (يُحدَّث كل frame)
        this._otherRobots = new Map();

        // ── A* Path Planning State ──
        this._path = null;
        this._pathIdx = 0;
        this._plannedAt = 0;

        this._switchPhase('moving');
        logger(`🚀 Navigating → (${GOAL.x}, ${GOAL.z})`);
      }

      get _ar() { return this.robot._robot3D; }

      get phase() { return this._phase; }

      _switchPhase(p) {
        if (this._phase === p) return;
        this._phase = p;
        this._phaseAt = performance.now();
        logger(`▶ PHASE → ${p}`);
      }

      _elapsed() { return performance.now() - this._phaseAt; }

      // ══════════════════════════════════════
      //  COMPUTER VISION → عوائق افتراضية
      //  ✅ v2.2: روبوتات فقط، بلا تكرار، سجل واحد لكل اسم
      // ══════════════════════════════════════
      _updateVisionObstacles() {
        const ar = this._ar;
        if (!ar?.parts) return;
        const v = window.__vision;
        if (!v) return;
        const now = performance.now();

        for (const [key, data] of this._otherRobots) {
          if (data._vision && now - data.lastSeen > 1000) {
            this._otherRobots.delete(key);
          }
        }

        if (!v.active) return;
        const base = ar.parts.base.group.position;
        const detections = v.getDetections();
        for (let i = 0; i < detections.length; i++) {
          const d = detections[i];
          // ✅ روبوتات فقط — الصناديق تُقرأ بدقة من __boxes
          if (!d.name || !d.name.toLowerCase().includes('robot')) continue;
          const pos3d = v.estimate3DPosition(d);
          // ✅ تجاهل رصد الذات (الكاميرا قد ترى أجزاء الروبوت نفسه)
          if (Math.hypot(pos3d.x - base.x, pos3d.z - base.z) < 1.2) continue;

          // ✅ تجاهل إذا كان نفس الروبوت معروفاً بدقة من onRobotDetected
          let dup = false;
          for (const [, o] of this._otherRobots) {
            if (!o._vision && Math.hypot(o.x - pos3d.x, o.z - pos3d.z) < 1.5) { dup = true; break; }
          }
          if (dup) continue;

          const key = `vision_${d.name}`;   // ✅ بدون فهرس → سجل واحد لكل اسم
          this._otherRobots.set(key, {
            x: pos3d.x, z: pos3d.z,
            yaw: 0, speed: 0,
            lastSeen: now,
            _vision: true,
            name: d.name
          });
        }
      }

      // ══════════════════════════════════════
      //  EVENT: onRobotDetected (كل frame)
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
      //  جمع كل العوائق (روبوتات + رؤية + صناديق)
      // ══════════════════════════════════════
      _collectObstacles(goal) {
        const now = performance.now();
        const out = [];
        const add = (id, x, z, radius) => {
          // العائق الملاصق للهدف لا يمنع الوصول إليه
          if (Math.hypot(x - goal.x, z - goal.z) < 0.7) return;
          out.push({ id, x, z, radius });
        };

        // 1) روبوتات + عوائق الرؤية (نصف قطر أصغر للرؤية لأنها أقل دقة)
        for (const [id, data] of this._otherRobots) {
          if (now - data.lastSeen > 300 && !data._vision) continue;
          add(data.name || id, data.x, data.z, data._vision ? 0.8 : 1.3);
        }

        // 2) الصناديق (مباشرة، أدق من الرؤية)
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
      //  A* Grid Path Planner
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

        // حرّر خلايا البداية والهدف
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

        // تبسيط بخط رؤية مشدّد (الخلية + جيرانها → لا قصّ للزوايا)
        const los = (a, b) => {
          const ai = Math.floor(a / N), aj = a % N;
          const bi2 = Math.floor(b / N), bj = b % N;
          const steps = Math.max(Math.abs(bi2 - ai), Math.abs(bj - aj)) * 2;
          for (let s = 1; s < steps; s++) {
            const i = Math.round(ai + (bi2 - ai) * s / steps);
            const j = Math.round(aj + (bj - aj) * s / steps);
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
      //  المنطق الرئيسي: تتبع مسار A*
      // ══════════════════════════════════════
      _navigate(ar) {
        const base = ar.parts.base.group.position;
        const now = performance.now();

        // ── وصلنا إلى الهدف النهائي؟ ──
        const goalDist = Math.hypot(GOAL.x - base.x, GOAL.z - base.z);
        if (goalDist < STOP_RADIUS) {
          ar.setDrive(0, 0);
          this._finished = true;
          this._switchPhase('arrived');
          logger(`🏁 ARRIVED at (${GOAL.x.toFixed(1)}, ${GOAL.z.toFixed(1)})`);
          onDone();
          return;
        }

        // ── إعادة التخطيط كل 2.5 ثانية ──
        if (!this._path || now - this._plannedAt > 2500) {
          this._path = this._planPath(ar, GOAL);
          this._pathIdx = 0;
          this._plannedAt = now;
          if (!this._path) {
            ar.setDrive(0, 0);
            this._switchPhase('waiting');
            logger('⏳ No path available — waiting for clearance...');
            return;
          }
          // ✅ v2.2: تخطَّ النقاط التي نحن عندها أصلاً → استمرارية بلا توقف
          while (this._pathIdx < this._path.length - 1 &&
                 Math.hypot(this._path[this._pathIdx].x - base.x,
                            this._path[this._pathIdx].z - base.z) < 0.6) {
            this._pathIdx++;
          }
          this._switchPhase('moving');
        }

        // ── النقطة الحالية على المسار ──
        let wp = this._path[Math.min(this._pathIdx, this._path.length - 1)];
        const isLast = this._pathIdx >= this._path.length - 1;
        if (Math.hypot(wp.x - base.x, wp.z - base.z) < (isLast ? STOP_RADIUS : 0.45)) {
          if (!isLast) {
            this._pathIdx++;
            wp = this._path[this._pathIdx];
            logger(`📍 Waypoint ${this._pathIdx}/${this._path.length - 1} reached → next`);
          } else {
            ar.setDrive(0, 0);
            return;
          }
        }

        // ── قيادة القاعدة — ✅ v2.2: أسرع ──
        const yaw = ar.baseState?.yaw ?? 0;
        const targetYaw = Math.atan2(wp.x - base.x, wp.z - base.z);
        const yawErr = normalizeRad(targetYaw - yaw);
        const mv = ar.description.movement;

        let speed = 0;
        if (Math.abs(yawErr) < 0.5) {
          speed = clamp(Math.hypot(wp.x - base.x, wp.z - base.z) * 0.8,
            0.25, mv.speed * 0.75);
        }
        const turn = Math.abs(yawErr) < 0.04 ? 0 : clamp(yawErr * 2.2, -mv.turn, mv.turn);

        ar.setDrive(speed, turn);

        // ── سجل الحالة كل ~2 ثانية ──
        const elMs = this._elapsed();
        if (elMs > 0 && Math.floor(elMs / 2000) !== Math.floor((elMs - 16) / 2000)) {
          logger(
            `📡 dist=${goalDist.toFixed(1)}m | ` +
            `phase=${this._phase} | ` +
            `wp=${this._pathIdx + 1}/${this._path.length} | ` +
            `robots nearby=${this._otherRobots.size}`
          );
        }
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

  window.moveTo = async function (x, z) {
    if (typeof x !== 'number' || typeof z !== 'number') {
      console.error('[NavBot] ❌ Usage: moveTo(x, z)  — example: moveTo(5, 3)');
      return;
    }

    await initSDK();
    const robot = await waitForRobot();
    const { RobotListener } = _modules;

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
    window._navListener = fresh;   // للتشخيص من الـ console

    const pos = robot._robot3D.parts.base.group.position;
    console.log(`[NavBot] ✅ Moving: (${pos.x.toFixed(1)}, ${pos.z.toFixed(1)}) → (${x}, ${z})`);
    console.log('[NavBot] 📋 stopMove() to abort | moveStatus() to check');

    return {
      status: () => _listener?.phase ?? 'idle',
      stop: () => _listener?.forceStop(),
    };
  };

  window.stopMove = function () {
    if (_listener) {
      _listener.forceStop();
      _listener = null;
    }
    const ar = window.robot?._robot3D;
    if (ar) ar.setDrive(0, 0);
    console.log('[NavBot] 🛑 Stopped');
  };

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
