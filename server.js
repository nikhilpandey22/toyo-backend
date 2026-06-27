/* =============================================================================
   TOYO SPRINGS LTD — FURNACE MES BACKEND
   PostgreSQL Version - Render Deployment
   ========================================================================== */
const pool = require('./db.js');
const express = require("express");
const http = require("http");
const net = require("net");
const crypto = require("crypto");
const path = require("path");
const { WebSocketServer } = require("ws");

// require("dotenv").config();

const APP_DIR = __dirname;

// ---------------------------------------------------------------- UTILS --
function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

// ---------------------------------------------------------------- DB INIT --
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password VARCHAR(100) NOT NULL,
        role VARCHAR(20) NOT NULL,
        full_name VARCHAR(100)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id INT PRIMARY KEY DEFAULT 1,
        furnace_count INT DEFAULT 6,
        plc_ip VARCHAR(50) DEFAULT '192.168.3.39',
        plc_port INT DEFAULT 5007,
        simulation_mode BOOLEAN DEFAULT true,
        warn_temp INT DEFAULT 850,
        crit_temp INT DEFAULT 950
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS production_log (
        id SERIAL PRIMARY KEY,
        date DATE NOT NULL,
        time VARCHAR(20) NOT NULL,
        temps JSONB,
        operator VARCHAR(100),
        machine VARCHAR(50),
        part VARCHAR(100),
        shift VARCHAR(20),
        target INT,
        qty INT,
        remarks TEXT,
        status VARCHAR(20)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS alarm_log (
        id SERIAL PRIMARY KEY,
        ts VARCHAR(50) NOT NULL,
        furnace VARCHAR(50) NOT NULL,
        level VARCHAR(20) NOT NULL,
        message TEXT NOT NULL,
        active BOOLEAN DEFAULT true
      );
    `);

    // Insert default admin/operator if not exists
    await pool.query(`
      INSERT INTO users (username, password, role, full_name)
      VALUES
        ('admin', $1, 'Admin', 'Administrator'),
        ('operator', $2, 'Operator', 'Line Operator')
      ON CONFLICT (username) DO NOTHING
    `, [sha256("toyo@123"), sha256("oper@123")]);

    // Insert default settings if not exists
    await pool.query(`
      INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING
    `);

    console.log("PostgreSQL tables ready ✅");
  } catch (err) {
    console.error("DB Init Error:", err);
  }
}

async function getSettings() {
  const result = await pool.query("SELECT * FROM settings WHERE id = 1");
  return result.rows[0];
}

async function saveSettings(settings) {
  await pool.query(`
    UPDATE settings SET
      furnace_count = $1,
      plc_ip = $2,
      plc_port = $3,
      simulation_mode = $4,
      warn_temp = $5,
      crit_temp = $6
    WHERE id = 1
  `, [
    settings.furnace_count,
    settings.plc_ip,
    settings.plc_port,
    settings.simulation_mode,
    settings.warn_temp,
    settings.crit_temp
  ]);
}

// ============================================================================
// MITSUBISHI MC PROTOCOL (3E binary frame, read D-registers)
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
      const devNum = parseInt(headDevice.replace(/[^0-9]/g, ""), 10);
      const frame = Buffer.alloc(21);
      let o = 0;
      frame.writeUInt16LE(0x50, o); o += 2;
      frame.writeUInt8(0x00, o); o += 1;
      frame.writeUInt8(0xff, o); o += 1;
      frame.writeUInt16LE(0x03ff, o); o += 2;
      frame.writeUInt8(0x00, o); o += 1;
      frame.writeUInt16LE(0x0c, o); o += 2;
      frame.writeUInt16LE(0x0010, o); o += 2;
      frame.writeUInt16LE(0x0401, o); o += 2;
      frame.writeUInt16LE(0x0000, o); o += 2;
      frame.writeUIntLE(devNum, o, 3); o += 3;
      frame.write("D\0", o, "ascii"); o += 2;
      frame.writeUInt16LE(count, o); o += 2;

      socket.write(frame);
    });

    let received = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= 11) {
        const dataLen = received.readUInt16LE(7);
        if (received.length >= 9 + dataLen) {
          finished = true;
          socket.destroy();
          const endCode = received.readUInt16LE(9);
          if (endCode!== 0) {
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
// LIVE DATA LOOP
// ============================================================================
let simBase = {};
function simTick(n) {
  const out = {};
  for (let i = 1; i <= n; i++) {
    const prev = simBase[i]?? (820 + Math.random() * 85);
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
  const s = await getSettings();
  const n = s.furnace_count;

  if (s.simulation_mode) {
    lastTemps = simTick(n);
    if (!plcOnline) {
      plcOnline = true;
      broadcast("plc_status", { connected: true, message: "SIMULATION MODE" });
    }
    broadcast("temps", lastTemps);
  } else {
    try {
      const words = await mcRead3E({ host: s.plc_ip, port: s.plc_port, headDevice: "D100", count: n });
      const temps = {};
      words.forEach((w, idx) => { temps[idx + 1] = Math.round((w / 10) * 10) / 10; });
      lastTemps = temps;
      if (!plcOnline) {
        plcOnline = true;
        broadcast("plc_status", { connected: true, message: `PLC ONLINE ${s.plc_ip}:${s.plc_port}` });
      }
      broadcast("temps", lastTemps);
    } catch (e) {
      if (plcOnline) {
        plcOnline = false;
        broadcast("plc_status", { connected: false, message: "PLC OFFLINE — " + e.message });
      }
    }
  }

  // alarm detection
  for (const [i, val] of Object.entries(lastTemps)) {
    let level = null;
    if (val >= s.crit_temp) level = "CRITICAL";
    else if (val >= s.warn_temp) level = "WARNING";
    if (level) {
      const exists = await pool.query(
        "SELECT * FROM alarm_log WHERE furnace = $1 AND active = true LIMIT 1",
        [`Furnace-${i}`]
      );
      if (exists.rows.length === 0) {
        const newAlarm = await pool.query(`
          INSERT INTO alarm_log (ts, furnace, level, message, active)
          VALUES ($1, $2, $3, $4, true)
          RETURNING *
        `, [
          new Date().toLocaleString(),
          `Furnace-${i}`,
          level,
          `Furnace #${i} temperature ${level === "CRITICAL"? "CRITICAL" : "high"}: ${val.toFixed(1)}°C`
        ]);
        broadcast("alarm", newAlarm.rows[0]);
      }
    } else {
      await pool.query("UPDATE alarm_log SET active = false WHERE furnace = $1", [`Furnace-${i}`]);
    }
  }

  setTimeout(liveLoop, 1000);
}

// ============================================================================
// EXPRESS APP + REST API
// ============================================================================
const app = express();
app.use(express.json());
app.use(express.static(path.join(APP_DIR, "public")));

app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
    const user = result.rows[0];
    if (!user || user.password!== sha256(password || "")) {
      return res.status(401).json({ error: "Invalid username or password" });
    }
    res.json({ username: user.username, role: user.role, full_name: user.full_name });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/settings", async (req, res) => {
  const settings = await getSettings();
  res.json(settings);
});
app.get('/api/data', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM production_log ORDER BY id DESC LIMIT 100');
    res.json({ data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});
app.post("/api/settings", async (req, res) => {
  try {
    const newSettings = {...await getSettings(),...req.body };
    newSettings.furnace_count = Math.max(4, Math.min(6, Number(newSettings.furnace_count) || 6));
    await saveSettings(newSettings);
    simBase = {};
    res.json(newSettings);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/production", async (req, res) => {
  try {
    let query = "SELECT * FROM production_log WHERE 1=1";
    const params = [];
    const { from, to, status, operator } = req.query;

    if (from) {
      params.push(from);
      query += ` AND date >= $${params.length}`;
    }
    if (to) {
      params.push(to);
      query += ` AND date <= $${params.length}`;
    }
    if (status) {
      params.push(status);
      query += ` AND status = $${params.length}`;
    }
    if (operator) {
      params.push(operator);
      query += ` AND operator = $${params.length}`;
    }

    query += " ORDER BY id DESC";
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/production", async (req, res) => {
  try {
    const rec = req.body;
    const result = await pool.query(`
      INSERT INTO production_log (date, time, temps, operator, machine, part, shift, target, qty, remarks, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `, [
      new Date().toISOString().slice(0, 10),
      new Date().toLocaleTimeString(),
      JSON.stringify(Object.values(lastTemps)),
      rec.operator,
      rec.machine,
      rec.part,
      rec.shift,
      rec.target,
      rec.qty,
      rec.remarks,
      rec.status
    ]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/alarms", async (req, res) => {
  const result = await pool.query("SELECT * FROM alarm_log ORDER BY id DESC LIMIT 100");
  res.json(result.rows);
});

app.post("/api/alarms/ack", async (req, res) => {
  await pool.query("UPDATE alarm_log SET active = false");
  res.json({ ok: true });
});

app.get("/api/operators", async (req, res) => {
  const result = await pool.query("SELECT DISTINCT operator FROM production_log WHERE operator IS NOT NULL");
  res.json(result.rows.map(r => r.operator));
});

// ============================================================================
// HTTP + WEBSOCKET SERVER
// ============================================================================
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  wsClients.add(ws);
  ws.send(JSON.stringify({ type: "plc_status", payload: { connected: plcOnline, message: plcOnline? "CONNECTED" : "CONNECTING…" } }));
  ws.on("close", () => wsClients.delete(ws));
});
// ===== CHECK SABHI TABLES =====
app.get('/api/tables', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
    res.json({ tables: result.rows });
  } catch (err) {
    res.json({ error: err.message });
  }
});
// ==============================
const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
  await initDB();
  const settings = await getSettings();
  console.log(`\n==============================================`);
  console.log(` TOYO SPRINGS LTD — Furnace MES running`);
  console.log(` Open: http://localhost:${PORT}`);
 
  console.log(`==============================================\n`);
  liveLoop();
});