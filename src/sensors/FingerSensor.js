import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160/build/three.module.js";


export class FingerSensor {
  constructor(name, fingerMesh, fingerBody, robotDescription, options = {}) {
    this.name = name;
    this.mesh = fingerMesh;
    this.body = fingerBody;
    this.robot = options.robot || null;
    this.logger = options.logger || ((msg, cls) => {});  // DI: logger اختياري
    this.threshold    = options.threshold    ?? 0.035;
    this.debounceTime = options.debounceTime ?? 0.05;
    
    // ✅ قراءة constants من description
    const f = robotDescription.finger;
    const FH = f.h;
    const FW = f.w;
    const FD = f.d;
    const BH = robotDescription.box.half;
    
    // نقاط الاستشعار — مستقلة عن Three.js
    this.sensorPoints = [
      { name: 'tip',    localY: FH - 0.05, isTouching: false, touchForce: 0 },
      { name: 'middle', localY: FH / 2,    isTouching: false, touchForce: 0 },
      { name: 'base',   localY: 0.1,       isTouching: false, touchForce: 0 }
    ];
    
    // حفظ constants للاستخدام في contactDetection
    this._FH = FH;
    this._FW = FW;
    this._FD = FD;
    this._BH = BH;
    
    this.isTouching  = false;
    this.touchForce  = 0;
    this.activePoint = null;
    this.lastTouchTime = 0;
    this.targetObject  = null;
  }

  /**
   
   * @returns {THREE.Vector3} الموقع العالمي
   */
  computeWorldPosition(localY) {
    const worldPos = new THREE.Vector3(0, localY, 0);
    // هذا يمكن استبداله بحسابات يدوية إذا أردنا فصل Three.js
    this.mesh.localToWorld(worldPos);
    return worldPos;
  }

  /**
   * كشف التماس مع object
   * @returns {object} { closestDist, closestPoint, maxForce, anyTouching }
   */
  contactDetection(targetObject) {
    const fingerRadius = Math.max(this._FW, this._FD) * 0.5;
    const targetRadius = this._BH;
    let closestDist = Infinity;
    let closestPoint = null;
    let maxForce = 0;
    let anyTouching = false;

    for (const point of this.sensorPoints) {
      // ✅ الفصل: استخدم computeWorldPosition بدل mesh.localToWorld مباشرة
      const worldPos = this.computeWorldPosition(point.localY);
      const surfaceDist = Math.max(0, worldPos.distanceTo(targetObject.position) - (fingerRadius + targetRadius));
      
      point.isTouching = surfaceDist < this.threshold;
      point.touchForce = point.isTouching ? THREE.MathUtils.clamp(1 - surfaceDist / this.threshold, 0, 1) : 0;
      
      if (surfaceDist < closestDist) {
        closestDist = surfaceDist;
        closestPoint = point;
      }
      if (point.touchForce > maxForce) maxForce = point.touchForce;
      if (point.isTouching) anyTouching = true;
    }

    return { closestDist, closestPoint, maxForce, anyTouching };
  }

  /**
   * الحصول على نقاط الاستشعار (للوثائق والاختبار)
   */
  getSensorPoints() {
    return this.sensorPoints.map(p => ({
      name: p.name,
      localY: p.localY,
      isTouching: p.isTouching,
      touchForce: p.touchForce
    }));
  }

  update(dt, targetId = 'box') {
    const perceived = this.robot?.getPerceivedObject(targetId);
    if (!perceived) { 
      this._resetAll(); 
      return; 
    }
    
    this.targetObject = { 
      position: new THREE.Vector3(perceived.x, perceived.y, perceived.z) 
    };

    // ✅ استخدم الدالة المنفصلة contactDetection
    const { closestDist, closestPoint, maxForce, anyTouching } = this.contactDetection(this.targetObject);
    this.activePoint = closestPoint;

    const now = performance.now();
    if (anyTouching) {
      if (!this.isTouching && (now - this.lastTouchTime) > this.debounceTime * 1000) {
        this._onTouchStart();
      }
      this.isTouching = true;
      this.touchForce = maxForce;
    } else {
      if (this.isTouching) {
        this._onTouchEnd();
      }
      this.isTouching = false;
      this.touchForce = 0;
    }
  }

  _resetAll() {
    if (this.isTouching) this._onTouchEnd();
    this.isTouching = false;
    this.touchForce = 0;
    this.activePoint = null;
    for (const p of this.sensorPoints) { 
      p.isTouching = false; 
      p.touchForce = 0; 
    }
  }

  _onTouchStart() {
    this.lastTouchTime = performance.now();
    this.robot?.onFingerTouch(this.name, 'start', this.touchForce, this.activePoint?.name);
    this.logger(`👆 ${this.name}[${this.activePoint?.name}] TOUCH START`, 'sens-log');
  }

  _onTouchEnd() {
    this.robot?.onFingerTouch(this.name, 'end', 0, null);
    this.logger(`👋 ${this.name} TOUCH END`, 'sens-log');
  }

  getState() {
    return {
      isTouching:  this.isTouching,
      touchForce:  this.touchForce,
      activePoint: this.activePoint?.name ?? null,
      points:      this.getSensorPoints(),
      target:      this.targetObject ? 'box' : null
    };
  }
}