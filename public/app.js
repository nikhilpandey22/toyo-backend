/* ════════════════════════════════════════════════════════════════
   TOYO SPRINGS LTD — FURNACE MES
   Application logic (front-end only — wire PLC_ENDPOINT to your
   Node/Express + PLC bridge when simulation mode is switched off)
   ════════════════════════════════════════════════════════════════ */
(() => {
  "use strict";

  /* ---------------------------------------------------------------
   * 0. DEMO AUTH  (replace with real /api/login call to your backend)
   * ------------------------------------------------------------- */
  const DEMO_USERS = { "admin": "admin123", "operator": "operator123" };

  /* ---------------------------------------------------------------
   * 1. CONFIG  (persisted to localStorage so settings survive reload)
   * ------------------------------------------------------------- */
  const FURNACE_COLORS = ["#22D9C0", "#5BA1FF", "#B07BFF", "#FF6FA8", "#FFA94D", "#C6E84D"];
  const DOWNTIME_REASONS = ["Scheduled Maintenance", "Sensor Fault", "Material Jam", "Power Trip", "Manual Stop / Changeover"];

  const DEFAULT_CONFIG = {
    furnaceCount: 6,
    simMode: true,
    plcIp: "192.168.1.50",
    plcPort: "502",
    furnaces: Array.from({ length: 6 }, (_, i) => ({
      id: `F${i + 1}`,
      name: `Furnace ${i + 1}`,
      color: FURNACE_COLORS[i],
      min: 600,
      max: 950,
      warn: 850,
      crit: 900
    }))
  };

  function loadConfig() {
    try {
      const raw = localStorage.getItem("mes_config");
      if (raw) return Object.assign({}, DEFAULT_CONFIG, JSON.parse(raw));
    } catch (e) { /* ignore corrupt storage */ }
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
  function saveConfig(cfg) {
    localStorage.setItem("mes_config", JSON.stringify(cfg));
  }

  let CONFIG = loadConfig();

  /* ---------------------------------------------------------------
   * 2. STATE
   * ------------------------------------------------------------- */
  const state = {
    user: null,
    furnaces: {},          // id -> { temp, status, running, lastChange }
    alarms: [],            // active + acked feed
    alarmSeq: 1,
    production: [],        // log rows
    prodSeq: 1,
    downtime: [],          // { machine, start, end, duration, reason }
    shiftStartCount: 0,
    shiftStartTime: null,
    muted: false,
    chart: null,
    chartWindow: 40,
    selectedAlarm: null,
    plcConnected: false
  };

  /* ---------------------------------------------------------------
   * 3. SHIFT HELPERS
   * ------------------------------------------------------------- */
  function currentShift(d = new Date()) {
    const h = d.getHours();
    if (h >= 6 && h < 14) return { name: "Shift A (06:00–14:00)", start: 6 };
    if (h >= 14 && h < 22) return { name: "Shift B (14:00–22:00)", start: 14 };
    return { name: "Shift C (22:00–06:00)", start: 22 };
  }

  function initShift() {
    state.shiftStartTime = new Date();
    state.shiftStartCount = 0;
    state.downtime = [];
  }

  /* ---------------------------------------------------------------
   * 4. INIT FURNACE STATE FROM CONFIG
   * ------------------------------------------------------------- */
  function buildFurnaceState() {
    state.furnaces = {};
    CONFIG.furnaces.slice(0, CONFIG.furnaceCount).forEach(f => {
      state.furnaces[f.id] = {
        temp: Math.round(f.min + Math.random() * (f.warn - f.min) * 0.6 + (f.warn - f.min) * 0.2),
        status: "Normal",
        running: true,
        offSince: null
      };
    });
  }

  /* ---------------------------------------------------------------
   * 5. DOM REFS
   * ------------------------------------------------------------- */
  const $ = sel => document.querySelector(sel);
  const els = {
    loginScreen: $("#loginScreen"), appShell: $("#appShell"),
    loginUser: $("#loginUser"), loginPass: $("#loginPass"), loginBtn: $("#loginBtn"),
    loginError: $("#loginError"), togglePass: $("#togglePass"),
    userBadge: $("#userBadge"), logoutBtn: $("#logoutBtn"),
    plcChip: $("#plcChip"), muteBtn: $("#muteBtn"), reportBtn: $("#reportBtn"),
    settingsBtn: $("#settingsBtn"),
    clockTime: $("#clockTime"), clockDate: $("#clockDate"),
    kpiAvg: $("#kpiAvg"), kpiProdCount: $("#kpiProdCount"), kpiRunning: $("#kpiRunning"),
    kpiUptime: $("#kpiUptime"), kpiAlarms: $("#kpiAlarms"), kpiOEE: $("#kpiOEE"),
    furnaceGrid: $("#furnaceGrid"),
    alCrit: $("#alCrit"), alWarn: $("#alWarn"), alInfo: $("#alInfo"),
    alarmFeed: $("#alarmFeed"), alarmFilter: $("#alarmFilter"), ackAllBtn: $("#ackAllBtn"),
    prodTableBody: $("#prodTableBody"), tblInfo: $("#tblInfo"),
    fFromDate: $("#fFromDate"), fToDate: $("#fToDate"), fFurnace: $("#fFurnace"), fStatus: $("#fStatus"),
    searchBtn: $("#searchBtn"), clearBtn: $("#clearBtn"), exportBtn: $("#exportBtn"),
    oeeAvail: $("#oeeAvail"), oeePerf: $("#oeePerf"), oeeQual: $("#oeeQual"), oeeFinal: $("#oeeFinal"),
    downtimeList: $("#downtimeList"),
    settingsModal: $("#settingsModal"), settingsSaveBtn: $("#settingsSaveBtn"), settingsCancelBtn: $("#settingsCancelBtn"),
    setFurnaceCount: $("#setFurnaceCount"), setSimMode: $("#setSimMode"), setPlcIp: $("#setPlcIp"), setPlcPort: $("#setPlcPort"),
    furnaceLimitsTable: $("#furnaceLimitsTable"),
    alarmModal: $("#alarmModal"), amFurnace: $("#amFurnace"), amTemp: $("#amTemp"), amThreshold: $("#amThreshold"),
    amType: $("#amType"), amTime: $("#amTime"), amStatus: $("#amStatus"), amAction: $("#amAction"),
    alarmAckBtn: $("#alarmAckBtn"), alarmCloseBtn: $("#alarmCloseBtn")
  };

  /* ---------------------------------------------------------------
   * 6. LOGIN
   * ------------------------------------------------------------- */
  els.togglePass.addEventListener("click", () => {
    els.loginPass.type = els.loginPass.type === "password" ? "text" : "password";
  });

  async function doLogin() {
  const u = els.loginUser.value.trim();
  const p = els.loginPass.value;
  
  if (!u ||!p) { 
    els.loginError.textContent = "Enter username and password."; 
    return; 
  }

  els.loginError.textContent = "Logging in..."; // Loading dikhane ke liye

  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: u, password: p })
    });

    if (!res.ok) {
      els.loginError.textContent = "Invalid credentials. Try admin / toyo@123";
      return;
    }

    const data = await res.json(); // Backend se user data aayega
    state.user = data.username;
    state.role = data.role;
    
    els.loginError.textContent = "";
    els.loginScreen.style.display = "none";
    els.appShell.style.display = "grid";
    els.userBadge.textContent = data.full_name || u.toUpperCase();
    bootDashboard();
    
  } catch (err) {
    els.loginError.textContent = "Server error. Try again.";
    console.error(err);
  }
}
  els.loginBtn.addEventListener("click", doLogin);
  els.loginPass.addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
  els.logoutBtn.addEventListener("click", () => {
    state.user = null;
    els.appShell.style.display = "none";
    els.loginScreen.style.display = "flex";
    els.loginUser.value = ""; els.loginPass.value = "";
  });

  /* ---------------------------------------------------------------
   * 7. CLOCK
   * ------------------------------------------------------------- */
  function tickClock() {
    const d = new Date();
    els.clockTime.textContent = d.toLocaleTimeString("en-GB");
    els.clockDate.textContent = d.toLocaleDateString("en-GB");
  }

  /* ---------------------------------------------------------------
   * 8. CHART (Chart.js) — colors mirror furnace card colors
   * ------------------------------------------------------------- */
  function buildChart() {
    const ctx = document.getElementById("trendChart").getContext("2d");
    const ids = CONFIG.furnaces.slice(0, CONFIG.furnaceCount).map(f => f.id);
    const datasets = CONFIG.furnaces.slice(0, CONFIG.furnaceCount).map(f => ({
      label: f.id,
      data: [],
      borderColor: f.color,
      backgroundColor: f.color,
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.3
    }));
    if (state.chart) state.chart.destroy();
    state.chart = new Chart(ctx, {
      type: "line",
      data: { labels: [], datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { labels: { color: "#7E8DA1", boxWidth: 12, font: { size: 10 } }, position: "top", align: "end" },
          tooltip: { mode: "index", intersect: false }
        },
        scales: {
          x: { ticks: { color: "#5A6B80", maxTicksLimit: 6, font: { size: 9 } }, grid: { color: "#1A2330" } },
          y: { ticks: { color: "#5A6B80", font: { size: 9 } }, grid: { color: "#1A2330" }, title: { display: true, text: "°C", color: "#5A6B80", font: { size: 9 } } }
        }
      }
    });
  }

  function pushChartPoint() {
    const d = new Date();
    const label = d.toLocaleTimeString("en-GB", { hour12: false });
    const c = state.chart;
    c.data.labels.push(label);
    c.data.datasets.forEach(ds => {
      ds.data.push(state.furnaces[ds.label] ? state.furnaces[ds.label].temp : null);
    });
    if (c.data.labels.length > state.chartWindow) {
      c.data.labels.shift();
      c.data.datasets.forEach(ds => ds.data.shift());
    }
    c.update();
  }

  /* ---------------------------------------------------------------
   * 9. FURNACE CARDS
   * ------------------------------------------------------------- */
  function gaugeBackground(pct, color) {
    const deg = Math.max(0, Math.min(100, pct)) * 3.6;
    return `conic-gradient(${color} ${deg}deg, #1B2330 ${deg}deg)`;
  }

  function renderFurnaceCards() {
    els.furnaceGrid.innerHTML = "";
    CONFIG.furnaces.slice(0, CONFIG.furnaceCount).forEach(f => {
      const st = state.furnaces[f.id];
      const pct = ((st.temp - f.min) / (f.max - f.min)) * 100;
      const card = document.createElement("div");
      card.className = "furnace-card";
      card.style.setProperty("--f-color", f.color);
      if (!st.running) card.classList.add("fc-off");
      else if (st.status === "Overheat") card.classList.add("fc-crit");
      else if (st.status === "Warning") card.classList.add("fc-warn");

      const dotClass = !st.running ? "dot-bad" : st.status === "Overheat" ? "dot-bad" : st.status === "Warning" ? "dot-warn" : "dot-ok";
      const statusLbl = !st.running ? "OFFLINE" : st.status.toUpperCase();

      card.innerHTML = `
        <span class="fc-name">${f.id}</span>
        <div class="fc-gauge" style="background:${gaugeBackground(pct, f.color)}">
          <div class="fc-gauge-inner">
            <span class="fc-temp">${st.running ? st.temp : "—"}</span>
            <span class="fc-unit">°C</span>
          </div>
        </div>
        <div class="fc-status-row"><span class="dot ${dotClass}"></span>${statusLbl}</div>
        <span class="fc-meta">WARN ${f.warn}° · CRIT ${f.crit}°</span>
      `;
      els.furnaceGrid.appendChild(card);
    });
  }

  /* ---------------------------------------------------------------
   * 10. ALARM ENGINE
   * ------------------------------------------------------------- */
  function recommendedAction(type, furnaceId) {
    if (type === "Critical")
      return `Immediate action required: reduce burner output on ${furnaceId}, verify thermocouple reading, and notify shift supervisor. Stop feed if temperature continues to rise.`;
    if (type === "Warning")
      return `Monitor ${furnaceId} closely. Check fuel/air ratio and cooling circuit. Escalate to Critical procedure if temperature does not stabilize within 5 minutes.`;
    return `Informational — no immediate action required. Continue routine monitoring of ${furnaceId}.`;
  }

  function raiseAlarm(furnaceId, type, temp, threshold) {
    // avoid duplicate active (un-acked) alarm of same type for same furnace
    const dup = state.alarms.find(a => a.furnaceId === furnaceId && a.type === type && !a.ack);
    if (dup) { dup.temp = temp; dup.time = new Date(); return; }
    const alarm = {
      id: state.alarmSeq++,
      furnaceId, type, temp, threshold,
      time: new Date(),
      ack: false, ackBy: null, ackTime: null,
      action: recommendedAction(type, furnaceId)
    };
    state.alarms.unshift(alarm);
    if (state.alarms.length > 200) state.alarms.length = 200;
    if (type === "Critical" && !state.muted) playAlarmSound();
  }

  function clearAlarmsFor(furnaceId, type) {
    state.alarms.filter(a => a.furnaceId === furnaceId && a.type === type && !a.ack)
      .forEach(a => { a.cleared = true; });
    state.alarms = state.alarms.filter(a => !(a.cleared && a.ack === false && a.autoCleared));
  }

  function ackAlarm(id) {
    const a = state.alarms.find(x => x.id === id);
    if (a && !a.ack) { a.ack = true; a.ackBy = state.user || "operator"; a.ackTime = new Date(); }
  }

  /* ---------------------------------------------------------------
   * 11. WEB AUDIO ALARM BEEP (no external file needed)
   * ------------------------------------------------------------- */
  let audioCtx = null;
  function playAlarmSound() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = "square"; o.frequency.value = 880;
      g.gain.value = 0.08;
      o.connect(g); g.connect(audioCtx.destination);
      o.start();
      setTimeout(() => { o.stop(); }, 220);
    } catch (e) { /* audio not available */ }
  }
  els.muteBtn.addEventListener("click", () => {
    state.muted = !state.muted;
    els.muteBtn.textContent = state.muted ? "🔇 SOUND OFF" : "🔊 SOUND ON";
  });

  /* ---------------------------------------------------------------
   * 12. SIMULATION TICK — replace with PLC polling when simMode=false
   * ------------------------------------------------------------- */
  function simTick() {
    const list = CONFIG.furnaces.slice(0, CONFIG.furnaceCount);
    let runningCount = 0;

    list.forEach(f => {
      const st = state.furnaces[f.id];

      // rare random downtime event
      if (st.running && Math.random() < 0.0025) {
        st.running = false;
        st.offSince = new Date();
        state.downtime.push({
          machine: f.id,
          start: st.offSince,
          end: null,
          duration: null,
          reason: DOWNTIME_REASONS[Math.floor(Math.random() * DOWNTIME_REASONS.length)]
        });
      } else if (!st.running && Math.random() < 0.18) {
        st.running = true;
        const dt = state.downtime.find(d => d.machine === f.id && !d.end);
        if (dt) {
          dt.end = new Date();
          dt.duration = Math.round((dt.end - dt.start) / 1000);
        }
      }

      if (st.running) {
        const drift = (Math.random() - 0.48) * 9;
        st.temp = Math.max(f.min - 20, Math.min(f.max + 40, Math.round(st.temp + drift)));

        if (st.temp >= f.crit) { st.status = "Overheat"; raiseAlarm(f.id, "Critical", st.temp, f.crit); }
        else if (st.temp >= f.warn) { st.status = "Warning"; raiseAlarm(f.id, "Warning", st.temp, f.warn); }
        else { st.status = "Normal"; }
        runningCount++;
      }
    });

    // production log row every tick
    const now = new Date();
    const temps = list.map(f => state.furnaces[f.id].running ? state.furnaces[f.id].temp : "-");
    const worst = list.some(f => state.furnaces[f.id].status === "Overheat") ? "Overheat"
      : list.some(f => state.furnaces[f.id].status === "Warning") ? "Warning" : "Normal";
    const qty = runningCount > 0 ? Math.floor(Math.random() * 3) : 0;
    state.production.unshift({
      sno: state.prodSeq++,
      date: now.toLocaleDateString("en-GB"),
      time: now.toLocaleTimeString("en-GB"),
      temps, qty, status: worst, _ts: now
    });
    if (state.production.length > 500) state.production.length = 500;
    state.shiftStartCount += qty;

    renderFurnaceCards();
    pushChartPoint();
    renderAlarms();
    renderTable();
    updateKPIs(runningCount, list.length);
    updateOEE(list.length);
    renderDowntime();
  }

  /* ---------------------------------------------------------------
   * 13. ALARM FEED RENDER
   * ------------------------------------------------------------- */
  function renderAlarms() {
    const filterF = els.alarmFilter.value;
    const visible = state.alarms.filter(a => !filterF || a.furnaceId === filterF);

    els.alCrit.textContent = state.alarms.filter(a => a.type === "Critical" && !a.ack).length;
    els.alWarn.textContent = state.alarms.filter(a => a.type === "Warning" && !a.ack).length;
    els.alInfo.textContent = state.alarms.filter(a => a.type === "Info" && !a.ack).length;

    if (visible.length === 0) {
      els.alarmFeed.innerHTML = `<div class="alarm-clear"><span>✓</span>No Active Alarms</div>`;
      return;
    }
    els.alarmFeed.innerHTML = visible.slice(0, 60).map(a => {
      const cls = a.ack ? "is-ack" : a.type === "Warning" ? "is-warn" : a.type === "Info" ? "is-info" : "";
      const badge = a.ack ? `<span class="alarm-badge b-ack">ACK</span>` : `<span class="alarm-badge b-${a.type === "Critical" ? "crit" : "warn"}">${a.type.toUpperCase()}</span>`;
      const ico = a.type === "Critical" ? "🔴" : a.type === "Warning" ? "🟠" : "🔵";
      return `<div class="alarm-item ${cls}" data-id="${a.id}">
        <span class="alarm-ico">${ico}</span>
        <div class="alarm-txt">
          <div class="a-title">${a.furnaceId} — ${a.type} (${a.temp}°C)</div>
          <div class="a-sub">${a.time.toLocaleTimeString("en-GB")}${a.ack ? ` · ack by ${a.ackBy}` : ""}</div>
        </div>
        ${badge}
      </div>`;
    }).join("");
  }

  els.alarmFeed.addEventListener("click", e => {
    const row = e.target.closest(".alarm-item");
    if (!row) return;
    openAlarmModal(parseInt(row.dataset.id, 10));
  });
  els.alarmFilter.addEventListener("change", renderAlarms);
  els.ackAllBtn.addEventListener("click", () => {
    state.alarms.filter(a => !a.ack).forEach(a => ackAlarm(a.id));
    renderAlarms();
  });

  /* ---------------------------------------------------------------
   * 14. ALARM DETAIL MODAL
   * ------------------------------------------------------------- */
  function openAlarmModal(id) {
    const a = state.alarms.find(x => x.id === id);
    if (!a) return;
    state.selectedAlarm = a;
    const f = CONFIG.furnaces.find(x => x.id === a.furnaceId);
    els.amFurnace.textContent = `${a.furnaceId} — ${f ? f.name : ""}`;
    els.amTemp.textContent = `${a.temp} °C`;
    els.amThreshold.textContent = `${a.threshold} °C`;
    els.amType.textContent = a.type;
    els.amTime.textContent = a.time.toLocaleString("en-GB");
    els.amStatus.textContent = a.ack ? `Acknowledged by ${a.ackBy} @ ${a.ackTime.toLocaleTimeString("en-GB")}` : "Active — Unacknowledged";
    els.amAction.textContent = a.action;
    els.alarmAckBtn.style.display = a.ack ? "none" : "block";
    els.alarmModal.style.display = "flex";
  }
  els.alarmCloseBtn.addEventListener("click", () => els.alarmModal.style.display = "none");
  els.alarmAckBtn.addEventListener("click", () => {
    if (state.selectedAlarm) { ackAlarm(state.selectedAlarm.id); renderAlarms(); }
    els.alarmModal.style.display = "none";
  });

  /* ---------------------------------------------------------------
   * 15. KPIs
   * ------------------------------------------------------------- */
  function updateKPIs(runningCount, total) {
    const temps = Object.values(state.furnaces).filter(s => s.running).map(s => s.temp);
    const avg = temps.length ? Math.round(temps.reduce((a, b) => a + b, 0) / temps.length) : 0;
    els.kpiAvg.textContent = temps.length ? `${avg}°` : "—";
    els.kpiProdCount.textContent = state.shiftStartCount;
    els.kpiRunning.textContent = `${runningCount} / ${total}`;
    els.kpiRunning.className = "kpi-val " + (runningCount === total ? "kpi-good" : runningCount === 0 ? "kpi-alarm" : "");
    els.kpiAlarms.textContent = state.alarms.filter(a => !a.ack).length;

    const ms = Date.now() - state.shiftStartTime.getTime();
    const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
    const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
    const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
    els.kpiUptime.textContent = `${h}:${m}:${s}`;
  }

  /* ---------------------------------------------------------------
   * 16. OEE  (Availability × Performance × Quality)
   * ------------------------------------------------------------- */
  function updateOEE(totalMachines) {
    const plannedMs = Date.now() - state.shiftStartTime.getTime();
    const downMs = state.downtime.reduce((sum, d) => {
      const end = d.end ? d.end.getTime() : Date.now();
      return sum + (end - d.start.getTime());
    }, 0);
    const availability = plannedMs > 0 ? Math.max(0, Math.min(100, 100 - (downMs / (plannedMs * totalMachines)) * 100)) : 100;

    const idealRatePerMin = totalMachines * 0.6; // ideal pieces/min across all furnaces
    const elapsedMin = Math.max(plannedMs / 60000, 0.05);
    const idealCount = idealRatePerMin * elapsedMin;
    const performance = idealCount > 0 ? Math.max(0, Math.min(100, (state.shiftStartCount / idealCount) * 100)) : 100;

    const totalRows = state.production.length || 1;
    const goodRows = state.production.filter(r => r.status === "Normal").length;
    const quality = (goodRows / totalRows) * 100;

    const oee = (availability / 100) * (performance / 100) * (quality / 100) * 100;

    els.oeeAvail.textContent = `${availability.toFixed(1)}%`;
    els.oeePerf.textContent = `${performance.toFixed(1)}%`;
    els.oeeQual.textContent = `${quality.toFixed(1)}%`;
    els.oeeFinal.textContent = `${oee.toFixed(1)}%`;
    els.kpiOEE.textContent = `${oee.toFixed(0)}%`;
  }

  /* ---------------------------------------------------------------
   * 17. DOWNTIME LIST
   * ------------------------------------------------------------- */
  function renderDowntime() {
    if (state.downtime.length === 0) {
      els.downtimeList.innerHTML = `<div class="dt-empty">No downtime recorded this shift</div>`;
      return;
    }
    els.downtimeList.innerHTML = state.downtime.slice().reverse().slice(0, 30).map(d => {
      const dur = d.duration != null ? `${d.duration}s` : "ongoing";
      return `<div class="dt-item">
        <div><span class="dt-reason">${d.machine}</span> — ${d.reason}</div>
        <div class="dt-time">${d.start.toLocaleTimeString("en-GB")}${d.end ? " – " + d.end.toLocaleTimeString("en-GB") : ""}</div>
        <div class="dt-dur">${dur}</div>
      </div>`;
    }).join("");
  }

  /* ---------------------------------------------------------------
   * 18. PRODUCTION TABLE + FILTERS
   * ------------------------------------------------------------- */
  function getFilteredRows() {
    let rows = state.production;
    const from = els.fFromDate.value, to = els.fToDate.value;
    const furnace = els.fFurnace.value, status = els.fStatus.value;

    if (from) rows = rows.filter(r => isoDate(r._ts) >= from);
    if (to) rows = rows.filter(r => isoDate(r._ts) <= to);
    if (status) rows = rows.filter(r => r.status === status);
    if (furnace) {
      const idx = CONFIG.furnaces.findIndex(f => f.id === furnace);
      rows = rows.filter(r => r.temps[idx] !== "-" && r.temps[idx] !== undefined);
    }
    return rows;
  }
  function isoDate(d) { return d.toISOString().slice(0, 10); }

  function renderTable() {
    const rows = getFilteredRows().slice(0, 200);
    els.prodTableBody.innerHTML = rows.map(r => {
      const tcells = [0, 1, 2, 3, 4, 5].map(i => `<td>${r.temps[i] !== undefined ? r.temps[i] : "-"}</td>`).join("");
      return `<tr>
        <td>${r.sno}</td><td>${r.date}</td><td>${r.time}</td>
        ${tcells}
        <td>${r.qty}</td>
        <td><span class="status-pill status-${r.status}">${r.status}</span></td>
      </tr>`;
    }).join("");
    els.tblInfo.textContent = `Showing ${rows.length} of ${state.production.length} records`;
  }

  els.searchBtn.addEventListener("click", renderTable);
  els.clearBtn.addEventListener("click", () => {
    els.fFromDate.value = ""; els.fToDate.value = ""; els.fFurnace.value = ""; els.fStatus.value = "";
    renderTable();
  });
  els.exportBtn.addEventListener("click", () => {
    const rows = getFilteredRows();
    const header = ["S.NO", "DATE", "TIME", "F1", "F2", "F3", "F4", "F5", "F6", "QTY", "STATUS"];
    const data = rows.map(r => [r.sno, r.date, r.time, ...[0, 1, 2, 3, 4, 5].map(i => r.temps[i] ?? "-"), r.qty, r.status]);
    const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Production Log");
    XLSX.writeFile(wb, `Furnace_Production_Log_${Date.now()}.xlsx`);
  });

  /* ---------------------------------------------------------------
   * 19. SHIFT REPORT (manual + automatic at 06:00 / 14:00 / 22:00)
   * ------------------------------------------------------------- */
  function generateShiftReportCSV() {
    const shift = currentShift();
    const lines = [
      ["Toyo Springs Ltd - Shift Report"],
      ["Shift", shift.name],
      ["Generated", new Date().toLocaleString("en-GB")],
      [],
      ["Avg Temp (C)", els.kpiAvg.textContent],
      ["Production Count", state.shiftStartCount],
      ["Machines Running", els.kpiRunning.textContent],
      ["Active Alarms", els.kpiAlarms.textContent],
      ["Availability", els.oeeAvail.textContent],
      ["Performance", els.oeePerf.textContent],
      ["Quality", els.oeeQual.textContent],
      ["OEE", els.oeeFinal.textContent],
      [],
      ["Downtime Events"],
      ["Machine", "Reason", "Start", "End", "Duration(s)"],
      ...state.downtime.map(d => [d.machine, d.reason, d.start.toLocaleTimeString("en-GB"), d.end ? d.end.toLocaleTimeString("en-GB") : "ongoing", d.duration ?? ""])
    ];
    const csv = lines.map(row => row.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `Shift_Report_${Date.now()}.csv`;
    a.click();
  }
  els.reportBtn.addEventListener("click", generateShiftReportCSV);

  let lastShiftStart = null;
  function checkAutoShiftBoundary() {
    const s = currentShift();
    if (lastShiftStart !== s.start) {
      if (lastShiftStart !== null) { generateShiftReportCSV(); initShift(); }
      lastShiftStart = s.start;
    }
  }

  /* ---------------------------------------------------------------
   * 20. SETTINGS MODAL (furnace count, sim mode, PLC, per-furnace limits)
   * ------------------------------------------------------------- */
  function buildLimitsTable() {
    const count = parseInt(els.setFurnaceCount.value, 10) || CONFIG.furnaceCount;
    let html = `<div class="flt-head"><span></span><span>Min</span><span>Max</span><span>Warn</span><span>Crit</span></div>`;
    for (let i = 0; i < count; i++) {
      const f = CONFIG.furnaces[i] || { id: `F${i + 1}`, min: 600, max: 950, warn: 850, crit: 900 };
      html += `<div class="flt-row" data-idx="${i}">
        <span>${f.id}</span>
        <input type="number" class="lim-min" value="${f.min}"/>
        <input type="number" class="lim-max" value="${f.max}"/>
        <input type="number" class="lim-warn" value="${f.warn}"/>
        <input type="number" class="lim-crit" value="${f.crit}"/>
      </div>`;
    }
    els.furnaceLimitsTable.innerHTML = html;
  }
  els.setFurnaceCount.addEventListener("input", buildLimitsTable);

  els.settingsBtn.addEventListener("click", () => {
    els.setFurnaceCount.value = CONFIG.furnaceCount;
    els.setSimMode.checked = CONFIG.simMode;
    els.setPlcIp.value = CONFIG.plcIp;
    els.setPlcPort.value = CONFIG.plcPort;
    buildLimitsTable();
    els.settingsModal.style.display = "flex";
  });
  els.settingsCancelBtn.addEventListener("click", () => els.settingsModal.style.display = "none");
  els.settingsSaveBtn.addEventListener("click", () => {
    const count = Math.min(6, Math.max(4, parseInt(els.setFurnaceCount.value, 10) || 6));
    const rows = els.furnaceLimitsTable.querySelectorAll(".flt-row");
    const furnaces = [];
    rows.forEach((row, i) => {
      const base = CONFIG.furnaces[i] || {};
      furnaces.push({
        id: `F${i + 1}`,
        name: base.name || `Furnace ${i + 1}`,
        color: FURNACE_COLORS[i],
        min: parseFloat(row.querySelector(".lim-min").value) || 600,
        max: parseFloat(row.querySelector(".lim-max").value) || 950,
        warn: parseFloat(row.querySelector(".lim-warn").value) || 850,
        crit: parseFloat(row.querySelector(".lim-crit").value) || 900
      });
    });
    CONFIG = {
      furnaceCount: count,
      simMode: els.setSimMode.checked,
      plcIp: els.setPlcIp.value.trim(),
      plcPort: els.setPlcPort.value.trim(),
      furnaces
    };
    saveConfig(CONFIG);
    els.settingsModal.style.display = "none";
    rebuildFurnaceFilterOptions();
    buildFurnaceState();
    buildChart();
    renderFurnaceCards();
    updatePlcChip();
  });

  function rebuildFurnaceFilterOptions() {
    const list = CONFIG.furnaces.slice(0, CONFIG.furnaceCount);
    els.fFurnace.innerHTML = `<option value="">All</option>` + list.map(f => `<option value="${f.id}">${f.id}</option>`).join("");
    els.alarmFilter.innerHTML = `<option value="">All Furnaces</option>` + list.map(f => `<option value="${f.id}">${f.id}</option>`).join("");
  }

  function updatePlcChip() {
    if (CONFIG.simMode) {
      state.plcConnected = true;
      els.plcChip.innerHTML = `<span class="dot dot-ok"></span> SIMULATION MODE`;
    } else {
      // Placeholder: wire this to a real PLC bridge endpoint on your Node/Express backend, e.g.:
      // fetch(`/api/plc/status`).then(r => r.json()).then(d => {...})
      state.plcConnected = false;
      els.plcChip.innerHTML = `<span class="dot dot-warn"></span> AWAITING PLC ${CONFIG.plcIp}:${CONFIG.plcPort}`;
    }
  }

  /* ---------------------------------------------------------------
   * 21. BOOT
   * ------------------------------------------------------------- */
  let simInterval = null, clockInterval = null;
  function bootDashboard() {
    rebuildFurnaceFilterOptions();
    buildFurnaceState();
    buildChart();
    initShift();
    lastShiftStart = currentShift().start;
    updatePlcChip();

    renderFurnaceCards();
    renderAlarms();
    renderTable();
    renderDowntime();
    updateKPIs(CONFIG.furnaceCount, CONFIG.furnaceCount);
    updateOEE(CONFIG.furnaceCount);

    tickClock();
    clockInterval && clearInterval(clockInterval);
    clockInterval = setInterval(() => { tickClock(); checkAutoShiftBoundary(); }, 1000);

    simInterval && clearInterval(simInterval);
    simInterval = setInterval(simTick, 2000);
    simTick();
  }

  // default date filters = today, blank-friendly
  document.addEventListener("DOMContentLoaded", () => {
    tickClock();
    setInterval(tickClock, 1000);
  });
})();