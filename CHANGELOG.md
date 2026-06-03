# 更新日志

本项目所有值得记录的变更都写在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)：
按 **Added（新增）/ Changed（变更）/ Removed（删除）/ Fixed（修复）** 分类，最新的在最上面。

## [Unreleased]

### Added
- `CLAUDE.md`：面向 Claude Code 的仓库指引（项目概述、常用命令、跨进程架构、仓库维护约定）。
- `CHANGELOG.md`：本变更日志，作为版本维护历史的唯一权威记录。
- `.gitignore`：新增忽略 `*.pdb`（.NET 调试符号）与 `Microsoft.Web.WebView2.*.xml`（WebView2 IntelliSense 文档，约 700KB），二者运行时均不需要。

### Changed
- `CLAUDE.md`：新增「WSL2 一样能驱动」说明并澄清「常用命令」措辞——`SUPPORTED_PLATFORMS=win32` 只约束 bridge/companion 须由 Windows node 运行，不限制 Claude Code 的宿主；WSL2 里把 hook 的 `node` 换成 `node.exe`（Windows node，interop 直接透传 stdin）即可驱动灵动岛。背景：实测从 WSL 跑 `echo JSON | node.exe bridge.mjs hook` 成功开窗、状态实时更新、中文/emoji stdin 无损、终端经 `WT_SESSION` 识别为 windows-terminal；此前「仅支持 Windows」的措辞反复被误读为「Claude Code 必须 Windows 原生」。
- `README.md` / `island/SKILL.md`：同步「WSL2 宿主」用法——README 安装节后新增 WSL2 提示框；SKILL 依赖节后新增「Claude Code 运行在 WSL2 时」小节，说明 hook 命令改用 `node.exe` + `C:/` 路径、interop 透传 stdin。实测：WSL 的 `/root/.claude/settings.json` 配 `node.exe` hooks 后，当前 WSL 会话被 Claude Code 热加载并真实驱动上岛（log 出现真实 session_id 的 update）。
- `README.md`：补齐与当前实现的差异——新增 `/island theme <dark|pink|auto>` 命令、`screen all` 选项、聚焦跳转说明；架构图 hook 列表补全为 7 个（增加 `StopFailure`、`PermissionRequest`）；新增「更新日志」指向。
- 初始化 Git 仓库，推送至 `github.com/zenbinhao/cc-island-win`。

### Removed
- `island/src/island.md`：删除 `SKILL.md` 的过时旧副本。该文件内容已与实现脱节（旧脚本路径少了 `src/`、依赖已废弃的 `prompt`/`tool-start`/`tool-end`/`done` 子命令、误述「完成后 5 秒自动消失」实际为 30 秒、缺少 theme / StopFailure / PermissionRequest），留在公开仓库会误导读者。**skill 的唯一权威文档为 `island/SKILL.md`。**
