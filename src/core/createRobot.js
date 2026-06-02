import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160/build/three.module.js";
import * as CANNON from "https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js";

/**
 * createRobot — Factory / Builder
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
  const joints = [];  // لتخزين Joint Constraints

  // Procedural brushed metal texture generator for realism
  function makeBrushedMetalTexture(colorHex) {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 512;
    const g = c.getContext('2d');
    
    g.fillStyle = '#' + colorHex.toString(16).padStart(6, '0');
    g.fillRect(0, 0, 512, 512);
    
    // Add brushed noise
    for(let i = 0; i < 4000; i++) {
      g.fillStyle = `rgba(255,255,255,${Math.random() * 0.04})`;
      g.fillRect(Math.random() * 512, Math.random() * 512, Math.random() * 60 + 20, 1.5);
      g.fillStyle = `rgba(0,0,0,${Math.random() * 0.05})`;
      g.fillRect(Math.random() * 512, Math.random() * 512, Math.random() * 60 + 20, 1.5);
    }
    
    // Edge highlights (simulating panel gaps)
    g.strokeStyle = 'rgba(0,0,0,0.4)';
    g.lineWidth = 3;
    g.strokeRect(10, 10, 492, 492);
    g.strokeStyle = 'rgba(255,255,255,0.2)';
    g.lineWidth = 2;
    g.strokeRect(12, 12, 488, 488);

    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    return tex;
  }

  // Material builder with texture
  const ms = c => new THREE.MeshStandardMaterial({ 
    color: c, 
    map: makeBrushedMetalTexture(c),
    metalness: 0.75, 
    roughness: 0.35 
  });

  const msPlain = c => new THREE.MeshStandardMaterial({ color: c, metalness: 0.8, roughness: 0.3 });

  // =====================================================================
  // HELPER: إنشاء Hinge Constraint مع حدود الحركة
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

    joints.push({
      bodyA, bodyB, axisA, axisB, limits, constraint
    });
  }

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
  // VISUAL GROUP
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
  // VISUAL MESHES
  // =====================================================================
  // Procedural track texture for realistic movement
  function makeTrackTexture() {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 256;
    const g = c.getContext('2d');
    // Warm dark rubber base instead of pure black
    g.fillStyle = '#3a3632';
    g.fillRect(0, 0, 256, 256);
    // Tread pattern in slightly lighter warm gray
    g.fillStyle = '#4a4540';
    for(let i=0; i<256; i+=32) {
      g.fillRect(0, i, 256, 12);
    }
    // Subtle wear marks
    g.fillStyle = 'rgba(200,180,140,0.06)';
    for(let i=0; i<256; i+=32) {
      g.fillRect(0, i+12, 256, 4);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, 15);
    return tex;
  }

  const matTrack = new THREE.MeshStandardMaterial({ map: makeTrackTexture(), metalness: 0.15, roughness: 0.85 });
  const matChassis = ms(BODY_COLOR);
  const matDeck = new THREE.MeshStandardMaterial({ color: 0x5C6370, metalness: 0.75, roughness: 0.4 }); // Steel deck
  const matAccent = ms(ACCENT_COLOR);
  const matWheel = new THREE.MeshStandardMaterial({ color: 0x4A4640, metalness: 0.5, roughness: 0.65 }); // Warm dark wheel
  const matHub = new THREE.MeshStandardMaterial({ color: 0xB0B8C0, metalness: 0.85, roughness: 0.2 }); // Bright aluminum hub

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
  const trackWheels = []; // لتخزين العجلات وتحريكها لاحقاً

  function makeTrack(side) {
    const g = new THREE.Group();
    const belt = new THREE.Mesh(new THREE.BoxGeometry(TRACK_W, TRACK_H, TRACK_L), matTrack);
    belt.castShadow = true;
    g.add(belt);
    [TRACK_L / 2, -TRACK_L / 2].forEach((z, i) => {
      const geom = new THREE.CylinderGeometry(TRACK_H / 2, TRACK_H / 2, TRACK_W, 20, 1, false, 0, Math.PI);
      geom.rotateZ(Math.PI / 2); // Align correctly
      const cap = new THREE.Mesh(geom, matTrack);
      cap.rotation.y = i === 0 ? Math.PI : 0;
      cap.position.z = z;
      cap.castShadow = true;
      g.add(cap);
    });
    [TRACK_L / 2, 0, -TRACK_L / 2].forEach(z => { // Added a middle wheel for realism
      const wGeom = new THREE.CylinderGeometry(TRACK_H / 2 - 0.005, TRACK_H / 2 - 0.005, TRACK_W + 0.01, 18);
      wGeom.rotateZ(Math.PI / 2); // Geometry aligned to X axis
      const w = new THREE.Mesh(wGeom, matWheel);
      w.position.z = z;
      w.castShadow = true;
      g.add(w);
      
      const hubGeom = new THREE.CylinderGeometry(TRACK_H * 0.26, TRACK_H * 0.26, TRACK_W + 0.03, 10);
      hubGeom.rotateZ(Math.PI / 2);
      const hub = new THREE.Mesh(hubGeom, matHub);

      // إضافة أذرع (Spokes) للعجلة لتصبح حركتها الدائرية واضحة جداً للعين
      const spokeGeom = new THREE.BoxGeometry(TRACK_H * 0.45, TRACK_H * 0.08, TRACK_W + 0.035);
      const spokeMat = msPlain(0x5A5550); // Warm spoke color
      const spoke1 = new THREE.Mesh(spokeGeom, spokeMat);
      const spoke2 = new THREE.Mesh(spokeGeom, spokeMat);
      spoke2.rotation.x = Math.PI / 2;
      hub.add(spoke1);
      hub.add(spoke2);

      hub.position.z = z;
      g.add(hub);

      // Save for animation
      trackWheels.push(w);
      trackWheels.push(hub);
    });

    // إضافة أغطية حماية معدنية فوق المجنزرات (Fenders / Mudguards)
    const fenderGeom = new THREE.BoxGeometry(TRACK_W + 0.06, 0.03, TRACK_L + TRACK_H * 0.8);
    const fender = new THREE.Mesh(fenderGeom, matChassis);
    fender.position.set(0, TRACK_H + 0.015, 0);
    fender.castShadow = true;
    g.add(fender);

    // زوايا مائلة للغطاء لجعله يشبه الدبابات والجرافات الحقيقية
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
    // We rely on the texture mapping for treads now.

    const brakeMat = matBrake.clone();
    const brake = new THREE.Mesh(
      new THREE.BoxGeometry(TRACK_W * 0.7, TRACK_H * 0.5, 0.035),
      brakeMat
    );
    brake.position.set(0, TRACK_H / 2, -(TRACK_L / 2 + TRACK_H / 2 - 0.01));
    g.add(brake);

    // إضافة مصدر ضوء حقيقي (PointLight) ليعطي نورة قوي على الأرض والجسم
    const brakeLight = new THREE.PointLight(0xff0000, 0, 1.5);
    brakeLight.position.set(0, TRACK_H / 2, -(TRACK_L / 2 + TRACK_H / 2 + 0.05));
    g.add(brakeLight);

    brakeLights.push({ mat: brakeMat, light: brakeLight });

    const brakeFrame = new THREE.Mesh(
      new THREE.BoxGeometry(TRACK_W * 0.8, TRACK_H * 0.6, 0.02),
      new THREE.MeshStandardMaterial({ color: 0x3D3836, metalness: 0.4, roughness: 0.5 }) // Warm dark frame
    );
    brakeFrame.position.set(0, TRACK_H / 2, -(TRACK_L / 2 + TRACK_H / 2 - 0.022));
    g.add(brakeFrame);

    g.position.set(side * (BODY_W / 2 + TRACK_W / 2), TRACK_H / 2, 0);
    baseG.add(g);
    return g;
  }

  const trackL = makeTrack(-1);
  const trackR = makeTrack(1);

  // Realistic chamfered look for chassis using multiple boxes
  const chassisM = new THREE.Group();
  const mainChassis = new THREE.Mesh(new THREE.BoxGeometry(BODY_W, BODY_H, BODY_D), matChassis);
  mainChassis.castShadow = true;
  chassisM.add(mainChassis);
  
  // Side panels
  const sidePanelMat = msPlain(0x5C6370); // Steel side panels matching deck
  const sideL = new THREE.Mesh(new THREE.BoxGeometry(0.04, BODY_H * 0.8, BODY_D * 0.9), sidePanelMat);
  sideL.position.set(-BODY_W/2 - 0.01, 0, 0);
  chassisM.add(sideL);
  const sideR = new THREE.Mesh(new THREE.BoxGeometry(0.04, BODY_H * 0.8, BODY_D * 0.9), sidePanelMat);
  sideR.position.set(BODY_W/2 + 0.01, 0, 0);
  chassisM.add(sideR);

  chassisM.position.set(0, TRACK_H + BODY_H / 2, 0);
  baseG.add(chassisM);

  const deckM = new THREE.Mesh(new THREE.BoxGeometry(BODY_W - 0.04, 0.03, BODY_D - 0.06), matDeck);
  deckM.position.set(0, TRACK_H + BODY_H + 0.015, 0);
  baseG.add(deckM);

  const turretBase = new THREE.Mesh(
    new THREE.CylinderGeometry(TURRET_R, TURRET_R + 0.05, TURRET_H, 32),
    matChassis
  );
  turretBase.position.set(0, TRACK_H + BODY_H + TURRET_H / 2, 0);
  turretBase.castShadow = true;
  baseG.add(turretBase);

  // Turret joint detail
  const turretRing = new THREE.Mesh(
    new THREE.TorusGeometry(TURRET_R + 0.01, 0.02, 16, 32),
    msPlain(0x6B7280) // Warm gunmetal ring
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

  [-0.24, 0.24].forEach(x => {
    const light = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.12), matAccent);
    light.position.set(x, TRACK_H + BODY_H + 0.025, BODY_D / 2 - 0.06);
    baseG.add(light);
  });

  // =====================================================================
  // STATUS LIGHT (cobot)
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
  // ARM — SHOULDER (Realistic Cylindrical Shape)
  // =====================================================================
  const a1p = new THREE.Group();
  a1p.position.y = BASE_OFF;
  baseG.add(a1p);

  const a1m = new THREE.Group();
  a1m.position.y = description.arm.shoulder.len / 2;
  
  const shoulderW = description.arm.shoulder.w;
  const shoulderLen = description.arm.shoulder.len;

  // Main arm cylinder
  const a1body = new THREE.Mesh(
    new THREE.CylinderGeometry(shoulderW * 0.6, shoulderW * 0.7, shoulderLen - shoulderW, 32),
    ms(description.arm.shoulder.color)
  );
  a1body.castShadow = true;
  a1m.add(a1body);

  // Bottom joint cylinder (Pivot)
  const a1JointBase = new THREE.Mesh(
    new THREE.CylinderGeometry(shoulderW * 0.6, shoulderW * 0.6, shoulderW * 1.2, 32),
    msPlain(0x6B7280) // Warm gunmetal joint
  );
  a1JointBase.rotation.z = Math.PI / 2;
  a1JointBase.position.y = -shoulderLen / 2;
  a1JointBase.castShadow = true;
  a1m.add(a1JointBase);

  // Side caps for joint
  [1, -1].forEach(dir => {
    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(shoulderW * 0.65, shoulderW * 0.65, 0.04, 32),
      matAccent
    );
    cap.rotation.z = Math.PI / 2;
    cap.position.set(dir * (shoulderW * 0.6 + 0.02), -shoulderLen / 2, 0);
    a1m.add(cap);
  });

  a1p.add(a1m);

  const a1ph = new CANNON.Body({
    type: CANNON.Body.KINEMATIC, mass: description.arm.shoulder.mass,
    material: mBox, allowSleep: false, collisionFilterGroup: ARM_GROUP, collisionFilterMask: ARM_MASK
  });
  a1ph.addShape(new CANNON.Box(new CANNON.Vec3(description.arm.shoulder.physHalfW, description.arm.shoulder.physHalfH, description.arm.shoulder.physHalfD)));
  world.addBody(a1ph);
  kB.push({ mesh: a1m, body: a1ph });

  // =====================================================================
  // ARM — ELBOW (Realistic Cylindrical Shape)
  // =====================================================================
  const a2p = new THREE.Group();
  a2p.position.y = shoulderLen / 2;
  a1m.add(a2p);

  const a2m = new THREE.Group();
  a2m.position.y = description.arm.elbow.physHalfH;

  const elbowW = description.arm.elbow.w;
  const elbowLen = description.arm.elbow.len;

  // Main arm cylinder (tapered)
  const a2body = new THREE.Mesh(
    new THREE.CylinderGeometry(elbowW * 0.5, elbowW * 0.6, elbowLen - elbowW, 32),
    ms(description.arm.elbow.color)
  );
  a2body.castShadow = true;
  a2m.add(a2body);

  // Bottom joint cylinder (Pivot)
  const a2JointBase = new THREE.Mesh(
    new THREE.CylinderGeometry(elbowW * 0.55, elbowW * 0.55, elbowW * 1.1, 32),
    msPlain(0x6B7280) // Warm gunmetal joint
  );
  a2JointBase.rotation.z = Math.PI / 2;
  a2JointBase.position.y = -elbowLen / 2;
  a2JointBase.castShadow = true;
  a2m.add(a2JointBase);

  // Side caps
  [1, -1].forEach(dir => {
    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(elbowW * 0.6, elbowW * 0.6, 0.03, 32),
      matAccent
    );
    cap.rotation.z = Math.PI / 2;
    cap.position.set(dir * (elbowW * 0.55 + 0.015), -elbowLen / 2, 0);
    a2m.add(cap);
  });

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
    msPlain(0xA0A8B0) // Bright brushed steel ring
  );
  wristRing.rotation.x = Math.PI / 2;
  wm.add(wristRing);

  const wristFlange = new THREE.Mesh(
    new THREE.CylinderGeometry(WR * 0.95, WR * 0.8, 0.05, 32),
    msPlain(0x6B7280) // Warm gunmetal flange
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
  // PALM
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

  // Make the palm a more complex engineered shape
  const palmM = new THREE.Group();
  const palmCore = new THREE.Mesh(
    new THREE.BoxGeometry(PW, PHt, PD),
    ms(description.arm.palm.color)
  );
  palmCore.castShadow = true;
  palmM.add(palmCore);
  
  // Decorative side plates
  [1, -1].forEach(dir => {
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(0.02, PHt * 0.8, PD * 1.05),
      matAccent
    );
    plate.position.set(dir * (PW / 2 + 0.01), 0, 0);
    palmM.add(plate);
  });
  
  palmG.add(palmM);

  const gripperMat = msPlain(0x78818C); // Brushed steel gripper
  const knuckleMat = msPlain(0x9CA3AF); // Bright aluminum knuckle

  const gripperBase = new THREE.Mesh(
    new THREE.BoxGeometry(PW * 1.02, PHt * 1.4, PD * 0.8), // إعادة العرض للحجم الطبيعي الأنيق
    gripperMat
  );
  gripperBase.position.y = PHt * 0.5;
  gripperBase.castShadow = true;
  palmG.add(gripperBase);

  // السكة الأساسية التي ينزلق عليها القابض
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
  // FINGERS
  // =====================================================================
  const lG = new THREE.Group();
  lG.position.set(-FOPEN, 0.04, 0);
  palmG.add(lG);

  const rG = new THREE.Group();
  rG.position.set(FOPEN, 0.04, 0);
  palmG.add(rG);

  const fingerMat = msPlain(FCOLOR);
  const padMat = new THREE.MeshStandardMaterial({ color: 0x4A4540, metalness: 0.1, roughness: 0.92 }); // Warm rubber pad
  const jointMat = msPlain(0x8C939A); // Brushed steel joints;

  function makeFinger(grp, dir) {
    const m = new THREE.Group();
    m.position.y = FH / 2;
    grp.add(m);

    // إضافة قضيب الانزلاق (Slider Rod) ليربط الإصبع بالمعصم (القاعدة) دائمًا
    // طول محسوب بدقة لكي لا يبرز من الجهة الأخرى عند الإغلاق الكلي
    const sliderLength = 0.28; 
    const slider = new THREE.Mesh(
      new THREE.BoxGeometry(sliderLength, FH * 0.15, FD * 0.35),
      jointMat
    );
    // توجيه القضيب نحو الداخل (نحو المعصم)
    // dir: -1 لليسار، 1 لليمين. 
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

    // Textured rubber pad for grip realism
    const pad = new THREE.Mesh(new THREE.BoxGeometry(FW * 0.28, FH * 0.7, FD * 0.7), padMat);
    pad.position.set(-dir * (FW * 0.42), FH * 0.05, 0);
    m.add(pad);

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
  // JOINTS (PHYSICS)
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
