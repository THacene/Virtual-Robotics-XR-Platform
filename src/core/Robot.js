export class Robot {
  constructor(name, handlers = {}) {
    this.name = name;
    this.listener = null;
    this.perceivedObjects = new Map();
    this.handlers = handlers; // { grab, release, saveGripOffset }
    this.fingerState = { left: null, right: null }; // memory layer
    this._robot3D = null;  // ✅ مرجع إلى Robot3D الفعلي (للوصول إلى parts, loadedMass, إلخ)
  }

  // ✅ تعيين Robot3D للحصول على وصول كامل
  setRobot3D(robot3D) {
    this._robot3D = robot3D;
  }

  // ✅ توكيل الخصائص والدوال إلى Robot3D
  get parts() {
    return this._robot3D?.parts;
  }

  get loadedMass() {
    return this._robot3D?.loadedMass ?? 0;
  }

  set loadedMass(value) {
    if (this._robot3D) this._robot3D.loadedMass = value;
  }

  get loadedBoxPosition() {
    return this._robot3D?.loadedBoxPosition;
  }

  set loadedBoxPosition(value) {
    if (this._robot3D) this._robot3D.loadedBoxPosition = value;
  }

  setLoadedBox(mass = 0, boxPosition = null) {
    if (this._robot3D?.setLoadedBox) {
      this._robot3D.setLoadedBox(mass, boxPosition);
    }
  }

  updatePhysicsBodyCOG(boxPosition = null) {
    if (this._robot3D?.updatePhysicsBodyCOG) {
      this._robot3D.updatePhysicsBodyCOG(boxPosition);
    }
  }

  onObjectDetected(id, coords) {
    this.perceivedObjects.set(id, {
      ...coords,
      lastUpdated: performance.now()
    });
    this.listener?.onObjectDetected?.(id, coords);
  }

  onRobotDetected(id, coords) {
    this.listener?.onRobotDetected?.(id, coords);
  }

  getPerceivedObject(id, maxAgeMs = 50) {
    const obj = this.perceivedObjects.get(id);
    if (!obj || performance.now() - obj.lastUpdated > maxAgeMs) return null;
    return obj;
  }

  onFingerTouch(name, state, force, pointName = null) {
    this.fingerState[name] = { state, force, pointName };
    this.listener?.onFingerTouch?.(name, state, force, pointName);
  }

  getFingerState(side) {
    return this.fingerState[side];
  }

  onGripRequest(state, data) {
    this.listener?.onGripRequest?.(state, data);
  }

  actuateGrab() {
    this.handlers.grab?.();
  }

  actuateRelease() {
    this.handlers.release?.();
  }

  moveArm(arm, degree) {
    this.handlers.moveArm?.(arm, degree);
  }

  setListener(listener) {
    this.listener = listener;
  }
}