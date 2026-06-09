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
const PAD      = 20;
const SLIDER_H = 32;
const SLIDER_GAP = 54;
const BTN_H    = 38;
const BTN_GAP  = 46;

// ── Colours ──
const C = {
  bg:       'rgba(12, 16, 24, 0.88)',
  panelBg:  'rgba(18, 24, 34, 0.92)',
  border:   'rgba(255, 204, 0, 0.28)',
  accent:   '#ffcc00',
  accentDim:'rgba(255,204,0,0.35)',
  text:     '#d0d8e0',
  textDim:  '#5a6a7a',
  sliderBg: 'rgba(255,255,255,0.08)',
  sliderFill:'#ffcc00',
  btnBg:    'rgba(255,255,255,0.06)',
  btnHover: 'rgba(255,255,255,0.14)',
  btnGrab:  'rgba(46,138,80,0.35)',
  btnRelease:'rgba(204,51,34,0.35)',
  btnReset: 'rgba(74,106,138,0.35)',
  btnSwitch:'rgba(150,80,200,0.35)',
  green:    '#00cc55',
  red:      '#cc3322',
  blue:     '#4a88cc',
  purple:   '#9955cc',
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
    this.cb    = cb;

    this._visible = false;
    this._tabActive = false;
    this._view = 'main'; // 'main' or 'stats'

    // ── Canvas + Texture ──
    this._canvas = document.createElement('canvas');
    this._canvas.width  = CW;
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
      mk('base',     'BASE',     -180, 180, C.accent),
      mk('shoulder', 'SHOULDER', -180, 180, C.blue),
      mk('elbow',    'ELBOW',    -180, 180, C.green),
      mk('wrist',    'WRIST',    -180, 180, C.purple),
      mk('gripper',  'GRIPPER',    14,  55, '#ff8833'),
    ];
  }

  _defineButtons() {
    const bw = (CW - PAD * 2 - 16) / 2;
    let y = 400;
    const btns = [
      { id: 'grab',    label: '✊ GRAB',    x: PAD, y, w: bw, h: BTN_H, color: C.btnGrab,    view: 'main', action: () => this.cb.grab() },
      { id: 'release', label: '🤚 RELEASE', x: PAD + bw + 16, y, w: bw, h: BTN_H, color: C.btnRelease, view: 'main', action: () => this.cb.release() },
    ];
    y += BTN_GAP;
    btns.push(
      { id: 'reset',  label: '🔄 RESET',   x: PAD, y, w: bw, h: BTN_H, color: C.btnReset,  view: 'main', action: () => this.cb.resetJoints() },
      { id: 'switch', label: '🔀 SWITCH',  x: PAD + bw + 16, y, w: bw, h: BTN_H, color: C.btnSwitch, view: 'main', action: () => this.cb.switchRobot() },
    );
    y += BTN_GAP;
    btns.push(
      { id: 'stats', label: '📊 STATISTICS', x: PAD, y, w: bw, h: BTN_H, color: C.btnReset, view: 'main', action: () => { this._view = 'stats'; } },
      { id: 'exit',  label: '🚪 EXIT VR',    x: PAD + bw + 16, y, w: bw, h: BTN_H, color: '#aa3333', view: 'main', action: () => { if (this.cb.exitXR) this.cb.exitXR(); } }
    );

    // Stats view buttons
    btns.push(
      { id: 'back', label: '◀ BACK', x: PAD, y: 76, w: 100, h: BTN_H, color: C.btnBg, view: 'stats', action: () => { this._view = 'main'; } }
    );

    return btns;
  }

  // ─────────────────── Show / Hide / Toggle ───────────────────
  show() {
    if (this._visible) return;
    this._visible = true;
    this.mesh.visible = true;
    this.mesh.position.set(0, 0, 0); // reset for snap
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
   * @param {{ origin: THREE.Vector3, direction: THREE.Vector3 }|null} ray
   *   — from VRControllerManager.getRay('right')
   * @param {boolean} triggerPressed — is right trigger pressed this frame
   * @param {object} statsData — extracted telemetry data
   */
  update(dt, ray, triggerPressed, statsData = null) {
    if (statsData) this._statsData = statsData;

    // ── Always process toggle tab (even when panel hidden) ──
    if (this._tabActive) {
      this._positionTab();
      this._tabHovered = false;
      if (ray) {
        this._raycaster.set(ray.origin, ray.direction);
        const tabHits = this._raycaster.intersectObject(this.tabMesh);
        if (tabHits.length > 0) {
          this._tabHovered = true;
          // Toggle on trigger PRESS (rising edge)
          if (triggerPressed && !this._triggerHeld) {
            this.toggle();
          }
        }
      }
      this._drawTab();
    }

    if (!this._visible) {
      this._triggerHeld = triggerPressed;
      return;
    }

    // ── Position the main panel ──
    this._positionPanel();

    // ── Raycast interaction with panel ──
    this._hoverUV = null;
    this._hoveredEl = null;

    if (ray && !this._tabHovered) {
      this._raycaster.set(ray.origin, ray.direction);
      const hits = this._raycaster.intersectObject(this.mesh);
      if (hits.length > 0 && hits[0].uv) {
        const u = hits[0].uv;
        this._hoverUV = { x: u.x * CW, y: (1 - u.y) * CH };
        this._processInteraction(triggerPressed);
      } else {
        if (this._dragging && !triggerPressed) this._dragging = null;
      }
    }

    if (!triggerPressed) {
      if (this._triggerHeld && this._hoveredEl) {
        const btn = this._buttons.find(b => b.id === this._hoveredEl);
        if (btn) btn.action();
      }
      this._dragging = null;
    }
    this._triggerHeld = triggerPressed;

    // ── Redraw canvas ──
    this._draw();
    this._tex.needsUpdate = true;
  }

  // ─────────────────── Panel positioning (LEFT SIDE) ───────────────────
  _positionPanel() {
    const rp = this.xrRig.position;
    let headPos = new THREE.Vector3(rp.x, rp.y + 1.5, rp.z);

    // Try camera for better accuracy
    const cam = this.xrRig.children.find(c => c.isCamera);
    if (cam) {
      cam.updateWorldMatrix(true, false);
      const cp = new THREE.Vector3();
      cam.getWorldPosition(cp);
      if (cp.lengthSq() > 0.5) headPos.copy(cp);
    }

    // Panel to the LEFT of the user, slightly angled
    this._targetPos.set(headPos.x - 0.65, headPos.y - 0.15, headPos.z - 0.9);

    // Snap on first frame, then smooth
    if (this.mesh.position.lengthSq() < 0.01) {
      this.mesh.position.copy(this._targetPos);
    } else {
      this.mesh.position.lerp(this._targetPos, 0.05);
    }

    // Face the user (swap eye/target so front face points to head)
    const lookMat = new THREE.Matrix4().lookAt(headPos, this.mesh.position, new THREE.Vector3(0, 1, 0));
    const lookQ = new THREE.Quaternion().setFromRotationMatrix(lookMat);
    if (this.mesh.quaternion.lengthSq() < 0.01) {
      this.mesh.quaternion.copy(lookQ);
    } else {
      this.mesh.quaternion.slerp(lookQ, 0.06);
    }
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
  _processInteraction(triggerPressed) {
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

    // Check buttons
    for (const b of this._buttons) {
      if (b.view && b.view !== this._view) continue;
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        this._hoveredEl = b.id;
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
    } else if (this._view === 'stats') {
      this._drawStatistics(ctx);
    }

    // ── Buttons ──
    for (const b of this._buttons) {
      if (b.view === this._view) {
        this._drawButton(ctx, b);
      }
    }

    // ── Cursor dot ──
    if (this._hoverUV) {
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
    const y0 = 540; // Shifted down to make room for EXIT button
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
    ctx.fillText('A: RESET · B: TOGGLE PANEL · SQUEEZE R: GRIP', CW / 2, ty + 42);
  }

  _drawStatistics(ctx) {
    const s = this._statsData || {};
    let ty = 140;

    ctx.fillStyle = C.accent;
    ctx.font = '14px "Share Tech Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText('FULL STATISTICS', PAD + 10, ty);
    
    ctx.strokeStyle = 'rgba(255,204,0,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD, ty + 8); ctx.lineTo(CW - PAD, ty + 8); ctx.stroke();

    ty += 30;
    
    const drawRow = (lbl, val, col = C.text) => {
      ctx.fillStyle = C.textDim;
      ctx.font = '12px "Share Tech Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText(lbl, PAD + 10, ty);
      ctx.fillStyle = col;
      ctx.textAlign = 'right';
      ctx.fillText(val, CW - PAD - 10, ty);
      ty += 20;
    };

    ctx.fillStyle = C.blue;
    ctx.font = '12px "Share Tech Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText('BOX POSITION', PAD + 10, ty);
    ty += 20;
    drawRow('X Axis', s.boxX, C.text);
    drawRow('Y Axis', s.boxY, C.text);
    drawRow('Z Axis', s.boxZ, C.text);
    drawRow('Distance', s.boxDist, C.accent);
    
    ty += 10;
    ctx.fillStyle = C.purple;
    ctx.font = '12px "Share Tech Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText('TCP POSITION', PAD + 10, ty);
    ty += 20;
    drawRow('X Axis', s.tcpX, C.text);
    drawRow('Y Axis', s.tcpY, C.text);
    drawRow('Z Axis', s.tcpZ, C.text);

    ty += 10;
    ctx.fillStyle = '#ff8833';
    ctx.font = '12px "Share Tech Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText('FINGER SENSORS', PAD + 10, ty);
    ty += 20;
    
    drawRow('Left Tip', s.lTip, s.lTip !== 'OFF' ? C.green : C.textDim);
    drawRow('Left Mid', s.lMid, s.lMid !== 'OFF' ? C.green : C.textDim);
    drawRow('Left Base', s.lBase, s.lBase !== 'OFF' ? C.green : C.textDim);
    drawRow('Right Tip', s.rTip, s.rTip !== 'OFF' ? C.green : C.textDim);
    drawRow('Right Mid', s.rMid, s.rMid !== 'OFF' ? C.green : C.textDim);
    drawRow('Right Base', s.rBase, s.rBase !== 'OFF' ? C.green : C.textDim);
    
    ty += 10;
    ctx.fillStyle = C.accent;
    ctx.font = '14px "Share Tech Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText('AVERAGE FORCE', PAD + 10, ty);
    ctx.textAlign = 'right';
    ctx.fillText(s.force, CW - PAD - 10, ty);
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
