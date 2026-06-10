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
//   { id, type:"respawn" }
//
// Persistent daemon — stays alive until explicitly killed.
// The island window remains visible as a permanent status bar.

import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { existsSync, readFileSync, unlinkSync, mkdirSync, appendFileSync, statSync, writeFileSync } from "node:fs";
import { deadRowIds, processIsAlive } from "./liveness.mjs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { openFixed } from "./open-fixed.mjs";
import { buildIslandHTML } from "./island.html.mjs";
import { SOCK } from "./socket-path.mjs";
import { SCALES, windowSize } from "./scales.mjs";

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
  execSync("taskkill /F /IM island-host-win.exe", { timeout: 3000, stdio: "pipe", windowsHide: true });
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
const _pref = readPref();
const SCREEN_PREF = typeof _pref.screen === "string" && _pref.screen.length > 0 ? _pref.screen : "primary";
const THEME_PREF = ["dark","pink","auto"].includes(_pref.theme) ? _pref.theme : "dark";
let curScale = SCALES[_pref.scale] ? _pref.scale : "medium";

log("info", `screenPref=${SCREEN_PREF} theme=${THEME_PREF}`);

// ── Open one window per screen ─────────────────────────────────────────
// currentRows: id → js string — used to replay state into newly-ready windows
const currentRows = new Map();
const wins = [];
let isCollapsed = false;

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

// 跳转聚焦:sessionId → 前台窗口 HWND(UserPromptSubmit 时刻由 host 捕获)
const hwndBySession = new Map();
function hostWin() { for (const w of wins) if (w._ready) return w; return null; }
function focusSession(id) {
  const hwnd = hwndBySession.get(id);
  log("info", `focus id=${id} hwnd=${hwnd || "none"}`);
  if (!hwnd) return;
  const hw = hostWin();
  if (hw) hw.cmd({ type: "focusWindow", hwnd });
}

function openIslandWindow(screenPref) {
  const init = windowSize(1, false, curScale);
  let w;
  try {
    w = openFixed(buildIslandHTML(), {
      width: init.w, height: init.h, screen: screenPref,
      frameless: true, floating: true, transparent: true,
      clickThrough: true, noDock: true,
    });
  } catch (e) { log("fatal", `openFixed failed (screen=${screenPref}): ${e.message}`); return null; }
  w._ready = false;
  wins.push(w);
  w.on("ready", (info) => {
    w._ready = true;
    log("info", `window ready (screen=${screenPref}): ${JSON.stringify(info)}`);
    initWindow(w);
  });
  w.on("message", (data) => {
    // Handle messages from WebView (collapse button, per-row dismiss, row focus)
    if (!data || typeof data !== "object") return;
    if (data.action === "collapseChanged") {
      isCollapsed = data.collapsed;
      log("info", `collapse state changed: ${isCollapsed}`);
      syncHeight();
    } else if (data.type === "dismiss" && typeof data.id === "string" && data.id) {
      log("info", `dismiss id=${data.id}`);
      removeRowById(data.id);
    } else if (data.type === "focus" && typeof data.id === "string" && data.id) {
      focusSession(data.id);
    }
  });
  w.on("fg", (m) => {
    if (m && typeof m.sid === "string" && typeof m.hwnd === "number" && m.hwnd > 0) {
      hwndBySession.set(m.sid, m.hwnd);
      log("info", `fg captured: ${m.sid} → hwnd=${m.hwnd}`);
    }
  });
  w.on("closed", () => {
    if (!w._ready) log("fatal", "window closed before ready — WebView2 Runtime 可能缺失,安装: https://developer.microsoft.com/en-us/microsoft-edge/webview2/");
    log("info", `window closed (screen=${screenPref})`);
    cleanup();
    process.exit(0);
  });
  w.on("error", (e) => { log("error", `window error (screen=${screenPref}): ${e?.message || e}`); });
  return w;
}

const firstWin = openIslandWindow(SCREEN_PREF === "all" ? "primary" : SCREEN_PREF);
if (SCREEN_PREF === "all" && firstWin) {
  // 先有 host 才知道屏数:经 screens 协议问到后再补开其余屏
  firstWin.on("screens", (count) => {
    log("info", `all-screens mode: ${count} screen(s)`);
    for (let i = 2; i <= Math.min(count, 9); i++) openIslandWindow(String(i));
  });
  firstWin.on("ready", () => firstWin.cmd({ type: "screens" }));
}

if (wins.length === 0) {
  log("fatal", "no windows could be opened");
  process.exit(1);
}

// ── Socket server ──────────────────────────────────────────────────────
try { mkdirSync(PREF_DIR, { recursive: true }); } catch (e) { log("warn", `mkdir PREF_DIR failed: ${e.message}`); }

const clients = new Set();
const activeRowIds = new Set();
const rowPids = new Map();  // id → ccPid, 用于探活

let lastW = -1, lastH = -1;
function syncHeight() {
  const { w, h } = windowSize(activeRowIds.size, isCollapsed, curScale);
  if (w === lastW && h === lastH) return; // 尺寸没变就别打扰 host(此前每条 update 都 SetWindowPos)
  lastW = w; lastH = h;
  for (const win of wins) { try { win.resize(w, h); } catch {} }
}

function removeRowById(id) {
  activeRowIds.delete(id);
  rowPids.delete(id);
  hwndBySession.delete(id);
  currentRows.delete(id);
  syncHeight();  // 空了会自动隐藏(在 syncHeight 里统一处理)
  send('window.island.removeRow(' + JSON.stringify(id) + ')');
}

const server = createServer((sock) => {
  clients.add(sock);
  log("info", `client connected (total=${clients.size})`);

  const rl = createInterface({ input: sock, crlfDelay: Infinity });
  rl.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "update") {
      if (!msg.id || !VALID_STATUS.has(msg.status)) return;
      log("info", `update id=${msg.id} status=${msg.status} project=${msg.project||''} prompt="${(msg.prompt||'').substring(0,40)}"`);
      activeRowIds.add(msg.id);
      if (typeof msg.ccPid === "number" && msg.ccPid > 0) {
        rowPids.set(msg.id, msg.ccPid);
      }
      if (msg.captureFg) {
        // UserPromptSubmit 时刻:用户刚在该终端按下回车,前台窗口就是它
        const hw = hostWin();
        if (hw) hw.cmd({ type: "captureFg", sid: msg.id });
      }
      // Auto-expand when new update arrives
      if (isCollapsed) {
        isCollapsed = false;
        send('window.island.setCollapsed(false)');
        log("info", "auto-expanded due to new update");
      }
      syncHeight();
      const js = 'window.island.upsertRow(' + JSON.stringify(msg.id) + ',' + JSON.stringify(msg) + ')';
      currentRows.set(msg.id, js);
      send(js);
      return;
    }
    if (msg.type === "remove") {
      if (!msg.id) return;
      log("info", `remove id=${msg.id}`);
      removeRowById(msg.id);
      return;
    }
    if (msg.type === "scale" && typeof msg.scale === "string") {
      if (SCALES[msg.scale]) curScale = msg.scale;
      send('window.island.setScale(' + JSON.stringify(msg.scale) + ')');
      syncHeight(); // 缩放改变窗口宽高(修 large/xlarge 被裁剪)
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
    log("info", `client disconnected (total=${clients.size})`);
  });
  sock.on("error", (e) => {
    log("warn", `socket error: ${e.message}`);
  });
});

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

// ── Liveness checker (30s) ─────────────────────────────────────────────
setInterval(() => {
  const dead = deadRowIds(rowPids, processIsAlive);
  for (const id of dead) {
    log("info", `liveness check: row ${id} pid=${rowPids.get(id)} is dead, removing`);
    removeRowById(id);
  }
}, 30_000);

// ── Cleanup ────────────────────────────────────────────────────────────
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  log("info", "cleanup");
  try { server.close(); } catch (e) { log("warn", `server.close failed: ${e.message}`); }
  for (const w of wins) { try { w.close(); } catch (e) { log("warn", `win.close failed: ${e.message}`); } }
}
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("SIGINT",  () => { cleanup(); process.exit(0); });
process.on("exit", cleanup);
