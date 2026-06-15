// ═══════════════════════════════════════════════════════════
//  HandTrackingController — WebXR Hand Input API
//  Realistic human hands + Gesture recognition → robot control
// ═══════════════════════════════════════════════════════════

import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160/build/three.module.js";
import { XRHandModelFactory } from "https://cdn.jsdelivr.net/npm/three@0.160/examples/jsm/webxr/XRHandModelFactory.js";

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
const PINCH_START = 0.020;  // metres — start pinch (reduced to prevent accidental clicks)
const PINCH_END = 0.035;    // metres — end pinch (hysteresis)
const FIST_DIST = 0.06;     // finger tips close to MCPs
const OPEN_DIST = 0.10;     // finger tips far from MCPs

// ── Joint control speeds ──
const HAND_JOINT_SPEED = 45;  // degrees per second
const HAND_DRIVE_FACTOR = 2.5;

// ── Appearance config ──
const HAND_PROFILE = "mesh";  // realistic skinned hand from the asset factory
// Official high-detail WebXR hand assets (textured, realistic skin).
const HAND_ASSET_PATH = "https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets/dist/profiles/generic-hand/";

// Optional skin override. Leave false to keep the realistic textured asset.
const USE_SKIN_MATERIAL = true;
const SKIN_COLOR = 0xe0ac88;

export class HandTrackingController {

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Group} xrRig
   * @param {THREE.Scene} scene
   * @param {object} cb — callbacks
   */
  constructor(renderer, xrRig, scene, cb) {
    this.renderer = renderer;
    this.xrRig = xrRig;
    this.scene = scene;
    this.cb = cb;

    this.handR = null;   // THREE.Group from renderer.xr.getHand()
    this.handL = null;

    // Visual models
    this._modelR = null;
    this._modelL = null;

    // Optional skin materials (only used when USE_SKIN_MATERIAL is true)
    this._matR = null;
    this._matL = null;
    this._materialsApplied = { right: false, left: false };

    // Lighting we add to the scene for natural-looking skin
    this._hemiLight = null;
    this._dirLight = null;

    // Gesture state
    this._pinchR = false;
    this._pinchL = false;
    this._fistR = false;
    this._thumbUpL = false;

    // Native OS pinch fallback
    this._nativePinchR = false;
    this._nativePinchL = false;

    // Manual distance pinch
    this._manualPinchR = false;
    this._manualPinchL = false;

    // Edge tracking state
    this._prevPinchDistStateR = false;
    this._prevPinchDistStateL = false;

    // Native pulse state
    this._nativePulseR = false;
    this._nativePulseL = false;

    // Reference pose (captured when entering hand mode)
    this._refRight = null;  // { wristPos, wristQuat }

    // Smoothing
    this._smoothGrip = 0;

    this._active = false;
    this._available = false;  // true only if hand-tracking feature is granted
  }

  // ─────────────────── setup ───────────────────
  setup() {
    this.handR = this.renderer.xr.getHand(0);
    this.handL = this.renderer.xr.getHand(1);

    // Build realistic, textured hand models from the official asset library.
    const handModelFactory = new XRHandModelFactory();
    handModelFactory.setPath(HAND_ASSET_PATH);

    this._modelR = handModelFactory.createHandModel(this.handR, HAND_PROFILE);
    this._modelL = handModelFactory.createHandModel(this.handL, HAND_PROFILE);

    this.handR.add(this._modelR);
    this.handL.add(this._modelL);

    // Optional natural-skin material (kept off by default to preserve textures).
    if (USE_SKIN_MATERIAL) {
      this._matR = new THREE.MeshPhysicalMaterial({
        color: SKIN_COLOR,
        roughness: 0.6,
        metalness: 0.0,
        clearcoat: 0.2,
        clearcoatRoughness: 0.7,
      });
      this._matL = this._matR.clone();
    }

    // Soft, natural scene lighting so the skin reads as real.
    this._hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.9);
    this._dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
    this._dirLight.position.set(1, 2, 1);
    this.scene.add(this._hemiLight);
    this.scene.add(this._dirLight);

    // Listen for hand connect / disconnect
    this.handR.addEventListener('connected', (e) => {
      if (!this._active) return;
      if (e.data?.hand) {
        this._available = true;
        this._materialsApplied.right = false;
      }
    });
    this.handL.addEventListener('connected', (e) => {
      if (!this._active) return;
      if (e.data?.hand) {
        this._available = true;
        this._materialsApplied.left = false;
      }
    });
    this.handR.addEventListener('disconnected', () => {
      this._materialsApplied.right = false;
      this._checkAvailable();
    });
    this.handL.addEventListener('disconnected', () => {
      this._materialsApplied.left = false;
      this._checkAvailable();
    });

    // Native OS pinch events mapping to standard controllers
    const ctrlR = this.renderer.xr.getController(0);
    const ctrlL = this.renderer.xr.getController(1);

    ctrlR.addEventListener('selectstart', () => { if (this._active) { this._nativePinchR = true; this._nativePulseR = true; } });
    ctrlR.addEventListener('selectend', () => { if (this._active) this._nativePinchR = false; });
    ctrlL.addEventListener('selectstart', () => { if (this._active) { this._nativePinchL = true; this._nativePulseL = true; } });
    ctrlL.addEventListener('selectend', () => { if (this._active) this._nativePinchL = false; });

    this.xrRig.add(this.handR);
    this.xrRig.add(this.handL);

    this._active = true;
  }

  // Apply a custom skin material only when requested. The asset factory builds
  // meshes asynchronously, so we keep retrying until the meshes exist.
  _applyMaterials(side) {
    if (!USE_SKIN_MATERIAL) return; // keep the realistic textured asset as-is

    const model = side === 'right' ? this._modelR : this._modelL;
    const mat = side === 'right' ? this._matR : this._matL;
    if (this._materialsApplied[side] || !model || !mat) return;

    let found = false;
    model.traverse(c => { if (c.isMesh) { c.material = mat; found = true; } });
    if (found) this._materialsApplied[side] = true;
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
  get indexTipR() { return this._indexTipR; }
  get indexTipL() { return this._indexTipL; }

  // ─────────────────── Per-frame ───────────────────
  update(dt) {
    if (!this._active) return;

    const sess = this.renderer.xr.getSession();
    if (!sess) return;

    const frame = this.renderer.xr.getFrame?.();
    const refSpace = this.renderer.xr.getReferenceSpace?.();
    if (!frame || !refSpace) return;

    // Skin override (no-op unless USE_SKIN_MATERIAL is true)
    this._applyMaterials('right');
    this._applyMaterials('left');

    // Process each hand
    this._processHand('right', frame, refSpace, dt);
    this._processHand('left', frame, refSpace, dt);
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
    this._indexTipR = joints[INDEX_TIP].clone().applyMatrix4(this.xrRig.matrixWorld);

    let currentPinchState = this._prevPinchDistStateR;
    const pinchDist = this._dist(joints, THUMB_TIP, INDEX_TIP);
    
    if (pinchDist !== null) {
      if (!currentPinchState && pinchDist < PINCH_START) currentPinchState = true;
      else if (currentPinchState && pinchDist > PINCH_END) currentPinchState = false;
    }
    
    // Edge trigger for manual pinch
    this._manualPinchR = currentPinchState && !this._prevPinchDistStateR;
    this._prevPinchDistStateR = currentPinchState;
    
    this._pinchR = this._nativePulseR || this._manualPinchR;
    this._nativePulseR = false; // consume pulse
  }

  // ─────────────────── Left hand gestures ───────────────────
  _processLeftHand(joints, dt) {
    this._indexTipL = joints[INDEX_TIP].clone().applyMatrix4(this.xrRig.matrixWorld);

    let currentPinchState = this._prevPinchDistStateL;
    const pinchDist = this._dist(joints, THUMB_TIP, INDEX_TIP);
    
    if (pinchDist !== null) {
      if (!currentPinchState && pinchDist < PINCH_START) currentPinchState = true;
      else if (currentPinchState && pinchDist > PINCH_END) currentPinchState = false;
    }
    
    // Edge trigger for manual pinch
    this._manualPinchL = currentPinchState && !this._prevPinchDistStateL;
    this._prevPinchDistStateL = currentPinchState;
    
    this._pinchL = this._nativePulseL || this._manualPinchL;
    this._nativePulseL = false; // consume pulse
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
    if (this._hemiLight) this.scene.remove(this._hemiLight);
    if (this._dirLight) this.scene.remove(this._dirLight);
    this._matR?.dispose();
    this._matL?.dispose();
    this.handR = this.handL = null;
    this._refRight = null;
  }

  /** Reset the reference pose (call when switching robots) */
  resetReference() {
    this._refRight = null;
  }
}
