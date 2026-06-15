// ═══════════════════════════════════════════════════════════
//  VRUI — Floating 3D control panel inside VR
//  Canvas-texture based: sliders, buttons, status display
// ═══════════════════════════════════════════════════════════

import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160/build/three.module.js";

// ── Canvas dimensions (px) ──
const CW = 480;
const CH = 700;

// ── Panel size in metres ──
const PANEL_W = 0.48;
const PANEL_H = PANEL_W * (CH / CW);

// ── Layout constants ──
const PAD = 20;
const SLIDER_H = 32;
const SLIDER_GAP = 54;
const BTN_H = 38;
const BTN_GAP = 46;

// ── Colours ──
const C = {
  bg: 'rgba(12, 16, 24, 0.88)',
  panelBg: 'rgba(18, 24, 34, 0.92)',
  border: 'rgba(255, 204, 0, 0.28)',
  accent: '#ffcc00',
  accentDim: 'rgba(255,204,0,0.35)',
  text: '#d0d8e0',
  textDim: '#5a6a7a',
  sliderBg: 'rgba(255,255,255,0.08)',
  sliderFill: '#ffcc00',
  btnBg: 'rgba(255,255,255,0.06)',
  btnHover: 'rgba(255,255,255,0.14)',
  btnGrab: 'rgba(46,138,80,0.35)',
  btnRelease: 'rgba(204,51,34,0.35)',
  btnReset: 'rgba(74,106,138,0.35)',
  btnSwitch: 'rgba(150,80,200,0.35)',
  green: '#00cc55',
  red: '#cc3322',
  blue: '#4a88cc',
  purple: '#9955cc',
};

export class VRUI {

  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Group} xrRig
   * @param {object} cb — callbacks:
   *   getActive() → Robot3D, moveJoint(name, deg),
   *   grab(), release(), resetJoints(), switchRobot(),
   *   getActiveIdx() → number, getGrabbed() → bool,
   *   setSqueeze(v), getStatus() → string
   */
  constructor(scene, xrRig, cb) {
    this.scene = scene;
    this.xrRig = xrRig;
    this.cb = cb;

    this._visible = false;
    this._tabActive = false;
    this._view = 'main'; // 'main' or 'stats'

    // ── Canvas + Texture ──
    this._canvas = document.createElement('canvas');
    this._canvas.width = CW;
    this._canvas.height = CH;
    this._ctx = this._canvas.getContext('2d');
    this._tex = new THREE.CanvasTexture(this._canvas);
    this._tex.minFilter = THREE.LinearFilter;
    this._tex.magFilter = THREE.LinearFilter;

    // ── 3D Mesh (main panel) ──
    const geo = new THREE.PlaneGeometry(PANEL_W, PANEL_H);
    const mat = new THREE.MeshBasicMaterial({
      map: this._tex, transparent: true, side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.renderOrder = 9999;
    this.mesh.visible = false;

    // ── Toggle Tab (small floating button, always visible in VR) ──
    this._tabCanvas = document.createElement('canvas');
    this._tabCanvas.width = 180;
    this._tabCanvas.height = 72;
    this._tabCtx = this._tabCanvas.getContext('2d');
    this._tabTex = new THREE.CanvasTexture(this._tabCanvas);
    this._tabTex.minFilter = THREE.LinearFilter;
    const tabGeo = new THREE.PlaneGeometry(0.14, 0.055);
    const tabMat = new THREE.MeshBasicMaterial({
      map: this._tabTex, transparent: true, side: THREE.DoubleSide, depthWrite: false,
    });
    this.tabMesh = new THREE.Mesh(tabGeo, tabMat);
    this.tabMesh.renderOrder = 9998;
    this.tabMesh.visible = false;
    this._tabHovered = false;

    // ── Interaction state ──
    this._raycaster = new THREE.Raycaster();
    this._hoverUV = null;        // { x, y } in canvas coords
    this._hoveredEl = null;      // element id string
    this._dragging = null;       // slider id being dragged
    this._triggerHeld = false;

    // ── UI element definitions ──
    this._sliders = this._defineSliders();
    this._buttons = this._defineButtons();

    this._targetPos = new THREE.Vector3();
    this._targetQuat = new THREE.Quaternion();
  }

  // ─────────────────── Element definitions ───────────────────
  _defineSliders() {
    const x = PAD + 10;
    const w = CW - PAD * 2 - 20;
    let y = 110;
    const mk = (id, label, min, max, color) => {
      const s = { id, label, x, y, w, h: SLIDER_H, min, max, color };
      y += SLIDER_GAP;
      return s;
    };
    return [
      mk('base', 'BASE', -180, 180, C.accent),
      mk('shoulder', 'SHOULDER', -180, 180, C.blue),
      mk('elbow', 'ELBOW', -180, 180, C.green),
      mk('wrist', 'WRIST', -180, 180, C.purple),
      mk('gripper', 'GRIPPER', 14, 55, '#ff8833'),
    ];
  }

  _defineButtons() {
    const bw3 = (CW - PAD * 2 - 20) / 3;
    let y = 390;
    const btns = [
      { id: 'grab', label: '✊ GRAB', x: PAD, y, w: bw3, h: BTN_H, color: C.btnGrab, view: 'main', action: () => {
          if (typeof window !== 'undefined' && window.autoGrab) {
            window.autoGrab({ step: 1, interval: 80 });
          } else {
            this.cb.grab(true);
          }
      } },
      { id: 'release', label: '🤚 RELEASE', x: PAD + bw3 + 10, y, w: bw3, h: BTN_H, color: C.btnRelease, view: 'main', action: () => {
          if (typeof window !== 'undefined' && window.autoRelease) {
            window.autoRelease({ step: 1, interval: 80 });
          } else {
            this.cb.release();
          }
      } },
      { id: 'reset', label: '🔄 RESET', x: PAD + bw3 * 2 + 20, y, w: bw3, h: BTN_H, color: C.btnReset, view: 'main', action: () => this.cb.resetJoints() },
    ];
    y += BTN_GAP;
    btns.push(
      { id: 'switch', label: '🤖 ROBOTS', x: PAD, y, w: bw3, h: BTN_H, color: C.btnSwitch, view: 'main', action: () => { this._view = 'robots'; } },
      { id: 'camera', label: '📷 VISION', x: PAD + bw3 + 10, y, w: bw3, h: BTN_H, color: C.btnReset, view: 'main', action: () => { this._view = 'camera'; } },
      { id: 'create', label: '➕ CREATE', x: PAD + bw3 * 2 + 20, y, w: bw3, h: BTN_H, color: 'rgba(255,204,0,0.25)', view: 'main', action: () => { this._view = 'create'; if (this.cb.openCreator) this.cb.openCreator(); } }
    );
    y += BTN_GAP;
    btns.push(
      { id: 'exit', label: '🚪 EXIT VR', x: PAD, y, w: CW - PAD * 2, h: 32, color: '#aa3333', view: 'main', action: () => { if (this.cb.exitXR) this.cb.exitXR(); } }
    );

    // Back buttons
    btns.push(
      { id: 'back_camera', label: '◀ BACK', x: PAD, y: 76, w: 100, h: BTN_H, color: C.btnBg, view: 'camera', action: () => { this._view = 'main'; } },
      { id: 'back_robots', label: '◀ BACK', x: PAD, y: 76, w: 100, h: BTN_H, color: C.btnBg, view: 'robots', action: () => { this._view = 'main'; } },
      { id: 'back_create', label: '◀ BACK', x: PAD, y: 76, w: 100, h: BTN_H, color: C.btnBg, view: 'create', action: () => { this._view = 'main'; if (this.cb.closeCreator) this.cb.closeCreator(); } },
      { id: 'deploy_robot', label: '⚡ DEPLOY', x: CW - PAD - 120, y: 76, w: 120, h: BTN_H, color: 'rgba(255,204,0,0.3)', view: 'create', action: () => { if (this.cb.deployCreator) this.cb.deployCreator(); this._view = 'main'; } }
    );

    return btns;
  }

  // ─────────────────── Show / Hide / Toggle ───────────────────
  show() {
    if (this._visible) return;
    this._visible = true;
    this.mesh.visible = true;
    this._needsPositioning = true;
    this._framesSinceShow = 0;
    this.scene.add(this.mesh);
  }

  hide() {
    if (!this._visible) return;
    this._visible = false;
    this.mesh.visible = false;
    this.scene.remove(this.mesh);
  }

  toggle() { this._visible ? this.hide() : this.show(); }
  get visible() { return this._visible; }

  /** Activate the toggle tab (call when entering VR) */
  activate() {
    this._tabActive = true;
    this.tabMesh.visible = true;
    this.scene.add(this.tabMesh);
    this._drawTab();
  }

  /** Deactivate everything (call when exiting VR) */
  deactivate() {
    this.hide();
    this._tabActive = false;
    this.tabMesh.visible = false;
    this.scene.remove(this.tabMesh);
  }

  // ─────────────────── Per-frame update ───────────────────
  /**
   * @param {number} dt
   * @param {Array<{ray: object, triggerPressed: boolean}>} inputs
   * @param {object} statsData — extracted telemetry data
   */
  update(dt, inputs, statsData = null) {
    if (statsData) this._statsData = statsData;

    // Backward compatibility for old signature
    if (!Array.isArray(inputs)) {
      inputs = [{ id: 'right', ray: inputs, triggerPressed: arguments[2] }];
      statsData = arguments[3] || null;
      if (statsData) this._statsData = statsData;
    }

    if (!this._triggerHeldMap) this._triggerHeldMap = {};
    if (!this._localPos) this._localPos = new THREE.Vector3();
    const nextTriggerMap = {};

    let anyTriggerPressed = false;
    let toggledThisFrame = false;

    // ── Always process toggle tab (even when panel hidden) ──
    if (this._tabActive) {
      this._positionTab();
      this._tabHovered = false;
      for (const input of inputs) {
        const id = input.id || 'default';
        if (input.triggerPressed) anyTriggerPressed = true;
        const wasHeld = this._triggerHeldMap[id] || false;
        
        if (input.ray) {
          this._raycaster.set(input.ray.origin, input.ray.direction);
          const tabHits = this._raycaster.intersectObject(this.tabMesh);
          if (tabHits.length > 0) {
            this._tabHovered = true;
            if (input.triggerPressed && !wasHeld) {
              toggledThisFrame = true;
            }
          }
        } else if (input.touchPos) {
          this.tabMesh.worldToLocal(this._localPos.copy(input.touchPos));
          if (this._localPos.z < 0.02 && this._localPos.z > -0.15 &&
              this._localPos.x >= -0.075 && this._localPos.x <= 0.075 &&
              this._localPos.y >= -0.025 && this._localPos.y <= 0.025) {
            this._tabHovered = true;
            anyTriggerPressed = true;
            if (!wasHeld) toggledThisFrame = true;
          }
        }
      }
      if (toggledThisFrame) this.toggle();
      this._drawTab();
    } else {
      for (const input of inputs) {
        if (input.triggerPressed) anyTriggerPressed = true;
      }
    }

    if (!this._visible) {
      for (const input of inputs) {
        const id = input.id || 'default';
        nextTriggerMap[id] = input.triggerPressed;
      }
      this._triggerHeldMap = nextTriggerMap;
      return;
    }

    // ── Position the main panel ──
    this._positionPanel();

    // ── Raycast interaction with panel ──
    this._hoverUVs = [];
    this._hoverUV = null;
    this._hoveredEl = null;

    for (const input of inputs) {
      const id = input.id || 'default';
      const wasHeld = this._triggerHeldMap[id] || false;
      let triggered = input.triggerPressed || false;
      let uvPos = null;

      if (input.ray && !this._tabHovered) {
        this._raycaster.set(input.ray.origin, input.ray.direction);
        const hits = this._raycaster.intersectObject(this.mesh);
        if (hits.length > 0 && hits[0].uv) {
          const u = hits[0].uv;
          uvPos = { x: u.x * CW, y: (1 - u.y) * CH };
        }
      } else if (input.touchPos && !this._tabHovered) {
        this.mesh.worldToLocal(this._localPos.copy(input.touchPos));
        if (this._localPos.z < 0.02 && this._localPos.z > -0.15 &&
            this._localPos.x >= -0.4 && this._localPos.x <= 0.4 &&
            this._localPos.y >= -0.225 && this._localPos.y <= 0.225) {
          triggered = true; // Synthetic press
          const u = (this._localPos.x + 0.4) / 0.8;
          const v = (this._localPos.y + 0.225) / 0.45;
          uvPos = { x: u * CW, y: (1 - v) * CH };
        }
      }

      nextTriggerMap[id] = triggered;
      if (triggered) anyTriggerPressed = true;

      if (uvPos) {
        this._hoverUVs.push(uvPos);
        this._hoverUV = uvPos; // Used by _processInteraction
        const isClick = triggered && !wasHeld;
        this._processInteraction(triggered, isClick);
      }
    }

    if (!anyTriggerPressed) {
      this._dragging = null;
    }
    this._triggerHeldMap = nextTriggerMap;

    // ── Redraw canvas ──
    this._draw();
    this._tex.needsUpdate = true;
  }

  // ─────────────────── Panel positioning (LEFT SIDE) ───────────────────
  _positionPanel() {
    // If it's already positioned (anchored), don't move it!
    // This allows the user to lean in and touch it physically without it running away.
    if (!this._needsPositioning && this.mesh.position.lengthSq() > 0.01) return;

    const rp = this.xrRig.position;
    let headPos = new THREE.Vector3(rp.x, rp.y + 1.5, rp.z);

    // Try camera for better accuracy
    let hasGoodCam = false;
    const cam = this.xrRig.children.find(c => c.isCamera);
    if (cam) {
      cam.updateWorldMatrix(true, false);
      const cp = new THREE.Vector3();
      cam.getWorldPosition(cp);
      if (cp.lengthSq() > 0.1 || this._framesSinceShow > 30) {
        headPos.copy(cp);
        hasGoodCam = true;
      }
    }

    this._framesSinceShow = (this._framesSinceShow || 0) + 1;

    // Wait until we have a good camera position or timeout
    if (!hasGoodCam && this._framesSinceShow < 30) {
      return; // Skip positioning this frame
    }

    // Anchor to the LEFT of the user, slightly angled
    this._targetPos.set(headPos.x - 0.65, headPos.y - 0.15, headPos.z - 0.9);
    this.mesh.position.copy(this._targetPos);

    // Face the user (swap eye/target so front face points to head)
    const lookMat = new THREE.Matrix4().lookAt(headPos, this.mesh.position, new THREE.Vector3(0, 1, 0));
    const lookQ = new THREE.Quaternion().setFromRotationMatrix(lookMat);
    this.mesh.quaternion.copy(lookQ);

    this._needsPositioning = false;
  }

  // ─────────────────── Tab positioning + drawing ───────────────────
  _positionTab() {
    const rp = this.xrRig.position;
    let headPos = new THREE.Vector3(rp.x, rp.y + 1.5, rp.z);
    const cam = this.xrRig.children.find(c => c.isCamera);
    if (cam) {
      cam.updateWorldMatrix(true, false);
      const cp = new THREE.Vector3();
      cam.getWorldPosition(cp);
      if (cp.lengthSq() > 0.5) headPos.copy(cp);
    }

    // Tab: lower-left of view, always accessible
    const tabTarget = new THREE.Vector3(headPos.x - 0.35, headPos.y - 0.45, headPos.z - 0.7);
    this.tabMesh.position.lerp(tabTarget, 0.08);
    this.tabMesh.lookAt(headPos);
  }

  _drawTab() {
    const ctx = this._tabCtx;
    const w = 180, h = 72;
    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = this._tabHovered ? 'rgba(255,204,0,0.25)' : 'rgba(14, 20, 30, 0.90)';
    ctx.fillRect(0, 0, w, h);

    // Border
    ctx.strokeStyle = this._tabHovered ? '#ffcc00' : 'rgba(255,204,0,0.30)';
    ctx.lineWidth = this._tabHovered ? 3 : 2;
    ctx.strokeRect(1, 1, w - 2, h - 2);

    // Top accent
    ctx.fillStyle = this._visible ? '#00cc55' : '#ffcc00';
    ctx.fillRect(0, 0, w, 3);

    // Text
    ctx.fillStyle = this._tabHovered ? '#fff' : (this._visible ? '#00cc55' : '#ffcc00');
    ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this._visible ? '✕ HIDE UI' : '☰ SHOW UI', w / 2, h / 2 + 2);

    this._tabTex.needsUpdate = true;
  }

  // ─────────────────── Interaction processing ───────────────────
  _processInteraction(triggerPressed, isClick = false) {
    const { x, y } = this._hoverUV;

    // Check sliders
    if (this._view === 'main') {
      for (const s of this._sliders) {
        if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) {
          this._hoveredEl = s.id;
          if (triggerPressed) {
            this._dragging = s.id;
          }
        }
      }
    }

    // Drag slider
    if (this._dragging) {
      const s = this._sliders.find(sl => sl.id === this._dragging);
      if (s) {
        const ratio = Math.max(0, Math.min(1, (x - s.x) / s.w));
        const val = s.min + ratio * (s.max - s.min);
        if (s.id === 'gripper') {
          this.cb.setSqueeze((55 - val) / (55 - 14));
        } else {
          this.cb.moveJoint(s.id, val);
        }
      }
      return;
    }

    // Check robots list
    if (this._view === 'robots') {
      const robots = this._statsData?.robots || [];
      let ty = 140;
      for (let i = 0; i < robots.length; i++) {
        if (x >= PAD && x <= CW - PAD && y >= ty && y <= ty + 46) {
          this._hoveredEl = 'robot_' + i;
          if (isClick && robots[i].isFree && !robots[i].isYours) {
            if (this.cb.claimRobot) this.cb.claimRobot(i);
            this._view = 'main';
          }
        }
        ty += 56;
      }
    }

    // Check create view interactions (Type, Color, Map)
    if (this._view === 'create') {
      // Type
      if (x >= PAD && x <= CW / 2 - 5 && y >= 140 && y <= 180) {
        this._hoveredEl = 'type_ind';
        if (isClick && this.cb.setCreatorType) {
          this.cb.setCreatorType('industrial');
        }
      }
      if (x >= CW / 2 + 5 && x <= CW - PAD && y >= 140 && y <= 180) {
        this._hoveredEl = 'type_cob';
        if (isClick && this.cb.setCreatorType) {
          this.cb.setCreatorType('cobot');
        }
      }
      // Colors
      const cSize = 40;
      const cGap = (CW - PAD * 2 - cSize * 6) / 5;
      for (let i = 0; i < 6; i++) {
        const cx = PAD + i * (cSize + cGap);
        if (x >= cx && x <= cx + cSize && y >= 210 && y <= 250) {
          this._hoveredEl = 'col_' + i;
          if (isClick && this.cb.setCreatorColor) {
            const colors = [0xF7931E, 0xCC2936, 0xE8B931, 0x2C7AB5, 0x44BB88, 0x9955CC];
            this.cb.setCreatorColor(colors[i]);
          }
        }
      }
      // Map
      const mapY = 490;
      const mapH = 180;
      if (x >= PAD && x <= CW - PAD && y >= mapY && y <= mapY + mapH) {
        if (triggerPressed && this.cb.setCreatorMapPos) {
          const u = (x - PAD) / (CW - PAD * 2);
          const v = (y - mapY) / mapH;
          this.cb.setCreatorMapPos(u, v);
        }
      }
    }

    // Check buttons
    for (const b of this._buttons) {
      if (b.view && b.view !== this._view) continue;
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        this._hoveredEl = b.id;
        if (isClick) {
          b.action();
        }
      }
    }
  }

  // ─────────────────── Canvas drawing ───────────────────
  _draw() {
    const ctx = this._ctx;
    const active = this.cb.getActive();

    // ── Background ──
    ctx.clearRect(0, 0, CW, CH);

    // Rounded panel background
    this._roundRect(0, 0, CW, CH, 18, C.panelBg);
    ctx.strokeStyle = C.border;
    ctx.lineWidth = 2;
    this._roundRectStroke(0, 0, CW, CH, 18);

    // Top accent line
    ctx.fillStyle = C.accent;
    ctx.fillRect(20, 0, CW - 40, 2);

    // ── Title ──
    ctx.fillStyle = C.accent;
    ctx.font = 'bold 26px Rajdhani, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('VR  CONTROL', CW / 2, 40);

    ctx.fillStyle = C.textDim;
    ctx.font = '11px "Share Tech Mono", monospace';
    ctx.fillText(`ROBOT ${(this.cb.getActiveIdx?.() ?? 0) + 1}  ·  ${this.cb.getGrabbed?.() ? 'GRIP ACTIVE' : 'STANDBY'}`, CW / 2, 60);

    if (this._view === 'main') {
      // ── Separator ──
      ctx.strokeStyle = 'rgba(255,204,0,0.15)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(PAD, 74); ctx.lineTo(CW - PAD, 74); ctx.stroke();

      // ── Mode indicator ──
      ctx.fillStyle = C.textDim;
      ctx.font = '10px "Share Tech Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText('JOINT  SLIDERS', PAD + 10, 96);

      // ── Sliders ──
      for (const s of this._sliders) {
        this._drawSlider(ctx, s, active);
      }

      // ── Telemetry section ──
      this._drawTelemetry(ctx, active);
    } else if (this._view === 'camera') {
      this._drawCameraVision(ctx);
    } else if (this._view === 'robots') {
      this._drawRobots(ctx);
    } else if (this._view === 'create') {
      this._drawCreator(ctx);
    }

    // ── Buttons ──
    for (const b of this._buttons) {
      if (b.view === this._view) {
        this._drawButton(ctx, b);
      }
    }

    // ── Cursor dots ──
    if (this._hoverUVs && this._hoverUVs.length > 0) {
      for (const uv of this._hoverUVs) {
        ctx.beginPath();
        ctx.arc(uv.x, uv.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.fill();
        ctx.strokeStyle = C.accent;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    } else if (this._hoverUV) {
      ctx.beginPath();
      ctx.arc(this._hoverUV.x, this._hoverUV.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fill();
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  _drawSlider(ctx, s, active) {
    let val;
    if (s.id === 'gripper') {
      val = active ? Math.round((active.FOPEN / 0.38) * 100) : 38;
      // Clamp to slider range
      val = Math.max(s.min, Math.min(s.max, val));
    } else {
      val = active ? active.jCurrent[s.id] ?? 0 : 0;
    }

    const isHovered = this._hoveredEl === s.id;
    const isDragged = this._dragging === s.id;

    // Label + value
    ctx.fillStyle = isHovered ? '#fff' : C.text;
    ctx.font = '12px "Share Tech Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(s.label, s.x, s.y - 4);
    ctx.textAlign = 'right';
    ctx.fillStyle = s.color;
    ctx.fillText(s.id === 'gripper' ? `${Math.round(val)}mm` : `${Math.round(val)}°`, s.x + s.w, s.y - 4);

    // Track background
    const trackY = s.y + 6;
    const trackH = 10;
    ctx.fillStyle = isHovered ? 'rgba(255,255,255,0.12)' : C.sliderBg;
    this._roundRect(s.x, trackY, s.w, trackH, 3, ctx.fillStyle);

    // Fill
    const ratio = (val - s.min) / (s.max - s.min);
    const fillW = Math.max(2, ratio * s.w);
    ctx.fillStyle = isDragged ? '#fff' : s.color;
    ctx.globalAlpha = isDragged ? 1.0 : 0.7;
    this._roundRect(s.x, trackY, fillW, trackH, 3, ctx.fillStyle);
    ctx.globalAlpha = 1.0;

    // Thumb
    const thumbX = s.x + ratio * s.w;
    ctx.beginPath();
    ctx.arc(thumbX, trackY + trackH / 2, isDragged ? 8 : 6, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    if (isDragged) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  _drawButton(ctx, b) {
    const isHovered = this._hoveredEl === b.id;
    const bg = isHovered ? C.btnHover : b.color;

    this._roundRect(b.x, b.y, b.w, b.h, 6, bg);
    ctx.strokeStyle = isHovered ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    this._roundRectStroke(b.x, b.y, b.w, b.h, 6);

    ctx.fillStyle = isHovered ? '#fff' : C.text;
    ctx.font = 'bold 14px Rajdhani, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 5);
  }

  _drawTelemetry(ctx, active) {
    const y0 = 590; // Shifted down to make room for EXIT button
    ctx.strokeStyle = 'rgba(255,204,0,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD, y0); ctx.lineTo(CW - PAD, y0); ctx.stroke();

    ctx.fillStyle = C.textDim;
    ctx.font = '10px "Share Tech Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText('TELEMETRY', PAD + 10, y0 + 18);

    if (!active) return;

    const joints = [
      { label: 'BASE', val: active.jCurrent.base, color: C.accent },
      { label: 'SHLD', val: active.jCurrent.shoulder, color: C.blue },
      { label: 'ELBW', val: active.jCurrent.elbow, color: C.green },
      { label: 'WRST', val: active.jCurrent.wrist, color: C.purple },
    ];

    let ty = y0 + 38;
    for (const j of joints) {
      ctx.fillStyle = C.textDim;
      ctx.font = '11px "Share Tech Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText(j.label, PAD + 10, ty);

      // Bar
      const barX = PAD + 70;
      const barW = CW - PAD * 2 - 120;
      const barH = 4;
      ctx.fillStyle = C.sliderBg;
      ctx.fillRect(barX, ty - 4, barW, barH);
      const ratio = (j.val + 180) / 360;
      ctx.fillStyle = j.color;
      ctx.globalAlpha = 0.6;
      ctx.fillRect(barX, ty - 4, ratio * barW, barH);
      ctx.globalAlpha = 1.0;

      // Value
      ctx.fillStyle = j.color;
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.round(j.val)}°`, CW - PAD - 10, ty);
      ty += 24;
    }

    // Status
    ty += 10;
    ctx.strokeStyle = 'rgba(255,204,0,0.1)';
    ctx.beginPath(); ctx.moveTo(PAD, ty - 8); ctx.lineTo(CW - PAD, ty - 8); ctx.stroke();

    const grabbed = this.cb.getGrabbed?.();
    const status = this.cb.getStatus?.() ?? (grabbed ? 'GRIP ACTIVE' : 'STANDBY');
    ctx.fillStyle = grabbed ? C.green : C.accent;
    ctx.font = 'bold 13px "Share Tech Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`STATUS: ${status}`, CW / 2, ty + 8);

    // Hint
    ctx.fillStyle = C.textDim;
    ctx.font = '9px "Share Tech Mono", monospace';
    ctx.fillText('R-STICK: JOINTS · L-STICK: DRIVE · CLICK STICK: MODE', CW / 2, ty + 28);
    ctx.fillText('A: CREATE · B: TOGGLE PANEL · SQUEEZE R: GRIP', CW / 2, ty + 42);
  }

  _drawCameraVision(ctx) {
    let ty = 140;

    ctx.fillStyle = C.accent;
    ctx.font = '14px "Share Tech Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText('ROBOT CAMERA VISION', PAD + 10, ty);

    ctx.strokeStyle = 'rgba(255,204,0,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD, ty + 8); ctx.lineTo(CW - PAD, ty + 8); ctx.stroke();

    ty += 30;

    const s = this._statsData || {};
    if (s.visionCanvas) {
      // Draw the camera feed. VRUI width is CW=480, draw it as large as possible.
      const w = CW - PAD * 2; // 440
      const h = w * (s.visionCanvas.height / s.visionCanvas.width);

      ctx.drawImage(s.visionCanvas, PAD, ty, w, h);

      // Add industrial border
      ctx.strokeStyle = 'rgba(77, 170, 255, 0.5)';
      ctx.lineWidth = 2;
      ctx.strokeRect(PAD, ty, w, h);

      // REC indicator (blinking)
      if (Math.floor(Date.now() / 500) % 2 === 0) {
        ctx.fillStyle = '#ff3333';
        ctx.beginPath();
        ctx.arc(PAD + 16, ty + 16, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'left';
        ctx.fillText('REC', PAD + 24, ty + 20);
      }

      // Crosshair
      const cx = PAD + w / 2;
      const cy = ty + h / 2;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx - 10, cy); ctx.lineTo(cx + 10, cy);
      ctx.moveTo(cx, cy - 10); ctx.lineTo(cx, cy + 10);
      ctx.stroke();

    } else {
      ctx.fillStyle = C.textDim;
      ctx.font = '12px "Share Tech Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('CAMERA FEED UNAVAILABLE', CW / 2, ty + 100);
    }
  }

  _drawRobots(ctx) {
    const robots = this._statsData?.robots || [];
    let ty = 140;

    ctx.fillStyle = C.accent;
    ctx.font = '14px "Share Tech Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText('SELECT ROBOT', PAD + 10, ty);

    ctx.strokeStyle = 'rgba(255,204,0,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD, ty + 8); ctx.lineTo(CW - PAD, ty + 8); ctx.stroke();

    ty += 30;

    const META = window.ROBOT_META || [];

    for (let i = 0; i < robots.length; i++) {
      const st = robots[i];
      const m = META[i] || { name: `Robot ${i + 1}`, type: 'Unknown', color: '#888' };

      const isHovered = this._hoveredEl === 'robot_' + i;

      let bg = 'rgba(255,255,255,0.02)';
      let border = 'rgba(255,255,255,0.06)';
      let statusTxt = '🔒 IN USE';
      let statusCol = '#cc4444';

      if (st.isYours) {
        bg = 'rgba(0, 255, 136, 0.05)';
        border = 'rgba(0, 255, 136, 0.40)';
        statusTxt = '● YOURS';
        statusCol = '#00cc66';
      } else if (st.isFree) {
        bg = isHovered ? 'rgba(255,204,0,0.06)' : 'rgba(255,255,255,0.02)';
        border = isHovered ? 'rgba(255,204,0,0.30)' : 'rgba(255,255,255,0.06)';
        statusTxt = '◎ FREE';
        statusCol = '#00ff88';
      }

      this._roundRect(PAD, ty, CW - PAD * 2, 46, 6, bg);
      ctx.strokeStyle = border;
      ctx.lineWidth = 1;
      this._roundRectStroke(PAD, ty, CW - PAD * 2, 46, 6);

      this._roundRect(PAD + 14, ty + 16, 14, 14, 3, m.color);

      ctx.fillStyle = C.text;
      ctx.font = 'bold 14px Rajdhani, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(m.name, PAD + 40, ty + 20);

      ctx.fillStyle = C.textDim;
      ctx.font = '9px "Share Tech Mono", monospace';
      ctx.fillText(m.type, PAD + 40, ty + 34);

      ctx.fillStyle = statusCol;
      ctx.font = 'bold 10px "Share Tech Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText(statusTxt, CW - PAD - 14, ty + 28);

      ty += 56;
    }
  }

  _drawCreator(ctx) {
    let ty = 130;

    const state = this.cb.getCreatorState?.();
    if (!state) return;

    // Type toggles
    ctx.fillStyle = C.textDim;
    ctx.font = '10px "Share Tech Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText('ROBOT TYPE', PAD, ty);
    ty += 10;

    const isInd = state.type === 'industrial';
    const isCob = state.type === 'cobot';

    // Industrial btn
    this._roundRect(PAD, ty, CW / 2 - PAD - 5, 40, 6, isInd ? 'rgba(255,204,0,0.2)' : C.btnBg);
    if (this._hoveredEl === 'type_ind') ctx.fillStyle = '#fff'; else ctx.fillStyle = isInd ? C.accent : C.text;
    ctx.font = 'bold 14px Rajdhani';
    ctx.textAlign = 'center';
    ctx.fillText('🏭 INDUSTRIAL', PAD + (CW / 2 - PAD - 5) / 2, ty + 25);

    // Cobot btn
    this._roundRect(CW / 2 + 5, ty, CW / 2 - PAD - 5, 40, 6, isCob ? 'rgba(44, 122, 181, 0.4)' : C.btnBg);
    if (this._hoveredEl === 'type_cob') ctx.fillStyle = '#fff'; else ctx.fillStyle = isCob ? '#4D9EE0' : C.text;
    ctx.fillText('🤝 COBOT', CW / 2 + 5 + (CW / 2 - PAD - 5) / 2, ty + 25);

    ty += 60;

    // Colors
    ctx.fillStyle = C.textDim;
    ctx.font = '10px "Share Tech Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText('ARM COLOR', PAD, ty);
    ty += 10;

    const colors = [0xF7931E, 0xCC2936, 0xE8B931, 0x2C7AB5, 0x44BB88, 0x9955CC];
    const cSize = 40;
    const cGap = (CW - PAD * 2 - cSize * 6) / 5;
    for (let i = 0; i < 6; i++) {
      const cx = PAD + i * (cSize + cGap);
      const hexStr = '#' + colors[i].toString(16).padStart(6, '0');
      ctx.fillStyle = hexStr;
      this._roundRect(cx, ty, cSize, cSize, 4, hexStr);

      if (state.color === colors[i]) {
        ctx.strokeStyle = C.accent;
        ctx.lineWidth = 3;
        this._roundRectStroke(cx, ty, cSize, cSize, 4);
      } else if (this._hoveredEl === 'col_' + i) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        this._roundRectStroke(cx, ty, cSize, cSize, 4);
      }
    }

    ty += 60;

    // Preview
    ctx.fillStyle = C.textDim;
    ctx.textAlign = 'left';
    ctx.fillText('3D PREVIEW', PAD, ty);
    ty += 10;

    if (state.prevCanvas) {
      const pW = CW - PAD * 2;
      const pH = 180;
      // fill background
      ctx.fillStyle = '#060a10';
      ctx.fillRect(PAD, ty, pW, pH);
      ctx.drawImage(state.prevCanvas, PAD, ty, pW, pH);
      ctx.strokeStyle = 'rgba(255,204,0,0.3)';
      ctx.lineWidth = 1;
      ctx.strokeRect(PAD, ty, pW, pH);
    }

    ty += 200;

    // Map
    ctx.fillStyle = C.textDim;
    ctx.fillText('DEPLOYMENT MAP (CLICK TO PLACE)', PAD, ty);
    ty += 10;

    if (state.mapCanvas) {
      const mW = CW - PAD * 2;
      const mH = 180;
      ctx.fillRect(PAD, ty, mW, mH);
      ctx.drawImage(state.mapCanvas, PAD, ty, mW, mH);
      ctx.strokeStyle = 'rgba(255,204,0,0.3)';
      ctx.lineWidth = 1;
      ctx.strokeRect(PAD, ty, mW, mH);
    }
  }

  // ─────────────────── Canvas helpers ───────────────────
  _roundRect(x, y, w, h, r, fill) {
    const ctx = this._ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  _roundRectStroke(x, y, w, h, r) {
    const ctx = this._ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.stroke();
  }

  // ─────────────────── Cleanup ───────────────────
  dispose() {
    this.deactivate();
    this._tex.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this._tabTex.dispose();
    this.tabMesh.geometry.dispose();
    this.tabMesh.material.dispose();
  }
}
