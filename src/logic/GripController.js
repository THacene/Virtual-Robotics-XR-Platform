

const GRAVITY = 9.81;

export class GripController {
  /**
   * @param {object} robotDescription -
   * @param {function} logger - 
   */
  constructor(robotDescription, logger = null) {
    this.description = robotDescription;
    this.logger = logger || ((msg, cls) => {});
    

    this.pdState = {
      prevError: 0,
      prevForce: 0,
      integralError: 0,
    };

    // استخراج الثوابت من الـ description
    this.grip = robotDescription.grip;
    this.box = robotDescription.box;
  }

  /**
   
   * @returns {object}
   */
  evaluateGrip(fingerSensorLeft, fingerSensorRight) {
    const ls = fingerSensorLeft.getState();
    const rs = fingerSensorRight.getState();

    const bothTouching    = ls.isTouching && rs.isTouching;
    const sufficientForce = ls.touchForce > 0.05 && rs.touchForce > 0.05;

    if (!bothTouching || !sufficientForce) {
      return {
        canGrip: false,
        forceData: null,
        reason: 'Insufficient sensor contact'
      };
    }

    // ===== حساب القوة المتاحة =====
    const totalGripForce = ls.touchForce + rs.touchForce;
    const normalForce = totalGripForce * this.grip.maxForce;
    
    // القوة الاحتكاكية: μ × N × عامل الفعالية
    const frictionForce = this.grip.frictionCoefficient * normalForce * this.grip.frictionEffectivenessFactor;
    const totalAvailableForce = normalForce + frictionForce;

    // ===== حساب القوة المطلوبة =====
    const directForceRequired = this.box.mass * GRAVITY;
    
    // تقليل القوة المطلوبة بفضل الاحتكاك
    const frictionReduction = 1 / (1 + this.grip.frictionCoefficient * this.grip.frictionReductionFactor);
    const requiredForce = directForceRequired * frictionReduction;
    
    // هامش الأمان
    const requiredForceWithSafety = requiredForce * this.grip.safetyMargin;

    // ===== فحص القوة من كل إصبع =====
    const minForcePerFinger = this.grip.minForcePerFinger;
    const leftForceEnough = ls.touchForce * this.grip.maxForce >= minForcePerFinger;
    const rightForceEnough = rs.touchForce * this.grip.maxForce >= minForcePerFinger;

    const forceData = {
      totalGripForce,
      normalForce,
      frictionForce,
      totalAvailableForce,
      directForceRequired,
      requiredForce,
      requiredForceWithSafety,
      leftForce: ls.touchForce,
      rightForce: rs.touchForce,
      leftForceEnough,
      rightForceEnough,
      activePoints: {
        left: ls.activePoint,
        right: rs.activePoint,
      }
    };

    const canGrip = (totalAvailableForce >= requiredForceWithSafety) && 
                    leftForceEnough && rightForceEnough;

    return { canGrip, forceData, reason: canGrip ? 'OK' : 'Insufficient grip force' };
  }

  /**
  
   * @param {object} forceData 
   * @param {number} dt 
   * @returns {object} 
   */
  computePDControlledForce(forceData, dt) {
    const pdCtrl = this.grip.pdControl;
    
    // الخطأ: الفرق بين المطلوب والمتاح
    const error = forceData.requiredForceWithSafety - forceData.totalAvailableForce;
    
    // حساب PD
    const pTerm = pdCtrl.kp * error;
    const dTerm = pdCtrl.kd * (error - this.pdState.prevError) / Math.max(dt, 0.001);
    let targetForce = forceData.totalAvailableForce + pTerm + dTerm;
    
    // تطبيق slew rate limiting — منع القفزات المفاجئة
    const maxDelta = pdCtrl.maxForceRate * dt;
    const forceDelta = targetForce - this.pdState.prevForce;
    targetForce = this.pdState.prevForce + Math.max(-maxDelta, Math.min(maxDelta, forceDelta));
    
    // حفظ الحالة للـ iteration التالية
    this.pdState.prevError = error;
    this.pdState.prevForce = targetForce;
    
    return {
      targetForce,
      pdTerms: { pTerm, dTerm, error }
    };
  }

  /**
   * إعادة تعيين حالة PD
   */
  resetState() {
    this.pdState.prevError = 0;
    this.pdState.prevForce = 0;
    this.pdState.integralError = 0;
  }

  /**
   * الحصول على البيانات الحالية
   */
  getState() {
    return {
      pdState: { ...this.pdState },
      grip: this.grip,
      box: this.box
    };
  }
}