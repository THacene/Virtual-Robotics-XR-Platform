import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160/build/three.module.js";
import * as CANNON from "https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js";

/**
 * createRobot — Factory / Builder  (Industrial Edition 🏭)
 *
 * @param {object} description
 * @param {object} ctx  { world, scene, materials: { mBox, mFing, mGnd } }
 * @returns {object} robotParts
 */
export function createRobot(description, { world, scene, materials }) {
  const { mBox, mFing, mGnd } = materials;
  const jointLimits = description.joints?.limits ?? {};

  // ===== CONSTANTS =====
  const BH = description.box.half;
  const FW = description.finger.w;
  const FH = description.finger.h;
  const FD = description.finger.d;
  const FCLOSE = description.finger.closeX;
  const FOPEN = description.finger.openX;
  const FCOLOR = description.finger.color ?? 0xffcc00;

  const ARM_GROUP = 2;
  const ARM_MASK = 1 | 2;
  const kB = [];
  const joints = [];

  // =====================================================================
  // 🎨 PROCEDURAL TEXTURES — معدن مصقول، شرائط تحذير، تهوية، شعار
  // =====================================================================

  function makeBrushedMetalTexture(colorHex) {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 512;
    const g = c.getContext('2d');

    g.fillStyle = '#' + colorHex.toString(16).padStart(6, '0');
    g.fillRect(0, 0, 512, 512);

    // خدوش معدنية أفقية ناعمة
    for (let i = 0; i < 4000; i++) {
      g.fillStyle = `rgba(255,255,255,${Math.random() * 0.04})`;
      g.fillRect(Math.random() * 512, Math.random() * 512, Math.random() * 60 + 20, 1.5);
      g.fillStyle = `rgba(0,0,0,${Math.random() * 0.05})`;
      g.fillRect(Math.random() * 512, Math.random() * 512, Math.random() * 60 + 20, 1.5);
    }

    // بقع اتساخ صناعي خفيفة (grime) قرب الحواف
    for (let i = 0; i < 40; i++) {
      const x = Math.random() * 512, y = Math.random() * 512;
      const r = Math.random() * 40 + 10;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, 'rgba(0,0,0,0.06)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }

    // فواصل ألواح (panel gaps)
    g.strokeStyle = 'rgba(0,0,0,0.4)';
    g.lineWidth = 3;
    g.strokeRect(10, 10, 492, 492);
    g.strokeStyle = 'rgba(255,255,255,0.2)';
    g.lineWidth = 2;
    g.strokeRect(12, 12, 488, 488);
    // برشام (rivets) على الزوايا
    g.fillStyle = 'rgba(255,255,255,0.35)';
    [[28, 28], [484, 28], [28, 484], [484, 484]].forEach(([x, y]) => {
      g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill();
    });

    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    return tex;
  }

  // شريط تحذير صناعي أصفر/أسود مائل
  function makeHazardTexture() {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#E8B82F';
    g.fillRect(0, 0, 256, 64);
    g.fillStyle = '#23272B';
    for (let x = -64; x < 320; x += 64) {
      g.beginPath();
      g.moveTo(x, 64); g.lineTo(x + 32, 0); g.lineTo(x + 64, 0); g.lineTo(x + 32, 64);
      g.closePath(); g.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    return tex;
  }

  // شبكة تهوية
  function makeVentTexture() {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#101418';
    g.fillRect(0, 0, 128, 128);
    for (let y = 8; y < 128; y += 16) {
      g.fillStyle = '#2A3138';
      g.fillRect(8, y, 112, 6);
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(8, y, 112, 2);
    }
    return new THREE.CanvasTexture(c);
  }

  // شعار / اسم الموديل
  function makeDecalTexture(text, accentHex) {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 160;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 512, 160);
    g.fillStyle = 'rgba(255,255,255,0.95)';
    g.font = 'bold 68px Arial';
    g.fillText(text, 16, 78);
    g.fillStyle = '#' + accentHex.toString(16).padStart(6, '0');
    g.fillRect(16, 96, 320, 12);
    g.font = 'bold 28px Arial';
    g.fillStyle = 'rgba(255,255,255,0.65)';
    g.fillText('HEAVY INDUSTRIAL SERIES', 16, 142);
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    return tex;
  }

  // أخاديد مطاطية لوسادة القبضة
  function makeGripTexture() {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#3A3530';
    g.fillRect(0, 0, 64, 128);
    for (let y = 4; y < 128; y += 12) {
      g.fillStyle = '#241F1B';
      g.fillRect(0, y, 64, 5);
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.fillRect(0, y, 64, 1.5);
    }
    return new THREE.CanvasTexture(c);
  }

  // =====================================================================
  // 🎨 MATERIALS — طلاء صناعي بطبقة لمعان (clearcoat)
  // =====================================================================

  // طلاء مصنع لامع: مثل أذرع KUKA/ABB المطلية
  const ms = c => new THREE.MeshPhysicalMaterial({
    color: c,
    map: makeBrushedMetalTexture(c),
    metalness: 0.45,
    roughness: 0.32,
    clearcoat: 0.6,
    clearcoatRoughness: 0.22,
  });

  const msPlain = c => new THREE.MeshStandardMaterial({ color: c, metalness: 0.8, roughness: 0.3 });

  const matHazard = new THREE.MeshStandardMaterial({ map: makeHazardTexture(), metalness: 0.2, roughness: 0.55 });
  const matVent = new THREE.MeshStandardMaterial({ map: makeVentTexture(), metalness: 0.6, roughness: 0.5 });
  const matCable = new THREE.MeshStandardMaterial({ color: 0x14151a, metalness: 0.05, roughness: 0.9 });
  const matChrome = new THREE.MeshStandardMaterial({ color: 0xd8dde2, metalness: 1.0, roughness: 0.08 });
  const matMotor = new THREE.MeshStandardMaterial({ color: 0x23272d, metalness: 0.7, roughness: 0.45 });

  // =====================================================================
  // HELPER: Hinge Constraint مع حدود الحركة
  // =====================================================================
  function createHingeJoint(bodyA, bodyB, pivotPosA, pivotPosB, axisA, axisB, limits) {
    const constraint = new CANNON.HingeConstraint(bodyA, bodyB, {
      pivotA: new CANNON.Vec3(pivotPosA.x, pivotPosA.y, pivotPosA.z),
      pivotB: new CANNON.Vec3(pivotPosB.x, pivotPosB.y, pivotPosB.z),
      axisA: new CANNON.Vec3(axisA.x, axisA.y, axisA.z),
      axisB: new CANNON.Vec3(axisB.x, axisB.y, axisB.z),
      collideConnected: false
    });
    world.addConstraint(constraint);

    constraint.enableMotor();
    constraint.setMotorSpeed(0);
    constraint.setMotorMaxForce(100000);

    joints.push({ bodyA, bodyB, axisA, axisB, limits, constraint });
  }

  // =====================================================================
  // HELPER: علبة محرك سيرفو بزعانف تبريد (توضع عند المفاصل)
  // =====================================================================
  function makeMotorHousing(radius, len, accentMat) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 24), matMotor);
    body.rotation.z = Math.PI / 2;
    body.castShadow = true;
    g.add(body);

    // زعانف تبريد
    for (let i = 0; i < 5; i++) {
      const fin = new THREE.Mesh(
        new THREE.CylinderGeometry(radius * 1.1, radius * 1.1, len * 0.06, 24),
        msPlain(0x3a4048)
      );
      fin.rotation.z = Math.PI / 2;
      fin.position.x = -len * 0.32 + i * len * 0.16;
      g.add(fin);
    }

    // غطاء نهاية ملوّن + صامولة كروم مركزية
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.72, radius * 0.72, 0.022, 24), accentMat);
    cap.rotation.z = Math.PI / 2;
    cap.position.x = len / 2 + 0.012;
    g.add(cap);
    const nut = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.2, radius * 0.2, 0.03, 6), matChrome);
    nut.rotation.z = Math.PI / 2;
    nut.position.x = len / 2 + 0.03;
    g.add(nut);

    return g;
  }

  // HELPER: أنبوب كابلات منحني على طول الذراع
  function makeCableConduit(points, radius) {
    const curve = new THREE.CatmullRomCurve3(points);
    const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, radius, 8, false), matCable);
    mesh.castShadow = true;
    // مشابك تثبيت الكابل
    [0.25, 0.55, 0.85].forEach(t => {
      const p = curve.getPoint(t);
      const clip = new THREE.Mesh(new THREE.TorusGeometry(radius * 1.25, radius * 0.3, 8, 12), matChrome);
      clip.position.copy(p);
      mesh.add(new THREE.Object3D()); // placeholder للحفاظ على البنية
      clip.lookAt(curve.getPoint(Math.min(t + 0.05, 1)).clone().add(p.clone().multiplyScalar(0)));
      mesh.parent?.add?.(clip);
      // نضيف المشبك للمجموعة الأم لاحقاً عبر الإرجاع
      mesh.userData.clips = mesh.userData.clips || [];
      mesh.userData.clips.push(clip);
    });
    return mesh;
  }

  // HELPER: لوحة شعار جانبية
  function makeDecal(text, accentHex, w, h) {
    return new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: makeDecalTexture(text, accentHex), transparent: true })
    );
  }

  const MODEL_NAME = (description.name ?? 'RX-07').toString().toUpperCase().slice(0, 8);

  // =====================================================================
  // BASE DIMENSIONS
  // =====================================================================
  const TRACK_W = description.base.track.w;
  const TRACK_L = description.base.track.len;
  const TRACK_H = description.base.track.h;
  const BODY_W = description.base.body.w;
  const BODY_H = description.base.body.h;
  const BODY_D = description.base.body.d;
  const TURRET_R = description.base.turret.r;
  const TURRET_H = description.base.turret.h;
  const BASE_OFF = TRACK_H + BODY_H + TURRET_H;

  const BODY_COLOR = description.base.body.color ?? 0x1e2d3d;
  const ACCENT_COLOR = description.base.accentColor ?? 0x0055ee;

  const chassisY = TRACK_H + BODY_H / 2;
  const turretY = TRACK_H + BODY_H + TURRET_H / 2;
  const chassisVol = BODY_W * BODY_H * BODY_D;
  const turretVol = Math.PI * TURRET_R * TURRET_R * TURRET_H;
  const trackVol = 2 * TRACK_W * TRACK_H * TRACK_L;
  const trackY = TRACK_H / 2;

  const totalVol = chassisVol + turretVol + trackVol;
  const COG_Y = (chassisY * chassisVol + turretY * turretVol + trackY * trackVol) / totalVol;

  // =====================================================================
  // VISUAL GROUP + PHYSICS BODY (بدون تغيير)
  // =====================================================================
  const baseG = new THREE.Group();
  scene.add(baseG);

  const basePh = new CANNON.Body({
    type: CANNON.Body.KINEMATIC,
    material: mGnd,
    collisionFilterGroup: 1,
    collisionFilterMask: -1,
    allowSleep: false
  });

  basePh.addShape(
    new CANNON.Box(new CANNON.Vec3((BODY_W + TRACK_W * 2) / 2, (BODY_H + TRACK_H) / 2, BODY_D / 2)),
    new CANNON.Vec3(0, chassisY - COG_Y, 0)
  );

  basePh.addShape(
    new CANNON.Cylinder(TURRET_R + 0.04, TURRET_R + 0.04, TURRET_H, 12),
    new CANNON.Vec3(0, turretY - COG_Y, 0),
    (() => { const q = new CANNON.Quaternion(); q.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2); return q; })()
  );

  basePh.position.set(0, COG_Y, 0);
  world.addBody(basePh);

  // =====================================================================
  // VISUAL MESHES — TRACKS
  // =====================================================================
  function makeTrackTexture() {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#332f2b';
    g.fillRect(0, 0, 256, 256);
    // تروس مطاطية بارزة مع ظلال
    for (let i = 0; i < 256; i += 32) {
      g.fillStyle = '#4a4540';
      g.fillRect(0, i, 256, 14);
      g.fillStyle = 'rgba(255,255,255,0.10)';
      g.fillRect(0, i, 256, 3);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(0, i + 11, 256, 3);
      // مسامير وسط التروس
      g.fillStyle = '#5a544e';
      for (let x = 24; x < 256; x += 52) g.fillRect(x, i + 4, 10, 6);
    }
    // غبار/طين خفيف
    for (let i = 0; i < 250; i++) {
      g.fillStyle = `rgba(140,120,90,${Math.random() * 0.08})`;
      g.fillRect(Math.random() * 256, Math.random() * 256, 4, 3);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, 15);
    return tex;
  }

  const matTrack = new THREE.MeshStandardMaterial({ map: makeTrackTexture(), metalness: 0.15, roughness: 0.85 });
  const matChassis = ms(BODY_COLOR);
  const matDeck = new THREE.MeshStandardMaterial({ color: 0x5C6370, metalness: 0.75, roughness: 0.4 });
  const matAccent = ms(ACCENT_COLOR);
  const matWheel = new THREE.MeshStandardMaterial({ color: 0x4A4640, metalness: 0.5, roughness: 0.65 });
  const matHub = new THREE.MeshStandardMaterial({ color: 0xB0B8C0, metalness: 0.85, roughness: 0.2 });

  const matBrake = new THREE.MeshStandardMaterial({
    color: 0x330000,
    emissive: 0xff0000,
    emissiveIntensity: 0.0,
    metalness: 0.2,
    roughness: 0.3,
    transparent: true,
    opacity: 0.95,
  });
  const brakeLights = [];
  const trackWheels = [];

  function makeTrack(side) {
    const g = new THREE.Group();
    const belt = new THREE.Mesh(new THREE.BoxGeometry(TRACK_W, TRACK_H, TRACK_L), matTrack);
    belt.castShadow = true;
    g.add(belt);
    [TRACK_L / 2, -TRACK_L / 2].forEach((z, i) => {
      const geom = new THREE.CylinderGeometry(TRACK_H / 2, TRACK_H / 2, TRACK_W, 20, 1, false, 0, Math.PI);
      geom.rotateZ(Math.PI / 2);
      const cap = new THREE.Mesh(geom, matTrack);
      cap.rotation.y = i === 0 ? Math.PI : 0;
      cap.position.z = z;
      cap.castShadow = true;
      g.add(cap);
    });
    [TRACK_L / 2, 0, -TRACK_L / 2].forEach(z => {
      const wGeom = new THREE.CylinderGeometry(TRACK_H / 2 - 0.005, TRACK_H / 2 - 0.005, TRACK_W + 0.01, 18);
      wGeom.rotateZ(Math.PI / 2);
      const w = new THREE.Mesh(wGeom, matWheel);
      w.position.z = z;
      w.castShadow = true;
      g.add(w);

      const hubGeom = new THREE.CylinderGeometry(TRACK_H * 0.26, TRACK_H * 0.26, TRACK_W + 0.03, 10);
      hubGeom.rotateZ(Math.PI / 2);
      const hub = new THREE.Mesh(hubGeom, matHub);

      const spokeGeom = new THREE.BoxGeometry(TRACK_H * 0.45, TRACK_H * 0.08, TRACK_W + 0.035);
      const spokeMat = msPlain(0x5A5550);
      const spoke1 = new THREE.Mesh(spokeGeom, spokeMat);
      const spoke2 = new THREE.Mesh(spokeGeom, spokeMat);
      spoke2.rotation.x = Math.PI / 2;
      hub.add(spoke1);
      hub.add(spoke2);

      hub.position.z = z;
      g.add(hub);

      trackWheels.push(w);
      trackWheels.push(hub);
    });

    // أغطية حماية (Fenders) مع شريط تحذير على الحافة
    const fenderGeom = new THREE.BoxGeometry(TRACK_W + 0.06, 0.03, TRACK_L + TRACK_H * 0.8);
    const fender = new THREE.Mesh(fenderGeom, matChassis);
    fender.position.set(0, TRACK_H + 0.015, 0);
    fender.castShadow = true;
    g.add(fender);

    const hazardStrip = new THREE.Mesh(
      new THREE.BoxGeometry(0.022, 0.026, TRACK_L + TRACK_H * 0.8),
      matHazard
    );
    hazardStrip.position.set(side * (TRACK_W / 2 + 0.02), TRACK_H + 0.015, 0);
    g.add(hazardStrip);

    const slantGeom = new THREE.BoxGeometry(TRACK_W + 0.06, 0.03, TRACK_H * 0.8);
    const slantF = new THREE.Mesh(slantGeom, matChassis);
    slantF.rotation.x = Math.PI / 4;
    slantF.position.set(0, TRACK_H - 0.05, TRACK_L / 2 + TRACK_H * 0.4 - 0.01);
    slantF.castShadow = true;
    g.add(slantF);

    const slantB = new THREE.Mesh(slantGeom, matChassis);
    slantB.rotation.x = -Math.PI / 4;
    slantB.position.set(0, TRACK_H - 0.05, -(TRACK_L / 2 + TRACK_H * 0.4 - 0.01));
    slantB.castShadow = true;
    g.add(slantB);

    const brakeMat = matBrake.clone();
    const brake = new THREE.Mesh(
      new THREE.BoxGeometry(TRACK_W * 0.7, TRACK_H * 0.5, 0.035),
      brakeMat
    );
    brake.position.set(0, TRACK_H / 2, -(TRACK_L / 2 + TRACK_H / 2 - 0.01));
    g.add(brake);

    const brakeLight = new THREE.PointLight(0xff0000, 0, 1.5);
    brakeLight.position.set(0, TRACK_H / 2, -(TRACK_L / 2 + TRACK_H / 2 + 0.05));
    g.add(brakeLight);

    brakeLights.push({ mat: brakeMat, light: brakeLight });

    const brakeFrame = new THREE.Mesh(
      new THREE.BoxGeometry(TRACK_W * 0.8, TRACK_H * 0.6, 0.02),
      new THREE.MeshStandardMaterial({ color: 0x3D3836, metalness: 0.4, roughness: 0.5 })
    );
    brakeFrame.position.set(0, TRACK_H / 2, -(TRACK_L / 2 + TRACK_H / 2 - 0.022));
    g.add(brakeFrame);

    g.position.set(side * (BODY_W / 2 + TRACK_W / 2), TRACK_H / 2, 0);
    baseG.add(g);
    return g;
  }

  const trackL = makeTrack(-1);
  const trackR = makeTrack(1);

  // =====================================================================
  // CHASSIS — هيكل صناعي مشطوف مع تهوية وشعار ومصدّات تحذير
  // =====================================================================
  const chassisM = new THREE.Group();
  const mainChassis = new THREE.Mesh(new THREE.BoxGeometry(BODY_W, BODY_H, BODY_D), matChassis);
  mainChassis.castShadow = true;
  chassisM.add(mainChassis);

  // لوح أمامي مائل (glacis plate) مثل المعدات الثقيلة
  const glacis = new THREE.Mesh(new THREE.BoxGeometry(BODY_W * 0.96, BODY_H * 0.7, 0.04), matChassis);
  glacis.rotation.x = -0.5;
  glacis.position.set(0, BODY_H * 0.1, BODY_D / 2 + 0.035);
  glacis.castShadow = true;
  chassisM.add(glacis);

  // مصدّات تحذير أمامية وخلفية
  [[BODY_D / 2 + 0.065, 1], [-BODY_D / 2 - 0.025, -1]].forEach(([z]) => {
    const bumper = new THREE.Mesh(new THREE.BoxGeometry(BODY_W * 0.9, BODY_H * 0.22, 0.05), matHazard);
    bumper.position.set(0, -BODY_H * 0.3, z);
    chassisM.add(bumper);
  });

  // ألواح جانبية + شعار + تهوية
  const sidePanelMat = msPlain(0x5C6370);
  [-1, 1].forEach(dir => {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.04, BODY_H * 0.8, BODY_D * 0.9), sidePanelMat);
    panel.position.set(dir * (BODY_W / 2 + 0.01), 0, 0);
    chassisM.add(panel);

    // شعار اسم الموديل
    const decal = makeDecal(MODEL_NAME, ACCENT_COLOR, BODY_D * 0.45, BODY_H * 0.34);
    decal.rotation.y = dir * Math.PI / 2;
    decal.position.set(dir * (BODY_W / 2 + 0.035), BODY_H * 0.12, dir * (-BODY_D * 0.12));
    chassisM.add(decal);

    // شبكة تهوية خلفية جانبية
    const vent = new THREE.Mesh(new THREE.PlaneGeometry(BODY_D * 0.26, BODY_H * 0.42), matVent);
    vent.rotation.y = dir * Math.PI / 2;
    vent.position.set(dir * (BODY_W / 2 + 0.033), -BODY_H * 0.05, dir * (BODY_D * 0.3));
    chassisM.add(vent);
  });

  chassisM.position.set(0, TRACK_H + BODY_H / 2, 0);
  baseG.add(chassisM);

  const deckM = new THREE.Mesh(new THREE.BoxGeometry(BODY_W - 0.04, 0.03, BODY_D - 0.06), matDeck);
  deckM.position.set(0, TRACK_H + BODY_H + 0.015, 0);
  baseG.add(deckM);

  // صناديق معدات على السطح (خلف البرج)
  const toolbox = new THREE.Mesh(
    new THREE.BoxGeometry(BODY_W * 0.55, TURRET_H * 0.8, BODY_D * 0.18),
    msPlain(0x39414a)
  );
  toolbox.position.set(0, TRACK_H + BODY_H + TURRET_H * 0.4, -BODY_D * 0.36);
  toolbox.castShadow = true;
  baseG.add(toolbox);
  const toolboxHazard = new THREE.Mesh(
    new THREE.BoxGeometry(BODY_W * 0.55 + 0.01, 0.025, BODY_D * 0.18 + 0.01),
    matHazard
  );
  toolboxHazard.position.set(0, TRACK_H + BODY_H + TURRET_H * 0.82, -BODY_D * 0.36);
  baseG.add(toolboxHazard);

  // هوائي اتصالات
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.01, 0.5, 8), matChrome);
  antenna.position.set(-BODY_W * 0.38, TRACK_H + BODY_H + 0.27, -BODY_D * 0.4);
  baseG.add(antenna);
  const antennaTip = new THREE.Mesh(
    new THREE.SphereGeometry(0.018, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0xff3300, emissive: 0xff2200, emissiveIntensity: 0.9 })
  );
  antennaTip.position.set(-BODY_W * 0.38, TRACK_H + BODY_H + 0.53, -BODY_D * 0.4);
  baseG.add(antennaTip);

  // =====================================================================
  // TURRET — برج دوران بمظهر مسنن صناعي
  // =====================================================================
  const turretBase = new THREE.Mesh(
    new THREE.CylinderGeometry(TURRET_R, TURRET_R + 0.05, TURRET_H, 32),
    matChassis
  );
  turretBase.position.set(0, TRACK_H + BODY_H + TURRET_H / 2, 0);
  turretBase.castShadow = true;
  baseG.add(turretBase);

  // حلقة مسننة (slew bearing) — أسنان حول قاعدة البرج
  const gearRing = new THREE.Group();
  for (let i = 0; i < 24; i++) {
    const ang = (i / 24) * Math.PI * 2;
    const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.035, TURRET_H * 0.35, 0.025), msPlain(0x6B7280));
    tooth.position.set(Math.cos(ang) * (TURRET_R + 0.045), 0, Math.sin(ang) * (TURRET_R + 0.045));
    tooth.rotation.y = -ang;
    gearRing.add(tooth);
  }
  gearRing.position.set(0, TRACK_H + BODY_H + TURRET_H * 0.25, 0);
  baseG.add(gearRing);

  const turretRing = new THREE.Mesh(
    new THREE.TorusGeometry(TURRET_R + 0.01, 0.02, 16, 32),
    msPlain(0x6B7280)
  );
  turretRing.rotation.x = Math.PI / 2;
  turretRing.position.set(0, TRACK_H + BODY_H + 0.02, 0);
  baseG.add(turretRing);

  const turretTop = new THREE.Mesh(
    new THREE.CylinderGeometry(TURRET_R - 0.03, TURRET_R, 0.04, 32),
    matAccent
  );
  turretTop.position.set(0, TRACK_H + BODY_H + TURRET_H - 0.01, 0);
  baseG.add(turretTop);

  // مسامير حول قمة البرج
  const turretBoltMat = matChrome;
  for (let i = 0; i < 10; i++) {
    const ang = (i / 10) * Math.PI * 2;
    const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.018, 6), turretBoltMat);
    bolt.position.set(
      Math.cos(ang) * (TURRET_R - 0.06),
      TRACK_H + BODY_H + TURRET_H + 0.012,
      Math.sin(ang) * (TURRET_R - 0.06)
    );
    baseG.add(bolt);
  }

  // مصابيح أمامية مضيئة بإطار كروم
  [-0.24, 0.24].forEach(x => {
    const bezel = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.04), matChrome);
    bezel.position.set(x, TRACK_H + BODY_H + 0.025, BODY_D / 2 - 0.04);
    baseG.add(bezel);
    const lens = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, 0.05, 0.012),
      new THREE.MeshStandardMaterial({
        color: 0xfff6d8, emissive: 0xffeeaa, emissiveIntensity: 1.4,
        metalness: 0.1, roughness: 0.2
      })
    );
    lens.position.set(x, TRACK_H + BODY_H + 0.025, BODY_D / 2 - 0.016);
    baseG.add(lens);
  });

  // =====================================================================
  // STATUS LIGHT (cobot) — بدون تغيير
  // =====================================================================
  let statusLight = null;
  if (description.base.statusLight) {
    const matStatus = new THREE.MeshStandardMaterial({
      color: ACCENT_COLOR, emissive: ACCENT_COLOR, emissiveIntensity: 1.0,
      metalness: 0.1, roughness: 0.4,
    });
    statusLight = new THREE.Mesh(
      new THREE.SphereGeometry(TURRET_R * 0.55, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2),
      matStatus
    );
    statusLight.position.set(0, TRACK_H + BODY_H + TURRET_H + 0.005, 0);
    baseG.add(statusLight);
  }

  const cogIndicatorMat = new THREE.MeshStandardMaterial({
    color: 0xff6600, emissive: 0xff3300, emissiveIntensity: 0.6,
    transparent: true, opacity: 0.45, depthWrite: false,
  });
  const cogIndicator = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), cogIndicatorMat);
  cogIndicator.position.set(0, COG_Y, 0);
  cogIndicator.name = 'cogIndicator';
  baseG.add(cogIndicator);

  const trackState = { offset: 0, matTrack, wheels: trackWheels };
  const baseM = turretBase;

  // =====================================================================
  // ARM — SHOULDER (ذراع صناعية: علبة محرك + كابلات + شعار)
  // =====================================================================
  const a1p = new THREE.Group();
  a1p.position.y = BASE_OFF;
  baseG.add(a1p);

  const a1m = new THREE.Group();
  a1m.position.y = description.arm.shoulder.len / 2;

  const shoulderW = description.arm.shoulder.w;
  const shoulderLen = description.arm.shoulder.len;
  const matShoulder = ms(description.arm.shoulder.color);

  // جسم الذراع الرئيسي
  const a1body = new THREE.Mesh(
    new THREE.CylinderGeometry(shoulderW * 0.6, shoulderW * 0.7, shoulderLen - shoulderW, 32),
    matShoulder
  );
  a1body.castShadow = true;
  a1m.add(a1body);

  // أضلاع تقوية جانبية (structural ribs)
  [-1, 1].forEach(dir => {
    const rib = new THREE.Mesh(
      new THREE.BoxGeometry(shoulderW * 0.18, shoulderLen - shoulderW * 1.3, shoulderW * 0.5),
      matShoulder
    );
    rib.position.set(dir * shoulderW * 0.58, 0, 0);
    rib.castShadow = true;
    a1m.add(rib);
  });

  // علبة محرك المفصل السفلي (بزعانف تبريد)
  const a1Motor = makeMotorHousing(shoulderW * 0.62, shoulderW * 1.7, matAccent);
  a1Motor.position.y = -shoulderLen / 2;
  a1m.add(a1Motor);

  // شريط تحذير حول أعلى الذراع
  const a1Hazard = new THREE.Mesh(
    new THREE.CylinderGeometry(shoulderW * 0.615, shoulderW * 0.615, shoulderW * 0.3, 32),
    matHazard
  );
  a1Hazard.position.y = shoulderLen / 2 - shoulderW * 0.75;
  a1m.add(a1Hazard);

  // أنبوب كابلات منحني على طول الذراع
  const a1Cable = makeCableConduit([
    new THREE.Vector3(shoulderW * 0.35, -shoulderLen / 2 + shoulderW * 0.7, shoulderW * 0.6),
    new THREE.Vector3(shoulderW * 0.55, -shoulderLen * 0.1, shoulderW * 0.68),
    new THREE.Vector3(shoulderW * 0.45, shoulderLen * 0.25, shoulderW * 0.55),
    new THREE.Vector3(shoulderW * 0.2, shoulderLen / 2 - shoulderW * 0.3, shoulderW * 0.35),
  ], shoulderW * 0.11);
  a1m.add(a1Cable);
  (a1Cable.userData.clips ?? []).forEach(c => a1m.add(c));

  // شعار على جانب الذراع
  const a1Decal = makeDecal(MODEL_NAME, ACCENT_COLOR, shoulderLen * 0.4, shoulderLen * 0.13);
  a1Decal.rotation.y = Math.PI / 2;
  a1Decal.rotation.z = -Math.PI / 2;
  a1Decal.position.set(shoulderW * 0.68, 0, 0);
  a1m.add(a1Decal);

  a1p.add(a1m);

  const a1ph = new CANNON.Body({
    type: CANNON.Body.KINEMATIC, mass: description.arm.shoulder.mass,
    material: mBox, allowSleep: false, collisionFilterGroup: ARM_GROUP, collisionFilterMask: ARM_MASK
  });
  a1ph.addShape(new CANNON.Box(new CANNON.Vec3(description.arm.shoulder.physHalfW, description.arm.shoulder.physHalfH, description.arm.shoulder.physHalfD)));
  world.addBody(a1ph);
  kB.push({ mesh: a1m, body: a1ph });

  // =====================================================================
  // ARM — ELBOW
  // =====================================================================
  const a2p = new THREE.Group();
  a2p.position.y = shoulderLen / 2;
  a1m.add(a2p);

  const a2m = new THREE.Group();
  a2m.position.y = description.arm.elbow.physHalfH;

  const elbowW = description.arm.elbow.w;
  const elbowLen = description.arm.elbow.len;
  const matElbow = ms(description.arm.elbow.color);

  const a2body = new THREE.Mesh(
    new THREE.CylinderGeometry(elbowW * 0.5, elbowW * 0.6, elbowLen - elbowW, 32),
    matElbow
  );
  a2body.castShadow = true;
  a2m.add(a2body);

  // علبة محرك مفصل الكوع
  const a2Motor = makeMotorHousing(elbowW * 0.56, elbowW * 1.55, matAccent);
  a2Motor.position.y = -elbowLen / 2;
  a2m.add(a2Motor);

  // أنبوب كابلات الساعد
  const a2Cable = makeCableConduit([
    new THREE.Vector3(elbowW * 0.3, -elbowLen / 2 + elbowW * 0.6, elbowW * 0.52),
    new THREE.Vector3(elbowW * 0.45, 0, elbowW * 0.58),
    new THREE.Vector3(elbowW * 0.2, elbowLen / 2 - elbowW * 0.3, elbowW * 0.3),
  ], elbowW * 0.1);
  a2m.add(a2Cable);
  (a2Cable.userData.clips ?? []).forEach(c => a2m.add(c));

  // شريط تحذير قرب المعصم
  const a2Hazard = new THREE.Mesh(
    new THREE.CylinderGeometry(elbowW * 0.515, elbowW * 0.515, elbowW * 0.26, 32),
    matHazard
  );
  a2Hazard.position.y = elbowLen / 2 - elbowW * 0.65;
  a2m.add(a2Hazard);

  // مخمد هيدروليكي وهمي (يضيف واقعية ميكانيكية)
  const piston = new THREE.Mesh(new THREE.CylinderGeometry(elbowW * 0.1, elbowW * 0.1, elbowLen * 0.45, 12), matChrome);
  piston.position.set(-elbowW * 0.45, -elbowLen * 0.12, 0);
  a2m.add(piston);
  const pistonSleeve = new THREE.Mesh(new THREE.CylinderGeometry(elbowW * 0.15, elbowW * 0.15, elbowLen * 0.3, 12), matMotor);
  pistonSleeve.position.set(-elbowW * 0.45, -elbowLen * 0.3, 0);
  a2m.add(pistonSleeve);

  a2p.add(a2m);

  const a2ph = new CANNON.Body({
    type: CANNON.Body.KINEMATIC, mass: description.arm.elbow.mass,
    material: mBox, allowSleep: false, collisionFilterGroup: ARM_GROUP, collisionFilterMask: ARM_MASK
  });
  a2ph.addShape(new CANNON.Box(new CANNON.Vec3(description.arm.elbow.physHalfW, description.arm.elbow.physHalfH, description.arm.elbow.physHalfD)));
  world.addBody(a2ph);
  kB.push({ mesh: a2m, body: a2ph });

  // =====================================================================
  // ARM — WRIST
  // =====================================================================
  const wp = new THREE.Group();
  wp.position.y = description.arm.elbow.physHalfH;
  a2m.add(wp);

  const WR = description.arm.wrist.r;
  const WHt = description.arm.wrist.h;
  const wm = new THREE.Mesh(
    new THREE.CylinderGeometry(WR, WR * 1.1, WHt, 32),
    ms(description.arm.wrist.color)
  );
  wm.castShadow = true;
  wp.add(wm);

  const wristRing = new THREE.Mesh(
    new THREE.TorusGeometry(WR * 1.05, WR * 0.22, 16, 32),
    msPlain(0xA0A8B0)
  );
  wristRing.rotation.x = Math.PI / 2;
  wm.add(wristRing);

  // حلقة LED حالة على المعصم (لمسة cobot حديثة)
  const wristLed = new THREE.Mesh(
    new THREE.TorusGeometry(WR * 1.02, WR * 0.06, 8, 32),
    new THREE.MeshStandardMaterial({
      color: ACCENT_COLOR, emissive: ACCENT_COLOR, emissiveIntensity: 1.2,
      metalness: 0.1, roughness: 0.3
    })
  );
  wristLed.rotation.x = Math.PI / 2;
  wristLed.position.y = WHt * 0.28;
  wm.add(wristLed);

  const wristFlange = new THREE.Mesh(
    new THREE.CylinderGeometry(WR * 0.95, WR * 0.8, 0.05, 32),
    msPlain(0x6B7280)
  );
  wristFlange.position.y = -WHt / 2 - 0.02;
  wristFlange.castShadow = true;
  wm.add(wristFlange);

  const boltMat = new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 1.0, roughness: 0.1 });
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2;
    const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.015, 8), boltMat);
    bolt.position.set(Math.cos(ang) * WR * 0.65, WHt / 2 + 0.005, Math.sin(ang) * WR * 0.65);
    wm.add(bolt);
  }

  const wph = new CANNON.Body({
    type: CANNON.Body.KINEMATIC, mass: description.arm.wrist.mass,
    material: mBox, allowSleep: false, collisionFilterGroup: ARM_GROUP, collisionFilterMask: ARM_MASK
  });
  wph.addShape(new CANNON.Cylinder(WR, WR, WHt, 16));
  world.addBody(wph);
  kB.push({ mesh: wm, body: wph });

  // =====================================================================
  // PALM — قابض صناعي مع شريط تحذير
  // =====================================================================
  const palmG = new THREE.Group();
  palmG.position.y = 0.1;
  wp.add(palmG);

  const tcp = new THREE.Object3D();
  tcp.name = "tcp";
  tcp.position.set(0, 0.06, 0);
  palmG.add(tcp);

  const PW = description.arm.palm.w;
  const PHt = description.arm.palm.h;
  const PD = description.arm.palm.d;

  const palmM = new THREE.Group();
  const palmCore = new THREE.Mesh(
    new THREE.BoxGeometry(PW, PHt, PD),
    ms(description.arm.palm.color)
  );
  palmCore.castShadow = true;
  palmM.add(palmCore);

  [1, -1].forEach(dir => {
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(0.02, PHt * 0.8, PD * 1.05),
      matAccent
    );
    plate.position.set(dir * (PW / 2 + 0.01), 0, 0);
    palmM.add(plate);
  });

  palmG.add(palmM);

  const gripperMat = msPlain(0x78818C);
  const knuckleMat = msPlain(0x9CA3AF);

  const gripperBase = new THREE.Mesh(
    new THREE.BoxGeometry(PW * 1.02, PHt * 1.4, PD * 0.8),
    gripperMat
  );
  gripperBase.position.y = PHt * 0.5;
  gripperBase.castShadow = true;
  palmG.add(gripperBase);

  // شريط تحذير على واجهة القابض
  const gripperHazard = new THREE.Mesh(
    new THREE.BoxGeometry(PW * 1.03, PHt * 0.3, 0.012),
    matHazard
  );
  gripperHazard.position.set(0, PHt * 0.5, PD * 0.4 + 0.007);
  palmG.add(gripperHazard);

  const rail = new THREE.Mesh(
    new THREE.BoxGeometry(PW * 0.96, PHt * 0.45, PD * 0.4),
    knuckleMat
  );
  rail.position.y = PHt * 1.1;
  palmG.add(rail);

  const palmPh = new CANNON.Body({
    type: CANNON.Body.KINEMATIC, mass: description.arm.palm.mass,
    material: mBox, allowSleep: false, collisionFilterGroup: ARM_GROUP, collisionFilterMask: ARM_MASK
  });
  palmPh.addShape(new CANNON.Box(new CANNON.Vec3(description.arm.palm.physHalfW, description.arm.palm.physHalfH, description.arm.palm.physHalfD)));
  world.addBody(palmPh);
  kB.push({ mesh: palmM, body: palmPh });

  // =====================================================================
  // FINGERS — وسادات مطاطية بأخاديد قبض حقيقية
  // =====================================================================
  const lG = new THREE.Group();
  lG.position.set(-FOPEN, 0.04, 0);
  palmG.add(lG);

  const rG = new THREE.Group();
  rG.position.set(FOPEN, 0.04, 0);
  palmG.add(rG);

  const fingerMat = msPlain(FCOLOR);
  const padMat = new THREE.MeshStandardMaterial({
    map: makeGripTexture(), color: 0xffffff, metalness: 0.05, roughness: 0.95
  });
  const jointMat = msPlain(0x8C939A);

  function makeFinger(grp, dir) {
    const m = new THREE.Group();
    m.position.y = FH / 2;
    grp.add(m);

    const sliderLength = 0.28;
    const slider = new THREE.Mesh(
      new THREE.BoxGeometry(sliderLength, FH * 0.15, FD * 0.35),
      jointMat
    );
    slider.position.set(-dir * (sliderLength / 2 + FW * 0.1), -FH / 2 + FW * 0.3, dir * 0.03);
    slider.castShadow = true;
    m.add(slider);

    const knuckle = new THREE.Mesh(new THREE.SphereGeometry(FW * 0.62, 24, 16), jointMat);
    knuckle.position.y = -FH / 2 + FW * 0.3;
    knuckle.castShadow = true;
    m.add(knuckle);

    const proximal = new THREE.Mesh(new THREE.BoxGeometry(FW, FH * 0.55, FD * 0.92), fingerMat);
    proximal.position.y = -FH * 0.12;
    proximal.castShadow = true;
    m.add(proximal);

    const midJoint = new THREE.Mesh(new THREE.CylinderGeometry(FW * 0.5, FW * 0.5, FD * 0.98, 24), jointMat);
    midJoint.rotation.x = Math.PI / 2;
    midJoint.position.y = FH * 0.18;
    m.add(midJoint);

    const tip = new THREE.Mesh(new THREE.BoxGeometry(FW * 0.9, FH * 0.42, FD * 0.85), fingerMat);
    tip.position.set(-dir * FW * 0.12, FH * 0.38, 0);
    tip.rotation.z = dir * 0.18;
    tip.castShadow = true;
    m.add(tip);

    // وسادة مطاطية بأخاديد
    const pad = new THREE.Mesh(new THREE.BoxGeometry(FW * 0.28, FH * 0.7, FD * 0.7), padMat);
    pad.position.set(-dir * (FW * 0.42), FH * 0.05, 0);
    m.add(pad);

    // مسامير تثبيت صغيرة على الإصبع
    [FH * 0.25, -FH * 0.25].forEach(y => {
      const screw = new THREE.Mesh(new THREE.CylinderGeometry(FW * 0.08, FW * 0.08, 0.008, 8), matChrome);
      screw.rotation.x = Math.PI / 2;
      screw.position.set(0, y, FD * 0.47);
      m.add(screw);
    });

    const p = new CANNON.Body({
      type: CANNON.Body.KINEMATIC, mass: description.finger.mass,
      material: mFing, allowSleep: false, collisionFilterGroup: ARM_GROUP, collisionFilterMask: ARM_MASK
    });
    p.addShape(new CANNON.Box(new CANNON.Vec3(FW / 2, FH / 2, FD / 2)));
    world.addBody(p);
    kB.push({ mesh: m, body: p });
    return p;
  }

  const lFP = makeFinger(lG, -1);
  const rFP = makeFinger(rG, 1);

  // =====================================================================
  // JOINTS (PHYSICS) — بدون تغيير
  // =====================================================================
  createHingeJoint(
    basePh, a1ph,
    new CANNON.Vec3(0, BASE_OFF, 0),
    new CANNON.Vec3(0, -description.arm.shoulder.len / 2, 0),
    new CANNON.Vec3(1, 0, 0),
    new CANNON.Vec3(1, 0, 0),
    jointLimits.shoulder ?? { min: -90, max: 90 }
  );

  createHingeJoint(
    a1ph, a2ph,
    new CANNON.Vec3(0, description.arm.shoulder.len / 2, 0),
    new CANNON.Vec3(0, -description.arm.elbow.len / 2, 0),
    new CANNON.Vec3(1, 0, 0),
    new CANNON.Vec3(1, 0, 0),
    jointLimits.elbow ?? { min: 0, max: 180 }
  );

  createHingeJoint(
    a2ph, wph,
    new CANNON.Vec3(0, description.arm.elbow.len / 2, 0),
    new CANNON.Vec3(0, -description.arm.wrist.h / 2, 0),
    new CANNON.Vec3(0, 1, 0),
    new CANNON.Vec3(0, 1, 0),
    jointLimits.wrist ?? { min: -180, max: 180 }
  );

  return {
    constants: { BH, FW, FH, FD, FCLOSE, FOPEN, BASE_OFF, ARM_GROUP, ARM_MASK, COG_Y },
    base: { group: baseG, body: basePh, mesh: baseM, trackL, trackR, trackState, statusLight, cogIndicator, brakeLights, COG_Y },
    shoulder: { pivot: a1p, mesh: a1m, body: a1ph },
    elbow: { pivot: a2p, mesh: a2m, body: a2ph },
    wrist: { pivot: wp, mesh: wm, body: wph },
    palm: { group: palmG, mesh: palmM, body: palmPh, tcp },
    fingers: {
      left: { group: lG, body: lFP },
      right: { group: rG, body: rFP }
    },
    joints,
    kB
  };
}
