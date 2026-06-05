# 灵动岛：关闭 Claude Code 时自动摘行 / 整窗隐藏 — 设计

- 日期：2026-06-05
- 分支：0.0.1-dev
- 状态：设计四点已逐项确认（关闭语义=按会话；兑底=父进程探活；空了=隐藏窗口、companion 续活；范围=仅 WSL2）；待 spec 评审

## 背景与动机

用户关闭 Claude Code 后，灵动岛上对应那行不会消失，整窗也不收。现状根因（实测确认）：

1. **没挂 `SessionEnd` hook** —— 优雅退出时 bridge/companion 收不到任何通知。现有 7 个 hook（SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop / StopFailure / PermissionRequest）无 SessionEnd。
2. **`Stop` 只冻结不摘行**（`bridge.mjs:317`）：把行冻成 `done` + 删状态文件该 session 数据，但发给 companion 的是 `type:"update"` 不是 `remove`，可见行仍在。
3. **companion 纯事件驱动**：无定时器/轮询，不记 CC 进程信息。bridge 是一次性进程，每个 hook 连一次断一次 → socket 断开天天发生，**不能**当会话结束信号。
4. **现有「10 分钟过期清理」是假的**（`bridge.mjs:221`）：只在下一次 hook 触发时顺手删状态文件、不摘可见行；CC 一关更没 hook 触发它。
5. **摘掉最后一行后窗口不消失**：`syncHeight()` 缩到 52px 空壳常驻。

## 与历史决策的关系（关键，避免哲学冲突）

上一个设计（`2026-06-04-island-per-row-dismiss`）把灵动岛定为「**永久看板、无 TTL**，只靠逐行 `×` + `/island kill` 手动清理」，并特意删掉了 idle-exit 与 ROW_TTL。

本设计**不复活 TTL**。区别在触发语义：

- **被否决的 idle-timeout**：「闲置 N 分钟就摘」——与「永久看板」抵触（一个活着但没动的会话会被误摘）。用户在设计问答中明确拒绝。
- **本设计采用的探活**：「**进程真没了才摘**」——只在会话/终端确实终止时移除，与「看板代表真实存在的会话」一致。活着但闲置的会话 PID 仍在 → 行保留。

唯一**改写**历史行为的点：上个设计保留「最后一行消除后留 52px 空壳窗」，本设计改为「**空了隐藏窗口**」（用户本次明确选「最后一个关了整窗消失」）。详见「整窗隐藏」一节及「待评审决策」。

## 目标

1. 关闭 CC 时，对应会话行自动从灵动岛移除（覆盖用户全部四种关闭方式）。
2. 最后一行移除后，整窗隐藏；companion 守护进程继续存活，下次 SessionStart/update 瞬间复现。
3. 探活**不依赖 PowerShell/系统进程表查询**，只用 Node 自带 `process.kill(pid,0)`。
4. 行为变更同步 `README.md` / `island/SKILL.md` / `CHANGELOG.md`。

## 非目标 / 范围

- **仅 WSL2 方向**。native Windows 直跑 CC 那条不在范围、不验证。`ccPid` 机制通用、native 下不报错，但 native 下 `process.ppid` 是否对应 CC 长期进程未经证实（可能是瞬时 wrapper → 误删），故标注「未支持/未验证」，不为其写代码、不为其调参。
- **不复活任何 TTL / idle-exit**。
- **不追求零轮询的「连接断开即感知」IPC**（架构不允许，见下）。
- **不加全局 exit 按钮**；`/island kill` 仍是整窗彻底关闭的手段。

## 为何做不到「连接断开即感知」（架构硬约束）

理想是：CC 持有一条到 companion 的长连接，CC 一死连接断、companion 即刻知道。本架构做不干净：

- 只有 **Windows 进程**能持有发往 companion 的命名管道（`//./pipe/claude-island`）；WSL 里的 CC 是 Linux 进程，连不上。
- hook 模型只给**一次性进程**（bridge 每次 hook 起一次、立即退）；无法借它维持一条「与会话同寿」的长连接。
- 唯一与 pane 同寿的 Windows 进程是 wsl.exe 中继，但我们没法让它替我们持有自定义长连接。
- 硬造常驻 keeper，keeper 自己仍要探测 CC 死活 → 绕回轮询。

故采用「轮询 + 零系统依赖判活」，把系统依赖从 PowerShell 降为 Node 内建调用。

## 关闭方式覆盖矩阵

| 关闭方式 | 触发事件 | 摘行机制 | 时延 |
|---|---|---|---|
| Ctrl+C（输入框退出） | `SessionEnd`（reason 多为 `prompt_input_exit`） | 即时 `remove` | 秒级 |
| Ctrl+D | `SessionEnd`（`prompt_input_exit`） | 即时 `remove` | 秒级 |
| `exit` / `/quit` | `SessionEnd` | 即时 `remove` | 秒级 |
| 叉掉终端窗口/标签 | **无任何事件** | `ccPid` 探活 | ≤ 轮询间隔（30s） |

## 实测依据（WSL2）

- 从 WSL 经 interop 拉起的 `node.exe`，`process.ppid` = 启动该 pane 的 **wsl.exe 中继**；连跑三次恒定（长期存活，非每调用新起）。
- 系统里 wsl.exe 成对成链、**每个 pane 一条独立链**（实测两个 pane：`7408(终端)→22512→50172`、`7408→50880→29864`），叶子中继 PID 各不同 → 可按 pane 区分。
- `process.kill(<relay>,0)` → 不抛错（ALIVE）；`process.kill(<死PID>,0)` → 抛 `ESRCH`。判活可行、零外部进程。

> 注：探的是「该 pane 的 wsl.exe 中继」存活，非 CC 进程本身。对「叉掉终端窗口」场景正好够用；CC-exit-但-shell-还在 的情形由 `SessionEnd` 即时兜住。

## 架构与数据流

复用现有四层管道，仅增量改动 bridge 与 companion，host/C# **不改**（采用 resize 隐藏方案时）。

### A. 即时通道 —— `SessionEnd` hook

```
SessionEnd hook → node(.exe) bridge.mjs hook
  → bridge handleHook: case "SessionEnd"
      ├─ sendToCompanion({ id: sessionId, type: "remove" })
      └─ 删 STATE_FILE 内 _sessionData[sessionId]（复用 Stop 里那段）
  → companion: 已有 msg.type==="remove" 分支 → removeRowById(id)
```

- SKILL.md hook 配置新增第 8 个：`"SessionEnd": [{... bridge.mjs hook}]`。
- 命令同其它 hook 用 `hook` 子命令（非 `on`），WSL 下 `node` 换 `node.exe`。

### B. 兑底通道 —— 父进程探活

```
每个 hook（handleHook）：update payload 增加 ccPid: process.ppid   // 零成本
  → companion msg.type==="update"：rowPids.set(id, msg.ccPid)
companion setInterval(30_000)：
  → 对 rowPids 每项 process.kill(pid,0)；抛 ESRCH（且非 EPERM）→ removeRowById(id) + rowPids.delete(id)
```

- bridge：在 handleHook 顶部取 `const ccPid = process.ppid;`，并入每个 `sendToCompanion({... type:"update" ...})` 的 payload。
- companion：
  - 新增 `const rowPids = new Map();`，`update` 分支里 `if (typeof msg.ccPid === "number") rowPids.set(msg.id, msg.ccPid);`。
  - `removeRowById(id)` 内补 `rowPids.delete(id)`。
  - 新增 30s `setInterval` 执行探活清扫。

### C. 整窗隐藏（空了）

`removeRowById` 末尾：若 `activeRowIds.size === 0` → 隐藏所有窗口。
- **推荐手段（B 方案，不动 C#）**：`for (w of wins) w.resize(WIN_W, 0)`，把窗口压成 0 高。透明背景 + 0 高 ≈ 不可见。
- **复现**：`update` 分支已有「activeRowIds.add + syncHeight」，syncHeight 会按行数 resize 回正常高度，自然复现。
- 备选手段（A 方案，若 0 高仍可见）：给 host 加 `hide/show` stdin 命令（动 `island-host.cs` 的 `Form.Hide()`/`ShowPassive()` + 重编 exe + 提交二进制）。

## 探活的可测性设计（深模块，避免依赖真实进程/定时器）

把「判断哪些行该摘」抽成纯函数，与「定时器 + 真实 process.kill + 摘行副作用」解耦：

```js
// 纯函数：给定 id→pid 映射与一个 isAlive 谓词，返回应移除的 id 列表
export function deadRowIds(rowPids, isAlive) { ... }
```

- 生产：`isAlive = (pid) => { try { process.kill(pid,0); return true; } catch (e) { return e.code !== "ESRCH"; } }`（EPERM 视为存活，保守不误删）。
- 测试：传入假 `isAlive`（如 `pid => pid !== 42`），断言 `deadRowIds` 只返回该摘的 id。无需起真实进程、无需等定时器。
- 定时器与摘行副作用是薄包装，靠 HITL 验。

## 错误处理 / 边界 / 取舍

- **PID 回收不防（知情取舍）**：`process.kill(pid,0)` 无法校验进程名（校验需 PowerShell，与目标 3 冲突）。极小概率：中继 PID 死后恰被另一活进程复用 → 该行多留一会儿。概率低、后果轻、优雅退出已被 `SessionEnd` 即时兜住 → 接受，不为它加回 PowerShell。
- **ccPid 缺失/为 0**：探活清扫跳过无 pid 的行（只摘「明确探到已死」的，不摘「不知道」的），避免误删。
- **EPERM**：视为存活（保守），不摘。
- **多窗口**：`removeRowById` 经 `send()` 广播 `removeRow` 到所有窗口；隐藏/复现亦对所有 `wins` 生效。
- **手动 × 与隐藏的交互**：见「待评审决策」。
- **native Windows**：范围外；机制不报错，但行为不保证。

## 测试与验证

- **自动化护栏**：
  - `node --check`（语法）。
  - `node island/src/island-test.mjs`：新增「`SessionEnd` 事件 → bridge 发出 `type:"remove"` + 删 `_sessionData[sessionId]`」的回归（向 bridge 灌 SessionEnd stdin JSON，断言行为）。现有用例应保持通过。
  - `deadRowIds` 纯函数单测（假 isAlive）。
- **HITL（GUI/真实进程，必需）**：
  1. WSL pane 跑 CC，Ctrl+C/Ctrl+D/exit → 对应行**秒级消失**（SessionEnd）。
  2. WSL pane 跑 CC，**直接叉掉终端窗口** → 对应行 **≤30s 消失**（探活）；companion 日志可见探活摘行。
  3. 多 pane：关其一只摘其行，其余保留；关到最后一个 → **整窗隐藏**；再在某 pane 发消息 → 窗口**复现**。

## 组件改动清单

- `island/src/bridge.mjs`：新增 `case "SessionEnd"`（发 remove + 删 session 数据，复用 Stop 里删除段）；handleHook 各 `update` payload 加 `ccPid: process.ppid`。
- `island/src/companion.mjs`：`rowPids` Map；`update` 分支记 ccPid；`removeRowById` 删 rowPids + 空了隐藏窗口；新增 30s 探活 `setInterval`；抽 `deadRowIds` 纯函数 + `isAlive`。
- `island/src/island-test.mjs`：加 SessionEnd 回归 + `deadRowIds` 单测。
- `island/src/hosts/windows/island-host.cs`：**采用 B 方案则不改**；仅当 0 高仍可见、改走 A 方案时才动（加 hide/show 命令）并 `node island/src/build.mjs` 重编、提交 exe。
- 文档：`README.md` / `island/SKILL.md`（hook 列表 7→8、新增 SessionEnd、行为节加「关闭即摘行/空了隐藏」、hook 计数表述）；`CHANGELOG.md` 记 Added。

## 文档同步要点

- SKILL.md：架构事件列表加 `SessionEnd`；阶段5 hook 配置加第 8 条；「已配置 7 个 hook」→「8 个」并补 SessionEnd；行为节加「关闭 CC 自动摘行（SessionEnd 即时 + 父进程探活兑底）、最后一行走后整窗隐藏」。
- README.md：行为/hook 描述同步。
- CHANGELOG.md：Added 记「SessionEnd 即时摘行 + 30s 父进程探活兑底（process.kill，零 PowerShell）+ 空了整窗隐藏」；注明仅 WSL2、PID 回收取舍。

## 待评审决策（请用户确认）

1. **手动 `×` 消除最后一行时，是否也整窗隐藏？**
   - 推荐：**统一「空了即隐藏」**（无论摘行原因）。语义一致：空看板=隐藏；下次有事件再现。
   - 代价：改写上个设计「× 最后一行留 52px 空壳」的行为。
2. **隐藏手段 B（resize 0 高）若实测仍露出可见痕迹**，是否接受改走 A（加 host hide 命令 + 重编 exe）？默认：先试 B，B 不行再 A。
