# 更新日志

本项目所有值得记录的变更都写在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)：
按 **Added（新增）/ Changed（变更）/ Removed（删除）/ Fixed（修复）** 分类，最新的在最上面。

## [Unreleased]

### Fixed
- **IPC 命名管道 → TCP 回环 127.0.0.1:38917**(用户实测反馈:cmd 里开的 Claude Code 灵动岛永远不显示):
  - 根因(逐层实证):本机 WT 为管理员运行 → WSL hook 拉起的 companion 提权 → 其命名管道携带创建者完整性级别,**非提权进程连接被拒**——`schtasks /RL LIMITED` 跑 medium-IL 探针连 `\\.\pipe\claude-island` 得 `EPERM`,提权上下文 `CONNECT-OK`。于是 cmd(非提权)会话的每个 hook 都连不上 → update 全丢、永不上岛;bridge 失连还会 spawn 注定 EADDRINUSE 的 companion(日志实锤:90 秒内 8 个 `companion starting → EADDRINUSE` 风暴)。
  - 修复:`socket-path.mjs` 默认端点改 `{port:38917, host:"127.0.0.1"}`(显式绑回环,不暴露局域网;端口避开本机 Hyper-V 排除段),`net.connect`/`server.listen` 通吃,EADDRINUSE 单例语义不变。`CLAUDE_ISLAND_SOCK` 覆盖升级:纯数字=TCP 端口,其它=管道/套接字路径。
  - 修复后 medium-IL 探针 `CONNECT-OK`,日志里非提权会话的 update 开始到达。换代自愈:新 companion 拿到 TCP 单例后清掉旧管道 companion 的 host,旧实例随之退出,无需手工迁移。
- **companion 启动顺序:先 listen 拿单例,再清孤儿/写 PID/开窗**:此前启动最前就 `taskkill /F /IM island-host-win.exe` 并抢写 PID 文件,EADDRINUSE 的并发实例会**误杀健康 companion 的 host 窗口**(同权场景)、把 PID 文件指向将死进程,还会开一个一闪而过的 host 再退出。现在 EADDRINUSE 落败者全程零副作用;附带收益:companion 从 spawn 到可连通从 ~1-2s 降到 ~100ms(listen 不再等 WebView2 开窗)。窗口未就绪期间到达的 captureFg 排队,首窗 ready 后立即补发(冷启动首条 prompt 的跳转绑定不再丢失)。
- **状态文件并发写损坏 + 永不自愈**(现场实锤:`claude-island-state.json` 尾部残留 `}ozenElapsed": 357587…` 垃圾,JSON 解析永久失败,所有会话 prompt/计时丢失,日志全是 `prompt=""`):多个一次性 bridge 并发 `writeFileSync` 互相截断;且 `saveSessionData` 解析失败即静默放弃,损坏永不修复。修复:统一 `writeStateFileAtomic`(写 `.tmp` + rename,NTFS 原子替换),解析失败以空表自愈重建。代价说明:并发读改写仍可能丢一次更新(最后写者赢),但文件恒为合法 JSON。
- **探活误删 cmd 宿主的活跃会话行**:cmd 宿主的 CC 经一次性 `cmd /c` 包装进程调 hook,bridge 记的 `ppid` 在 hook 结束后立刻死亡 → 30s 探活就把**活跃会话**的行摘掉(修复 IPC 后日志实锤:`liveness check: row … pid=3452 is dead, removing`)。`deadRowIds` 规则升级:pid 存活记入 `seenAlive`;曾存活的 pid 死亡 → 终端真关了,立即摘行(WSL 行为不变);**从未观测存活的 pid 不可信** → 按 5 分钟无更新静默期兜底。
- **`/island off` 形同虚设**:`handleHook` 从不检查 `enabled`,off 之后 hook 照常发 update、还会把 companion 拉活。现在 `enabled=false` 时 hook 全部静默(SKILL.md 既有语义)。
- **跳转防错乱:窗口类名校验**(用户实测反馈:点击行偶尔跳到无关窗口):捕获表持久化的 hwnd 会被系统复用给别的窗口,`IsWindow` 仍为真就照跳。现 `captureFg` 同时记窗口类名(`GetClassName`),`focusWindow` 跳转前校验,不符即放弃并记日志(旧表无类名字段的条目跳过校验,向后兼容)。另一错乱来源——回车后切窗的捕获竞态——被 IPC 修复大幅收窄(失连重试曾把捕获拖到 4-6 秒后,现 ~100-300ms),残余竞态在 SKILL.md 明示。

### Added
- **跳转再升级:跨 tab 定位 + 捕获表持久化**(用户实测反馈:同窗多个 WSL2 子窗口,目标在非活动 tab 时不切换):
  - 根因(日志实证):捕获完全正确(`pane=TermControl#…`),但 **WT 非活动 tab 的 pane 不挂在 UIA 树上**,点击时 `FindAll` 找不到该 RuntimeId → 退窗口级 → 窗口本就在前台,看起来"没反应"。
  - 修复:`captureFg` 同时记录**所在 TabItem 的 RuntimeId**(tab 头常驻 UIA 树);`focusWindow` 找不到 pane 时,按 TabItem RuntimeId `SelectionItemPattern.Select()` 切 tab、等内容挂回树(350ms)再找 pane 落焦;tab 也找不到才止于窗口级。
  - 第二个实测漏洞:捕获表原是 companion 内存态,reload 即丢,点击悄无声息没动作。现持久化到 `~/.claude/claude-island-fg.json`(启动加载、捕获/摘行即写)。
  - E2E 场景 3(全自动):`wt -w -1` 开双 tab(cmd 各自 title tabA/B)→ Ctrl+Tab 切到 tabA 捕获(断言 tab RuntimeId 非空)→ 切回 tabB(目标 pane 脱树)→ SendInput 点击岛行 → 断言标题自动变回 tabA。三场景 21 断言全绿,套件 46。
- **跳转升级为 pane 级精确聚焦**（窗口级跳转的后继增强,用户点名:多 pane 下「拉起窗口」不够,要直接落焦到那个 CC 的输入行）:
  - 捕获端:`captureFg` 除前台 HWND 外,同时取 **UIA 焦点元素的 RuntimeId + ClassName**。坑:`AutomationElement.FocusedElement` 在 WT 上停在 HWND 级壳 `Windows.UI.Input.InputSite.WindowClass`(每窗口一个,不到 pane)——需 `FindFirst(Descendants, HasKeyboardFocus=true)` 向下钻到真正的 `TermControl`。
  - 聚焦端:`focusWindow` 带 `paneId/paneClass`,拉起窗口后在其 UIA 子树内按 ClassName 缩小范围、`Automation.Compare` 比对 RuntimeId 找回该 pane → `SetFocus()`;100ms 后校验焦点未落则对元素矩形中心 `SendInput` 真实点击兜底(虚拟桌面绝对坐标,多屏正确)。pane 已关/找不到 → 静默退回窗口级。
  - RuntimeId 跟元素走:pane 重排/缩放不影响定位。终端无独立输入框,pane 得焦后击键即直达该 CC 输入行。
  - 工程坑:UIA(System.Windows.Automation)在 WPF 程序集,csproj 需 `UseWPF`,而 UseWPF 会让 SDK 移除隐式 `System.IO` using(补显式 using);跨完整性级别 UIA 被 UIPI 拦截——本机 WT 为管理员运行,interop 全链路同级,畅通。
  - E2E 场景 2(全自动,14 断言全绿):`wt -w -1` 开双 pane(cmd 各自 title paneA/B,**WT 窗口标题恒等于聚焦 pane 标题**=现成断言器);左 pane 聚焦时捕获(断言 class=TermControl)→ 点右 pane 挪走焦点 → SendInput 点击岛行 → 断言标题变回 paneA。配套坑:提权 WT 标题带「管理员: 」前缀,标题匹配用后缀;PowerShell `-EncodedCommand` 撞 32K 命令行上限,改写临时 .ps1 走 `-File`;清理按 Win32_Process 命令行精准杀 pane 的 cmd。
- **整行点击跳转到对应 CC 终端窗口**（UI 重写主线,设计 spec 见 `docs/superpowers/specs/2026-06-10-island-ui-rewrite-design.md`）:
  - 捕获:`UserPromptSubmit` 时 bridge 在 update 上带 `captureFg:true` → companion 让常驻 C# host 发 `captureFg` 命令 `GetForegroundWindow()` 捕获该时刻前台窗口 HWND(用户刚按回车,前台即该终端),存 `sessionId → hwnd` 表。**零额外进程**——规避了旧版(2026-06-03 被砍)每 hook 起 PowerShell 遍历进程树的根本病灶,也不做任何终端类型探测。
  - 跳转:整行成为命中矩形,点击行(× 以外)→ webview `focus` 消息 → companion 查表 → host `focusWindow`:`IsWindow` 校验 → `IsIconic` 则 `SW_RESTORE` → ALT trick + `SetForegroundWindow`(AttachThreadInput 兜底)。hover 时行高亮 + ↗ 提示淡入。
  - 限制(明示):窗口级粒度,同窗多 pane 无法区分;会话尚无 UserPromptSubmit 捕获时点击静默无效。
  - host 协议新增 `screens` / `captureFg` / `focusWindow` 三命令与 `fg` 应答;`open-fixed.mjs` 新增 `cmd()` 通用命令与 `screens`/`fg` 事件。
  - Windows 侧 `C:/Users/Z/.claude/settings.json` 重新配齐 8 个 island hooks(裸 `node`,先备份)——原生 PowerShell/cmd 进入的 CC 同样上岛、同样可跳转。
- **`scales.mjs`**:尺寸/缩放常量 + `windowSize(rowCount, collapsed, scaleName)` 纯函数,companion 与 island.html 共用(此前 SCALES 在 bridge/HTML 两处重复、窗口尺寸在 companion 写死)。
- **E2E 自驱回路 `island-e2e.mjs`**:SendInput 真实桌面回归「点击行跳转拉起已最小化窗口 / × 删行 / 空态整窗隐藏」,7 断言全自动(吸收并替代 `_dbgclick.ps1`)。坑:Win11 notepad 是打包应用、启动器 PID 立刻换身,须按进程名轮询找窗口;后台进程 `SetForegroundWindow`/ALT trick 均被前台锁拒,只有 SendInput 真实输入能立前台基准。
- **PerMonitorV2 DPI 感知**(csproj `ApplicationHighDpiMode`):高缩放屏不再位图模糊、热区坐标 125%/150% 不偏移(此前完全无 DPI 声明)。
- **WM_DISPLAYCHANGE 重归位**:分辨率/显示器拓扑变化后窗口按既定屏幕偏好自动顶部居中(此前不动)。
- **host `--screen <primary|active|N>` 自定位**:屏幕几何解析移入 C#(`Screen.AllScreens`),all 模式由 companion 先开主屏、经 `screens` 协议问到屏数再补开其余——解决「没有 host 之前不知道屏数」。
- **`SOCK` 支持 `CLAUDE_ISLAND_SOCK` env 覆盖**(测试 seam)+ island-test fake companion 基建,新增测试 12–15(windowSize / env 覆盖 / captureFg 标志 / host 原生协议)。

### Changed
- **测试套件与真实灵动岛隔离**:island-test 起套件级假 companion(127.0.0.1 临时端口),所有 bridge 默认指向它——此前测试行会真实出现在用户屏幕上、且 bridge 失连时 spawn 的 companion 会重启用户的 host。fake companion 基建从命名管道换成 TCP 临时端口(直接演练生产同款代码路径)。
- 新增测试:8.5 状态文件损坏自愈、13.5 并发 12 路 update 不丢 + 并发后文件仍合法 JSON、14.5 enabled=false 静默、探活新规则 4 例、captureFg 应答含 winClass。套件 46 → 56 断言。
- 同步文档:README / SKILL.md / CLAUDE.md 架构图与排查指南(TCP 端点、混合提权说明、探活规则、hwnd 复用防护、捕获竞态残余)。
- **`island.html.mjs` 全重写**(动效/交互全权重设计):
  - 结构:外层 `.row-wrap` 只管 transform 定位(GPU 友好),内层 `.row` 只管观感;行 DOM 只建一次,文本经 refs `textContent` 增量更新,不再整行 innerHTML 重建(无 esc/innerHTML 注入面)。
  - 动效:进场 滑入+轻弹簧、退场 上移收缩淡出、下方行平滑上滑补位(淘汰 max-height 跳变);状态切到 waiting/done 一次性 pop + 持续 inset 呼吸光;点击按压反馈;收起手柄重绘为 chevron 细柄。
  - 放大:基准行 460×34 → **540×40**(medium),字号 11.5 → 13;四档 scale 保留并以新基准重算。
  - TransparencyKey 约束落实:全部发光改 inset/实色,**消灭粉色主题外发光的品红描边**;`STATUS` 与 `THEMES.dark` 整段重复随重写消亡。
  - 命中区:从「× 右缘竖带」扩展为整行(跳转)+ 收起手柄;× 与 hover 让位行为保留。
- **companion 窗口尺寸 scale 感知 + no-op 跳过**:`syncHeight` 改用 `windowSize()`(宽高都按当前 scale 计算,`scale` 消息即时重算),同尺寸 resize 直接跳过(此前每条 update 都触发一次 SetWindowPos)。
- **companion 摆脱 PowerShell**:开窗改传 `--screen`,启动不再执行 2 次 PS 几何查询,companion 启动实测 1400ms → 400ms;`window closed before ready` 时日志输出 WebView2 Runtime 安装指引,`bridge on/toggle` 失败输出同步给出指引。
- **bridge**:`UserPromptSubmit` payload 带 `captureFg:true`;Stop/StopFailure/SessionEnd 三处重复的删 session 数据块提取为 `deleteSessionData()`;SCALES 改从 `scales.mjs` 导入。

### Fixed
- **large/xlarge 档窗口裁剪**:旧 `syncHeight` 写死 36px 行高、窗口宽 640 固定,large/xlarge 下行被裁掉(xlarge 行宽 729 > 640)。`windowSize()` 按 scale 计算宽高后修复。

### Removed
- **`platform.mjs` 删除**:屏幕几何/屏数全部移入 C# host,JS 侧再无平台分支与 PowerShell 依赖。
- **companion `socketIds` WeakMap 死代码**:维护多年从未被读取。
- **`_dbgclick.ps1`**(未跟踪调试脚本):SendInput 自驱逻辑吸收进 `island-e2e.mjs` 后删除。
- island-test 死变量 `const PASS/FAIL` 与「liveness.mjs 还不存在」过时注释。

---
以下为本轮 UI 重写之前的 Unreleased 记录:

### Added
- **关闭 CC 自动摘行**：Ctrl+C / Ctrl+D / exit → SessionEnd hook 秒级摘行；直接叉掉终端窗口 → 父进程探活（30s 轮询，process.kill 判活）兜底。细节：
  - `liveness.mjs`：纯函数 `deadRowIds(rowPids, isAlive)` 返回已死进程的 id 列表，`processIsAlive(pid)` 基于 `process.kill(pid,0)` 判活（ESRCH → 死，EPERM/其它 → 保守判活）。配套测试（island-test.mjs 测试 9）。
  - `bridge.mjs`：SessionEnd case 发 `type:remove` 到 companion 并删除 `_sessionData[sessionId]`（复用 Stop 清理逻辑）；handleHook 顶部取 `ccPid = process.ppid`，7 处 update payload 全部加上 ccPid 字段。
  - `companion.mjs`：新增 `rowPids` Map (id → ccPid)；update 分支记录 ccPid；30s 定时器调用 `deadRowIds(rowPids, processIsAlive)` 清扫已死进程（零 PowerShell）。
  - `syncHeight()` 统一处理空态隐藏：`activeRowIds.size === 0` 时 resize 0 高，避免初始空壳和多路径不一致（removeRowById/initWindow/update 全走同一规则）。
  - `island/SKILL.md`：架构事件列表 7→8 个（新增 SessionEnd）；WSL hook 示例追加 SessionEnd；阶段5 hook 配置追加 SessionEnd；阶段7 完成告知 7→8；行为节新增「关闭 CC 自动摘行」和「空了整窗隐藏」两条。**仅 WSL2 验证**，native Windows 未测试。
  - `README.md`：架构图 hook 列表补 SessionEnd (7→8)；行为节同步新增「关闭 CC 自动摘行」和「空了整窗隐藏」。
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
- **companion.mjs 语法损坏（仓库级 P0）**: 提交 `4dfb4ac` 在 `removeRowById()` 末尾残留了重复的 `send(...)` 行与多余的 `}`，`node --check` 直接 SyntaxError——companion 完全无法启动。线上未即时暴露是因为屏幕上跑的还是坏提交之前启动的旧进程，下次 reload 即失效。修复：删除重复两行。配套在 `island-test.mjs` 增加 **测试 0：全源文件 `node --check` 语法门禁**，此类损坏今后在测试suite 第一步即被拦截。
- **bridge 每次 hook 阻塞约 4.6 秒（约 40 倍提速）**: bridge 是一次性进程，但 `readStdin()` 的 5s 兜底定时器与 `connectOnce()` 的 2s 超时定时器在正常完成后**从不清理**，事件循环被挂到定时器到期才退出——实测每次 hook 调用耗时 ~4.6s（node.exe interop 冷启动本身只占 0.06s），而 PreToolUse 等 hook 会阻塞 Claude Code 的工具执行，即每次工具调用都白等数秒。修复：两处定时器在 settle 时 `clearTimeout`。实测单次 hook 4.6s → 0.12s。配套 `island-test.mjs` 测试 0.5：断言单次 hook 调用 < 3s，防回归。
- **灵动岛收起/× 点击全部失效（架构级修复）**: Task 2 用 `Form.WM_NCHITTEST` + `HitRects` 放行命中区的方案从未生效。根因：窗口靠 `AllowTransparency`+`TransparencyKey`（层叠色键窗口）透明，WebView2 把内容画在独立 DirectComposition 层、**不进入层叠窗口的命中位图**，整张位图都是 Magenta 色键 → 整窗在合成层即被判透明、鼠标直接穿透到桌面，`WM_NCHITTEST` 从未被调用（用 `SendInput` 把光标移到窗口上实测：WebView DOM 与 `Form.WndProc` 都收不到任何鼠标事件）。修复：host 安装 `WH_MOUSE_LL` 全局低级鼠标钩子（UI 线程）——左键落在 WebView 上报的命中矩形（收起按钮 + 逐行 × 右缘竖带，按 `devicePixelRatio` 换算）内 → 调 `window.island.hitClick(x,y)` 执行收起切换 / 删该行并**吞掉该次点击**（连同 up，不泄漏到岛后面的窗口），其余位置照常穿透；移动事件节流 40ms → `window.island.hover(x,y)` 驱动 ×（CSS `:hover` 在此透明穿透窗上无法触发，改用 `.row.hovered` 类）。收起按钮与逐行 × 由此首次真正可点。重编 `island-host-win.exe`/`.dll`。
- **逐行 × 与执行耗时重叠**: hover 显 × 时把右侧元信息（状态/耗时）整体左移 `20px*scale`（`.row.hovered .slot.right { margin-right }`），× 不再压住执行时间。
- **`nul` 脏文件反复生成**: `companion.mjs` 的 `taskkill /F /IM island-host-win.exe 2>nul` 在 Linux（如 `island-test.mjs` 用 Linux node 跑 companion）下被 `/bin/sh` 当成文件重定向，生成内容为 `taskkill: not found` 的 `nul` 文件。删除冗余的 `2>nul`（`stdio:"pipe"` 已抑制输出），不再产生该脏文件。
- **companion 因 idle-exit 残留调用点崩溃**: 「收起/展开」改动删除了 `idleTimer` 声明与 `scheduleIdleExit()` 函数，却漏删 `companion.mjs` 中两个调用点（连接处理器、`sock.close`），引用已不存在的符号 → `ReferenceError` → companion 在第一个客户端连接时即崩溃退出（`node --check` 查不出此类运行时错误）。删除残留两行，完成 idle-exit 移除：窗口真正永久常驻，整窗关闭只由 `/island kill` 负责（无任何定时自动消失：done-retract / ROW_TTL / idle-exit 均已清除）。
