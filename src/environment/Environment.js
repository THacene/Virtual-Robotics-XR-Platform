export class Environment {
  constructor(robot, physicsCtrl, allRobots = []) {
    this.robot = robot;
    this.physicsCtrl = physicsCtrl;
    this.allRobots = allRobots;   // Robot3D[] — كل الروبوتات في المشهد
  }

  update() {
    // ── إرسال موقع الصندوق ──
    const b = this.physicsCtrl.body;
    if (b) {
      this.robot.onObjectDetected("box", {
        x: b.position.x, y: b.position.y, z: b.position.z,
        qx: b.quaternion.x, qy: b.quaternion.y,
        qz: b.quaternion.z, qw: b.quaternion.w
      });
    }

    // ── إرسال مواقع الروبوتات الأخرى ──
    const activeR3D = this.robot._robot3D;
    for (let i = 0; i < this.allRobots.length; i++) {
      const r = this.allRobots[i];
      if (r === activeR3D) continue;          // لا نُبلِّغ عن نفسنا
      const pos = r.parts.base.group.position;
      this.robot.onRobotDetected(`robot_${i}`, {
        x: pos.x,
        z: pos.z,
        yaw: r.baseState?.yaw ?? 0,
        speed: r.baseState?.speed ?? 0
      });
    }
  }
}
