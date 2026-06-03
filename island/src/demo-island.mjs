// demo-island.mjs — 演示脚本：显示灵动岛 30 秒，截图验证
// Usage: node demo-island.mjs

import { connect } from "node:net";
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SOCK } from "./socket-path.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(HERE, "bridge.mjs");
const COMPANION = join(HERE, "companion.mjs");

function log(msg) { console.log(`[demo] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Connect and keep alive
function keepAlive(durationMs) {
  return new Promise((resolve) => {
    const s = connect(SOCK);
    s.on("connect", () => {
      log("connected to companion");
      setTimeout(() => { s.end(); log("disconnected"); resolve(); }, durationMs);
    });
    s.on("error", (e) => { log(`connect error: ${e.code}`); resolve(); });
  });
}

function sendMsg(msg) {
  return new Promise((resolve) => {
    const s = connect(SOCK);
    s.on("connect", () => {
      s.write(JSON.stringify(msg) + "\n");
      s.end();
      resolve(true);
    });
    s.on("error", () => resolve(false));
    setTimeout(() => resolve(false), 1000);
  });
}

function takeScreenshot(name) {
  try {
    execSync(`powershell -NoProfile -NoLogo -EncodedCommand ${Buffer.from(`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$x = [Math]::Max(0, ($b.Width - 900) / 2)
$bmp = New-Object System.Drawing.Bitmap(900, 140)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x - 50, 0, 0, 0, (New-Object System.Drawing.Size(900, 140)))
$out = Join-Path $env:USERPROFILE "${name}.png"
$bmp.Save($out)
$g.Dispose()
$bmp.Dispose()
Write-Host "OK"
`, "utf16le").toString("base64")}`, { encoding: "utf8", timeout: 5000, windowsHide: true });
    log(`screenshot saved: ~/${name}.png`);
    return true;
  } catch (e) {
    log(`screenshot failed: ${e.message}`);
    return false;
  }
}

async function main() {
  log("=== claude-island demo ===");
  log(`platform: ${process.platform}, SOCK: ${SOCK}`);

  // Step 1: kill any existing companion
  log("Step 1: clean up...");
  try {
    execSync('taskkill /F /IM node.exe /FI "COMMANDLINE eq *companion.mjs*"', { timeout: 2000, stdio: "ignore", windowsHide: true });
  } catch {}
  await sleep(500);

  // Step 2: start companion via bridge
  log("Step 2: starting companion...");
  const initResult = execSync(`node "${BRIDGE}" on`, { encoding: "utf8", timeout: 10000 }).trim();
  log(`bridge on: ${initResult}`);

  await sleep(1000);

  // Step 3: send status updates to show something on the island
  log("Step 3: sending status updates...");
  const SESSION_ID = "demo-" + Date.now().toString(36);

  await sendMsg({
    id: SESSION_ID, type: "update",
    project: "pi", status: "editing", detail: "island.md",
    prompt: "灵动岛效果展示", startedAt: Date.now(),
  });

  await sleep(500);

  // Step 4: keep connection alive for 30s and take screenshots
  log("Step 4: keeping alive for 30s...");

  // Take screenshot at t=2s
  await sleep(1500);
  takeScreenshot("island-demo-2s");

  // Take another at t=10s
  await sleep(8000);
  takeScreenshot("island-demo-10s");

  // Keep alive for the remainder
  await sleep(20000);

  log("demo complete! Screenshots saved as island-demo-2s.png and island-demo-10s.png");
}

main().catch(e => { console.error(e); process.exit(1); });
