import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160/build/three.module.js";

export class RobotVision {
  constructor(config = {}) {
    this.renderer = null;
    this.scene = null;
    this.cams = [];
    this.displayCanvas = null;
    this.displayCtx = null;
    this.tempCanvas = null;
    this.tempCtx = null;
    this.active = false;
    this.displayVisible = false;   // هل يُعرض الـ canvas للمستخدم (الرؤية تعمل بالخلفية دائماً)
    this.activeAll = false;
    this._allCamDefs = [];
    this._allCtx = null;
    this._allCanvas = null;
    this._allTempCanvas = null;
    this.detectedObjects = [];
    this.collisionWarnings = [];
    this.frameCount = 0;
    this._targets = {};
    this._activeRobot = null;
    this._worldVec = new THREE.Vector3();

    this._nextId = 1;
    this._trackedObjects = new Map();
    this._trackMatchDist = 0.8;
    this._trackMaxAge = 30;

    this._onCollisionStop = null;

    this.width = config.width ?? 320;
    this.height = config.height ?? 240;

    this.onDetect = config.onDetect ?? (() => {});
    this.onCollision = config.onCollision ?? (() => {});

    this._camDefs = [
      { label: 'BODY', mount: 'body', height: 0.85, forward: 0.45, tilt: -0.3 },
      { label: 'WRIST', mount: 'wrist', tilt: -0.15 },
    ];
  }

  init(renderer, scene, displayCanvas) {
    this.renderer = renderer;
    this.scene = scene;
    this.displayCanvas = displayCanvas;
    this.displayCtx = displayCanvas?.getContext('2d');

    const vw = this.width;
    const vh = Math.floor(this.height / 2);

    this.tempCanvas = document.createElement('canvas');
    this.tempCanvas.width = vw;
    this.tempCanvas.height = vh;
    this.tempCtx = this.tempCanvas.getContext('2d', { willReadFrequently: true });

    if (this.displayCanvas) {
      this.displayCanvas.width = this.width;
      this.displayCanvas.height = this.height;
    }

    this.cams = this._camDefs.map(def => {
      const cam = new THREE.PerspectiveCamera(100, vw / vh, 0.05, 15);
      const rt = new THREE.WebGLRenderTarget(vw, vh, {
        minFilter: THREE.LinearFilter, magFilter: THREE.NearestFilter, format: THREE.RGBAFormat,
      });
      return {
        ...def,
        cam, rt,
        frustum: new THREE.Frustum(),
        projScreen: new THREE.Matrix4(),
        camPos: new THREE.Vector3(),
        pixelBuf: new Uint8Array(vw * vh * 4),
      };
    });

    return true;
  }

  setTargets(targets) {
    this._targets = targets;
  }

  setActiveBoxId(id) {
    this._activeBoxId = id;
  }

  start() {
    if (this.active) return;
    this.active = true;
    console.log('[RobotVision] Robot camera vision activated (background)');
  }

  stop() {
    this.active = false;
    this.detectedObjects = [];
    this.collisionWarnings = [];
    if (this.displayCtx) {
      this.displayCtx.clearRect(0, 0, this.width, this.height);
    }
    console.log('[RobotVision] Robot camera vision deactivated');
  }

  // إظهار/إخفاء العرض المرئي للمستخدم — الرؤية تبقى تعمل في الخلفية
  showDisplay() {
    this.displayVisible = true;
  }

  hideDisplay() {
    this.displayVisible = false;
    if (this.displayCtx) {
      this.displayCtx.clearRect(0, 0, this.width, this.height);
    }
  }

  // ===== ALL-ROBOTS MULTI-CAMERA VIEW =====
  startAll(robots) {
    if (this.activeAll) return;
    this.activeAll = true;
    this._allFrameCount = 0;
    if (robots) this._initAllCamDefs(robots);
    console.log('[RobotVision] All-robots camera view activated');
  }

  stopAll() {
    this.activeAll = false;
    this._allCamDefs = [];
    if (this._allCtx && this._allCanvas) {
      this._allCtx.fillStyle = '#000';
      this._allCtx.fillRect(0, 0, this._allCanvas.width, this._allCanvas.height);
    }
    console.log('[RobotVision] All-robots camera view deactivated');
  }

  setAllCanvas(canvas) {
    this._allCanvas = canvas;
    this._allCtx = canvas?.getContext('2d');
    this._allTempCanvas = document.createElement('canvas');
  }

  _initAllCamDefs(robots) {
    const vw = 160, vh = 120;
    this._allCamDefs = [];
    for (let ri = 0; ri < robots.length; ri++) {
      for (let ci = 0; ci < 2; ci++) {
        const d = this._camDefs[ci];
        const cam = new THREE.PerspectiveCamera(100, vw / vh, 0.05, 15);
        const rt = new THREE.WebGLRenderTarget(vw, vh, {
          minFilter: THREE.LinearFilter, magFilter: THREE.NearestFilter, format: THREE.RGBAFormat,
        });
        this._allCamDefs.push({
          label: d.label, mount: d.mount, height: d.height, forward: d.forward, tilt: d.tilt,
          robotIdx: ri, camIdx: ci,
          cam, rt, camPos: new THREE.Vector3(),
          pixelBuf: new Uint8Array(vw * vh * 4),
          frustum: new THREE.Frustum(),
          projScreen: new THREE.Matrix4(),
        });
      }
    }
    this._allTempCanvas.width = vw;
    this._allTempCanvas.height = vh;
  }

  updateAll(robots) {
    if (!this.activeAll || !this._allCtx || !this._allCanvas) return;
    this._allFrameCount++;
    if (this._allFrameCount % 3 !== 0) return;
    if (this._allCamDefs.length === 0 && robots) this._initAllCamDefs(robots);

    const prev = this.renderer.getRenderTarget();
    const xrEnabled = this.renderer.xr.enabled;
    this.renderer.xr.enabled = false;
    const ctx = this._allCtx;
    const cv = this._allCanvas;
    const num = robots.length;
    const cols = num;
    const rows = 2;
    const cellW = Math.floor(cv.width / cols);
    const cellH = Math.floor(cv.height / rows);
    const tempCtx = this._allTempCanvas.getContext('2d');

    ctx.fillStyle = '#0a0e14';
    ctx.fillRect(0, 0, cv.width, cv.height);

    for (const vc of this._allCamDefs) {
      if (vc.robotIdx >= num) continue;
      const robot = robots[vc.robotIdx];
      if (!robot?.parts?.base?.group) continue;

      this._updateCamPos(vc, robot);
      this.renderer.setRenderTarget(vc.rt);
      this.renderer.render(this.scene, vc.cam);
      this.renderer.readRenderTargetPixels(vc.rt, 0, 0, 160, 120, vc.pixelBuf);

      const img = new ImageData(new Uint8ClampedArray(vc.pixelBuf), 160, 120);
      this._flipY(img);
      tempCtx.putImageData(img, 0, 0); // REQUIRED: Put data into temp canvas

      const cx = vc.robotIdx * cellW;
      const cy = vc.camIdx * cellH;

      ctx.drawImage(this._allTempCanvas, cx, cy, cellW, cellH);

      // Professional HUD Header Bar
      ctx.fillStyle = 'rgba(15, 20, 25, 0.75)';
      ctx.fillRect(cx, cy, cellW, 18);

      // Camera Label
      ctx.fillStyle = '#4DAAFF'; // Industrial blue
      ctx.font = 'bold 10px monospace';
      ctx.fillText(`[R${vc.robotIdx+1}] ${vc.label}`, cx + 6, cy + 13);

      // Recording Indicator (Red Dot)
      // Make it blink based on frame count for realism
      if (Math.floor(this._allFrameCount / 10) % 2 === 0) {
        ctx.fillStyle = '#FF3333';
        ctx.beginPath();
        ctx.arc(cx + cellW - 12, cy + 9, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      // Center Crosshair
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx + cellW / 2 - 8, cy + cellH / 2);
      ctx.lineTo(cx + cellW / 2 + 8, cy + cellH / 2);
      ctx.moveTo(cx + cellW / 2, cy + cellH / 2 - 8);
      ctx.lineTo(cx + cellW / 2, cy + cellH / 2 + 8);
      ctx.stroke();

      // Industrial Corner Brackets
      ctx.strokeStyle = '#4DAAFF';
      ctx.lineWidth = 1.5;
      const blen = 8;
      
      // Top-Left
      ctx.beginPath(); ctx.moveTo(cx, cy + blen); ctx.lineTo(cx, cy); ctx.lineTo(cx + blen, cy); ctx.stroke();
      // Top-Right
      ctx.beginPath(); ctx.moveTo(cx + cellW - blen, cy); ctx.lineTo(cx + cellW, cy); ctx.lineTo(cx + cellW, cy + blen); ctx.stroke();
      // Bottom-Left
      ctx.beginPath(); ctx.moveTo(cx, cy + cellH - blen); ctx.lineTo(cx, cy + cellH); ctx.lineTo(cx + blen, cy + cellH); ctx.stroke();
      // Bottom-Right
      ctx.beginPath(); ctx.moveTo(cx + cellW - blen, cy + cellH); ctx.lineTo(cx + cellW, cy + cellH); ctx.lineTo(cx + cellW, cy + cellH - blen); ctx.stroke();
    }

    this.renderer.xr.enabled = xrEnabled;
    this.renderer.setRenderTarget(prev);

    const det = document.getElementById('allCamRobots');
    if (det) det.textContent = `Robots: ${num}`;
    const det2 = document.getElementById('allCamDetections');
    if (det2) det2.textContent = `Detections: ${this.detectedObjects.length}`;
  }

  update(activeRobot) {
    if (!this.active) return;
    this._activeRobot = activeRobot;
    const prev = this.renderer.getRenderTarget();
    const xrEnabled = this.renderer.xr.enabled;
    this.renderer.xr.enabled = false;
    const vw = this.width;
    const vh = Math.floor(this.height / 2);
    const allDetections = [];

    for (let i = 0; i < this.cams.length; i++) {
      const vc = this.cams[i];
      this._updateCamPos(vc, activeRobot);
      this.renderer.setRenderTarget(vc.rt);
      this.renderer.render(this.scene, vc.cam);

      this.renderer.readRenderTargetPixels(vc.rt, 0, 0, vw, vh, vc.pixelBuf);

      // الرسم المرئي للمستخدم فقط عند فتح العرض (الكشف يستمر بالخلفية دائماً) أو عند طلبه من الـ VR
      if ((this.displayVisible || this.forceRender) && this.displayCtx) {
        const img = new ImageData(new Uint8ClampedArray(vc.pixelBuf), vw, vh);
        this._flipY(img);
        this.tempCtx.putImageData(img, 0, 0);
        this.displayCtx.drawImage(this.tempCanvas, 0, i * vh);
      }

      const dets = this._frustumDetect(vc, i);
      allDetections.push(...dets);
    }

    this.renderer.xr.enabled = xrEnabled;
    this.renderer.setRenderTarget(prev);

    const seen = new Set();
    const raw = [];
    for (const d of allDetections) {
      const key = `${d.name}_${d.worldX.toFixed(1)}_${d.worldY.toFixed(1)}_${d.worldZ.toFixed(1)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      raw.push(d);
    }

    this._trackObjects(raw);
    this._drawView();
    this._checkCollisionStop();

    if (this.detectedObjects.length > 0) this.onDetect(this.detectedObjects);
    this.frameCount++;
  }

  _updateCamPos(vc, robot) {
    const base = robot?.parts?.base?.group;
    if (!base) return;
    const yaw = robot.baseState?.yaw ?? 0;

    let camPos;
    if (vc.mount === 'wrist') {
      camPos = new THREE.Vector3();
      robot.parts?.wrist?.mesh?.getWorldPosition(camPos);
      // إزاحة الكاميرا للأمام (باتجاه النظر) وللأعلى قليلاً حتى لا يحجبها جسم الـ wrist
      const fwd = Math.cos(vc.tilt);
      camPos.x += Math.sin(yaw) * fwd * 0.18;
      camPos.z += Math.cos(yaw) * fwd * 0.18;
      camPos.y += 0.12;
    } else {
      const bp = base.position;
      const fwdDist = vc.forward || 0;
      camPos = new THREE.Vector3(
        bp.x + Math.sin(yaw) * fwdDist,
        vc.height,
        bp.z + Math.cos(yaw) * fwdDist
      );
    }
    vc.cam.position.copy(camPos);
    vc.camPos.copy(camPos);
    const lookTarget = new THREE.Vector3(
      camPos.x + Math.sin(yaw) * Math.cos(vc.tilt) * 5,
      camPos.y + Math.sin(vc.tilt) * 5,
      camPos.z + Math.cos(yaw) * Math.cos(vc.tilt) * 5
    );
    vc.cam.lookAt(lookTarget);
    vc.cam.updateMatrixWorld(true);
    vc.projScreen.multiplyMatrices(vc.cam.projectionMatrix, vc.cam.matrixWorldInverse);
    vc.frustum.setFromProjectionMatrix(vc.projScreen);
  }

  _worldToScreen(vc, wp, size) {
    this._worldVec.set(wp.x, wp.y, wp.z);
    this._worldVec.project(vc.cam);
    if (this._worldVec.z > 1) return null;
    const vw = this.width;
    const vh = Math.floor(this.height / 2);
    const sx = (this._worldVec.x * 0.5 + 0.5) * vw;
    const sy = (-this._worldVec.y * 0.5 + 0.5) * vh;
    if (sx < -50 || sx > vw + 50 || sy < -50 || sy > vh + 50) return null;
    const s = size ?? 20;
    return { x: sx, y: sy, w: s, h: s };
  }

  _sampleColor(vc, sx, sy) {
    if (!vc.pixelBuf) return '#888';
    const vw = this.width;
    const vh = Math.floor(this.height / 2);
    const px = Math.round(Math.max(0, Math.min(vw - 1, sx)));
    const py = Math.round(Math.max(0, Math.min(vh - 1, sy)));
    const idx = (py * vw + px) * 4;
    if (idx + 3 >= vc.pixelBuf.length) return '#888';
    const r = vc.pixelBuf[idx], g = vc.pixelBuf[idx + 1], b = vc.pixelBuf[idx + 2];
    return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
  }

  _frustumDetect(vc, camIndex) {
    const dets = [];
    const targets = this._targets;
    const vw = this.width;
    const vh = Math.floor(this.height / 2);
    const yOff = camIndex * vh;

    // قائمة الصناديق: نفضّل targets.boxes (متعددة)، وإلا boxPhys واحد (توافق عكسي)
    let boxList = targets.boxes;
    if (!boxList && targets.boxPhys) {
      boxList = [{ id: targets.boxPhys.__boxId ?? 0, body: targets.boxPhys }];
    }
    if (boxList) {
      for (const entry of boxList) {
        const body = entry.body ?? entry;       // يدعم {id, body} أو body مباشرة
        const boxId = entry.id ?? body.__boxId ?? 0;
        const bx = body.position.x, by = body.position.y, bz = body.position.z;
        const sphere = new THREE.Sphere(new THREE.Vector3(bx, by, bz), 0.5);
        if (!vc.frustum.intersectsSphere(sphere)) continue;
        const sc = this._worldToScreen(vc, { x: bx, y: by + 0.2, z: bz }, 35);
        if (!sc) continue;
        const dx = bx - vc.camPos.x, dy = by - vc.camPos.y, dz = bz - vc.camPos.z;
        const dist = Math.hypot(dx, dy, dz);
        const color = this._sampleColor(vc, sc.x, sc.y);
        const isActive = (this._activeBoxId !== undefined && boxId === this._activeBoxId);
        dets.push({
          name: 'box', boxId, isTarget: isActive,
          color: isActive ? '#00ff66' : '#00aaff',
          x: sc.x, y: sc.y + yOff, width: sc.w, height: sc.h, area: sc.w * sc.h,
          centerX: sc.x / vw, centerY: (sc.y + yOff) / this.height,
          worldX: bx, worldY: by, worldZ: bz,
          distance: dist, sampledColor: color, camLabel: vc.label,
        });
      }
    }

    const robots = targets.robots;
    if (robots) {
      for (let i = 0; i < robots.length; i++) {
        const r = robots[i];
        if (r === this._activeRobot) continue;
        const pos = r.parts?.base?.group?.position;
        if (!pos) continue;
        const sphere = new THREE.Sphere(new THREE.Vector3(pos.x, pos.y + 0.5, pos.z), 0.8);
        if (vc.frustum.intersectsSphere(sphere)) {
          const sc = this._worldToScreen(vc, { x: pos.x, y: pos.y + 0.5, z: pos.z }, 40);
          if (sc) {
            const dx = pos.x - vc.camPos.x, dy = pos.y + 0.5 - vc.camPos.y, dz = pos.z - vc.camPos.z;
            const dist = Math.hypot(dx, dy, dz);
            dets.push({
              name: 'robot', color: '#ff6600',
              x: sc.x, y: sc.y + yOff, width: sc.w, height: sc.h, area: sc.w * sc.h,
              centerX: sc.x / vw, centerY: (sc.y + yOff) / this.height,
              worldX: pos.x, worldY: pos.y + 0.5, worldZ: pos.z,
              distance: dist, robotIdx: i, camLabel: vc.label,
            });
          }
        }
      }
    }

    return dets;
  }

  _drawView() {
    const ctx = this.displayCtx;
    const w = this.width;
    const vh = Math.floor(this.height / 2);
    if (!ctx || (!this.displayVisible && !this.forceRender)) return;

    for (const d of this.detectedObjects) {
      const idStr = d.trackId !== undefined ? `#${d.trackId}` : '';
      const distStr = d.distance !== undefined ? `${d.distance.toFixed(2)}m` : '';
      const stableStr = d.stable !== undefined && d.stable > 10 ? '✓' : '';

      ctx.strokeStyle = d.color;
      ctx.lineWidth = 2;
      ctx.strokeRect(d.x - d.width / 2, d.y - d.height / 2, d.width, d.height);

      const boxLabel = d.boxId !== undefined ? `BOX#${d.boxId}${d.isTarget ? ' ★' : ''}` : `${d.name} ${idStr}`;
      ctx.fillStyle = d.color;
      ctx.font = 'bold 10px monospace';
      ctx.fillText(boxLabel, d.x - d.width / 2 + 3, d.y - d.height / 2 - 4);

      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.font = '8px monospace';
      ctx.fillText(distStr, d.x - d.width / 2 + 3, d.y - d.height / 2 + 12);

      if (d.sampledColor) {
        ctx.fillStyle = d.sampledColor;
        ctx.fillRect(d.x + d.width / 2 - 6, d.y - d.height / 2 - 6, 6, 6);
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 1;
        ctx.strokeRect(d.x + d.width / 2 - 6, d.y - d.height / 2 - 6, 6, 6);
      }

      if (stableStr && d.color === '#00aaff') {
        ctx.fillStyle = '#00ff88';
        ctx.font = '7px monospace';
        ctx.fillText(stableStr, d.x + d.width / 2 + 4, d.y - d.height / 2 - 4);
      }

      if (d.distance < 1.0) {
        ctx.strokeStyle = '#ff0000';
        ctx.lineWidth = 3;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(d.x - d.width / 2 - 4, d.y - d.height / 2 - 4, d.width + 8, d.height + 8);
        ctx.setLineDash([]);
      }
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, vh);
    ctx.lineTo(w, vh);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 2; i++) {
      const cy = i * vh + vh / 2;
      ctx.beginPath();
      ctx.moveTo(w / 2 - 8, cy); ctx.lineTo(w / 2 + 8, cy);
      ctx.moveTo(w / 2, cy - 8); ctx.lineTo(w / 2, cy + 8);
      ctx.stroke();
    }

    for (let i = 0; i < this.cams.length; i++) {
      const vc = this.cams[i];
      const y0 = i * vh;
      ctx.fillStyle = 'rgba(0,180,255,0.85)';
      ctx.font = 'bold 10px monospace';
      ctx.fillText(vc.label, 4, y0 + 14);
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.font = '7px monospace';
      ctx.fillText(`${vc.cam.position.y.toFixed(2)}m`, 40, y0 + 14);
    }

    const near = this.detectedObjects.filter(d => d.distance < 1.0);
    if (near.length > 0) {
      ctx.fillStyle = '#ff4444';
      ctx.font = 'bold 10px monospace';
      ctx.fillText(`⚠ NEAR ${near.length}`, 5, this.height - 6);
    }

    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.font = '7px monospace';
    ctx.fillText(`f${this.frameCount}`, w - 26, this.height - 6);
  }

  _flipY(img) {
    const w = img.width, h = img.height, rs = w * 4, half = Math.floor(h / 2);
    const buf = new Uint8Array(rs);
    for (let y = 0; y < half; y++) {
      const t = y * rs, b = (h - 1 - y) * rs;
      buf.set(img.data.subarray(t, t + rs));
      img.data.copyWithin(t, b, b + rs);
      img.data.set(buf, b);
    }
  }

  _trackObjects(detections) {
    for (const [id, tracked] of this._trackedObjects) {
      tracked.age++;
    }

    for (const d of detections) {
      let bestId = null;
      let bestDist = this._trackMatchDist;

      for (const [id, tracked] of this._trackedObjects) {
        if (tracked.name !== d.name) continue;
        const dist = Math.hypot(
          d.worldX - tracked.x,
          d.worldY - tracked.y,
          d.worldZ - tracked.z
        );
        if (dist < bestDist) {
          bestDist = dist;
          bestId = id;
        }
      }

      if (bestId !== null) {
        const t = this._trackedObjects.get(bestId);
        t.x = d.worldX; t.y = d.worldY; t.z = d.worldZ;
        t.age = 0; t.stable = t.stable + 1;
        d.trackId = bestId;
        d.stable = t.stable;
      } else {
        const newId = this._nextId++;
        this._trackedObjects.set(newId, {
          x: d.worldX, y: d.worldY, z: d.worldZ,
          age: 0, stable: 1, name: d.name,
        });
        d.trackId = newId;
        d.stable = 1;
      }
    }

    for (const [id, tracked] of this._trackedObjects) {
      if (tracked.age > this._trackMaxAge) {
        this._trackedObjects.delete(id);
      }
    }

    this.detectedObjects = detections;
  }

  setCollisionStopHandler(fn) {
    this._onCollisionStop = fn;
  }

  _checkCollisionStop() {
    if (!this._onCollisionStop) return;
    let danger = false;
    for (const d of this.detectedObjects) {
      if (d.name === 'robot' && d.distance < 1.5) { danger = true; break; }
      if (d.name === 'box' && d.distance < 0.7) { danger = true; break; }
    }
    if (danger) {
      this._onCollisionStop({ detected: this.detectedObjects });
    }
  }

  estimate3DPosition(detection) {
    if (detection.worldX !== undefined) {
      return {
        x: detection.worldX, y: detection.worldY, z: detection.worldZ,
        distance: detection.distance ?? null,
        fromCamera: detection.camLabel ?? null,
      };
    }
    return null;
  }

  getDetections() {
    return [...this.detectedObjects];
  }

  getCollisionWarnings(robotPosition, threshold = 2.0) {
    const warnings = [];
    for (const obj of this.detectedObjects) {
      const p = this.estimate3DPosition(obj);
      if (!p) continue;
      const d = obj.distance ?? Math.hypot(p.x - robotPosition.x, p.z - robotPosition.z);
      if (d < threshold) {
        warnings.push({ object: obj, distance: d, position: p, trackId: obj.trackId });
      }
    }
    this.collisionWarnings = warnings;
    if (warnings.length > 0) this.onCollision(warnings);
    return warnings;
  }

  getTrackedObjects() {
    const result = [];
    for (const [id, t] of this._trackedObjects) {
      result.push({ id, ...t });
    }
    return result;
  }

  getStatus() {
    return {
      active: this.active,
      detections: this.detectedObjects.length,
      collisions: this.collisionWarnings.length,
      frame: this.frameCount,
    };
  }
}
