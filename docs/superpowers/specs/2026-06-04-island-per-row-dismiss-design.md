# 灵动岛：逐行手动消除（hover ×）+ 完成 idle-exit 移除 — 设计

- 日期：2026-06-04（2026-06-04 因并发功能落地而修订）
- 分支：0.0.1-dev
- 状态：设计已逐项确认；因另一实例并发落地「收起/展开」功能，已据实协调

## 背景与动机

灵动岛此前已改为「状态行保留到下一个事件覆盖」（删 done-retract 30s 与 ROW_TTL 120s，commit `0c91215`）。随后暴露：被 kill / 退出的会话留下的 done/waiting/interrupted「幽灵行」无人单独清除；且 `companion.mjs` 的 60s idle-exit 与文档「永久常驻」自相矛盾。

用户取舍：把灵动岛当**永久看板**，由人**手动**清理。决定：删 idle-exit（永久常驻）+ 每行一个 **hover 才显**的 `×`（只消该行）+ 整窗关闭仍用 `/island kill`。

## ⚠️ 协调：并发落地的「收起/展开」功能

本设计 plan 提交（`2fb8b1b`）后，**另一个 Claude Code 实例**在其上加了 4 个提交（`ce16612`/`e88024a`/`dd05087`/`1ea4c8e`），实现了**收起/展开**：底部中央一个小尖尖按钮（▲/▼），点击收起（窗口缩到 30px、仅留按钮），有新 update 自动展开。状态仅内存态。这与本设计**强重叠**，据实协调如下：

1. **idle-exit 已被它「删了一半」——现 HEAD 是坏的。** 收起改动顺手删掉了 `let idleTimer` 声明和 `scheduleIdleExit()` 函数（它俩与被改写的 `syncHeight` 相邻），**但漏删两个调用点**（`companion.mjs:209` 的 `if (idleTimer){...}`、`:272` 的 `if (clients.size===0) scheduleIdleExit();`）。这两处引用已不存在的符号 → ES module 严格模式抛 `ReferenceError` → `uncaughtException` → companion 在**第一个客户端连接时即崩溃退出**。`node --check` 查不出（运行时错误）。→ 本设计 **Task 1 由「删 idle-exit」改为「删这两个残留调用点」**，既完成 idle-exit 移除、又**修掉这个崩溃 bug**，且必须最先做（否则后续 HITL reload 一律崩）。

2. **收起按钮当前点不动——本设计的 hit-test 正好修它。** 收起功能加了可点按钮 + companion 已处理 `collapseChanged` 消息，**但完全没动 `island-host.cs`**——`WM_NCHITTEST` 仍整窗 `HTTRANSPARENT`，所有点击穿透，按钮收不到点击（`TEST-COLLAPSE.md` 第 3 步「点击 ▲」当前必然失败）。本设计 Task 2 要新建的 hit-test 抠洞正是它所缺。用户已确认「顺手修好收起按钮」：**`hitrects` 同时上报「收起按钮矩形 + 逐行 × 命中条」**，两者都可点。

3. **companion 的 `w.on("message")` 已存在**（处理 `collapseChanged`）→ 本设计**扩展它**加 `dismiss` 分支，而非新增监听。collapse 用 `action` 字段、本设计的 `hitrects`/`dismiss` 用 `type` 字段，互不干扰。

4. **git 约定变更**（`1ea4c8e` 改了 `CLAUDE.md`）：在 `*-dev` 分支工作，**验证完成后直接 push 到远端 `*-dev`**，master 仅用户操作。→ Task 5 增加 push。

## 目标

1. 删除 `companion.mjs` 残留的 idle-exit 调用点（修崩溃 + 完成永久常驻）。
2. 逐行 `×` 手动消除：hover 才显，点击把该会话行从**所有窗口 + companion 状态**移除。
3. 顺带让**收起按钮可点**（共享同一 hit-test 基础设施）。
4. 行为变更同步 `README.md` / `island/SKILL.md` / `CHANGELOG.md`。

## 非目标 / 维持现状

- **不恢复任何 TTL**：行的移除只剩——被下一个事件覆盖 / `×` 手动消除 / 收起（仅隐藏）。
- **不加全局 exit 按钮**（用户选逐行 ×）。整窗关闭走 `/island kill`。
- **不恢复旧聚焦机制**（hover 轮询 / 抢前台 / 进程树）。只抠静态命中区。
- **不改收起功能的交互逻辑**：只补它缺的 hit-test，使其按钮可点；不动它的 CSS / 状态机。

## 架构与数据流

复用四层管道。WebView → host → companion 回传链已全通（`open-fixed.mjs:47` 已有 `w.on("message")` 事件，companion 已挂监听处理 collapse）：

```
① 逐行 × onclick / ② 收起按钮 onclick（已存在）
  → window.islandHost.send(...)                         // ① {type:"dismiss",id} ② {action:"collapseChanged",collapsed}
  → host WebMessageReceived（island-host.cs，本次改造按 type 分流）
       ├─ {type:"hitrects", rects[], dpr} → 本地存入 IslandForm.HitRects，供 WM_NCHITTEST（不转发）
       ├─ {__islandHost_close}            → CloseAndExit（维持）
       └─ 其余（dismiss / collapseChanged）→ Stdout {type:"message", data}（转发）
  → open-fixed FixedWindow 触发 w.on("message", data)    // 已具备
  → companion w.on("message")（扩展现有 handler）
       ├─ data.action==="collapseChanged" → isCollapsed=…, syncHeight()（已有）
       └─ data.type==="dismiss"           → removeRowById(id)（本次新增）
```

`removeRowById(id)`：`activeRowIds.delete + currentRows.delete + syncHeight + 向所有窗口广播 window.island.removeRow(id)`。删 companion 状态 + 广播多窗，避免多屏不同步 / replay 复活。被消会话再来事件 → 重新 upsert 成行（`×` = 暂时清掉）。

## 命中区 / WM_NCHITTEST 设计

现状：`IslandForm.WndProc` 对**整窗** `WM_NCHITTEST` 返回 `HTTRANSPARENT`（`island-host.cs:110-115`）。

改为：`IslandForm` 持有一个矩形数组 `HitRects`（客户区像素）。`WM_NCHITTEST` 把屏幕坐标 `PointToClient` 转客户区，落在**任一**矩形内返回 `HTCLIENT`（放行给子 WebView2），否则仍 `HTTRANSPARENT`。

WebView（`island.html.mjs` 的 `reportHitRects`）上报**两类**矩形：
- **收起按钮**：`#collapse-btn` 的 `getBoundingClientRect()`，**始终上报**（收起态也要能点它展开）。
- **逐行 × 命中条**：胶囊右缘约 `34px × stack 高`的竖带，**仅展开态（`!collapsed`）且有行时上报**（收起时行已隐藏，无需命中）。

上报时机：`upsertRow`（新行）/`removeRow`/`setScale`/`setCollapsed` 后，`scheduleReport()`（立即 + 360ms 延迟各一次，覆盖动画/窗口 resize settle）。`×` 平时 `opacity:0`，光标进命中条 → 该行 `:hover` → `×` 淡入（纯 CSS）。

## DPI 处理

`getBoundingClientRect()` 为 CSS px；随 `hitrects` 带上 `devicePixelRatio`，host 端 `clientPx = cssPx × dpr`。`WM_NCHITTEST` 的 `LParam` 为物理屏幕坐标 → `PointToClient`。100% 缩放（dpr=1）天然对齐；高 DPI 实测校正——**列为实现期验证项**。

## 错误处理 / 边界

- **多窗口**：每窗 WebView 各报自己的 `hitrects`（host 本地）；`dismiss` 经 companion 广播 `removeRow` 到所有窗口。
- **收起态**：`#stack` 隐藏（pointer-events:none），× 命中条不上报；收起按钮始终可点 → 展开。auto-expand（companion 调 `setCollapsed(false)`）会触发 `scheduleReport` 重新上报含命中条。
- **消除最后一行**：stack 空 → 52px 透明窗，companion 仍跑。整窗关闭靠 `/island kill`。
- **不触碰 STATE_FILE**：`×` 是显示动作。

## 测试与验证

- **自动化护栏**：`node --check`（语法）+ `node island/src/island-test.mjs`（回归，本次不改 bridge 状态逻辑，应保持 13/0）。注意：`--check` 查不出 Task 1 修的那种 `ReferenceError`（运行时）。
- **HITL（必需，GUI 交互人来验）**：Task 2 一次 reload 同时验证——① 逐行 × 可点删行、跨窗同步、日志 `dismiss id=`；② **收起按钮变可点**（点 ▲/▼ 切换、日志 `collapse state changed`）。Task 3 验 hover 才显。

## 风险

1. **点击能否进 DOM onclick**（头号）：`WS_EX_NOACTIVATE` 窗，命中区放行后 WebView2 是否触发 DOM 事件。收起按钮可点与否是同一判定 → Task 2 一并验证。
2. **hover 在 NOACTIVATE 窗可靠性**：mousemove 是否送达触发 `:hover`。
3. **DPI 对齐**：非 100% 缩放矩形偏移。

## 组件改动清单

- `island/src/companion.mjs`：**Task 1** 删两处残留 idle-exit 调用点（`:209`/`:272`，修崩溃）；**Task 2** 抽 `removeRowById` + 复用于 socket remove + **扩展现有** `w.on("message")` 加 `dismiss` 分支。
- `island/src/hosts/windows/island-host.cs`：`WebMessageReceived` 按 `type` 分流（`hitrects` 本地消费）；`IslandForm` 存 `HitRects` + `WM_NCHITTEST` 多矩形命中 + `UpdateHitRects` + DPI 换算。**改后 `node island/src/build.mjs` 重编并提交 exe 产物**。
- `island/src/island.html.mjs`：每行 `×` DOM + hover CSS + `reportHitRects`（收起按钮 + × 命中条）+ `scheduleReport` 接入 upsert/remove/scale/setCollapsed + `×` 点击委托。
- `island/src/open-fixed.mjs`：无需改。
- 文档：`README.md` / `island/SKILL.md` 行为节加「逐行消除」；`CHANGELOG.md` 记 Added(逐行×) + Fixed(idle-exit 残留崩溃)。

## 文档同步要点

- 行为：新增「逐行 `×` 手动消除（hover 才显）」；「永久常驻」属实（idle-exit 残留已清）；收起按钮可点。
- CHANGELOG：Added 记逐行 × + 顺带修好收起按钮可点；Fixed 记 collapse 改动遗留的 idle-exit 悬空引用崩溃。
