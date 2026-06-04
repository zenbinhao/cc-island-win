# 灵动岛逐行手动消除（hover ×）+ 完成 idle-exit 移除 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为灵动岛每行加一个 hover 才显的 × 按钮（点击只消除该会话行），并顺带修两个并发「收起/展开」功能引入的问题：① 残留的 idle-exit 调用点导致 companion 崩溃；② 收起按钮无 hit-test 而点不动。

**Architecture:** 复用四层管道。× 点击经 `window.islandHost.send({type:"dismiss",id})` → C# host（`WebMessageReceived` 按 `type` 分流：`hitrects` host 本地消费供 `WM_NCHITTEST` 抠洞，其余转发 stdout）→ `open-fixed` 的 `w.on("message")` → companion **扩展现有** handler 加 `dismiss` 分支 → `removeRowById` 向所有窗口广播 `removeRow`。命中放行两类矩形：**收起按钮 + 逐行 × 右缘竖带**（WebView 上报，收起态只报按钮）。

**Tech Stack:** Node.js（companion / open-fixed / island.html 生成）、C# WinForms + WebView2（island-host）、.NET 8 SDK 重编 exe。

**⚠️ 并发协调（必读）：** 另一实例已在 plan 提交后落地「收起/展开」（commits `ce16612`…`1ea4c8e`）。后果：(a) **当前 HEAD 是坏的**——idle-exit 的声明/函数已被删但漏删两个调用点（`companion.mjs:209`/`:272`），引用已不存在的 `idleTimer`/`scheduleIdleExit` → `ReferenceError` → companion 一连接就崩；(b) 收起按钮**点不动**（`island-host.cs` 没动、整窗仍穿透）；(c) companion 已有 `w.on("message")`（处理 collapse）→ 本计划**扩展**它而非新增。所有 old_string 已对齐当前真实文件。

**约定（CLAUDE.md，已更新）：** 在 `*-dev` 分支工作；提交信息说明改了什么、以 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` 结尾；**验证完成后直接 push 到远端 `0.0.1-dev`，master 仅用户操作**；行为变更同步 README/SKILL/CHANGELOG。

**测试现实：** 改动落在守护进程 / 原生窗口 / HTML，`island-test.mjs` 覆盖不到 hover/点击/hit-test/DPI（且 `--check` 查不出 Task 1 那种运行时 `ReferenceError`）。自动化护栏 = `node --check` + `node island/src/island-test.mjs`（应保持 13/0）。GUI 行为由**人在 Windows 实跑**确认，相关步骤标 **[HITL]**。

---

## 前置条件（已满足）

- [ ] **Step 0: .NET 8 SDK** — 已确认 Windows 侧 `dotnet --list-sdks` 为 `8.0.421`，可重编 exe。无需安装。

---

## Task 1: 修复残留 idle-exit 调用点（崩溃修复 + 完成永久常驻）

**说明：** idle-exit 的 `let idleTimer` 声明与 `scheduleIdleExit()` 函数已被收起改动删除，但漏删两个调用点，引用已不存在的符号导致 `ReferenceError` 崩溃。本任务删掉这两行残留即可。

**Files:**
- Modify: `island/src/companion.mjs`（删 2 行残留）

- [ ] **Step 1: 删除连接处理器里的残留**

在 `island/src/companion.mjs` 的 `const server = createServer((sock) => {` 内部，删掉这一行（当前在 `socketIds.set(sock, new Set());` 与 `log("info", \`client connected ...\`)` 之间）：

```js
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
```

- [ ] **Step 2: 删除 sock.close 里的残留**

在 `sock.on("close", () => {` 内部，删掉这一行（当前在 `log("info", \`client disconnected (total=${clients.size})\`)` 之后、是该回调最后一条语句）：

```js
    if (clients.size === 0) scheduleIdleExit();
```

- [ ] **Step 3: 确认无残留引用**

Run: `grep -n "idleTimer\|scheduleIdleExit" island/src/companion.mjs`
Expected: 无输出（exit code 1）。

- [ ] **Step 4: 语法 + 回归**

Run: `node --check island/src/companion.mjs && node island/src/island-test.mjs`
Expected: `--check` 无输出；island-test 结尾 13 passed / 0 failed（退出码 0）。

- [ ] **Step 5: Commit**

```bash
git add island/src/companion.mjs && git commit -m "fix: 删除收起改动遗留的 idle-exit 调用点（修 companion 崩溃）

收起/展开改动删掉了 idleTimer 声明与 scheduleIdleExit() 函数，却漏删
companion.mjs 中两个调用点（连接处理器、sock.close），引用已不存在的符号
→ ReferenceError → companion 一连接即崩。删除残留两行，完成 idle-exit 移除，
窗口真正永久常驻，整窗关闭仍由 /island kill 负责。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: 自检** — `git diff HEAD~1 -- island/src/companion.mjs` 应只删这两行，别无改动。

---

## Task 2: 逐行 × 可点 + 收起按钮可点 spike（× 常显，打通链路）

**目的：** 先用「常显 ×」隔离验证头号风险——命中区放行点击、点击触发 DOM onclick、消息回到 companion。这一步同时让**收起按钮也变可点**（hitrects 含其矩形）。hover 美化放 Task 3。

**Files:**
- Modify: `island/src/hosts/windows/island-host.cs`（HitRects + WM_NCHITTEST + WebMessage 分流）
- Build: `island/src/hosts/windows/island-host-win.{exe,dll,deps.json,runtimeconfig.json}`（重编产物）
- Modify: `island/src/island.html.mjs`（× DOM + hitrects 上报 + 点击委托）
- Modify: `island/src/companion.mjs`（抽 `removeRowById` + 扩展 `w.on("message")`）

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

- [ ] **Step 2: host — WM_NCHITTEST 改为按命中矩形放行**

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
            // Click-through everywhere EXCEPT the reported hit rects (× strip + collapse btn).
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

                // hit rects are consumed locally (for WM_NCHITTEST), not forwarded.
                // Everything else (dismiss, collapseChanged) is forwarded to companion.
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

- [ ] **Step 5: [Windows] 重编 exe**

Run（Windows，仓库根；agent 可经 WSL interop 用 `node.exe`）: `node island/src/build.mjs`（或 `node.exe island/src/build.mjs`）
Expected: 末行 `[claude-island] Built: ...island-host-win.exe`（退出码 0）。

- [ ] **Step 6: html — 渲染每行的 × 元素（spike 常显）**

在 `island/src/island.html.mjs` 的 `<style>` 里，`.ctx-hot  { color: var(--ctx-hot); }` 之后（`.meta` 规则区结束处）加：

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

- [ ] **Step 7: html — scale 因子追踪 + 上报接入**

把 `var SCALES = { small: 0.88, medium: 1.0, large: 1.18, xlarge: 1.35 };` 这一行后面加一行：

```js
  var curScaleFactor = SCALES.medium;
```

把 `setScale` 整行：

```js
  function setScale(scale) { var factor=SCALES[scale]; if(factor==null)factor=SCALES.medium; document.documentElement.style.setProperty('--scale',String(factor)); }
```

改为：

```js
  function setScale(scale) { var factor=SCALES[scale]; if(factor==null)factor=SCALES.medium; curScaleFactor=factor; document.documentElement.style.setProperty('--scale',String(factor)); scheduleReport(); }
```

在 `upsertRow` 新行分支，把：

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

把 `removeRow` 整个函数：

```js
  function removeRow(id) {
    var row = rows[id]; if (!row||row.removing) return;
    row.removing = true; row.el.classList.remove('visible');
    setTimeout(function () { if (row.wrap.parentNode) row.wrap.parentNode.removeChild(row.wrap); delete rows[id]; var i=order.indexOf(id); if(i>=0)order.splice(i,1); }, 340);
  }
```

改为（末尾加 `scheduleReport()`）：

```js
  function removeRow(id) {
    var row = rows[id]; if (!row||row.removing) return;
    row.removing = true; row.el.classList.remove('visible');
    setTimeout(function () { if (row.wrap.parentNode) row.wrap.parentNode.removeChild(row.wrap); delete rows[id]; var i=order.indexOf(id); if(i>=0)order.splice(i,1); }, 340);
    scheduleReport();
  }
```

- [ ] **Step 8: html — setCollapsed 末尾接入上报 + 点击委托 + reportHitRects/scheduleReport**

把 `setCollapsed` 整个函数：

```js
  function setCollapsed(state) {
    collapsed = state;
    if (collapsed) {
      document.body.classList.add('collapsed');
    } else {
      document.body.classList.remove('collapsed');
    }
  }
```

改为（末尾加 `scheduleReport()`）：

```js
  function setCollapsed(state) {
    collapsed = state;
    if (collapsed) {
      document.body.classList.add('collapsed');
    } else {
      document.body.classList.remove('collapsed');
    }
    scheduleReport();
  }
```

在 `window.island = {` 这一行**之前**，插入上报函数 + 点击委托（此处 `collapsed`、`stack`、`removeRow`、`#collapse-btn` 均已在作用域内）：

```js
  // ── Hit rects (× strip + collapse button) reported to native host ──────
  function reportHitRects() {
    if (!window.islandHost || !window.islandHost.send) return;
    var dpr = window.devicePixelRatio || 1;
    var rects = [];
    var cb = document.getElementById('collapse-btn');
    if (cb) {
      var cr = cb.getBoundingClientRect();
      if (cr.width > 0 && cr.height > 0) rects.push({ x:cr.left, y:cr.top, w:cr.width, h:cr.height });
    }
    if (!collapsed) {
      var wraps = stack.children;
      if (wraps.length > 0) {
        var first = wraps[0].getBoundingClientRect();
        var last  = wraps[wraps.length-1].getBoundingClientRect();
        var stripW = 34 * curScaleFactor;
        rects.push({ x: first.right - stripW, y: first.top, w: stripW, h: last.bottom - first.top });
      }
    }
    window.islandHost.send({ type:'hitrects', rects:rects, dpr:dpr });
  }

  var reportTimer = null;
  function scheduleReport() {
    reportHitRects();
    if (reportTimer) clearTimeout(reportTimer);
    reportTimer = setTimeout(reportHitRects, 360);
  }

  // ── Per-row × dismiss (delegated click; only hittable on the right-edge strip) ──
  stack.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.dismiss') : null;
    if (!btn) return;
    var id = btn.getAttribute('data-id');
    if (!id) return;
    if (window.islandHost && window.islandHost.send) window.islandHost.send({ type:'dismiss', id:id });
    removeRow(id);   // optimistic; companion 的 removeRow 广播是幂等的
  });

```

- [ ] **Step 9: companion — 抽出 removeRowById 并复用**

在 `island/src/companion.mjs` 的 `syncHeight` 函数（`function syncHeight() { ... }`）**之后**，新增：

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

- [ ] **Step 10: companion — 扩展现有 w.on("message") 加 dismiss 分支**

把窗口循环里**已存在**的：

```js
  w.on("message", (data) => {
    // Handle messages from WebView (e.g., collapse button clicks)
    if (data && data.action === "collapseChanged") {
      isCollapsed = data.collapsed;
      log("info", `collapse state changed: ${isCollapsed}`);
      syncHeight();
    }
  });
```

改为：

```js
  w.on("message", (data) => {
    // Handle messages from WebView (collapse button, per-row dismiss)
    if (!data || typeof data !== "object") return;
    if (data.action === "collapseChanged") {
      isCollapsed = data.collapsed;
      log("info", `collapse state changed: ${isCollapsed}`);
      syncHeight();
    } else if (data.type === "dismiss" && typeof data.id === "string" && data.id) {
      log("info", `dismiss id=${data.id}`);
      removeRowById(data.id);
    }
  });
```

- [ ] **Step 11: 语法检查**

Run: `node --check island/src/companion.mjs && node --check island/src/island.html.mjs`
Expected: 无输出（两者退出码 0）。

- [ ] **Step 12: [HITL/Windows] 实跑验证（× 删行 + 收起按钮可点）**

在 Windows 上：
1. `/island reload`（重启 companion，加载新 exe + 新 HTML）。
2. 造一行：`echo {"hook_event_name":"UserPromptSubmit","session_id":"spike1","prompt":"spike","cwd":"C:/tmp"} | node island/src/bridge.mjs hook`（或在某 pane 发条消息）。
3. 胶囊行右缘有常显 ×，移过去点击它。
4. 点击底部中央小尖尖（▲）。
5. 看日志：`Get-Content $HOME\.claude\claude-island.log -Tail 20`。

Expected：
- × 处是「可点」光标；点击后该行消失；日志 `dismiss id=spike1`；多屏则各屏同消。
- **收起按钮现在能点了**：点 ▲ 收起（窗口缩到 30px、行折叠）、▼ 展开；日志 `collapse state changed: true/false`。

不通时排查：日志有无 `update id=spike1`（行建出来没）；× 点偏 → DPI（临时设 100% 缩放复测，是则在 `reportHitRects` 或 C# 换算处校正）；都不行再考虑 host 侧 `WM_LBUTTONDOWN`（尽量不走）。

- [ ] **Step 13: [Windows] 重编产物 + 提交**

链路通过后提交（含重编 exe 产物；`.pdb`/`*.xml` 已被 `.gitignore` 排除）：

```bash
git add island/src/hosts/windows/island-host.cs \
        island/src/hosts/windows/island-host-win.exe \
        island/src/hosts/windows/island-host-win.dll \
        island/src/hosts/windows/island-host-win.deps.json \
        island/src/hosts/windows/island-host-win.runtimeconfig.json \
        island/src/island.html.mjs \
        island/src/companion.mjs
git commit -m "feat: 逐行 × 手动消除 + 顺带修好收起按钮可点（spike：× 常显）

WM_NCHITTEST 改为只放行 WebView 上报的命中矩形（逐行 × 右缘竖带 + 收起按钮），
× 点击经 window.islandHost.send → host(按 type 分流) → open-fixed w.on(message)
→ companion removeRowById 跨窗广播删行；扩展现有 message handler 加 dismiss 分支。
收起按钮因共享同一 hit-test 而首次变得可点。重编 island-host-win.exe。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: × 改为 hover 才显 + 右侧内容让位（纯 CSS，无需重编）

**Files:**
- Modify: `island/src/island.html.mjs`（只动 `.dismiss` 相关 CSS）

- [ ] **Step 1: × 默认隐藏、hover 淡入**

把 Task 2 加的 `.dismiss` 规则尾部：

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

（`.row:hover` 仅在光标进入右缘命中条时触发——那正是 × 所在处。命中条外的行体仍穿透、收不到 hover，符合预期。）

- [ ] **Step 2: 语法检查**

Run: `node --check island/src/island.html.mjs`
Expected: 无输出（退出码 0）。

- [ ] **Step 3: [HITL/Windows] 验证 hover 交互**

`/island reload` 后（无需重编 exe）：
- 光标不在行右缘时看不到 ×；移到行右缘 → 该行 × 淡入、右侧 Done/耗时变淡；移开恢复；
- 点击淡入的 × → 该行消失、日志 `dismiss id=...`；
- 收起按钮 hover/点击仍正常。

Expected: 全部成立。不出 × → 命中条没上报或 mousemove 没送达，必要时把 `stripW` 调宽（`40 * curScaleFactor`）复测。

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

在 `README.md` 中，定位以 `- **状态保留**:` 开头的那条，在其**后面**插入一行（注意它下面已有「收起/展开」一条，插在「状态保留」与「收起/展开」之间）：

```markdown
- **逐行消除**: 光标移到某行右缘会浮现 × 按钮，点击即从所有屏幕移除该会话行；行只被「下一个事件覆盖」或「× 手动消除」移除，无定时自动消失
```

- [ ] **Step 2: SKILL 行为节**

在 `island/SKILL.md` 中，定位以 `- **状态保留**` 开头的那条，在其后插入：

```markdown
- **逐行消除**: 光标移到某行右缘会浮现 × 按钮，点击即从所有屏幕移除该会话行；行只被「下一个事件覆盖」或「× 手动消除」移除，无定时自动消失。整窗关闭仍用 `/island kill`。
```

- [ ] **Step 3: CHANGELOG**

在 `CHANGELOG.md` 的 `## [Unreleased]` 下，`### Added` 末尾加：

```markdown
- **逐行 × 手动消除**: 灵动岛每行新增一个 hover 才显的 × 按钮，点击只移除该会话行（跨所有屏幕同步移除）。链路：`window.islandHost.send({type:"dismiss",id})` → C# host(`WebMessageReceived` 按 `type` 分流，`hitrects` 本地消费、其余转发) → `open-fixed` 的 `w.on("message")` → companion 扩展现有 handler 调 `removeRowById` 广播 `removeRow`。为让穿透窗上的 × 可点，`island-host.cs` 的 `WM_NCHITTEST` 改为只放行 WebView 上报的命中矩形（逐行 × 右缘竖带 + 收起按钮，按 `devicePixelRatio` 换算到客户区），其余仍整窗穿透。**顺带修好了收起按钮**：它此前因无 hit-test 而点不动，现共享同一命中机制后首次可点。重编并提交 `island-host-win.exe`。
```

在 `## [Unreleased]` 下新增（或追加到已有的）`### Fixed` 小节：

```markdown
### Fixed
- **companion 因 idle-exit 残留调用点崩溃**: 「收起/展开」改动删除了 `idleTimer` 声明与 `scheduleIdleExit()` 函数，却漏删 `companion.mjs` 中两个调用点（连接处理器、`sock.close`），引用已不存在的符号 → `ReferenceError` → companion 在第一个客户端连接时即崩溃退出（`node --check` 查不出此类运行时错误）。删除残留两行，完成 idle-exit 移除：窗口真正永久常驻，整窗关闭只由 `/island kill` 负责（无任何定时自动消失：done-retract / ROW_TTL / idle-exit 均已清除）。
```

- [ ] **Step 4: Commit**

```bash
git add README.md island/SKILL.md CHANGELOG.md
git commit -m "docs: 同步逐行 × 手动消除、收起按钮修复与 idle-exit 残留修复

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 收尾验证 + 推送（verification-before-completion）

- [ ] **Step 1: 语法 + 回归**

Run: `node --check island/src/companion.mjs && node --check island/src/island.html.mjs && node --check island/src/bridge.mjs && node island/src/island-test.mjs`
Expected: `--check` 全无输出；island-test 结尾 13 passed / 0 failed。

- [ ] **Step 2: 确认重编产物已入库**

Run: `git status --porcelain island/src/hosts/windows/`
Expected: 无输出（exe/dll/deps/runtimeconfig 已提交；`.pdb`、`*.xml` 被 ignore 不出现）。

- [ ] **Step 3: 确认无残留引用**

Run: `grep -rn "idleTimer\|scheduleIdleExit\|done-retract\|ROW_TTL\|doneTimers" island/src/`
Expected: 无输出。

- [ ] **Step 4: [HITL/Windows] 端到端最终确认**

多 pane 下：一个 pane 跑到 done、一个停在等待确认；hover 各自右缘点 × 分别消掉；收起按钮 ▲/▼ 正常；确认窗口不再自动消失（静默 >60s 仍在、且不再崩）；`/island kill` 能整窗关闭。

Expected: 全部符合。

- [ ] **Step 5: 推送到远端 *-dev**

按 CLAUDE.md 新约定，验证完成后推送：

Run: `git push origin 0.0.1-dev`
Expected: 推送成功。（master 不动，仅用户操作。）

---

## Self-Review（计划对照 spec）

- **修 idle-exit 残留崩溃** → Task 1 ✓
- **逐行 × 回传链路（host 分流 / open-fixed / companion 扩展 handler）** → Task 2 Step 3/10 ✓
- **hitrects 含收起按钮 + × 命中条；收起态只报按钮** → Task 2 Step 8（`reportHitRects`）✓
- **顺带修好收起按钮可点** → Task 2（共享 hit-test）+ Step 12 验证 ✓
- **WM_NCHITTEST 多矩形 + DPI(dpr)** → Task 2 Step 1/2/4 ✓
- **hover 才显** → Task 3 ✓
- **跨窗广播 removeRow** → Task 2 Step 9（`removeRowById` 用 `send()`）✓
- **重编并提交 exe** → Task 2 Step 5/13 ✓
- **维持无 TTL** → 不新增计时器；Task 5 Step 3 grep ✓
- **文档（README/SKILL/CHANGELOG Added+Fixed）** → Task 4 ✓
- **push 到 origin/0.0.1-dev（新 git 约定）** → Task 5 Step 5 ✓
- **回归 13/0 + HITL 验证** → Task 1 Step 4、Task 5 Step 1、Task 2 Step 12、Task 3 Step 3 ✓

无占位符；命名一致（`removeRowById`、`HitRects`、`UpdateHitRects`、`reportHitRects`/`scheduleReport`/`curScaleFactor`）。所有 old_string 对齐当前真实文件（含收起改动后的 `w.on("message")`、`setCollapsed`、多行 `window.island`）。
