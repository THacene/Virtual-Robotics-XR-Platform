import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160/build/three.module.js";
import { GripController } from './GripController.js';


export function smartGripUpdate(dt, { 
  grabbed, 
  getFingerGap, 
  isBoxBetweenFingers, 
  BH, 
  FW, 
  robot, 
  fingerSensors, 
  robotDescription,
  gripController,  // ✅ جديد: GripController instance (ملتصق بالروبوت)
  logger           // ✅ جديد: logger كـ dependency
}) {

  // استخدام logger من الـ dependency أو fallback لـ console
  const log = logger || ((msg, cls) => {});

  // التحقق من المدخلات
  if (!gripController) {
    log('❌ No GripController provided!', 'error');
    return;
  }

  const ls = fingerSensors.left.getState();
  const rs = fingerSensors.right.getState();

  const bothTouching    = ls.isTouching && rs.isTouching;
  const sufficientForce = ls.touchForce > 0.05 && rs.touchForce > 0.05;
  const gap             = getFingerGap();
  const between         = isBoxBetweenFingers();
  const centeredGrip    = between && gap <= BH * 2 + 0.05;
  const edgeGrip        = !between &&
                          bothTouching &&
                          sufficientForce &&
                          ls.activePoint &&
                          rs.activePoint &&
                          gap <= BH * 2 + FW * 2 + 0.02;

  // ===== CHECK IF WE CAN GRAB =====
  if (!grabbed && bothTouching && sufficientForce && (centeredGrip || edgeGrip)) {
    // تقييم القبض باستخدام GripController
    const { canGrip, forceData, reason } = gripController.evaluateGrip(fingerSensors.left, fingerSensors.right);
    
    if (canGrip && forceData) {
      // تطبيق PD Control
      const { targetForce, pdTerms } = gripController.computePDControlledForce(forceData, dt);
      
      // ✅ حساب موقع TCP (Tool Center Point)
      let tcpWorldPos = new THREE.Vector3(0, 0, 0);
      if (robot?.parts?.palm?.tcp) {
        robot.parts.palm.tcp.getWorldPosition(tcpWorldPos);
      }
      
      robot?.onGripRequest('start', {
        leftForce:  ls.touchForce, 
        rightForce: rs.touchForce,
        leftPoint:  ls.activePoint, 
        rightPoint: rs.activePoint,
        boxMass: gripController.box.mass,
        directForce: forceData.normalForce,
        frictionForce: forceData.frictionForce,
        totalAvailableForce: forceData.totalAvailableForce,
        requiredForce: forceData.requiredForceWithSafety,
        frictionCoeff: gripController.grip.frictionCoefficient,
        pdControlledForce: targetForce,
        error: pdTerms.error,
        boxPosition: { x: tcpWorldPos.x, y: tcpWorldPos.y, z: tcpWorldPos.z }  // ✅ موقع الصندوق الجديد
      });
      
      // ✅ حفظ boxPosition في robot للاستخدام لاحقاً
      if (robot?.loadedBoxPosition !== undefined) {
        robot.loadedBoxPosition = { x: tcpWorldPos.x, y: tcpWorldPos.y, z: tcpWorldPos.z };
      }
      const mode = centeredGrip ? 'CENTER' : 'EDGE';
      log(`✅ GRIP ${mode}: ${gripController.box.mass}kg | Normal: ${forceData.normalForce.toFixed(0)}N + Friction: ${forceData.frictionForce.toFixed(0)}N = ${forceData.totalAvailableForce.toFixed(0)}N | μ=${gripController.grip.frictionCoefficient}`, 'ok');
    } else {
      gripController.resetState();
      log(`❌ GRIP FAILED: ${reason}`, 'warn');
    }
  } 
  // ===== CHECK IF WE SHOULD DROP =====
  else if (grabbed && (!ls.isTouching || !rs.isTouching || gap > BH * 2 + 0.08)) {
    robot?.onGripRequest('end', {});
    gripController.resetState();
  }
  // ===== RESET IF NOT GRABBED =====
  else if (!grabbed) {
    gripController.resetState();
  }
}

