import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160/build/three.module.js";
import * as CANNON from "https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js";

/**
 * Factory Environment — واقعي ، أداء سلس
 * يُنشئ بيئة مصنع كبيرة ثلاثية الأبعاد:
 *   أرضية صناعية — جدران — سقف — عوارض — رفوف — صناديق — أحزمة نقل
 *   حواجز أمان — أعمدة — إضاءة صناعية — أنابيب — براميل — لوحات تحذيرية
 */

// ─── مقاسات المصنع ───
const FW = 60;   // عرض
const FD = 60;   // عمق
const FH = 12;   // ارتفاع
const HALF_W = FW / 2;
const HALF_D = FD / 2;

// ─── ألوان صناعية واقعية ───
const COL = {
  floor:     0x5a5a5a,   // خرسانة رمادية داكنة
  floorLine: 0xe8c831,   // خطوط أمان صفراء
  wall:      0xd4cfc5,   // جدران بيج صناعي
  wallLower: 0x7a8a7a,   // حزام سفلي أخضر رمادي
  ceiling:   0xe0ddd5,   // سقف فاتح
  beam:      0x606870,   // عوارض معدنية
  shelf:     0x4a6a8a,   // رفوف أزرق صناعي
  shelfPost: 0xd07020,   // أعمدة رفوف برتقالي
  pallet:    0x9e7e4a,   // طبليات خشبية
  pipe:      0x889098,   // أنابيب فضية
  barrel:    0x2255aa,   // براميل زرقاء
  barrelTop: 0x44444c,   // غطاء البرميل
  conveyor:  0x383c42,   // حزام النقل
  convRoll:  0x666e76,   // بكرات الحزام
  caution:   0xffcc00,   // أصفر تحذيري
  guardRail: 0xcccc22,   // حواجز أمان
  light:     0xfff8e0,   // إضاءة دافئة
  sign:      0xdd3322,   // لافتة حمراء
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

// ══════════════════════════════════════════════════
//  buildFactory(scene, world, groundMaterial)
//  ← المدخل الرئيسي — يبني البيئة + التصادمات
// ══════════════════════════════════════════════════
export function buildFactory(scene, world, groundMaterial) {
  const root = new THREE.Group();
  root.name = 'factory';

  // ═══════════ أرضية خرسانية ═══════════
  buildFloor(root);

  // ═══════════ جدران ═══════════
  buildWalls(root);

  // ═══════════ سقف + عوارض ═══════════
  buildCeiling(root);

  // ═══════════ رفوف صناعية ═══════════
  buildShelves(root);

  // ═══════════ صناديق على الرفوف ═══════════
  buildShelfBoxes(root);

  // ═══════════ أحزمة نقل ═══════════
  buildConveyors(root);

  // ═══════════ براميل ═══════════
  buildBarrels(root);

  // ═══════════ طبليات خشبية ═══════════
  buildPallets(root);

  // ═══════════ خطوط أمان على الأرض ═══════════
  buildFloorMarkings(root);

  // ═══════════ أنابيب سقفية ═══════════
  buildPipes(root);

  // ═══════════ إضاءة صناعية ═══════════
  buildIndustrialLights(root, scene);

  // ═══════════ لوحات تحذيرية ═══════════
  buildSigns(root);

  // ═══════════ أعمدة دعم ═══════════
  buildColumns(root);

  // ═══════════ حواجز أمان ═══════════
  buildGuardRails(root);

  // ═══════════ تصادمات فيزيائية ═══════════
  if (world) buildPhysics(world, groundMaterial);

  scene.add(root);
  return root;
}

// ──────────────────────────────────────────────────
//  أرضية
// ──────────────────────────────────────────────────
function buildFloor(root) {
  // أرضية خرسانية بتكسشر إجرائي
  const floorCanvas = document.createElement('canvas');
  floorCanvas.width = 512; floorCanvas.height = 512;
  const ctx = floorCanvas.getContext('2d');
  
  // قاعدة خرسانية
  ctx.fillStyle = '#6b6b6b';
  ctx.fillRect(0, 0, 512, 512);
  
  // تأثير الخرسانة — نقاط عشوائية
  for (let i = 0; i < 3000; i++) {
    const x = Math.random() * 512;
    const y = Math.random() * 512;
    const s = Math.random() * 2 + 0.5;
    const a = Math.random() * 0.15;
    ctx.fillStyle = Math.random() > 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
    ctx.fillRect(x, y, s, s);
  }
  
  // خطوط الفواصل الخرسانية
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= 4; i++) {
    ctx.beginPath(); ctx.moveTo(i * 128, 0); ctx.lineTo(i * 128, 512); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i * 128); ctx.lineTo(512, i * 128); ctx.stroke();
  }
  
  const floorTex = new THREE.CanvasTexture(floorCanvas);
  floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
  floorTex.repeat.set(8, 8);
  floorTex.anisotropy = 4;
  
  const floorMat = new THREE.MeshStandardMaterial({
    map: floorTex,
    roughness: 0.85,
    metalness: 0.05,
  });
  
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(FW, FD), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  root.add(floor);
}

// ──────────────────────────────────────────────────
//  جدران
// ──────────────────────────────────────────────────
function buildWalls(root) {
  const wallMat = mat(COL.wall, { roughness: 0.85, metalness: 0.02 });
  const lowerMat = mat(COL.wallLower, { roughness: 0.7, metalness: 0.05 });
  
  const wallDefs = [
    { w: FW, pos: { x: 0, y: FH / 2, z: -HALF_D }, ry: 0 },
    { w: FW, pos: { x: 0, y: FH / 2, z: HALF_D },  ry: Math.PI },
    { w: FD, pos: { x: -HALF_W, y: FH / 2, z: 0 }, ry: Math.PI / 2 },
    { w: FD, pos: { x: HALF_W, y: FH / 2, z: 0 },  ry: -Math.PI / 2 },
  ];
  
  for (const w of wallDefs) {
    // جدار علوي
    const upper = box(w.w, FH, 0.3, wallMat, w.pos, 0, w.ry);
    upper.receiveShadow = true;
    root.add(upper);
    // حزام سفلي (1.2 م)
    const lowerPos = { x: w.pos.x, y: 0.6, z: w.pos.z };
    const lower = box(w.w, 1.2, 0.35, lowerMat, lowerPos, 0, w.ry);
    lower.receiveShadow = true;
    root.add(lower);
  }
}

// ──────────────────────────────────────────────────
//  سقف + عوارض
// ──────────────────────────────────────────────────
function buildCeiling(root) {
  const ceilMat = mat(COL.ceiling, { roughness: 0.9, metalness: 0.02, side: THREE.DoubleSide });
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(FW, FD), ceilMat);
  ceil.position.y = FH;
  ceil.rotation.x = Math.PI / 2;
  ceil.receiveShadow = true;
  root.add(ceil);
  
  // عوارض معدنية على شكل I-beam
  const beamMat = mat(COL.beam, { roughness: 0.5, metalness: 0.6 });
  const beamCount = 7;
  for (let i = 0; i < beamCount; i++) {
    const z = -HALF_D + 4 + i * (FD - 8) / (beamCount - 1);
    // الشريط الرئيسي
    const main = box(FW - 1, 0.6, 0.15, beamMat, { x: 0, y: FH - 0.3, z });
    root.add(main);
    // الشريط السفلي
    const bottom = box(FW - 1, 0.08, 0.4, beamMat, { x: 0, y: FH - 0.6, z });
    root.add(bottom);
    // الشريط العلوي
    const top = box(FW - 1, 0.08, 0.4, beamMat, { x: 0, y: FH - 0.04, z });
    root.add(top);
  }
}

// ──────────────────────────────────────────────────
//  رفوف صناعية (Pallet Racks)
// ──────────────────────────────────────────────────
function buildShelves(root) {
  const postMat = mat(COL.shelfPost, { roughness: 0.5, metalness: 0.4 });
  const shelfMat = mat(COL.shelf, { roughness: 0.55, metalness: 0.45 });
  
  const shelfDefs = [
    // يمين — صفّين
    { x: 18, z: -8,  rot: 0, levels: 4, length: 12 },
    { x: 18, z: 4,   rot: 0, levels: 4, length: 12 },
    // يسار — صفّين
    { x: -18, z: -8, rot: 0, levels: 4, length: 12 },
    { x: -18, z: 4,  rot: 0, levels: 4, length: 12 },
    // خلف
    { x: 0,  z: -22, rot: Math.PI / 2, levels: 3, length: 16 },
    // أمام يسار
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
  
  // أعمدة
  for (let p = 0; p < postCount; p++) {
    const px = -length / 2 + p * (length / (postCount - 1));
    // أمام وخلف
    for (const dz of [-depth / 2, depth / 2]) {
      const post = box(postW, postH, postW, postMat, { x: px, y: postH / 2, z: dz });
      group.add(post);
    }
  }
  
  // الرفوف (المستويات)
  for (let lv = 0; lv < levels; lv++) {
    const y = 0.5 + lv * 1.5;
    const shelf = box(length, shelfThick, depth, shelfMat, { x: 0, y, z: 0 });
    group.add(shelf);
  }
  
  // دعامات أفقية بين الأعمدة (قضبان X)
  for (let lv = 0; lv < levels; lv++) {
    const y = 0.5 + lv * 1.5 - 0.15;
    for (let p = 0; p < postCount - 1; p++) {
      const px = -length / 2 + p * (length / (postCount - 1)) + (length / (postCount - 1)) / 2;
      const brace = box(length / (postCount - 1) - 0.1, 0.05, 0.05, shelfMat, { x: px, y, z: 0 });
      group.add(brace);
    }
  }
  
  root.add(group);
}

// ──────────────────────────────────────────────────
//  صناديق زخرفية على الرفوف (ثابتة بصرياً)
// ──────────────────────────────────────────────────
function buildShelfBoxes(root) {
  const colors = [0xc8964b, 0xb8863b, 0xd8a65b, 0xa07030, 0xc09050];
  
  const boxDefs = [];
  
  // ملء الرفوف بصناديق
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
        if (Math.random() < 0.25) continue; // بعض الفراغات لإحساس واقعي
        const localX = -sc.length / 2 + 0.6 + b * 1.1 + (Math.random() - 0.5) * 0.15;
        const localZ = (Math.random() - 0.5) * 0.4;
        const size = 0.3 + Math.random() * 0.25;
        
        // تحويل الإحداثيات المحلية للرف إلى عالمية
        const cos = Math.cos(sc.rot);
        const sin = Math.sin(sc.rot);
        const wx = sc.x + localX * cos - localZ * sin;
        const wz = sc.z + localX * sin + localZ * cos;
        
        boxDefs.push({ x: wx, y, z: wz, s: size, c: colors[Math.floor(Math.random() * colors.length)] });
      }
    }
  }
  
  // إنشاء الصناديق
  for (const bd of boxDefs) {
    const bMat = mat(bd.c, { roughness: 0.85, metalness: 0.0 });
    const bm = box(bd.s, bd.s, bd.s, bMat, { x: bd.x, y: bd.y, z: bd.z });
    bm.rotation.y = Math.random() * 0.3 - 0.15;
    root.add(bm);
  }
}

// ──────────────────────────────────────────────────
//  أحزمة نقل (Conveyor Belts)
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
    
    // الإطار الجانبي
    const legH = 0.9;
    for (const side of [-0.45, 0.45]) {
      const rail = box(cv.len, 0.08, 0.06, frameMat, { x: 0, y: legH, z: side });
      g.add(rail);
      // أرجل
      for (let lx = -cv.len / 2 + 0.5; lx <= cv.len / 2 - 0.5; lx += 2) {
        const leg = box(0.06, legH, 0.06, frameMat, { x: lx, y: legH / 2, z: side });
        g.add(leg);
      }
    }
    
    // سطح الحزام
    const belt = box(cv.len - 0.2, 0.04, 0.8, beltMat, { x: 0, y: legH + 0.04, z: 0 });
    g.add(belt);
    
    // البكرات
    const rollGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.8, 8);
    for (let rx = -cv.len / 2 + 0.3; rx <= cv.len / 2 - 0.3; rx += 0.5) {
      const roll = new THREE.Mesh(rollGeo, rollMat);
      roll.position.set(rx, legH - 0.02, 0);
      roll.rotation.x = Math.PI / 2;
      g.add(roll);
    }
    
    root.add(g);
  }
}

// ──────────────────────────────────────────────────
//  براميل
// ──────────────────────────────────────────────────
function buildBarrels(root) {
  const bMat = mat(COL.barrel, { roughness: 0.5, metalness: 0.35 });
  const topMat = mat(COL.barrelTop, { roughness: 0.4, metalness: 0.5 });
  const barrelGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.9, 12);
  const topGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.04, 12);
  
  const positions = [
    { x: 22, z: 18 }, { x: 22.8, z: 18 }, { x: 22.4, z: 18.7 },
    { x: -22, z: -18 }, { x: -22.8, z: -18 }, { x: -22.4, z: -17.3 },
    { x: 22, z: -20 }, { x: 22.8, z: -20 },
    // براميل مكدسة
    { x: 22.4, z: 18.35, stack: true },
  ];
  
  for (const p of positions) {
    const y = p.stack ? 1.35 : 0.45;
    const barrel = new THREE.Mesh(barrelGeo, bMat);
    barrel.position.set(p.x, y, p.z);
    barrel.castShadow = true;
    root.add(barrel);
    
    const top = new THREE.Mesh(topGeo, topMat);
    top.position.set(p.x, y + 0.47, p.z);
    root.add(top);
  }
}

// ──────────────────────────────────────────────────
//  طبليات خشبية (Pallets)
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
  
  // الألواح العلوية
  for (let i = -2; i <= 2; i++) {
    const plank = box(1.2, 0.04, 0.22, palletMat, { x: 0, y: 0.14, z: i * 0.25 });
    g.add(plank);
  }
  // القوائم (الكعوب)
  for (const bx of [-0.45, 0, 0.45]) {
    for (const bz of [-0.4, 0, 0.4]) {
      const block = box(0.12, 0.1, 0.12, palletMat, { x: bx, y: 0.05, z: bz });
      g.add(block);
    }
  }
  // الألواح السفلية
  for (const bz of [-0.4, 0, 0.4]) {
    const bottom = box(1.2, 0.03, 0.15, palletMat, { x: 0, y: 0.0, z: bz });
    g.add(bottom);
  }
  
  root.add(g);
}

// ──────────────────────────────────────────────────
//  خطوط أمان على الأرض
// ──────────────────────────────────────────────────
function buildFloorMarkings(root) {
  const lineMat = mat(COL.floorLine, { roughness: 0.6, metalness: 0.1 });
  
  // خطوط ممرات
  const lines = [
    // ممر رئيسي — أفقي
    { x: 0, z: 0, w: 40, d: 0.12, ry: 0 },
    // ممر رأسي
    { x: 0, z: 0, w: 40, d: 0.12, ry: Math.PI / 2 },
  ];
  
  for (const l of lines) {
    if (l.isRect) {
      // مربع أمان (4 خطوط)
      for (const edge of [
        { x: l.x, z: l.z - l.d / 2, w: l.w, ry: 0 },
        { x: l.x, z: l.z + l.d / 2, w: l.w, ry: 0 },
        { x: l.x - l.w / 2, z: l.z, w: l.d, ry: Math.PI / 2 },
        { x: l.x + l.w / 2, z: l.z, w: l.d, ry: Math.PI / 2 },
      ]) {
        const stripe = box(edge.w, 0.01, 0.12, lineMat, { x: edge.x, y: 0.005, z: edge.z }, 0, edge.ry);
        root.add(stripe);
      }
    } else {
      const stripe = box(l.w, 0.01, l.d, lineMat, { x: l.x, y: 0.005, z: l.z }, 0, l.ry);
      root.add(stripe);
    }
  }
  
  // أسهم اتجاه بسيطة (مثلثات) 
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
}

// ──────────────────────────────────────────────────
//  تصادمات فيزيائية — أجسام CANNON ثابتة
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
  // ── جدران (4) ──
  addStaticBox(world, gndMat, FW / 2, FH / 2, 0.15,  0, FH / 2, -HALF_D);              // خلف
  addStaticBox(world, gndMat, FW / 2, FH / 2, 0.15,  0, FH / 2,  HALF_D);              // أمام
  addStaticBox(world, gndMat, 0.15, FH / 2, FD / 2, -HALF_W, FH / 2, 0);               // يسار
  addStaticBox(world, gndMat, 0.15, FH / 2, FD / 2,  HALF_W, FH / 2, 0);               // يمين

  // ── أعمدة الدعم (6) ──
  const colPositions = [
    { x: -12, z: -12 }, { x: 12, z: -12 },
    { x: -12, z: 12 },  { x: 12, z: 12 },
    { x: -12, z: 0 },   { x: 12, z: 0 },
  ];
  for (const cp of colPositions) {
    addStaticBox(world, gndMat, 0.3, FH / 2, 0.3, cp.x, FH / 2, cp.z);
  }

  // ── رفوف صناعية (bounding box مُبسَّط لكل رف) ──
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

  // ── أحزمة نقل (Conveyors) ──
  const conveyors = [
    { x: 8, z: 12, rot: 0, len: 10 },
    { x: -8, z: -14, rot: Math.PI / 4, len: 8 },
  ];
  for (const cv of conveyors) {
    // الحزام + الإطار كصندوق واحد
    addStaticBox(world, gndMat, cv.len / 2, 0.5, 0.5, cv.x, 0.5, cv.z, cv.rot);
  }

  // ── براميل ──
  const barrelPositions = [
    { x: 22, z: 18 }, { x: 22.8, z: 18 }, { x: 22.4, z: 18.7 },
    { x: -22, z: -18 }, { x: -22.8, z: -18 }, { x: -22.4, z: -17.3 },
    { x: 22, z: -20 }, { x: 22.8, z: -20 },
    { x: 22.4, z: 18.35 },  // المكدّس
  ];
  for (const bp of barrelPositions) {
    const y = (bp.x === 22.4 && bp.z === 18.35) ? 1.35 : 0.45;
    // نستخدم صندوق بدلاً من أسطوانة (أداء أفضل)
    addStaticBox(world, gndMat, 0.35, 0.45, 0.35, bp.x, y, bp.z);
  }

  // ── طبليات خشبية ──
  const palletPositions = [
    { x: 12, z: -4 }, { x: 12, z: -2.5 },
    { x: -10, z: 10 }, { x: -10, z: 11.5 },
    { x: 6, z: -18 },
  ];
  for (const pp of palletPositions) {
    addStaticBox(world, gndMat, 0.6, 0.1, 0.55, pp.x, 0.1, pp.z);
  }

  // ── أنبوب التهوية الرأسي ──
  addStaticBox(world, gndMat, 0.2, FH / 2, 0.2, 24, FH / 2, -24);

  // ── حواجز الأمان (Guard Rails) ──
  const rails = [
    { x: 5, z: 15, w: 6, d: 0.2, ry: 0 },
    { x: -5, z: -15, w: 6, d: 0.2, ry: Math.PI / 2 }
  ];
  for (const r of rails) {
    addStaticBox(world, gndMat, r.w / 2, 0.6, r.d / 2, r.x, 0.6, r.z, r.ry);
  }
}

// ──────────────────────────────────────────────────
//  أنابيب سقفية
// ──────────────────────────────────────────────────
function buildPipes(root) {
  const pipeMat = mat(COL.pipe, { roughness: 0.35, metalness: 0.6 });
  const pipeGeo = new THREE.CylinderGeometry(0.08, 0.08, FW - 4, 8);
  
  const pipeZ = [-15, -5, 5, 15];
  
  for (const z of pipeZ) {
    const pipe = new THREE.Mesh(pipeGeo, pipeMat);
    pipe.position.set(0, FH - 1, z);
    pipe.rotation.z = Math.PI / 2;
    root.add(pipe);
    
    // مشابك التثبيت
    const clampGeo = new THREE.TorusGeometry(0.12, 0.025, 6, 8);
    for (let cx = -HALF_W + 5; cx <= HALF_W - 5; cx += 8) {
      const clamp = new THREE.Mesh(clampGeo, pipeMat);
      clamp.position.set(cx, FH - 1, z);
      clamp.rotation.y = Math.PI / 2;
      root.add(clamp);
    }
  }
  
  // أنبوب رأسي كبير (تهوية)
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
  
  // شبكة أضواء
  for (let x = -20; x <= 20; x += 10) {
    for (let z = -20; z <= 20; z += 10) {
      // العلبة المعدنية
      const housing = new THREE.Mesh(housGeo, lightHousing);
      housing.position.set(x, FH - 0.4, z);
      root.add(housing);
      
      // السطح المضيء
      const glow = new THREE.Mesh(glowGeo, glowMat);
      glow.position.set(x, FH - 0.48, z);
      glow.rotation.x = -Math.PI / 2;
      root.add(glow);
      
      // إضاءة فعلية — فقط في الأماكن القريبة من المركز لحفظ الأداء
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
  // لوحة "CAUTION"
  const signPositions = [
    { x: -HALF_W + 0.2, y: 3, z: 0, ry: Math.PI / 2 },
    { x: HALF_W - 0.2,  y: 3, z: 0, ry: -Math.PI / 2 },
    { x: 0, y: 3, z: -HALF_D + 0.2, ry: 0 },
  ];
  
  for (const sp of signPositions) {
    // خلفية اللوحة
    const signCanvas = document.createElement('canvas');
    signCanvas.width = 256; signCanvas.height = 128;
    const ctx = signCanvas.getContext('2d');
    
    // خلفية صفراء
    ctx.fillStyle = '#ffcc00';
    ctx.fillRect(0, 0, 256, 128);
    
    // إطار أسود
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 8;
    ctx.strokeRect(4, 4, 248, 120);
    
    // خطوط تحذيرية (شرائط)
    ctx.fillStyle = '#000000';
    for (let i = 0; i < 256; i += 32) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i + 16, 0);
      ctx.lineTo(i + 16, 12);
      ctx.lineTo(i, 12);
      ctx.fill();
    }
    for (let i = 0; i < 256; i += 32) {
      ctx.beginPath();
      ctx.moveTo(i + 16, 116);
      ctx.lineTo(i + 32, 116);
      ctx.lineTo(i + 32, 128);
      ctx.lineTo(i + 16, 128);
      ctx.fill();
    }
    
    // النص
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
    // عمود معدني
    const col = box(0.5, FH, 0.5, colMat, { x: cp.x, y: FH / 2, z: cp.z });
    root.add(col);
    
    // شريط تحذيري في الأسفل
    const warn = box(0.55, 1.0, 0.55, warnMat, { x: cp.x, y: 0.5, z: cp.z });
    root.add(warn);
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
    
    // أعمدة
    for (const px of [-r.w / 2 + 0.1, 0, r.w / 2 - 0.1]) {
      const post = box(0.15, 1.2, 0.15, postMat, { x: px, y: 0.6, z: 0 });
      g.add(post);
    }
    // قضبان العرض
    for (const py of [0.5, 1.0]) {
      const bar = box(r.w, 0.15, 0.08, railMat, { x: 0, y: py, z: 0 });
      g.add(bar);
    }
    
    root.add(g);
  }
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

