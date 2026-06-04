# 更新日志

本项目所有值得记录的变更都写在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)：
按 **Added（新增）/ Changed（变更）/ Removed（删除）/ Fixed（修复）** 分类，最新的在最上面。

## [Unreleased]

### Added
- **灵动岛收起/展开交互**：在灵动岛底部中间添加小尖尖按钮（▲/▼），支持手动收起/展开。收起后窗口缩小至 30px 高度，只显示小尖尖按钮；展开时恢复正常高度并显示所有胶囊行。交互逻辑：(1) 点击 ▲ 手动收起，(2) 点击 ▼ 手动展开，(3) 收起状态下有新状态更新时自动展开。状态仅内存态，不持久化。涉及文件：
  - `island.html.mjs`：新增 `#collapse-btn` 按钮样式与 SVG 图标、`body.collapsed` CSS 折叠动画（300ms cubic-bezier）、前端状态管理（`collapsed` 变量、`setCollapsed()`/`toggleCollapse()` 函数）、通过 `window.islandHost.send()` 向 companion 通知状态变更。
  - `companion.mjs`：新增 `isCollapsed` 全局变量、`WIN_H_COLLAPSED=30` 常量；监听 WebView `message` 事件处理 `collapseChanged` 动作；`syncHeight()` 根据 collapsed 状态选择窗口高度；`update` 消息到达时若处于收起状态则自动展开（调用 `setCollapsed(false)` 并通知前端）。
- `CLAUDE.md`：面向 Claude Code 的仓库指引（项目概述、常用命令、跨进程架构、仓库维护约定）。
- `CHANGELOG.md`：本变更日志，作为版本维护历史的唯一权威记录。
- `.gitignore`：新增忽略 `*.pdb`（.NET 调试符号）与 `Microsoft.Web.WebView2.*.xml`（WebView2 IntelliSense 文档，约 700KB），二者运行时均不需要。
- **逐行 × 手动消除**: 灵动岛每行新增一个 hover 才显的 × 按钮，点击只移除该会话行（跨所有屏幕同步移除）。链路：`window.islandHost.send({type:"dismiss",id})` → C# host(`WebMessageReceived` 按 `type` 分流，`hitrects` 本地消费、其余转发) → `open-fixed` 的 `w.on("message")` → companion 扩展现有 handler 调 `removeRowById` 广播 `removeRow`。为让穿透窗上的 × 可点，`island-host.cs` 的 `WM_NCHITTEST` 改为只放行 WebView 上报的命中矩形（逐行 × 右缘竖带 + 收起按钮，按 `devicePixelRatio` 换算到客户区），其余仍整窗穿透。**顺带修好了收起按钮**：它此前因无 hit-test 而点不动，现共享同一命中机制后首次可点。重编并提交 `island-host-win.exe`。

### Changed
- `CLAUDE.md`：新增「WSL2 一样能驱动」说明并澄清「常用命令」措辞——`SUPPORTED_PLATFORMS=win32` 只约束 bridge/companion 须由 Windows node 运行，不限制 Claude Code 的宿主；WSL2 里把 hook 的 `node` 换成 `node.exe`（Windows node，interop 直接透传 stdin）即可驱动灵动岛。背景：实测从 WSL 跑 `echo JSON | node.exe bridge.mjs hook` 成功开窗、状态实时更新、中文/emoji stdin 无损、终端经 `WT_SESSION` 识别为 windows-terminal；此前「仅支持 Windows」的措辞反复被误读为「Claude Code 必须 Windows 原生」。
- `README.md` / `island/SKILL.md`：同步「WSL2 宿主」用法——README 安装节后新增 WSL2 提示框；SKILL 依赖节后新增「Claude Code 运行在 WSL2 时」小节，说明 hook 命令改用 `node.exe` + `C:/` 路径、interop 透传 stdin。实测：WSL 的 `/root/.claude/settings.json` 配 `node.exe` hooks 后，当前 WSL 会话被 Claude Code 热加载并真实驱动上岛（log 出现真实 session_id 的 update）。
- `README.md`：补齐与当前实现的差异——新增 `/island theme <dark|pink|auto>` 命令、`screen all` 选项、聚焦跳转说明；架构图 hook 列表补全为 7 个（增加 `StopFailure`、`PermissionRequest`）；新增「更新日志」指向。
- 初始化 Git 仓库，推送至 `github.com/zenbinhao/cc-island-win`。
- `island/src/hosts/windows/island-host.csproj`：WebView2 `PackageReference` 由浮动 `1.*` 固定为 `1.0.3912.50`（与仓库已提交的 WebView2 DLL 版本一致）。背景：浮动版本会让重新编译时拉到更新的 WebView2（实测拉到 `1.0.3967.48`），新生成的 `deps.json` 与已提交 DLL 不符，exe 启动即抛 `FileNotFoundException: Microsoft.Web.WebView2.WinForms`；固定版本保证重编确定性、不产生无关的 WebView2 二进制改动。预编译 `island-host-win.exe`/`.dll`/`.deps.json`/`.runtimeconfig.json` 随聚焦功能删除一并重新编译提交。
- **`bridge.mjs` / `companion.mjs`：状态行改为「保留到下一个事件覆盖」，删除两类定时自动移除。** 此前 `Stop`/`StopFailure` 发完 `done`/`interrupted` 后会再发 `done-retract`，30 秒后移除该行；`companion` 另有 `ROW_TTL_MS=120000` 兜底定时器，行 120 秒无更新即移除。现两者全部删除：done / interrupted / waiting 状态行一律保留到该会话的下一个事件把它覆盖（再次发消息翻回 thinking 等）。整窗清理仍由既有的 60 秒 idle-exit 负责（不在本次改动范围）。连带删除 `companion` 内随之失效的 `done-retract` 协议消息处理、`doneTimers` / `rowLastUpdate` 两张表、`scheduleDoneRetract()` / `clearDoneTimer()` 及 update / remove / cleanup 中的相关调用。背景：维护者常在多 pane 下并行跑 CLI，希望灵动岛作为一块持续看板——已完成的 pane 显示 done、等待授权的 pane 显示 waiting 都应一直可见，而不是各自定时消失；30s/120s 两个定时器恰好打断了这种「看板」语义。`island/SKILL.md` 行为说明同步更新。

### Removed
- **聚焦跳转功能（↗ 按钮）整体删除**：移除「鼠标悬停胶囊、每行左侧浮现 ↗ 圆形按钮、点击跳回对应会话终端窗口」的全部能力。涉及四层：
  - `island.html.mjs`：删 `.focus-btn` 样式、`body.island-hover` 整排变暗规则、按钮 DOM 创建与 `data-ppid`、`stack` 上的点击监听。
  - `bridge.mjs`：删整个 `getTerminalInfo()` 终端探测（含每个 hook 一串 PowerShell 进程树遍历 + WT tabIndex 检测）与 7 处 `...getTerminalInfo()` 注入。**副作用：每个 hook 不再起 PowerShell，明显提速，WSL2（每个 hook 已是一次 interop 冷启动）下尤其明显。**
  - `companion.mjs`：删 `sessionTerminal` 表、`focusTerminal()`、WT `focus-tab` / WezTerm `activate-pane` 调用、`focus-session` 窗口消息处理，及 update 日志里的 `termType`/`tabIndex` 字段。
  - `island-host.cs`：删 `ActivateWindow` 抢前台全套 Win32 P/Invoke（`SetForegroundWindow`/`AttachThreadInput`/ALT 键 trick/Toolhelp 进程树等）、60ms hover 轮询 `StartHoverDetection`、`WM_LBUTTONDOWN` 处理与 `OnButtonRowClick`、`activate` stdin 命令；`WM_NCHITTEST` 由「仅放行按钮命中区」改为**整窗点击穿透**（消除了原按钮区那条隐形不可穿透的死区）。
  - `open-fixed.mjs`：删不再被调用的 `activate()` 包装。
  - **背景**：维护者在 WSL2 高频使用、常在单个窗口内分屏跑 2–3 个 CLI，「按窗口聚焦」无法区分同一窗口里的多个 pane；且该交互体验与外观均不满意，故整体砍掉。灵动岛回归纯状态展示。
- `island/src/island.md`：删除 `SKILL.md` 的过时旧副本。该文件内容已与实现脱节（旧脚本路径少了 `src/`、依赖已废弃的 `prompt`/`tool-start`/`tool-end`/`done` 子命令、误述「完成后 5 秒自动消失」实际为 30 秒、缺少 theme / StopFailure / PermissionRequest），留在公开仓库会误导读者。**skill 的唯一权威文档为 `island/SKILL.md`。**

### Fixed
- **companion 因 idle-exit 残留调用点崩溃**: 「收起/展开」改动删除了 `idleTimer` 声明与 `scheduleIdleExit()` 函数，却漏删 `companion.mjs` 中两个调用点（连接处理器、`sock.close`），引用已不存在的符号 → `ReferenceError` → companion 在第一个客户端连接时即崩溃退出（`node --check` 查不出此类运行时错误）。删除残留两行，完成 idle-exit 移除：窗口真正永久常驻，整窗关闭只由 `/island kill` 负责（无任何定时自动消失：done-retract / ROW_TTL / idle-exit 均已清除）。
