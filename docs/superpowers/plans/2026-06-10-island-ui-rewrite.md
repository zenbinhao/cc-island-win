# 灵动岛 UI 重写 + 点击跳转 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec `docs/superpowers/specs/2026-06-10-island-ui-rewrite-design.md` 重写灵动岛 UI 层,新增整行点击跳转到对应 CC 终端窗口,补齐 DPI/分辨率兼容,消灭 PowerShell 启动依赖。

**Architecture:** 四层管道不变(bridge 一次性 → 命名管道 → companion 常驻 → C# host stdin/stdout)。新增:bridge 在 UserPromptSubmit 上打 `captureFg` 标 → companion 经常驻 host 捕获前台 HWND 存表 → 点击行回流 `focus` 消息 → host `SetForegroundWindow`。`island.html.mjs` 全重写(transform 定位 + 增量渲染);屏幕几何移入 C#;尺寸常量收敛到新模块 `scales.mjs`。

**Tech Stack:** Node.js (ESM, Windows node 运行)、C# WinForms + WebView2 (.NET 8)、PowerShell 仅余测试/E2E 用途。

**运行约定:** 所有命令在仓库根 `/mnt/c/Users/Z/Desktop/claude-code-island` 下执行;测试/脚本一律 `node.exe`(Windows node,WSL interop)。测试套件会读写真实 `~/.claude/claude-island-state.json` 并向活的 companion 发消息(屏上会闪测试行,跑完恢复)。**每个任务完成即 commit;不要把多个任务攒成一个 commit。**

---

## 文件结构总览

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `island/src/scales.mjs` | 新建 | 尺寸/缩放常量 + `windowSize()` 纯函数(companion 与 HTML 共用,深模块) |
| `island/src/socket-path.mjs` | 改 | `SOCK` 支持 `CLAUDE_ISLAND_SOCK` env 覆盖(测试 seam) |
| `island/src/bridge.mjs` | 改 | UserPromptSubmit 带 `captureFg`;提取 `deleteSessionData()`;SCALES 改从 scales.mjs 导入 |
| `island/src/hosts/windows/island-host.cs` | 改 | 新命令 screens/captureFg/focusWindow;`--screen` 自定位;WM_DISPLAYCHANGE;聚焦 P/Invoke |
| `island/src/hosts/windows/island-host.csproj` | 改 | `ApplicationHighDpiMode=PerMonitorV2` |
| `island/src/open-fixed.mjs` | 改 | `cmd()` 通用命令 + `screens`/`fg` 事件 |
| `island/src/companion.mjs` | 改 | host 几何接管(--screen/all 模式)、scale 感知尺寸、no-op resize 跳过、hwnd 表与 focus 路由、删 socketIds、WebView2 缺失提示 |
| `island/src/island.html.mjs` | 重写 | 新 UI:transform 定位、增量渲染、新动效、整行命中、focus 消息 |
| `island/src/platform.mjs` | 删除 | 几何全部移入 C#,无人再引用 |
| `island/src/island-test.mjs` | 改 | 新增 windowSize/fake-socket/captureFg/host 协议测试;清死变量过时注释 |
| `island/src/island-e2e.mjs` | 新建 | SendInput 自驱 E2E:跳转/×/收起回归 |
| `island/src/_dbgclick.ps1` | 删除 | 逻辑被 island-e2e.mjs 吸收 |
| `C:/Users/Z/.claude/settings.json` | 改 | Windows 侧 8 个 island hooks(裸 node) |
| `README.md` `island/SKILL.md` `CLAUDE.md` `CHANGELOG.md` | 改 | 文档同步 |

---

### Task 1: scales.mjs — 尺寸常量 + windowSize 纯函数 (TDD)

**Files:**
- Create: `island/src/scales.mjs`
- Test: `island/src/island-test.mjs`(追加测试 12)

- [ ] **Step 1: 写失败测试** — 在 island-test.mjs 测试 10 之后、Results 之前追加:

```js
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
```

- [ ] **Step 2: 跑测试确认 RED** — `node.exe island/src/island-test.mjs`,期望:测试 12 处报错(Cannot find module './scales.mjs')或断言失败。
- [ ] **Step 3: 最小实现** — 新建 `island/src/scales.mjs`:

```js
// scales.mjs — 尺寸/缩放常量与窗口尺寸计算(纯函数,companion 与 island.html 共用)
// 基准(scale=1,即 medium):行 540×40,收起手柄 20 高,窗口比行宽多 40 边距。

export const SCALES = { small: 0.88, medium: 1.0, large: 1.18, xlarge: 1.35 };
export const ROW_W = 540;
export const ROW_H = 40;
export const HANDLE_H = 20;
export const WIN_MARGIN = 40;

/**
 * 计算原生窗口应有尺寸。
 * @param {number} rowCount 活跃行数
 * @param {boolean} collapsed 是否收起
 * @param {string} scaleName small|medium|large|xlarge(未知回退 medium)
 * @returns {{w:number,h:number}} 设备无关 px(host 侧按窗口所在屏 DPI 呈现)
 */
export function windowSize(rowCount, collapsed, scaleName) {
  const f = SCALES[scaleName] ?? SCALES.medium;
  const w = Math.ceil((ROW_W + WIN_MARGIN) * f);
  if (rowCount === 0) return { w, h: 0 };
  const handleH = Math.ceil(HANDLE_H * f);
  if (collapsed) return { w, h: handleH };
  return { w, h: Math.ceil(rowCount * ROW_H * f) + handleH };
}
```

- [ ] **Step 4: 跑测试确认 GREEN** — `node.exe island/src/island-test.mjs`,期望:测试 12 全 ✓,总计 0 失败。
- [ ] **Step 5: Commit**

```bash
git add island/src/scales.mjs island/src/island-test.mjs
git commit -m "feat: scales.mjs 尺寸常量 + windowSize 纯函数(scale 感知,修 large/xlarge 裁剪前置)"
```

---

### Task 2: SOCK 测试 seam + fake-socket 测试基建 (TDD)

**Files:**
- Modify: `island/src/socket-path.mjs`
- Test: `island/src/island-test.mjs`

- [ ] **Step 1: 写失败测试** — island-test.mjs:先给 `runBridge` 加 env 参数(整函数替换):

```js
function runBridge(stdinJson, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE, "hook"], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      env: { ...process.env, HOME: homedir(), ...(extraEnv || {}) },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => { resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }); });
    child.stdin.write(stdinJson);
    child.stdin.end();
  });
}
```

再加 fake companion 帮手(放 runBridge 之后)与测试 13(测试 12 之后):

```js
// 起一个假 companion(独占测试管道),收集 bridge 发来的消息
async function withFakeCompanion(fn) {
  const pipe = "//./pipe/claude-island-test-" + process.pid;
  const messages = [];
  const server = createServer((sock) => {
    const rl = createInterface({ input: sock, crlfDelay: Infinity });
    rl.on("line", (line) => { try { messages.push(JSON.parse(line)); } catch {} });
  });
  await new Promise((r) => server.listen(pipe, r));
  try { await fn(pipe, messages); } finally { server.close(); }
  return messages;
}
```

```js
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
```

- [ ] **Step 2: 跑测试确认 RED** — `node.exe island/src/island-test.mjs`,期望:测试 13 两断言 ✗(bridge 连的还是真管道,fake 收不到)。
- [ ] **Step 3: 最小实现** — `island/src/socket-path.mjs` 全文替换:

```js
// IPC path shared by companion daemon and bridge client.
// Windows: Named pipe at \\.\pipe\claude-island
// CLAUDE_ISLAND_SOCK 环境变量可覆盖(测试 seam:island-test 用独立管道起 fake companion)

export const SOCK = process.env.CLAUDE_ISLAND_SOCK || "//./pipe/claude-island";
```

- [ ] **Step 4: 跑测试确认 GREEN** — 0 失败。
- [ ] **Step 5: Commit**

```bash
git add island/src/socket-path.mjs island/src/island-test.mjs
git commit -m "feat: SOCK 支持 CLAUDE_ISLAND_SOCK env 覆盖 + fake companion 测试基建"
```

---

### Task 3: bridge — captureFg 标志 + deleteSessionData 提取 + 测试文件清理 (TDD)

**Files:**
- Modify: `island/src/bridge.mjs`
- Test: `island/src/island-test.mjs`

- [ ] **Step 1: 写失败测试** — 测试 13 之后追加:

```js
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
```

- [ ] **Step 2: 跑测试确认 RED** — 期望:`captureFg:true` 断言 ✗。
- [ ] **Step 3: 实现** — bridge.mjs 三处改动:

(a) UserPromptSubmit case 的 `sendToCompanion` payload 增加一行 `captureFg: true,`(放 `ccPid,` 之后):

```js
      await sendToCompanion({
        id: sessionId, type: "update",
        project, status: "thinking", detail: "",
        prompt: sess.prompt, startedAt: sess.startedAt, frozenElapsed: null,
        ccPid,
        captureFg: true,  // companion 据此让常驻 host 捕获前台 HWND(点击跳转的锚点)
      });
```

(b) 提取重复三次的删 session 数据块为函数(放 `saveSessionData` 之后),Stop/StopFailure/SessionEnd 三个 case 里的整段 `try { if (existsSync(STATE_FILE)) {...} } catch {}` 替换为 `deleteSessionData(sessionId);`:

```js
function deleteSessionData(sessionId) {
  try {
    if (existsSync(STATE_FILE)) {
      const data = JSON.parse(readFileSync(STATE_FILE, "utf8"));
      if (data && data._sessionData && data._sessionData[sessionId]) {
        delete data._sessionData[sessionId];
        writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
      }
    }
  } catch {}
}
```

(c) SCALES 改从 scales.mjs 导入(DRY):删除 `const SCALES = ["small", "medium", "large", "xlarge"];`,顶部加 `import { SCALES as SCALE_MAP } from "./scales.mjs";`,改 `const SCALES = Object.keys(SCALE_MAP);`。

- [ ] **Step 4: 测试文件清理(顺手,属本任务)** — island-test.mjs:删除死变量行 `const PASS = 0, FAIL = 0;`;把测试 9 的过时注释 `// 动态导入 liveness.mjs(还不存在)` 改为 `// 动态导入 liveness.mjs`。
- [ ] **Step 5: 跑测试确认 GREEN** — `node.exe island/src/island-test.mjs`,0 失败(测试 3/10 顺带回归 deleteSessionData 行为不变)。
- [ ] **Step 6: Commit**

```bash
git add island/src/bridge.mjs island/src/island-test.mjs
git commit -m "feat: bridge UserPromptSubmit 带 captureFg + 提取 deleteSessionData 去三处重复"
```

---

### Task 4: C# host — 协议扩展 screens/captureFg/focusWindow + open-fixed 配套 (TDD)

**Files:**
- Modify: `island/src/hosts/windows/island-host.cs`
- Modify: `island/src/open-fixed.mjs`
- Test: `island/src/island-test.mjs`

- [ ] **Step 1: open-fixed.mjs 加通用命令与事件**(测试要用,先做):rl 的 switch 增加两个 case(`case "message"` 之前):

```js
        case "screens": this.emit("screens", msg.count); break;
        case "fg": this.emit("fg", msg); break;
```

类方法区(`send(js)` 一行之后)加:

```js
  cmd(obj)      { this.#write(obj); }
```

- [ ] **Step 2: 写失败测试** — island-test.mjs 测试 14 之后追加(起一个隐藏 host 直测原生协议):

```js
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
  w15.close();
  await sleep(300);
```

- [ ] **Step 3: 跑测试确认 RED** — 期望:测试 15 两断言 ✗(host 不识别 screens/captureFg,超时)。
- [ ] **Step 4: island-host.cs 实现** — 四处:

(a) `IslandHost` 类的 P/Invoke 区(`GetModuleHandle` 声明之后)追加:

```csharp
    // ── 跳转聚焦:捕获前台窗口 + 拉起目标窗口 ──
    const int SW_RESTORE = 9;
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
```

(b) `HandleCommand` 的 switch 增加三个 case(`case "resize"` 之后):

```csharp
            case "screens":
                Stdout.Write(new JsonObject { ["type"] = "screens", ["count"] = Screen.AllScreens.Length });
                break;
            case "captureFg":
            {
                var sid = json["sid"]?.GetValue<string>() ?? "";
                var fg = GetForegroundWindow();
                // 永远应答(hwnd=0 表示无效),协议确定性优先;companion 侧忽略 0
                long hwnd = (fg == IntPtr.Zero || fg == Form.Handle) ? 0 : fg.ToInt64();
                Stdout.Write(new JsonObject { ["type"] = "fg", ["sid"] = sid, ["hwnd"] = hwnd });
                break;
            }
            case "focusWindow":
            {
                var hv = json["hwnd"]?.GetValue<long>() ?? 0;
                if (hv != 0) FocusWindow(hv);
                break;
            }
```

(c) `IslandHost` 类内(`UpdateHitRects` 之后)加方法:

```csharp
    private void FocusWindow(long hwndVal)
    {
        var h = new IntPtr(hwndVal);
        if (!IsWindow(h)) { Log.Info($"focusWindow: stale hwnd {hwndVal}"); return; }
        if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
        // ALT 按键 trick:让系统认为本进程刚收到键输入,解除 SetForegroundWindow 前台锁
        keybd_event(0x12, 0, 0, UIntPtr.Zero);
        keybd_event(0x12, 0, 2, UIntPtr.Zero); // KEYEVENTF_KEYUP
        if (!SetForegroundWindow(h))
        {
            uint fgTid = GetWindowThreadProcessId(GetForegroundWindow(), out _);
            uint myTid = GetCurrentThreadId();
            AttachThreadInput(myTid, fgTid, true);
            SetForegroundWindow(h);
            AttachThreadInput(myTid, fgTid, false);
        }
    }
```

(d) 重编:`node.exe island/src/build.mjs`,期望输出 `Built: ...island-host-win.exe`。

- [ ] **Step 5: 跑测试确认 GREEN** — `node.exe island/src/island-test.mjs`,0 失败。
- [ ] **Step 6: Commit**(exe/dll 一起提交,仓库惯例)

```bash
git add island/src/hosts/windows/island-host.cs island/src/open-fixed.mjs island/src/island-test.mjs island/src/hosts/windows/island-host-win.exe island/src/hosts/windows/*.dll island/src/hosts/windows/*.json
git commit -m "feat: host 协议扩展 screens/captureFg/focusWindow + 聚焦 P/Invoke(ALT trick + AttachThreadInput 兜底)"
```

---

### Task 5: C# host — --screen 自定位 + PerMonitorV2 + WM_DISPLAYCHANGE

**Files:**
- Modify: `island/src/hosts/windows/island-host.cs`
- Modify: `island/src/hosts/windows/island-host.csproj`
- Modify: `island/src/open-fixed.mjs`(透传 --screen)

- [ ] **Step 1: Config 加 ScreenPref** — `Config` 类加字段 `public string ScreenPref = "primary";`,`Parse` 的 switch 加:

```csharp
                case "--screen": if (++i < args.Length) c.ScreenPref = args[i]; break;
```

- [ ] **Step 2: 屏幕选取 + 自定位** — `IslandHost` 类加静态方法:

```csharp
    internal static Screen PickScreen(string pref)
    {
        var all = Screen.AllScreens;
        if (pref == "active")
        {
            var pos = Cursor.Position;
            foreach (var s in all) if (s.Bounds.Contains(pos)) return s;
        }
        if (int.TryParse(pref, out var idx) && idx >= 1 && idx <= all.Length) return all[idx - 1];
        return Screen.PrimaryScreen ?? all[0];
    }
```

构造函数中,把现有

```csharp
        if (config.X.HasValue && config.Y.HasValue)
            Form.Location = new Point(config.X.Value, config.Y.Value);
```

替换为(显式 --x/--y 仍最高优先,向后兼容):

```csharp
        if (config.X.HasValue && config.Y.HasValue)
        {
            Form.Location = new Point(config.X.Value, config.Y.Value);
        }
        else
        {
            var scr = PickScreen(config.ScreenPref);
            Form.StartPosition = FormStartPosition.Manual;
            Form.Location = new Point(scr.Bounds.X + (scr.Bounds.Width - config.Width) / 2, scr.Bounds.Y);
        }
        Form.ScreenPref = config.ScreenPref;
```

- [ ] **Step 3: WM_DISPLAYCHANGE 重归位** — `IslandForm` 加 `public string ScreenPref = "primary";` 与常量 `const int WM_DISPLAYCHANGE = 0x007E;`,WndProc 中(WM_NCHITTEST 块之后、`base.WndProc` 之前)加:

```csharp
        if (m.Msg == WM_DISPLAYCHANGE)
        {
            // 分辨率/拓扑变化:按既定屏幕偏好重新顶部居中
            BeginInvoke(() =>
            {
                var scr = IslandHost.PickScreen(ScreenPref);
                Left = scr.Bounds.X + (scr.Bounds.Width - Width) / 2;
                Top = scr.Bounds.Y;
            });
        }
```

- [ ] **Step 4: PerMonitorV2** — 打开 `island-host.csproj`,在第一个 `<PropertyGroup>` 内加一行:

```xml
    <ApplicationHighDpiMode>PerMonitorV2</ApplicationHighDpiMode>
```

(`ApplicationConfiguration.Initialize()` 会据此调 SetHighDpiMode;高缩放屏不再位图拉伸,LL hook/PointToClient/devicePixelRatio 全链路物理像素一致。)

- [ ] **Step 5: open-fixed.mjs 透传** — `openFixed` 的 args 组装区(`--title` 行之后)加:

```js
  if (options.screen != null) args.push("--screen", String(options.screen));
```

- [ ] **Step 6: 重编 + 验证** — `node.exe island/src/build.mjs` 成功;`node.exe island/src/island-test.mjs` 0 失败(测试 15 顺带验证重编后协议仍通);手动验证:`node.exe island/src/bridge.mjs reload` 后窗口仍出现在主屏顶部居中(此时 companion 仍传 --x/--y,显式坐标优先路径未变)。
- [ ] **Step 7: Commit**

```bash
git add island/src/hosts/windows/island-host.cs island/src/hosts/windows/island-host.csproj island/src/open-fixed.mjs island/src/hosts/windows/island-host-win.exe island/src/hosts/windows/*.dll island/src/hosts/windows/*.json
git commit -m "feat: host --screen 自定位 + PerMonitorV2 DPI + WM_DISPLAYCHANGE 重归位"
```

---

### Task 6: companion — 几何接管 + all 模式 + WebView2 提示 + platform.mjs 删除

**Files:**
- Modify: `island/src/companion.mjs`
- Delete: `island/src/platform.mjs`

- [ ] **Step 1: 改窗口开启逻辑** — companion.mjs:删除 `import { getScreenGeometry, getScreenCount, computeWindowPosition } from "./platform.mjs";`,顶部加 `import { windowSize } from "./scales.mjs";`。删除「Build list of screen geometries」整段与 `for (const geo of screenGeos)` 循环,替换为函数化开窗(保持原有事件处理内容不变,只是挪进函数;`message` 处理沿用现有 handler 逻辑):

```js
function openIslandWindow(screenPref) {
  const init = windowSize(1, false, SCALE_PREF);
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
  firstWin.on("screens", (count) => {
    log("info", `all-screens mode: ${count} screen(s)`);
    for (let i = 2; i <= Math.min(count, 9); i++) openIslandWindow(String(i));
  });
  firstWin.on("ready", () => firstWin.cmd({ type: "screens" }));
}
```

(`SCALE_PREF`、`hwndBySession`、`focusSession`、`syncHeight` 在 Task 7 落定;本任务先放占位常量 `const SCALE_PREF = "medium";`、`const hwndBySession = new Map();`、`function focusSession() {}` 让链路可跑,Task 7 替换为真实现——两任务连续执行,占位不入独立 commit 也可,合并到 Task 7 提交前必须替换。若想本任务独立绿灯,占位即可。)

- [ ] **Step 2: bridge WebView2 提示** — bridge.mjs `case "on"` 与 `toggle` 的失败输出统一改为:

```js
      console.log(ok ? "Island enabled" : "Island enabled (companion start failed — 查看 ~/.claude/claude-island.log;若含 'WebView2' 字样,需安装 WebView2 Runtime: https://developer.microsoft.com/en-us/microsoft-edge/webview2/)");
```

- [ ] **Step 3: 删 platform.mjs** — 先确认无引用:`grep -rn "platform.mjs" island/ --include=*.mjs` 仅应剩注释/无;`rm island/src/platform.mjs`。
- [ ] **Step 4: 验证** — `node.exe island/src/island-test.mjs` 0 失败;`node.exe island/src/bridge.mjs reload` → 窗口正常出现(此时无 --x/--y,走 host 自定位路径),`tail ~/.claude/claude-island.log` 无 fatal;启动日志不再出现 PowerShell 痕迹且 `window ready` 在 reload 后 ~2s 内出现(对比此前 PS 两连击的耗时)。
- [ ] **Step 5: Commit**

```bash
git add -A island/src/companion.mjs island/src/bridge.mjs island/src/platform.mjs
git commit -m "feat: 屏幕几何移入 host(--screen),companion 摆脱 PowerShell;all 模式经 screens 协议;WebView2 缺失提示;删 platform.mjs"
```

---

### Task 7: companion — scale 感知尺寸 + no-op 跳过 + hwnd 路由 + 删 socketIds

**Files:**
- Modify: `island/src/companion.mjs`

- [ ] **Step 1: scale 感知 + no-op 跳过** — 删除常量 `WIN_W/WIN_H/WIN_H_COLLAPSED`;`SCALE_PREF` 改真实现(从 pref 读,放 THEME_PREF 旁):

```js
import { SCALES, windowSize } from "./scales.mjs";
let curScale = SCALES[_pref.scale] ? _pref.scale : "medium";
```

`syncHeight` 整函数替换:

```js
let lastW = -1, lastH = -1;
function syncHeight() {
  const { w, h } = windowSize(activeRowIds.size, isCollapsed, curScale);
  if (w === lastW && h === lastH) return; // 尺寸没变就别打扰 host(此前每条 update 都 SetWindowPos)
  lastW = w; lastH = h;
  for (const win of wins) { try { win.resize(w, h); } catch {} }
}
```

socket server 的 `scale` 分支改为(更新 curScale 并重算窗口):

```js
    if (msg.type === "scale" && typeof msg.scale === "string") {
      if (SCALES[msg.scale]) { curScale = msg.scale; }
      send('window.island.setScale(' + JSON.stringify(msg.scale) + ')');
      syncHeight();
      return;
    }
```

`openIslandWindow` 里 `windowSize(1, false, SCALE_PREF)` 改 `windowSize(1, false, curScale)`,删除占位 `SCALE_PREF`。

- [ ] **Step 2: hwnd 路由真实现** — 替换 Task 6 的占位:

```js
const hwndBySession = new Map(); // sessionId → 前台窗口 HWND(UserPromptSubmit 时刻捕获)
function hostWin() { for (const w of wins) if (w._ready) return w; return null; }
function focusSession(id) {
  const hwnd = hwndBySession.get(id);
  log("info", `focus id=${id} hwnd=${hwnd || "none"}`);
  if (!hwnd) return;
  const hw = hostWin();
  if (hw) hw.cmd({ type: "focusWindow", hwnd });
}
```

update 分支在 `rowPids.set` 之后加:

```js
      if (msg.captureFg) {
        const hw = hostWin();
        if (hw) hw.cmd({ type: "captureFg", sid: msg.id });
      }
```

`removeRowById` 加一行 `hwndBySession.delete(id);`(与 `rowPids.delete(id)` 并排)。

- [ ] **Step 3: 删 socketIds 死代码** — 删除 `const socketIds = new WeakMap();`、连接 handler 里的 `socketIds.set(sock, new Set());`、line handler 里的 `socketIds.get(sock)?.add(msg.id);` 整个 if 块、close handler 里的 `const ids = socketIds.get(sock); if (ids) socketIds.delete(sock);`。
- [ ] **Step 4: 验证** — `node --check`(经测试 0 自动覆盖);`node.exe island/src/island-test.mjs` 0 失败;`node.exe island/src/bridge.mjs reload && node.exe island/src/bridge.mjs scale large` → 窗口变大不裁剪,再 `scale medium` 还原;日志确认 update 连发时无重复 resize。
- [ ] **Step 5: Commit**

```bash
git add island/src/companion.mjs
git commit -m "feat: companion scale 感知窗口尺寸 + no-op resize 跳过 + hwnd 捕获/聚焦路由 + 删 socketIds 死代码"
```

---

### Task 8: island.html.mjs 全重写(新视觉/动效/整行命中/focus)

**Files:**
- Rewrite: `island/src/island.html.mjs`

- [ ] **Step 1: 整文件替换为以下内容**(完整代码;实现时如有视觉微调,保持结构与接口不变):

```js
// HTML + 客户端状态机 — 灵动岛 UI 层(全重写)。
// 结构:外层 .row-wrap 只管 transform 定位(GPU 友好),内层 .row 只管观感
// (进出场/按压/呼吸光)。文本全部经 refs 增量更新(textContent),不重建 DOM。
// 硬约束:窗口靠 TransparencyKey 抠色透明,无逐像素 alpha——禁止外发光与
// 半透明边缘,发光一律 inset、底色一律实色,否则出品红描边。
// 接口(companion 经 eval 调用):window.island.{upsertRow,removeRow,setScale,
// setTheme,setCollapsed,toggleCollapse,hover,hitClick}
import { SCALES, ROW_W, ROW_H } from "./scales.mjs";

export function buildIslandHTML() {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
:root {
  --scale: 1;
  --row-w: calc(${ROW_W}px * var(--scale));
  --row-h: calc(${ROW_H}px * var(--scale));
  --ease-out: cubic-bezier(0.32, 0.72, 0, 1);
  --spring: cubic-bezier(0.34, 1.3, 0.64, 1);
  --row-bg: #0a0a0c;
  --row-bg-hover: #191920;
  --row-text: #fff;
  --project-color: rgba(255,255,255,0.96);
  --detail-color: rgba(255,255,255,0.60);
  --prompt-color: rgba(255,255,255,0.80);
  --meta-color: rgba(255,255,255,0.55);
  --meta-border: rgba(255,255,255,0.12);
  --row-border: rgba(255,255,255,0.16);
  --dismiss-bg: rgba(255,255,255,0.12);
  --ctx-warn: #F59E0B;
  --ctx-hot: #EF4444;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
  width: 100%; height: 100%;
  background: transparent !important;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  user-select: none; -webkit-user-select: none;
}

#stack {
  position: absolute; top: 0; left: 50%;
  width: var(--row-w);
  margin-left: calc(var(--row-w) / -2);
  transform-origin: top center;
  transition: opacity 280ms var(--ease-out), transform 280ms var(--ease-out);
}
body.collapsed #stack {
  opacity: 0; pointer-events: none;
  transform: translateY(calc(-8px * var(--scale))) scaleY(0.92);
}

.row-wrap {
  position: absolute; top: 0; left: 0;
  width: 100%; height: var(--row-h);
  transition: transform 320ms var(--ease-out);
}
.row {
  width: 100%; height: 100%;
  position: relative;
  background: var(--row-bg);
  color: var(--row-text);
  padding: 0 calc(16px * var(--scale));
  display: flex; justify-content: space-between; align-items: center;
  gap: calc(10px * var(--scale));
  font-size: calc(13px * var(--scale)); font-weight: 500;
  white-space: nowrap; overflow: hidden;
  transition: opacity 240ms var(--ease-out),
              transform 380ms var(--spring),
              background 180ms ease;
}
.row.enter   { opacity: 0; transform: translateY(calc(-10px * var(--scale))) scale(0.96); }
.row.leaving { opacity: 0; transform: translateY(calc(-6px * var(--scale))) scale(0.96); }
.row.pressed { transform: scale(0.985); }
.row.hovered { background: var(--row-bg-hover); }
.row-wrap.not-first .row { border-top: 1px solid var(--row-border); }
.row-wrap.last .row { border-radius: 0 0 calc(20px * var(--scale)) calc(20px * var(--scale)); }

@keyframes pop { 0% { transform: scale(1); } 40% { transform: scale(1.03); } 100% { transform: scale(1); } }
.row.pop { animation: pop 300ms var(--ease-out); }

/* ── 状态呼吸光(dark,inset 安全) ───────────────────────────────── */
@keyframes breathe-waiting {
  0%, 100% { box-shadow: inset 0 0 10px rgba(245,158,11,0.25); background: #16110a; }
  50%      { box-shadow: inset 0 0 26px rgba(245,158,11,0.55); background: #271a06; }
}
@keyframes breathe-done {
  0%, 100% { box-shadow: inset 0 0 10px rgba(34,197,94,0.22); background: #07150c; }
  50%      { box-shadow: inset 0 0 24px rgba(34,197,94,0.50); background: #0a2414; }
}
@keyframes glyph-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.row[data-status="waiting"] { animation: breathe-waiting 1.1s ease-in-out infinite; }
.row[data-status="done"]    { animation: breathe-done 1.6s ease-in-out infinite; }
.row[data-status="waiting"].pop { animation: breathe-waiting 1.1s ease-in-out infinite, pop 300ms var(--ease-out); }
.row[data-status="done"].pop    { animation: breathe-done 1.6s ease-in-out infinite, pop 300ms var(--ease-out); }
.row[data-status="waiting"] .glyph { animation: glyph-pulse 1.1s ease-in-out infinite; }
.row[data-status="done"] .glyph    { animation: glyph-pulse 1.6s ease-in-out infinite; }

/* ── 槽位与文本 ────────────────────────────────────────────────── */
.slot { display: flex; align-items: center; gap: calc(8px * var(--scale)); min-width: 0; }
.slot.left  { flex: 0 1 auto; max-width: calc(150px * var(--scale)); overflow: hidden; }
.slot.right { flex: 0 0 auto; transition: margin-right 160ms ease; }
.row.hovered .slot.right { margin-right: calc(22px * var(--scale)); }
.slot.mid {
  position: absolute; left: 50%; top: 0; bottom: 0;
  transform: translateX(-50%);
  display: flex; align-items: center; justify-content: center;
  max-width: calc(190px * var(--scale));
  overflow: hidden; pointer-events: none;
}
.glyph {
  font-family: ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace;
  font-size: calc(14px * var(--scale)); line-height: 1;
  width: calc(15px * var(--scale)); text-align: center;
  flex-shrink: 0;
}
.project { color: var(--project-color); font-weight: 600; letter-spacing: -0.1px; overflow: hidden; text-overflow: ellipsis; }
.detail {
  color: var(--detail-color);
  font-family: ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace;
  font-size: calc(11.5px * var(--scale));
  overflow: hidden; text-overflow: ellipsis;
}
.prompt { color: var(--prompt-color); font-style: italic; font-weight: 400; overflow: hidden; text-overflow: ellipsis; }
.prompt::before { content: '\\201C'; opacity: 0.5; margin-right: 1px; }
.prompt::after  { content: '\\201D'; opacity: 0.5; margin-left: 1px; }
.status { flex-shrink: 0; font-weight: 600; }
.meta {
  padding-left: calc(9px * var(--scale));
  border-left: 1px solid var(--meta-border);
  color: var(--meta-color);
  font-family: ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace;
  font-size: calc(11px * var(--scale));
  display: flex; gap: calc(7px * var(--scale)); align-items: center; flex-shrink: 0;
}
.meta .mono { font-variant-numeric: tabular-nums; }
.ctx-warn { color: var(--ctx-warn); }
.ctx-hot  { color: var(--ctx-hot); }
.jump {
  opacity: 0; transition: opacity 140ms ease;
  color: var(--detail-color);
  font-family: ui-monospace, monospace;
  font-size: calc(12px * var(--scale)); flex-shrink: 0;
}
.row.hovered .jump { opacity: 0.85; }
.dismiss {
  position: absolute; right: calc(9px * var(--scale)); top: 50%;
  transform: translateY(-50%);
  width: calc(18px * var(--scale)); height: calc(18px * var(--scale));
  display: flex; align-items: center; justify-content: center;
  border-radius: 50%;
  font-size: calc(14px * var(--scale)); line-height: 1;
  color: var(--detail-color); background: var(--dismiss-bg);
  opacity: 0; transition: opacity 140ms ease;
}
.row.hovered .dismiss { opacity: 0.92; }

/* ── 收起手柄 ──────────────────────────────────────────────────── */
#collapse-btn {
  position: fixed; bottom: 0; left: 50%; transform: translateX(-50%);
  width: calc(52px * var(--scale)); height: calc(20px * var(--scale));
  display: flex; align-items: center; justify-content: center;
  background: var(--row-bg);
  border: none; padding: 0; cursor: pointer;
  border-radius: 0 0 calc(10px * var(--scale)) calc(10px * var(--scale));
  z-index: 1000; pointer-events: auto;
  transition: opacity 200ms ease;
}
#collapse-btn:hover { opacity: 0.8; }
#collapse-btn svg {
  width: calc(12px * var(--scale)); height: calc(12px * var(--scale));
  fill: var(--detail-color);
  transition: transform 300ms var(--ease-out);
}
body.collapsed #collapse-btn svg { transform: rotate(180deg); }

/* ── Pink 主题(全部实色/inset,无外发光) ───────────────────────── */
body.theme-pink {
  --row-bg: #F6D3DA;
  --row-bg-hover: #F0BFC9;
  --row-text: #4A1428;
  --project-color: #3A0E1E;
  --detail-color: rgba(75,20,40,0.68);
  --prompt-color: rgba(75,20,40,0.72);
  --meta-color: rgba(75,20,40,0.55);
  --meta-border: rgba(75,20,40,0.15);
  --row-border: rgba(75,20,40,0.12);
  --dismiss-bg: rgba(75,20,40,0.10);
  --ctx-warn: #A06200;
  --ctx-hot: #B02828;
}
@keyframes breathe-waiting-pink {
  0%, 100% { box-shadow: inset 0 0 10px rgba(176,64,96,0.25); background: #F6D3DA; }
  50%      { box-shadow: inset 0 0 26px rgba(176,64,96,0.50); background: #EFB6C3; }
}
@keyframes breathe-done-pink {
  0%, 100% { box-shadow: inset 0 0 10px rgba(38,152,84,0.22); background: #F6D3DA; }
  50%      { box-shadow: inset 0 0 24px rgba(38,152,84,0.45); background: #DFEFE3; }
}
body.theme-pink .row[data-status="waiting"] { animation-name: breathe-waiting-pink; }
body.theme-pink .row[data-status="done"]    { animation-name: breathe-done-pink; }
body.theme-pink .row[data-status="waiting"].pop { animation: breathe-waiting-pink 1.1s ease-in-out infinite, pop 300ms var(--ease-out); }
body.theme-pink .row[data-status="done"].pop    { animation: breathe-done-pink 1.6s ease-in-out infinite, pop 300ms var(--ease-out); }

/* ── auto 主题:跟随系统亮暗 ───────────────────────────────────── */
@media (prefers-color-scheme: light) {
  body.theme-auto {
    --row-bg: #F6D3DA;
    --row-bg-hover: #F0BFC9;
    --row-text: #4A1428;
    --project-color: #3A0E1E;
    --detail-color: rgba(75,20,40,0.68);
    --prompt-color: rgba(75,20,40,0.72);
    --meta-color: rgba(75,20,40,0.55);
    --meta-border: rgba(75,20,40,0.15);
    --row-border: rgba(75,20,40,0.12);
    --dismiss-bg: rgba(75,20,40,0.10);
    --ctx-warn: #A06200;
    --ctx-hot: #B02828;
  }
  body.theme-auto .row[data-status="waiting"] { animation-name: breathe-waiting-pink; }
  body.theme-auto .row[data-status="done"]    { animation-name: breathe-done-pink; }
}
</style>
</head>
<body>
<div id="stack"></div>
<button id="collapse-btn" aria-label="Toggle collapse">
  <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 10 L8 5 L13 10 L11.6 11.4 L8 7.8 L4.4 11.4 Z"/>
  </svg>
</button>
<script>
(function () {
  var stack = document.getElementById('stack');
  var SCALE_FACTORS = ${JSON.stringify(SCALES)};
  var ROW_H = ${ROW_H};

  var THEMES = {
    dark: {
      thinking:  { color: '#F59E0B', label: 'Working',   spin: true  },
      reading:   { color: '#3B82F6', label: 'Reading',   spin: true  },
      editing:   { color: '#FACC15', label: 'Editing',   spin: true  },
      writing:   { color: '#FACC15', label: 'Writing',   spin: true  },
      running:   { color: '#F97316', label: 'Running',   spin: true  },
      searching: { color: '#8B5CF6', label: 'Searching', spin: true  },
      done:      { color: '#22C55E', label: 'Done',      spin: false, glyph: '\\u2713' },
      error:     { color: '#EF4444', label: 'Error',     spin: false, glyph: '\\u2715' },
      waiting:   { color: '#F59E0B', label: '等待确认',  spin: true  },
    },
    pink: {
      thinking:  { color: '#B84068', label: 'Working',   spin: true  },
      reading:   { color: '#4060B8', label: 'Reading',   spin: true  },
      editing:   { color: '#A87800', label: 'Editing',   spin: true  },
      writing:   { color: '#A87800', label: 'Writing',   spin: true  },
      running:   { color: '#B84040', label: 'Running',   spin: true  },
      searching: { color: '#7048B0', label: 'Searching', spin: true  },
      done:      { color: '#289858', label: 'Done',      spin: false, glyph: '\\u2713' },
      error:     { color: '#C03040', label: 'Error',     spin: false, glyph: '\\u2715' },
      waiting:   { color: '#B84068', label: '等待确认',  spin: true  },
    },
  };
  THEMES.auto = THEMES.dark;
  var STATUS = Object.assign({}, THEMES.dark);

  var BRAILLE = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
  var brailleIdx = 0;
  var rows = {}; var order = [];
  var tickerB = null, tickerT = null;
  var curScaleFactor = SCALE_FACTORS.medium;
  var collapsed = false;

  function fmtElapsedParts(ms) {
    var s = Math.floor(ms / 1000);
    if (s < 60) return { main: s + 's', sub: '' };
    var m = Math.floor(s / 60); s = s % 60;
    if (m < 60) return { main: m + 'm', sub: ' ' + (s < 10 ? '0' : '') + s + 's' };
    var h = Math.floor(m / 60); m = m % 60;
    return { main: h + 'h', sub: ' ' + (m < 10 ? '0' : '') + m + 'm' };
  }
  function fmtElapsedHTML(ms) {
    var f = fmtElapsedParts(ms);
    return '<span class="t-main">' + f.main + '</span><span class="t-sub">' + f.sub + '</span>';
  }

  function anySpinning() {
    for (var id in rows) { var r = rows[id]; if (r && !r.removing) { var s = STATUS[r.data.status]; if (s && s.spin) return true; } }
    return false;
  }
  function anyRunning() { for (var id in rows) if (rows[id] && !rows[id].removing) return true; return false; }

  function startTickers() {
    if (!tickerB && anySpinning()) {
      tickerB = setInterval(function () {
        brailleIdx = (brailleIdx + 1) % BRAILLE.length;
        for (var id in rows) {
          var r = rows[id];
          if (r && !r.removing && r.el.dataset.spin === 'true') r.refs.glyph.textContent = BRAILLE[brailleIdx];
        }
        if (!anySpinning()) { clearInterval(tickerB); tickerB = null; }
      }, 80);
    }
    if (!tickerT && anyRunning()) {
      tickerT = setInterval(function () {
        for (var id in rows) {
          var r = rows[id]; if (!r || r.removing) continue;
          if (r.data.frozenElapsed != null || !r.data.startedAt) continue;
          r.refs.time.innerHTML = fmtElapsedHTML(Date.now() - r.data.startedAt);
        }
        if (!anyRunning()) { clearInterval(tickerT); tickerT = null; }
      }, 250);
    }
  }

  // 行 DOM 只建一次,后续全部经 refs 增量更新
  function buildRow(id) {
    var wrap = document.createElement('div'); wrap.className = 'row-wrap';
    var el = document.createElement('div'); el.className = 'row enter';
    el.setAttribute('data-id', id);
    var left = document.createElement('div'); left.className = 'slot left';
    var glyph = document.createElement('span'); glyph.className = 'glyph';
    var project = document.createElement('span'); project.className = 'project';
    left.appendChild(glyph); left.appendChild(project);
    var mid = document.createElement('div'); mid.className = 'slot mid';
    var task = document.createElement('span');
    mid.appendChild(task);
    var right = document.createElement('div'); right.className = 'slot right';
    var status = document.createElement('span'); status.className = 'status';
    var meta = document.createElement('div'); meta.className = 'meta';
    var time = document.createElement('span'); time.className = 'mono t-elapsed';
    var metaSep = document.createElement('span'); metaSep.textContent = '\\u00B7'; metaSep.style.opacity = '0.5';
    var ctx = document.createElement('span'); ctx.className = 'mono ctx';
    meta.appendChild(time); meta.appendChild(metaSep); meta.appendChild(ctx);
    var jump = document.createElement('span'); jump.className = 'jump'; jump.textContent = '\\u2197';
    right.appendChild(status); right.appendChild(meta); right.appendChild(jump);
    var dismiss = document.createElement('div'); dismiss.className = 'dismiss';
    dismiss.setAttribute('data-id', id); dismiss.textContent = '\\u00D7';
    el.appendChild(left); el.appendChild(mid); el.appendChild(right); el.appendChild(dismiss);
    wrap.appendChild(el);
    return { id: id, data: {}, wrap: wrap, el: el, removing: false,
             refs: { glyph: glyph, project: project, task: task, status: status,
                     meta: meta, time: time, metaSep: metaSep, ctx: ctx } };
  }

  function applyData(row) {
    var d = row.data, s = STATUS[d.status] || STATUS.thinking;
    var prevStatus = row.el.getAttribute('data-status');
    row.refs.glyph.style.color = s.color;
    row.refs.glyph.textContent = s.spin ? BRAILLE[brailleIdx] : (s.glyph || '\\u25CF');
    row.refs.project.textContent = d.project || '';
    row.refs.task.textContent = d.detail || d.prompt || '';
    row.refs.task.className = d.detail ? 'detail' : 'prompt';
    row.refs.status.textContent = s.label || '';
    row.refs.status.style.color = s.color;
    var hasTime = !!d.startedAt, hasCtx = d.ctxPct != null;
    row.refs.meta.style.display = (hasTime || hasCtx) ? 'flex' : 'none';
    row.refs.time.style.display = hasTime ? '' : 'none';
    if (hasTime) {
      var t = d.frozenElapsed != null ? d.frozenElapsed : (Date.now() - d.startedAt);
      row.refs.time.innerHTML = fmtElapsedHTML(t);
    }
    row.refs.metaSep.style.display = (hasTime && hasCtx) ? '' : 'none';
    row.refs.ctx.style.display = hasCtx ? '' : 'none';
    if (hasCtx) {
      row.refs.ctx.textContent = Math.round(d.ctxPct) + '%';
      row.refs.ctx.className = 'mono ctx ' + (d.ctxPct >= 85 ? 'ctx-hot' : d.ctxPct >= 60 ? 'ctx-warn' : '');
    }
    row.el.dataset.spin = s.spin ? 'true' : 'false';
    row.el.setAttribute('data-status', d.status || 'thinking');
    // 状态切到 done/waiting:一次性 pop 强调
    if (prevStatus && prevStatus !== d.status && (d.status === 'done' || d.status === 'waiting')) {
      row.el.classList.remove('pop'); void row.el.offsetWidth; row.el.classList.add('pop');
    }
  }

  function reflow() {
    var rowPx = ROW_H * curScaleFactor;
    for (var i = 0; i < order.length; i++) {
      var r = rows[order[i]]; if (!r) continue;
      r.wrap.style.transform = 'translateY(' + (i * rowPx) + 'px)';
      r.wrap.classList.toggle('not-first', i > 0);
      r.wrap.classList.toggle('last', i === order.length - 1);
    }
    stack.style.height = (order.length * rowPx) + 'px';
    scheduleReport();
  }

  function upsertRow(id, data) {
    var existing = rows[id];
    if (existing && !existing.removing) {
      existing.data = Object.assign({}, existing.data, data);
      applyData(existing); startTickers(); return;
    }
    var row = buildRow(id);
    row.data = Object.assign({}, data);
    if (!row.data.startedAt) row.data.startedAt = Date.now();
    rows[id] = row; order.push(id);
    stack.appendChild(row.wrap);
    applyData(row);
    reflow();
    requestAnimationFrame(function () { requestAnimationFrame(function () { row.el.classList.remove('enter'); }); });
    startTickers();
  }

  function removeRow(id) {
    var row = rows[id]; if (!row || row.removing) return;
    row.removing = true;
    row.el.classList.add('leaving');
    var i = order.indexOf(id); if (i >= 0) order.splice(i, 1);
    reflow(); // 下方行立即上滑补位,离场行原位淡出
    setTimeout(function () {
      if (row.wrap.parentNode) row.wrap.parentNode.removeChild(row.wrap);
      delete rows[id];
    }, 260);
  }

  function setScale(scale) {
    var f = SCALE_FACTORS[scale]; if (f == null) f = SCALE_FACTORS.medium;
    curScaleFactor = f;
    document.documentElement.style.setProperty('--scale', String(f));
    reflow();
  }

  function setTheme(theme) {
    document.body.classList.remove('theme-dark', 'theme-pink', 'theme-auto');
    document.body.classList.add('theme-' + theme);
    var t = THEMES[theme] || THEMES.dark;
    Object.assign(STATUS, t);
    for (var id in rows) { if (rows[id] && !rows[id].removing) applyData(rows[id]); }
  }

  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function (e) {
      if (document.body.classList.contains('theme-auto')) {
        THEMES.auto = e.matches ? THEMES.pink : THEMES.dark;
        Object.assign(STATUS, THEMES.auto);
        for (var id in rows) { if (rows[id] && !rows[id].removing) applyData(rows[id]); }
      }
    });
  }

  // ── 收起/展开 ─────────────────────────────────────────────────────
  function setCollapsed(state) {
    collapsed = state;
    document.body.classList.toggle('collapsed', collapsed);
    scheduleReport();
  }
  function toggleCollapse() {
    setCollapsed(!collapsed);
    if (window.islandHost && window.islandHost.send) {
      window.islandHost.send({ action: 'collapseChanged', collapsed: collapsed });
    }
  }
  var collapseBtn = document.getElementById('collapse-btn');
  if (collapseBtn) collapseBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleCollapse(); });

  // ── 命中区上报(整行可点跳转 + 收起手柄) ──────────────────────────
  function reportHitRects() {
    if (!window.islandHost || !window.islandHost.send) return;
    var rects = [];
    var cb = document.getElementById('collapse-btn');
    if (cb) {
      var cr = cb.getBoundingClientRect();
      if (cr.width > 0 && cr.height > 0) rects.push({ x: cr.left, y: cr.top, w: cr.width, h: cr.height });
    }
    if (!collapsed && order.length > 0) {
      var first = rows[order[0]], last = rows[order[order.length - 1]];
      if (first && last) {
        var fr = first.wrap.getBoundingClientRect(), lr = last.wrap.getBoundingClientRect();
        // 整行可点(点击=跳转,× 区域=删行),不再只是 × 右缘竖带
        rects.push({ x: fr.left, y: fr.top, w: fr.width, h: lr.bottom - fr.top });
      }
    }
    window.islandHost.send({ type: 'hitrects', rects: rects, dpr: window.devicePixelRatio || 1 });
  }
  var reportTimer = null;
  function scheduleReport() {
    reportHitRects();
    if (reportTimer) clearTimeout(reportTimer);
    reportTimer = setTimeout(reportHitRects, 400); // 过渡完成后再报一次终值
  }

  // ── 原生 WH_MOUSE_LL 钩子驱动的交互 ──────────────────────────────
  // 窗口在合成层整体穿透,DOM 收不到真实鼠标事件;host 把光标坐标(CSS px)
  // 转发进来:hover(x,y) 管高亮/×/↗ 显隐,hitClick(x,y) 分发点击。
  function dismissRow(id) {
    if (!id) return;
    if (window.islandHost && window.islandHost.send) window.islandHost.send({ type: 'dismiss', id: id });
    removeRow(id); // 乐观删除;companion 的 removeRow 广播幂等
  }

  var _hoverRow = null;
  function hover(x, y) {
    var el = (x >= 0 && y >= 0) ? document.elementFromPoint(x, y) : null;
    var row = (el && el.closest) ? el.closest('.row') : null;
    if (row === _hoverRow) return;
    if (_hoverRow) _hoverRow.classList.remove('hovered');
    _hoverRow = row;
    if (row) row.classList.add('hovered');
  }

  function hitClick(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el || !el.closest) return;
    if (el.closest('#collapse-btn')) { toggleCollapse(); return; }
    var dis = el.closest('.dismiss');
    if (dis) { dismissRow(dis.getAttribute('data-id')); return; }
    var rowEl = el.closest('.row');
    if (rowEl) {
      var id = rowEl.getAttribute('data-id');
      rowEl.classList.add('pressed');
      setTimeout(function () { rowEl.classList.remove('pressed'); }, 130);
      if (window.islandHost && window.islandHost.send) window.islandHost.send({ type: 'focus', id: id });
    }
  }

  window.island = {
    upsertRow: upsertRow,
    removeRow: removeRow,
    setScale: setScale,
    setTheme: setTheme,
    setCollapsed: setCollapsed,
    toggleCollapse: toggleCollapse,
    hover: hover,
    hitClick: hitClick
  };
})();
</script>
</body>
</html>`;
}
```

- [ ] **Step 2: 语法/套件验证** — `node.exe island/src/island-test.mjs` 0 失败(测试 0 覆盖新文件语法)。
- [ ] **Step 3: 视觉验收(demo + 截图,允许迭代)** — `node.exe island/src/bridge.mjs reload && node.exe island/src/demo-island.mjs`,查看 `~/island-demo-*.png`:行更大更醒目、底角圆润、动画顺滑、无品红描边。多行场景:手动再发 2 条不同 id 的 update(可用 `node.exe island/src/bridge.mjs eval ...` 或临时脚本),截图检查行间分隔线与最后一行圆角。**视觉不满意可在本任务内迭代 CSS 数值,结构与接口不得变。**
- [ ] **Step 4: Commit**

```bash
git add island/src/island.html.mjs
git commit -m "feat: island.html 全重写——transform 定位+增量渲染+新动效体系+整行命中(点击跳转/×删行),放大基准 540x40"
```

---

### Task 9: E2E 自驱回路 island-e2e.mjs + 删 _dbgclick.ps1

**Files:**
- Create: `island/src/island-e2e.mjs`
- Delete: `island/src/_dbgclick.ps1`

- [ ] **Step 1: 写 E2E 脚本** — 新建 `island/src/island-e2e.mjs`:

```js
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
  return execSync("powershell -NoProfile -NoLogo -EncodedCommand " +
    Buffer.from(script, "utf16le").toString("base64"),
    { encoding: "utf8", timeout: 20000, windowsHide: true }).trim();
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
  const npPid = Number(ps(String.raw`(Start-Process notepad -PassThru).Id`));
  await sleep(1200);
  const npHwnd = Number(psW(String.raw`
$p = Get-Process -Id ${npPid}
[void][W]::SetForegroundWindow($p.MainWindowHandle)
Write-Output ([int64]$p.MainWindowHandle)`));
  assert(npHwnd > 0, `notepad 启动 (hwnd=${npHwnd})`);
  await sleep(500);

  // 3) 发 captureFg update(此刻前台= notepad → companion 捕获其 hwnd)
  await sendMsg({
    id: "e2e-jump", type: "update", project: "e2e", status: "waiting",
    detail: "", prompt: "jump-test", startedAt: Date.now(), captureFg: true,
  });
  await sleep(1000);

  // 4) 最小化 notepad,确认前台已不是它
  psW(`[void][W]::ShowWindow([IntPtr]${npHwnd}, 6)`); // SW_MINIMIZE
  await sleep(800);
  const fgAfterMin = Number(psW(`Write-Output ([int64][W]::GetForegroundWindow())`));
  assert(fgAfterMin !== npHwnd, "notepad 已最小化让位");

  // 5) 点击行中部(避开 × 与中部留白都可,行任意非×处=跳转)
  const rect = islandRect();
  assert(!!rect && rect.h > 10, `岛窗口可见 (${rect ? rect.w + "x" + rect.h : "none"})`);
  const f = SCALES.medium;
  const rowCx = Math.round((rect.l + rect.r) / 2 - 100 * f); // 偏左 100px,稳避 × 与 meta
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
  ps(`Stop-Process -Id ${npPid} -Force -ErrorAction SilentlyContinue`);
  await sendMsg({ id: "e2e-jump", type: "remove" });

  console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 跑 E2E** — `node.exe island/src/island-e2e.mjs`,期望全部 ✓。失败时按 systematic-debugging 走:坐标偏移优先查 DPI(PerMonitorV2 后 GetWindowRect 为物理像素)与 hit-rect dpr 换算。
- [ ] **Step 3: 删 _dbgclick.ps1** — `rm island/src/_dbgclick.ps1`(逻辑已吸收进 WIN32 帮手)。
- [ ] **Step 4: Commit**

```bash
git add island/src/island-e2e.mjs
git commit -m "test: 跳转/×/隐藏 E2E 自驱回路(SendInput 真实桌面,吸收并替代 _dbgclick.ps1)"
```

---

### Task 10: Windows 侧 hooks 接入(原生 PowerShell/cmd CC)

**Files:**
- Modify: `C:/Users/Z/.claude/settings.json`(用户全局配置,先备份)

- [ ] **Step 1: 备份 + 写入**:

```bash
cp /mnt/c/Users/Z/.claude/settings.json /mnt/c/Users/Z/.claude/settings.json.bak.$(date +%Y%m%d_%H%M%S)
python3 - <<'EOF'
import json
p = '/mnt/c/Users/Z/.claude/settings.json'
d = json.load(open(p))
B = 'node C:/Users/Z/Desktop/claude-code-island/island/src/bridge.mjs '
mk = lambda cmd: [{"matcher": "", "hooks": [{"type": "command", "command": B + cmd}]}]
h = {'SessionStart': mk('on')}
for ev in ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'StopFailure', 'PermissionRequest', 'SessionEnd']:
    h[ev] = mk('hook')
d['hooks'] = h
json.dump(d, open(p, 'w'), ensure_ascii=False, indent=2)
print('hooks written:', list(h.keys()))
EOF
```

- [ ] **Step 2: 验证** — `python3 -c "import json; json.load(open('/mnt/c/Users/Z/.claude/settings.json'))" && echo OK`;链路冒烟:`echo '{"hook_event_name":"UserPromptSubmit","session_id":"native-smoke","cwd":"C:/tmp","prompt":"native"}' | node.exe island/src/bridge.mjs hook` → 岛上出现 native-smoke 行,再发 SessionEnd 摘除。**HITL:请用户开一个原生 PowerShell 的 Claude Code 会话确认上岛 + 跳转。**
- [ ] **Step 3: 无 commit**(用户配置不在仓库),CHANGELOG 在 Task 11 记录。

---

### Task 11: 文档同步 + 全量终验 + push

**Files:**
- Modify: `README.md`、`island/SKILL.md`、`CLAUDE.md`、`CHANGELOG.md`

- [ ] **Step 1: SKILL.md** — 行为节加「点击行跳转对应 CC 终端窗口(窗口级,UserPromptSubmit 时刻捕获前台;同窗多 pane 不区分)」「× 删行」「整行可点」;安装节补 Windows 原生宿主 hooks 配置(裸 `node`,8 事件,与 WSL 节对照);故障排查补 WebView2 缺失提示与「跳转无反应 → 该会话尚无 UserPromptSubmit 捕获」;尺寸基准更新(540×40@medium)。
- [ ] **Step 2: README.md** — 架构图:platform.mjs 移除、host 自定位、新协议命令(screens/captureFg/focusWindow/focus);行为节同步跳转/放大/动效;WSL2 提示框旁补原生宿主说明。
- [ ] **Step 3: CLAUDE.md** — 「平台分支集中在 platform.mjs」一条改写为「屏幕几何由 C# host 自解析(--screen),JS 侧无平台分支;platform.mjs 已删除」;常用命令补 `node island/src/island-e2e.mjs`(注明会动真实鼠标);架构图补 scales.mjs 与跳转链路一句。
- [ ] **Step 4: CHANGELOG.md** — Unreleased 下记录:Added(整行点击跳转全链路、scales.mjs、E2E 回路、Windows 侧 hooks 接入、PerMonitorV2、WM_DISPLAYCHANGE、--screen 自定位、SOCK env seam)、Changed(island.html 全重写:动效/放大/增量渲染;companion scale 感知尺寸+no-op 跳过;bridge captureFg/deleteSessionData;WebView2 提示)、Removed(platform.mjs、socketIds 死代码、_dbgclick.ps1)、Fixed(large/xlarge 窗口裁剪)。
- [ ] **Step 5: 全量终验** — `node.exe island/src/island-test.mjs`(0 失败)+ `node.exe island/src/island-e2e.mjs`(0 失败)+ `node.exe island/src/bridge.mjs reload` 后真实 WSL 会话观察上岛正常。
- [ ] **Step 6: Commit + push**

```bash
git add README.md island/SKILL.md CLAUDE.md CHANGELOG.md
git commit -m "docs: 同步 UI 重写/点击跳转/双宿主 hooks/兼容补齐 全部文档"
git push origin 0.0.1-dev
```

---

## 验收清单(对照 spec)

- [ ] spec §2:UserPromptSubmit→captureFg→hwnd 表→点击行→SetForegroundWindow 全链路(Task 3/4/7/8,E2E Task 9)
- [ ] spec §2:Windows 原生宿主 hooks(Task 10)
- [ ] spec §3:540×40 放大、新动效、inset 发光、增量渲染(Task 8)
- [ ] spec §4:PerMonitorV2、WM_DISPLAYCHANGE、--screen 自定位、screens 协议、WebView2 提示(Task 4/5/6)
- [ ] spec §5:scale 感知尺寸+no-op 跳过、socketIds、deleteSessionData、测试清理、_dbgclick.ps1(Task 3/7/9)
- [ ] spec §6:fake socket、captureFg 断言、host 协议测试、E2E 回路(Task 2/3/4/9)
- [ ] spec §7:README/SKILL/CLAUDE/CHANGELOG(Task 11)
