---
name: island
description: >
  配置桌面级灵动岛状态胶囊，在屏幕顶部显示 Claude Code 实时工作状态。
  触发词：/island、灵动岛、island、状态胶囊、dynamic island、屏幕顶部显示。
  支持 on/off/toggle/scale/screen/reload/kill/status/setup 命令。
  当用户提到灵动岛相关操作（初始化、开启、关闭、调整大小、重启、设置、状态查看）时使用此 skill。
---

![灵动岛多会话截图](screenshots/08-multi-session.png)
![任务完成状态](screenshots/06-done.png)
![等待用户确认](screenshots/07-waiting.png)

# 灵动岛 (Dynamic Island) for Claude Code

配置一个电脑桌面级灵动岛风格的状态胶囊，固定在屏幕顶部，实时显示 Claude Code 当前正在做什么，并支持跳转对应窗口

- **Windows**: 屏幕顶部居中胶囊，WinForms + WebView2

## 架构

```
Claude Code hooks (settings.json)
  ↓ SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop / StopFailure / PermissionRequest
bridge.mjs  (一次性进程，每次 hook 调用，数据来自 stdin JSON)
  ↓ Named pipe
companion.mjs  (常驻守护进程，永不自动退出)
  ↓ stdin/stdout JSON-line 协议
原生窗口 (C# WebView2)
  └─ 渲染透明背景黑色胶囊 HTML
```

## 目录结构

所有源文件位于本 skill 目录下的 `src/` 子目录：

| 文件 | 作用 |
|------|------|
| `src/companion.mjs` | 常驻守护进程，管理 WebView 窗口 + socket 服务 |
| `src/bridge.mjs` | Hook 桥接脚本，读取 stdin JSON 更新状态 |
| `src/build.mjs` | 编译原生主机二进制文件 |
| `src/island.html.mjs` | WebView 内渲染的 HTML/CSS/JS |
| `src/open-fixed.mjs` | 原生主机进程的 spawn 封装 |
| `src/platform.mjs` | 平台抽象层（屏幕检测、窗口定位） |
| `src/socket-path.mjs` | IPC 路径定义 |
| `src/island-test.mjs` | 自动化测试脚本 |
| `src/hosts/windows/` | Windows 原生主机 C# 源码 + 预编译 exe |

**脚本根目录**：所有命令执行前，先将路径定位到 `~/.claude/skills/island/`，然后使用 `src/` 子目录下的脚本。

---

## 依赖

| 依赖 | 用途 | 安装方式 |
|------|------|---------|
| **Node.js** | 运行所有 JS 脚本（bridge/companion） | Claude Code 自带，无需额外安装 |
| **.NET Desktop Runtime 8.0+** | Windows：运行预编译的 island-host-win.exe | `winget install Microsoft.DotNet.DesktopRuntime.8`（50MB）。8.0/9.0/10.0 均可 |
| **.NET 8 SDK** | Windows：从源码编译 exe（仅 exe 丢失时需要） | `winget install Microsoft.DotNet.SDK.8`（200MB） |
| **WebView2 Runtime** | Windows：渲染胶囊 HTML | Windows 10+ 已内置，Win10 LTSC 需手动安装 |

预编译 exe（`src/hosts/windows/island-host-win.exe`）已内置在 skill 目录中，**绝大多数用户无需安装任何编译工具**，如未找到，请重新核实目录是否正确，路径或转义是否正确解析，只需 .NET Desktop Runtime 8.0 即可运行。

### Claude Code 运行在 WSL2 时

灵动岛 UI 只在 Windows 桌面渲染，但 Claude Code 的宿主可以是 WSL2。此时 **hook 命令必须用 Windows 的 node（`node.exe`），不能用 WSL 的 Linux node**——后者连不上 Windows 命名管道、`platform.mjs` 也只认 `win32`。

配置 hooks 时（WSL 的 `~/.claude/settings.json`，如 `/root/.claude/settings.json`），把命令里的 `node` 换成 `node.exe`，bridge 路径用 Windows 形式 `C:/…`：

```json
"SessionStart": [{"matcher":"","hooks":[{"type":"command","command":"node.exe C:/Users/<你>/.../island/src/bridge.mjs on"}]}]
```

其余 6 个 hook 同理改用 `node.exe ... bridge.mjs hook`。`node.exe` 在 WSL 默认 PATH 内可直接调用，interop 会把 hook 的 stdin JSON 原样透传到 Windows node（含中文 / emoji，已实测无损；终端经 `WT_SESSION` 仍识别为 `windows-terminal`）。代价：每个 hook 多一次 interop 冷启动（约 1~2 秒）。状态文件统一落在 Windows 侧 `C:\Users\<你>\.claude`，与 Windows 原生会话共享、按 session 堆叠不串。

---

## /island 命令

用户通过 `/island` 与灵动岛交互。你需要根据参数执行相应操作。

### 0. 初始化 — /island setup

当用户执行 `/island setup` 或说"初始化灵动岛"时，**由你（Agent）自动完成全部配置**，不要引导用户手动操作。

#### 流程：检查 → 询问 → 自动执行

**阶段 1：检查环境**

并行执行以下检查：

Windows:
```powershell
# 检查 exe
Test-Path "$env:USERPROFILE\.claude\skills\island\src\hosts\windows\island-host-win.exe"
# 检查 Runtime（8.0/9.0/10.0 均可）
dotnet --list-runtimes | Select-String "Microsoft.WindowsDesktop.App [89]"
```

**阶段 2：汇总并询问**

根据检查结果，汇总状态并一次性告知用户：

> 检查结果：
> - 预编译 exe: ✅ / ❌
> - .NET Desktop Runtime 8.0+: ✅ (版本 x.x.x) / ❌
>
> [如果全部 ✅] 环境就绪，是否开始配置灵动岛？
> [如果缺少依赖] 需要安装以下依赖（共约 XX MB），是否继续？
>   - .NET Desktop Runtime 8.0 (50MB) — winget install Microsoft.DotNet.DesktopRuntime.8
>   [如果 exe 也缺失] - .NET 8 SDK (200MB) — winget install Microsoft.DotNet.SDK.8

**等待用户确认。用户回复"确定"/"是"/"继续"后进入阶段 3。**

**阶段 3：自动安装依赖（如有缺失）**

若缺少 .NET Desktop Runtime 8.0+：
```powershell
winget install Microsoft.DotNet.DesktopRuntime.8
```

若 exe 不存在，需要 .NET 8 SDK 并编译：
```powershell
winget install Microsoft.DotNet.SDK.8
node ~/.claude/skills/island/src/build.mjs
```

**阶段 4：初始化状态 + 启动 companion（灵动岛立即可见）**

```bash
node ~/.claude/skills/island/src/bridge.mjs init
```
此命令会立即启动 companion 和灵动岛窗口，无需 reload。

**阶段 5：配置 hooks**

读取 `~/.claude/settings.json`，合并以下 hooks（路径使用正斜杠 `/`，Windows 展开 `~` 为绝对路径）：

```json
{
  "hooks": {
    "SessionStart": [{"matcher":"","hooks":[{"type":"command","command":"node <HOME>/.claude/skills/island/src/bridge.mjs on"}]}],
    "UserPromptSubmit": [{"matcher":"","hooks":[{"type":"command","command":"node <HOME>/.claude/skills/island/src/bridge.mjs hook"}]}],
    "PreToolUse": [{"matcher":"","hooks":[{"type":"command","command":"node <HOME>/.claude/skills/island/src/bridge.mjs hook"}]}],
    "PostToolUse": [{"matcher":"","hooks":[{"type":"command","command":"node <HOME>/.claude/skills/island/src/bridge.mjs hook"}]}],
    "Stop": [{"matcher":"","hooks":[{"type":"command","command":"node <HOME>/.claude/skills/island/src/bridge.mjs hook"}]}],
    "StopFailure": [{"matcher":"","hooks":[{"type":"command","command":"node <HOME>/.claude/skills/island/src/bridge.mjs hook"}]}],
    "PermissionRequest": [{"matcher":"","hooks":[{"type":"command","command":"node <HOME>/.claude/skills/island/src/bridge.mjs hook"}]}]
  }
}
```

合并规则：
- 先读取现有 settings.json，**不覆盖已有其他 hooks**
- 若已有同类型 hook，将 island 的 hook **追加**到数组末尾
- `<HOME>` 替换为用户实际 home 目录绝对路径，使用正斜杠

**阶段 6：验证**

```bash
node -e "const s=require(process.env.HOME+'/.claude/settings.json'); for(const [k,arr] of Object.entries(s.hooks||{})){ for(const e of arr){ if(e.command&&!e.hooks){ console.log('BAD FORMAT in '+k); process.exit(1); } } } console.log('OK');"
```

**阶段 7：完成告知**

全部完成后告知用户：

> ✅ 灵动岛配置完成！
> - 状态：运行中
> - 已配置 7 个 hook：SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, StopFailure, PermissionRequest
> -  支持开机自启
>
> 常用命令：
> - `/island on` — 显示灵动岛
> - `/island off` — 隐藏灵动岛
> - `/island toggle` — 切换显示/隐藏
> - `/island scale <small|medium|large|xlarge>` — 调整大小
> - `/island screen <primary|active|all|1|2>` — 选择屏幕
> - `/island theme <dark|pink|auto>` — 切换主题
> - `/island reload` — 重启灵动岛
> - `/island status` — 查看状态
> - `/island kill` — 完全关闭

### 1. /island on — 显示灵动岛

```bash
node ~/.claude/skills/island/src/bridge.mjs on
```

### 2. /island off — 隐藏灵动岛

```bash
node ~/.claude/skills/island/src/bridge.mjs off
```

### 3. /island toggle — 切换显示/隐藏

```bash
node ~/.claude/skills/island/src/bridge.mjs toggle
```

### 4. /island scale <size> — 调整大小

可选值: `small`, `medium`, `large`, `xlarge`

```bash
node ~/.claude/skills/island/src/bridge.mjs scale <size>
```

### 5. /island screen <value> — 选择屏幕

可选值: `primary`（主屏幕）、`active`（鼠标所在屏幕）、`all`（所有屏幕各显示一个胶囊）、`1`、`2`、`3`...（指定第N个屏幕）

```bash
node ~/.claude/skills/island/src/bridge.mjs screen <value>
```

### 6. /island theme <theme> — 切换主题

可选值: `dark`（原始黑色/默认）、`pink`（马卡龙粉）、`auto`（跟随系统 light/dark 模式）

```bash
node ~/.claude/skills/island/src/bridge.mjs theme <theme>
```

主题偏好会持久化到 `~/.claude/claude-island.json`，重启后自动恢复。

### 7. /island reload — 重启灵动岛

强制杀掉 companion 并重新启动（状态重置）:

```bash
node ~/.claude/skills/island/src/bridge.mjs reload
```

### 8. /island kill — 完全关闭

```bash
node ~/.claude/skills/island/src/bridge.mjs kill
```

### 9. /island status — 查看状态

```bash
node ~/.claude/skills/island/src/bridge.mjs status
```

输出当前状态（enabled、scale、project 等）。

---

## 故障排查

当用户报告灵动岛有问题时，**由你（Agent）主动执行检查**，不要只是告诉用户怎么做。

### 灵动岛不显示

按顺序执行：

1. 查看日志：
   Windows: `Get-Content "$env:USERPROFILE\.claude\claude-island.log" -Tail 20`
2. 检查状态并告知用户当前 enabled/scale/运行状态
3. 若 enabled=false → 执行 `/island on`
4. 若 companion 未运行 → 执行 `bridge.mjs reload`
5. 若持续异常 → 检查 .NET Runtime 和 WebView2 Runtime

### 状态卡住 / 不更新

执行 `/island reload` 强制清理并重启。

### WebView2 初始化失败 (Windows)

检查 WebView2 Runtime。若缺失，引导安装：https://developer.microsoft.com/en-us/microsoft-edge/webview2/

### 窗口位置不对

查看 log 中的 `screenGeo` 行，建议用户尝试 `/island screen primary` 或 `/island screen active`。

### companion 进程残留

执行 `/island kill`，通过 PID 文件精确终止。

---

## 行为说明

- **自动启动**: Claude Code 启动时（SessionStart hook），灵动岛自动出现。
- **自动出现**: 发送消息后，状态行立即显示（UserPromptSubmit hook）。
- **自动消失**: 正常完成 30 秒后状态行自动移除（done-retract）；Ctrl+C 中断 30 秒后显示 "interrupted" 并移除。
- **兜底清理**: 120 秒无更新的行自动移除（防止异常终止后残留）。
- **多会话**: 每个 Claude Code 实例有独立的 sessionId，灵动岛会堆叠显示各行。
- **永久常驻**: companion 不会自动退出，灵动岛窗口在屏幕顶部持续显示。关闭需用 `/island kill`。
- **重启恢复**: 电脑重启后，下次打开 Claude Code 时 SessionStart hook 自动启动灵动岛，无需手动操作。
- **日志文件**: 位于 `~/.claude/claude-island.log`，最大 256KB，自动轮转。
- **偏好设置**: `~/.claude/claude-island.json`（enabled, scale, screen, theme）
- **会话状态**: `~/.claude/claude-island-state.json`（`_sessionData` 按 session_id 隔离各会话）
- **PID 文件**: `~/.claude/claude-island.pid`（用于精确进程管理）
- **聚焦按钮**: 鼠标悬停在灵动岛上时，每行左侧出现 ↗ 圆形按钮，点击可聚焦到对应 session 的终端窗口。支持 WezTerm、Windows Terminal、PowerShell、CMD、Git Bash、VSCode 终端。
- **主题切换**: 支持 dark（默认黑色）、pink（马卡龙粉）、auto（跟随系统）三种主题，通过 `/island theme` 切换。

当灵动岛需要更新时，应当在一次命令中杀掉已有的灵动岛进程并进行更新，避免多次命令间hook重启旧灵动岛程序。