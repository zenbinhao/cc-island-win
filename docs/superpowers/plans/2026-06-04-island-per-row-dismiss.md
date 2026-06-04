# 灵动岛逐行手动消除（hover ×）+ 删除 idle-exit 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 灵动岛窗口改为永久常驻（删 60s idle-exit），并为每行加一个 hover 才显的 × 按钮，点击只消除该会话行。

**Architecture:** 复用现有四层管道。× 点击经 `window.islandHost.send` → C# host（`WebMessageReceived` 按 `type` 分流：`hitrects` host 本地消费供 `WM_NCHITTEST` 抠洞，`dismiss` 转发 stdout）→ `open-fixed` 的 `w.on("message")` → companion 删除状态并向所有窗口广播 `removeRow`。命中只放行胶囊右缘一条竖带（每窗 1 个由 WebView 上报的矩形），其余仍点击穿透。

**Tech Stack:** Node.js（companion / open-fixed / island.html 生成）、C# WinForms + WebView2（island-host）、.NET 8 SDK 重编 exe。

**约定（来自仓库 CLAUDE.md）：** 分支上工作；提交信息说明改了什么并以 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` 结尾；行为变更同步 README/SKILL/CHANGELOG。

**测试现实：** 本次改动落在守护进程 / 原生窗口 / HTML，`island-test.mjs`（驱动 bridge stdin→状态）覆盖不到 hover/点击/hit-test/DPI。自动化护栏 = `node --check`（语法）+ `node island/src/island-test.mjs`（回归，本次不改 bridge，应保持 13/0）。GUI 行为由**人在 Windows 实跑**确认，相关步骤标 **[HITL]**——agent 无法替用户移动鼠标 / 观察 hover。

---

## 前置条件

- [ ] **Step 0: 确认 .NET 8 SDK（Windows 侧）**

Run（Windows）: `dotnet --list-sdks`
Expected: 至少一行 `8.x.x`。若无：`winget install Microsoft.DotNet.SDK.8` 后重开终端。
（没有 SDK 则 Task 2 的重编 exe 无法进行。）

---

## Task 1: companion 删除 60s idle-exit

**Files:**
- Modify: `island/src/companion.mjs`（删 `idleTimer` / `scheduleIdleExit` / 两处调用）

- [ ] **Step 1: 删除 `idleTimer` 声明**

把 `island/src/companion.mjs` 中这一行删掉：

```js
let idleTimer = null;
```

（它在 `const activeRowIds = new Set();` 下一行。删除后保留上面的 `activeRowIds`。）

- [ ] **Step 2: 删除 `scheduleIdleExit` 函数**

删掉整段：

```js
function scheduleIdleExit() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    log("info", "all clients disconnected, exiting companion");
    cleanup();
    process.exit(0);
  }, 60000); // exit 60s after last client disconnects
}
```

- [ ] **Step 3: 删除 server 连接处理器里清 timer 的那行**

在 `const server = createServer((sock) => {` 内部，删掉：

```js
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
```

（保留它上面的 `socketIds.set(sock, new Set());` 和下面的 `log("info", \`client connected ...\`);`。）

- [ ] **Step 4: 删除 `sock.on("close")` 里的 idle 调度**

在 `sock.on("close", () => {` 内部，删掉：

```js
    if (clients.size === 0) scheduleIdleExit();
```

（保留它上面的 `log("info", \`client disconnected (total=${clients.size})\`);`。）

- [ ] **Step 5: 确认无残留引用**

Run: `grep -n "idleTimer\|scheduleIdleExit" island/src/companion.mjs`
Expected: 无输出（exit code 1）。

- [ ] **Step 6: 语法 + 回归**

Run: `node --check island/src/companion.mjs && node island/src/island-test.mjs`
Expected: `--check` 无输出；island-test 结尾打印 13 passed / 0 failed（退出码 0）。

- [ ] **Step 7: Commit**

```bash
git add island/src/companion.mjs
git commit -m "refactor: 删除 60s idle-exit，灵动岛窗口永久常驻

companion 不再在所有 socket 客户端断开 60s 后自杀，回归 README/SKILL/
顶部注释一直声称的『永久常驻』。整窗关闭仍由 /island kill 负责。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 逐行 × 可点 spike（× 常显，先打通链路）

**目的：** 在加 hover 美化前，先用「常显 ×」隔离验证三件事——命中条放行点击、点击触发 DOM onclick、dismiss 经 host 回到 companion 并跨窗删行。这是头号风险，必须先过。

**Files:**
- Modify: `island/src/hosts/windows/island-host.cs`（HitRects + WM_NCHITTEST + WebMessage 分流）
- Build: `island/src/hosts/windows/island-host-win.{exe,dll,deps.json,runtimeconfig.json}`（重编产物）
- Modify: `island/src/island.html.mjs`（× DOM + 命中条上报 + 点击委托）
- Modify: `island/src/companion.mjs`（抽 `removeRowById` + `w.on("message")`）

- [ ] **Step 1: host — IslandForm 增加命中矩形字段与 HTCLIENT 常量**

在 `island/src/hosts/windows/island-host.cs` 的 `sealed class IslandForm : Form` 内，把常量区：

```csharp
    const int WM_NCHITTEST  = 0x0084;
    const int HTTRANSPARENT = -1;
```

改为：

```csharp
    const int WM_NCHITTEST  = 0x0084;
    const int HTTRANSPARENT = -1;
    const int HTCLIENT      = 1;

    // Hittable rectangles in client pixels — set from WebView "hitrects" messages.
    // Only these regions receive clicks; the rest of the window stays click-through.
    public Rectangle[] HitRects = Array.Empty<Rectangle>();
```

- [ ] **Step 2: host — WM_NCHITTEST 改为按命中条放行**

把 `WndProc` 里这段：

```csharp
        if (m.Msg == WM_NCHITTEST && HitTestEnabled)
        {
            // Whole window is click-through: every mouse event passes to windows below.
            m.Result = (IntPtr)HTTRANSPARENT;
            return;
        }
```

替换为：

```csharp
        if (m.Msg == WM_NCHITTEST && HitTestEnabled)
        {
            // Click-through everywhere EXCEPT the reported hit rects (the × strip).
            var rects = HitRects;
            if (rects.Length > 0)
            {
                int sx = unchecked((short)(long)m.LParam);
                int sy = unchecked((short)((long)m.LParam >> 16));
                var pt = PointToClient(new Point(sx, sy));
                foreach (var r in rects)
                {
                    if (r.Contains(pt)) { m.Result = (IntPtr)HTCLIENT; return; }
                }
            }
            m.Result = (IntPtr)HTTRANSPARENT;
            return;
        }
```

- [ ] **Step 3: host — WebMessageReceived 按 type 分流**

把 `_webView.CoreWebView2.WebMessageReceived += (_, args) =>` 这个 lambda 体：

```csharp
            try
            {
                var raw = args.TryGetWebMessageAsString();
                if (raw == null) return;
                var msg = JsonNode.Parse(raw);
                if (msg?["__islandHost_close"]?.GetValue<bool>() == true)
                { CloseAndExit(); return; }

                var output = new JsonObject { ["type"] = "message" };
                output["data"] = JsonNode.Parse(raw);
                Stdout.Write(output);
            }
            catch { }
```

替换为：

```csharp
            try
            {
                var raw = args.TryGetWebMessageAsString();
                if (raw == null) return;
                var msg = JsonNode.Parse(raw);
                if (msg?["__islandHost_close"]?.GetValue<bool>() == true)
                { CloseAndExit(); return; }

                // hit rects are consumed locally (for WM_NCHITTEST), not forwarded
                if (msg?["type"]?.GetValue<string>() == "hitrects")
                { UpdateHitRects(msg!); return; }

                var output = new JsonObject { ["type"] = "message" };
                output["data"] = JsonNode.Parse(raw);
                Stdout.Write(output);
            }
            catch { }
```

- [ ] **Step 4: host — 新增 UpdateHitRects 方法**

在 `IslandHost` 类里，紧挨 `private void EmitReady()` 之前，加：

```csharp
    private void UpdateHitRects(JsonNode msg)
    {
        var arr = msg["rects"]?.AsArray();
        double dpr = msg["dpr"]?.GetValue<double>() ?? 1.0;
        if (arr == null) { Form.HitRects = Array.Empty<Rectangle>(); return; }
        var list = new List<Rectangle>(arr.Count);
        foreach (var r in arr)
        {
            if (r == null) continue;
            int x = (int)Math.Floor((r["x"]?.GetValue<double>() ?? 0) * dpr);
            int y = (int)Math.Floor((r["y"]?.GetValue<double>() ?? 0) * dpr);
            int w = (int)Math.Ceiling((r["w"]?.GetValue<double>() ?? 0) * dpr);
            int h = (int)Math.Ceiling((r["h"]?.GetValue<double>() ?? 0) * dpr);
            list.Add(new Rectangle(x, y, w, h));
        }
        Form.HitRects = list.ToArray();
    }
```

（`List<>`/`Rectangle`/`Math`/`Array` 在 `ImplicitUsings=enable` + `System.Drawing` 下均可用，无需加 using。）

- [ ] **Step 5: [HITL/Windows] 重编 exe**

Run（Windows，仓库根）: `node island/src/build.mjs`
Expected: 末行 `[claude-island] Built: ...island-host-win.exe`（退出码 0）。
失败排查：若报 `.NET 8 SDK not found` → 回到 Step 0 装 SDK。

- [ ] **Step 6: html — 渲染每行的 × 元素（spike 常显）**

在 `island/src/island.html.mjs` 的 `<style>` 里，`.meta` 规则之后加：

```css
.dismiss {
  position: absolute;
  right: calc(7px * var(--scale));
  top: 50%;
  transform: translateY(-50%);
  width: calc(16px * var(--scale));
  height: calc(16px * var(--scale));
  display: flex; align-items: center; justify-content: center;
  border-radius: 50%;
  font-size: calc(13px * var(--scale)); line-height: 1;
  color: var(--detail-color);
  background: rgba(255,255,255,0.12);
  cursor: pointer; pointer-events: auto;
}
```

在 `renderRowContent` 末尾，把这一行：

```js
    row.el.innerHTML = '<div class="slot left">'+left+'</div><div class="slot mid">'+mid+'</div><div class="slot right">'+right+'</div>';
```

改为：

```js
    var dismiss = '<div class="dismiss" data-id="'+esc(row.id)+'">&times;</div>';
    row.el.innerHTML = '<div class="slot left">'+left+'</div><div class="slot mid">'+mid+'</div><div class="slot right">'+right+'</div>'+dismiss;
```

- [ ] **Step 7: html — 命中条上报 + 点击委托**

在 IIFE 里 `var SCALES = ...;` 之后加一个 scale 因子追踪变量：

```js
  var curScaleFactor = SCALES.medium;
```

在 `setScale` 函数体内，`var factor=SCALES[scale]; if(factor==null)factor=SCALES.medium;` 之后加：

```js
    curScaleFactor = factor;
```

并在 `setScale` 末尾（设置完 `--scale` 之后）加：

```js
    scheduleReport();
```

在 `removeRow` 之后、`setScale` 之前，新增两个函数：

```js
  function reportHitRects() {
    if (!window.islandHost || !window.islandHost.send) return;
    var dpr = window.devicePixelRatio || 1;
    var wraps = stack.children;
    if (wraps.length === 0) { window.islandHost.send({ type:'hitrects', rects:[], dpr:dpr }); return; }
    var first = wraps[0].getBoundingClientRect();
    var last  = wraps[wraps.length-1].getBoundingClientRect();
    var stripW = 34 * curScaleFactor;
    var rect = { x: first.right - stripW, y: first.top, w: stripW, h: last.bottom - first.top };
    window.islandHost.send({ type:'hitrects', rects:[rect], dpr:dpr });
  }

  var reportTimer = null;
  function scheduleReport() {
    reportHitRects();
    if (reportTimer) clearTimeout(reportTimer);
    reportTimer = setTimeout(reportHitRects, 360);
  }
```

在 `upsertRow` 的**新行分支**末尾（`startTickers();` 之前的 `requestAnimationFrame(...)` 之后）加 `scheduleReport();`，即把：

```js
    requestAnimationFrame(function () { requestAnimationFrame(function () { el.classList.add('visible'); }); });
    startTickers();
```

改为：

```js
    requestAnimationFrame(function () { requestAnimationFrame(function () { el.classList.add('visible'); }); });
    scheduleReport();
    startTickers();
```

在 `removeRow` 函数体末尾（`setTimeout(...)` 那行之后）加：

```js
    scheduleReport();
```

在 `window.island = {...}` 那一行之前，挂上点击委托：

```js
  stack.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.dismiss') : null;
    if (!btn) return;
    var id = btn.getAttribute('data-id');
    if (!id) return;
    if (window.islandHost && window.islandHost.send) window.islandHost.send({ type:'dismiss', id:id });
    removeRow(id);   // optimistic; companion 的 removeRow 广播是幂等的
  });
```

- [ ] **Step 8: companion — 抽出 removeRowById 并复用**

在 `island/src/companion.mjs` 的 `syncHeight` 函数之后，新增：

```js
function removeRowById(id) {
  activeRowIds.delete(id);
  currentRows.delete(id);
  syncHeight();
  send('window.island.removeRow(' + JSON.stringify(id) + ')');
}
```

把 socket 的 remove 分支：

```js
    if (msg.type === "remove") {
      if (!msg.id) return;
      activeRowIds.delete(msg.id);
      currentRows.delete(msg.id);
      syncHeight();
      log("info", `remove id=${msg.id}`);
      send('window.island.removeRow(' + JSON.stringify(msg.id) + ')');
      return;
    }
```

改为：

```js
    if (msg.type === "remove") {
      if (!msg.id) return;
      log("info", `remove id=${msg.id}`);
      removeRowById(msg.id);
      return;
    }
```

- [ ] **Step 9: companion — 窗口监听 host 回传的 dismiss**

在窗口创建循环里（`w.on("error", ...)` 之后）加：

```js
  w.on("message", (data) => {
    if (!data || typeof data !== "object") return;
    if (data.type === "dismiss" && typeof data.id === "string" && data.id) {
      log("info", `dismiss id=${data.id}`);
      removeRowById(data.id);
    }
  });
```

- [ ] **Step 10: 语法检查**

Run: `node --check island/src/companion.mjs && node --check island/src/island.html.mjs`
Expected: 无输出（两者退出码 0）。

- [ ] **Step 11: [HITL/Windows] 实跑验证回传链路**

在 Windows 上：
1. `/island reload`（重启 companion，加载新 exe + 新 HTML）。
2. 造一行测试行（任选其一）：
   - 在任意 Claude Code pane 里发条消息（出现 thinking 行）；或
   - 终端跑：`echo {"hook_event_name":"UserPromptSubmit","session_id":"spike1","prompt":"spike","cwd":"C:/tmp"} | node island/src/bridge.mjs hook`
3. 看到胶囊行右缘有个常显的 ×。把光标移过去、点击它。
4. `tail` 日志：`Get-Content $HOME\.claude\claude-island.log -Tail 20`

Expected（四件事全中才算通过）：
- 鼠标在 × 上是「可点」光标（命中条放行成功）；
- 点击后该行消失；
- 日志出现 `dismiss id=spike1`（消息到达 companion）；
- 多屏时（若 `screen all`）所有屏该行同时消失。

不通时的判定与回退：
- 点了没反应、日志无 `dismiss` → 命中区没放行或点击没进 DOM。先确认日志有没有 `update id=spike1`（行确实建出来了）。再考虑回退到 host 侧原生 `WM_LBUTTONDOWN` 按 y 算行（重拾原生点击；尽量不走，先排查 DPI：见下）。
- × 可见但点击位置偏移（点旁边才触发）→ DPI 缩放问题。临时把 Windows 显示缩放设 100% 复测以确认是 DPI；是则在 `reportHitRects` 上报值或 C# 换算处校正。

- [ ] **Step 12: [HITL/Windows] 重编产物 + 提交**

链路通过后提交（含重编的 exe 产物；`.pdb` 与 WebView2 `*.xml` 已被 `.gitignore` 排除）：

```bash
git add island/src/hosts/windows/island-host.cs \
        island/src/hosts/windows/island-host-win.exe \
        island/src/hosts/windows/island-host-win.dll \
        island/src/hosts/windows/island-host-win.deps.json \
        island/src/hosts/windows/island-host-win.runtimeconfig.json \
        island/src/island.html.mjs \
        island/src/companion.mjs
git commit -m "feat: 逐行 × 手动消除（spike：× 常显，打通点击回传链路）

WM_NCHITTEST 改为只放行 WebView 上报的命中条（胶囊右缘竖带），× 点击经
window.islandHost.send → host(WebMessageReceived 按 type 分流) → open-fixed
w.on(message) → companion removeRowById 跨窗广播删行。重编 island-host-win.exe。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: × 改为 hover 才显 + 右侧内容让位（纯 CSS，无需重编）

**Files:**
- Modify: `island/src/island.html.mjs`（只动 `.dismiss` 相关 CSS）

- [ ] **Step 1: × 默认隐藏、hover 淡入**

把 Task 2 加的 `.dismiss` 规则中：

```css
  color: var(--detail-color);
  background: rgba(255,255,255,0.12);
  cursor: pointer; pointer-events: auto;
}
```

改为：

```css
  color: var(--detail-color);
  background: rgba(255,255,255,0.12);
  cursor: pointer; pointer-events: auto;
  opacity: 0;
  transition: opacity 140ms ease, background 140ms ease;
}
.row:hover .dismiss { opacity: 0.85; }
.dismiss:hover { opacity: 1; background: rgba(255,255,255,0.2); }
.row:hover .slot.right { opacity: 0.25; transition: opacity 140ms ease; }
```

（`.row:hover` 仅在光标进入右缘命中条时触发——那正是 × 所在处，所以「移到行右缘 → 该行 × 淡入、右侧 Done/耗时让位」。命中条外的行体仍穿透、收不到 hover，符合预期。）

- [ ] **Step 2: 语法检查**

Run: `node --check island/src/island.html.mjs`
Expected: 无输出（退出码 0）。

- [ ] **Step 3: [HITL/Windows] 验证 hover 交互**

`/island reload` 后（无需重编 exe，HTML 在 companion 启动时重新生成）：
- 光标不在行上时：看不到 ×；
- 光标移到某行右缘：该行 × 淡入、右侧 Done/耗时变淡；移开恢复；
- 点击淡入的 × → 该行消失、日志 `dismiss id=...`。

Expected: 上述全部成立。
不成立（hover 不出 ×）→ mousemove 没送达 WebView：确认 Task 2 的命中条仍在上报（日志/行为正常），必要时把 `stripW` 调宽（如 `40 * curScaleFactor`）增大命中目标后复测。

- [ ] **Step 4: Commit**

```bash
git add island/src/island.html.mjs
git commit -m "feat: 逐行 × 改为 hover 才显，hover 时右侧元信息让位

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 文档同步

**Files:**
- Modify: `README.md`（行为节）
- Modify: `island/SKILL.md`（行为节）
- Modify: `CHANGELOG.md`（[Unreleased]）

- [ ] **Step 1: README 行为节**

在 `README.md` 中，定位以 `- **状态保留**:` 开头的那条，在其**后面**插入一行：

```markdown
- **逐行消除**: 光标移到某行右缘会浮现 × 按钮，点击即从所有屏幕移除该会话行；行只被「下一个事件覆盖」或「× 手动消除」移除，无定时自动消失
```

`README.md` 中以 `- **永久常驻**:` 开头的那条无需改文字（删 idle-exit 后它已属实）。

- [ ] **Step 2: SKILL 行为节**

在 `island/SKILL.md` 中，定位以 `- **状态保留**` 开头的那条（commit 0c91215 加入），在其后插入同样一行：

```markdown
- **逐行消除**: 光标移到某行右缘会浮现 × 按钮，点击即从所有屏幕移除该会话行；行只被「下一个事件覆盖」或「× 手动消除」移除，无定时自动消失。整窗关闭仍用 `/island kill`。
```

若 `island/SKILL.md` 行为/常驻描述中提到「60 秒后自动退出 / idle 退出」之类，改为「永久常驻，需 `/island kill` 关闭」。（若无此类描述则跳过。）

- [ ] **Step 3: CHANGELOG**

在 `CHANGELOG.md` 的 `## [Unreleased]` 下，`### Added` 末尾加：

```markdown
- **逐行 × 手动消除**: 灵动岛每行新增一个 hover 才显的 × 按钮，点击只移除该会话行（跨所有屏幕同步移除）。× 点击经 `window.islandHost.send({type:"dismiss",id})` → C# host(`WebMessageReceived` 按 `type` 分流) → `open-fixed` 的 `w.on("message")` → companion `removeRowById` 广播 `removeRow`。为让穿透窗上的 × 可点，`WM_NCHITTEST` 改为只放行 WebView 上报的命中条（胶囊右缘竖带，`hitrects` 消息由 host 本地消费、按 `devicePixelRatio` 换算到客户区），其余仍整窗穿透。重编并提交 `island-host-win.exe`。
```

在 `### Changed` 末尾加：

```markdown
- **删除 60s idle-exit**: `companion.mjs` 不再在所有 socket 客户端断开满 60 秒后自杀。此前每个 hook 由 bridge 连接/断开一次，「全部 pane 静默 60s」会触发整窗退出，与 README/SKILL/companion 顶部注释一直声称的「永久常驻」矛盾；现删除该计时器，窗口真正永久常驻，整窗关闭只由 `/island kill` 负责。配合新增的逐行 × 手动消除，灵动岛成为一块「只由人手动清理」的持续看板（无任何定时自动消失：done-retract / ROW_TTL 早已删除，idle-exit 此次删除）。
```

- [ ] **Step 4: Commit**

```bash
git add README.md island/SKILL.md CHANGELOG.md
git commit -m "docs: 同步逐行 × 手动消除与 idle-exit 删除

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 收尾验证（verification-before-completion）

- [ ] **Step 1: 语法 + 回归**

Run: `node --check island/src/companion.mjs && node --check island/src/island.html.mjs && node --check island/src/bridge.mjs && node island/src/island-test.mjs`
Expected: `--check` 全无输出；island-test 结尾 13 passed / 0 failed（退出码 0）。

- [ ] **Step 2: 确认重编产物已入库**

Run: `git status --porcelain island/src/hosts/windows/`
Expected: 无输出（exe/dll/deps/runtimeconfig 已提交；`.pdb`、`*.xml` 被 ignore 不出现）。

- [ ] **Step 3: 确认无残留引用**

Run: `grep -rn "idleTimer\|scheduleIdleExit\|done-retract\|ROW_TTL\|doneTimers" island/src/`
Expected: 无输出。

- [ ] **Step 4: [HITL/Windows] 端到端最终确认**

多 pane 下：一个 pane 跑到 done、一个停在等待确认；hover 各自右缘点 × 分别消掉；确认窗口不再 60s 自动消失（静默 >60s 仍在）；`/island kill` 能整窗关闭。

Expected: 全部符合。

---

## Self-Review（计划对照 spec）

- **idle-exit 删除** → Task 1 ✓
- **逐行 × 回传链路（host 分流 / open-fixed / companion 广播）** → Task 2 ✓
- **hitrects host 本地消费、dismiss 转发** → Task 2 Step 3-4 ✓
- **WM_NCHITTEST 命中条 + DPI(dpr 换算)** → Task 2 Step 1-2-4 ✓
- **hover 才显** → Task 3 ✓
- **跨窗广播 removeRow** → Task 2 Step 8（`removeRowById` 用 `send()` 广播）✓
- **重编并提交 exe** → Task 2 Step 5/12 ✓
- **维持无 TTL** → 不新增任何计时器；Task 5 Step 3 grep 确认 ✓
- **文档（README/SKILL/CHANGELOG）** → Task 4 ✓
- **回归 island-test 13/0** → Task 1 Step 6、Task 5 Step 1 ✓
- **HITL 风险验证（点击进 DOM / hover / DPI）** → Task 2 Step 11、Task 3 Step 3 ✓

无占位符；类型/命名一致（`removeRowById`、`HitRects`、`UpdateHitRects`、`reportHitRects`/`scheduleReport`/`curScaleFactor` 全程一致）。
