# 灵动岛 UI 重写 + 点击跳转 — 设计 spec

日期:2026-06-10
状态:已评审通过(用户确认七节全部认可)
前置:P0 热修已独立完成并提交(`bae716e`:companion 语法损坏 + bridge 残留定时器致每 hook 阻塞 4.6s → 0.12s)

## 背景与目标

用户要求"优化整个项目",方向确认为:代码质量、性能、视觉/交互(动效全权交给实现者审美)。推进方式选定 **UI 层推倒重写**,并新增一条硬需求:

> 无论从 Windows 打开的 WSL2 命令行进入的 Claude Code,还是 Windows 通过 PowerShell、cmd 进入的 Claude Code,都能通过 UI 直接跳转到对应的窗口——不然每次看到待确认(waiting)和 done 还得去找到底是哪个 Claude Code 的窗口。

另两条明确诉求:整体放大一点点;补齐 Windows 侧没做的兼容点。

### 史实约束(必须规避旧版被砍的三宗罪)

聚焦跳转(↗ 按钮)2026-06-03 曾整体删除(见 CHANGELOG Removed 节),原因:

1. 每个 hook 起一串 PowerShell 遍历进程树,拖慢全链路;
2. ↗ 按钮 + hover 整排变暗的交互/外观不被接受;
3. 单窗口多 pane 无法区分。

本设计:捕获零额外进程(§2);整行可点、无附加按钮(§2);坦白窗口级粒度限制(§2)。

## 1. 范围与原则

- `island/src/island.html.mjs` **全部重写**;`companion.mjs`、`hosts/windows/island-host.cs`、`bridge.mjs` 配套改动;C# host 重编并提交 exe。
- **保留不动的机制**:WH_MOUSE_LL 全局鼠标钩子驱动热区点击/hover(透明穿透窗的唯一可行命中方案,硬啃出来的)、TransparencyKey 抠色透明、命名管道协议骨架、bridge 一次性/companion 常驻的进程模型、按 session 隔离的状态管道。
- 三主线:观感动效重做、渲染与链路性能、点击跳转。

## 2. 点击跳转(核心新功能)

### 捕获:前台窗口 HWND,零额外进程

- `UserPromptSubmit` 时 bridge 在 update 消息上带 `captureFg: true`。
- companion 收到带此标志的 update 后,立即向常驻 C# host 发新 stdin 命令 `{type:"captureFg", sid}`;host 调 `GetForegroundWindow()`(若结果是岛自身窗口则忽略),回传 `{type:"fg", sid, hwnd}`;companion 存入 `sessionId → hwnd` 表。
- **原理**:用户刚在那个终端按下 Enter,此刻的前台窗口就是它。从回车到捕获 <0.2s;每次 UserPromptSubmit 刷新(用户把 tab 拖成新窗口也能跟上)。
- WSL2 与原生 PowerShell/cmd/Windows Terminal 完全同一机制,**不做任何终端类型探测**(旧版 PowerShell 进程树遍历不回归)。
- 多屏 all 模式:用第一个 ready 的窗口的 host 执行捕获与聚焦。

### 跳转:整行可点

- 命中矩形从「× 右缘竖带」扩展为**整行**(收起按钮照旧)。点 × = 删行;点行上其它位置 = 跳转。
- 链路:webview `hitClick` 判定 → `{type:"focus", id}` → host 转发 stdout → companion 查 `sessionId → hwnd` → 向 host 发 `{type:"focusWindow", hwnd}` → host:`IsWindow` 校验 → `IsIconic` 则 `ShowWindow(SW_RESTORE)` → `SetForegroundWindow`,前台锁用 AttachThreadInput / ALT-key trick 兜底(旧版 git 历史有现成 P/Invoke 可参考)。
- hover:行高亮 + × 浮现 + 状态侧淡入小 ↗ 暗示可跳(非常驻按钮)。
- 代价(已接受):行区域点击不再穿透到桌面。
- **限制(坦白)**:窗口级粒度,同窗多 pane 无法区分 pane;HWND 失效(窗口已关)静默忽略。

### 原生 CC 接入

Windows 侧 `C:/Users/Z/.claude/settings.json` 重新配 8 个 hooks(SessionStart→`bridge.mjs on`,其余→`bridge.mjs hook`,命令用裸 `node`)。会修改用户全局配置——已在评审中明示并获同意。WSL 侧 `/root/.claude/settings.json` 既有 8 hooks 不动。

## 3. 视觉与动效

- **放大**:medium 档行高 34→40px、行宽 460→540px、字号 11.5→13px;small/medium/large/xlarge 四档保留,全部基于新基准。
- **布局**:沿用三段式(左:旋转符+项目名 | 中:任务详情/prompt | 右:耗时·ctx%·状态),呼吸感加大。braille 旋转符保留(终端血统),按状态着色。
- **动效体系**:
  - 进场:opacity 0→1 + translateY(-10px)→0 + scale .96→1,~380ms 轻弹簧曲线(淘汰 max-height 跳变);
  - 退场:opacity→0 + 轻微上移收缩,~240ms;下方行平滑上滑补位(行用 translateY 定位,GPU 友好);
  - 状态切换:颜色 crossfade ~200ms;转入 waiting/done 一次性 pop(scale 1→1.03→1)后进入持续柔和 inset 呼吸光;
  - hover:行底色提亮 + × 浮现 + ↗ 淡入,右侧元信息让位(保留现有让位行为);
  - 点击:瞬时按压反馈(scale .985,~120ms);
  - 收起/展开:transform 折叠,收起柄重绘为细长 pill+chevron。
- **硬约束**:TransparencyKey 无逐像素 alpha → 所有发光一律 inset/实色;粉色主题现有外发光(品红描边来源)在重写中消灭。
- 主题:dark/pink/auto 三档保留,配色按新设计语言重调;现 `STATUS` 与 `THEMES.dark` 整段重复随重写消亡。
- **渲染性能**:动画只动 transform/opacity;update 增量更新文本节点(保留行内元素引用),不再整行 innerHTML 重建;ticker 机制(80ms braille / 250ms 计时)维持。

## 4. Windows 兼容补齐(C# host,重编提交)

- **PerMonitorV2 DPI 感知**(现状:完全无声明):`Application.SetHighDpiMode(HighDpiMode.PerMonitorV2)`。高缩放屏不再模糊、热区坐标 125%/150% 不偏移。⚠ 对现有点击链路风险最大的一项,E2E 回路兜底(§6)。
- **WM_DISPLAYCHANGE**:分辨率/拓扑变化后窗口按所在屏重新归位(现状:不动)。
- **host 自定位**:新增 `--screen primary|active|N` 参数,屏幕几何解析移入 C#(`Screen.AllScreens`);companion 不再为几何起 PowerShell(现状 2 次、每次数百 ms);`platform.mjs` 的 PS 依赖消亡。all 模式屏数获取:companion 先以 `--screen primary` 起第一个 host,经 stdin 命令 `{type:"screens"}` 问到屏数后再补开其余 host(解决「没有 host 之前不知道屏数」的先后问题)。
- WebView2 Runtime 缺失:host 已检测,补全链路让 `bridge on` 直接输出明确安装指引。

## 5. companion/bridge 配套与质量梳理

- **scale 感知的窗口尺寸**(存量缺陷):syncHeight 现在写死 36px 行高,large/xlarge 行被窗口裁掉;窗口宽 640 固定,xlarge(1.35×540=729px)会溢出。改为 companion 跟踪当前 scale,高与宽都按 scale 计算;同时**跳过同尺寸 no-op resize**(现状每条 update 都触发 SetWindowPos)。
- companion:删除从未使用的 `socketIds` WeakMap。
- bridge:Stop/StopFailure/SessionEnd 三处重复的删 session 数据块提取为 `deleteSessionData(sessionId)`。
- island-test:清掉死变量(`const PASS/FAIL`)与过时注释("liveness.mjs 还不存在")。
- `_dbgclick.ps1`:SendInput 自驱逻辑吸收进新 E2E 脚本后**删除**,不单独提交。

## 6. 测试与验证

- 既有 30 项(含 P0 加的语法门禁、延迟门禁)全部保持通过。
- 新增 bridge 行为断言:UserPromptSubmit 的 update 带 `captureFg`。seam:`socket-path.mjs` 的 `SOCK` 支持环境变量覆盖(如 `CLAUDE_ISLAND_SOCK`),测试起 fake socket server 捕获消息。
- **跳转 E2E 自驱回路**(全自动):脚本起一个 cmd 窗口 → 经 fake/真实链路把会话绑定其 HWND → SendInput 点击胶囊行 → 断言 `GetForegroundWindow()` 变为目标窗口。同一回路顺带回归收起按钮与逐行 ×(DPI 改动的兜底验证)。
- 视觉效果:demo 脚本 + 截图,用户人眼验收。

## 7. 文档与交付

- README.md / island/SKILL.md 同步:跳转行为、双宿主 hooks 配置(含 Windows 侧重新接入)、新尺寸基准、host 新参数。
- CHANGELOG.md 记录全部变更与背景。
- 按仓库约定分阶段独立 commit,验证后推 `0.0.1-dev`;main 不动。

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| PerMonitorV2 改变坐标语义,热区/hover 偏移 | E2E SendInput 回路在真实桌面回归;dpr 换算链路已存在 |
| SetForegroundWindow 被前台锁拒绝 | AttachThreadInput / ALT trick 兜底;旧版实现可参考 |
| 捕获时刻用户已切走(排队 prompt 等) | 每次 UserPromptSubmit 刷新,best-effort 语义,明示限制 |
| 整行重写回归收起/×链路 | 机制层(LL hook + hitrects)不动,E2E 回路全量回归 |
| 重编 exe 与 WebView2 DLL 版本漂移 | csproj 已固定 1.0.3912.50,沿用 |
