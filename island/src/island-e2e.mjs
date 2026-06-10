#!/usr/bin/env node
// island-e2e.mjs — 真实桌面 E2E 自驱回路(Windows node 运行,会动鼠标!)
// 验证:① 点击胶囊行 → 跳转拉起捕获的目标窗口;② 点 × → 行删除、空了整窗隐藏。
// 流程:reload companion → 起 notepad(前台) → 发 captureFg update(companion 捕
// 获 notepad HWND) → 最小化 notepad → SendInput 点行 → 断言前台回到 notepad
// → SendInput 点 × → 断言岛窗口高度归零。
// Usage: node.exe island/src/island-e2e.mjs

import { execSync } from "node:child_process";
import { connect } from "node:net";
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
function ps(script) {
  const full = "$ProgressPreference='SilentlyContinue'\n" + script;
  return execSync("powershell -NoProfile -NoLogo -EncodedCommand " +
    Buffer.from(full, "utf16le").toString("base64"),
    { encoding: "utf8", timeout: 20000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
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
  public delegate bool EnumProc(IntPtr h, IntPtr l);
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
  const { readFileSync } = await import("node:fs");
  const { homedir } = await import("node:os");
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

  console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
