// Platform abstraction. Windows-specific logic stays here so callers
// never branch on process.platform.
import { execSync } from "node:child_process";

function log(msg) { console.error(`[platform] ${msg}`); }

export const SUPPORTED_PLATFORMS = new Set(["win32"]);
export function isSupported() { return SUPPORTED_PLATFORMS.has(process.platform); }

// ── Screen geometry ────────────────────────────────────────────────────────
function execPS(script) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return execSync(`powershell -NoProfile -NoLogo -EncodedCommand ${encoded}`, {
    encoding: "utf8", timeout: 2000, windowsHide: true,
  }).trim();
}

export function getScreenGeometry(screenPref) {
  try {
    let psFilter;
    if (screenPref === "active") {
      psFilter = "$pos=[System.Windows.Forms.Cursor]::Position;$scr=[System.Windows.Forms.Screen]::AllScreens|Where-Object{$_.Bounds.Contains($pos)}|Select-Object -First 1;if(-not$scr){$scr=[System.Windows.Forms.Screen]::PrimaryScreen}";
    } else {
      const idx = parseInt(screenPref, 10);
      psFilter = Number.isFinite(idx) && idx >= 1
        ? "$all=[System.Windows.Forms.Screen]::AllScreens;$scr=if($all.Length -ge " + idx + "){$all[" + (idx - 1) + "]}else{$all[0]}"
        : "$scr=[System.Windows.Forms.Screen]::PrimaryScreen";
    }
    const script = "Add-Type -AssemblyName System.Windows.Forms;" + psFilter + ";$b=$scr.Bounds;$wa=$scr.WorkingArea;ConvertTo-Json @{x=$b.X;y=$b.Y;w=$b.Width;h=$b.Height;taskbarH=$b.Height-$wa.Height}";
    const j = JSON.parse(execPS(script));
    if (Number.isFinite(j.w) && Number.isFinite(j.h)) {
      return { x: Math.round(j.x || 0), y: Math.round(j.y || 0), w: Math.round(j.w), h: Math.round(j.h) };
    }
  } catch (e) { log(`getScreenGeometry failed: ${e.message}`); }
  return { x: 0, y: 0, w: 1920, h: 1080 };
}

export function computeWindowPosition(screenGeo, winW, winH) {
  const x = Math.round(screenGeo.x + (screenGeo.w - winW) / 2);
  return { x, y: screenGeo.y };
}

export function getScreenCount() {
  try {
    const n = parseInt(execPS("Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.Screen]::AllScreens.Length"), 10);
    if (Number.isFinite(n) && n >= 1) return Math.min(n, 9);
  } catch (e) { log(`getScreenCount failed: ${e.message}`); }
  return 1;
}
