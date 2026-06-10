# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

本仓库是一个 Claude Code 的 **skill**（`island`）：在 **Windows** 屏幕顶部显示桌面级「灵动岛」状态胶囊，实时反映 Claude Code 当前在做什么（思考 / 读取 / 编辑 / 写入 / 执行 / 搜索 / 完成 / 等待确认）。仅支持 Windows（WinForms + WebView2）。

`island/SKILL.md` 是 **skill 的唯一权威文档**（Claude Code 加载 skill 时读取它，含安装、`/island` 命令、故障排查）。`README.md` 面向 GitHub 访客。两者在行为/命令变化时都需同步。

## 常用命令

脚本都在 `island/src/`，用 Node.js 运行（Claude Code 自带 node）。**bridge / companion 必须由 Windows node 运行**——会涉及命名管道与原生 exe。但 Claude Code 的宿主既可是 Windows 原生终端，**也可是 WSL2**（此时 hook 改调 `node.exe`，详见架构小节「WSL2 一样能驱动」一条）。

```bash
# 运行测试套件：向 bridge 灌入模拟的 hook stdin JSON，验证事件分派、
# 跨 session 数据隔离、工具名→状态映射、过期 session 清理。
# 会读写真实的 ~/.claude/claude-island-state.json，退出码表示通过/失败。
node island/src/island-test.mjs

# 编译 Windows 原生主机（仅当预编译 exe 丢失时才需要，要装 .NET 8 SDK）
node island/src/build.mjs

# 手动驱动灵动岛（CLI 模式子命令）
node island/src/bridge.mjs <on|off|toggle|scale|screen|theme|reload|kill|status|init>

# 真实桌面 E2E：SendInput 驱动「点击行跳转 / × 删行 / 空态隐藏」回归。
# ⚠ 会真实移动鼠标、起一个 notepad 窗口，跑完自动清理；仅手动按需运行。
node island/src/island-e2e.mjs

# 调试 companion：直接前台运行，stderr 实时打印到终端
node island/src/companion.mjs
```

## 架构

四层、跨进程的状态管道——改动其中一环通常要同时看相邻文件：

```
Claude Code hooks (settings.json)
  ↓ stdin JSON   SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop / StopFailure / PermissionRequest / SessionEnd
bridge.mjs           一次性进程：每次 hook 调用启动一次，读 stdin JSON，转成状态消息
  ↓ 命名管道  //./pipe/claude-island   (socket-path.mjs)
companion.mjs        常驻守护进程：socket 服务端 + 拥有原生窗口，按 session 渲染各自的胶囊行
  ↓ stdin/stdout JSON-line 协议   (open-fixed.mjs 封装 spawn)
island-host-win.exe  C# WinForms + WebView2 原生窗口   (hosts/windows/island-host.cs)
  └─ 渲染透明背景胶囊 HTML   (island.html.mjs 生成的 HTML/CSS/JS 字符串)
```

跨文件的关键设计（容易踩坑）：

- **hook 数据走 stdin JSON，不是命令行变量替换。** Claude Code **不会**替换命令里的 `${PROMPT}` / `${TOOL_NAME}`；真实字段在 stdin 的 JSON payload 里。`bridge.mjs` 按 `hook_event_name` 分派，`tool_name` 经 `toolToIsland()` 映射到状态。
- **bridge 一次性、companion 常驻。** bridge 每次 hook 都是新进程、自身不存状态；跨调用的会话状态持久化在 `~/.claude/claude-island-state.json` 的 `_sessionData[sessionId]` 下，按 session 隔离以免多会话串扰，10 分钟不活跃自动清理。
- **companion 单例。** 命名管道地址被占用（EADDRINUSE）时，后启动者直接退出，保证全局只有一个守护进程。
- **屏幕几何 / DPI / 聚焦全部在 C# host 层。** host 以 `--screen <primary|active|N>` 自定位（顶部居中），PerMonitorV2 DPI 感知，WM_DISPLAYCHANGE 自动重新归位；JS 侧不再有任何 PowerShell 或平台分支（`platform.mjs` 已删除）。all 模式由 companion 先开主屏 host、经 `screens` 协议问到屏数再补开其余。
- **点击跳转链路（整行可点，pane 级）。** `UserPromptSubmit` 时 bridge 标记 `captureFg` → companion 让常驻 host 捕获前台 HWND + **UIA 焦点元素 RuntimeId**（HWND 级壳如 WT 的 InputSite 要向下钻到持键盘焦点的 TermControl）存表 → 点击行经 `focus` 消息回流 → host `SW_RESTORE` + ALT trick + `SetForegroundWindow` 拉起窗口，再按 RuntimeId `SetFocus()` 该 pane（失败则对其中心补真实点击）。WT 分屏可精确回到那个 pane；定位失败退窗口级；零额外进程（旧版被砍的 PowerShell 进程树探测不许回归）。坑：UIA 在 WPF 程序集里，csproj 开 `UseWPF` 后 SDK 会移除隐式 `System.IO` using；跨完整性级别（提权差异）UIA 会被拦。尺寸常量统一在 `scales.mjs`（companion 与 island.html 共用）。
- **灵动岛只限 Windows *桌面*，不限 Claude Code 的宿主——WSL2 一样能驱动。** **bridge / companion 必须由 Windows node 运行**，但不要求 Claude Code 跑在 Windows 原生终端。在 WSL2 里，把 hook 命令里的 `node` 换成 `node.exe`（Windows node，WSL interop 可直接调用并原样透传 stdin），bridge 就跑在 Windows 侧，后续链路与纯 Windows 完全一致。已实测：从 WSL 跑 `echo JSON | node.exe <仓库>/island/src/bridge.mjs hook` 能正常开窗、状态实时更新、中文 / emoji prompt 无损，且因 `WT_SESSION` 经 WSLENV 透传，终端仍被识别为 `windows-terminal`。代价：每个 hook 多一次 interop 冷启动开销。**别再断言「WSL 下做不了」。**
- **发往 C# 主机的 stdin 只传 ASCII。** `open-fixed.mjs` 把 JSON 里的非 ASCII 字符转成 `\uXXXX`，规避 Windows 管道编码导致的 Unicode 损坏。
- **预编译 exe 有意提交进仓库**（`island/src/hosts/windows/`），让用户免装 .NET SDK 即可运行；`build.mjs` 只在 exe 丢失时用到。`.pdb` 与 WebView2 `*.xml` 文档不入库（见 `.gitignore`）。

## 仓库维护约定

- **自律用 git 维护版本**：推进本项目时主动用 git commit，提交信息说明改了什么；无需每次征求是否提交。先在*-dev分支上工作，验证完成后，直接push到远端*-dev分支，master分支仅允许用户自己操作。
- **及时同步文档**：行为 / 命令变化时，同步更新 `README.md` 与 `island/SKILL.md`。
- **维护 `CHANGELOG.md`**：每次维护新增 / 删减的内容都记在这里，含变更说明与背景。**变更历史与注解一律以 `CHANGELOG.md` 为准**——CLAUDE.md 不内联变更注解，只在此指向 `CHANGELOG.md`。
- **远端**：`git@github.com:zenbinhao/cc-island-win.git`（SSH，身份 `zenbinhao`）。
