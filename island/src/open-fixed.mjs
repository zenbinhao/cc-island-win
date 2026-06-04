// Spawn wrapper for the native host binary.
// Windows → hosts/windows/island-host-win.exe  (C# WinForms + WebView2)
// Speaks a stdin/stdout JSON-line protocol: html / eval / close.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { existsSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

function resolveBinary() {
  const here = dirname(fileURLToPath(import.meta.url));
  const bin = join(here, "hosts", "windows", "island-host-win.exe");
  if (existsSync(bin)) return bin;
  throw new Error(
    "claude-island: Windows host binary not found.\n" +
    "Run: node " + join(here, "build.mjs") + "  (requires .NET 8 SDK: winget install Microsoft.DotNet.SDK.8)"
  );
}

class FixedWindow extends EventEmitter {
  #proc; #closed = false; #pending = null;

  constructor(proc, html) {
    super();
    this.#proc = proc;
    this.#pending = html;
    proc.stdin.on("error", () => {});
    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      switch (msg.type) {
        case "ready":
          // First ready: set HTML (which triggers a navigation + second ready).
          // Subsequent ready: emit to caller.
          if (this.#pending) {
            this.setHTML(this.#pending);
            this.#pending = null;
            // Don't emit yet — wait for the second "ready" after navigation completes.
          } else {
            this.emit("ready", msg);
          }
          break;
        case "message": this.emit("message", msg.data); break;
        case "click": this.emit("click"); break;
        case "closed":
          if (!this.#closed) { this.#closed = true; this.emit("closed"); }
          break;
      }
    });
    proc.on("error", (e) => this.emit("error", e));
    proc.on("exit", () => { if (!this.#closed) { this.#closed = true; this.emit("closed"); } });
  }

  #write(obj) {
    if (this.#closed) return;
    try {
      // Escape non-ASCII so the stdin pipe carries only ASCII bytes.
      // Fixes Unicode corruption on Windows where pipe encoding may not be UTF-8.
      const json = JSON.stringify(obj).replace(/[-￿]/g,
        (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
      this.#proc.stdin.write(json + "\n");
    } catch {}
  }

  send(js)      { this.#write({ type: "eval", js }); }
  setHTML(html) { this.#write({ type: "html", html: Buffer.from(html).toString("base64") }); }
  resize(w, h)  { this.#write({ type: "resize", width: w, height: h }); }
  close()       { this.#write({ type: "close" }); }
}

export function openFixed(html, options = {}) {
  const bin = resolveBinary();
  const args = [];
  if (options.width != null)  args.push("--width", String(options.width));
  if (options.height != null) args.push("--height", String(options.height));
  if (options.title != null)  args.push("--title", options.title);
  if (options.frameless)    args.push("--frameless");
  if (options.floating)     args.push("--floating");
  if (options.transparent)  args.push("--transparent");
  if (options.clickThrough) args.push("--click-through");
  if (options.noDock)       args.push("--no-dock");
  if (options.hidden)       args.push("--hidden");
  if (options.x != null) args.push("--x", String(options.x));
  if (options.y != null) args.push("--y", String(options.y));

  const proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  // Log native host stderr for debugging
  proc.stderr.on("data", (d) => { try { appendFileSync(join(homedir(), ".claude", "claude-island.log"), `[native] ${d}`); } catch {} });
  return new FixedWindow(proc, html);
}
