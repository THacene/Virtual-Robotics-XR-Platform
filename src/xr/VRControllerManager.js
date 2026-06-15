// ═══════════════════════════════════════════════════════════
//  VRControllerManager — Full VR controller system
//  Handles both controllers, visual models, rays, haptics
// ═══════════════════════════════════════════════════════════

import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160/build/three.module.js";
import { XRControllerModelFactory } from "https://cdn.jsdelivr.net/npm/three@0.160/examples/jsm/webxr/XRControllerModelFactory.js";

const JOINT_SPEED = 65;   // degrees per second for joint control
const BASE_SPEED  = 50;   // degrees per second for base rotation
const DEAD_ZONE   = 0.15;

export class VRControllerManager {

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Group} xrRig
   * @param {THREE.Scene} scene
   * @param {object} cb — callbacks:
   *   grab(), release(), switchRobot(),
   *   getActive() → Robot3D, moveJoint(name, deg),
   *   setDrive(speed, turn), setSqueeze(v),
   *   resetJoints(), toggleUI(), getGrabbed() → bool
   */
  constructor(renderer, xrRig, scene, cb) {
    this.renderer = renderer;
    this.xrRig    = xrRig;
    this.scene    = scene;
    this.cb       = cb;

    // Controllers / grips
    this.ctrlR = null;  this.ctrlL = null;
    this.gripR = null;  this.gripL = null;

    // XRInputSource references (set on 'connected')
    this.srcR = null;  this.srcL = null;

    // Trigger states
    this.triggerR = false;
    this.triggerL = false;

    // Edge-detection for buttons
    this._prev = { left: {}, right: {} };

    // Joint-control mode: 0 = shoulder/elbow, 1 = base/wrist
    this.jointMode = 0;
    this._modeIndicatorR = null;

    // Visual pieces
    this._modelR = null;  this._modelL = null;
    this.rayR = null;     this.rayL = null;

    this._active = false;
  }

  // ─────────────────── setup ───────────────────
  setup() {
    const r = this.renderer;

    this.ctrlR = r.xr.getController(0);
    this.ctrlL = r.xr.getController(1);
    this.gripR = r.xr.getControllerGrip(0);
    this.gripL = r.xr.getControllerGrip(1);

    const controllerModelFactory = new XRControllerModelFactory();

    this._modelR = controllerModelFactory.createControllerModel(this.gripR);
    this.gripR.add(this._modelR);

    this._modelL = controllerModelFactory.createControllerModel(this.gripL);
    this.gripL.add(this._modelL);

    // Mode indicator on right controller
    this._modeIndicatorR = this._buildModeIndicator();
    this.gripR.add(this._modeIndicatorR);

    // Rays (shorter so they don't 'go too far away' into the distance)
    this.rayR = this._buildRay(0x00ffdd, 1.5);
    this.rayL = this._buildRay(0xffaa55, 1.2);
    this.ctrlR.add(this.rayR);
    this.ctrlL.add(this.rayL);

    // ── Events ──
    this.ctrlR.addEventListener('connected', e => { this.srcR = e.data; });
    this.ctrlL.addEventListener('connected', e => { this.srcL = e.data; });
    this.ctrlR.addEventListener('disconnected', () => { this.srcR = null; });
    this.ctrlL.addEventListener('disconnected', () => { this.srcL = null; });

    // Trigger R → grab / release
    this.ctrlR.addEventListener('selectstart', () => {
      this.triggerR = true;
      if (this.srcR?.hand) return;
      this.cb.grab();
      this._haptic('right', 0.6, 80);
    });
    this.ctrlR.addEventListener('selectend', () => {
      this.triggerR = false;
      if (this.srcR?.hand) return;
      this.cb.release();
    });

    // Trigger L (for UI interaction with left hand if needed)
    this.ctrlL.addEventListener('selectstart', () => {
      this.triggerL = true;
    });
    this.ctrlL.addEventListener('selectend', () => {
      this.triggerL = false;
    });

    // Squeeze L → switch robot
    this.ctrlL.addEventListener('squeezestart', () => {
      if (this.srcL?.hand) return;
      this.cb.switchRobot();
      this._haptic('left', 0.35, 50);
    });

    // Add to rig
    this.xrRig.add(this.ctrlR);
    this.xrRig.add(this.ctrlL);
    this.xrRig.add(this.gripR);
    this.xrRig.add(this.gripL);

    this._active = true;
  }

  // ─────────────────── per-frame update ───────────────────
  update(dt) {
    if (!this._active) return;

    // Refresh input sources each frame (some runtimes re-create them)
    const sess = this.renderer.xr.getSession();
    if (sess) {
      for (const src of sess.inputSources) {
        if (src.handedness === 'right') this.srcR = src;
        if (src.handedness === 'left')  this.srcL = src;
      }
    }

    this._tickRight(dt);
    this._tickLeft(dt);
  }

  // ─────────────────── RIGHT controller ───────────────────
  _tickRight(dt) {
    if (this.srcR?.hand) return; // Do not control robot with hands
    const gp = this.srcR?.gamepad;
    if (!gp) return;
    const active = this.cb.getActive();
    if (!active) return;

    // ── Squeeze R → gripper (analog 0-1) ──
    const sq = gp.buttons[1]?.value ?? 0;
    if (sq > 0.05) {
      this.cb.setSqueeze(sq);
    }

    // ── Thumbstick R ──
    const tx = gp.axes[2] ?? gp.axes[0] ?? 0;
    const ty = gp.axes[3] ?? gp.axes[1] ?? 0;

    if (this.jointMode === 0) {
      // Mode 0 — Shoulder (Y) + Elbow (X)
      if (Math.abs(ty) > DEAD_ZONE) {
        this.cb.moveJoint('shoulder', active.jTarget.shoulder + (-ty * JOINT_SPEED * dt));
      }
      if (Math.abs(tx) > DEAD_ZONE) {
        this.cb.moveJoint('elbow', active.jTarget.elbow + (tx * JOINT_SPEED * dt));
      }
    } else {
      // Mode 1 — Base (X) + Wrist (Y)
      if (Math.abs(tx) > DEAD_ZONE) {
        this.cb.moveJoint('base', active.jTarget.base + (tx * BASE_SPEED * dt));
      }
      if (Math.abs(ty) > DEAD_ZONE) {
        this.cb.moveJoint('wrist', active.jTarget.wrist + (-ty * JOINT_SPEED * dt));
      }
    }

    // ── Thumbstick click (btn 3) → toggle joint mode ──
    if (this._rising('right', 3, gp.buttons[3])) {
      this.jointMode = this.jointMode === 0 ? 1 : 0;
      this._updateModeIndicator();
      this._haptic('right', 0.3, 40);
    }

    // ── A button (btn 4) → Open Robot Creator ──
    if (this._rising('right', 4, gp.buttons[4])) {
      if (this.cb.openCreatorUI) this.cb.openCreatorUI();
      this._haptic('right', 0.4, 60);
    }

    // ── B button (btn 5) → toggle VR UI ──
    if (this._rising('right', 5, gp.buttons[5])) {
      this.cb.toggleUI();
      this._haptic('right', 0.2, 30);
    }
  }

  // ─────────────────── LEFT controller ───────────────────
  _tickLeft(dt) {
    if (this.srcL?.hand) return; // Do not control robot with hands
    const gp = this.srcL?.gamepad;
    if (!gp) return;
    const active = this.cb.getActive();
    if (!active) return;
    const m = active.description.movement;

    // ── Thumbstick L → Drive (Y=fwd/back, X=turn) ──
    const lx = gp.axes[2] ?? gp.axes[0] ?? 0;
    const ly = gp.axes[3] ?? gp.axes[1] ?? 0;

    const speed = Math.abs(ly) > DEAD_ZONE ? -ly * m.speed : 0;
    const turn  = Math.abs(lx) > DEAD_ZONE ? -lx * m.turn  : 0;
    this.cb.setDrive(speed, turn);

    // ── X button (btn 4) → Open Camera Vision ──
    if (this._rising('left', 4, gp.buttons[4])) {
      if (this.cb.openCameraVision) this.cb.openCameraVision();
      this._haptic('left', 0.3, 40);
    }

    // ── Y button (btn 5) → Open Robot Picker ──
    if (this._rising('left', 5, gp.buttons[5])) {
      if (this.cb.openRobotsList) this.cb.openRobotsList();
      this._haptic('left', 0.3, 40);
    }
  }

  // ─────────────────── Haptic ───────────────────
  _haptic(hand, intensity, ms) {
    const src = hand === 'right' ? this.srcR : this.srcL;
    if (!src?.gamepad) return;
    try {
      if (src.gamepad.hapticActuators?.[0]) {
        src.gamepad.hapticActuators[0].pulse(intensity, ms);
      }
      if (src.gamepad.vibrationActuator) {
        src.gamepad.vibrationActuator.playEffect?.('dual-rumble', {
          duration: ms,
          strongMagnitude: intensity,
          weakMagnitude: intensity * 0.4,
        });
      }
    } catch (_) { /* swallow */ }
  }

  /** Pulse haptic from outside (e.g., on grip contact) */
  pulseHaptic(hand = 'right', intensity = 0.5, duration = 100) {
    this._haptic(hand, intensity, duration);
  }

  // ─────────────────── Raycaster helper ───────────────────
  /** Returns { origin, direction } in world space for the given hand */
  getRay(hand = 'right') {
    const ctrl = hand === 'right' ? this.ctrlR : this.ctrlL;
    if (!ctrl) return null;
    const origin = new THREE.Vector3();
    const direction = new THREE.Vector3(0, 0, -1);
    ctrl.getWorldPosition(origin);
    const q = new THREE.Quaternion();
    ctrl.getWorldQuaternion(q);
    direction.applyQuaternion(q);
    return { origin, direction };
  }

  // ─────────────────── Visuals ───────────────────

  _buildRay(color, len) {
    const pts = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -len)];
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.4 });
    const line = new THREE.Line(geo, mat);

    // Dot at tip
    const dGeo = new THREE.SphereGeometry(0.007, 6, 6);
    const dMat = new THREE.MeshBasicMaterial({ color });
    const dot = new THREE.Mesh(dGeo, dMat);
    dot.position.set(0, 0, -len);
    line.add(dot);

    return line;
  }

  _buildModeIndicator() {
    const geo = new THREE.SphereGeometry(0.006, 8, 8);
    const mat = new THREE.MeshBasicMaterial({ color: 0x44aaff }); // blue = shoulder/elbow
    const m = new THREE.Mesh(geo, mat);
    m.position.set(0.02, 0.035, -0.04);
    return m;
  }

  _updateModeIndicator() {
    if (!this._modeIndicatorR) return;
    const c = this.jointMode === 0 ? 0x44aaff : 0xffcc00;
    this._modeIndicatorR.material.color.setHex(c);
  }

  // ─────────────────── Button edge ───────────────────
  _rising(hand, idx, btn) {
    if (!btn) return false;
    const was = this._prev[hand][idx] ?? false;
    const is  = btn.pressed;
    this._prev[hand][idx] = is;
    return is && !was;
  }

  // ─────────────────── Cleanup ───────────────────
  dispose() {
    this._active = false;
    for (const obj of [this.ctrlR, this.ctrlL, this.gripR, this.gripL]) {
      if (obj) this.xrRig.remove(obj);
    }
    this.ctrlR = this.ctrlL = this.gripR = this.gripL = null;
    this.srcR  = this.srcL  = null;
  }
}
