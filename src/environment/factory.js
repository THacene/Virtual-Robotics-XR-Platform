import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160/build/three.module.js";
import * as CANNON from "https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js";

/**
 * Factory Environment v2 — واقعية عالية، أداء سلس
 *   أرضية ببقع زيت وآثار إطارات — جدران معدنية مموّجة — نوافذ علوية
 *   باب مصنع — رافعة شوكية — صناديق كرتونية — مناطق مرقّمة
 *   طفايات حريق — لوحات كهرباء — سقف بجمالونات — إضاءة صناعية
 */

// ─── مقاسات المصنع ───
const FW = 60;   // عرض
const FD = 60;   // عمق
const FH = 12;   // ارتفاع
const HALF_W = FW / 2;
const HALF_D = FD / 2;

// ─── ألوان صناعية واقعية ───
const COL = {
  floor:     0x5a5a5a,
  floorLine: 0xe8c831,
  wall:      0xd4cfc5,
  wallLower: 0x7a8a7a,
  ceiling:   0xe0ddd5,
  beam:      0x606870,
  shelf:     0x4a6a8a,
  shelfPost: 0xd07020,
  pallet:    0x9e7e4a,
  pipe:      0x889098,
  barrel:    0x2255aa,
  barrelTop: 0x44444c,
  conveyor:  0x383c42,
  convRoll:  0x666e76,
  caution:   0xffcc00,
  guardRail: 0xcccc22,
  light:     0xfff8e0,
  sign:      0xdd3322,
  forklift:  0xe8a020,
};

// ─── مساعدات ───
function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: opts.roughness ?? 0.75,
    metalness: opts.metalness ?? 0.15,
    ...opts,
  });
}

function box(w, h, d, material, pos, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(pos.x, pos.y, pos.z);
  if (rx) m.rotation.x = rx;
  if (ry) m.rotation.y = ry;
  if (rz) m.rotation.z = rz;
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// ─── تكسشرات إجرائية ───

// كرتون بشريط لاصق
function makeCardboardTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#b88a52';
  g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 300; i++) {
    g.fillStyle = `rgba(0,0,0,${Math.random() * 0.06})`;
    g.fillRect(Math.random() * 128, Math.random() * 128, 3, 1);
  }
  // شريط لاصق
  g.fillStyle = 'rgba(190,170,140,0.9)';
  g.fillRect(54, 0, 20, 128);
  g.fillStyle = 'rgba(0,0,0,0.15)';
  g.fillRect(54, 0, 2, 128); g.fillRect(72, 0, 2, 128);
  // ملصق شحن
  g.fillStyle = '#f0ede6';
  g.fillRect(8, 78, 40, 26);
  g.fillStyle = '#222';
  g.fillRect(11, 83, 34, 3); g.fillRect(11, 90, 24, 3); g.fillRect(11, 97, 30, 3);
  return new THREE.CanvasTexture(c);
}

// معدن مموّج للجدران
function makeCorrugatedTexture(baseColor) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = baseColor;
  g.fillRect(0, 0, 256, 256);
  // تموجات رأسية
  for (let x = 0; x < 256; x += 16) {
    const grad = g.createLinearGradient(x, 0, x + 16, 0);
    grad.addColorStop(0, 'rgba(0,0,0,0.16)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.10)');
    grad.addColorStop(1, 'rgba(0,0,0,0.16)');
    g.fillStyle = grad;
    g.fillRect(x, 0, 16, 256);
  }
  // صدأ خفيف أسفل
  for (let i = 0; i < 60; i++) {
    g.fillStyle = `rgba(110,70,40,${Math.random() * 0.10})`;
    g.fillRect(Math.random() * 256, 200 + Math.random() * 56, Math.random() * 18 + 4, Math.random() * 8 + 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// باب مصنع (Roller Shutter)
function makeRollerDoorTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#7a838c';
  g.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y += 20) {
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(0, y, 256, 3);
    g.fillStyle = 'rgba(0,0,0,0.30)';
    g.fillRect(0, y + 16, 256, 4);
  }
  // اتساخ
  for (let i = 0; i < 120; i++) {
    g.fillStyle = `rgba(0,0,0,${Math.random() * 0.07})`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 14, 3);
  }
  return new THREE.CanvasTexture(c);
}

// ══════════════════════════════════════════════════
//  buildFactory(scene, world, groundMaterial)
// ══════════════════════════════════════════════════
export function buildFactory(scene, world, groundMaterial) {
  const root = new THREE.Group();
  root.name = 'factory';

  buildFloor(root);
  buildWalls(root);
  buildCeiling(root);
  buildShelves(root);
  buildShelfBoxes(root);
  buildConveyors(root);
  buildBarrels(root);
  buildPallets(root);
  buildFloorMarkings(root);
  buildPipes(root);
  buildIndustrialLights(root, scene);
  buildSigns(root);
  buildColumns(root);
  buildGuardRails(root);
  buildForklift(root);        // 🆕 رافعة شوكية
  buildWallProps(root);       // 🆕 طفايات + لوحات كهرباء + ساعة

  if (world) buildPhysics(world, groundMaterial);

  scene.add(root);
  return root;
}

// ──────────────────────────────────────────────────
//  أرضية — خرسانة + بقع زيت + آثار إطارات + تآكل
// ──────────────────────────────────────────────────
function buildFloor(root) {
  const floorCanvas = document.createElement('canvas');
  floorCanvas.width = 1024; floorCanvas.height = 1024;
  const ctx = floorCanvas.getContext('2d');

  ctx.fillStyle = '#6b6b6b';
  ctx.fillRect(0, 0, 1024, 1024);

  // حبيبات الخرسانة
  for (let i = 0; i < 9000; i++) {
    const a = Math.random() * 0.14;
    ctx.fillStyle = Math.random() > 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
    ctx.fillRect(Math.random() * 1024, Math.random() * 1024, Math.random() * 2 + 0.5, Math.random() * 2 + 0.5);
  }

  // 🆕 بقع زيت داكنة
  for (let i = 0; i < 14; i++) {
    const x = Math.random() * 1024, y = Math.random() * 1024;
    const r = Math.random() * 50 + 18;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(20,18,15,0.45)');
    grad.addColorStop(0.6, 'rgba(20,18,15,0.18)');
    grad.addColorStop(1, 'rgba(20,18,15,0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }

  // 🆕 آثار إطارات منحنية
  ctx.strokeStyle = 'rgba(25,22,20,0.16)';
  ctx.lineWidth = 14;
  for (let i = 0; i < 8; i++) {
    const x = Math.random() * 1024, y = Math.random() * 1024;
    ctx.beginPath();
    ctx.arc(x, y, 120 + Math.random() * 200, Math.random() * Math.PI, Math.random() * Math.PI + 1.2);
    ctx.stroke();
  }

  // 🆕 مناطق تآكل فاتحة (مسارات الحركة المتكررة)
  for (let i = 0; i < 5; i++) {
    const grad = ctx.createLinearGradient(0, 0, 1024, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.05)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, Math.random() * 1024, 1024, 60);
  }

  // فواصل خرسانية
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 3;
  for (let i = 0; i <= 8; i++) {
    ctx.beginPath(); ctx.moveTo(i * 128, 0); ctx.lineTo(i * 128, 1024); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i * 128); ctx.lineTo(1024, i * 128); ctx.stroke();
  }

  const floorTex = new THREE.CanvasTexture(floorCanvas);
  floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
  floorTex.repeat.set(4, 4);
  floorTex.anisotropy = 8;

  const floorMat = new THREE.MeshStandardMaterial({
    map: floorTex,
    roughness: 0.82,
    metalness: 0.06,
  });

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(FW, FD), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  root.add(floor);
}

// ──────────────────────────────────────────────────
//  جدران — معدن مموّج + نوافذ علوية + باب مصنع
// ──────────────────────────────────────────────────
function buildWalls(root) {
  const corrTex = makeCorrugatedTexture('#d4cfc5');
  corrTex.repeat.set(12, 3);
  const wallMat = new THREE.MeshStandardMaterial({ map: corrTex, roughness: 0.65, metalness: 0.35 });
  const lowerMat = mat(COL.wallLower, { roughness: 0.7, metalness: 0.05 });

  const wallDefs = [
    { w: FW, pos: { x: 0, y: FH / 2, z: -HALF_D }, ry: 0 },
    { w: FW, pos: { x: 0, y: FH / 2, z: HALF_D },  ry: Math.PI },
    { w: FD, pos: { x: -HALF_W, y: FH / 2, z: 0 }, ry: Math.PI / 2 },
    { w: FD, pos: { x: HALF_W, y: FH / 2, z: 0 },  ry: -Math.PI / 2 },
  ];

  for (const w of wallDefs) {
    const upper = box(w.w, FH, 0.3, wallMat, w.pos, 0, w.ry);
    upper.receiveShadow = true;
    root.add(upper);
    const lowerPos = { x: w.pos.x, y: 0.6, z: w.pos.z };
    const lower = box(w.w, 1.2, 0.35, lowerMat, lowerPos, 0, w.ry);
    lower.receiveShadow = true;
    root.add(lower);
  }

  // 🆕 نوافذ علوية مضيئة (ضوء نهار) على الجدارين الجانبيين
  const winMat = new THREE.MeshStandardMaterial({
    color: 0xbfdcff, emissive: 0x9fc8f0, emissiveIntensity: 0.55,
    roughness: 0.2, metalness: 0.1,
  });
  const frameMat = mat(0x4a525a, { roughness: 0.5, metalness: 0.6 });
  for (const side of [-1, 1]) {
    for (let z = -HALF_D + 6; z <= HALF_D - 6; z += 8) {
      const frame = box(0.12, 2.0, 3.2, frameMat, { x: side * (HALF_W - 0.18), y: FH - 2.2, z });
      root.add(frame);
      const glass = new THREE.Mesh(new THREE.PlaneGeometry(2.9, 1.7), winMat);
      glass.position.set(side * (HALF_W - 0.26), FH - 2.2, z);
      glass.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
      root.add(glass);
      // قضبان النافذة
      const bar = box(0.05, 1.8, 0.06, frameMat, { x: side * (HALF_W - 0.24), y: FH - 2.2, z });
      root.add(bar);
    }
  }

  // 🆕 باب مصنع كبير (Roller Door) على الجدار الأمامي
  const doorTex = makeRollerDoorTexture();
  const doorMat = new THREE.MeshStandardMaterial({ map: doorTex, roughness: 0.55, metalness: 0.55 });
  const door = new THREE.Mesh(new THREE.PlaneGeometry(6, 5), doorMat);
  door.position.set(10, 2.5, HALF_D - 0.18);
  door.rotation.y = Math.PI;
  root.add(door);
  // إطار الباب بشريط تحذيري
  const doorFrameMat = mat(COL.caution, { roughness: 0.5 });
  root.add(box(0.3, 5.2, 0.15, doorFrameMat, { x: 10 - 3.15, y: 2.6, z: HALF_D - 0.2 }));
  root.add(box(0.3, 5.2, 0.15, doorFrameMat, { x: 10 + 3.15, y: 2.6, z: HALF_D - 0.2 }));
  root.add(box(6.6, 0.3, 0.15, doorFrameMat, { x: 10, y: 5.25, z: HALF_D - 0.2 }));
  // علبة محرك الباب
  root.add(box(6.6, 0.5, 0.5, mat(0x3a4048, { metalness: 0.6 }), { x: 10, y: 5.7, z: HALF_D - 0.35 }));

  // 🆕 لافتة EXIT مضيئة فوق الباب
  const exitCanvas = document.createElement('canvas');
  exitCanvas.width = 128; exitCanvas.height = 48;
  const eg = exitCanvas.getContext('2d');
  eg.fillStyle = '#0a3d1a'; eg.fillRect(0, 0, 128, 48);
  eg.fillStyle = '#33ff66'; eg.font = 'bold 32px Arial'; eg.textAlign = 'center';
  eg.fillText('EXIT', 64, 36);
  const exitMat = new THREE.MeshStandardMaterial({
    map: new THREE.CanvasTexture(exitCanvas),
    emissive: 0x22cc44, emissiveIntensity: 0.7,
  });
  const exitSign = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.45), exitMat);
  exitSign.position.set(10, 6.3, HALF_D - 0.25);
  exitSign.rotation.y = Math.PI;
  root.add(exitSign);
}

// ──────────────────────────────────────────────────
//  سقف + عوارض بجمالونات (Trusses)
// ──────────────────────────────────────────────────
function buildCeiling(root) {
  const ceilMat = mat(COL.ceiling, { roughness: 0.9, metalness: 0.02, side: THREE.DoubleSide });
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(FW, FD), ceilMat);
  ceil.position.y = FH;
  ceil.rotation.x = Math.PI / 2;
  ceil.receiveShadow = true;
  root.add(ceil);

  const beamMat = mat(COL.beam, { roughness: 0.5, metalness: 0.6 });
  const beamCount = 7;
  for (let i = 0; i < beamCount; i++) {
    const z = -HALF_D + 4 + i * (FD - 8) / (beamCount - 1);
    root.add(box(FW - 1, 0.6, 0.15, beamMat, { x: 0, y: FH - 0.3, z }));
    root.add(box(FW - 1, 0.08, 0.4, beamMat, { x: 0, y: FH - 0.6, z }));
    root.add(box(FW - 1, 0.08, 0.4, beamMat, { x: 0, y: FH - 0.04, z }));

    // 🆕 قضبان جمالون مائلة (تبدو كهيكل V متكرر)
    for (let x = -HALF_W + 4; x < HALF_W - 4; x += 4) {
      const d1 = box(0.06, 0.7, 0.06, beamMat, { x: x + 1, y: FH - 0.32, z }, 0, 0, 0.62);
      const d2 = box(0.06, 0.7, 0.06, beamMat, { x: x + 3, y: FH - 0.32, z }, 0, 0, -0.62);
      root.add(d1); root.add(d2);
    }
  }

  // 🆕 شرائح سكاي لايت (إضاءة نهارية من السقف)
  const skyMat = new THREE.MeshStandardMaterial({
    color: 0xcfe4ff, emissive: 0xb8d4f5, emissiveIntensity: 0.45,
    roughness: 0.3, side: THREE.DoubleSide,
  });
  for (const z of [-12, 0, 12]) {
    const sky = new THREE.Mesh(new THREE.PlaneGeometry(FW - 16, 2.2), skyMat);
    sky.position.set(0, FH - 0.02, z);
    sky.rotation.x = Math.PI / 2;
    root.add(sky);
  }
}

// ──────────────────────────────────────────────────
//  رفوف صناعية (Pallet Racks)
// ──────────────────────────────────────────────────
function buildShelves(root) {
  const postMat = mat(COL.shelfPost, { roughness: 0.5, metalness: 0.4 });
  const shelfMat = mat(COL.shelf, { roughness: 0.55, metalness: 0.45 });

  const shelfDefs = [
    { x: 18, z: -8,  rot: 0, levels: 4, length: 12 },
    { x: 18, z: 4,   rot: 0, levels: 4, length: 12 },
    { x: -18, z: -8, rot: 0, levels: 4, length: 12 },
    { x: -18, z: 4,  rot: 0, levels: 4, length: 12 },
    { x: 0,  z: -22, rot: Math.PI / 2, levels: 3, length: 16 },
    { x: -14, z: 18, rot: Math.PI / 2, levels: 3, length: 8 },
  ];

  for (const def of shelfDefs) {
    buildOneShelf(root, def, postMat, shelfMat);
  }
}

function buildOneShelf(root, def, postMat, shelfMat) {
  const { x, z, rot, levels, length } = def;
  const depth = 1.2;
  const postH = levels * 1.5 + 0.5;
  const postW = 0.1;
  const shelfThick = 0.06;
  const postCount = Math.ceil(length / 3) + 1;

  const group = new THREE.Group();
  group.position.set(x, 0, z);
  group.rotation.y = rot;

  for (let p = 0; p < postCount; p++) {
    const px = -length / 2 + p * (length / (postCount - 1));
    for (const dz of [-depth / 2, depth / 2]) {
      group.add(box(postW, postH, postW, postMat, { x: px, y: postH / 2, z: dz }));
    }
  }

  for (let lv = 0; lv < levels; lv++) {
    const y = 0.5 + lv * 1.5;
    group.add(box(length, shelfThick, depth, shelfMat, { x: 0, y, z: 0 }));
  }

  for (let lv = 0; lv < levels; lv++) {
    const y = 0.5 + lv * 1.5 - 0.15;
    for (let p = 0; p < postCount - 1; p++) {
      const px = -length / 2 + p * (length / (postCount - 1)) + (length / (postCount - 1)) / 2;
      group.add(box(length / (postCount - 1) - 0.1, 0.05, 0.05, shelfMat, { x: px, y, z: 0 }));
    }
  }

  // 🆕 واقيات أعمدة صفراء عند طرفي الرف
  const guardMat = mat(COL.caution, { roughness: 0.55 });
  [-length / 2, length / 2].forEach(px => {
    group.add(box(0.25, 0.4, depth + 0.3, guardMat, { x: px, y: 0.2, z: 0 }));
  });

  root.add(group);
}

// ──────────────────────────────────────────────────
//  صناديق كرتونية واقعية على الرفوف
// ──────────────────────────────────────────────────
function buildShelfBoxes(root) {
  const cardboardTex = makeCardboardTexture();
  const boxMats = [
    new THREE.MeshStandardMaterial({ map: cardboardTex, roughness: 0.88, metalness: 0 }),
    new THREE.MeshStandardMaterial({ map: cardboardTex, color: 0xddc8a8, roughness: 0.88, metalness: 0 }),
    new THREE.MeshStandardMaterial({ map: cardboardTex, color: 0xc8a878, roughness: 0.88, metalness: 0 }),
  ];

  const shelfConfigs = [
    { x: 18, z: -8, rot: 0, length: 12, levels: 4 },
    { x: 18, z: 4,  rot: 0, length: 12, levels: 4 },
    { x: -18, z: -8, rot: 0, length: 12, levels: 4 },
    { x: -18, z: 4,  rot: 0, length: 12, levels: 4 },
    { x: 0,  z: -22, rot: Math.PI / 2, length: 16, levels: 3 },
    { x: -14, z: 18, rot: Math.PI / 2, length: 8, levels: 3 },
  ];

  for (const sc of shelfConfigs) {
    for (let lv = 0; lv < sc.levels; lv++) {
      const y = 0.5 + lv * 1.5 + 0.25;
      const count = Math.floor(sc.length / 1.2);
      for (let b = 0; b < count; b++) {
        if (Math.random() < 0.25) continue;
        const localX = -sc.length / 2 + 0.6 + b * 1.1 + (Math.random() - 0.5) * 0.15;
        const localZ = (Math.random() - 0.5) * 0.4;
        const size = 0.3 + Math.random() * 0.25;

        const cos = Math.cos(sc.rot);
        const sin = Math.sin(sc.rot);
        const wx = sc.x + localX * cos - localZ * sin;
        const wz = sc.z + localX * sin + localZ * cos;

        const bMat = boxMats[Math.floor(Math.random() * boxMats.length)];
        const bm = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), bMat);
        bm.position.set(wx, y, wz);
        bm.rotation.y = Math.random() * 0.3 - 0.15;
        bm.castShadow = true;
        root.add(bm);

        // 🆕 أحياناً صندوق ثانٍ مكدّس فوقه
        if (Math.random() < 0.3 && lv < sc.levels - 1) {
          const s2 = size * 0.8;
          const bm2 = new THREE.Mesh(new THREE.BoxGeometry(s2, s2, s2), bMat);
          bm2.position.set(wx + (Math.random() - 0.5) * 0.06, y + size / 2 + s2 / 2, wz);
          bm2.rotation.y = Math.random() * 0.4 - 0.2;
          bm2.castShadow = true;
          root.add(bm2);
        }
      }
    }
  }
}

// ──────────────────────────────────────────────────
//  أحزمة نقل
// ──────────────────────────────────────────────────
function buildConveyors(root) {
  const beltMat = mat(COL.conveyor, { roughness: 0.6, metalness: 0.3 });
  const rollMat = mat(COL.convRoll, { roughness: 0.4, metalness: 0.6 });
  const frameMat = mat(0x555560, { roughness: 0.5, metalness: 0.5 });

  const conveyors = [
    { x: 8, z: 12, rot: 0, len: 10 },
    { x: -8, z: -14, rot: Math.PI / 4, len: 8 },
  ];

  for (const cv of conveyors) {
    const g = new THREE.Group();
    g.position.set(cv.x, 0, cv.z);
    g.rotation.y = cv.rot;

    const legH = 0.9;
    for (const side of [-0.45, 0.45]) {
      g.add(box(cv.len, 0.08, 0.06, frameMat, { x: 0, y: legH, z: side }));
      for (let lx = -cv.len / 2 + 0.5; lx <= cv.len / 2 - 0.5; lx += 2) {
        g.add(box(0.06, legH, 0.06, frameMat, { x: lx, y: legH / 2, z: side }));
      }
    }

    g.add(box(cv.len - 0.2, 0.04, 0.8, beltMat, { x: 0, y: legH + 0.04, z: 0 }));

    const rollGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.8, 8);
    for (let rx = -cv.len / 2 + 0.3; rx <= cv.len / 2 - 0.3; rx += 0.5) {
      const roll = new THREE.Mesh(rollGeo, rollMat);
      roll.position.set(rx, legH - 0.02, 0);
      roll.rotation.x = Math.PI / 2;
      g.add(roll);
    }

    // 🆕 صناديق كرتونية على الحزام
    const cTex = makeCardboardTexture();
    const cMat = new THREE.MeshStandardMaterial({ map: cTex, roughness: 0.88 });
    for (let i = 0; i < 3; i++) {
      const s = 0.32 + Math.random() * 0.12;
      const bm = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), cMat);
      bm.position.set(-cv.len / 2 + 1.2 + i * (cv.len / 3.2), legH + 0.06 + s / 2, 0);
      bm.rotation.y = Math.random() * 0.4;
      bm.castShadow = true;
      g.add(bm);
    }

    root.add(g);
  }
}

// ──────────────────────────────────────────────────
//  براميل
// ──────────────────────────────────────────────────
function buildBarrels(root) {
  const bMat = mat(COL.barrel, { roughness: 0.5, metalness: 0.35 });
  const bMatRed = mat(0xaa3322, { roughness: 0.5, metalness: 0.35 });
  const topMat = mat(COL.barrelTop, { roughness: 0.4, metalness: 0.5 });
  const barrelGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.9, 14);
  const topGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.04, 14);
  const ringGeo = new THREE.TorusGeometry(0.355, 0.018, 6, 16);

  const positions = [
    { x: 22, z: 18 }, { x: 22.8, z: 18 }, { x: 22.4, z: 18.7 },
    { x: -22, z: -18 }, { x: -22.8, z: -18 }, { x: -22.4, z: -17.3 },
    { x: 22, z: -20 }, { x: 22.8, z: -20 },
    { x: 22.4, z: 18.35, stack: true },
  ];

  let n = 0;
  for (const p of positions) {
    const y = p.stack ? 1.35 : 0.45;
    const material = (n++ % 3 === 2) ? bMatRed : bMat;   // 🆕 تنويع الألوان
    const barrel = new THREE.Mesh(barrelGeo, material);
    barrel.position.set(p.x, y, p.z);
    barrel.castShadow = true;
    root.add(barrel);

    // 🆕 حلقتا تقوية حول البرميل
    for (const ry of [-0.22, 0.22]) {
      const ring = new THREE.Mesh(ringGeo, topMat);
      ring.position.set(p.x, y + ry, p.z);
      ring.rotation.x = Math.PI / 2;
      root.add(ring);
    }

    const top = new THREE.Mesh(topGeo, topMat);
    top.position.set(p.x, y + 0.47, p.z);
    root.add(top);
  }
}

// ──────────────────────────────────────────────────
//  طبليات خشبية
// ──────────────────────────────────────────────────
function buildPallets(root) {
  const palletMat = mat(COL.pallet, { roughness: 0.9, metalness: 0.0 });

  const palletPositions = [
    { x: 12, z: -4 }, { x: 12, z: -2.5 },
    { x: -10, z: 10 }, { x: -10, z: 11.5 },
    { x: 6, z: -18 },
  ];

  for (const p of palletPositions) {
    buildOnePallet(root, p.x, p.z, palletMat);
  }
}

function buildOnePallet(root, x, z, palletMat) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);

  for (let i = -2; i <= 2; i++) {
    g.add(box(1.2, 0.04, 0.22, palletMat, { x: 0, y: 0.14, z: i * 0.25 }));
  }
  for (const bx of [-0.45, 0, 0.45]) {
    for (const bz of [-0.4, 0, 0.4]) {
      g.add(box(0.12, 0.1, 0.12, palletMat, { x: bx, y: 0.05, z: bz }));
    }
  }
  for (const bz of [-0.4, 0, 0.4]) {
    g.add(box(1.2, 0.03, 0.15, palletMat, { x: 0, y: 0.0, z: bz }));
  }

  root.add(g);
}

// ──────────────────────────────────────────────────
//  خطوط أمان + ممر مشاة + مناطق مرقّمة
// ──────────────────────────────────────────────────
function buildFloorMarkings(root) {
  const lineMat = mat(COL.floorLine, { roughness: 0.6, metalness: 0.1 });

  const lines = [
    { x: 0, z: 0, w: 40, d: 0.12, ry: 0 },
    { x: 0, z: 0, w: 40, d: 0.12, ry: Math.PI / 2 },
  ];

  for (const l of lines) {
    root.add(box(l.w, 0.01, l.d, lineMat, { x: l.x, y: 0.005, z: l.z }, 0, l.ry));
  }

  // أسهم اتجاه
  const arrowMat = mat(0xffffff, { roughness: 0.5, metalness: 0.1 });
  const arrowPositions = [
    { x: 5, z: 0, ry: -Math.PI / 2 },
    { x: -5, z: 0, ry: Math.PI / 2 },
    { x: 0, z: 5, ry: Math.PI },
    { x: 0, z: -5, ry: 0 },
  ];

  for (const a of arrowPositions) {
    const arrowShape = new THREE.Shape();
    arrowShape.moveTo(0, 0.3);
    arrowShape.lineTo(-0.2, -0.1);
    arrowShape.lineTo(0.2, -0.1);
    arrowShape.closePath();

    const geo = new THREE.ShapeGeometry(arrowShape);
    const arrow = new THREE.Mesh(geo, arrowMat);
    arrow.rotation.x = -Math.PI / 2;
    arrow.rotation.z = a.ry;
    arrow.position.set(a.x, 0.008, a.z);
    root.add(arrow);
  }

  // 🆕 ممر مشاة (Zebra) أمام الباب
  const zebraMat = mat(0xffffff, { roughness: 0.6 });
  for (let i = 0; i < 6; i++) {
    root.add(box(0.5, 0.01, 3.4, zebraMat, { x: 7.6 + i * 0.95, y: 0.006, z: HALF_D - 4 }));
  }

  // 🆕 منطقة محظورة بخطوط مائلة (تحت الرف الأمامي)
  const hatchMat = mat(COL.floorLine, { roughness: 0.6 });
  for (let i = 0; i < 7; i++) {
    root.add(box(2.6, 0.01, 0.12, hatchMat, { x: -14, y: 0.006, z: 15.4 + i * 0.85 }, 0, Math.PI / 4));
  }

  // 🆕 ملصقات أرضية "ZONE A / ZONE B"
  function zoneLabel(text, x, z, color) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 96;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 256, 96);
    g.fillStyle = color;
    g.font = 'bold 56px Arial';
    g.textAlign = 'center';
    g.fillText(text, 128, 66);
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(3.2, 1.2),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true })
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.009, z);
    root.add(m);
  }
  zoneLabel('ZONE A', 13, -1, 'rgba(255,255,255,0.75)');
  zoneLabel('ZONE B', -13, -1, 'rgba(255,255,255,0.75)');
}

// ──────────────────────────────────────────────────
//  تصادمات فيزيائية
// ──────────────────────────────────────────────────
let factoryBodies = [];

function addStaticBox(world, gndMat, hw, hh, hd, px, py, pz, ry = 0) {
  const body = new CANNON.Body({
    mass: 0,
    material: gndMat,
    collisionFilterGroup: 1,
    collisionFilterMask: -1,
  });
  body.addShape(new CANNON.Box(new CANNON.Vec3(hw, hh, hd)));
  body.position.set(px, py, pz);
  if (ry) body.quaternion.setFromEuler(0, ry, 0);
  world.addBody(body);
  factoryBodies.push(body);
  return body;
}

function buildPhysics(world, gndMat) {
  // ── جدران ──
  addStaticBox(world, gndMat, FW / 2, FH / 2, 0.15,  0, FH / 2, -HALF_D);
  addStaticBox(world, gndMat, FW / 2, FH / 2, 0.15,  0, FH / 2,  HALF_D);
  addStaticBox(world, gndMat, 0.15, FH / 2, FD / 2, -HALF_W, FH / 2, 0);
  addStaticBox(world, gndMat, 0.15, FH / 2, FD / 2,  HALF_W, FH / 2, 0);

  // ── أعمدة الدعم ──
  const colPositions = [
    { x: -12, z: -12 }, { x: 12, z: -12 },
    { x: -12, z: 12 },  { x: 12, z: 12 },
    { x: -12, z: 0 },   { x: 12, z: 0 },
  ];
  for (const cp of colPositions) {
    addStaticBox(world, gndMat, 0.3, FH / 2, 0.3, cp.x, FH / 2, cp.z);
  }

  // ── رفوف ──
  const shelfDefs = [
    { x: 18, z: -8,  rot: 0, levels: 4, length: 12 },
    { x: 18, z: 4,   rot: 0, levels: 4, length: 12 },
    { x: -18, z: -8, rot: 0, levels: 4, length: 12 },
    { x: -18, z: 4,  rot: 0, levels: 4, length: 12 },
    { x: 0,  z: -22, rot: Math.PI / 2, levels: 3, length: 16 },
    { x: -14, z: 18, rot: Math.PI / 2, levels: 3, length: 8 },
  ];
  for (const sd of shelfDefs) {
    const depth = 1.2;
    const h = sd.levels * 1.5 + 0.5;
    addStaticBox(world, gndMat, sd.length / 2, h / 2, depth / 2, sd.x, h / 2, sd.z, sd.rot);
  }

  // ── أحزمة نقل ──
  const conveyors = [
    { x: 8, z: 12, rot: 0, len: 10 },
    { x: -8, z: -14, rot: Math.PI / 4, len: 8 },
  ];
  for (const cv of conveyors) {
    addStaticBox(world, gndMat, cv.len / 2, 0.5, 0.5, cv.x, 0.5, cv.z, cv.rot);
  }

  // ── براميل ──
  const barrelPositions = [
    { x: 22, z: 18 }, { x: 22.8, z: 18 }, { x: 22.4, z: 18.7 },
    { x: -22, z: -18 }, { x: -22.8, z: -18 }, { x: -22.4, z: -17.3 },
    { x: 22, z: -20 }, { x: 22.8, z: -20 },
    { x: 22.4, z: 18.35 },
  ];
  for (const bp of barrelPositions) {
    const y = (bp.x === 22.4 && bp.z === 18.35) ? 1.35 : 0.45;
    addStaticBox(world, gndMat, 0.35, 0.45, 0.35, bp.x, y, bp.z);
  }

  // ── طبليات ──
  const palletPositions = [
    { x: 12, z: -4 }, { x: 12, z: -2.5 },
    { x: -10, z: 10 }, { x: -10, z: 11.5 },
    { x: 6, z: -18 },
  ];
  for (const pp of palletPositions) {
    addStaticBox(world, gndMat, 0.6, 0.1, 0.55, pp.x, 0.1, pp.z);
  }

  // ── أنبوب التهوية ──
  addStaticBox(world, gndMat, 0.2, FH / 2, 0.2, 24, FH / 2, -24);

  // ── حواجز الأمان ──
  const rails = [
    { x: 5, z: 15, w: 6, d: 0.2, ry: 0 },
    { x: -5, z: -15, w: 6, d: 0.2, ry: Math.PI / 2 }
  ];
  for (const r of rails) {
    addStaticBox(world, gndMat, r.w / 2, 0.6, r.d / 2, r.x, 0.6, r.z, r.ry);
  }

  // 🆕 ── الرافعة الشوكية ──
  addStaticBox(world, gndMat, 1.0, 1.1, 1.6, 17, 1.1, 22, -0.5);
}

// ──────────────────────────────────────────────────
//  أنابيب سقفية
// ──────────────────────────────────────────────────
function buildPipes(root) {
  const pipeMat = mat(COL.pipe, { roughness: 0.35, metalness: 0.6 });
  const yellowPipeMat = mat(0xd8b020, { roughness: 0.4, metalness: 0.5 });   // 🆕 أنبوب غاز أصفر
  const pipeGeo = new THREE.CylinderGeometry(0.08, 0.08, FW - 4, 8);

  const pipeZ = [-15, -5, 5, 15];

  for (const z of pipeZ) {
    const pipe = new THREE.Mesh(pipeGeo, pipeMat);
    pipe.position.set(0, FH - 1, z);
    pipe.rotation.z = Math.PI / 2;
    root.add(pipe);

    const clampGeo = new THREE.TorusGeometry(0.12, 0.025, 6, 8);
    for (let cx = -HALF_W + 5; cx <= HALF_W - 5; cx += 8) {
      const clamp = new THREE.Mesh(clampGeo, pipeMat);
      clamp.position.set(cx, FH - 1, z);
      clamp.rotation.y = Math.PI / 2;
      root.add(clamp);
    }
  }

  // 🆕 أنبوب أصفر إضافي (خط غاز)
  const gasPipe = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, FW - 4, 8), yellowPipeMat);
  gasPipe.position.set(0, FH - 1.4, -10);
  gasPipe.rotation.z = Math.PI / 2;
  root.add(gasPipe);

  const ventPipe = new THREE.Mesh(
    new THREE.CylinderGeometry(0.2, 0.2, FH - 1, 10),
    pipeMat
  );
  ventPipe.position.set(24, (FH - 1) / 2, -24);
  root.add(ventPipe);
}

// ──────────────────────────────────────────────────
//  إضاءة صناعية
// ──────────────────────────────────────────────────
function buildIndustrialLights(root, scene) {
  const lightHousing = mat(0x888888, { roughness: 0.3, metalness: 0.7 });
  const glowMat = new THREE.MeshStandardMaterial({
    color: COL.light,
    emissive: COL.light,
    emissiveIntensity: 0.6,
    roughness: 0.2,
    metalness: 0.0,
  });

  const housGeo = new THREE.BoxGeometry(1.2, 0.15, 0.4);
  const glowGeo = new THREE.PlaneGeometry(1.0, 0.3);

  for (let x = -20; x <= 20; x += 10) {
    for (let z = -20; z <= 20; z += 10) {
      const housing = new THREE.Mesh(housGeo, lightHousing);
      housing.position.set(x, FH - 0.4, z);
      root.add(housing);

      const glow = new THREE.Mesh(glowGeo, glowMat);
      glow.position.set(x, FH - 0.48, z);
      glow.rotation.x = -Math.PI / 2;
      root.add(glow);

      // سلسلتا تعليق 🆕
      for (const dx of [-0.5, 0.5]) {
        const chain = new THREE.Mesh(
          new THREE.CylinderGeometry(0.012, 0.012, 0.32, 6),
          lightHousing
        );
        chain.position.set(x + dx, FH - 0.18, z);
        root.add(chain);
      }

      if (Math.abs(x) <= 10 && Math.abs(z) <= 10) {
        const pl = new THREE.PointLight(0xfff0d0, 0.8, 15);
        pl.position.set(x, FH - 0.6, z);
        scene.add(pl);
      }
    }
  }
}

// ──────────────────────────────────────────────────
//  لوحات تحذيرية
// ──────────────────────────────────────────────────
function buildSigns(root) {
  const signPositions = [
    { x: -HALF_W + 0.2, y: 3, z: 0, ry: Math.PI / 2 },
    { x: HALF_W - 0.2,  y: 3, z: 0, ry: -Math.PI / 2 },
    { x: 0, y: 3, z: -HALF_D + 0.2, ry: 0 },
  ];

  for (const sp of signPositions) {
    const signCanvas = document.createElement('canvas');
    signCanvas.width = 256; signCanvas.height = 128;
    const ctx = signCanvas.getContext('2d');

    ctx.fillStyle = '#ffcc00';
    ctx.fillRect(0, 0, 256, 128);

    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 8;
    ctx.strokeRect(4, 4, 248, 120);

    ctx.fillStyle = '#000000';
    for (let i = 0; i < 256; i += 32) {
      ctx.beginPath();
      ctx.moveTo(i, 0); ctx.lineTo(i + 16, 0); ctx.lineTo(i + 16, 12); ctx.lineTo(i, 12);
      ctx.fill();
    }
    for (let i = 0; i < 256; i += 32) {
      ctx.beginPath();
      ctx.moveTo(i + 16, 116); ctx.lineTo(i + 32, 116); ctx.lineTo(i + 32, 128); ctx.lineTo(i + 16, 128);
      ctx.fill();
    }

    ctx.fillStyle = '#000000';
    ctx.font = 'bold 36px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⚠ CAUTION', 128, 45);
    ctx.font = '18px Arial';
    ctx.fillText('ROBOT AREA', 128, 80);

    const signTex = new THREE.CanvasTexture(signCanvas);
    const signMat = new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.4, metalness: 0.1 });

    const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.75), signMat);
    sign.position.set(sp.x, sp.y, sp.z);
    sign.rotation.y = sp.ry;
    root.add(sign);
  }
}

// ──────────────────────────────────────────────────
//  أعمدة دعم
// ──────────────────────────────────────────────────
function buildColumns(root) {
  const colMat = mat(0x888890, { roughness: 0.4, metalness: 0.5 });
  const warnMat = mat(COL.caution, { roughness: 0.5, metalness: 0.2 });

  const colPositions = [
    { x: -12, z: -12 }, { x: 12, z: -12 },
    { x: -12, z: 12 },  { x: 12, z: 12 },
    { x: -12, z: 0 },   { x: 12, z: 0 },
  ];

  for (const cp of colPositions) {
    root.add(box(0.5, FH, 0.5, colMat, { x: cp.x, y: FH / 2, z: cp.z }));
    root.add(box(0.55, 1.0, 0.55, warnMat, { x: cp.x, y: 0.5, z: cp.z }));
  }
}

// ──────────────────────────────────────────────────
//  حواجز أمان
// ──────────────────────────────────────────────────
function buildGuardRails(root) {
  const railMat = mat(COL.guardRail, { roughness: 0.5, metalness: 0.2 });
  const postMat = mat(0x444444, { roughness: 0.7, metalness: 0.4 });

  const rails = [
    { x: 5, z: 15, w: 6, d: 0.2, ry: 0 },
    { x: -5, z: -15, w: 6, d: 0.2, ry: Math.PI / 2 }
  ];

  for (const r of rails) {
    const g = new THREE.Group();
    g.position.set(r.x, 0, r.z);
    g.rotation.y = r.ry;

    for (const px of [-r.w / 2 + 0.1, 0, r.w / 2 - 0.1]) {
      g.add(box(0.15, 1.2, 0.15, postMat, { x: px, y: 0.6, z: 0 }));
    }
    for (const py of [0.5, 1.0]) {
      g.add(box(r.w, 0.15, 0.08, railMat, { x: 0, y: py, z: 0 }));
    }

    root.add(g);
  }
}

// ──────────────────────────────────────────────────
//  🆕 رافعة شوكية (ديكور ثابت — له جسم فيزيائي)
// ──────────────────────────────────────────────────
function buildForklift(root) {
  const bodyMat = mat(COL.forklift, { roughness: 0.5, metalness: 0.4 });
  const darkMat = mat(0x2a2e33, { roughness: 0.6, metalness: 0.5 });
  const tireMat = mat(0x1c1a18, { roughness: 0.95, metalness: 0.0 });
  const mastMat = mat(0x44484e, { roughness: 0.4, metalness: 0.7 });

  const g = new THREE.Group();
  g.position.set(17, 0, 22);
  g.rotation.y = -0.5;

  // الهيكل + ثقل الموازنة الخلفي
  g.add(box(1.3, 0.8, 1.9, bodyMat, { x: 0, y: 0.85, z: -0.1 }));
  g.add(box(1.2, 0.6, 0.6, darkMat, { x: 0, y: 0.75, z: -1.3 }));
  // قفص السائق
  for (const dx of [-0.55, 0.55]) {
    g.add(box(0.08, 1.1, 0.08, darkMat, { x: dx, y: 1.8, z: 0.5 }));
    g.add(box(0.08, 1.1, 0.08, darkMat, { x: dx, y: 1.8, z: -0.7 }));
  }
  g.add(box(1.25, 0.08, 1.4, darkMat, { x: 0, y: 2.35, z: -0.1 }));
  // المقعد وعجلة القيادة
  g.add(box(0.5, 0.4, 0.5, darkMat, { x: 0, y: 1.45, z: -0.5 }));
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.03, 8, 16), darkMat);
  wheel.rotation.x = -0.9;
  wheel.position.set(0, 1.55, 0.15);
  g.add(wheel);

  // الصاري (Mast) والشوكتان
  for (const dx of [-0.35, 0.35]) {
    g.add(box(0.1, 2.6, 0.1, mastMat, { x: dx, y: 1.3, z: 0.95 }));
  }
  g.add(box(0.85, 0.1, 0.1, mastMat, { x: 0, y: 2.5, z: 0.95 }));
  for (const dx of [-0.3, 0.3]) {
    g.add(box(0.12, 0.05, 1.1, mastMat, { x: dx, y: 0.12, z: 1.6 }));
  }

  // عجلات
  const tireGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.24, 14);
  tireGeo.rotateZ(Math.PI / 2);
  [[-0.65, 0.55], [0.65, 0.55], [-0.6, -1.0], [0.6, -1.0]].forEach(([x, z]) => {
    const t = new THREE.Mesh(tireGeo, tireMat);
    t.position.set(x, 0.32, z);
    t.castShadow = true;
    g.add(t);
  });

  // ضوء تحذير برتقالي على السقف
  const beacon = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.09, 0.12, 10),
    new THREE.MeshStandardMaterial({ color: 0xff8800, emissive: 0xff6600, emissiveIntensity: 0.8 })
  );
  beacon.position.set(0.4, 2.47, -0.1);
  g.add(beacon);

  root.add(g);
}

// ──────────────────────────────────────────────────
//  🆕 معدات الجدران: طفايات حريق + لوحات كهرباء + ساعة
// ──────────────────────────────────────────────────
function buildWallProps(root) {
  // طفايات حريق على الأعمدة
  const extMat = mat(0xcc2211, { roughness: 0.35, metalness: 0.3 });
  const extTopMat = mat(0x222222, { roughness: 0.5, metalness: 0.5 });
  [{ x: -12, z: -12 }, { x: 12, z: 12 }, { x: 12, z: 0 }].forEach(p => {
    const ext = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.45, 10), extMat);
    ext.position.set(p.x + 0.34, 1.0, p.z);
    root.add(ext);
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.12, 8), extTopMat);
    nozzle.position.set(p.x + 0.34, 1.28, p.z);
    root.add(nozzle);
    // لوحة حمراء خلف الطفاية
    root.add(box(0.3, 0.6, 0.02, mat(0xaa1111, { roughness: 0.6 }), { x: p.x + 0.27, y: 1.05, z: p.z }));
  });

  // لوحات كهرباء على الجدار الخلفي
  const panelMat = mat(0x8a9098, { roughness: 0.4, metalness: 0.6 });
  [-8, -4].forEach(x => {
    root.add(box(1.0, 1.6, 0.18, panelMat, { x, y: 1.8, z: -HALF_D + 0.28 }));
    root.add(box(0.9, 0.06, 0.2, mat(0x303438), { x, y: 2.4, z: -HALF_D + 0.3 }));
    // لمبة حالة خضراء
    const led = new THREE.Mesh(
      new THREE.SphereGeometry(0.035, 8, 6),
      new THREE.MeshStandardMaterial({ color: 0x22ff44, emissive: 0x22cc44, emissiveIntensity: 1.0 })
    );
    led.position.set(x + 0.3, 2.2, -HALF_D + 0.38);
    root.add(led);
  });

  // ساعة حائط صناعية
  const clockCanvas = document.createElement('canvas');
  clockCanvas.width = 128; clockCanvas.height = 128;
  const cg = clockCanvas.getContext('2d');
  cg.fillStyle = '#f0f0ea'; cg.beginPath(); cg.arc(64, 64, 60, 0, Math.PI * 2); cg.fill();
  cg.strokeStyle = '#222'; cg.lineWidth = 6; cg.stroke();
  cg.lineWidth = 4;
  cg.beginPath(); cg.moveTo(64, 64); cg.lineTo(64, 26); cg.stroke();
  cg.beginPath(); cg.moveTo(64, 64); cg.lineTo(90, 72); cg.stroke();
  for (let i = 0; i < 12; i++) {
    const a = i * Math.PI / 6;
    cg.fillStyle = '#222';
    cg.fillRect(64 + Math.cos(a) * 50 - 2, 64 + Math.sin(a) * 50 - 2, 4, 4);
  }
  const clock = new THREE.Mesh(
    new THREE.CircleGeometry(0.5, 24),
    new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(clockCanvas), roughness: 0.5 })
  );
  clock.position.set(0, 5.5, -HALF_D + 0.22);
  root.add(clock);
}

// ──────────────────────────────────────────────────
// الكشف عن تصادم الروبوت مع البيئة
// ──────────────────────────────────────────────────
const tmpBox = new THREE.Box3();
export function checkFactoryCollision(robot) {
  if (!robot || typeof robot._computeOverallBox !== 'function') return false;
  robot._computeOverallBox(robot._overallBox);
  for (const body of factoryBodies) {
    if (body.aabbNeedsUpdate) body.updateAABB();
    tmpBox.min.set(body.aabb.lowerBound.x, body.aabb.lowerBound.y, body.aabb.lowerBound.z);
    tmpBox.max.set(body.aabb.upperBound.x, body.aabb.upperBound.y, body.aabb.upperBound.z);
    if (robot._overallBox.intersectsBox(tmpBox)) return true;
  }
  return false;
}
