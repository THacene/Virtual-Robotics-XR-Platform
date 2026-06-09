
// ---- HEAD (defaults common to ALL robot types) ----
export const defaultDescription = {
  type: 'industrial',

  box: { half: 0.25, mass: 15.0 },  

  // ⬇️ أبعاد واقعية: ذراع أقصر وأكثر تناسقاً (مثل روبوت صناعي حقيقي ~1.1m + 0.95m)
  arm: {
    shoulder: { len: 1.5,  w: 0.26, physHalfW: 0.13, physHalfH: 0.55, physHalfD: 0.13, color: 0xF7931E, mass: 20.0 }, // KUKA Orange
    elbow:    { len: 0.95, w: 0.22, physHalfW: 0.11, physHalfH: 0.475, physHalfD: 0.11, color: 0xE8820A, mass: 15.0 }, // Deeper KUKA Orange
    wrist:    { r: 0.12,   h: 0.12, color: 0x8C939A, mass: 4.0 }, // Brushed steel
    palm:     { w: 0.42,   h: 0.08, d: 0.24, physHalfW: 0.21, physHalfH: 0.04, physHalfD: 0.12, color: 0x6B7280, mass: 3.0 }, // Warm gunmetal
  },

  finger: {
    // ⬇️ ارتفاع كافٍ ليلتف حول الصندوق (الصندوق نصف قطره 0.25 → ارتفاعه 0.5)
    w: 0.08, h: 0.54, d: 0.18,
    closeX: 0.295, openX: 0.38,
    color: 0x9CA3AF, // أصابع ألمنيوم مصقول
    mass: 0.5,  // كتلة الإصبع الواحد
  },

  grip: {
    maxForce: 1200.0,       // أقصى قوة قبض (Newton)
    minForcePerFinger: 100, // أدنى قوة مطلوبة من كل إصبع للحمل
    frictionCoefficient: 0.8,  // معامل الاحتكاك
    maxLoadCapacity: 50.0,  // أقصى وزن واقعي يمكن حمله (kg)
    
  
    frictionReductionFactor: 0.5,  
    frictionEffectivenessFactor: 0.3,  
    safetyMargin: 1.1,  
    
    // PD Control للقبض الواقعي
    pdControl: {
      kp: 500.0,    
      kd: 50.0,     
      maxForceRate: 200.0,  
    }
  },

  base: {
    track:  { w: 0.16, len: 0.95, h: 0.24 },
    body:   { w: 0.60, h: 0.14,   d: 0.80, color: 0x4B5563, mass: 100.0 }, // Warm industrial steel chassis
    turret: { r: 0.28, h: 0.14, mass: 15.0 },
    accentColor: 0xD97706, // برتقالي داكن (accent متناسق مع ذراع KUKA)
    statusLight: false,           // قبة صغيرة فوق الـ turret تلوّن حسب الحالة
  },

  joints: {
    limits: {
      base:     { min: -180, max:  180 },
      shoulder: { min:  -80, max:   85 },
      elbow:    { min:  -90, max:   90 },
      wrist:    { min: -180, max:  180 },
    },
    maxVel:  { base: 35, shoulder: 30, elbow: 35, wrist: 50 },
    maxAcc:  { base: 50, shoulder: 45, elbow: 50, wrist: 70 },
    maxJerk: { base: 150, shoulder: 130, elbow: 150, wrist: 200 },
  },

  movement: { speed: 2, turn: 1, accel: 3, decel: 4 },

  // ⬇️ مسافات تصادم ذاتي مصغّرة لتتناسب مع الذراع الأقصر
  selfCollision: {
    minDist: {
      elbowToBase: 0.32,
      wristToShoulder: 0.32,
      palmToBase: 0.28,
      elbowToShoulder: 0.28,
    }
  },


  // ---- Safety profile: industrial = OFF by default ----
  safety: {
    enabled: false,
    maxLinearSpeed: Infinity,    // clamp على setDrive(speed)
    maxTurnRate:    Infinity,    // clamp على setDrive(turn)
    stopOnContact:  false,       // وقفة طوارئ ملي يصير self/floor/inter-robot collision
    eStopHoldSec:   0,           // مدة الوقفة قبل ما يرجع normal
    slowDownFactor: 1.0,         // multiplier للسرعات في حالة "slow"
  },
};


// ---------------------------------------------------------------------
export const industrialPreset = {
  type: 'industrial',
  arm: {
    shoulder: { color: 0xF7931E }, // KUKA Orange
    elbow:    { color: 0xE8820A }, // Deeper Orange
    palm:     { color: 0x6B7280 }, // Warm gunmetal
  },
  finger: { color: 0x9CA3AF }, // Brushed aluminum
  base: {
    body:        { color: 0x4B5563 }, // Warm steel
    accentColor: 0xD97706,            // Dark orange accent
    statusLight: false,
  },
  // movement + joints + safety = نفس defaultDescription
};


// ---------------------------------------------------------------------
export const cobotPreset = {
  type: 'cobot',

  box: { half: 0.25, mass: 8.0 },  // صندوق أخف لـ cobot

  arm: {
    shoulder: { color: 0xD0D5DB, mass: 12.0 },   // Brushed aluminum
    elbow:    { color: 0xC5CAD0, mass: 10.0 },     // Slightly darker aluminum
    wrist:    { color: 0x8C939A, mass: 2.5 },       // Brushed steel
    palm:     { color: 0x6B7280, mass: 2.0 },       // Warm gunmetal
  },

  finger: { color: 0x9CA3AF, mass: 0.3 },  // Brushed aluminum fingers

  grip: {
    maxForce: 600.0,        // قوة قبض أقل (آمن للإنسان)
    minForcePerFinger: 50,  // أدنى قوة أقل
    frictionCoefficient: 0.8,
    maxLoadCapacity: 20.0,  // سعة أقل — cobot أضعف
    
    // عوامل الاحتكاك والأمان
    frictionReductionFactor: 0.5,  // نسبة فعالية الاحتكاك
    frictionEffectivenessFactor: 0.3,  // عامل فعالية الاحتكاك
    safetyMargin: 1.1,  // هامش أمان
    
    // PD Control للقبض الناعم والآمن
    pdControl: {
      kp: 300.0,    // Proportional gain أقل للأمان
      kd: 40.0,     // Derivative gain للتخفيف
      maxForceRate: 100.0,  // معدل تغير أقل — حركة أكثر سلاسة
    }
  },

  base: {
    body:        { color: 0xBFC5CC, mass: 70.0 },  // Light industrial aluminum
    turret:      { mass: 10.0 },
    accentColor: 0x2C7AB5, // Professional cobot blue (like UR5)
    statusLight: true,
  },

  // حركة لطيفة — الإنسان قريب
  movement: { speed: 0.8, turn: 0.6, accel: 2.0, decel: 4.0 },

  joints: {
    maxVel:  { base:  35, shoulder:  30, elbow:  40, wrist:  60 },
    maxAcc:  { base:  50, shoulder:  45, elbow:  55, wrist:  80 },
    maxJerk: { base: 150, shoulder: 130, elbow: 160, wrist: 200 },
  },

  safety: {
    enabled: true,
    maxLinearSpeed: 0.8,    // m/s — حتى لو المستخدم طلب أكثر، نقصّوها
    maxTurnRate:    0.7,    // rad/s
    stopOnContact:  true,   // أي تصادم → E-STOP
    eStopHoldSec:   1.2,    // يبقى واقف 1.2s ثم يفك
    slowDownFactor: 0.4,    // في حالة proximity، يخدم بـ 40% فقط
  },
};
  

// =====================================================================
// REGISTRY — زيد هنا أي type جديد
// =====================================================================
export const TYPE_PRESETS = {
  industrial: industrialPreset,
  cobot:      cobotPreset,
};

// =====================================================================
// MERGE HELPER
// =====================================================================
function deepMerge(base, overrides) {
  if (overrides == null) return structuredClone(base);
  const out = structuredClone(base);
  for (const key of Object.keys(overrides)) {
    const v = overrides[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[key] = deepMerge(base[key] ?? {}, v);
    } else {
      out[key] = v;
    }
  }
  return out;
}

/**
 * makeDescription(overrides?)
 * يبني description كاملة:
 *   defaultDescription  ←  TYPE_PRESETS[type]  ←  overrides
 *
 * @param {object} overrides   { type?: 'industrial'|'cobot', ...other }
 * @returns {object}           description جاهزة لـ Robot3D
 *
 * 
 */
export function makeDescription(overrides = {}) {
  const type = overrides.type ?? defaultDescription.type;
  const preset = TYPE_PRESETS[type];
  if (!preset) {
    console.warn(`[makeDescription] unknown type "${type}", falling back to industrial`);
  }
  const withType = deepMerge(defaultDescription, preset ?? industrialPreset);
  return deepMerge(withType, overrides);
}