# 灵动岛：逐行手动消除（hover ×）+ 删除 idle-exit — 设计

- 日期：2026-06-04
- 分支：0.0.1-dev
- 状态：设计已与用户逐项确认，待最终 spec 评审 → writing-plans

## 背景与动机

灵动岛此前已改为「状态行保留到下一个事件覆盖」（删除了 done-retract 30s 与 ROW_TTL 120s，commit `0c91215`）。随后暴露两个问题：

1. **幽灵行**：被 kill / 正常退出的会话，其最后一行（done / waiting / interrupted）没有任何机制单独清除——它永远等不到「下一个事件」来覆盖。
2. **idle-exit 与「永久常驻」文档矛盾**：`companion.mjs` 有一个 60s idle-exit（所有 socket 客户端断开满 60s 整窗退出），而 README / SKILL / companion 顶部注释都声称「永久常驻，不会自动退出」——文档与代码不符。

用户的取舍：把灵动岛当成一块**永久看板**，由人**手动**清理，而不是任何定时自动消失。具体决定（逐项确认）：

- 删掉 60s idle-exit，让窗口真正永久常驻（文档转正）。
- 每行加一个 **hover 才显**的 `×`，点击只消除该会话那一行。
- 想整窗关闭仍用既有 `/island kill`。

## 目标

1. 删除 `companion.mjs` 的 60s idle-exit 机制。
2. 逐行 `×` 手动消除：光标移到某行右缘时该行 `×` 淡入，点击后该会话行从**所有窗口 + companion 状态**中移除。
3. 行为变更同步到 `island/SKILL.md` / `README.md` / `CHANGELOG.md`。

## 非目标 / 维持现状

- **不恢复任何 TTL**：done-retract / ROW_TTL 维持已删除状态。行的移除只剩两条路径：被同一会话的下一个事件覆盖，或被 `×` 手动消除。
- **不加全局 exit 按钮**（用户在「岛上全局 exit / 逐行 × / 托盘」中选了逐行 ×）。整窗关闭走 `/island kill`。
- **不恢复旧聚焦机制**：不引入 hover 轮询、`SetForegroundWindow`/`AttachThreadInput` 抢前台、进程树遍历等（CHANGELOG 已整体删除）。本次只重抠一块**静态命中区**。

## 关键决策

| 决策点 | 选定 | 备选（未选） |
|--------|------|--------------|
| 窗口生命周期 | 删 idle-exit，永久常驻 | 保留 60s / 改可配 TTL |
| 消除粒度 | 逐行 `×`（只消该行） | 全局 exit / system-tray |
| `×` 可见性 | hover 才显 | 常显淡色 |
| 命中几何 | 右缘**单命中条**（每窗 1 矩形） | 每个 `×` 精确 N 矩形 |

## 架构与数据流

复用现有四层管道，新增一条「WebView → host → companion」的回传链（链路本身已全通，仅 companion 端缺一个监听）：

```
× onclick (island.html.mjs)
  → window.islandHost.send({type:"dismiss", id})        // 新增按钮 + onclick
  → host WebMessageReceived                              // island-host.cs：已有，按 type 分流
       ├─ {type:"hitrects",...} → 本地存入 IslandForm，供 WM_NCHITTEST（不转发）
       ├─ {type:"dismiss", id}  → Stdout {type:"message", data:{...}}（转发）
       └─ {__islandHost_close}  → CloseAndExit（维持原样）
  → open-fixed FixedWindow 触发 w.on("message", {type:"dismiss", id})   // open-fixed.mjs:47 已具备
  → companion w.on("message")                            // 新增监听
       activeRowIds.delete(id) + currentRows.delete(id) + syncHeight()
       + 向所有窗口广播 window.island.removeRow(id)
```

**要点**：
- `hitrects` 与 `dismiss` 都从 WebView 经同一 `postMessage` 出来，host 按 `type` 分流——`hitrects` host 自己消费（WM_NCHITTEST 要同步用），`dismiss` 才转发给 companion。
- 消除是删 **companion 状态 + 广播到所有窗口**，不是只删一个 DOM；否则多屏不同步、且 replay（新窗口就绪时回放 `currentRows`）会复活它。
- 被消会话之后若再来 hook 事件，bridge 照常 `update`，companion 重新 `upsertRow` → 自然重新成行。`×` 语义是「暂时清掉」而非永久拉黑。

## 命中条 / WM_NCHITTEST 设计

现状：`IslandForm.WndProc` 对**整窗** `WM_NCHITTEST` 返回 `HTTRANSPARENT`（`island-host.cs:110-115`），全窗穿透。

改为：
- `IslandForm` 持有一个命中矩形（客户区像素）。`WM_NCHITTEST` 时把屏幕坐标转客户区坐标，落在矩形内返回 `HTCLIENT`（放行给子 WebView2），否则仍 `HTTRANSPARENT`。
- 命中条几何：胶囊右缘一条约 **32px** 宽、跨整个 stack 高度的竖带。`×` 渲染在其中、按行排列。
- 命中条**永久可命中**（hover 才显的前提：唯有该区可命中，WebView 才能在此收到 mousemove 触发 CSS `:hover`）。`×` 平时 `opacity:0`，光标进入命中条 → 当前行 `:hover` → 该行 `×` 淡入。

WebView 上报时机（`island.html.mjs`）：`ready` 后、`upsertRow`/`removeRow` 改变行数后、`setScale` 后，用 `requestAnimationFrame` 取右缘竖带的 `getBoundingClientRect()`，`send({type:"hitrects", rects:[{x,y,w,h}], dpr})`。协议用数组（便于将来扩成每 `×` 精确矩形），当前只发 1 个。

## DPI 处理

- WebView 的 `getBoundingClientRect()` 是 CSS px；host 客户区按物理像素命中。换算：`clientPx = cssPx × devicePixelRatio`，`devicePixelRatio` 随 `hitrects` 一并上报。
- `WM_NCHITTEST` 的 `LParam` 是物理屏幕坐标 → `Form.PointToClient` 转客户区后比对。
- 用户大概率 100% 缩放（`devicePixelRatio=1`）下天然对齐；高 DPI 需实测校正。**列为实现期验证项，不在设计阶段假设其正确。**

## 错误处理 / 边界

- **多窗口（screen=all）**：每窗 WebView 各自向自己的 host 上报 `hitrects`（host 本地）；`dismiss` 经 companion 广播 `removeRow` 到所有窗口，多屏同步消失。
- **消除最后一行**：stack 空 → `syncHeight()` 收到 min 52px 透明窗（magenta 不可见），companion 仍在跑。整窗关闭仍靠 `/island kill`。这是「永久常驻」的预期形态。
- **dismiss 的会话再活跃**：下一个 hook → 重新 upsert 成行（预期）。
- **不触碰 STATE_FILE**：`×` 是显示动作；会话持久数据仍由 bridge 维护、10 分钟不活跃自动清理。

## 测试与验证

- **自动化局限**：本次改动集中在 companion（守护进程 + 原生窗口）、C# host、HTML，`island-test.mjs`（驱动 bridge stdin → 状态）覆盖不到 hover/点击/hit-test/DPI。回归上至少要确认现有 `island-test.mjs` 仍 13/0 通过（本次不改 bridge 状态逻辑，应不受影响）。
- **风险优先的手动反馈环（HITL，必需）**：GUI 交互无法由 agent 自行验证（需人移动鼠标 / 观察 hover）。第一步先做**最小链路 spike**（临时命中条 + 一个可见 `×`，点击发 dismiss），由用户在 Windows 实跑，确认四件事：
  1. hover 能否让 `×` 收到 mousemove（CSS `:hover` 生效）；
  2. 点击能否触发 DOM `onclick`；
  3. dismiss 消息是否到达 companion（看 `~/.claude/claude-island.log`）；
  4. 行是否跨所有窗口消失。
  通过 → 继续美化（hover 才显）；不通 → 回退到 host 侧 `WM_LBUTTONDOWN` 按 `y` 算行（但那是重拾原生点击处理，尽量不走）。

## 风险

1. **点击能否进到 DOM onclick**（头号）：窗口 `WS_EX_NOACTIVATE`，命中区返回 `HTCLIENT` 后 WebView2 子窗是否真能收到点击并触发 DOM 事件。旧聚焦功能证明命中区可收点击（但它走原生 `WM_LBUTTONDOWN`，非 DOM）——需实测。
2. **hover 在 NOACTIVATE 窗上是否可靠**：mousemove 是否照常送达 WebView2 触发 `:hover`。
3. **DPI 对齐**：非 100% 缩放下矩形偏移。

## 组件改动清单

- `island/src/island.html.mjs`：每行加 `×` DOM、hover 才显 CSS、命中条 `getBoundingClientRect` 上报、`×` onclick→dismiss。
- `island/src/hosts/windows/island-host.cs`：`WebMessageReceived` 按 type 分流；`IslandForm` 存命中矩形 + `WM_NCHITTEST` 命中判定 + 坐标换算。**改后必须 `node island/src/build.mjs` 重编并提交 `island-host-win.exe`**（需 Windows + .NET 8 SDK）。
- `island/src/companion.mjs`：删 idle-exit（`idleTimer` / `scheduleIdleExit` / 两处调用）；窗口循环里加 `w.on("message")` 处理 dismiss。
- `island/src/open-fixed.mjs`：无需改（`w.on("message")` 已具备，`open-fixed.mjs:47`）。
- 文档：`island/SKILL.md`、`README.md` 行为节；`CHANGELOG.md` 记一条。

## 文档同步要点

- 行为：新增「逐行 `×` 手动消除（hover 才显）」；idle-exit 删除后「永久常驻」属实，整窗关闭走 `/island kill`。
- CHANGELOG：Changed 记 idle-exit 删除 + 逐行 dismiss 链路；Added 记 `×` 交互。
