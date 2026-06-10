#!/usr/bin/env node
// island-e2e.mjs — 真实桌面 E2E 自驱回路(Windows node 运行,会动鼠标!)
// 验证:① 点击胶囊行 → 跳转拉起捕获的目标窗口;② 点 × → 行删除、空了整窗隐藏。
// 流程:reload companion → 起 notepad(前台) → 发 captureFg update(companion 捕
// 获 notepad HWND) → 最小化 notepad → SendInput 点行 → 断言前台回到 notepad
// → SendInput 点 × → 断言岛窗口高度归零。
// Usage: node.exe island/src/island-e2e.mjs

import { execSync } from "node:child_process";
import { connect } from "node:net";
import { writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SOCK } from "./socket-path.mjs";
import { SCALES, ROW_W, ROW_H } from "./scales.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(HERE, "bridge.mjs");
let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log("  ✓ " + label); }
  else { failed++; console.log("  ✗ " + label); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
let _psSeq = 0;
function ps(script) {
  // -EncodedCommand 会撞 32K 命令行上限,改写临时 .ps1 走 -File(脚本保持纯 ASCII)
  const file = join(tmpdir(), `island-e2e-${process.pid}-${_psSeq++}.ps1`);
  writeFileSync(file, "$ProgressPreference='SilentlyContinue'\n" + script, "utf8");
  try {
    return execSync(`powershell -NoProfile -NoLogo -ExecutionPolicy Bypass -File "${file}"`,
      { encoding: "utf8", timeout: 20000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } finally { try { rmSync(file); } catch {} }
}
function sendMsg(msg) {
  return new Promise((resolve) => {
    const s = connect(SOCK);
    s.on("connect", () => { s.write(JSON.stringify(msg) + "\n"); s.end(); resolve(true); });
    s.on("error", () => resolve(false));
    setTimeout(() => resolve(false), 2000);
  });
}

// Win32 帮手(SendInput 点击 / 前台查询 / 窗口矩形,吸收自原 _dbgclick.ps1)
const WIN32 = String.raw`
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Collections.Generic;
public struct RECT { public int L, T, R, B; }
[StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
[StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; }
public class W {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] p, int cb);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder sb, int n);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  public static string Title(IntPtr h) { var sb = new System.Text.StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  public static long FindTitle(string a, string b) {
    // 后缀匹配:管理员 WT 标题带 "管理员: " 前缀
    long found = 0;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var t = Title(h);
      if (t.EndsWith(a) || t.EndsWith(b)) { found = (long)h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static List<IntPtr> ByPid(uint pid) {
    var r = new List<IntPtr>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) r.Add(h); return true; }, IntPtr.Zero);
    return r;
  }
  public static void Click(int x, int y) {
    int sw = GetSystemMetrics(0), sh = GetSystemMetrics(1);
    var mv = new INPUT[1]; mv[0].type = 0;
    mv[0].mi.dx = (int)(x * 65535.0 / (sw - 1)); mv[0].mi.dy = (int)(y * 65535.0 / (sh - 1));
    mv[0].mi.dwFlags = 0x0001 | 0x8000; SendInput(1, mv, Marshal.SizeOf(typeof(INPUT)));
    System.Threading.Thread.Sleep(150);
    var dn = new INPUT[1]; dn[0].type = 0; dn[0].mi.dwFlags = 0x0002; SendInput(1, dn, Marshal.SizeOf(typeof(INPUT)));
    System.Threading.Thread.Sleep(60);
    var up = new INPUT[1]; up[0].type = 0; up[0].mi.dwFlags = 0x0004; SendInput(1, up, Marshal.SizeOf(typeof(INPUT)));
  }
}
"@
`;
function psW(body) { return ps(WIN32 + "\n" + body); }

function islandRect() {
  const out = psW(String.raw`
$p = Get-Process island-host-win -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $p) { Write-Output "none"; exit }
$best = $null
foreach ($h in [W]::ByPid([uint32]$p.Id)) {
  $r = New-Object RECT; [void][W]::GetWindowRect($h, [ref]$r)
  if (($r.R - $r.L) -gt 200) { $best = $r }
}
if ($best -eq $null) { Write-Output "none" } else { Write-Output "$($best.L),$($best.T),$($best.R),$($best.B)" }`);
  if (out === "none") return null;
  const [l, t, r, b] = out.split(",").map(Number);
  return { l, t, r, b, w: r - l, h: b - t };
}

async function main() {
  console.log("=== 灵动岛 E2E(跳转/×/隐藏) ===\n");
  // 1) 干净 companion
  execSync(`node.exe "${BRIDGE}" reload`, { encoding: "utf8", timeout: 30000 });
  await sleep(1500);

  // 2) 起 notepad 并置前台
  // Win11 的 notepad 是打包应用:启动器 PID 立刻退出再换身,只能按进程名轮询找窗口
  const npHwnd = Number(psW(String.raw`
Start-Process notepad | Out-Null
$h = 0
for ($i = 0; $i -lt 20; $i++) {
  $p = Get-Process -Name notepad, Notepad -ErrorAction SilentlyContinue |
       Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($p) { $h = [int64]$p.MainWindowHandle; break }
  Start-Sleep -Milliseconds 250
}
Write-Output $h`));
  assert(npHwnd > 0, `notepad 启动 (hwnd=${npHwnd})`);
  await sleep(400);
  // 真实输入才能无条件夺前台:SendInput 点 notepad 标题栏
  psW(String.raw`
$r = New-Object RECT; [void][W]::GetWindowRect([IntPtr]${npHwnd}, [ref]$r)
[W]::Click([int](($r.L + $r.R) / 2), $r.T + 15)`);
  await sleep(600);
  const fgNow = Number(psW(`Write-Output ([int64][W]::GetForegroundWindow())`));
  assert(fgNow === npHwnd, `notepad 已置前台 (前台=${fgNow})`);

  // 3) 发 captureFg update(此刻前台= notepad → companion 捕获其 hwnd)
  await sendMsg({
    id: "e2e-jump", type: "update", project: "e2e", status: "waiting",
    detail: "", prompt: "jump-test", startedAt: Date.now(), captureFg: true,
  });
  await sleep(1000);
  // 从 companion 日志确认捕获到的就是 notepad(区分"捕获错"与"聚焦失败")
  let capturedHwnd = 0;
  try {
    const lg = readFileSync(join(homedir(), ".claude", "claude-island.log"), "utf8");
    const m = [...lg.matchAll(/fg captured: e2e-jump → hwnd=(\d+)/g)].pop();
    if (m) capturedHwnd = Number(m[1]);
  } catch {}
  assert(capturedHwnd === npHwnd, `companion 捕获 hwnd=${capturedHwnd} == notepad`);

  // 4) 最小化 notepad,确认前台已不是它
  psW(`[void][W]::ShowWindow([IntPtr]${npHwnd}, 6)`); // SW_MINIMIZE
  await sleep(800);
  const fgAfterMin = Number(psW(`Write-Output ([int64][W]::GetForegroundWindow())`));
  assert(fgAfterMin !== npHwnd, "notepad 已最小化让位");

  // 5) 点击行中部偏左(避开 × 与右侧元信息),行任意非 × 处 = 跳转
  const rect = islandRect();
  assert(!!rect && rect.h > 10, `岛窗口可见 (${rect ? rect.w + "x" + rect.h : "none"})`);
  const f = SCALES.medium;
  const rowCx = Math.round((rect.l + rect.r) / 2 - 100 * f);
  const rowCy = Math.round(rect.t + (ROW_H * f) / 2);
  psW(`[W]::Click(${rowCx}, ${rowCy})`);
  await sleep(1500);
  const fgAfterClick = Number(psW(`Write-Output ([int64][W]::GetForegroundWindow())`));
  assert(fgAfterClick === npHwnd, `点击行跳转拉起 notepad (前台=${fgAfterClick})`);

  // 6) 点 × 删行 → 空了整窗隐藏(高度归零)
  const xCx = Math.round((rect.l + rect.r) / 2 + (ROW_W / 2 - 18) * f); // 行右缘 × 圆心
  psW(`[W]::Click(${xCx}, ${rowCy})`);
  await sleep(1200);
  const rect2 = islandRect();
  assert(!rect2 || rect2.h <= 10, `× 删行后窗口隐藏 (h=${rect2 ? rect2.h : "gone"})`);

  // 7) 清理
  try { ps(`Stop-Process -Name notepad, Notepad -Force -ErrorAction SilentlyContinue`); } catch {}
  await sendMsg({ id: "e2e-jump", type: "remove" });

  // ── 场景 2: Windows Terminal 双 pane,pane 级聚焦 ─────────────────────
  // WT 窗口标题恒等于当前聚焦 pane 的标题(cmd 用 title 各自命名)——
  // 标题即「焦点在哪个 pane」的现成断言器。
  console.log("\n— 场景 2: WT 双 pane,pane 级聚焦 —");
  ps(String.raw`Start-Process wt -ArgumentList '-w -1 nt cmd /k "title paneA" ; sp -V cmd /k "title paneB"'`);
  let wtHwnd = 0;
  for (let i = 0; i < 30 && !wtHwnd; i++) {
    await sleep(400);
    wtHwnd = Number(psW(`Write-Output ([W]::FindTitle("paneA","paneB"))`));
  }
  assert(wtHwnd > 0, `WT 双 pane 窗口启动 (hwnd=${wtHwnd})`);
  await sleep(800);
  const [wl, wtTop, wrgt, wbot] = psW(String.raw`
$r = New-Object RECT; [void][W]::GetWindowRect([IntPtr]${wtHwnd}, [ref]$r)
Write-Output "$($r.L),$($r.T),$($r.R),$($r.B)"`).split(",").map(Number);
  const midY = Math.round(wtTop + (wbot - wtTop) * 0.6);
  // 点左 pane → 焦点落 paneA
  psW(`[W]::Click(${Math.round(wl + (wrgt - wl) * 0.25)}, ${midY})`);
  await sleep(600);
  assert(psW(`Write-Output ([W]::Title([IntPtr]${wtHwnd}))`).endsWith("paneA"), "左 pane(paneA) 已聚焦");
  // captureFg:此刻焦点 = paneA 的 TermControl
  await sendMsg({ id: "e2e-pane", type: "update", project: "e2e-pane", status: "waiting",
                  detail: "", prompt: "pane-jump", startedAt: Date.now(), captureFg: true });
  await sleep(1200);
  let capLine = "";
  try {
    const lg = readFileSync(join(homedir(), ".claude", "claude-island.log"), "utf8");
    capLine = ([...lg.matchAll(/fg captured: e2e-pane → .*$/gm)].pop() || [""])[0];
  } catch {}
  const capM = capLine.match(/hwnd=(\d+) pane=([^#]*)#(.*)$/) || [];
  assert(Number(capM[1]) === wtHwnd && capM[3] && capM[3] !== "-",
    `捕获到 WT pane (class=${capM[2] || "?"} rid=${(capM[3] || "").slice(0, 24)}…)`);
  // 点右 pane → 焦点移走
  psW(`[W]::Click(${Math.round(wl + (wrgt - wl) * 0.75)}, ${midY})`);
  await sleep(600);
  assert(psW(`Write-Output ([W]::Title([IntPtr]${wtHwnd}))`).endsWith("paneB"), "右 pane(paneB) 已聚焦(焦点移走)");
  // 点击岛上的行 → 应把键盘焦点精确还给 paneA
  const rect3 = islandRect();
  assert(!!rect3 && rect3.h > 10, "岛窗口随新行复现");
  psW(`[W]::Click(${Math.round((rect3.l + rect3.r) / 2 - 100 * f)}, ${Math.round(rect3.t + (ROW_H * f) / 2)})`);
  await sleep(1800);
  const fgPane = Number(psW(`Write-Output ([int64][W]::GetForegroundWindow())`));
  const titlePane = psW(`Write-Output ([W]::Title([IntPtr]${wtHwnd}))`);
  assert(fgPane === wtHwnd, `WT 窗口在前台 (${fgPane})`);
  assert(titlePane.endsWith("paneA"), `焦点精确回到 paneA —— pane 级聚焦生效 [title=${titlePane}]`);
  // 清理:按命令行精准杀两个 pane 的 cmd,panes 关完 WT 窗口自关
  try {
    ps(String.raw`Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
  Where-Object { $_.CommandLine -match 'title pane[AB]' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
  } catch {}
  await sendMsg({ id: "e2e-pane", type: "remove" });

  console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
