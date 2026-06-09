import express from 'express';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { WebSocketServer } from 'ws';

const __dirname = path.resolve();
const ccoPort   = 3000;

const app = express();
const options = {
  key:  fs.readFileSync(__dirname + '/server-key.pem'),
  cert: fs.readFileSync(__dirname + '/server.pem')
};
const server = https.createServer(options, app);

// ===== WEBSOCKET =====
const wss = new WebSocketServer({ server });
let webSockets = [];

// ===== MULTIUSER SYSTEM =====
const muClients = {};           // clientId -> { ws, robotIndex }
const muRobotOwners = {};       // robotIndex -> clientId
const muRobotStates = {};       // robotIndex -> last known state
let muBoxState = null;          // latest box position from any client
const TOTAL_ROBOTS = 4;
let muNextId = 1;

function muBroadcast(msg, excludeId = null) {
  const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
  for (const id of Object.keys(muClients)) {
    if (id !== excludeId) {
      try { muClients[id].ws.send(data); } catch (e) { /* ignore */ }
    }
  }
}

function muReleaseRobot(clientId) {
  for (let ri = 0; ri < TOTAL_ROBOTS; ri++) {
    if (muRobotOwners[ri] === clientId) {
      muRobotOwners[ri] = null;
      return ri;
    }
  }
  return -1;
}

function muAssignFreeRobot(clientId) {
  // First try to find an unowned robot
  for (let ri = 0; ri < TOTAL_ROBOTS; ri++) {
    if (!muRobotOwners[ri]) {
      muRobotOwners[ri] = clientId;
      return ri;
    }
  }
  // All taken — release the one with oldest client (first entry)
  for (const id of Object.keys(muClients)) {
    const ri = muClients[id].robotIndex;
    if (ri !== undefined) {
      muRobotOwners[ri] = clientId;
      return ri;
    }
  }
  return 0;
}

// ===== WEBSOCKET CONNECTION =====
wss.on('connection', function(ws, req) {
  let id = req.url.replace("/", "");
  log("connection >> " + id);
  ws.terminalId = id;
  webSockets[id] = ws;

  // ── Multiuser: assign client ──
  const clientId = 'mu_' + (muNextId++);
  const robotIdx = muAssignFreeRobot(clientId);
  muClients[clientId] = { ws, robotIndex: robotIdx };
  log(`[MU] ${clientId} assigned robot ${robotIdx}`);

  // Send assignment to the new client
  ws.send(JSON.stringify({
    type: 'mu_assigned',
    clientId,
    robotIndex: robotIdx,
    totalRobots: TOTAL_ROBOTS
  }));

  // Send current states of all other robots + box position
  const syncAll = {};
  for (const ri of Object.keys(muRobotStates)) {
    syncAll[ri] = muRobotStates[ri];
  }
  ws.send(JSON.stringify({ type: 'mu_sync_all', states: syncAll, box: muBoxState, owners: muRobotOwners }));

  // Broadcast new client to everyone else
  muBroadcast({ type: 'mu_join', clientId, robotIndex: robotIdx }, clientId);

  ws.on('message', async function(data) {
    let message = JSON.parse(data);
    log(ws.terminalId + " >> " + message.type);

    // ── Multiuser message handling ──
    if (message.type === 'mu_state') {
      // Store last known state for this robot
      muRobotStates[message.robotIndex] = message.state;
      // Extract + store global box position from any client
      const st = message.state;
      if (st.boxX !== undefined) {
        muBoxState = {
          x: st.boxX, y: st.boxY, z: st.boxZ,
          qx: st.boxQx, qy: st.boxQy, qz: st.boxQz, qw: st.boxQw,
          grabbed: !!st.grabbed,
          t: message.t ?? Date.now()
        };
      }
      // Relay to all other clients
      muBroadcast(message, clientId);
      return;
    }

    if (message.type === 'mu_release') {
      const ri = muReleaseRobot(clientId);
      if (ri >= 0) {
        log(`[MU] ${clientId} released robot ${ri}`);
        muBroadcast({ type: 'mu_release', clientId, robotIndex: ri }, null);
      }
      return;
    }

    if (message.type === 'mu_claim') {
      const targetRi = message.robotIndex;
      if (targetRi !== undefined && !muRobotOwners[targetRi]) {
        // Release current robot and broadcast its release
        const oldRi = muReleaseRobot(clientId);
        if (oldRi >= 0) {
          muBroadcast({ type: 'mu_release', clientId, robotIndex: oldRi }, null);
        }
        // Claim new robot
        muRobotOwners[targetRi] = clientId;
        muClients[clientId].robotIndex = targetRi;
        log(`[MU] ${clientId} claimed robot ${targetRi} (released ${oldRi})`);
        ws.send(JSON.stringify({ type: 'mu_assigned', clientId, robotIndex: targetRi, totalRobots: TOTAL_ROBOTS }));
        muBroadcast({ type: 'mu_join', clientId, robotIndex: targetRi }, null);
      }
      return;
    }

    // ── Legacy relay system ──
    if (webSockets[message.dst] != undefined) {
      webSockets[message.dst].send(JSON.stringify(message));
    }
  });

  ws.on("close", () => {
    log("close >> " + ws.terminalId);

    // ── Multiuser: release robot ──
    const ri = muReleaseRobot(clientId);
    if (ri >= 0) {
      log(`[MU] ${clientId} disconnected, robot ${ri} freed`);
      muBroadcast({ type: 'mu_leave', clientId, robotIndex: ri }, null);
    }
    delete muClients[clientId];

    webSockets[ws.terminalId] = undefined;
  });
});

// ===== STATIC FILES =====
app.use("/public", express.static(path.join(__dirname, "public"))); // ← style.css
app.use("/src",    express.static(path.join(__dirname, "src")));    // ← main.js + modules

// ===== ROUTES =====
app.use(express.urlencoded({ extended: true }));
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

// ===== START =====
server.listen(ccoPort, () => log('server listening on ' + ccoPort));

function log(msg) { console.log(msg); }