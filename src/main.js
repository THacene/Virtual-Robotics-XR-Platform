import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160/build/three.module.js";
import * as CANNON from "https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js";
import { Robot } from './core/Robot.js';
import { RobotListener } from './core/RobotListener.js';
import { PhysicsController } from './core/PhysicsController.js';
import { Robot3D } from './core/Robot3D.js';
import { makeDescription } from './core/defaultDescription.js';
import { FingerSensor } from './sensors/FingerSensor.js';
import { Environment } from './environment/Environment.js';
import { buildFactory, checkFactoryCollision } from './environment/factory.js';
import { updateTelemetry } from './ui/telemetry.js';
import { smartGripUpdate } from './logic/gripLogic.js';
import { log } from './ui/log.js';
import { MultiuserSync } from './core/MultiuserSync.js';
import { RobotVision } from './vision/RobotVision.js';
import { VRControllerManager } from './xr/VRControllerManager.js';
import { VRUI } from './xr/VRUI.js';
import { HandTrackingController } from './xr/HandTrackingController.js';

const BH = 0.25;

// ===== RENDERER =====
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.xr.enabled = true;  // ← WebXR من البداية
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8a9aaa);
scene.fog = new THREE.FogExp2(0x8a9aaa, 0.018);

// ===== CAMERA + XR RIG =====
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 80);
const xrRig = new THREE.Group();
xrRig.position.set(0, 0, 8);  // موقف المستخدم أمام الروبوتات
scene.add(xrRig);
xrRig.add(camera);

// ===== XR STATE (يُعرَّف هنا باش updateCamera يقدر يقرأه) =====
let _xrSess = null;
let _xrCtrlR = null;
let _xrCtrlL = null;
let _vrCtrlMgr = null;
let _vrUI = null;
let _handTracker = null;

const CAM = {
  theta: 0.72, phi: 0.85, radius: 10,
  target: new THREE.Vector3(0, 1.5, 0),
  dragging: false, lastX: 0, lastY: 0,
  autoOrbit: true, autoSpeed: 0.0003,
  idleTimer: 0, thetaL: 0.72, phiL: 0.85, radiusL: 10
};

const cvs = renderer.domElement;
cvs.addEventListener('pointerdown', e => {
  if (e.clientX < 180 || e.clientX > innerWidth - 180) return;
  CAM.dragging = true; CAM.lastX = e.clientX; CAM.lastY = e.clientY;
  CAM.idleTimer = 0; CAM.autoOrbit = false;
  cvs.setPointerCapture(e.pointerId);
});
cvs.addEventListener('pointermove', e => {
  if (!CAM.dragging) return;
  CAM.theta -= (e.clientX - CAM.lastX) * 0.005;
  CAM.phi = Math.max(0.2, Math.min(1.5, CAM.phi - (e.clientY - CAM.lastY) * 0.005));
  CAM.lastX = e.clientX; CAM.lastY = e.clientY;
});
cvs.addEventListener('pointerup', () => CAM.dragging = false);
cvs.addEventListener('wheel', e => {
  e.preventDefault();
  CAM.radius = Math.max(4, Math.min(22, CAM.radius + e.deltaY * 0.01));
  CAM.idleTimer = 0; CAM.autoOrbit = false;
}, { passive: false });
cvs.addEventListener('dblclick', () => {
  CAM.theta = 0.72; CAM.phi = 0.85; CAM.radius = 10; CAM.autoOrbit = true;
});

function updateCamera() {
  if (_xrSess) return;  // ← القلب: لا تتدخل في الكاميرا داخل XR
  if (!CAM.dragging) { CAM.idleTimer++; if (CAM.idleTimer > 180) CAM.autoOrbit = true; }
  if (CAM.autoOrbit && !CAM.dragging) CAM.theta += CAM.autoSpeed;
  CAM.thetaL += (CAM.theta - CAM.thetaL) * 0.18;
  CAM.phiL += (CAM.phi - CAM.phiL) * 0.18;
  CAM.radiusL += (CAM.radius - CAM.radiusL) * 0.18;
  const r = CAM.radiusL;
  camera.position.set(
    CAM.target.x + r * Math.sin(CAM.phiL) * Math.sin(CAM.thetaL),
    CAM.target.y + r * Math.cos(CAM.phiL),
    CAM.target.z + r * Math.sin(CAM.phiL) * Math.cos(CAM.thetaL)
  );
  camera.lookAt(CAM.target);
}

// ===== LIGHTING (Factory Indoor) =====
scene.add(new THREE.AmbientLight(0xfff8f0, 2.0));
const sun = new THREE.DirectionalLight(0xfff0d8, 2.8);
sun.position.set(5, 14, 7); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -18; sun.shadow.camera.right = 18;
sun.shadow.camera.top = 18; sun.shadow.camera.bottom = -18;
sun.shadow.bias = -0.001;
scene.add(sun);
const pl1 = new THREE.PointLight(0xffd8a0, 1.5, 25); pl1.position.set(-6, 8, -6); scene.add(pl1);
const pl2 = new THREE.PointLight(0xfff0c8, 1.2, 20); pl2.position.set(6, 8, 6); scene.add(pl2);
const pl3 = new THREE.PointLight(0xffe8b0, 1.0, 20); pl3.position.set(0, 10, 0); scene.add(pl3);

// ===== PHYSICS =====
const world = new CANNON.World();
world.gravity.set(0, -9.81, 0);
world.solver.iterations = 20; world.solver.tolerance = 0.001;
world.broadphase = new CANNON.SAPBroadphase(world);
world.allowSleep = true;

const mFing = new CANNON.Material("f");
const mBox = new CANNON.Material("b");
const mGnd = new CANNON.Material("g");
const mWheel = new CANNON.Material("w");

world.addContactMaterial(new CANNON.ContactMaterial(mFing, mBox, {
  friction: 15, restitution: 0,
  contactEquationStiffness: 5e4, contactEquationRelaxation: 8,
  frictionEquationStiffness: 1e6, frictionEquationRelaxation: 8
}));
world.addContactMaterial(new CANNON.ContactMaterial(mGnd, mBox, { friction: 0.8, restitution: 0.1 }));
world.addContactMaterial(new CANNON.ContactMaterial(mWheel, mGnd, {
  friction: 0.8, restitution: 0.0,
  contactEquationStiffness: 1e6, contactEquationRelaxation: 3
}));

const gB = new CANNON.Body({ mass: 0, material: mGnd, collisionFilterGroup: 1, collisionFilterMask: -1 });
gB.addShape(new CANNON.Plane());
gB.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
world.addBody(gB);

// ===== PLAYER PHYSICS (VR Head + Hands) =====
const mPlayer = new CANNON.Material('player');
world.addContactMaterial(new CANNON.ContactMaterial(mPlayer, mBox, {
  friction: 0.4, restitution: 0.1,
  contactEquationStiffness: 1e5, contactEquationRelaxation: 4
}));
world.addContactMaterial(new CANNON.ContactMaterial(mPlayer, mGnd, {
  friction: 0.5, restitution: 0.0
}));

function makeKinematicSphere(radius) {
  const b = new CANNON.Body({
    mass: 0,
    type: CANNON.Body.KINEMATIC,
    material: mPlayer,
    collisionFilterGroup: 2,
    collisionFilterMask: -1,
  });
  b.addShape(new CANNON.Sphere(radius));
  b.position.set(0, -10, 0); // start underground so it doesn't interfere before XR
  return b;
}

const playerHeadBody  = makeKinematicSphere(0.15);
const playerHandLBody = makeKinematicSphere(0.08);
const playerHandRBody = makeKinematicSphere(0.08);
let _playerBodiesInWorld = false;

function addPlayerBodiesToWorld() {
  if (_playerBodiesInWorld) return;
  world.addBody(playerHeadBody);
  world.addBody(playerHandLBody);
  world.addBody(playerHandRBody);
  _playerBodiesInWorld = true;
}

function removePlayerBodiesFromWorld() {
  if (!_playerBodiesInWorld) return;
  world.removeBody(playerHeadBody);
  world.removeBody(playerHandLBody);
  world.removeBody(playerHandRBody);
  _playerBodiesInWorld = false;
  // Reset positions underground
  playerHeadBody.position.set(0, -10, 0);
  playerHandLBody.position.set(0, -10, 0);
  playerHandRBody.position.set(0, -10, 0);
}

const _tmpVec3 = new THREE.Vector3();

function syncPlayerPhysics() {
  if (!_xrSess || !_playerBodiesInWorld) return;

  // Head → camera world position
  camera.getWorldPosition(_tmpVec3);
  playerHeadBody.position.set(_tmpVec3.x, _tmpVec3.y, _tmpVec3.z);
  playerHeadBody.velocity.set(0, 0, 0);

  // Right controller / hand
  if (_vrCtrlMgr && _vrCtrlMgr.ctrlR) {
    _vrCtrlMgr.ctrlR.getWorldPosition(_tmpVec3);
    playerHandRBody.position.set(_tmpVec3.x, _tmpVec3.y, _tmpVec3.z);
    playerHandRBody.velocity.set(0, 0, 0);
  } else {
    playerHandRBody.position.set(0, -10, 0);
  }

  // Left controller / hand
  if (_vrCtrlMgr && _vrCtrlMgr.ctrlL) {
    _vrCtrlMgr.ctrlL.getWorldPosition(_tmpVec3);
    playerHandLBody.position.set(_tmpVec3.x, _tmpVec3.y, _tmpVec3.z);
    playerHandLBody.velocity.set(0, 0, 0);
  } else {
    playerHandLBody.position.set(0, -10, 0);
  }
}

// ===== FACTORY ENVIRONMENT =====
const factoryGroup = buildFactory(scene, world, mGnd);

// ===== CARTON BOX TEXTURE (carton brun + numéro) =====
function makeCartonTexture(num) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  // خلفية كرتونية بنّية
  g.fillStyle = '#c8964b';
  g.fillRect(0, 0, 256, 256);
  // تدرّج خفيف لإحساس الكرتون
  const grad = g.createLinearGradient(0, 0, 256, 256);
  grad.addColorStop(0, 'rgba(255,255,255,0.10)');
  grad.addColorStop(0.5, 'rgba(0,0,0,0.04)');
  grad.addColorStop(1, 'rgba(80,50,20,0.18)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  // إطار حافة الصندوق
  g.strokeStyle = '#8a6531';
  g.lineWidth = 10;
  g.strokeRect(5, 5, 246, 246);
  // شريط لاصق في المنتصف (شكل صندوق مقفل)
  g.fillStyle = 'rgba(180,140,80,0.6)';
  g.fillRect(0, 112, 256, 32);
  g.strokeStyle = 'rgba(120,85,40,0.6)';
  g.lineWidth = 2;
  g.strokeRect(0, 112, 256, 32);
  // الرقم
  g.fillStyle = '#3a2a12';
  g.font = 'bold 130px Arial';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(num), 128, 138);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

// ===== TARGET BOXES (20 صندوق فيزيائي موزّعة في المصنع) =====
const BOX_DEFS = [
  // منطقة العمل المركزية (قرب الروبوتات)
  { id: 1, x: 3.5, z: 0 },
  { id: 2, x: 4.0, z: -2.2 },
  { id: 3, x: 2.6, z: 2.4 },
  { id: 4, x: -3.0, z: 1.5 },
  { id: 5, x: -1.5, z: -3.0 },
  // قرب حزام النقل الأيمن
  { id: 6, x: 7.5, z: 11.0 },
  { id: 7, x: 9.0, z: 12.5 },
  { id: 8, x: 10.5, z: 11.5 },
  // قرب حزام النقل الأيسر
  { id: 9, x: -7.0, z: -13.0 },
  { id: 10, x: -9.5, z: -14.5 },
  // قرب الطبليات الخشبية
  { id: 11, x: 11.5, z: -3.5 },
  { id: 12, x: 12.5, z: -2.0 },
  { id: 13, x: -9.5, z: 10.5 },
  // ممرات المصنع
  { id: 14, x: 6.0, z: -7.0 },
  { id: 15, x: -6.0, z: 7.0 },
  { id: 16, x: 8.0, z: 5.0 },
  // قرب الرفوف
  { id: 17, x: 15.0, z: -6.0 },
  { id: 18, x: -15.0, z: 3.0 },
  // بالقرب من الأعمدة
  { id: 19, x: 10.0, z: -10.0 },
  { id: 20, x: -10.0, z: -10.0 },
];

const boxes = BOX_DEFS.map(def => {
  const body = new CANNON.Body({
    mass: 0.8, material: mBox,
    linearDamping: 0.90, angularDamping: 0.98, allowSleep: false,
    collisionFilterGroup: 1, collisionFilterMask: -1
  });
  body.addShape(new CANNON.Box(new CANNON.Vec3(BH, BH, BH)));
  body.position.set(def.x, BH, def.z);
  body.aabbNeedsUpdate = true;
  body.__boxId = def.id;   // ← id الصندوق = رقمه
  world.addBody(body);

  const tex = makeCartonTexture(def.id);
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0.0 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(BH * 2, BH * 2, BH * 2), mat);
  mesh.castShadow = true;
  mesh.userData.boxId = def.id;
  scene.add(mesh);

  return { id: def.id, body, mesh };
});

// ✅ الصندوق الهدف الحالي — يبدأ بالصندوق رقم 1.
// boxPhys/boxMesh يشيران دائماً للصندوق المُستهدَف حالياً حتى يبقى منطق الإمساك كما هو.
let targetBoxId = boxes[0].id;
let boxPhys = boxes[0].body;
let boxMesh = boxes[0].mesh;

function getBoxById(id) {
  return boxes.find(b => b.id === id) ?? null;
}

function setTargetBox(id) {
  const b = getBoxById(id);
  if (!b) { console.warn('[Box] id not found:', id); return false; }
  targetBoxId = id;
  boxPhys = b.body;
  boxMesh = b.mesh;
  if (typeof physicsCtrl !== 'undefined' && physicsCtrl) physicsCtrl.body = b.body;
  if (window.__vision) window.__vision.setActiveBoxId?.(id);
  return true;
}
window.setTargetBox = setTargetBox;
window.__boxes = boxes;


// ===== ROBOTS =====
const ctx = { world, scene, materials: { mBox, mFing, mGnd } };

const robot1 = new Robot3D(makeDescription(), ctx);
robot1.setPosition(0, 0);

const robot2 = new Robot3D(makeDescription({
  arm: {
    shoulder: { color: 0xCC2936 },  // ABB-style industrial red
    elbow: { color: 0xB52430 },     // Deeper red
    palm: { color: 0x78818C },      // Brushed steel
  },
  base: {
    body: { color: 0x5C6370 },      // Steel chassis
    accentColor: 0xCC2936,           // Red accent
  },
  finger: { color: 0xA0A8B0 },      // Aluminum
  movement: { speed: 1.5 }
}), ctx);

robot2.setPosition(-4, -2);

const robot3 = new Robot3D(makeDescription({
  type: 'cobot',
  arm: {
    shoulder: { color: 0xE8B931 },  // Fanuc-style industrial yellow
    elbow: { color: 0xD4A72C },    // Deeper yellow
    palm: { color: 0x78818C },     // Brushed steel
  },
  base: {
    body: { color: 0x5C6370 },     // Steel chassis
    accentColor: 0xD4A72C,          // Yellow accent
  },
  finger: { color: 0xA0A8B0 },     // Aluminum
  movement: { speed: 1.2 }
}), ctx);
robot3.setPosition(-2, 3);


const cobot = new Robot3D(makeDescription({ type: 'cobot' }), ctx);
cobot.setPosition(5, 2);

const robots = [robot1, robot2, robot3, cobot];

let activeIdx = 0;
const getActive = () => robots[activeIdx];


// ===== KEYBOARD =====
const moveKeys = {};
document.addEventListener('keydown', e => {
  moveKeys[e.code] = true;
  // V key = toggle VR UI panel (works during XR for emulator testing)
  if (e.code === 'KeyV' && _vrUI) { _vrUI.toggle(); }
});
document.addEventListener('keyup', e => { moveKeys[e.code] = false; });

document.addEventListener('keydown', e => {
  if (e.code !== 'Tab') return;
  e.preventDefault();
  if (muMode) {
    // ── Toggle robot picker popup ──
    toggleRobotPicker();
    return;
  }
  // ✅ لا نفرج عن الصندوق عند التبديل — الروبوت السابق سيستمر بالإمساك
  // فقط أوقف حركة الروبوت السابق
  const prev = getActive(); prev.setDrive(0, 0);
  // إذا لم يكن هناك إمساك، أوقف الضغط أيضاً
  if (!grabbed) prev.setSqueeze(0);
  activeIdx = (activeIdx + 1) % robots.length;
  updateActiveBadge();
  robotApi.setRobot3D(getActive());
  syncSlidersToActive();
});

// ===== ROBOT PICKER POPUP =====
const _rpOverlay = document.getElementById('robotPickerOverlay');
const _rpBody    = document.getElementById('robotPickerBody');
let _rpOpen = false;

// Robot metadata for display
const ROBOT_META = [
  { name: 'Robot 1', type: 'Standard Arm',   color: '#4488BB' },
  { name: 'Robot 2', type: 'ABB Industrial',  color: '#CC2936' },
  { name: 'Robot 3', type: 'Fanuc Cobot',     color: '#E8B931' },
  { name: 'Robot 4', type: 'Cobot',           color: '#44BBAA' },
];

function openRobotPicker() {
  if (_rpOpen) return;
  _rpOpen = true;
  populateRobotPicker();
  _rpOverlay.classList.add('visible');
}

function closeRobotPicker() {
  if (!_rpOpen) return;
  _rpOpen = false;
  _rpOverlay.classList.remove('visible');
}

function toggleRobotPicker() {
  if (_rpOpen) closeRobotPicker();
  else openRobotPicker();
}

function populateRobotPicker() {
  _rpBody.innerHTML = '';
  const statuses = multiuser ? multiuser.getRobotStatuses() : [];

  for (let i = 0; i < robots.length; i++) {
    const meta = ROBOT_META[i] || { name: `Robot ${i + 1}`, type: 'Unknown', color: '#888' };
    const st   = statuses[i] || { index: i, isFree: true, isYours: i === activeIdx, ownerClientId: null };

    const item = document.createElement('div');
    item.className = 'rp-item';

    // Status class
    let statusText, statusClass;
    if (st.isYours) {
      item.classList.add('rp-current');
      statusText = '● YOURS';
      statusClass = 'yours';
    } else if (st.isFree) {
      statusText = '◎ FREE';
      statusClass = 'free';
    } else {
      item.classList.add('rp-locked');
      statusText = '🔒 IN USE';
      statusClass = 'locked';
    }

    item.innerHTML = `
      <div class="rp-color-dot" style="background:${meta.color};"></div>
      <div class="rp-info">
        <div class="rp-name">${meta.name}</div>
        <div class="rp-type">${meta.type}</div>
      </div>
      <span class="rp-status ${statusClass}">${statusText}</span>
      <span class="rp-key-hint">[${i + 1}]</span>
    `;

    // Click handler for free robots
    if (st.isFree && !st.isYours) {
      item.addEventListener('click', () => {
        claimAndSwitch(i);
      });
    }

    _rpBody.appendChild(item);
  }
}

function claimAndSwitch(idx) {
  if (!multiuser) return;
  const ok = multiuser.claimRobot(idx);
  if (ok) {
    closeRobotPicker();
  }
}

// Close on ESC
document.addEventListener('keydown', e => {
  if (e.code === 'Escape' && _rpOpen) {
    e.preventDefault();
    closeRobotPicker();
  }
  // Number keys 1-4 to quick-select in picker
  if (_rpOpen && e.code.startsWith('Digit')) {
    const num = parseInt(e.code.replace('Digit', ''));
    if (num >= 1 && num <= robots.length) {
      e.preventDefault();
      const statuses = multiuser ? multiuser.getRobotStatuses() : [];
      const st = statuses[num - 1];
      if (st && st.isFree && !st.isYours) {
        claimAndSwitch(num - 1);
      }
    }
  }
});

// Close when clicking overlay background
if (_rpOverlay) {
  _rpOverlay.addEventListener('click', e => {
    if (e.target === _rpOverlay) closeRobotPicker();
  });
}

function syncSlidersToActive() {
  const a = getActive();
  const set = (sid, vid, val, unit) => {
    const s = document.getElementById(sid); const v = document.getElementById(vid);
    if (s) s.value = Math.round(val); if (v) v.textContent = Math.round(val) + unit;
  };
  set('sBase', 'vBase', a.jCurrent.base, '°');
  set('sA1', 'vA1', a.jCurrent.shoulder, '°');
  set('sA2', 'vA2', a.jCurrent.elbow, '°');
  set('sW', 'vW', a.jCurrent.wrist, '°');
  const sOpen = document.getElementById('sOpen');
  if (sOpen) {
    sOpen.value = Math.round((a.FOPEN / 0.38) * 100);
    document.getElementById('vOpen').textContent = sOpen.value + 'mm';
    // Sync squeeze based on Max Open value
    const normalized = (55 - sOpen.value) / (55 - 14);
    const squeezeFinal = Math.max(0, Math.min(1, normalized));
    a.setSqueeze(squeezeFinal);
  }

}

function applyKeyboardToActive() {
  if (_xrSess) return;  // Thumbstick يتولى في XR
  const active = getActive(); const m = active.description.movement;
  let s = 0, t = 0;
  if (moveKeys['ArrowUp'] || moveKeys['KeyW']) s = m.speed;
  if (moveKeys['ArrowDown'] || moveKeys['KeyS']) s = -m.speed;
  if (moveKeys['ArrowLeft'] || moveKeys['KeyA']) t = m.turn;
  if (moveKeys['ArrowRight'] || moveKeys['KeyD']) t = -m.turn;
  if (robotApi?.listener?.controlsDrive && s === 0 && t === 0) {
    for (const r of robots) if (r !== active) r.setDrive(0, 0);
    return;
  }
  active.setDrive(s, t);
  for (const r of robots) if (r !== active) r.setDrive(0, 0);
}

function applyThumbstickToActive() {
  if (!_xrSess) return;
  if (_vrCtrlMgr) return;  // VRControllerManager handles XR input
  const gamepads = navigator.getGamepads ? [...navigator.getGamepads()] : [];
  const gp = gamepads.find(g => g && g.axes.length >= 4);
  if (!gp) return;
  const lx = gp.axes[2] ?? 0;
  const ly = gp.axes[3] ?? 0;
  const dead = 0.15;
  const active = getActive(); const m = active.description.movement;
  active.setDrive(Math.abs(ly) > dead ? -ly * m.speed : 0, Math.abs(lx) > dead ? -lx * m.turn : 0);
  for (const r of robots) if (r !== active) r.setDrive(0, 0);
}

// ===== GRIP =====
let grabbed = false, gripHoldTime = 0, gripAvailableForce = 0, gripRequiredForce = 0;
let holdingRobotIdx = 0;  // ✅ تتبع أي روبوت يمسك الصندوق
const gripOffsetPos = new THREE.Vector3();
const gripOffsetQuat = new THREE.Quaternion();

function getFingerGap() {
  return Math.max(0, (getActive().parts.fingers.right.group.position.x - getActive().FW / 2) * 2);
}

function isBoxBetweenFingers(api) {
  const perceived = api?.getPerceivedObject('box');
  if (!perceived) return false;
  const palmG = getActive().parts.palm.group;
  const boxWP = new THREE.Vector3(perceived.x, perceived.y, perceived.z);
  const palmWP = new THREE.Vector3(); const palmWQ = new THREE.Quaternion();
  palmG.getWorldPosition(palmWP); palmG.getWorldQuaternion(palmWQ);
  const localBox = boxWP.clone().sub(palmWP).applyQuaternion(palmWQ.clone().invert());
  const fingerX = getActive().parts.fingers.right.group.position.x;
  const innerX = fingerX - getActive().FW / 2;
  return (
    Math.abs(localBox.x) < (innerX + BH + 0.005) &&
    Math.abs(localBox.y) < (getActive().FH / 2 + BH + 0.02) &&
    Math.abs(localBox.z) < (getActive().FD / 2 + BH + 0.01) &&
    getFingerGap() < (BH * 2 + 0.01)
  );
}

function saveGripOffset(contactData = null) {
  const palmG = getActive().parts.palm.group;
  const palmWP = new THREE.Vector3(); const palmWQ = new THREE.Quaternion();
  palmG.getWorldPosition(palmWP); palmG.getWorldQuaternion(palmWQ);
  const boxWP = new THREE.Vector3(boxPhys.position.x, boxPhys.position.y, boxPhys.position.z);
  const boxWQ = new THREE.Quaternion(boxPhys.quaternion.x, boxPhys.quaternion.y, boxPhys.quaternion.z, boxPhys.quaternion.w);
  const palmWQInv = palmWQ.clone().invert();
  let gripRefPoint = palmWP.clone();
  if (contactData?.leftPoint && contactData?.rightPoint) {
    const FH = getActive().FH;
    const hMap = { tip: FH - 0.05, middle: FH / 2, base: 0.1 };
    const lp = new THREE.Vector3(0, hMap[contactData.leftPoint] || FH / 2, 0);
    const rp = new THREE.Vector3(0, hMap[contactData.rightPoint] || FH / 2, 0);
    getActive().parts.fingers.left.group.children[0].localToWorld(lp);
    getActive().parts.fingers.right.group.children[0].localToWorld(rp);
    gripRefPoint = lp.clone().add(rp).multiplyScalar(0.5);
  }
  gripOffsetPos.copy(boxWP).sub(gripRefPoint).applyQuaternion(palmWQInv);
  gripOffsetQuat.copy(palmWQInv).multiply(boxWQ);
}

function applyGripOffset() {
  // ✅ استخدام الروبوت الذي يمسك الصندوق وليس الروبوت النشط
  const holdingRobot = robots[holdingRobotIdx];
  const palmG = holdingRobot.parts.palm.group;
  const palmWP = new THREE.Vector3(); const palmWQ = new THREE.Quaternion();
  palmG.getWorldPosition(palmWP); palmG.getWorldQuaternion(palmWQ);
  const targetPos = palmWP.clone().add(gripOffsetPos.clone().applyQuaternion(palmWQ));
  const targetQuat = palmWQ.clone().multiply(gripOffsetQuat);
  boxPhys.position.set(targetPos.x, targetPos.y, targetPos.z);
  boxPhys.quaternion.set(targetQuat.x, targetQuat.y, targetQuat.z, targetQuat.w);
  boxPhys.linearDamping = 0.99; boxPhys.angularDamping = 0.995;
  boxPhys.angularVelocity.set(0, 0, 0); boxPhys.aabbNeedsUpdate = true;
  physicsCtrl.clampFloor(BH);
}

function actuateGrab() {
  if (grabbed) return;
  saveGripOffset(); physicsCtrl.freeze();
  grabbed = true; holdingRobotIdx = activeIdx;  // ✅ حفظ أي روبوت يمسك الصندوق
  getActive().setSqueeze(1.0);
  const gd = listener.getGripData();
  if (gd?.boxMass) {
    const r = getActive();
    if (r.loadedBoxPosition) r.setLoadedBox(gd.boxMass, r.loadedBoxPosition);
    else r.loadedMass = gd.boxMass;
  }
}

function actuateRelease() {
  if (!grabbed) return;
  grabbed = false; physicsCtrl.release();
  getActive().setSqueeze(0);
  robots[holdingRobotIdx].setLoadedBox(0, null);  // ✅ مسح حمل الروبوت الذي كان يمسك
  holdingRobotIdx = 0;
}

// ===== UI BINDINGS =====
function bind(sid, vid, fn) {
  const el = document.getElementById(sid); const vl = document.getElementById(vid);
  if (!el || !vl) return;
  el.oninput = e => { const v = +e.target.value; vl.textContent = Math.round(v) + (sid.includes('Open') ? 'mm' : '°'); fn(v); };
}
bind('sBase', 'vBase', v => getActive().moveJoint('base', v));
bind('sA1', 'vA1', v => getActive().moveJoint('shoulder', v));
bind('sA2', 'vA2', v => getActive().moveJoint('elbow', v));
bind('sW', 'vW', v => getActive().moveJoint('wrist', v));

const sOpen = document.getElementById('sOpen');
if (sOpen) sOpen.oninput = function () {
  getActive().setOpen(+this.value / 100);
  document.getElementById('vOpen').textContent = this.value + 'mm';
  // Inverse squeeze: when open=max, squeeze=0; when open=min, squeeze=1
  const normalized = (55 - this.value) / (55 - 14);
  getActive().setSqueeze(Math.max(0, Math.min(1, normalized)));
};


// ===== SENSORS / ENV =====
const physicsCtrl = new PhysicsController(boxPhys);
let muMode = false;
let multiuser = null;

const robotApi = new Robot("r1", {
  grab: actuateGrab, release: actuateRelease,
  saveGripOffset: (d) => saveGripOffset(d),
  moveArm: (arm, deg) => { if (['base', 'shoulder', 'elbow', 'wrist'].includes(arm)) getActive().moveJoint(arm, deg); }
});

const env = new Environment(robotApi, physicsCtrl, robots);
const listener = new RobotListener(robotApi, log);
robotApi.setListener(listener);
robotApi.setRobot3D(robot1);

const allFingerSensors = robots.map(r => ({
  left: new FingerSensor('left', r.parts.fingers.left.group.children[0], r.parts.fingers.left.body, r.description, { robot: robotApi, logger: log }),
  right: new FingerSensor('right', r.parts.fingers.right.group.children[0], r.parts.fingers.right.body, r.description, { robot: robotApi, logger: log }),
}));
const getActiveSensors = () => allFingerSensors[activeIdx];
const fingerSensors = new Proxy({}, { get(_, k) { return getActiveSensors()[k]; } });

// ===== MULTIUSER SYNC INIT =====
multiuser = new MultiuserSync(robots, physicsCtrl);
multiuser.onReady = (robotIdx) => {
  muMode = true;
  activeIdx = robotIdx;
  const active = getActive();
  active.setDrive(0, 0);
  active.setSqueeze(0);
  robotApi.setRobot3D(active);
  syncSlidersToActive();
  updateActiveBadge();
  log(`🌐 Multi-user: controlling Robot ${robotIdx + 1}`, 'ok');
};
multiuser.connect();

// ===== UI ELEMENTS (بعد كل التعريفات) =====
const activeBadge = document.createElement('div');
activeBadge.style.cssText = `position:fixed;top:14px;left:50%;transform:translateX(-50%);
  background:rgba(0,0,0,0.6);color:#fff;font:14px/1.4 monospace;
  padding:8px 16px;border-radius:8px;pointer-events:none;z-index:999;
  letter-spacing:.04em;border:2px solid #00ff88;`;
document.body.appendChild(activeBadge);

function updateActiveBadge() {
  if (muMode) {
    let others = [];
    if (multiuser && multiuser.owners) {
      for (const [ri, cid] of multiuser.owners.entries()) {
        if (ri !== activeIdx && cid) others.push(ri + 1);
      }
    }
    const oStr = others.length ? ` <span style="opacity:.6; margin-left:8px; border-left: 1px solid #555; padding-left: 8px;">🔒 In use: ${others.join(',')}</span>` : '';
    activeBadge.innerHTML = `🌐 <b>Robot ${activeIdx + 1}</b> <span style="color:#00ff88">● YOURS</span> &nbsp;·&nbsp; <span style="opacity:.7">Tab to switch</span>${oStr}`;
  } else {
    activeBadge.innerHTML = `🎮 Controlling: <b>Robot ${activeIdx + 1}</b> &nbsp;·&nbsp; <span style="opacity:.7">Tab / Squeeze L to switch</span>`;
  }
}
updateActiveBadge();

const hintDiv = document.createElement('div');
hintDiv.style.cssText = `position:fixed;bottom:16px;left:50%;transform:translateX(-50%);
  background:rgba(0,0,0,0.55);color:#fff;font:13px/1.6 monospace;
  padding:8px 18px;border-radius:8px;pointer-events:none;z-index:999;text-align:center;`;
hintDiv.innerHTML = '🕹 <b>W A S D</b> move &nbsp;·&nbsp; <b>Tab</b> switch &nbsp;·&nbsp; VR: <b>Thumbstick L</b> move · <b>Trigger R</b> grab · <b>Squeeze L</b> switch';
document.body.appendChild(hintDiv);
setTimeout(() => hintDiv.style.transition = 'opacity 1s', 5000);
setTimeout(() => hintDiv.style.opacity = '0', 6000);

// ===== XR UI HELPERS =====
const _xrLeft = document.getElementById('left');
const _xrRight = document.getElementById('right');

function xrHideUI() {
  if (_xrLeft) _xrLeft.style.display = 'none';
  if (_xrRight) _xrRight.style.display = 'none';
  activeBadge.style.display = 'none';
  hintDiv.style.display = 'none';
}
function xrShowUI() {
  if (_xrLeft) _xrLeft.style.display = '';
  if (_xrRight) _xrRight.style.display = '';
  activeBadge.style.display = '';
  hintDiv.style.display = '';
}

const _xrExit = document.createElement('button');
_xrExit.textContent = '✕ EXIT XR';
_xrExit.style.cssText = "position:fixed;top:14px;right:14px;z-index:10000;padding:9px 22px;background:#cc2200;color:#fff;border:none;border-radius:4px;font-family:'Teko',sans-serif;font-size:17px;letter-spacing:3px;cursor:pointer;display:none;";
document.body.appendChild(_xrExit);
_xrExit.addEventListener('click', () => _xrSess?.end());

// ===== MAIN LOOP =====
let _lastTime = performance.now();

renderer.setAnimationLoop(function mainLoop() {
  const now = performance.now();
  const dt = Math.min((now - _lastTime) / 1000, 0.05);
  _lastTime = now;

  applyKeyboardToActive();
  applyThumbstickToActive();

  // ── VR XR Systems update ──
  if (_vrCtrlMgr) _vrCtrlMgr.update(dt);
  if (_handTracker) _handTracker.update(dt);
  if (_vrUI) {
    const xrRay = _vrCtrlMgr ? _vrCtrlMgr.getRay('right') : null;
    const xrTrigger = _vrCtrlMgr?.srcR?.gamepad?.buttons[0]?.pressed ?? false;

    // Read stats from DOM (populated by telemetry.js)
    const statsData = {
      boxX: document.getElementById('tBoxX')?.textContent || '—',
      boxY: document.getElementById('tBoxY')?.textContent || '—',
      boxZ: document.getElementById('tBoxZ')?.textContent || '—',
      boxDist: document.getElementById('tBoxDist')?.textContent || '—',
      tcpX: document.getElementById('tTcpX')?.textContent || '—',
      tcpY: document.getElementById('tTcpY')?.textContent || '—',
      tcpZ: document.getElementById('tTcpZ')?.textContent || '—',
      force: document.getElementById('tForceVal')?.textContent || '0%',
      lTip: document.getElementById('tLTip')?.textContent || 'OFF',
      lMid: document.getElementById('tLMid')?.textContent || 'OFF',
      lBase: document.getElementById('tLBase')?.textContent || 'OFF',
      rTip: document.getElementById('tRTip')?.textContent || 'OFF',
      rMid: document.getElementById('tRMid')?.textContent || 'OFF',
      rBase: document.getElementById('tRBase')?.textContent || 'OFF',
      robots: multiuser ? multiuser.getRobotStatuses() : [],
      visionCanvas: document.getElementById('camCanvas'),
    };
    
    // Force camera rendering if VRUI is displaying it
    if (typeof vision !== 'undefined' && vision) {
      vision.forceRender = (_vrUI._view === 'camera');
    }

    _vrUI.update(dt, xrRay, xrTrigger, statsData);
  }

  // ── Sync player physics bodies (head + hands) to XR positions ──
  syncPlayerPhysics();

  let active = getActive();
  let activeStatus = { selfBlocked: null, floorBlocked: false, robotBlocked: false };

  for (const r of robots) { const s = r.update(dt); if (r === active) activeStatus = s; }

  window.__robotCollision = false;
  for (let pass = 0; pass < 3; pass++) {
    let hit = false;
    for (let i = 0; i < robots.length; i++) {
      // تصادم مع البيئة
      if (checkFactoryCollision(robots[i])) {
        robots[i].revertToSnapshot();
        if (robots[i] === active) {
          activeStatus.robotBlocked = true;
          window.__robotCollision = true;
        }
        hit = true;
      }

      // تصادم بين الروبوتات
      for (let j = i + 1; j < robots.length; j++) {
        if (robots[i].collidesWith(robots[j])) {
          const sh = window.__handoff;
          if (sh?.suppressCollision &&
            robots.length >= 2 &&
            ((robots[i] === robots[0] && robots[j] === robots[1]) ||
              (robots[i] === robots[1] && robots[j] === robots[0]))) {
            continue;
          }
          robots[i].revertToSnapshot(); robots[j].revertToSnapshot();
          if (robots[i] === active || robots[j] === active) {
            activeStatus.robotBlocked = true;
            window.__robotCollision = true;
          }
          hit = true;
        }
      }
    }
    if (!hit) break;
  }

  const sv = (id, v) => { const e = document.getElementById(id); if (e) e.value = Math.round(v); };
  const lv = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = Math.round(v) + '°'; };
  sv('sBase', active.jCurrent.base); lv('vBase', active.jCurrent.base);
  sv('sA1', active.jCurrent.shoulder); lv('vA1', active.jCurrent.shoulder);
  sv('sA2', active.jCurrent.elbow); lv('vA2', active.jCurrent.elbow);
  sv('sW', active.jCurrent.wrist); lv('vW', active.jCurrent.wrist);

  const isRemoteGrab = muMode && multiuser.isRemoteGrabbed();
  if (isRemoteGrab) {
    multiuser.applyRemoteBox();
    world.step(1 / 60, dt, 6);
    multiuser.applyRemoteBox();
  } else {
    if (grabbed) physicsCtrl.freeze(); else physicsCtrl.release();
    world.step(1 / 60, dt, 6);
    if (grabbed) applyGripOffset();
  }
  env.update();

  for (const set of allFingerSensors)
    for (const sensor of Object.values(set)) sensor.update(dt, 'box');

  {
    const S = getActiveSensors(); const L = S.left.getState(), R = S.right.getState();
    const avg = (L.touchForce + R.touchForce) / 2;
    const ptL = L.activePoint ? `[${L.activePoint}]` : ''; const ptR = R.activePoint ? `[${R.activePoint}]` : '';
    const eL = document.getElementById('indL'); const eR = document.getElementById('indR'); const eB = document.getElementById('indB');
    if (eL) { eL.textContent = `L: ${L.isTouching ? 'ON ' + ptL : 'OFF'}`; eL.style.color = L.isTouching ? 'var(--sens)' : 'var(--dim)'; }
    if (eR) { eR.textContent = `R: ${R.isTouching ? 'ON ' + ptR : 'OFF'}`; eR.style.color = R.isTouching ? 'var(--sens)' : 'var(--dim)'; }
    if (eB) { eB.textContent = `FORCE: ${Math.round(avg * 100)}%`; eB.style.color = avg > 0.3 ? 'var(--sens)' : 'var(--dim)'; }
  }

  smartGripUpdate(dt, {
    grabbed, getFingerGap, isBoxBetweenFingers: () => isBoxBetweenFingers(robotApi),
    BH, FW: getActive().FW, robot: robotApi, fingerSensors: getActiveSensors(),
    robotDescription: getActive().description, gripController: getActive().gripController, logger: log
  });

  if (grabbed) {
    gripHoldTime += dt;
    const gd = listener.getGripData();
    if (gd) { gripAvailableForce = gd.totalAvailableForce ?? 0; gripRequiredForce = gd.requiredForce ?? 0; }
    if (gripAvailableForce < gripRequiredForce && gripHoldTime > 2.0) { log('⚠️ OVERLOAD → DROPPING', 'warn'); actuateRelease(); }
  } else { gripHoldTime = 0; gripAvailableForce = 0; gripRequiredForce = 0; }

  if (!grabbed) physicsCtrl.clampFloor(BH);
  else if (physicsCtrl.body.position.y < BH) {
    physicsCtrl.body.position.y = BH;
    physicsCtrl.body.velocity.set(0, 0, 0); physicsCtrl.body.angularVelocity.set(0, 0, 0);
  }

  // مزامنة كل meshes الصناديق مع أجسامها الفيزيائية
  for (const b of boxes) {
    b.mesh.position.copy(b.body.position);
    b.mesh.quaternion.copy(b.body.quaternion);
  }
  physicsCtrl.markAABBDirty();


  // ── Multiuser: send local state & apply remote states ──
  if (muMode) {
    multiuser.sendUpdate(now, grabbed, physicsCtrl);
    multiuser.applyRemoteStates();
    updateActiveBadge(); // Keep UI fresh with latest ownership
  }

  const baseG = active.parts.base.group;
  CAM.target.lerp(new THREE.Vector3(baseG.position.x, 1.5 + baseG.position.y, baseG.position.z), 0.12);
  updateCamera();  // تعود فوراً بدون عمل إذا _xrSess != null

  if (!_xrSess) {
    const sbEl = document.getElementById('sb');
    if (sbEl) {
      let st = '', sc = '';
      if (activeStatus.floorBlocked) { st = '⛔ FLOOR LIMIT'; sc = 'crit'; }
      else if (activeStatus.robotBlocked) { st = '⛔ ROBOT-ROBOT COLLISION'; sc = 'crit'; }
      else if (activeStatus.selfBlocked) { st = '⚠ SELF COLLISION'; sc = 'warn'; }
      else if (grabbed) {
        const gd = listener.getGripData();
        if (gd) { const fp = (gd.totalAvailableForce / (gd.requiredForce || 1) * 100).toFixed(0); const s = gd.totalAvailableForce >= gd.requiredForce ? '🟢' : '🟠'; st = `${s} GRIP: ${gd.boxMass}kg | ${fp}%`; sc = gd.totalAvailableForce >= gd.requiredForce ? 'ok' : 'warn'; }
        else { st = '🟢 GRIP ACTIVE'; sc = 'ok'; }
      }
      else if (isBoxBetweenFingers(robotApi)) { st = '🟡 READY — close fingers'; sc = 'warn'; }
      else { st = 'STANDBY'; sc = ''; }
      sbEl.textContent = st; sbEl.className = sc;
    }
  }

  updateTelemetry({ jCurrent: active.jCurrent, scene, physicsCtrl, fingerSensors });
  // كاميرا الرؤية مدمجة في الروبوت وتعمل دائماً (الروبوت "يرى" باستمرار)
  vision.update(active);
  vision.getCollisionWarnings(active.parts.base.group.position, 1.8);


  vision.updateAll(robots);
  if (_allCamRemoteCtx && allCamsActive) {
    try {
      _allCamRemoteCtx.drawImage(_allCamOffscreen, 0, 0);
      const rEl = _allCamWin?.document?.getElementById('rInfo');
      if (rEl) rEl.textContent = `Robots: ${robots.length}`;
      const dEl = _allCamWin?.document?.getElementById('dInfo');
      if (dEl) dEl.textContent = `Detections: ${vision.getDetections().length}`;
    } catch (_) { }
  }
  renderer.render(scene, camera);
});

// ===== XR CONTROLLERS + SESSION =====

// ── XR helper: switch robot (shared by controllers + hand tracking) ──
function xrSwitchRobot() {
  if (muMode) { multiuser.claimNextRobot(); return; } // VR: cycle directly (no popup in XR)
  if (grabbed) actuateRelease();
  const prev = getActive(); prev.setDrive(0, 0);
  if (!grabbed) prev.setSqueeze(0);
  activeIdx = (activeIdx + 1) % robots.length;
  robotApi.setRobot3D(getActive()); syncSlidersToActive(); updateActiveBadge();
  if (_handTracker) _handTracker.resetReference();
}

// ── XR helper: reset all joints to 0 ──
function xrResetJoints() {
  const a = getActive();
  a.moveJoint('base', 0); a.moveJoint('shoulder', 0);
  a.moveJoint('elbow', 0); a.moveJoint('wrist', 0);
}

// ── Setup all VR interaction systems ──
function setupXRSystems() {
  const xrCb = {
    grab: () => {
      // Skip grab when interacting with VR UI
      if (_vrUI && _vrUI.visible && _vrUI._hoveredEl) return;
      actuateGrab();
    },
    release:      () => actuateRelease(),
    switchRobot:  xrSwitchRobot,
    claimRobot:   (idx) => { if (multiuser) multiuser.claimRobot(idx); },
    getActive:    () => getActive(),
    moveJoint:    (name, deg) => getActive().moveJoint(name, deg),
    setDrive:     (s, t) => {
      const active = getActive(); active.setDrive(s, t);
      for (const r of robots) if (r !== active) r.setDrive(0, 0);
    },
    setSqueeze: (v) => {
      const a = getActive();
      const clamped = Math.max(0, Math.min(1, v));
      a.setSqueeze(clamped);
      // Map squeeze (0=open, 1=closed) → FOPEN range (0.55→0.14)
      const openMM = 55 - clamped * (55 - 14);
      a.setOpen(openMM / 100);
    },
    resetJoints:  xrResetJoints,
    toggleUI:     () => { if (_vrUI) _vrUI.toggle(); },
    openCameraVision: () => {
      if (_vrUI) {
        _vrUI.show();
        _vrUI._view = 'camera';
      }
    },
    openRobotsList: () => {
      if (_vrUI) {
        _vrUI.show();
        _vrUI._view = 'robots';
      }
    },
    getGrabbed:   () => grabbed,
    getActiveIdx: () => activeIdx,
    getStatus: () => {
      if (grabbed) return 'GRIP ACTIVE';
      if (isBoxBetweenFingers(robotApi)) return 'READY';
      return 'STANDBY';
    },
    exitXR: () => { if (_xrSess) _xrSess.end(); },
    // ── ROBOT CREATOR API ──
    openCreatorUI: () => {
      if (_vrUI) {
        _vrUI.show();
        _vrUI._view = 'create';
      }
      openRobotCreator();
    },
    openCreator: () => { openRobotCreator(); },
    closeCreator: () => { closeRobotCreator(); },
    getCreatorState: () => {
      return {
        type: _rcType?.value || 'industrial',
        color: _rcSelectedColor,
        deployX: _rcDeployX,
        deployZ: _rcDeployZ,
        prevCanvas: _rcPrevCanvas,
        mapCanvas: _rcMapCanvas
      };
    },
    setCreatorColor: (hex) => {
      _rcSelectedColor = hex;
      if (_rcColors) {
        _rcColors.querySelectorAll('.rc-color-btn').forEach(b => {
          b.classList.toggle('selected', parseInt(b.dataset.color) === hex);
        });
      }
      updateRobotPreview();
    },
    setCreatorType: (t) => {
      if (_rcType) _rcType.value = t;
      if (t === 'cobot') {
        if (_rcSpeed) { _rcSpeed.value = 8; _rcSpeedVal.textContent = '0.8'; }
        if (_rcGrip) { _rcGrip.value = 600; _rcGripVal.textContent = '600N'; }
      } else {
        if (_rcSpeed) { _rcSpeed.value = 20; _rcSpeedVal.textContent = '2.0'; }
        if (_rcGrip) { _rcGrip.value = 1200; _rcGripVal.textContent = '1200N'; }
      }
      updateRobotPreview();
    },
    setCreatorMapPos: (u, v) => {
      const W = _rcMapCanvas?.width || 1;
      const H = _rcMapCanvas?.height || 1;
      const scaleX = W / 60;
      const scaleZ = H / 60;
      const scale = Math.min(scaleX, scaleZ) * 0.88;
      const mx = u * W;
      const mz = v * H;
      _rcDeployX = (mx - W / 2) / scale;
      _rcDeployZ = (mz - H / 2) / scale;
      _rcDeployX = Math.max(-28, Math.min(28, _rcDeployX));
      _rcDeployZ = Math.max(-28, Math.min(28, _rcDeployZ));
      if (_rcMapCoords) _rcMapCoords.textContent = `X: ${_rcDeployX.toFixed(1)}  Z: ${_rcDeployZ.toFixed(1)}`;
    },
    deployCreator: () => {
      document.getElementById('btnDeployRobot')?.click();
    }
  };

  // 1) VR Controller Manager
  _vrCtrlMgr = new VRControllerManager(renderer, xrRig, scene, xrCb);
  _vrCtrlMgr.setup();

  // 2) VR UI Panel (positioned to the LEFT — won't block view)
  _vrUI = new VRUI(scene, xrRig, xrCb);
  _vrUI.activate();
  _vrUI.show();  // Auto-show — panel is on the left side now

  // 3) Hand Tracking (auto-activates when hands are detected)
  _handTracker = new HandTrackingController(renderer, xrRig, scene, xrCb);
  _handTracker.setup();

  console.log('[XR] All VR systems initialised: Controllers ✓ | UI ✓ | HandTracking ✓');
}

// ── Cleanup all VR systems ──
function cleanupXRSystems() {
  if (_vrCtrlMgr)   { _vrCtrlMgr.dispose();   _vrCtrlMgr = null; }
  if (_vrUI)        { _vrUI.dispose();        _vrUI = null; }
  if (_handTracker) { _handTracker.dispose(); _handTracker = null; }
  _xrCtrlR = null; _xrCtrlL = null;
}

async function startXRSession(mode) {
  try {
    const opts = mode === 'immersive-ar'
      ? { requiredFeatures: ['hit-test'], optionalFeatures: ['local-floor', 'dom-overlay'], domOverlay: { root: document.body } }
      : { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] };

    const session = await navigator.xr.requestSession(mode, opts);
    _xrSess = session;
    await renderer.xr.setSession(session);

    if (mode === 'immersive-ar') { 
      scene.background = null; 
      renderer.setClearAlpha(0); 
      if (factoryGroup) factoryGroup.visible = false;
    }

    setupXRSystems();
    addPlayerBodiesToWorld();
    xrHideUI();
    _xrExit.style.display = 'block';

    const statEl = document.getElementById(mode === 'immersive-vr' ? 'vrStatus' : 'arStatus');
    if (statEl) { statEl.textContent = 'ACTIVE ●'; statEl.style.color = '#00ff77'; }

    session.addEventListener('end', () => {
      _xrSess = null;
      if (mode === 'immersive-ar') { 
        scene.background = new THREE.Color(0x8a9aaa); 
        renderer.setClearAlpha(1); 
        if (factoryGroup) factoryGroup.visible = true;
      }
      removePlayerBodiesFromWorld();
      cleanupXRSystems();
      xrShowUI();
      _xrExit.style.display = 'none';
      if (statEl) { statEl.textContent = 'AVAILABLE'; statEl.style.color = '#00cc55'; }
    });
  } catch (err) {
    console.error('XR error:', err);
    alert('XR Error: ' + err.message);
  }
}

function setupXRBtn(btnId, statId, mode) {
  const btn = document.getElementById(btnId); const sta = document.getElementById(statId);
  if (!btn || !sta) return;
  if (!navigator.xr) { sta.textContent = 'NO WEBXR'; sta.style.color = '#cc3333'; btn.disabled = true; return; }
  navigator.xr.isSessionSupported(mode)
    .then(ok => {
      sta.textContent = ok ? 'AVAILABLE' : 'NOT SUPPORTED'; sta.style.color = ok ? '#00cc55' : '#cc3333';
      btn.disabled = !ok;
      if (ok) btn.addEventListener('click', () => startXRSession(mode));
    })
    .catch(() => { sta.textContent = 'ERROR'; sta.style.color = '#cc3333'; btn.disabled = true; });
}

setupXRBtn('btnVR', 'vrStatus', 'immersive-vr');
setupXRBtn('btnAR', 'arStatus', 'immersive-ar');

// ===== COMPUTER VISION (ROBOT CAM) =====
const vision = new RobotVision({
  width: 320, height: 240, minArea: 80, processInterval: 2,
  onDetect: (detections) => {
    const el = document.getElementById('camDetections');
    if (el) el.textContent = `Detections: ${detections.length}`;
  },
  onCollision: (warnings) => {
    const el = document.getElementById('camCollisions');
    if (el) el.textContent = `Collisions: ${warnings.length}`;
    const st = document.getElementById('visionStatus');
    if (st) {
      const baseLabel = visionActive ? 'ACTIVE' : 'BG';
      st.textContent = warnings.length > 0 ? `⚠ ${warnings.length} COLL` : baseLabel;
      st.className = warnings.length > 0 ? 'warn' : 'on';
    }

  }
});

const camCanvas = document.getElementById('camCanvas');
const overlay = document.getElementById('cameraOverlay');
const btnVision = document.getElementById('btnVision');
const visionStatus = document.getElementById('visionStatus');
let visionActive = false;

vision.init(renderer, scene, camCanvas);
// نمرّر كل الصناديق + الصندوق الهدف الحالي. الرؤية تكتشف الصناديق كلها.
vision.setTargets({ boxPhys, boxes, robots });
vision.setActiveBoxId(targetBoxId);


// 👁️ كاميرا الرؤية مدمجة في الروبوت — تعمل دائماً بالخلفية منذ الإقلاع (الروبوت "يرى" باستمرار)
// لكن لا تُعرض شاشتها للمستخدم تلقائياً — يضغط الزر لرؤيتها عند الحاجة.
vision.start();              // المعالجة/الكشف تعمل بالخلفية
vision.hideDisplay();        // العرض المرئي مخفي افتراضياً
visionActive = false;        // العرض غير مفتوح للمستخدم
if (overlay) overlay.classList.remove('v');
if (visionStatus) { visionStatus.textContent = 'BG'; visionStatus.className = 'on'; }
if (btnVision) btnVision.textContent = '📷 ROBOT CAM';



vision.setCollisionStopHandler((data) => {
  const active = getActive();
  active.setDrive(0, 0);
  log(`🛑 Collision stop — ${data.detected.length} object(s) too close`, 'crit');
});

btnVision.addEventListener('click', () => {
  // الزر يبدّل عرض شاشة الكاميرا فقط — الرؤية تبقى تعمل بالخلفية دائماً
  if (visionActive) {
    vision.hideDisplay();
    overlay.classList.remove('v');
    btnVision.textContent = '📷 ROBOT CAM';
    visionStatus.textContent = 'BG';
    visionStatus.className = 'on';
    visionActive = false;
    return;
  }
  vision.start();          // ضمان أن المعالجة تعمل
  vision.showDisplay();    // إظهار الشاشة للمستخدم
  overlay.classList.add('v');
  btnVision.textContent = '⏹ HIDE CAM';
  visionStatus.textContent = 'ACTIVE';
  visionStatus.className = 'on';
  visionActive = true;
});


document.getElementById('btnCloseCamera').addEventListener('click', () => {
  if (visionActive) btnVision.click();
});

// ===== ALL ROBOTS CAMERA VIEW (new browser tab) =====
const btnAllCams = document.getElementById('btnAllCams');
let allCamsActive = false;
let _allCamWin = null;
let _allCamRemoteCtx = null;

const _allCamOffscreen = document.createElement('canvas');
_allCamOffscreen.width = 640;
_allCamOffscreen.height = 240;
vision.setAllCanvas(_allCamOffscreen);

function openAllCamsTab() {
  const w = 860, h = 430;
  _allCamWin = window.open('', 'allRobotCams', `width=${w},height=${h},menubar=no,toolbar=no,location=no,status=no`);
  if (!_allCamWin) return false;

  _allCamWin.document.write(`<!DOCTYPE html>
<html>
<head><title>All Robots Camera Vision</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0a0e14;display:flex;flex-direction:column;height:100vh;font-family:monospace}
  #hdr{display:flex;align-items:center;justify-content:space-between;padding:8px 14px;background:#1a0033;border-bottom:2px solid #aa44cc}
  #hdr span{color:#cc88ff;font-size:13px;letter-spacing:2px;text-transform:uppercase;font-weight:700}
  #hdr small{color:#8866aa;font-size:9px}
  #c{flex:1;width:100%;object-fit:contain;background:#000;display:block}
  #info{display:flex;gap:16px;padding:6px 14px;background:#0d1520;border-top:1px solid #6633aa;color:#cc88ff;font-size:10px;letter-spacing:1px}
</style></head>
<body>
  <div id="hdr"><span>ALL ROBOTS CAMERA VISION</span><small>4 robots · 8 cameras</small></div>
  <canvas id="c"></canvas>
  <div id="info"><span id="rInfo">Robots: 0</span><span id="dInfo">Detections: 0</span></div>
  <script>
    document.title = document.title + ' - ' + new Date().toLocaleTimeString();
    window.addEventListener('beforeunload',()=>{
      if(window.opener&&!window.opener.closed)
        window.opener.postMessage('allCamsClosed','*');
    });
  ${'<'}/script>
</body></html>`);
  _allCamWin.document.close();

  const cvs = _allCamWin.document.getElementById('c');
  if (!cvs) return false;
  cvs.width = 640;
  cvs.height = 240;
  _allCamRemoteCtx = cvs.getContext('2d');

  const checkClosed = setInterval(() => {
    if (_allCamWin && _allCamWin.closed) {
      clearInterval(checkClosed);
      _allCamWin = null;
      _allCamRemoteCtx = null;
      vision.stopAll();
      allCamsActive = false;
      btnAllCams.textContent = '📹 ALL ROBOTS CAM';
    }
  }, 500);

  return true;
}

window.addEventListener('message', e => {
  if (e.data === 'allCamsClosed') {
    _allCamWin = null;
    _allCamRemoteCtx = null;
    vision.stopAll();
    allCamsActive = false;
    btnAllCams.textContent = '📹 ALL ROBOTS CAM';
  }
});

if (btnAllCams) {
  btnAllCams.addEventListener('click', () => {
    if (allCamsActive) {
      if (_allCamWin && !_allCamWin.closed) _allCamWin.close();
      _allCamWin = null;
      _allCamRemoteCtx = null;
      vision.stopAll();
      btnAllCams.textContent = '📹 ALL ROBOTS CAM';
      allCamsActive = false;
    } else {
      if (visionActive) btnVision.click();
      vision.startAll(robots);
      if (openAllCamsTab()) {
        btnAllCams.textContent = '⏹ STOP ALL CAMS';
        allCamsActive = true;
      } else {
        vision.stopAll();
        alert('Popup blocked! Allow popups for this site.');
      }
    }
  });
}

window.__vision = vision;

// ===== MISC =====
window.robot = robotApi; window.robot1 = robot1; window.robot2 = robot2; window.robots = robots;

// ══════════════════════════════════════════════════════════
//  Handoff Bridge — للسماح لـ test3.js بالتحكم المباشر
//  في حالة الإمساك دون المرور عبر getActive()
// ══════════════════════════════════════════════════════════
window.__handoff = {
  setActiveIdx(idx) {
    activeIdx = idx;
    robotApi.setRobot3D(robots[idx]);
  },
  setHoldingIdx(idx) { holdingRobotIdx = idx; },
  saveGripOffset(d) { saveGripOffset(d); },
  getGrabbed() { return grabbed; },
  getHoldingIdx() { return holdingRobotIdx; },
  getActiveIdx() { return activeIdx; },
  suppressCollision: false,  // test3.js يضبطها true أثناء الاقتراب
};

// ═══════════════════════════════════════════════════════════════
//  ROBOT CREATOR MODAL — Phase 1
//  Full interactive modal: config + preview + mini factory map
// ═══════════════════════════════════════════════════════════════
const _rcOverlay   = document.getElementById('robotCreatorOverlay');
const _rcPanel     = document.getElementById('robotCreatorPanel');
const _rcName      = document.getElementById('rcName');
const _rcType      = document.getElementById('rcType');
const _rcColors    = document.getElementById('rcColors');
const _rcArmLen    = document.getElementById('rcArmLen');
const _rcArmLenVal = document.getElementById('rcArmLenVal');
const _rcSpeed     = document.getElementById('rcSpeed');
const _rcSpeedVal  = document.getElementById('rcSpeedVal');
const _rcGrip      = document.getElementById('rcGrip');
const _rcGripVal   = document.getElementById('rcGripVal');
const _rcMapCoords = document.getElementById('rcMapCoords');
const _rcMapCanvas = document.getElementById('rcMapCanvas');
const _rcPrevCanvas= document.getElementById('rcPreviewCanvas');

let _rcOpen = false;
let _rcSelectedColor = 0xF7931E;  // Default KUKA orange
let _rcDeployX = 6;
let _rcDeployZ = -5;
let _rcPreviewRenderer = null;
let _rcPreviewScene = null;
let _rcPreviewCamera = null;
let _rcPreviewGroup = null;
let _rcPreviewAnimId = null;

// ── COLOR PICKER ──
if (_rcColors) {
  _rcColors.addEventListener('click', e => {
    const btn = e.target.closest('.rc-color-btn');
    if (!btn) return;
    _rcColors.querySelectorAll('.rc-color-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    _rcSelectedColor = parseInt(btn.dataset.color);
    updateRobotPreview();
  });
}

// ── SLIDERS ──
if (_rcArmLen) _rcArmLen.oninput = function () {
  _rcArmLenVal.textContent = (this.value / 100).toFixed(1) + 'm';
  updateRobotPreview();
};
if (_rcSpeed) _rcSpeed.oninput = function () {
  _rcSpeedVal.textContent = (this.value / 10).toFixed(1);
};
if (_rcGrip) _rcGrip.oninput = function () {
  _rcGripVal.textContent = this.value + 'N';
};
if (_rcType) _rcType.onchange = function () {
  // Update defaults when type changes
  if (this.value === 'cobot') {
    _rcSpeed.value = 8; _rcSpeedVal.textContent = '0.8';
    _rcGrip.value = 600; _rcGripVal.textContent = '600N';
  } else {
    _rcSpeed.value = 20; _rcSpeedVal.textContent = '2.0';
    _rcGrip.value = 1200; _rcGripVal.textContent = '1200N';
  }
  updateRobotPreview();
};

// ── OPEN / CLOSE ──
function openRobotCreator() {
  if (_rcOpen) return;
  _rcOpen = true;
  // Set default name
  _rcName.value = `Robot ${robots.length + 1}`;
  _rcOverlay.classList.add('visible');
  initMiniFactoryMap();
  initRobotPreview();
  drawMiniFactoryMap();
}

function closeRobotCreator() {
  if (!_rcOpen) return;
  _rcOpen = false;
  _rcOverlay.classList.remove('visible');
  stopRobotPreview();
}

// Button bindings
document.getElementById('btnCreateRobot')?.addEventListener('click', openRobotCreator);
document.getElementById('btnCloseCreator')?.addEventListener('click', closeRobotCreator);
document.getElementById('btnCancelCreator')?.addEventListener('click', closeRobotCreator);

// Close on overlay click
if (_rcOverlay) {
  _rcOverlay.addEventListener('click', e => {
    if (e.target === _rcOverlay) closeRobotCreator();
  });
}
// Close on ESC
document.addEventListener('keydown', e => {
  if (e.code === 'Escape' && _rcOpen) { e.preventDefault(); closeRobotCreator(); }
});

// ═══════════════════════════════════════════════════════
//  MINI FACTORY MAP — 2D Canvas top-down view
// ═══════════════════════════════════════════════════════
const MAP_FW = 60, MAP_FD = 60;  // Factory dimensions (from factory.js)

function initMiniFactoryMap() {
  if (!_rcMapCanvas) return;
  const rect = _rcMapCanvas.parentElement.getBoundingClientRect();
  _rcMapCanvas.width = rect.width * (window.devicePixelRatio || 1);
  _rcMapCanvas.height = 180 * (window.devicePixelRatio || 1);
  _rcMapCanvas.style.width = rect.width + 'px';
  _rcMapCanvas.style.height = '180px';
}

function drawMiniFactoryMap() {
  if (!_rcMapCanvas) return;
  const ctx = _rcMapCanvas.getContext('2d');
  const W = _rcMapCanvas.width;
  const H = _rcMapCanvas.height;
  const scaleX = W / MAP_FW;
  const scaleZ = H / MAP_FD;
  const scale = Math.min(scaleX, scaleZ) * 0.88;
  const ox = W / 2;
  const oz = H / 2;

  function toMap(wx, wz) {
    return [ox + wx * scale, oz + wz * scale];
  }
  function drawRect(wx, wz, ww, wd, color, rot = 0) {
    const [cx, cy] = toMap(wx, wz);
    ctx.save();
    ctx.translate(cx, cy);
    if (rot) ctx.rotate(rot);
    ctx.fillStyle = color;
    ctx.fillRect(-ww * scale / 2, -wd * scale / 2, ww * scale, wd * scale);
    ctx.restore();
  }

  // Clear
  ctx.fillStyle = '#0a0e14';
  ctx.fillRect(0, 0, W, H);

  // Grid
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  for (let g = -30; g <= 30; g += 5) {
    const [gx] = toMap(g, 0);
    ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke();
    const [, gy] = toMap(0, g);
    ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke();
  }

  // Factory floor outline
  const [flx, fly] = toMap(-MAP_FW / 2, -MAP_FD / 2);
  const [frx, fry] = toMap(MAP_FW / 2, MAP_FD / 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(flx, fly, frx - flx, fry - fly);

  // Walls
  drawRect(0, -30, 60, 0.3, 'rgba(100,110,120,0.4)');
  drawRect(0, 30, 60, 0.3, 'rgba(100,110,120,0.4)');
  drawRect(-30, 0, 0.3, 60, 'rgba(100,110,120,0.4)');
  drawRect(30, 0, 0.3, 60, 'rgba(100,110,120,0.4)');

  // Shelves (blue)
  const shelves = [
    { x: 18, z: -8, w: 12, d: 1.2 }, { x: 18, z: 4, w: 12, d: 1.2 },
    { x: -18, z: -8, w: 12, d: 1.2 }, { x: -18, z: 4, w: 12, d: 1.2 },
    { x: 0, z: -22, w: 1.2, d: 16, rot: 0 },
    { x: -14, z: 18, w: 1.2, d: 8, rot: 0 },
  ];
  for (const s of shelves) {
    drawRect(s.x, s.z, s.w, s.d, 'rgba(74,106,138,0.45)', s.rot || 0);
  }

  // Conveyors (dark)
  drawRect(8, 12, 10, 0.9, 'rgba(56,60,66,0.5)');
  drawRect(-8, -14, 8, 0.9, 'rgba(56,60,66,0.5)', Math.PI / 4);

  // Columns
  const cols = [
    [-12, -12], [12, -12], [-12, 12], [12, 12], [-12, 0], [12, 0]
  ];
  for (const [cx, cz] of cols) {
    drawRect(cx, cz, 0.5, 0.5, 'rgba(136,136,144,0.5)');
  }

  // Barrels
  const barrels = [[22, 18], [22.8, 18], [22.4, 18.7], [-22, -18], [-22.8, -18], [22, -20]];
  for (const [bx, bz] of barrels) {
    const [mx, mz] = toMap(bx, bz);
    ctx.beginPath();
    ctx.arc(mx, mz, 3 * (scale / 5), 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(34,85,170,0.5)';
    ctx.fill();
  }

  // Safety lines (yellow)
  ctx.strokeStyle = 'rgba(232,200,49,0.25)';
  ctx.lineWidth = 1;
  const [slx1] = toMap(-20, 0); const [slx2] = toMap(20, 0);
  const [, sly] = toMap(0, 0);
  ctx.beginPath(); ctx.moveTo(slx1, sly); ctx.lineTo(slx2, sly); ctx.stroke();
  const [smx] = toMap(0, 0); const [, smz1] = toMap(0, -20); const [, smz2] = toMap(0, 20);
  ctx.beginPath(); ctx.moveTo(smx, smz1); ctx.lineTo(smx, smz2); ctx.stroke();

  // Existing robots (yellow dots with label)
  for (let i = 0; i < robots.length; i++) {
    const r = robots[i];
    const rx = r.baseState.x;
    const rz = r.baseState.z;
    const [mx, mz] = toMap(rx, rz);
    // Glow
    ctx.beginPath();
    ctx.arc(mx, mz, 8, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,204,0,0.15)';
    ctx.fill();
    // Dot
    ctx.beginPath();
    ctx.arc(mx, mz, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#ffcc00';
    ctx.fill();
    // Label
    ctx.fillStyle = 'rgba(255,204,0,0.7)';
    ctx.font = `${Math.max(9, 10 * (scale / 5))}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(`R${i + 1}`, mx, mz - 9);
  }

  // Selected deployment position (green crosshair with pulse)
  const [dx, dz] = toMap(_rcDeployX, _rcDeployZ);
  const pulse = 0.6 + 0.4 * Math.sin(Date.now() / 300);
  // Outer ring
  ctx.beginPath();
  ctx.arc(dx, dz, 12 * pulse, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(0,255,136,${0.3 * pulse})`;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // Inner ring
  ctx.beginPath();
  ctx.arc(dx, dz, 6, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(0,255,136,0.7)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // Cross
  ctx.strokeStyle = 'rgba(0,255,136,0.8)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(dx - 10, dz); ctx.lineTo(dx + 10, dz); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(dx, dz - 10); ctx.lineTo(dx, dz + 10); ctx.stroke();
  // Center dot
  ctx.beginPath();
  ctx.arc(dx, dz, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = '#00ff88';
  ctx.fill();
  // Label
  ctx.fillStyle = '#00ff88';
  ctx.font = `${Math.max(9, 10 * (scale / 5))}px monospace`;
  ctx.textAlign = 'center';
  ctx.fillText('NEW', dx, dz - 16);

  // Animate the pulse
  if (_rcOpen) requestAnimationFrame(drawMiniFactoryMap);
}

// Click on map to select position
if (_rcMapCanvas) {
  _rcMapCanvas.addEventListener('click', e => {
    const rect = _rcMapCanvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (_rcMapCanvas.width / rect.width);
    const mz = (e.clientY - rect.top) * (_rcMapCanvas.height / rect.height);
    const W = _rcMapCanvas.width;
    const H = _rcMapCanvas.height;
    const scaleX = W / MAP_FW;
    const scaleZ = H / MAP_FD;
    const scale = Math.min(scaleX, scaleZ) * 0.88;
    _rcDeployX = (mx - W / 2) / scale;
    _rcDeployZ = (mz - H / 2) / scale;
    // Clamp inside factory
    _rcDeployX = Math.max(-28, Math.min(28, _rcDeployX));
    _rcDeployZ = Math.max(-28, Math.min(28, _rcDeployZ));
    _rcMapCoords.textContent = `X: ${_rcDeployX.toFixed(1)}  Z: ${_rcDeployZ.toFixed(1)}`;
  });
}

// ═══════════════════════════════════════════════════════
//  ROBOT PREVIEW — Three.js mini renderer
// ═══════════════════════════════════════════════════════
function initRobotPreview() {
  if (!_rcPrevCanvas) return;
  const rect = _rcPrevCanvas.parentElement.getBoundingClientRect();
  const pw = Math.floor(rect.width);
  const ph = 200;
  _rcPrevCanvas.width = pw * (window.devicePixelRatio > 1 ? 1.5 : 1);
  _rcPrevCanvas.height = ph * (window.devicePixelRatio > 1 ? 1.5 : 1);
  _rcPrevCanvas.style.width = pw + 'px';
  _rcPrevCanvas.style.height = ph + 'px';

  // Create mini renderer
  _rcPreviewRenderer = new THREE.WebGLRenderer({
    canvas: _rcPrevCanvas,
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true
  });
  _rcPreviewRenderer.setSize(_rcPrevCanvas.width, _rcPrevCanvas.height, false);
  _rcPreviewRenderer.setClearColor(0x060a10, 1);

  // Mini scene
  _rcPreviewScene = new THREE.Scene();
  _rcPreviewScene.add(new THREE.AmbientLight(0xffffff, 1.5));
  const dLight = new THREE.DirectionalLight(0xfff0d8, 2.0);
  dLight.position.set(3, 6, 4);
  _rcPreviewScene.add(dLight);
  const pLight = new THREE.PointLight(0xffd8a0, 1.0, 15);
  pLight.position.set(-3, 4, -2);
  _rcPreviewScene.add(pLight);

  // Camera
  _rcPreviewCamera = new THREE.PerspectiveCamera(40, _rcPrevCanvas.width / _rcPrevCanvas.height, 0.1, 50);
  _rcPreviewCamera.position.set(3, 3, 4.5);
  _rcPreviewCamera.lookAt(0, 1.2, 0);

  // Grid floor
  const gridHelper = new THREE.GridHelper(6, 12, 0x1a2030, 0x111825);
  _rcPreviewScene.add(gridHelper);

  buildPreviewRobot();
  animatePreview();
}

function buildPreviewRobot() {
  if (!_rcPreviewScene) return;
  // Remove old
  if (_rcPreviewGroup) {
    _rcPreviewScene.remove(_rcPreviewGroup);
    _rcPreviewGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
  }

  _rcPreviewGroup = new THREE.Group();
  const armColor = _rcSelectedColor;
  const isCobot = _rcType?.value === 'cobot';
  const armLen = (_rcArmLen?.value || 150) / 100;

  const bodyColor = isCobot ? 0xBFC5CC : 0x4B5563;
  const accentColor = isCobot ? 0x2C7AB5 : armColor;

  // Materials
  const matBody = new THREE.MeshStandardMaterial({ color: bodyColor, metalness: 0.7, roughness: 0.4 });
  const matArm = new THREE.MeshStandardMaterial({ color: armColor, metalness: 0.75, roughness: 0.35 });
  const matAccent = new THREE.MeshStandardMaterial({ color: accentColor, metalness: 0.7, roughness: 0.35 });
  const matJoint = new THREE.MeshStandardMaterial({ color: 0x6B7280, metalness: 0.8, roughness: 0.3 });
  const matFinger = new THREE.MeshStandardMaterial({ color: 0x9CA3AF, metalness: 0.8, roughness: 0.3 });
  const matTrack = new THREE.MeshStandardMaterial({ color: 0x3a3632, metalness: 0.15, roughness: 0.85 });

  // Tracks
  const trackW = 0.16, trackH = 0.24, trackL = 0.95, bodyW = 0.6;
  for (const side of [-1, 1]) {
    const track = new THREE.Mesh(new THREE.BoxGeometry(trackW, trackH, trackL), matTrack);
    track.position.set(side * (bodyW / 2 + trackW / 2), trackH / 2, 0);
    _rcPreviewGroup.add(track);
  }

  // Chassis
  const bodyH = 0.14;
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(bodyW, bodyH, 0.8), matBody);
  chassis.position.y = trackH + bodyH / 2;
  _rcPreviewGroup.add(chassis);

  // Turret
  const turretR = 0.28, turretH = 0.14;
  const turret = new THREE.Mesh(new THREE.CylinderGeometry(turretR, turretR + 0.05, turretH, 24), matBody);
  turret.position.y = trackH + bodyH + turretH / 2;
  _rcPreviewGroup.add(turret);

  // Turret ring
  const ring = new THREE.Mesh(new THREE.TorusGeometry(turretR + 0.01, 0.02, 12, 24), matJoint);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = trackH + bodyH + 0.02;
  _rcPreviewGroup.add(ring);

  // Turret top accent
  const tTop = new THREE.Mesh(new THREE.CylinderGeometry(turretR - 0.03, turretR, 0.04, 24), matAccent);
  tTop.position.y = trackH + bodyH + turretH - 0.01;
  _rcPreviewGroup.add(tTop);

  // Status light for cobot
  if (isCobot) {
    const sMat = new THREE.MeshStandardMaterial({ color: accentColor, emissive: accentColor, emissiveIntensity: 1.0 });
    const sLight = new THREE.Mesh(new THREE.SphereGeometry(turretR * 0.5, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), sMat);
    sLight.position.y = trackH + bodyH + turretH + 0.005;
    _rcPreviewGroup.add(sLight);
  }

  const baseOff = trackH + bodyH + turretH;

  // Shoulder
  const shoulderW = 0.26;
  const shoulderLen = armLen;
  const shoulderPivot = new THREE.Group();
  shoulderPivot.position.y = baseOff;

  const shoulderMesh = new THREE.Group();
  shoulderMesh.position.y = shoulderLen / 2;

  const shoulderBody = new THREE.Mesh(
    new THREE.CylinderGeometry(shoulderW * 0.6, shoulderW * 0.7, shoulderLen - shoulderW, 24), matArm
  );
  shoulderMesh.add(shoulderBody);

  // Shoulder joint
  const sJoint = new THREE.Mesh(
    new THREE.CylinderGeometry(shoulderW * 0.6, shoulderW * 0.6, shoulderW * 1.2, 24), matJoint
  );
  sJoint.rotation.z = Math.PI / 2;
  sJoint.position.y = -shoulderLen / 2;
  shoulderMesh.add(sJoint);

  // Shoulder accent caps
  for (const d of [1, -1]) {
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(shoulderW * 0.65, shoulderW * 0.65, 0.04, 24), matAccent);
    cap.rotation.z = Math.PI / 2;
    cap.position.set(d * (shoulderW * 0.6 + 0.02), -shoulderLen / 2, 0);
    shoulderMesh.add(cap);
  }

  shoulderPivot.add(shoulderMesh);
  shoulderPivot.rotation.x = THREE.MathUtils.degToRad(25);  // Slight pose
  _rcPreviewGroup.add(shoulderPivot);

  // Elbow
  const elbowW = 0.22;
  const elbowLen = armLen * 0.63;
  const elbowPivot = new THREE.Group();
  elbowPivot.position.y = shoulderLen / 2;

  const elbowMesh = new THREE.Group();
  elbowMesh.position.y = elbowLen / 2;

  const elbowBody = new THREE.Mesh(
    new THREE.CylinderGeometry(elbowW * 0.5, elbowW * 0.6, elbowLen - elbowW, 24), matArm
  );
  elbowMesh.add(elbowBody);

  const eJoint = new THREE.Mesh(
    new THREE.CylinderGeometry(elbowW * 0.55, elbowW * 0.55, elbowW * 1.1, 24), matJoint
  );
  eJoint.rotation.z = Math.PI / 2;
  eJoint.position.y = -elbowLen / 2;
  elbowMesh.add(eJoint);

  for (const d of [1, -1]) {
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(elbowW * 0.6, elbowW * 0.6, 0.03, 24), matAccent);
    cap.rotation.z = Math.PI / 2;
    cap.position.set(d * (elbowW * 0.55 + 0.015), -elbowLen / 2, 0);
    elbowMesh.add(cap);
  }

  elbowPivot.add(elbowMesh);
  elbowPivot.rotation.x = THREE.MathUtils.degToRad(-40);  // Slight pose
  shoulderMesh.add(elbowPivot);

  // Wrist
  const wr = 0.12, wh = 0.12;
  const wristPivot = new THREE.Group();
  wristPivot.position.y = elbowLen / 2;
  const wristMesh = new THREE.Mesh(new THREE.CylinderGeometry(wr, wr * 1.1, wh, 24), matJoint);
  wristPivot.add(wristMesh);
  elbowMesh.add(wristPivot);

  // Gripper / fingers
  const palmGroup = new THREE.Group();
  palmGroup.position.y = 0.1;
  wristPivot.add(palmGroup);

  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.08, 0.24), matJoint);
  palmGroup.add(palm);

  const gripBase = new THREE.Mesh(new THREE.BoxGeometry(0.42 * 1.02, 0.08 * 1.4, 0.24 * 0.8), matJoint);
  gripBase.position.y = 0.04;
  palmGroup.add(gripBase);

  // Fingers
  for (const side of [-1, 1]) {
    const finger = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.40, 0.16), matFinger);
    finger.position.set(side * 0.22, 0.24, 0);
    palmGroup.add(finger);
    // Rubber pads
    const pad = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.30, 0.12),
      new THREE.MeshStandardMaterial({ color: 0x4A4540, metalness: 0.1, roughness: 0.9 }));
    pad.position.set(side * (-0.03), 0.02, 0);
    finger.add(pad);
  }

  _rcPreviewScene.add(_rcPreviewGroup);
}

function updateRobotPreview() {
  buildPreviewRobot();
}

function animatePreview() {
  if (!_rcOpen || !_rcPreviewRenderer) return;
  _rcPreviewAnimId = requestAnimationFrame(animatePreview);
  if (_rcPreviewGroup) {
    _rcPreviewGroup.rotation.y += 0.008;
  }
  _rcPreviewRenderer.render(_rcPreviewScene, _rcPreviewCamera);
}

function stopRobotPreview() {
  if (_rcPreviewAnimId) {
    cancelAnimationFrame(_rcPreviewAnimId);
    _rcPreviewAnimId = null;
  }
  if (_rcPreviewRenderer) {
    _rcPreviewRenderer.dispose();
    _rcPreviewRenderer = null;
  }
  if (_rcPreviewScene) {
    _rcPreviewScene.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (o.material.map) o.material.map.dispose();
        o.material.dispose();
      }
    });
    _rcPreviewScene = null;
  }
  _rcPreviewGroup = null;
  _rcPreviewCamera = null;
}

// ═══════════════════════════════════════════════════════
//  DEPLOY ROBOT — Creates a new Robot3D instance
// ═══════════════════════════════════════════════════════
document.getElementById('btnDeployRobot')?.addEventListener('click', () => {
  const robotName = _rcName.value.trim() || `Robot ${robots.length + 1}`;
  const robotType = _rcType.value;
  const armColor = _rcSelectedColor;
  const armLen = (_rcArmLen.value || 150) / 100;
  const speed = (_rcSpeed.value || 20) / 10;
  const gripForce = parseInt(_rcGrip.value) || 1200;
  const deployX = _rcDeployX;
  const deployZ = _rcDeployZ;

  // Build color variants
  const darkerColor = darkenHexColor(armColor, 0.85);
  const accentColor = robotType === 'cobot' ? 0x2C7AB5 : armColor;
  const bodyColor = robotType === 'cobot' ? 0xBFC5CC : 0x5C6370;

  // Create description overrides
  const overrides = {
    type: robotType,
    arm: {
      shoulder: { color: armColor, len: armLen },
      elbow: { color: darkerColor, len: armLen * 0.63 },
      palm: { color: 0x78818C },
    },
    base: {
      body: { color: bodyColor },
      accentColor: accentColor,
    },
    finger: { color: 0xA0A8B0 },
    movement: { speed: speed },
    grip: { maxForce: gripForce },
  };

  // Create the new robot
  const newRobot = new Robot3D(makeDescription(overrides), ctx);
  newRobot.setPosition(deployX, deployZ);

  // Add to robots array
  robots.push(newRobot);

  // Add metadata
  const colorHex = '#' + (armColor & 0xFFFFFF).toString(16).padStart(6, '0');
  ROBOT_META.push({
    name: robotName,
    type: robotType === 'cobot' ? 'Cobot' : 'Industrial',
    color: colorHex,
  });

  // Create FingerSensors for the new robot
  allFingerSensors.push({
    left: new FingerSensor('left',
      newRobot.parts.fingers.left.group.children[0],
      newRobot.parts.fingers.left.body,
      newRobot.description,
      { robot: robotApi, logger: log }),
    right: new FingerSensor('right',
      newRobot.parts.fingers.right.group.children[0],
      newRobot.parts.fingers.right.body,
      newRobot.description,
      { robot: robotApi, logger: log }),
  });

  // Switch to the new robot
  const prev = getActive();
  prev.setDrive(0, 0);
  if (!grabbed) prev.setSqueeze(0);
  activeIdx = robots.length - 1;
  robotApi.setRobot3D(newRobot);
  syncSlidersToActive();
  updateActiveBadge();

  // Log
  log(`🤖 Deployed "${robotName}" at (${deployX.toFixed(1)}, ${deployZ.toFixed(1)})`, 'ok');
  console.log(`[RobotCreator] Deployed ${robotName} — type=${robotType}, color=0x${armColor.toString(16)}, pos=(${deployX.toFixed(1)}, ${deployZ.toFixed(1)})`);

  closeRobotCreator();
});

// Utility: darken a hex color value
function darkenHexColor(hex, factor) {
  const r = ((hex >> 16) & 0xFF) * factor;
  const g = ((hex >> 8) & 0xFF) * factor;
  const b = (hex & 0xFF) * factor;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}


window.addEventListener('resize', () => {
  if (_xrSess) return;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

document.addEventListener('keydown', e => { if (e.key === 'r') actuateRelease(); });

