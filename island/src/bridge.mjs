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
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { SOCK } from "./socket-path.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPANION = join(HERE, "companion.mjs");
const PREF_DIR  = join(homedir(), ".claude");
const STATE_FILE = join(PREF_DIR, "claude-island-state.json");
const PREF_FILE  = join(PREF_DIR, "claude-island.json");
const PID_FILE   = join(PREF_DIR, "claude-island.pid");

// ── Logging ────────────────────────────────────────────────────────────
function log(msg) { console.error(`[bridge] ${msg}`); }

// ── Scale presets ───────────────────────────────────────────────────────
const SCALES = ["small", "medium", "large", "xlarge"];
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

function writeState(s) {
  try {
    if (!existsSync(PREF_DIR)) mkdirSync(PREF_DIR, { recursive: true });
    let prev = {};
    try { prev = JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch {}
    if (prev && prev._activeSessionId) s._activeSessionId = prev._activeSessionId;
    writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
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

// ── Terminal detection for focus-button feature ─────────────────────
let _terminalInfo = null;
function getTerminalInfo() {
  if (_terminalInfo) return _terminalInfo;
  const info = {
    termType: "generic",
    termPpid: process.ppid,
    termPid: process.ppid, // resolved below to the actual terminal process PID
    tabIndex: -1,           // Windows Terminal tab index (0-based)
  };

  // WezTerm: WEZTERM_PANE env var
  if (process.env.WEZTERM_PANE) {
    info.termType = "wezterm";
    info.termId = process.env.WEZTERM_PANE;
  }
  // Windows Terminal: WT_SESSION env var
  else if (process.env.WT_SESSION) {
    info.termType = "windows-terminal";
    info.termId = process.env.WT_SESSION;
  }
  // VSCode integrated terminal
  else if (process.env.TERM_PROGRAM === "vscode") {
    info.termType = "vscode";
  }
  // Git Bash / MSYS2 / Cygwin (mintty): MSYSTEM or TERM=xterm are definitive
  else if (process.env.MSYSTEM || process.env.TERM === "xterm") {
    info.termType = "git-bash";
  }
  // CMD: PROMPT is set to $P$G by default; PowerShell does not set it.
  // Must be checked BEFORE PSModulePath because PSModulePath is a
  // system-wide env var that CMD inherits when PowerShell is installed.
  else if (process.env.PROMPT) {
    info.termType = "cmd";
  }
  // PowerShell: PSModulePath is always set by both 5.1 and 7+
  else if (process.env.PSModulePath) {
    info.termType = "powershell";
  }

  // Walk process tree from our own PID up to find the terminal process.
  // This PID stays valid (unlike process.ppid which may be a short-lived
  // hook shell that exits before the user clicks the focus button).
	  if (process.platform === "win32") {
	    try {
	      let pid = null;

	      // For WezTerm and Windows Terminal, the shell (cmd/powershell) runs
	      // inside the terminal emulator as a child process.  Walking up from
	      // process.ppid would stop at the shell and miss the actual terminal
	      // window process.  Search by process name directly instead.
	      if (info.termType === "wezterm") {
	        const out = execSync(
	          `powershell -NoProfile -Command "(Get-Process -Name wezterm-gui -EA SilentlyContinue | Select-Object -First 1).Id"`,
	          { timeout: 3000, stdio: "pipe", windowsHide: true }
	        ).toString().trim();
	        if (out && /^\d+$/.test(out)) pid = parseInt(out, 10);
	      } else if (info.termType === "windows-terminal") {
	        // Walk process tree from PowerShell's own $PID up to WindowsTerminal.exe.
	        // $PID (not process.ppid) is used because ppid may be a short-lived hook
	        // shell that has already exited.
	        const walkOut = execSync(
	          `powershell -NoProfile -Command "$p=$PID;$found=$null;while($p -and $p -gt 4){$proc=Get-CimInstance Win32_Process -Filter \"ProcessId=$p\" -EA SilentlyContinue;if(-not $proc){break};if($proc.Name -eq 'WindowsTerminal.exe'){$found=$p;break};$p=$proc.ParentProcessId};$found"`,
	          { timeout: 5000, stdio: "pipe", windowsHide: true }
	        ).toString().trim();
	        if (walkOut && /^\d+$/.test(walkOut)) {
	          pid = parseInt(walkOut, 10);
	        } else {
	          // ConPTY may have broken the parent chain; fall back to first WT window by name.
	          // In multi-WT-window setups this may activate the wrong window.
	          log("WT pid: process tree walk failed, falling back to Get-Process by name (multi-window may focus wrong window)");
	          const fbOut = execSync(
	            `powershell -NoProfile -Command "(Get-Process -Name WindowsTerminal -EA SilentlyContinue | Select-Object -First 1).Id"`,
	            { timeout: 3000, stdio: "pipe", windowsHide: true }
	          ).toString().trim();
	          if (fbOut && /^\d+$/.test(fbOut)) pid = parseInt(fbOut, 10);
	        }
        // Detect which tab we are in: list WT children, walk up from ppid.
        // Child index ≈ tab index because WT spawns shells in tab order.
        try {
          if (!pid) throw new Error("wt pid not found for tab detection");
          const tabOut = execSync(
            `powershell -NoProfile -Command "$wtPid=${pid};$children=@(Get-CimInstance Win32_Process -Filter \\"ParentProcessId=$wtPid\\"| Where-Object {$_.Name -match '^(cmd|powershell|pwsh|wsl|bash)\\.exe$'}| Sort-Object CreationDate| Select-Object -ExpandProperty ProcessId);$p=${process.ppid};$idx=-1;while($p -gt 0){for($i=0;$i -lt $children.Count;$i++){if($children[$i] -eq $p){$idx=$i;break}};if($idx -ge 0){break};try{$p=(Get-CimInstance Win32_Process -Filter \\"ProcessId=$p\\" -EA Stop).ParentProcessId}catch{break}};$idx"`,
            { timeout: 5000, stdio: "pipe", windowsHide: true }
          ).toString().trim();
          const tabIdx = parseInt(tabOut);
          if (!isNaN(tabIdx) && tabIdx >= 0) info.tabIndex = tabIdx;
        } catch (e) { log(`tabIndex detection: ${e.message}`); }

	      } else {
	        // CMD / PowerShell / Git Bash / VSCode — walk process tree up from ppid
	        const out = execSync(
	          `powershell -NoProfile -Command "$p=${process.ppid};while($p){$n=(Get-Process -Id $p -EA SilentlyContinue).ProcessName;if($n -match '^(cmd|powershell|pwsh|mintty|Code|conhost)$'){$p;break};try{$p=(Get-CimInstance Win32_Process -Filter \"ProcessId=$p\" -EA Stop).ParentProcessId}catch{break}}"`,
	          { timeout: 3000, stdio: "pipe", windowsHide: true }
	        ).toString().trim();
	        if (out && /^\d+$/.test(out)) pid = parseInt(out, 10);
	      }

	      if (pid && pid > 0) info.termPid = pid;
	    } catch { /* keep termPid = process.ppid as fallback */ }
	  }


  _terminalInfo = info;
  log(`terminal: type=${info.termType} id=${info.termId || 'none'} termPid=${info.termPid} ppid=${info.termPpid}`);
  return info;
}

// ── Socket helpers ──────────────────────────────────────────────────────
function connectOnce() {
  return new Promise((resolve) => {
    const s = connect(SOCK);
    let settled = false;
    s.once("connect", () => { settled = true; resolve(s); });
    s.once("error", (err) => {
      if (!settled) { settled = true; log(`connectOnce error: ${err.code || err.message}`); resolve(null); }
    });
    setTimeout(() => {
      if (!settled) { settled = true; log("connectOnce timeout"); try { s.destroy(); } catch {} resolve(null); }
    }, 2000);
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
    const data = existsSync(STATE_FILE)
      ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
    if (!data || typeof data !== "object") return;
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
    writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  } catch {}
}

// ── Hook mode: read stdin JSON, dispatch by hook_event_name ─────────────
async function handleHook(json) {
  const event = json.hook_event_name;
  const sessionId = json.session_id || "unknown";
  const cwd = json.cwd || process.cwd();
  const state = readState(); // global prefs only (enabled, scale, etc.)
  const sess = getSessionData(sessionId);

  log(`hook event=${event} session=${sessionId} cwd=${cwd}`);

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
        ...getTerminalInfo(),
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
        ...getTerminalInfo(),
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
          ...getTerminalInfo(),
        });
      } else if (sess.activeToolCount === 0 && sess.inAgent) {
        await sendToCompanion({
          id: sessionId, type: "update",
          project, status: "thinking", detail: "",
          prompt: sess.prompt || "", startedAt: sess.startedAt, frozenElapsed: null,
          ...getTerminalInfo(),
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
        ...getTerminalInfo(),
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
        ...getTerminalInfo(),
      });
      await sendToCompanion({ id: sessionId, type: "done-retract", delayMs: 30000 });
      try {
        if (existsSync(STATE_FILE)) {
          const data = JSON.parse(readFileSync(STATE_FILE, "utf8"));
          if (data && data._sessionData && data._sessionData[sessionId]) {
            delete data._sessionData[sessionId];
            writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
          }
        }
      } catch {}
      break;
    }

    // Ctrl+C / abnormal termination — show interrupted briefly then remove
    case "StopFailure": {
      sess.inAgent = false;
      if (sess.startedAt != null) sess.frozenElapsed = Date.now() - sess.startedAt;
      saveSessionData(sessionId, sess);
      await sendToCompanion({
        id: sessionId, type: "update",
        project, status: "error", detail: "interrupted",
        prompt: sess.prompt || "", startedAt: sess.startedAt, frozenElapsed: sess.frozenElapsed,
        ...getTerminalInfo(),
      });
      await sendToCompanion({ id: sessionId, type: "done-retract", delayMs: 30000 });
      try {
        if (existsSync(STATE_FILE)) {
          const data = JSON.parse(readFileSync(STATE_FILE, "utf8"));
          if (data && data._sessionData && data._sessionData[sessionId]) {
            delete data._sessionData[sessionId];
            writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
          }
        }
      } catch {}
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
    const done = () => { if (!settled) { settled = true; resolve(data); } };
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", done);
    // Safety timeout — 5s should be ample for hook JSON (typically < 1KB)
    setTimeout(() => { if (data) done(); else { settled = true; resolve(""); } }, 5000);
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
      console.log(ok ? "Island enabled" : "Island enabled (companion start failed — check log)");
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
        console.log(ok ? "Island enabled" : "Island enabled (companion start failed — check log)");
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
