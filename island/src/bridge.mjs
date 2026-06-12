#!/usr/bin/env node
// claude-island bridge — called by Claude Code hooks as one-shot processes.
//
// Two modes:
//   1. hook mode:  reads stdin JSON from Claude Code hook system
//                  (session_id, prompt, tool_name, tool_input, etc.)
//   2. CLI mode:   traditional subcommands (on, off, status, etc.)
//
// Hook data arrives via stdin, NOT command-line arguments. The ${PROMPT}
// / ${TOOL_NAME} variables in the command string are NOT substituted by
// Claude Code — they arrive in the stdin JSON payload.

import { connect } from "node:net";
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { SOCK } from "./socket-path.mjs";
import { SCALES as SCALE_MAP } from "./scales.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPANION = join(HERE, "companion.mjs");
const PREF_DIR  = join(homedir(), ".claude");
const STATE_FILE = join(PREF_DIR, "claude-island-state.json");
const PREF_FILE  = join(PREF_DIR, "claude-island.json");
const PID_FILE   = join(PREF_DIR, "claude-island.pid");

// ── Logging ────────────────────────────────────────────────────────────
function log(msg) { console.error(`[bridge] ${msg}`); }

// ── Scale presets ───────────────────────────────────────────────────────
const SCALES = Object.keys(SCALE_MAP);
const DEFAULT_SCALE = "medium";
function isScale(v) { return typeof v === "string" && SCALES.includes(v); }

// ── State read/write ────────────────────────────────────────────────────
function readState() {
  const fallback = {
    enabled: true, scale: DEFAULT_SCALE, screen: "primary",
    theme: "dark",
    project: "", inAgent: false, activeToolCount: 0,
    prompt: "", startedAt: null, frozenElapsed: null,
  };
  try {
    if (!existsSync(STATE_FILE)) return fallback;
    const data = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    delete data.sessionId;
    delete data._sessions;
    delete data._activeSessionId;
    return { ...fallback, ...data };
  } catch (e) { log(`readState failed: ${e.message}`); return fallback; }
}

// 原子写状态文件:先写临时文件再 rename。多个一次性 bridge 并发写时
// 互相覆盖也只会丢一次更新,不会留下半截 JSON(尾部垃圾曾导致解析永久失败)
function writeStateFileAtomic(data) {
  const tmp = STATE_FILE + "." + process.pid + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, STATE_FILE);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

function writeState(s) {
  try {
    if (!existsSync(PREF_DIR)) mkdirSync(PREF_DIR, { recursive: true });
    let prev = {};
    try { prev = JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch {}
    if (prev && prev._activeSessionId) s._activeSessionId = prev._activeSessionId;
    writeStateFileAtomic(s);
  } catch (e) { log(`writeState failed: ${e.message}`); }
}

function writePref(state) {
  try {
    writeFileSync(PREF_FILE, JSON.stringify({
      enabled: state.enabled, scale: state.scale,
      screen: state.screen,
      theme: state.theme,
    }, null, 2));
  } catch (e) { log(`writePref failed: ${e.message}`); }
}

// ── Tool name → island status ───────────────────────────────────────────
function toolToIsland(toolName, input) {
  if (!input || typeof input !== "object") input = {};
  // MCP tools: extract last segment (e.g. mcp__db-query__query_mysql → query_mysql)
  const shortName = toolName.startsWith("mcp__")
    ? toolName.split("__").pop() || toolName
    : toolName;
  switch (toolName) {
    case "Read":      return { status: "reading",   detail: basename(input.file_path || "") || "file" };
    case "Edit":      return { status: "editing",   detail: basename(input.file_path || "") || "file" };
    case "Write":     return { status: "writing",   detail: basename(input.file_path || "") || "file" };
    case "Bash": case "PowerShell":
                      return { status: "running",   detail: (input.command || "").split(/\s+/)[0] || "shell" };
    case "Glob":      return { status: "searching", detail: input.pattern || "files" };
    case "Grep":      return { status: "searching", detail: input.pattern || "text" };
    case "Agent":     return { status: "thinking",  detail: input.subagent_type || "sub-agent" };
    case "WebFetch":  return { status: "reading",   detail: "web" };
    case "WebSearch": return { status: "searching", detail: "web" };
    case "AskUserQuestion": return { status: "thinking", detail: "asking" };
    case "TaskCreate": case "TaskUpdate": case "TaskGet": case "TaskList":
                      return { status: "thinking",  detail: "task" };
    default:          return { status: "running",   detail: truncate(shortName, 24) };
  }
}

function truncate(s, max) {
  const clean = String(s || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

// ── Socket helpers ──────────────────────────────────────────────────────
function connectOnce() {
  return new Promise((resolve) => {
    const s = connect(SOCK);
    let settled = false;
    // 定时器必须清理:bridge 是一次性进程,残留定时器会挂住事件循环到超时才退出
    const timer = setTimeout(() => {
      if (!settled) { settled = true; log("connectOnce timeout"); try { s.destroy(); } catch {} resolve(null); }
    }, 2000);
    s.once("connect", () => { settled = true; clearTimeout(timer); resolve(s); });
    s.once("error", (err) => {
      if (!settled) { settled = true; clearTimeout(timer); log(`connectOnce error: ${err.code || err.message}`); resolve(null); }
    });
  });
}

function writeMessage(sock, msg) {
  if (!sock || sock.destroyed) return;
  try { sock.write(JSON.stringify(msg) + "\n"); } catch (e) { log(`writeMessage failed: ${e.message}`); }
}

// ── Companion lifecycle ─────────────────────────────────────────────────
async function ensureCompanion() {
  const existing = await connectOnce();
  if (existing) { existing.end(); return true; }
  if (!existsSync(COMPANION)) { log("COMPANION not found: " + COMPANION); return false; }
  log("spawning companion...");
  const child = spawn(process.execPath, [COMPANION], {
    detached: true, stdio: "ignore", windowsHide: true,
  });
  let spawnError = null;
  child.on("error", (err) => { spawnError = err; log(`companion spawn error: ${err.message}`); });
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (spawnError) return false;
    await new Promise((r) => setTimeout(r, 100));
    const s = await connectOnce();
    if (s) { s.end(); log("companion ready after " + ((i + 1) * 100) + "ms"); return true; }
  }
  log("companion did not start within 4s");
  return false;
}

async function forceKillCompanion() {
  log("force killing companion...");
  let killed = false;
  try {
    if (existsSync(PID_FILE)) {
      const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
      if (Number.isFinite(pid) && pid > 0) {
        if (process.platform === "win32") {
          execSync(`taskkill /F /PID ${pid}`, { timeout: 2000, stdio: "pipe", windowsHide: true });
        }
        killed = true;
        log(`killed companion pid=${pid}`);
      }
    }
  } catch (e) { log(`PID kill failed: ${e.message}`); }
  if (!killed) {
    try {
      if (process.platform === "win32") {
        // taskkill /FI COMMANDLINE may fail on Win10 without elevation.
        // Fall back to PowerShell WMI which can read CommandLine in the same session.
        execSync(
          `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { $_.CommandLine -like '*companion.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }"`,
          { timeout: 5000, stdio: "pipe", windowsHide: true }
        );
      }
    } catch (e) { log(`pattern kill: ${e.message}`); }
  }
  // Kill orphaned native host windows (child process not auto-killed on Windows)
  try {
    if (process.platform === "win32") {
      execSync("taskkill /F /IM island-host-win.exe", { timeout: 3000, stdio: "pipe", windowsHide: true });
      log("killed orphaned island-host-win processes");
    }
  } catch (e) { log(`native host kill: ${e.message}`); }
  try { if (existsSync(PID_FILE)) unlinkSync(PID_FILE); } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

// ── Send helpers ────────────────────────────────────────────────────────
async function sendToCompanion(msg) {
  const sock = await connectOnce();
  if (!sock) {
    if (!(await ensureCompanion())) return false;
    const s2 = await connectOnce();
    if (!s2) return false;
    writeMessage(s2, msg);
    s2.end();
    return true;
  }
  writeMessage(sock, msg);
  sock.end();
  return true;
}

// ── Per-session data (avoids cross-session pollution) ──────────────────
function getSessionData(sessionId) {
  try {
    if (!existsSync(STATE_FILE)) return {};
    const data = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (!data || !data._sessionData) return {};
    return data._sessionData[sessionId] || {};
  } catch { return {}; }
}

function saveSessionData(sessionId, fields) {
  try {
    // 文件损坏(并发写事故)→ 以空表自愈重建,而不是静默放弃
    let data = {};
    try {
      if (existsSync(STATE_FILE)) data = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    } catch {}
    if (!data || typeof data !== "object") data = {};
    if (!data._sessionData) data._sessionData = {};
    if (!data._sessionData[sessionId]) data._sessionData[sessionId] = {};
    Object.assign(data._sessionData[sessionId], fields);
    // Prune stale sessions (> 10 min inactive)
    const now = Date.now();
    for (const [id, s] of Object.entries(data._sessionData)) {
      if (s && s.lastActivity && (now - s.lastActivity) > 600000) {
        delete data._sessionData[id];
      }
    }
    writeStateFileAtomic(data);
  } catch {}
}

function deleteSessionData(sessionId) {
  try {
    if (existsSync(STATE_FILE)) {
      const data = JSON.parse(readFileSync(STATE_FILE, "utf8"));
      if (data && data._sessionData && data._sessionData[sessionId]) {
        delete data._sessionData[sessionId];
        writeStateFileAtomic(data);
      }
    }
  } catch {}
}

// ── Hook mode: read stdin JSON, dispatch by hook_event_name ─────────────
async function handleHook(json) {
  const event = json.hook_event_name;
  const sessionId = json.session_id || "unknown";
  const cwd = json.cwd || process.cwd();
  const state = readState(); // global prefs only (enabled, scale, etc.)
  if (state.enabled === false) return; // /island off:hook 全部静默(否则 off 形同虚设,还会拉活 companion)
  const sess = getSessionData(sessionId);

  log(`hook event=${event} session=${sessionId} cwd=${cwd}`);
  const ccPid = process.ppid;  // WSL2: wsl.exe 中继 PID; native: 待验证

  // Project from cwd (per-session to avoid cross-contamination)
  const project = basename(cwd) || "claude";
  sess.project = project;
  sess.lastActivity = Date.now();

  switch (event) {
    case "UserPromptSubmit": {
      sess.prompt = truncate(json.prompt || "", 48);
      sess.inAgent = true;
      sess.activeToolCount = 0;
      sess.startedAt = Date.now();
      sess.frozenElapsed = null;
      saveSessionData(sessionId, sess);
      log(`prompt="${sess.prompt}" project="${project}"`);
      await sendToCompanion({
        id: sessionId, type: "update",
        project, status: "thinking", detail: "",
        prompt: sess.prompt, startedAt: sess.startedAt, frozenElapsed: null,
        ccPid,
        captureFg: true,  // companion 据此让常驻 host 捕获前台 HWND(点击跳转的锚点)
      });
      break;
    }

    case "PreToolUse": {
      const toolName = json.tool_name || "";
      const toolInput = json.tool_input || {};
      const toolUseId = json.tool_use_id || "";
      sess.activeToolCount = (sess.activeToolCount || 0) + 1;
      if (!sess.inAgent) {
        sess.inAgent = true;
        sess.startedAt = Date.now();
      }
      sess._lastToolId = toolUseId;
      saveSessionData(sessionId, sess);
      const upd = toolToIsland(toolName, toolInput);
      await sendToCompanion({
        id: sessionId, type: "update",
        project, status: upd.status, detail: upd.detail,
        prompt: sess.prompt || "", startedAt: sess.startedAt, frozenElapsed: null,
        ccPid,
      });
      break;
    }

    case "PostToolUse": {
      const toolName = json.tool_name || "";
      const durationMs = json.duration_ms;
      sess.activeToolCount = Math.max(0, (sess.activeToolCount || 1) - 1);
      const isError = !!(json.tool_response && json.tool_response.isError);
      saveSessionData(sessionId, sess);
      if (isError) {
        await sendToCompanion({
          id: sessionId, type: "update",
          project, status: "error", detail: toolName,
          prompt: sess.prompt || "", startedAt: sess.startedAt, frozenElapsed: null,
          ccPid,
        });
      } else if (sess.activeToolCount === 0 && sess.inAgent) {
        await sendToCompanion({
          id: sessionId, type: "update",
          project, status: "thinking", detail: "",
          prompt: sess.prompt || "", startedAt: sess.startedAt, frozenElapsed: null,
          ccPid,
        });
      }
      break;
    }

    case "PermissionRequest": {
      const toolName = json.tool_name || "";
      saveSessionData(sessionId, sess);
      await sendToCompanion({
        id: sessionId, type: "update",
        project, status: "waiting", detail: toolName,
        prompt: sess.prompt || "", startedAt: sess.startedAt, frozenElapsed: null,
        ccPid,
      });
      break;
    }

    case "Stop": {
      sess.inAgent = false;
      if (sess.startedAt != null) sess.frozenElapsed = Date.now() - sess.startedAt;
      saveSessionData(sessionId, sess);
      await sendToCompanion({
        id: sessionId, type: "update",
        project, status: "done", detail: "",
        prompt: sess.prompt || "", startedAt: sess.startedAt, frozenElapsed: sess.frozenElapsed,
        ccPid,
      });
      deleteSessionData(sessionId);
      break;
    }

    // Ctrl+C / abnormal termination — show interrupted until the next event overrides it
    case "StopFailure": {
      sess.inAgent = false;
      if (sess.startedAt != null) sess.frozenElapsed = Date.now() - sess.startedAt;
      saveSessionData(sessionId, sess);
      await sendToCompanion({
        id: sessionId, type: "update",
        project, status: "error", detail: "interrupted",
        prompt: sess.prompt || "", startedAt: sess.startedAt, frozenElapsed: sess.frozenElapsed,
        ccPid,
      });
      deleteSessionData(sessionId);
      break;
    }

    case "SessionEnd": {
      const reason = json.reason || "(none)";
      log(`SessionEnd reason=${reason} session=${sessionId}`);
      // 对所有 reason 执行 remove(clear/resume/logout/prompt_input_exit/other)
      await sendToCompanion({
        id: sessionId, type: "remove",
      });
      // 删除 session 数据(复用 Stop 逻辑)
      deleteSessionData(sessionId);
      break;
    }

    default: {
      log(`unhandled hook event: ${event}`);
    }
  }
}

// ── Read all of stdin ───────────────────────────────────────────────────
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(""); return; }
    let data = "";
    let settled = false;
    // 兜底定时器要在 stdin 正常结束时清掉,否则一次性进程会被挂满 5s 才退出
    const done = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(data); } };
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", done);
    // Safety timeout — 5s should be ample for hook JSON (typically < 1KB)
    const timer = setTimeout(() => { if (data) done(); else { settled = true; resolve(""); } }, 5000);
  });
}

// ── CLI mode: traditional subcommands ───────────────────────────────────
async function handleCli(cmd, args, state) {
  // Resolve session ID for CLI mode (manual invocations)
  const cliSessionId = process.env.CLAUDE_CODE_SESSION_ID
    || randomUUID().slice(0, 8);

  switch (cmd) {
    // ── Visibility ──────────────────────────────────────────────────
    case "on": case "enable": {
      state.enabled = true;
      writeState(state); writePref(state);
      const ok = await ensureCompanion();
      console.log(ok ? "Island enabled" : "Island enabled (companion start failed — 查看 ~/.claude/claude-island.log;若含 'WebView2' 字样,需安装 WebView2 Runtime: https://developer.microsoft.com/en-us/microsoft-edge/webview2/)");
      break;
    }
    case "off": case "disable": {
      state.enabled = false;
      writeState(state); writePref(state);
      await sendToCompanion({ id: cliSessionId, type: "remove" });
      console.log("Island disabled");
      break;
    }
    case "toggle": {
      state.enabled = !state.enabled;
      writeState(state); writePref(state);
      if (state.enabled) {
        const ok = await ensureCompanion();
        console.log(ok ? "Island enabled" : "Island enabled (companion start failed — 查看 ~/.claude/claude-island.log;若含 'WebView2' 字样,需安装 WebView2 Runtime: https://developer.microsoft.com/en-us/microsoft-edge/webview2/)");
      } else {
        await sendToCompanion({ id: cliSessionId, type: "remove" });
        console.log("Island disabled");
      }
      break;
    }

    // ── Scale ───────────────────────────────────────────────────────
    case "scale": {
      const next = args[1];
      if (!next || !isScale(next)) {
        console.log("Usage: bridge.mjs scale <small|medium|large|xlarge>");
        console.log("Current: " + state.scale); break;
      }
      state.scale = next;
      writeState(state); writePref(state);
      await sendToCompanion({ id: "config", type: "scale", scale: next });
      console.log("Island size → " + next);
      break;
    }

    // ── Screen ──────────────────────────────────────────────────────
    case "screen": {
      const next = args[1];
      if (!next) { console.log("Current screen: " + state.screen); break; }
      state.screen = next;
      writeState(state); writePref(state);
      await forceKillCompanion();
      if (state.enabled) await ensureCompanion();
      console.log("Island screen → " + next);
      break;
    }

    // ── Theme ────────────────────────────────────────────────────────
    case "theme": {
      const next = args[1];
      if (!next || !["dark", "pink", "auto"].includes(next)) {
        console.log("Usage: bridge.mjs theme <dark|pink|auto>");
        console.log("Current: " + (state.theme || "dark")); break;
      }
      state.theme = next;
      writeState(state); writePref(state);
      await sendToCompanion({ id: cliSessionId, type: "theme", theme: next });
      console.log("Island theme → " + next);
      break;
    }

    // ── Reload ──────────────────────────────────────────────────────
    case "reload": case "reset": {
      await forceKillCompanion();
      if (state.enabled) await ensureCompanion();
      console.log("Island reloaded");
      break;
    }

    // ── Kill ────────────────────────────────────────────────────────
    case "kill": {
      await sendToCompanion({ id: cliSessionId, type: "remove" });
      await forceKillCompanion();
      console.log("Island killed");
      break;
    }

    // ── Status ──────────────────────────────────────────────────────
    case "status": {
      console.log(JSON.stringify(state, null, 2));
      break;
    }

    // ── Init ─────────────────────────────────────────────────────────
    case "init": {
      state.project = args[1] || basename(process.cwd());
      writeState(state); writePref(state);
      const ok = await ensureCompanion();
      console.log(ok
        ? "Island initialized (project: " + state.project + ")"
        : "Island init: companion start failed — check ~/.claude/claude-island.log");
      break;
    }

    // ── Debug: eval JS in island window ──────────────────────────────
    case "eval": {
      const js = args.slice(1).join(" ");
      if (!js) { console.log("Usage: bridge.mjs eval <javascript>"); break; }
      const ok = await sendToCompanion({ id: "debug", type: "eval", js });
      console.log(ok ? "eval sent" : "eval failed");
      break;
    }

    default: {
      console.log("Unknown command: " + cmd + " — try: bridge.mjs help");
      process.exitCode = 1;
    }
  }
}

// ── Help ────────────────────────────────────────────────────────────────
function showHelp() {
  console.log("Claude Island Bridge");
  console.log("  hook                     Read stdin JSON from CC hook (auto-detected)");
  console.log("  init [project]           Initialise state + start companion");
  console.log("  on | off | toggle        Visibility control");
  console.log("  scale <small|medium|large|xlarge>  Size preset");
  console.log("  screen <primary|active|N>  Choose display");
  console.log("  theme <dark|pink|auto>  Color theme");
  console.log("  reload                   Restart companion");
  console.log("  kill                     Kill companion");
  console.log("  status                   Show current state");
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "help") { showHelp(); return; }

  // Hook mode: "hook" subcommand or stdin has data
  if (cmd === "hook" || (!process.stdin.isTTY && cmd !== "eval")) {
    const raw = await readStdin();
    if (raw && raw.trim()) {
      try {
        const json = JSON.parse(raw);
        if (json.hook_event_name) {
          await handleHook(json);
          return;
        }
      } catch (e) { log(`stdin JSON parse failed: ${e.message}`); }
    }
    // If stdin JSON failed but cmd is "hook", bail
    if (cmd === "hook") {
      log("hook mode: no valid JSON on stdin");
      return;
    }
    // Otherwise fall through to CLI mode
  }

  // CLI mode
  const state = readState();
  await handleCli(cmd, args, state);
}

main().catch((e) => {
  log(`fatal: ${e.message}`);
  console.error(e);
  process.exit(1);
});
