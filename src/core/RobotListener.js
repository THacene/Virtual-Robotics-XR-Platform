
export class RobotListener {
  /**
   * @param {object} robot 
   * @param {function} logger -
   */
  constructor(robot, logger = null) {
    this.robot = robot;
    this.logger = logger || ((msg, cls) => {});  
    this.grabbed = false;
    this.gripData = null;  
  }

  onObjectDetected(id, coords) {}

  onRobotDetected(id, coords) {}

  onFingerTouch(name, state, force, pointName = null) {}

  onGripRequest(state, data) {
    if (state === 'start' && !this.grabbed) {
      // حفظ بيانات القبض **قبل** استدعاء actuateGrab
      this.gripData = {
        boxMass: data.boxMass,
        directForce: data.directForce ?? 0,
        frictionForce: data.frictionForce ?? 0,
        totalAvailableForce: data.totalAvailableForce ?? 0,
        requiredForce: data.requiredForce ?? 0,
        leftForce: data.leftForce,
        rightForce: data.rightForce
      };
      
      // ✅ تعيين الصندوق المحمول (يشمل تحديث COG الديناميكي)
      if (this.robot?.setLoadedBox) {
        this.robot.setLoadedBox(data.boxMass, data.boxPosition);
        this.logger(`📍 Dynamic COG: Loaded ${data.boxMass}kg at Y=${data.boxPosition?.y?.toFixed(3)}m`, 'info');
      }
      
      // Pass contact point data to the grab handler
      this.robot.handlers.saveGripOffset?.(data);
      this.robot.actuateGrab();
      
      this.grabbed = true;
      const directF = (data.directForce ?? 0).toFixed(0);
      const frictionF = (data.frictionForce ?? 0).toFixed(0);
      const totalF = (data.totalAvailableForce ?? 0).toFixed(1);
      const reqF = (data.requiredForce ?? 0).toFixed(1);
      this.logger(`🧠 LISTENER: GRAB | Box: ${data.boxMass}kg | Direct: ${directF}N + Friction: ${frictionF}N = ${totalF}N / ${reqF}N`, 'ok');
    } else if (state === 'end' && this.grabbed) {
      this.robot.actuateRelease();
      
      // ✅ إفراج الصندوق (إعادة COG للقيمة الثابتة)
      if (this.robot?.setLoadedBox) {
        this.robot.setLoadedBox(0, null);
        this.logger(`📍 COG reset to static`, 'info');
      }
      
      this.grabbed = false;
      this.logger('🧠 LISTENER: DECIDED → RELEASE', 'warn');
      this.gripData = null;
    }
  }

  getGripData() {
    return this.gripData;
  }
}