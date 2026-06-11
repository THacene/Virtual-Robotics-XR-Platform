// ═══════════════════════════════════════════════════════════
//  HandTrackingController — WebXR Hand Input API
//  Gesture recognition → robot control
// ═══════════════════════════════════════════════════════════

import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160/build/three.module.js";

// ── XRHand joint indices ──
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_TIP = 9;
const MIDDLE_TIP = 14;
const RING_TIP = 19;
const PINKY_TIP = 24;
const INDEX_MCP = 5;
const MIDDLE_MCP = 10;
const RING_MCP = 15;
const PINKY_MCP = 20;
const THUMB_MCP = 2;

// ── Gesture thresholds ──
const PINCH_START = 0.025;    // metres — start pinch
const PINCH_END   = 0.045;    // metres — end pinch (hysteresis)
const FIST_DIST   = 0.06;     // finger tips close to MCPs
const OPEN_DIST   = 0.10;     // finger tips far from MCPs

// ── Joint control speeds ──
const HAND_JOINT_SPEED = 45;  // degrees per second
const HAND_DRIVE_FACTOR = 2.5;

// ── Bone connections for visual hand model ──
const FINGER_CHAINS = [
  [0, 1, 2, 3, 4],             // thumb
  [0, 5, 6, 7, 8, 9],          // index
  [0, 10, 11, 12, 13, 14],     // middle
  [0, 15, 16, 17, 18, 19],     // ring
  [0, 20, 21, 22, 23, 24],     // pinky
];

export class HandTrackingController {

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Group} xrRig
   * @param {THREE.Scene} scene
   * @param {object} cb — callbacks:
   *   grab(), release(), switchRobot(),
   *   getActive() → Robot3D, moveJoint(name, deg),
   *   setDrive(speed, turn), setSqueeze(v), resetJoints(),
   *   getGrabbed() → bool
   */
  constructor(renderer, xrRig, scene, cb) {
    this.renderer = renderer;
    this.xrRig    = xrRig;
    this.scene    = scene;
    this.cb       = cb;

    this.handR = null;   // THREE.Group from renderer.xr.getHand()
    this.handL = null;

    // Visual models
    this._modelR = null;
    this._modelL = null;

    // Gesture state
    this._pinchR = false;
    this._pinchL = false;
    this._fistR  = false;
    this._thumbUpL = false;

    // Reference pose (captured when entering hand mode)
    this._refRight = null;  // { wristPos, wristQuat }

    // Smoothing
    this._smoothGrip = 0;

    this._active  = false;
    this._available = false;  // true only if hand-tracking feature is granted
  }

  // ─────────────────── setup ───────────────────
  setup() {
    this.handR = this.renderer.xr.getHand(0);
    this.handL = this.renderer.xr.getHand(1);

    // Build visual hand models
    this._modelR = this._buildHandModel(0x00ddff);
    this._modelL = this._buildHandModel(0xff9944);
    this.handR.add(this._modelR.group);
    this.handL.add(this._modelL.group);

    // Listen for hand connect / disconnect
    this.handR.addEventListener('connected', (e) => {
      if (!this._active) return;
      if (e.data?.hand) this._available = true;
    });
    this.handL.addEventListener('connected', (e) => {
      if (!this._active) return;
      if (e.data?.hand) this._available = true;
    });
    this.handR.addEventListener('disconnected', () => { this._checkAvailable(); });
    this.handL.addEventListener('disconnected', () => { this._checkAvailable(); });

    this.xrRig.add(this.handR);
    this.xrRig.add(this.handL);

    this._active = true;
  }

  _checkAvailable() {
    if (!this._active) {
      this._available = false;
      return;
    }

    // Remains available if at least one hand is tracked
    this._available = Boolean(this.handR?.children?.length || this.handL?.children?.length);
  }

  get available() { return this._available; }

  // ─────────────────── Per-frame ───────────────────
  update(dt) {
    if (!this._active) return;

    const sess = this.renderer.xr.getSession();
    if (!sess) return;

    const frame = this.renderer.xr.getFrame?.();
    const refSpace = this.renderer.xr.getReferenceSpace?.();
    if (!frame || !refSpace) return;

    // Process each hand
    this._processHand('right', frame, refSpace, dt);
    this._processHand('left',  frame, refSpace, dt);

    // Update visual models
    this._updateVisual('right', frame, refSpace);
    this._updateVisual('left',  frame, refSpace);
  }

  // ─────────────────── Hand processing ───────────────────
  _processHand(side, frame, refSpace, dt) {
    const inputSources = this.renderer.xr.getSession()?.inputSources;
    if (!inputSources) return;

    let handSource = null;
    for (const src of inputSources) {
      if (src.hand && src.handedness === side) {
        handSource = src;
        break;
      }
    }
    if (!handSource) return;

    const hand = handSource.hand;
    const joints = this._getJointPositions(hand, frame, refSpace);
    if (!joints) return;

    if (side === 'right') {
      this._processRightHand(joints, dt);
    } else {
      this._processLeftHand(joints, dt);
    }
  }

  _getJointPositions(hand, frame, refSpace) {
    const positions = {};
    for (let i = 0; i < 25; i++) {
      const jointName = this._jointName(i);
      const joint = hand.get(jointName);
      if (!joint) continue;
      const pose = frame.getJointPose?.(joint, refSpace);
      if (pose) {
        positions[i] = new THREE.Vector3(
          pose.transform.position.x,
          pose.transform.position.y,
          pose.transform.position.z
        );
        if (i === WRIST) {
          positions.wristQuat = new THREE.Quaternion(
            pose.transform.orientation.x,
            pose.transform.orientation.y,
            pose.transform.orientation.z,
            pose.transform.orientation.w
          );
        }
      }
    }
    return Object.keys(positions).length >= 5 ? positions : null;
  }

  // ─────────────────── Right hand gestures ───────────────────
  _processRightHand(joints, dt) {
    const active = this.cb.getActive();
    if (!active) return;

    // ── Pinch detection (index + thumb) ──
    const pinchDist = this._dist(joints, THUMB_TIP, INDEX_TIP);
    if (pinchDist !== null) {
      if (!this._pinchR && pinchDist < PINCH_START) {
        this._pinchR = true;
        this.cb.grab();
      } else if (this._pinchR && pinchDist > PINCH_END) {
        this._pinchR = false;
        this.cb.release();
      }
    }

    // ── Fist detection → gripper close ──
    const fistScore = this._fistAmount(joints);
    if (fistScore !== null) {
      // Map fist score (0 = open, 1 = fist) to squeeze
      const targetGrip = Math.max(0, Math.min(1, fistScore));
      this._smoothGrip += (targetGrip - this._smoothGrip) * 0.15;
      if (!this._pinchR) {
        this.cb.setSqueeze(this._smoothGrip);
      }
    }

    // ── Joint control: wrist height → shoulder ──
    if (joints[WRIST] && joints.wristQuat) {
      if (!this._refRight) {
        // Capture reference on first frame
        this._refRight = {
          wristY: joints[WRIST].y,
          wristQuat: joints.wristQuat.clone(),
        };
      }

      // Shoulder: hand raised/lowered relative to reference
      const deltaY = joints[WRIST].y - this._refRight.wristY;
      if (Math.abs(deltaY) > 0.03) {
        const shoulderDelta = deltaY * HAND_JOINT_SPEED * dt * 3;
        this.cb.moveJoint('shoulder', active.jCurrent.shoulder + shoulderDelta);
      }

      // Wrist rotation: twist of the hand
      const currentQuat = joints.wristQuat;
      const refQuat = this._refRight.wristQuat;
      const relQuat = refQuat.clone().invert().multiply(currentQuat);
      const euler = new THREE.Euler().setFromQuaternion(relQuat, 'YXZ');
      const twist = THREE.MathUtils.radToDeg(euler.y);
      if (Math.abs(twist) > 8) {
        this.cb.moveJoint('wrist', active.jCurrent.wrist + twist * dt * 2);
      }
    }
  }

  // ─────────────────── Left hand gestures ───────────────────
  _processLeftHand(joints, dt) {
    const active = this.cb.getActive();
    if (!active) return;

    // ── Thumbs-up → switch robot ──
    const thumbUp = this._isThumbsUp(joints);
    if (thumbUp && !this._thumbUpL) {
      this._thumbUpL = true;
      this.cb.switchRobot();
    } else if (!thumbUp) {
      this._thumbUpL = false;
    }

    // ── Left hand tilt → drive robot ──
    if (joints[WRIST] && joints[MIDDLE_MCP]) {
      const wrist = joints[WRIST];
      const mcp = joints[MIDDLE_MCP];
      const forward = new THREE.Vector3().subVectors(mcp, wrist).normalize();

      // Y component of forward = how much hand is tilted forward/back
      const tiltForward = -forward.y;
      // X component = left/right tilt for turning
      const tiltSide = forward.x;

      const m = active.description.movement;
      const dead = 0.2;
      const speed = Math.abs(tiltForward) > dead ? tiltForward * m.speed * HAND_DRIVE_FACTOR : 0;
      const turn  = Math.abs(tiltSide)   > dead ? -tiltSide * m.turn * HAND_DRIVE_FACTOR : 0;
      this.cb.setDrive(speed, turn);
    }
  }

  // ─────────────────── Gesture helpers ───────────────────
  _dist(joints, a, b) {
    if (!joints[a] || !joints[b]) return null;
    return joints[a].distanceTo(joints[b]);
  }

  _fistAmount(joints) {
    // Average distance from each finger tip to its MCP, normalised
    const pairs = [
      [INDEX_TIP, INDEX_MCP],
      [MIDDLE_TIP, MIDDLE_MCP],
      [RING_TIP, RING_MCP],
      [PINKY_TIP, PINKY_MCP],
    ];
    let sum = 0, count = 0;
    for (const [tip, mcp] of pairs) {
      const d = this._dist(joints, tip, mcp);
      if (d !== null) {
        // 0 = fully curled (fist), 1 = extended (open)
        const openness = Math.max(0, Math.min(1, (d - FIST_DIST) / (OPEN_DIST - FIST_DIST)));
        sum += (1 - openness);
        count++;
      }
    }
    return count > 0 ? sum / count : null;
  }

  _isThumbsUp(joints) {
    if (!joints[THUMB_TIP] || !joints[WRIST]) return false;
    // Thumb tip should be significantly above wrist
    const thumbAbove = joints[THUMB_TIP].y - joints[WRIST].y > 0.06;
    // Other fingers should be curled
    const fist = this._fistAmount(joints);
    return thumbAbove && fist !== null && fist > 0.65;
  }

  // ─────────────────── Visual hand model ───────────────────
  _buildHandModel(color) {
    const group = new THREE.Group();

    // Joint spheres
    const jointGeo = new THREE.SphereGeometry(0.006, 6, 6);
    const jointMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7 });
    const tipMat   = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 });

    const spheres = [];
    for (let i = 0; i < 25; i++) {
      const isTip = [THUMB_TIP, INDEX_TIP, MIDDLE_TIP, RING_TIP, PINKY_TIP].includes(i);
      const s = new THREE.Mesh(
        isTip ? new THREE.SphereGeometry(0.008, 8, 8) : jointGeo,
        isTip ? tipMat.clone() : jointMat.clone()
      );
      s.visible = false;
      group.add(s);
      spheres.push(s);
    }

    // Bone lines
    const lineMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.4 });
    const lines = [];
    for (const chain of FINGER_CHAINS) {
      const pts = chain.map(() => new THREE.Vector3());
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.Line(geo, lineMat);
      line.visible = false;
      group.add(line);
      lines.push({ chain, line });
    }

    return { group, spheres, lines };
  }

  _updateVisual(side, frame, refSpace) {
    const inputSources = this.renderer.xr.getSession()?.inputSources;
    if (!inputSources) return;

    let handSource = null;
    for (const src of inputSources) {
      if (src.hand && src.handedness === side) {
        handSource = src;
        break;
      }
    }

    const model = side === 'right' ? this._modelR : this._modelL;
    const handGroup = side === 'right' ? this.handR : this.handL;
    if (!model) return;
    if (!handGroup) return;

    if (!handSource) {
      // Hide all
      for (const s of model.spheres) s.visible = false;
      for (const l of model.lines) l.line.visible = false;
      return;
    }

    const hand = handSource.hand;
    const positions = [];

    for (let i = 0; i < 25; i++) {
      const jointName = this._jointName(i);
      const joint = hand.get(jointName);
      if (!joint) { positions.push(null); continue; }
      const pose = frame.getJointPose?.(joint, refSpace);
      if (pose) {
        const p = new THREE.Vector3(
          pose.transform.position.x,
          pose.transform.position.y,
          pose.transform.position.z
        );
        // Convert to hand-group local space
        handGroup.worldToLocal(p);
        model.spheres[i].position.copy(p);
        model.spheres[i].visible = true;
        positions.push(p);
      } else {
        model.spheres[i].visible = false;
        positions.push(null);
      }
    }

    // Update bone lines
    for (const { chain, line } of model.lines) {
      let allValid = true;
      const pts = [];
      for (const idx of chain) {
        if (!positions[idx]) { allValid = false; break; }
        pts.push(positions[idx]);
      }
      if (allValid && pts.length >= 2) {
        line.geometry.setFromPoints(pts);
        line.geometry.attributes.position.needsUpdate = true;
        line.visible = true;
      } else {
        line.visible = false;
      }
    }
  }

  // ─────────────────── Joint name mapping ───────────────────
  _jointName(index) {
    const names = [
      'wrist',
      'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip',
      'index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip',
      'middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip',
      'ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip',
      'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip',
    ];
    return names[index] ?? 'wrist';
  }

  // ─────────────────── Cleanup ───────────────────
  dispose() {
    this._active = false;
    this._available = false;
    if (this.handR) this.xrRig.remove(this.handR);
    if (this.handL) this.xrRig.remove(this.handL);
    this.handR = this.handL = null;
    this._refRight = null;
  }

  /** Reset the reference pose (call when switching robots) */
  resetReference() {
    this._refRight = null;
  }
}
