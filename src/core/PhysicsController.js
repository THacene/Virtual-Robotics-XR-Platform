import * as CANNON from "https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js";

export class PhysicsController {
  constructor(body) {
    this.body = body;
  }

  freeze() {
    this.body.type = CANNON.Body.KINEMATIC;
    this.body.updateMassProperties();
    this.body.linearDamping = 0.995;
    this.body.angularDamping = 0.998;
    this.body.velocity.set(0, 0, 0);
    this.body.angularVelocity.set(0, 0, 0);
  }

  release() {
    this.body.type = CANNON.Body.DYNAMIC;
    this.body.updateMassProperties();
    this.body.wakeUp();
    this.body.linearDamping = 0.2;
    this.body.angularDamping = 0.4;
  }

  applyOffset(offsetPos, offsetQuat, palmWP, palmWQ) {
    const targetPos = offsetPos.clone().applyQuaternion(palmWQ).add(palmWP);

    this.body.velocity.set(0, 0, 0);
    this.body.angularVelocity.set(0, 0, 0);
    this.body.force.set(0, 0, 0);
    this.body.torque.set(0, 0, 0);

    this.body.position.set(targetPos.x, targetPos.y, targetPos.z);

    const targetQuat = palmWQ.clone().multiply(offsetQuat);
    this.body.quaternion.set(targetQuat.x, targetQuat.y, targetQuat.z, targetQuat.w);

    this.body.aabbNeedsUpdate = true;
    this.body.interpolatedPosition.copy(this.body.position);
    this.body.interpolatedQuaternion.copy(this.body.quaternion);
  }

  clampFloor(minY) {
    if (this.body.position.y < minY) {
      this.body.position.y = minY;
      if (this.body.velocity.y < 0) this.body.velocity.y = 0;
      this.body.angularVelocity.set(0, 0, 0);
    }
  }

  markAABBDirty() {
    this.body.aabbNeedsUpdate = true;
  }
}