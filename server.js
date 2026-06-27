/* =============================================================================
   TOYO SPRINGS LTD — FURNACE MES BACKEND
   Plain Node.js (Express + ws). No native build tools needed.
   - Serves the HTML/CSS/JS frontend from /public
   - Stores users / settings / production log / alarms in a simple JSON file (db.json)
   - Talks to a Mitsubishi PLC using the MC Protocol (3E binary frame) over TCP,
     OR runs SIMULATION MODE automatically if no PLC is reachable.
   - Pushes live furnace temperatures to the browser every second via WebSocket.
   ========================================================================== */

const express = require("express");
const http = require("http");
const net = require("net");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const APP_DIR = __dirname;
const DB_FILE = path.join(APP_DIR, "db.json");

// ---------------------------------------------------------------- JSON "DB" --
function defaultDB() {
  return {
    users: [
      { username: "admin", password: sha256("toyo@123"), role: "Admin", full_name: "Administrator" },
      { username: "operator", password: sha256("oper@123"), role: "Operator", full_name: "Line Operator" },
    ],
    settings: {
      furnace_count: 6,
      plc_ip: "192.168.3.39",
      plc_port: 5007,
      simulation_mode: true,   // set to false once a real PLC is reachable
      warn_temp: 850,
      crit_temp: 950,
    },
    production_log: [],   // {id,date,time,temps:[..],operator,machine,part,shift,target,qty,remarks,status}
    alarm_log: [],        // {id,ts,furnace,level,message}
  };
}

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultDB(), null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

let db = loadDB();

// ============================================================================
//  MITSUBISHI MC PROTOCOL  (3E binary frame, read D-registers)
//  Minimal client implemented directly over TCP — no extra npm dependency.
//  Works with Mitsubishi Q / L / iQ-R series Ethernet ports configured for
//  "MC Protocol (Binary)" with the 3E frame.
// ============================================================================
function mcRead3E({ host, port, headDevice = "D100", count = 6, timeout = 1500 }) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let finished = false;

    const fail = (err) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      reject(err);
    };

    socket.setTimeout(timeout, () => fail(new Error("PLC timeout")));
    socket.on("error", (e) => fail(e));

    socket.connect(port, host, () => {
      // Build 3E binary frame: read "count" words from device "D" starting at headDevice number
      const devNum = parseInt(headDevice.replace(/[^0-9]/g, ""), 10);
      const frame = Buffer.alloc(21);
      let o = 0;
      frame.writeUInt16LE(0x50, o); o += 2;      // Subheader 0x5000
      frame.writeUInt8(0x00, o); o += 1;         // Network No
      frame.writeUInt8(0xff, o); o += 1;         // PC No
      frame.writeUInt16LE(0x03ff, o); o += 2;    // Request dest module I/O
      frame.writeUInt8(0x00, o); o += 1;         // Request dest module station No
      frame.writeUInt16LE(0x0c, o); o += 2;      // Request data length (fixed for read command)
      frame.writeUInt16LE(0x0010, o); o += 2;    // CPU monitoring timer
      frame.writeUInt16LE(0x0401, o); o += 2;    // Command: batch read (0401)
      frame.writeUInt16LE(0x0000, o); o += 2;    // Subcommand: word units (0000)
      frame.writeUIntLE(devNum, o, 3); o += 3;   // Head device number (3 bytes)
      frame.write("D\0", o, "ascii"); o += 2;    // Device code "D*" (ASCII, 2 bytes) for D register
      frame.writeUInt16LE(count, o); o += 2;     // Number of device points to read

      socket.write(frame);
    });

    let received = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      // Response header is 11 bytes, then 2 bytes per word
      if (received.length >= 11) {
        const dataLen = received.readUInt16LE(7);
        if (received.length >= 9 + dataLen) {
          finished = true;
          socket.destroy();
          const endCode = received.readUInt16LE(9);
          if (endCode !== 0) {
            reject(new Error(`PLC returned error code 0x${endCode.toString(16)}`));
            return;
          }
          const words = [];
          for (let i = 0; i < count; i++) {
            words.push(received.readInt16LE(11 + i * 2));
          }
          resolve(words);
        }
      }
    });
  });
}

// ============================================================================
//  LIVE DATA LOOP  (PLC read or simulation) — broadcast to all WS clients
// ============================================================================
let simBase = {};
function simTick(n) {
  const out = {};
  for (let i = 1; i <= n; i++) {
    const prev = simBase[i] ?? (820 + Math.random() * 85);
    let next = prev + (Math.random() * 7 - 3.5);
    next = Math.max(750, Math.min(970, next));
    simBase[i] = next;
    out[i] = Math.round(next * 10) / 10;
  }
  return out;
}

let plcOnline = false;
let lastTemps = {};
let wsClients = new Set();

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const ws of wsClients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

async function liveLoop() {
  const s = db.settings;
  const n = s.furnace_count;

  if (s.simulation_mode) {
    lastTemps = simTick(n);
    if (!plcOnline) { plcOnline = true; broadcast("plc_status", { connected: true, message: "SIMULATION MODE" }); }
    broadcast("temps", lastTemps);
  } else {
    try {
      const words = await mcRead3E({ host: s.plc_ip, port: s.plc_port, headDevice: "D100", count: n });
      const temps = {};
      words.forEach((w, idx) => { temps[idx + 1] = Math.round((w / 10) * 10) / 10; });
      lastTemps = temps;
      if (!plcOnline) { plcOnline = true; broadcast("plc_status", { connected: true, message: `PLC ONLINE ${s.plc_ip}:${s.plc_port}` }); }
      broadcast("temps", lastTemps);
    } catch (e) {
      if (plcOnline) { plcOnline = false; broadcast("plc_status", { connected: false, message: "PLC OFFLINE — " + e.message }); }
    }
  }

  // alarm detection
  const alarms = {};
  for (const [i, val] of Object.entries(lastTemps)) {
    let level = null;
    if (val >= s.crit_temp) level = "CRITICAL";
    else if (val >= s.warn_temp) level = "WARNING";
    if (level) {
      alarms[i] = level;
      const exists = db.alarm_log.find(a => a.furnace === `Furnace-${i}` && a.active);
      if (!exists) {
        db.alarm_log.unshift({
          id: Date.now() + Math.random(),
          ts: new Date().toLocaleString(),
          furnace: `Furnace-${i}`,
          level,
          message: `Furnace #${i} temperature ${level === "CRITICAL" ? "CRITICAL" : "high"}: ${val.toFixed(1)}°C`,
          active: true,
        });
        if (db.alarm_log.length > 300) db.alarm_log.length = 300;
        saveDB(db);
        broadcast("alarm", db.alarm_log[0]);
      }
    } else {
      db.alarm_log.forEach(a => { if (a.furnace === `Furnace-${i}`) a.active = false; });
    }
  }

  setTimeout(liveLoop, 1000);
}

// ============================================================================
//  EXPRESS APP + REST API
// ============================================================================
const app = express();
app.use(express.json());
app.use(express.static(path.join(APP_DIR, "public")));

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  const user = db.users.find(u => u.username === username && u.password === sha256(password || ""));
  if (!user) return res.status(401).json({ error: "Invalid username or password" });
  res.json({ username: user.username, role: user.role, full_name: user.full_name });
});

app.get("/api/settings", (req, res) => res.json(db.settings));

app.post("/api/settings", (req, res) => {
  Object.assign(db.settings, req.body);
  db.settings.furnace_count = Math.max(4, Math.min(6, Number(db.settings.furnace_count) || 6));
  simBase = {}; // reset sim base on settings change
  saveDB(db);
  res.json(db.settings);
});

app.get("/api/production", (req, res) => {
  let rows = [...db.production_log];
  const { from, to, status, operator } = req.query;
  if (from) rows = rows.filter(r => r.date >= from);
  if (to) rows = rows.filter(r => r.date <= to);
  if (status) rows = rows.filter(r => r.status === status);
  if (operator) rows = rows.filter(r => r.operator === operator);
  res.json(rows.slice().reverse());
});

app.post("/api/production", (req, res) => {
  const rec = req.body;
  rec.id = db.production_log.length + 1;
  rec.date = new Date().toISOString().slice(0, 10);
  rec.time = new Date().toLocaleTimeString();
  rec.temps = Object.values(lastTemps);
  db.production_log.push(rec);
  saveDB(db);
  res.json(rec);
});

app.get("/api/alarms", (req, res) => res.json(db.alarm_log.slice(0, 100)));

app.post("/api/alarms/ack", (req, res) => {
  db.alarm_log.forEach(a => (a.active = false));
  saveDB(db);
  res.json({ ok: true });
});

app.get("/api/operators", (req, res) => {
  const ops = [...new Set(db.production_log.map(r => r.operator).filter(Boolean))];
  res.json(ops);
});

// ============================================================================
//  HTTP + WEBSOCKET SERVER
// ============================================================================
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  wsClients.add(ws);
  ws.send(JSON.stringify({ type: "plc_status", payload: { connected: plcOnline, message: plcOnline ? "CONNECTED" : "CONNECTING…" } }));
  ws.on("close", () => wsClients.delete(ws));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n==============================================`);
  console.log(` TOYO SPRINGS LTD — Furnace MES running`);
  console.log(` Open: http://localhost:${PORT}`);
  console.log(` Mode: ${db.settings.simulation_mode ? "SIMULATION" : "LIVE PLC " + db.settings.plc_ip + ":" + db.settings.plc_port}`);
  console.log(`==============================================\n`);
  liveLoop();
});