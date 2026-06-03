#!/usr/bin/env node
// claude-island companion daemon
// ===============================
// Single long-lived process that:
//   1. Owns native WebView windows at the top-center of each screen.
//   2. Runs a socket server for bridge clients to stream status updates.
//   3. Renders each connected session as its own pill row.
//
// Protocol (client → server, one JSON per line):
//   { id, type:"update", project, status, detail, prompt, ctxPct, startedAt, frozenElapsed }
//   { id, type:"remove" }
//   { id, type:"scale",   scale:"small"|"medium"|"large"|"xlarge" }
//   { id, type:"done-retract", delayMs: 5000 }   — auto-remove row after delay
//   { id, type:"respawn" }
//
// Persistent daemon — stays alive until explicitly killed.
// The island window remains visible as a permanent status bar.

import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { existsSync, readFileSync, unlinkSync, mkdirSync, appendFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { openFixed } from "./open-fixed.mjs";
import { buildIslandHTML } from "./island.html.mjs";
import { SOCK } from "./socket-path.mjs";
import { getScreenGeometry, getScreenCount, computeWindowPosition } from "./platform.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ── Logging ────────────────────────────────────────────────────────────
const LOG_FILE = join(homedir(), ".claude", "claude-island.log");
const MAX_LOG_SIZE = 256 * 1024;

function log(level, msg) {
  try {
    const ts = new Date().toISOString();
    appendFileSync(LOG_FILE, `[${ts}] [${level}] ${msg}\n`);
  } catch {}
}

try {
  if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > MAX_LOG_SIZE) {
    unlinkSync(LOG_FILE);
  }
} catch {}

log("info", `companion starting (pid=${process.pid}, platform=${process.platform})`);

// Kill any orphaned native host windows from a previous abnormal exit
try {
  execSync("taskkill /F /IM island-host-win.exe 2>nul", { timeout: 3000, stdio: "pipe", windowsHide: true });
  log("info", "cleaned up orphaned island-host-win processes");
} catch (e) { /* no orphaned processes — expected */ }

// ── User preference (~/.claude/claude-island.json) ─────────────────────
const PREF_DIR  = join(homedir(), ".claude");
const PREF_FILE = join(PREF_DIR, "claude-island.json");

const PID_FILE = join(PREF_DIR, "claude-island.pid");
try { writeFileSync(PID_FILE, String(process.pid)); } catch {}
process.on("exit", () => { try { if (existsSync(PID_FILE)) unlinkSync(PID_FILE); } catch {} });

// ── Crash handlers ─────────────────────────────────────────────────────
process.on("uncaughtException", (err) => {
  log("fatal", `uncaughtException: ${err.message}\n${err.stack}`);
  cleanup();
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log("error", `unhandledRejection: ${reason}`);
});

const VALID_STATUS = new Set([
  "thinking", "reading", "editing", "writing",
  "running",  "searching", "done",    "error", "waiting",
]);

function readPref() {
  try {
    if (!existsSync(PREF_FILE)) return {};
    const data = JSON.parse(readFileSync(PREF_FILE, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch (e) {
    log("warn", `readPref failed: ${e.message}`);
    return {};
  }
}

// ── Window setup ───────────────────────────────────────────────────────
const WIN_W = 640;
const WIN_H = 52;

const _pref = readPref();
const SCREEN_PREF = typeof _pref.screen === "string" && _pref.screen.length > 0 ? _pref.screen : "primary";
const THEME_PREF = ["dark","pink","auto"].includes(_pref.theme) ? _pref.theme : "dark";

log("info", `screenPref=${SCREEN_PREF} theme=${THEME_PREF}`);

// Build list of screen geometries to open windows on
const screenGeos = [];
if (SCREEN_PREF === "all") {
  const count = getScreenCount();
  log("info", `all-screens mode: detected ${count} screen(s)`);
  for (let i = 1; i <= count; i++) {
    screenGeos.push(getScreenGeometry(String(i)));
  }
  // Fallback: if count detection failed, use primary
  if (screenGeos.length === 0) screenGeos.push(getScreenGeometry("primary"));
} else {
  screenGeos.push(getScreenGeometry(SCREEN_PREF));
}

log("info", `windows=${screenGeos.length}`);

// ── Open one window per screen ─────────────────────────────────────────
// currentRows: id → js string — used to replay state into newly-ready windows
const currentRows = new Map();
const wins = [];

const MAX_PENDING = 200;
const pending = []; // JS strings queued before any window is ready

function send(js) {
  let sentToAny = false;
  for (const w of wins) {
    if (w._ready) { try { w.send(js); } catch (e) { log("warn", `win.send failed: ${e.message}`); } sentToAny = true; }
  }
  if (!sentToAny && pending.length < MAX_PENDING) pending.push(js);
}

function initWindow(w) {
  // Apply current state to a newly-ready window
  w.send('window.island.setTheme(' + JSON.stringify(THEME_PREF) + ')');
  // Resize BEFORE replaying rows: native host processes resize synchronously (Form.Invoke blocks),
  // so the window is at the correct height before any upsertRow JS reaches the browser process.
  syncHeight();
  for (const js of pending.splice(0)) { try { w.send(js); } catch {} }
  for (const js of currentRows.values()) { try { w.send(js); } catch {} }
}

for (const geo of screenGeos) {
  const { x, y } = computeWindowPosition(geo, WIN_W, WIN_H);
  log("info", `screenGeo=${JSON.stringify(geo)} windowPos=(${x},${y})`);
  let w;
  try {
    w = openFixed(buildIslandHTML(), {
      width: WIN_W, height: WIN_H, x, y,
      frameless: true, floating: true, transparent: true,
      clickThrough: true, noDock: true,
    });
  } catch (e) {
    log("fatal", `openFixed failed for screen (${x},${y}): ${e.message}`);
    continue;
  }
  w._ready = false;
  wins.push(w);

  w.on("ready", (info) => {
    w._ready = true;
    log("info", `window ready at (${x},${y}): ${JSON.stringify(info)}`);
    initWindow(w);
  });
  w.on("closed", () => {
    log("info", `window closed at (${x},${y})`);
    cleanup();
    process.exit(0);
  });
  w.on("error", (e) => {
    log("error", `window error at (${x},${y}): ${e?.message || e}`);
  });
}

if (wins.length === 0) {
  log("fatal", "no windows could be opened");
  process.exit(1);
}

// ── Socket server ──────────────────────────────────────────────────────
try { mkdirSync(PREF_DIR, { recursive: true }); } catch (e) { log("warn", `mkdir PREF_DIR failed: ${e.message}`); }

const clients = new Set();
const socketIds = new WeakMap();
const activeRowIds = new Set();
let idleTimer = null;
const doneTimers = new Map();
const ROW_TTL_MS = 120000;
const rowLastUpdate = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of rowLastUpdate) {
    if (now - ts > ROW_TTL_MS) {
      log("info", `row TTL expired id=${id}`);
      rowLastUpdate.delete(id);
      clearDoneTimer(id);
      activeRowIds.delete(id);
      currentRows.delete(id);
      syncHeight();
      try { send('window.island.removeRow(' + JSON.stringify(id) + ')'); } catch {}
    }
  }
}, 10000);

function syncHeight() {
  const h = Math.max(52, activeRowIds.size * 36 + 8);
  for (const w of wins) { try { w.resize(WIN_W, h); } catch {} }
}

function scheduleIdleExit() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    log("info", "all clients disconnected, exiting companion");
    cleanup();
    process.exit(0);
  }, 60000); // exit 60s after last client disconnects
}

const server = createServer((sock) => {
  clients.add(sock);
  socketIds.set(sock, new Set());
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  log("info", `client connected (total=${clients.size})`);

  const rl = createInterface({ input: sock, crlfDelay: Infinity });
  rl.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg || typeof msg.type !== "string") return;
    if (typeof msg.id === "string" && msg.id) {
      socketIds.get(sock)?.add(msg.id);
    }

    if (msg.type === "update") {
      if (!msg.id || !VALID_STATUS.has(msg.status)) return;
      log("info", `update id=${msg.id} status=${msg.status} project=${msg.project||''} prompt="${(msg.prompt||'').substring(0,40)}"`);
      rowLastUpdate.set(msg.id, Date.now());
      clearDoneTimer(msg.id);
      activeRowIds.add(msg.id);
      syncHeight();
      const js = 'window.island.upsertRow(' + JSON.stringify(msg.id) + ',' + JSON.stringify(msg) + ')';
      currentRows.set(msg.id, js);
      send(js);
      return;
    }
    if (msg.type === "remove") {
      if (!msg.id) return;
      clearDoneTimer(msg.id);
      activeRowIds.delete(msg.id);
      currentRows.delete(msg.id);
      syncHeight();
      log("info", `remove id=${msg.id}`);
      send('window.island.removeRow(' + JSON.stringify(msg.id) + ')');
      return;
    }
    if (msg.type === "done-retract") {
      if (!msg.id) return;
      const delay = typeof msg.delayMs === "number" ? msg.delayMs : 5000;
      log("info", `done-retract id=${msg.id} delay=${delay}ms`);
      scheduleDoneRetract(msg.id, delay);
      return;
    }
    if (msg.type === "scale" && typeof msg.scale === "string") {
      send('window.island.setScale(' + JSON.stringify(msg.scale) + ')');
      return;
    }
    if (msg.type === "theme" && ["dark","pink","auto"].includes(msg.theme)) {
      send('window.island.setTheme(' + JSON.stringify(msg.theme) + ')');
      return;
    }
    if (msg.type === "respawn") {
      log("info", "respawn requested");
      cleanup();
      process.exit(0);
      return;
    }
    if (msg.type === "eval" && typeof msg.js === "string") {
      log("info", `eval: ${msg.js.substring(0,80)}`);
      send(msg.js);
      return;
    }
  });

  sock.on("close", () => {
    clients.delete(sock);
    const ids = socketIds.get(sock);
    if (ids) socketIds.delete(sock);
    log("info", `client disconnected (total=${clients.size})`);
    if (clients.size === 0) scheduleIdleExit();
  });
  sock.on("error", (e) => {
    log("warn", `socket error: ${e.message}`);
  });
});

function clearDoneTimer(id) {
  const t = doneTimers.get(id);
  if (t) { clearTimeout(t); doneTimers.delete(id); }
}

function scheduleDoneRetract(id, delayMs) {
  clearDoneTimer(id);
  const t = setTimeout(() => {
    doneTimers.delete(id);
    activeRowIds.delete(id);
    rowLastUpdate.delete(id);
    currentRows.delete(id);
    syncHeight();
    send('window.island.removeRow(' + JSON.stringify(id) + ')');
  }, delayMs);
  doneTimers.set(id, t);
}

server.on("error", (err) => {
  if (err?.code === "EADDRINUSE") {
    log("info", "EADDRINUSE — another companion is already running, exiting");
    cleanup();
    process.exit(0);
  }
  log("error", `server error: ${err?.message} (code=${err?.code})`);
  cleanup();
  process.exit(1);
});

server.listen(SOCK, () => {
  log("info", `listening on ${SOCK}`);
});

// ── Cleanup ────────────────────────────────────────────────────────────
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  log("info", "cleanup");
  for (const t of doneTimers.values()) clearTimeout(t);
  doneTimers.clear();
  try { server.close(); } catch (e) { log("warn", `server.close failed: ${e.message}`); }
  for (const w of wins) { try { w.close(); } catch (e) { log("warn", `win.close failed: ${e.message}`); } }
}
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("SIGINT",  () => { cleanup(); process.exit(0); });
process.on("exit", cleanup);
