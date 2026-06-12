#!/usr/bin/env node
// island-test.mjs — 灵动岛功能验证脚本
// 模拟 Claude Code hooks stdin JSON，验证 bridge + companion + 渲染逻辑
// Usage: node island-test.mjs

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, createServer } from "node:net";
import { createInterface } from "node:readline";
import { SOCK } from "./socket-path.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(HERE, "bridge.mjs");
const STATE = join(homedir(), ".claude", "claude-island-state.json");
const LOG_FILE = join(homedir(), ".claude", "claude-island.log");
let passed = 0, failed = 0;
let SUITE_SOCK = ""; // 套件级假 companion 端口,main() 启动时赋值

function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

function runBridge(stdinJson, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE, "hook"], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      env: { ...process.env, HOME: homedir(), CLAUDE_ISLAND_SOCK: SUITE_SOCK, ...(extraEnv || {}) },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => { resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }); });
    child.stdin.write(stdinJson);
    child.stdin.end();
  });
}

function readState() {
  try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return {}; }
}

// 起一个假 companion(127.0.0.1 临时端口),收集 bridge 发来的消息。
// 经 CLAUDE_ISLAND_SOCK=<纯数字端口> 覆盖,直接演练生产同款 TCP 代码路径。
async function withFakeCompanion(fn) {
  const messages = [];
  const server = createServer((sock) => {
    const rl = createInterface({ input: sock, crlfDelay: Infinity });
    rl.on("line", (line) => { try { messages.push(JSON.parse(line)); } catch {} });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const sockEnv = String(server.address().port);
  try { await fn(sockEnv, messages); } finally { server.close(); }
  return messages;
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Test suite ──────────────────────────────────────────────────────────
async function main() {
  console.log("=== 灵动岛功能测试 ===\n");

  // 套件级假 companion:所有 bridge 默认指向它,测试不打扰真实灵动岛
  // (此前测试行会真实出现在用户屏幕上,bridge 失连时还会 spawn companion 重启真实 host)
  const suiteServer = createServer((sock) => { sock.resume(); });
  await new Promise((r) => suiteServer.listen(0, "127.0.0.1", r));
  SUITE_SOCK = String(suiteServer.address().port);

  // Clean up previous state
  try { unlinkSync(STATE); } catch {}
  await sleep(200);

  // ── Test 0: 全源文件语法门禁 ─────────────────────────────────────────
  console.log("0. 源文件语法检查 (node --check)");
  for (const f of readdirSync(HERE).filter((n) => n.endsWith(".mjs"))) {
    const r = spawnSync(process.execPath, ["--check", join(HERE, f)], {
      encoding: "utf8", windowsHide: true,
    });
    assert(r.status === 0, `${f} 语法合法${r.status === 0 ? "" : " — " + (r.stderr || "").split("\n").slice(0, 2).join(" ")}`);
  }

  // ── Test 0.5: bridge 退出延迟 ────────────────────────────────────────
  // 回归保护:残留定时器(readStdin 5s / connectOnce 2s)会把一次性进程挂住
  console.log("\n0.5 bridge 退出延迟");
  const t0 = Date.now();
  await runBridge(JSON.stringify({
    session_id: "perf-probe", cwd: "/tmp/perf",
    hook_event_name: "SessionEnd", reason: "other",
  }));
  const bridgeMs = Date.now() - t0;
  assert(bridgeMs < 3000, `单次 hook 调用 ${bridgeMs}ms < 3000ms`);

  // ── Test 1: Basic hook dispatch ──────────────────────────────────────
  console.log("1. Hook 事件分派");
  const r1 = await runBridge(JSON.stringify({
    session_id: "test-basic", cwd: "/home/test/proj",
    hook_event_name: "UserPromptSubmit", prompt: "Hello 世界",
  }));
  assert(r1.stderr.includes('prompt="Hello 世界"'), "UserPromptSubmit 解析 prompt");
  assert(r1.stderr.includes('project="proj"'), "从 cwd 提取项目名");

  // ── Test 2: Per-session isolation ────────────────────────────────────
  console.log("\n2. 跨 session 数据隔离");
  await runBridge(JSON.stringify({
    session_id: "sess-a", cwd: "/home/a", hook_event_name: "UserPromptSubmit", prompt: "Prompt A",
  }));
  await runBridge(JSON.stringify({
    session_id: "sess-b", cwd: "/home/b", hook_event_name: "UserPromptSubmit", prompt: "Prompt B",
  }));
  const state = readState();
  assert(state._sessionData["sess-a"]?.prompt === "Prompt A", "Session A prompt 隔离");
  assert(state._sessionData["sess-b"]?.prompt === "Prompt B", "Session B prompt 隔离");
  assert(state._sessionData["sess-a"]?.project === "a", "Session A project 隔离");
  assert(state._sessionData["sess-b"]?.project === "b", "Session B project 隔离");

  // ── Test 3: Stop cleanup ─────────────────────────────────────────────
  console.log("\n3. Stop 事件清理");
  await runBridge(JSON.stringify({
    session_id: "sess-a", cwd: "/home/a", hook_event_name: "Stop",
  }));
  const state2 = readState();
  assert(!state2._sessionData?.["sess-a"], "Stop 后 sess-a 数据已清理");
  assert(state2._sessionData?.["sess-b"], "sess-b 数据仍保留");

  // ── Test 4: Tool name normalization ───────────────────────────────────
  console.log("\n4. 工具名规范化");
  const r4 = await runBridge(JSON.stringify({
    session_id: "sess-b", cwd: "/home/b",
    hook_event_name: "PreToolUse",
    tool_name: "mcp__db-query__query_mysql",
    tool_input: { sql: "SELECT 1" },
  }));
  assert(r4.stderr.includes("session=sess-b"), "MCP tool session 正确");

  // ── Test 5: Chinese/Unicode prompt ────────────────────────────────────
  console.log("\n5. 中文/Unicode prompt");
  const r5 = await runBridge(JSON.stringify({
    session_id: "sess-c", cwd: "/home/c",
    hook_event_name: "UserPromptSubmit",
    prompt: "修复登录页面 🐛 bug — 用户无法使用微信登录",
  }));
  assert(r5.stderr.includes('project="c"'), "Unicode prompt 不破坏 JSON");

  // ── Test 6: Empty prompt ─────────────────────────────────────────────
  console.log("\n6. 空 prompt 处理");
  const r6 = await runBridge(JSON.stringify({
    session_id: "sess-d", cwd: "/home/d", hook_event_name: "UserPromptSubmit", prompt: "",
  }));
  assert(r6.stderr.includes('prompt=""'), "空 prompt 不崩溃");

  // ── Test 7: PostToolUse error ────────────────────────────────────────
  console.log("\n7. PostToolUse 错误处理");
  const r7 = await runBridge(JSON.stringify({
    session_id: "sess-e", cwd: "/home/e",
    hook_event_name: "UserPromptSubmit", prompt: "test",
  }));
  await runBridge(JSON.stringify({
    session_id: "sess-e", cwd: "/home/e",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_response: { isError: true },
  }));
  const state7 = readState();
  assert(state7._sessionData["sess-e"]?.activeToolCount === 0, "错误后 toolCount 归零");

  // ── Test 8: Stale session pruning ────────────────────────────────────
  console.log("\n8. 过期 session 清理");
  // Inject a stale session directly
  const oldState = readState();
  oldState._sessionData["old-sess"] = { project: "old", lastActivity: Date.now() - 700000, prompt: "stale" };
  writeFileSync(STATE, JSON.stringify(oldState, null, 2));
  // Trigger pruning by running a new hook
  await runBridge(JSON.stringify({
    session_id: "new-sess", cwd: "/home/new", hook_event_name: "UserPromptSubmit", prompt: "new",
  }));
  const state8 = readState();
  assert(!state8._sessionData?.["old-sess"], "过期 session (10min+) 被清理");

  // ── Test 8.5: 状态文件损坏自愈 ──────────────────────────────────────
  // 真实事故:多 bridge 并发写导致文件尾部残留垃圾,JSON.parse 永远失败,
  // saveSessionData 静默放弃 → prompt/计时全部丢失且永不恢复
  console.log("\n8.5 状态文件损坏自愈");
  writeFileSync(STATE, '{"_sessionData":{"x":{}}}ozenElapsed": 357587}}');
  await runBridge(JSON.stringify({
    session_id: "sess-heal", cwd: "/home/heal", hook_event_name: "UserPromptSubmit", prompt: "heal",
  }));
  const stateHeal = readState();
  assert(stateHeal._sessionData?.["sess-heal"]?.prompt === "heal", "损坏的 state 文件被自愈重建");

  // ── Test 9: deadRowIds 纯函数 ────────────────────────────────────────
  console.log("\n9. deadRowIds 纯函数(探活逻辑)");
  // 动态导入 liveness.mjs
  const { deadRowIds } = await import("./liveness.mjs");

  const pids = new Map([["a", 100], ["b", 200], ["c", 300]]);
  const fakeIsAlive = (pid) => pid !== 200;  // 200 已死
  const dead = deadRowIds(pids, fakeIsAlive);

  assert(dead.length === 1, "deadRowIds 返回1个死 id");
  assert(dead[0] === "b", "deadRowIds 正确识别 pid=200 对应 id=b");

  // 边界: 空 Map
  assert(deadRowIds(new Map(), fakeIsAlive).length === 0, "空 Map 返回空数组");

  // 边界: 全活
  const allAlive = new Map([["x", 1], ["y", 2]]);
  assert(deadRowIds(allAlive, () => true).length === 0, "全活返回空数组");

  // pid 从未被观测到存活(一次性 cmd /c 包装进程,如 cmd 宿主的 CC hook):
  // 不可凭 pid 判死,近期仍有更新的行必须保留
  {
    const pids = new Map([["cmd-row", 999]]);
    const lastUpdate = new Map([["cmd-row", 1000000]]);
    const fresh = deadRowIds(pids, () => false, {
      seenAlive: new Set(), lastUpdate, now: 1000000 + 60000, graceMs: 300000,
    });
    assert(fresh.length === 0, "pid 从未存活+近期有更新 → 行保留(cmd 宿主误删回归)");
    const stale = deadRowIds(pids, () => false, {
      seenAlive: new Set(), lastUpdate, now: 1000000 + 600000, graceMs: 300000,
    });
    assert(stale.length === 1 && stale[0] === "cmd-row", "pid 从未存活+静默超限 → 行移除");
  }
  // pid 曾被观测到存活后死亡(终端真关了) → 立即移除,不等静默期
  {
    const pids = new Map([["wsl-row", 888]]);
    const seenAlive = new Set(["wsl-row"]);
    const lastUpdate = new Map([["wsl-row", 1000000]]);
    const d = deadRowIds(pids, () => false, {
      seenAlive, lastUpdate, now: 1000000 + 1000, graceMs: 300000,
    });
    assert(d.length === 1 && d[0] === "wsl-row", "曾存活的 pid 死亡 → 立即移除");
  }
  // 探活将存活 pid 记入 seenAlive(供下次判定)
  {
    const pids = new Map([["live-row", 777]]);
    const seenAlive = new Set();
    deadRowIds(pids, () => true, { seenAlive, lastUpdate: new Map(), now: 0, graceMs: 1 });
    assert(seenAlive.has("live-row"), "存活 pid 被记入 seenAlive");
  }

  // ── Test 10: SessionEnd 即时摘行 ───────────────────────────────────
  console.log("\n10. SessionEnd hook 处理");

  await runBridge(JSON.stringify({
    session_id: "sess-end", cwd: "/home/end",
    hook_event_name: "UserPromptSubmit", prompt: "will end",
  }));
  const stateBefore = readState();
  assert(stateBefore._sessionData["sess-end"], "sess-end 会话已创建");

  // 触发 SessionEnd
  await runBridge(JSON.stringify({
    session_id: "sess-end", cwd: "/home/end",
    hook_event_name: "SessionEnd", reason: "prompt_input_exit",
  }));

  const stateAfter = readState();
  assert(!stateAfter._sessionData?.["sess-end"], "SessionEnd 后 session 数据已删除");

  // ── Test 12: windowSize 纯函数(scale 感知窗口尺寸) ───────────────────
  console.log("\n12. windowSize 纯函数");
  const { windowSize, SCALES: SC, ROW_W, ROW_H, HANDLE_H, WIN_MARGIN } = await import("./scales.mjs");
  assert(windowSize(0, false, "medium").h === 0, "空态高度为 0(隐藏语义)");
  {
    const m2 = windowSize(2, false, "medium");
    assert(m2.h === 2 * ROW_H + HANDLE_H, `medium 2行高度 = ${2 * ROW_H + HANDLE_H} (实际 ${m2.h})`);
    assert(m2.w === ROW_W + WIN_MARGIN, "medium 宽度 = 行宽+边距");
  }
  {
    const xl = windowSize(1, false, "xlarge");
    assert(xl.w === Math.ceil((ROW_W + WIN_MARGIN) * SC.xlarge), "xlarge 宽度按 1.35 放大(修宽度裁剪缺陷)");
    assert(xl.h === Math.ceil(ROW_H * SC.xlarge) + Math.ceil(HANDLE_H * SC.xlarge), "xlarge 高度按 1.35 放大");
  }
  assert(windowSize(3, true, "medium").h === HANDLE_H, "收起态只剩手柄高度");
  assert(windowSize(1, false, "bogus").w === ROW_W + WIN_MARGIN, "未知 scale 回退 medium");

  // ── Test 13: SOCK env 覆盖(fake companion 收到 update) ───────────────
  console.log("\n13. SOCK env 覆盖 + fake companion");
  const msgs13 = await withFakeCompanion(async (pipe) => {
    await runBridge(JSON.stringify({
      session_id: "sess-fake", cwd: "/home/fake",
      hook_event_name: "UserPromptSubmit", prompt: "fake pipe",
    }), { CLAUDE_ISLAND_SOCK: pipe });
    await sleep(300);
  });
  const upd13 = msgs13.find((m) => m.type === "update" && m.id === "sess-fake");
  assert(!!upd13, "bridge 经 env 覆盖管道送达 update");
  assert(upd13?.prompt === "fake pipe", "update 内容正确");

  // ── Test 13.5: 并发 hook 不丢消息(EADDRINUSE 风暴回归) ───────────────
  // 真实事故:多会话并发 hook 时命名管道 connect 瞬时失败,update 被丢、
  // bridge 反复 spawn 注定 EADDRINUSE 的 companion;TCP 回环无此问题
  console.log("\n13.5 并发 hook 不丢消息");
  const CONC = 12;
  const msgsConc = await withFakeCompanion(async (sockEnv) => {
    await Promise.all(Array.from({ length: CONC }, (_, i) => runBridge(JSON.stringify({
      session_id: "conc-" + i, cwd: "/home/conc",
      hook_event_name: "UserPromptSubmit", prompt: "p" + i,
    }), { CLAUDE_ISLAND_SOCK: sockEnv })));
    await sleep(500);
  });
  const concIds = new Set(msgsConc.filter((m) => m.type === "update").map((m) => m.id));
  assert(concIds.size === CONC, `${CONC} 路并发 update 全部送达 (实收 ${concIds.size})`);
  let concStateOk = true;
  try { JSON.parse(readFileSync(STATE, "utf8")); } catch { concStateOk = false; }
  assert(concStateOk, "并发写后 state 文件仍为合法 JSON(原子写回归)");

  // ── Test 14: UserPromptSubmit 带 captureFg,工具事件不带 ─────────────
  console.log("\n14. captureFg 标志");
  const msgs14 = await withFakeCompanion(async (pipe) => {
    await runBridge(JSON.stringify({
      session_id: "sess-fg", cwd: "/home/fg",
      hook_event_name: "UserPromptSubmit", prompt: "capture me",
    }), { CLAUDE_ISLAND_SOCK: pipe });
    await runBridge(JSON.stringify({
      session_id: "sess-fg", cwd: "/home/fg",
      hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/a.txt" },
    }), { CLAUDE_ISLAND_SOCK: pipe });
    await sleep(300);
  });
  const prompt14 = msgs14.find((m) => m.type === "update" && m.status === "thinking" && m.prompt === "capture me");
  const tool14 = msgs14.find((m) => m.type === "update" && m.status === "reading");
  assert(prompt14?.captureFg === true, "UserPromptSubmit update 带 captureFg:true");
  assert(tool14 && tool14.captureFg === undefined, "PreToolUse update 不带 captureFg");

  // ── Test 14.5: enabled=false 时 hook 静默(/island off 语义) ──────────
  console.log("\n14.5 enabled=false 时 hook 静默");
  writeFileSync(STATE, JSON.stringify({ enabled: false }));
  const msgs145 = await withFakeCompanion(async (sockEnv) => {
    await runBridge(JSON.stringify({
      session_id: "sess-off", cwd: "/home/off",
      hook_event_name: "UserPromptSubmit", prompt: "should be silent",
    }), { CLAUDE_ISLAND_SOCK: sockEnv });
    await sleep(300);
  });
  assert(msgs145.length === 0, "off 状态下 hook 不发送任何消息");
  assert(!readState()._sessionData?.["sess-off"], "off 状态下不写 session 数据");
  writeFileSync(STATE, JSON.stringify({ enabled: true }));

  // ── Test 15: host 原生协议(screens / captureFg) ──────────────────────
  console.log("\n15. host 原生协议");
  const { openFixed } = await import("./open-fixed.mjs");
  const w15 = openFixed("<html><body></body></html>", {
    width: 200, height: 60, x: 0, y: 0,
    frameless: true, transparent: true, hidden: true, noDock: true,
  });
  const count15 = await new Promise((resolve) => {
    const to = setTimeout(() => resolve(null), 20000);
    w15.on("ready", () => w15.cmd({ type: "screens" }));
    w15.on("screens", (c) => { clearTimeout(to); resolve(c); });
  });
  assert(typeof count15 === "number" && count15 >= 1, `screens 返回屏数 (${count15})`);
  const fg15 = await new Promise((resolve) => {
    const to = setTimeout(() => resolve(null), 5000);
    w15.on("fg", (m) => { clearTimeout(to); resolve(m); });
    w15.cmd({ type: "captureFg", sid: "t15" });
  });
  assert(fg15 && fg15.sid === "t15" && typeof fg15.hwnd === "number", "captureFg 应答含 sid+hwnd");
  assert(fg15 && typeof fg15.paneId === "string" && typeof fg15.paneClass === "string", "captureFg 应答含 paneId+paneClass(UIA)");
  assert(fg15 && typeof fg15.tabId === "string", "captureFg 应答含 tabId(跨 tab 跳转)");
  assert(fg15 && typeof fg15.winClass === "string", "captureFg 应答含 winClass(hwnd 复用防错跳)");
  w15.close();
  await sleep(300);

  // ── Results ───────────────────────────────────────────────────────────
  console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
