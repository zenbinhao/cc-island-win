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

// ── User preference (~/.claude/claude-island.json) ─────────────────────
const PREF_DIR  = join(homedir(), ".claude");
const PREF_FILE = join(PREF_DIR, "claude-island.json");

// PID 文件与孤儿 host 清理都在 server.listen 成功(确认自己是单例)之后才做:
// 并发启动的实例若在 EADDRINUSE 判定前就 taskkill 全部 host / 抢写 PID 文件,
// 会误杀健康 companion 的窗口、把 PID 文件指向一个将死进程
const PID_FILE = join(PREF_DIR, "claude-island.pid");
let ownsSingleton = false;
process.on("exit", () => { if (ownsSingleton) { try { if (existsSync(PID_FILE)) unlinkSync(PID_FILE); } catch {} } });

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
const pendingCaptures = []; // captureFg sids queued before any window is ready

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
  // 窗口未就绪期间排队的前台捕获:越早执行越接近回车时刻,绑错窗口概率越低
  for (const sid of pendingCaptures.splice(0)) { try { w.cmd({ type: "captureFg", sid }); } catch {} }
  // Resize BEFORE replaying rows: native host processes resize synchronously (Form.Invoke blocks),
  // so the window is at the correct height before any upsertRow JS reaches the browser process.
  syncHeight();
  for (const js of pending.splice(0)) { try { w.send(js); } catch {} }
  for (const js of currentRows.values()) { try { w.send(js); } catch {} }
}

// 跳转聚焦:sessionId → { hwnd, paneId, paneClass, tabId }(UserPromptSubmit 时刻由
// host 捕获;paneId/tabId 是 UIA RuntimeId——pane 定位 TermControl,tab 用于非活动
// tab 时先切过去)。持久化到磁盘,companion 重启后点击跳转依然可用。
const FG_FILE = join(PREF_DIR, "claude-island-fg.json");
const hwndBySession = new Map();
try {
  const saved = JSON.parse(readFileSync(FG_FILE, "utf8"));
  if (saved && typeof saved === "object") {
    for (const [k, v] of Object.entries(saved)) {
      if (v && typeof v.hwnd === "number") hwndBySession.set(k, v);
    }
    log("info", `fg table loaded: ${hwndBySession.size} entries`);
  }
} catch {}
function saveFgTable() {
  try { writeFileSync(FG_FILE, JSON.stringify(Object.fromEntries(hwndBySession))); } catch {}
}
function hostWin() { for (const w of wins) if (w._ready) return w; return null; }
function focusSession(id) {
  const t = hwndBySession.get(id);
  log("info", `focus id=${id} hwnd=${t ? t.hwnd : "none"} class=${t ? (t.winClass || "-") : "-"} pane=${t ? (t.paneClass || "-") + "#" + (t.paneId || "-") : "-"} tab=#${t ? (t.tabId || "-") : "-"}`);
  if (!t) return;
  const hw = hostWin();
  if (hw) hw.cmd({ type: "focusWindow", hwnd: t.hwnd, paneId: t.paneId, paneClass: t.paneClass, tabId: t.tabId || "", winClass: t.winClass || "" });
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
      hwndBySession.set(m.sid, {
        hwnd: m.hwnd,
        paneId: typeof m.paneId === "string" ? m.paneId : "",
        paneClass: typeof m.paneClass === "string" ? m.paneClass : "",
        tabId: typeof m.tabId === "string" ? m.tabId : "",
        winClass: typeof m.winClass === "string" ? m.winClass : "",
      });
      saveFgTable();
      log("info", `fg captured: ${m.sid} → hwnd=${m.hwnd} class=${m.winClass || "-"} pane=${(m.paneClass || "-")}#${(m.paneId || "-")} tab=#${(m.tabId || "-")}`);
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

// 开窗动作整体移入 server.listen 成功回调:确认单例前不碰任何窗口/进程,
// EADDRINUSE 的并发实例从头到尾零副作用(此前会先开一个一闪而过的 host 再退出)
function openAllWindows() {
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
}

// ── Socket server ──────────────────────────────────────────────────────
try { mkdirSync(PREF_DIR, { recursive: true }); } catch (e) { log("warn", `mkdir PREF_DIR failed: ${e.message}`); }

const clients = new Set();
const activeRowIds = new Set();
const rowPids = new Map();  // id → ccPid, 用于探活
const rowSeenAlive = new Set();   // 曾观测到 pid 存活的行(探活可信)
const rowLastUpdate = new Map();  // id → 最近 update 时间戳(pid 不可信时的静默期兜底)

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
  rowSeenAlive.delete(id);
  rowLastUpdate.delete(id);
  if (hwndBySession.delete(id)) saveFgTable();
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
      rowLastUpdate.set(msg.id, Date.now());
      if (typeof msg.ccPid === "number" && msg.ccPid > 0) {
        rowPids.set(msg.id, msg.ccPid);
      }
      if (msg.captureFg) {
        // UserPromptSubmit 时刻:用户刚在该终端按下回车,前台窗口就是它
        const hw = hostWin();
        if (hw) hw.cmd({ type: "captureFg", sid: msg.id });
        else if (pendingCaptures.length < 20) pendingCaptures.push(msg.id); // 冷启动首条 prompt:窗口就绪后立刻补捕获
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
  log("info", `listening on ${JSON.stringify(SOCK)}`);
  ownsSingleton = true;
  try { writeFileSync(PID_FILE, String(process.pid)); } catch {}
  // 单例确认、自己尚未开窗的此刻,才清理上次异常退出留下的孤儿 host
  try {
    execSync("taskkill /F /IM island-host-win.exe", { timeout: 3000, stdio: "pipe", windowsHide: true });
    log("info", "cleaned up orphaned island-host-win processes");
  } catch { /* 没有孤儿进程 — 正常 */ }
  openAllWindows();
});

// ── Liveness checker (30s) ─────────────────────────────────────────────
setInterval(() => {
  const dead = deadRowIds(rowPids, processIsAlive, {
    seenAlive: rowSeenAlive, lastUpdate: rowLastUpdate,
  });
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
