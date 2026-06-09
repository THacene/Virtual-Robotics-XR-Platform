const WS_URL = `wss://${location.hostname}:3000/mu`;

export class MultiuserSync {
  constructor(robots, physicsCtrl, options = {}) {
    this.robots = robots;
    this.physicsCtrl = physicsCtrl;
    this.ws = null;
    this.clientId = null;
    this.robotIndex = 0;
    this.connected = false;
    this.remoteStates = new Map();
    this.remoteTimestamps = new Map();
    this.remoteHeld = null;
    this.lastSend = 0;
    this.sendInterval = 50;
    this.onReady = null;
    this._lastSentStr = '';
    this._lastState = null;
    this.reconnectTimer = null;
    this._clockOffset = 0;
    this._clockOffset = 0;
    this._boxState = null;
    this._boxTs = 0;
    this.owners = new Map();
  }

  connect() {
    if (this.ws) return;
    this.ws = new WebSocket(WS_URL);
    this.ws.onopen = () => {
      this.connected = true;
    };
    this.ws.onmessage = (e) => this._onMessage(JSON.parse(e.data));
    this.ws.onclose = () => {
      this.connected = false;
      this.ws = null;
      this.reconnectTimer = setTimeout(() => this.connect(), 2000);
    };
    this.ws.onerror = () => {};
  }

  disconnect() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
    this.connected = false;
  }

  _onMessage(msg) {
    switch (msg.type) {
      case 'mu_assigned':
        this.clientId = msg.clientId;
        // Clear old robot from owners before switching
        if (this.robotIndex !== undefined && this.robotIndex !== msg.robotIndex) {
          this.owners.delete(this.robotIndex);
        }
        this.robotIndex = msg.robotIndex;
        this.owners.set(msg.robotIndex, msg.clientId);
        this.onReady?.(msg.robotIndex);
        break;

      case 'mu_sync_all': {
        const states = msg.states || {};
        for (const ri of Object.keys(states)) {
          const idx = parseInt(ri);
          const state = states[ri];
          const ts = state._t ?? 0;
          const prevTs = this.remoteTimestamps.get(idx) ?? -1;
          if (ts >= prevTs) {
            this.remoteTimestamps.set(idx, ts);
            this.remoteStates.set(idx, state);
          }
        }
        if (msg.owners) {
          this.owners.clear();
          for (const [ri, cid] of Object.entries(msg.owners)) {
            if (cid) this.owners.set(parseInt(ri), cid);
          }
        }
        // Apply server-stored state to local robot on reconnect
        if (this.robotIndex !== undefined && this.robotIndex !== null) {
          const localState = this.remoteStates.get(this.robotIndex);
          if (localState) {
            const robot = this.robots[this.robotIndex];
            if (robot) {
              if (localState.px !== undefined) robot.baseState.x = localState.px;
              if (localState.pz !== undefined) robot.baseState.z = localState.pz;
              if (localState.yaw !== undefined) robot.baseState.yaw = localState.yaw;
              robot.parts.base.group.position.set(robot.baseState.x, 0, robot.baseState.z);
              if (robot.parts.base.body)
                robot.parts.base.body.position.set(robot.baseState.x, robot.COG_Y ?? 0.5, robot.baseState.z);
              ['base','shoulder','elbow','wrist'].forEach(j => {
                if (localState[j] !== undefined) {
                  robot.jTarget[j] = localState[j];
                  robot.jCurrent[j] = localState[j];
                  robot.jVel[j] = 0;
                  robot.jAcc[j] = 0;
                }
              });
              if (localState.fopen !== undefined) robot.FOPEN = localState.fopen;
              if (localState.squeeze !== undefined) robot.sqTarget = localState.squeeze;
            }
          }
        }
        if (msg.box) {
          const bt = msg.box.t ?? 0;
          if (bt >= this._boxTs) {
            this._boxTs = bt;
            this._boxState = msg.box;
            this._applyBoxState();
          }
        }
        break;
      }

      case 'mu_state': {
        if (msg.robotIndex === this.robotIndex) return;
        const ts = msg.t ?? 0;
        const prevTs = this.remoteTimestamps.get(msg.robotIndex) ?? -1;
        if (ts < prevTs) return;
        this.remoteTimestamps.set(msg.robotIndex, ts);
        this.remoteStates.set(msg.robotIndex, msg.state);
        const st = msg.state;
        if (st.boxX !== undefined && ts >= this._boxTs) {
          this._boxTs = ts;
          this._boxState = {
            x: st.boxX, y: st.boxY, z: st.boxZ,
            qx: st.boxQx, qy: st.boxQy, qz: st.boxQz, qw: st.boxQw,
            grabbed: !!st.grabbed,
          };
        }
        break;
      }

      case 'mu_join': {
        this.owners.set(msg.robotIndex, msg.clientId);
        break;
      }

      case 'mu_leave':
      case 'mu_release': {
        this.remoteStates.delete(msg.robotIndex);
        this.remoteTimestamps.delete(msg.robotIndex);
        this.owners.delete(msg.robotIndex);
        if (this.remoteHeld?.robotIndex === msg.robotIndex) {
          this.remoteHeld = null;
        }
        break;
      }

      case 'mu_claim': {
        this.owners.set(msg.robotIndex, msg.clientId);
        break;
      }
    }
  }

  claimNextRobot() {
    if (!this.connected || !this.clientId) return;
    
    // Find the next available robot
    const numRobots = this.robots.length;
    let nextIdx = (this.robotIndex + 1) % numRobots;
    
    while (nextIdx !== this.robotIndex) {
      if (!this.owners.has(nextIdx)) {
        // We found a free robot! Claim it.
        this.ws.send(JSON.stringify({
          type: 'mu_claim',
          clientId: this.clientId,
          robotIndex: nextIdx
        }));
        return;
      }
      nextIdx = (nextIdx + 1) % numRobots;
    }
    console.log("No free robots available to switch to.");
  }

  /** Claim a specific robot by index */
  claimRobot(idx) {
    if (!this.connected || !this.clientId) return false;
    if (idx < 0 || idx >= this.robots.length) return false;
    if (idx === this.robotIndex) return false; // already yours
    if (this.owners.has(idx) && this.owners.get(idx) !== this.clientId) return false; // owned by someone else
    this.ws.send(JSON.stringify({
      type: 'mu_claim',
      clientId: this.clientId,
      robotIndex: idx
    }));
    return true;
  }

  /** Return status info for each robot: {index, isFree, isYours, ownerClientId} */
  getRobotStatuses() {
    const result = [];
    for (let i = 0; i < this.robots.length; i++) {
      const owner = this.owners.get(i) ?? null;
      result.push({
        index: i,
        isFree: !owner,
        isYours: i === this.robotIndex,
        ownerClientId: owner,
      });
    }
    return result;
  }

  getState(robot) {
    return {
      base: robot.jCurrent.base,
      shoulder: robot.jCurrent.shoulder,
      elbow: robot.jCurrent.elbow,
      wrist: robot.jCurrent.wrist,
      px: robot.baseState.x,
      pz: robot.baseState.z,
      yaw: robot.baseState.yaw,
      fopen: robot.FOPEN,
      squeeze: robot.sqTarget,
      _t: performance.now(),
    };
  }

  _hasStateChanged(newState) {
    if (!this._lastState) return true;
    const s = this._lastState;
    return Math.abs(newState.base - s.base) > 1.0 ||
      Math.abs(newState.shoulder - s.shoulder) > 1.0 ||
      Math.abs(newState.elbow - s.elbow) > 1.0 ||
      Math.abs(newState.wrist - s.wrist) > 1.0 ||
      Math.abs(newState.px - s.px) > 0.02 ||
      Math.abs(newState.pz - s.pz) > 0.02 ||
      Math.abs(newState.yaw - s.yaw) > 0.03 ||
      Math.abs(newState.fopen - s.fopen) > 0.01 ||
      Math.abs(newState.squeeze - s.squeeze) > 0.05 ||
      newState.grabbed !== s.grabbed;
  }

  sendUpdate(now, grabbed, physicsCtrl) {
    if (!this.connected || !this.clientId) return false;

    const robot = this.robots[this.robotIndex];
    if (!robot) return false;

    const state = this.getState(robot);

    const b = physicsCtrl?.body;
    state.grabbed = grabbed;
    if (b) {
      state.boxX = b.position.x;
      state.boxY = b.position.y;
      state.boxZ = b.position.z;
      state.boxQx = b.quaternion.x;
      state.boxQy = b.quaternion.y;
      state.boxQz = b.quaternion.z;
      state.boxQw = b.quaternion.w;
    }

    if (!this._hasStateChanged(state)) return false;
    const prev = this._lastState;
    this._lastState = state;

    const moving = grabbed || !prev || state.grabbed !== prev.grabbed;
    const interval = moving ? 30 : 80;
    if (now - this.lastSend < interval) return false;

    this.ws.send(JSON.stringify({
      type: 'mu_state',
      t: now,
      clientId: this.clientId,
      robotIndex: this.robotIndex,
      state
    }));

    this.lastSend = now;
    return true;
  }

  applyRemoteStates() {
    for (const [idx, state] of this.remoteStates) {
      const robot = this.robots[idx];
      if (!robot) continue;

      const setJoint = (name, val) => {
        if (val === undefined) return;
        robot.jTarget[name] = val;
        robot.jCurrent[name] = val;
        robot.jVel[name] = 0;
        robot.jAcc[name] = 0;
      };
      setJoint('base', state.base);
      setJoint('shoulder', state.shoulder);
      setJoint('elbow', state.elbow);
      setJoint('wrist', state.wrist);

      if (state.px !== undefined) robot.baseState.x = state.px;
      if (state.pz !== undefined) robot.baseState.z = state.pz;
      if (state.yaw !== undefined) robot.baseState.yaw = state.yaw;
      robot.driveTargetSpeed = 0;
      robot.driveTargetTurn = 0;

      if (state.fopen !== undefined) robot.FOPEN = state.fopen;
      if (state.squeeze !== undefined) robot.sqTarget = state.squeeze;

      if (state.grabbed && state.boxX !== undefined) {
        this.remoteHeld = { robotIndex: idx, state };
      } else if (!state.grabbed && this.remoteHeld?.robotIndex === idx) {
        this.remoteHeld = null;
      }
    }
  }

  _applyBoxState() {
    if (!this._boxState || !this.physicsCtrl?.body) return;
    const s = this._boxState;
    const b = this.physicsCtrl.body;
    b.position.set(s.x, s.y, s.z);
    b.quaternion.set(s.qx, s.qy, s.qz, s.qw);
    b.velocity.set(0, 0, 0);
    b.angularVelocity.set(0, 0, 0);
    b.aabbNeedsUpdate = true;
  }

  applyRemoteBox() {
    if (!this.remoteHeld || !this.physicsCtrl?.body) return;
    const s = this.remoteHeld.state;
    const b = this.physicsCtrl.body;
    const lerp = 0.6; // Increased from 0.4 for snappier sync
    b.position.x += (s.boxX - b.position.x) * lerp;
    b.position.y += (s.boxY - b.position.y) * lerp;
    b.position.z += (s.boxZ - b.position.z) * lerp;
    
    // Proper quaternion slerp for smooth rotation
    const currentQ = new CANNON.Quaternion(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
    const targetQ = new CANNON.Quaternion(s.boxQx, s.boxQy, s.boxQz, s.boxQw);
    currentQ.slerp(targetQ, lerp, currentQ);
    b.quaternion.copy(currentQ);
    b.velocity.set(0, 0, 0);
    b.angularVelocity.set(0, 0, 0);
    b.aabbNeedsUpdate = true;
  }

  isRemoteGrabbed() {
    return this.remoteHeld !== null;
  }
}
