# 灵动岛：关闭 CC 自动摘行/整窗隐藏 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 关闭 Claude Code 时自动移除对应会话行,最后一行移除后整窗隐藏(SessionEnd 即时 + process.kill 探活兑底,仅 WSL2)

**Architecture:** 双通道—— SessionEnd hook 即时摘行(Ctrl+C/Ctrl+D/exit,秒级)+ companion 每30s 用 process.kill(ppid,0) 探活兑底(叉窗口,≤30s)。空了 resize(WIN_W,0) 隐藏窗口,companion 续活。

**Tech Stack:** Node.js, 命名管道 IPC(Windows), Claude Code hooks

---

## 文件改动地图

- **island/src/bridge.mjs** (556 行): 新增 `case "SessionEnd"` (发 remove + 删 session 数据); handleHook 各 update payload 加 `ccPid: process.ppid`
- **island/src/companion.mjs** (311 行): 新增 `rowPids` Map + 30s 探活定时器; `removeRowById` 删 rowPids + 空了隐藏窗口; 抽 `deadRowIds` 纯函数
- **island/src/island-test.mjs** (146 行): 新增 SessionEnd 回归测试 + `deadRowIds` 单测
- **island/SKILL.md**: hook 配置加 SessionEnd (第8个); 架构/行为节更新
- **README.md**: 行为/hook 描述同步
- **CHANGELOG.md**: 记录 Added

---

### Task 1: deadRowIds 纯函数(探活核心逻辑,可测)

**Files:**
- Create: `island/src/liveness.mjs` (新文件,专职探活判定逻辑)
- Test: `island/src/island-test.mjs:147+` (追加单测)

- [ ] **Step 1: 写 deadRowIds 纯函数的失败测试**

在 `island/src/island-test.mjs` 末尾(第146行后)追加:

```javascript
  // ── Test 9: deadRowIds 纯函数 ────────────────────────────────────────
  console.log("\n9. deadRowIds 纯函数(探活逻辑)");
  // 动态导入 liveness.mjs(还不存在)
  const { deadRowIds } = await import("./liveness.mjs");
  
  const pids = new Map([["a", 100], ["b", 200], ["c", 300]]);
  const fakeIsAlive = (pid) => pid !== 200;  // 200 已死
  const dead = deadRowIds(pids, fakeIsAlive);
  
  assert(dead.length === 1, "deadRowIds 返回1个死 id");
  assert(dead[0] === "b", "deadRowIds 正确识别 pid=200 对应 id=b");
  
  // 边界: 空 Map
  assert(deadRowIds(new Map(), fakeIsAlive).length === 0, "空 Map 返回空数组");
  
  // 边界: 全活
  const allAlive = new Map([["x", 1], ["y", 2]]);
  assert(deadRowIds(allAlive, () => true).length === 0, "全活返回空数组");
```

- [ ] **Step 2: 运行测试验证失败**

Run: `node island/src/island-test.mjs`
Expected: 测试9失败 "Cannot find module './liveness.mjs'"

- [ ] **Step 3: 实现 deadRowIds 最小代码**

创建 `island/src/liveness.mjs`:

```javascript
// liveness.mjs — 进程探活纯逻辑(深模块:可测、无副作用)

/**
 * 返回已死进程对应的行 id 列表
 * @param {Map<string, number>} rowPids - id → pid 映射
 * @param {(pid: number) => boolean} isAlive - 判活谓词
 * @returns {string[]} 已死的 id 列表
 */
export function deadRowIds(rowPids, isAlive) {
  const dead = [];
  for (const [id, pid] of rowPids) {
    if (!isAlive(pid)) {
      dead.push(id);
    }
  }
  return dead;
}

/**
 * 生产用 isAlive: process.kill(pid,0) 探活
 * 不抛错 → 活; ESRCH → 死; EPERM → 保守视为活(避免误删)
 */
export function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== "ESRCH";  // EPERM/其它 → 保守判活
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `node island/src/island-test.mjs`
Expected: 测试9全部通过,总计 "13 通过, 0 失败"

- [ ] **Step 5: Commit**

```bash
git add island/src/liveness.mjs island/src/island-test.mjs
git commit -m "test: deadRowIds 纯函数(探活判定逻辑)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: bridge 增加 SessionEnd hook 处理

**Files:**
- Modify: `island/src/bridge.mjs:358` (在 StopFailure 后、default 前插入 SessionEnd case)
- Test: `island/src/island-test.mjs:147+` (追加 SessionEnd 测试)

- [ ] **Step 1: 写 SessionEnd 的失败测试**

在 `island/src/island-test.mjs` 测试9后追加:

```javascript
  // ── Test 10: SessionEnd 即时摘行 ───────────────────────────────────
  console.log("\n10. SessionEnd hook 处理");
  await runBridge(JSON.stringify({
    session_id: "sess-end", cwd: "/home/end",
    hook_event_name: "UserPromptSubmit", prompt: "will end",
  }));
  const stateBefore = readState();
  assert(stateBefore._sessionData["sess-end"], "sess-end 会话已创建");
  
  // 触发 SessionEnd
  const rEnd = await runBridge(JSON.stringify({
    session_id: "sess-end", cwd: "/home/end",
    hook_event_name: "SessionEnd", reason: "prompt_input_exit",
  }));
  
  const stateAfter = readState();
  assert(!stateAfter._sessionData?.["sess-end"], "SessionEnd 后 session 数据已删除");
  assert(rEnd.stderr.includes("session=sess-end"), "SessionEnd 被处理");
```

- [ ] **Step 2: 运行测试验证失败**

Run: `node island/src/island-test.mjs`
Expected: 测试10失败,session 数据未删除(因 bridge 还没 SessionEnd case)

- [ ] **Step 3: 在 bridge.mjs 实现 SessionEnd case**

在 `island/src/bridge.mjs:358` (StopFailure case 后、default 前)插入:

```javascript
    case "SessionEnd": {
      log(`SessionEnd reason=${json.reason || "(none)"}`);
      await sendToCompanion({
        id: sessionId, type: "remove",
      });
      // 删除 session 数据(复用 Stop 逻辑)
      try {
        if (existsSync(STATE_FILE)) {
          const data = JSON.parse(readFileSync(STATE_FILE, "utf8"));
          if (data && data._sessionData && data._sessionData[sessionId]) {
            delete data._sessionData[sessionId];
            writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
          }
        }
      } catch {}
      break;
    }
```

- [ ] **Step 4: 运行测试验证通过**

Run: `node island/src/island-test.mjs`
Expected: 测试10通过,总计 "15 通过, 0 失败"

- [ ] **Step 5: Commit**

```bash
git add island/src/bridge.mjs island/src/island-test.mjs
git commit -m "feat: SessionEnd hook 即时摘行(发 remove + 删 session 数据)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: bridge 各 update 加 ccPid 字段

**Files:**
- Modify: `island/src/bridge.mjs:233-310` (handleHook 顶部取 ccPid,各 sendToCompanion update 加该字段)

- [ ] **Step 1: 在 handleHook 顶部取 ccPid**

在 `island/src/bridge.mjs:240` (在 `log(...)` 行后)插入:

```javascript
  const ccPid = process.ppid;  // WSL2: wsl.exe 中继 PID; native: 待验证
```

- [ ] **Step 2: UserPromptSubmit update 加 ccPid**

修改 `bridge.mjs:256-260` 的 `sendToCompanion`:

```javascript
      await sendToCompanion({
        id: sessionId, type: "update",
        project, status: "thinking", detail: "",
        prompt: sess.prompt, startedAt: sess.startedAt, frozenElapsed: null,
        ccPid,
      });
```

- [ ] **Step 3: PreToolUse update 加 ccPid**

修改 `bridge.mjs:276-280` 的 `sendToCompanion`:

```javascript
      await sendToCompanion({
        id: sessionId, type: "update",
        project, status: upd.status, detail: upd.detail,
        prompt: sess.prompt || "", startedAt: sess.startedAt, frozenElapsed: null,
        ccPid,
      });
```

- [ ] **Step 4: PostToolUse error 分支加 ccPid**

修改 `bridge.mjs:291-295`:

```javascript
        await sendToCompanion({
          id: sessionId, type: "update",
          project, status: "error", detail: toolName,
          prompt: sess.prompt || "", startedAt: sess.startedAt, frozenElapsed: null,
          ccPid,
        });
```

- [ ] **Step 5: PostToolUse thinking 分支加 ccPid**

修改 `bridge.mjs:297-301`:

```javascript
        await sendToCompanion({
          id: sessionId, type: "update",
          project, status: "thinking", detail: "",
          prompt: sess.prompt || "", startedAt: sess.startedAt, frozenElapsed: null,
          ccPid,
        });
```

- [ ] **Step 6: PermissionRequest update 加 ccPid**

修改 `bridge.mjs:309-313`:

```javascript
      await sendToCompanion({
        id: sessionId, type: "update",
        project, status: "waiting", detail: toolName,
        prompt: sess.prompt || "", startedAt: sess.startedAt, frozenElapsed: null,
        ccPid,
      });
```

- [ ] **Step 7: Stop update 加 ccPid**

修改 `bridge.mjs:321-325`:

```javascript
      await sendToCompanion({
        id: sessionId, type: "update",
        project, status: "done", detail: "",
        prompt: sess.prompt || "", startedAt: sess.startedAt, frozenElapsed: sess.frozenElapsed,
        ccPid,
      });
```

- [ ] **Step 8: StopFailure update 加 ccPid**

修改 `bridge.mjs:343-347`:

```javascript
      await sendToCompanion({
        id: sessionId, type: "update",
        project, status: "error", detail: "interrupted",
        prompt: sess.prompt || "", startedAt: sess.startedAt, frozenElapsed: sess.frozenElapsed,
        ccPid,
      });
```

- [ ] **Step 9: 运行测试验证不破坏现有功能**

Run: `node island/src/island-test.mjs`
Expected: 所有测试仍通过 "15 通过, 0 失败"

- [ ] **Step 10: Commit**

```bash
git add island/src/bridge.mjs
git commit -m "feat: bridge 各 update 带上 ccPid (process.ppid)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: companion 记录 ccPid + 探活清扫

**Files:**
- Modify: `island/src/companion.mjs:199+` (新增 rowPids Map, update 分支记 pid, removeRowById 删 pid, 30s 探活定时器)

- [ ] **Step 1: 在 companion 顶部导入 liveness**

在 `island/src/companion.mjs:1` 顶部 import 列表里追加:

```javascript
import { deadRowIds, processIsAlive } from "./liveness.mjs";
```

- [ ] **Step 2: 在 activeRowIds 后新增 rowPids Map**

在 `island/src/companion.mjs:199` (const activeRowIds 行后)插入:

```javascript
const rowPids = new Map();  // id → ccPid, 用于探活
```

- [ ] **Step 3: update 分支记录 ccPid**

在 `companion.mjs:234` (activeRowIds.add 行后)插入:

```javascript
      if (typeof msg.ccPid === "number" && msg.ccPid > 0) {
        rowPids.set(msg.id, msg.ccPid);
      }
```

- [ ] **Step 4: removeRowById 删除 ccPid**

在 `companion.mjs:211` (activeRowIds.delete 行后)插入:

```javascript
  rowPids.delete(id);
```

- [ ] **Step 5: 新增 30s 探活定时器**

在 `companion.mjs:295` (server.listen 后,文件末尾前)插入:

```javascript

// ── Liveness checker (30s) ─────────────────────────────────────────────
setInterval(() => {
  const dead = deadRowIds(rowPids, processIsAlive);
  for (const id of dead) {
    log("info", `liveness check: row ${id} pid=${rowPids.get(id)} is dead, removing`);
    removeRowById(id);
  }
}, 30_000);
```

- [ ] **Step 6: 运行测试验证不破坏现有功能**

Run: `node island/src/island-test.mjs`
Expected: 所有测试仍通过 "15 通过, 0 失败"

- [ ] **Step 7: Commit**

```bash
git add island/src/companion.mjs
git commit -m "feat: companion 30s 探活清扫(process.kill 判活,零 PowerShell)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: removeRowById 空了隐藏窗口

**Files:**
- Modify: `island/src/companion.mjs:210-215` (removeRowById 末尾加空判隐藏)

- [ ] **Step 1: 在 removeRowById 末尾加窗口隐藏逻辑**

修改 `companion.mjs:210-215` 的 `removeRowById`:

```javascript
function removeRowById(id) {
  activeRowIds.delete(id);
  rowPids.delete(id);
  currentRows.delete(id);
  syncHeight();
  send('window.island.removeRow(' + JSON.stringify(id) + ')');
  
  // 空了隐藏窗口(resize 0 高,不动 C#)
  if (activeRowIds.size === 0) {
    log("info", "last row removed, hiding window (resize to 0)");
    for (const w of wins) {
      try { w.resize(WIN_W, 0); } catch (e) {
        log("warn", `resize(0) failed: ${e.message}`);
      }
    }
  }
}
```

- [ ] **Step 2: 运行测试验证不破坏现有功能**

Run: `node island/src/island-test.mjs`
Expected: 所有测试仍通过 "15 通过, 0 失败"

- [ ] **Step 3: Commit**

```bash
git add island/src/companion.mjs
git commit -m "feat: 空了隐藏窗口(resize 0 高),下次 update 自动复现

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: SKILL.md 新增 SessionEnd hook 配置

**Files:**
- Modify: `island/SKILL.md:24,71,137-148,170,287` (架构/hook 配置/计数)

- [ ] **Step 1: 架构事件列表加 SessionEnd**

修改 `island/SKILL.md:24`:

```markdown
  ↓ SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop / StopFailure / PermissionRequest / SessionEnd
```

- [ ] **Step 2: WSL hook 示例加 SessionEnd**

修改 `island/SKILL.md:71-72`,在 SessionStart 示例后追加:

```json
"SessionEnd": [{"matcher":"","hooks":[{"type":"command","command":"node.exe C:/Users/<你>/.../island/src/bridge.mjs hook"}]}],
```

- [ ] **Step 3: 阶段5 hook 配置加 SessionEnd(第8个)**

修改 `island/SKILL.md:141-148`,在现有7个后追加第8个:

```json
    "SessionEnd": [{"matcher":"","hooks":[{"type":"command","command":"node <HOME>/.claude/skills/island/src/bridge.mjs hook"}]}]
```

- [ ] **Step 4: hook 计数 7→8**

修改 `island/SKILL.md:170`:

```markdown
> - 已配置 8 个 hook：SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, StopFailure, PermissionRequest, SessionEnd
```

- [ ] **Step 5: 行为节加关闭自动摘行**

在 `island/SKILL.md:287` (自动启动 bullet 后)插入:

```markdown
- **关闭 CC 自动摘行**: Ctrl+C/Ctrl+D/exit → SessionEnd hook 秒级摘行;直接叉掉终端窗口 → 父进程探活(30s 轮询,process.kill 判活)兜底。**仅 WSL2 验证**,native Windows 未测试。
- **空了整窗隐藏**: 最后一行移除后窗口隐藏(resize 0 高),companion 守护进程继续存活;下次任意 update 自动复现。
```

- [ ] **Step 6: Commit**

```bash
git add island/SKILL.md
git commit -m "docs: SKILL.md 新增 SessionEnd hook(第8个) + 关闭摘行/空了隐藏行为

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 7: README.md 同步行为描述

**Files:**
- Modify: `README.md` (行为节同步 SessionEnd / 关闭摘行 / 空了隐藏)

- [ ] **Step 1: 找到 README.md 行为描述节并更新**

在 README.md 的行为特性节(通常在"特性"或"使用"段落)同步 SKILL.md 的措辞:

```markdown
- 关闭 Claude Code 自动摘行: Ctrl+C/Ctrl+D/exit 秒级摘行(SessionEnd hook);叉窗口 ≤30s 摘行(探活兜底)
- 空了整窗隐藏,下次有事件自动复现
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README 同步关闭摘行/空了隐藏行为

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 8: CHANGELOG.md 记录变更

**Files:**
- Modify: `CHANGELOG.md` (顶部追加 Added 条目)

- [ ] **Step 1: CHANGELOG 顶部追加新变更**

在 `CHANGELOG.md` 最新版本段落顶部追加:

```markdown
### Added
- 关闭 Claude Code 自动摘行: SessionEnd hook 即时摘行(Ctrl+C/Ctrl+D/exit,秒级) + 30s 父进程探活兜底(process.kill 判活,零 PowerShell,叉窗口 ≤30s)。**仅 WSL2 验证**,native Windows 未测试。
- 空了整窗隐藏: 最后一行移除后 resize(WIN_W,0) 隐藏窗口,companion 续活,下次 update 自动复现。统一所有摘行路径(关 CC / 探活 / 手动 ×)。
- 新增 liveness.mjs 探活纯函数模块(deadRowIds + processIsAlive),深模块设计,可单测。
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG 记录 SessionEnd 摘行 + 探活兜底 + 空了隐藏

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 9: HITL 验证(必需,GUI/真实进程)

**Files:**
- 无代码改动,纯人工验证

- [ ] **Step 1: 启动 companion 观察日志**

在一个 WSL pane:

```bash
cd /mnt/c/Users/Z/Desktop/claude-code-island
node island/src/companion.mjs
```

保持前台运行,观察日志输出。

- [ ] **Step 2: 另一 pane 启动 CC,触发 SessionEnd**

在另一 WSL pane:

```bash
# 启动 CC,发送消息,观察灵动岛出现对应行
# 然后 Ctrl+C 或 Ctrl+D 退出
```

Expected: companion 日志显示 `remove id=<session>`,对应行**秒级消失**。

- [ ] **Step 3: 验证叉窗口探活**

```bash
# 再启动一个 CC,发消息,观察岛上出现行
# 直接叉掉该 pane 的终端窗口/标签
```

Expected: companion 日志 ≤30s 显示 `liveness check: row ... is dead`,行自动消失。

- [ ] **Step 4: 验证空了隐藏窗口**

关掉所有运行 CC 的 pane,触发最后一行摘除。

Expected: companion 日志 `last row removed, hiding window`,整窗消失(或缩成不可见)。

- [ ] **Step 5: 验证窗口复现**

在任意 pane 再次启动 CC 并发消息。

Expected: 灵动岛窗口自动复现,显示新会话行。

- [ ] **Step 6: 如果 resize(0) 仍可见,改走 A 方案**

若 Step 4 窗口仍留可见痕迹:

1. 修改 `island/src/hosts/windows/island-host.cs` 加 hide/show 命令处理
2. 修改 `island/src/open-fixed.mjs` 暴露 `hide()`/`show()` 方法
3. `companion.mjs` removeRowById 改调 `w.hide()`,update 分支改调 `w.show()`
4. `node island/src/build.mjs` 重编 exe
5. 提交 exe 产物,重跑 HITL

否则跳过,B 方案足够。

---

### Task 10: Push 到远端 0.0.1-dev

**Files:**
- 无

- [ ] **Step 1: 确认当前分支与远端**

```bash
git branch --show-current
git remote -v
```

Expected: 当前 `0.0.1-dev`,远端 `git@github.com:zenbinhao/cc-island-win.git`

- [ ] **Step 2: Push 到远端**

```bash
git push origin 0.0.1-dev
```

Expected: 推送成功,所有 commits 上传到远端 0.0.1-dev 分支。

---

## 自检清单(Self-Review)

### 1. Spec 覆盖检查

- [x] SessionEnd 即时摘行 → Task 2
- [x] 父进程探活兜底 → Task 1(纯函数) + Task 3(ccPid) + Task 4(定时器)
- [x] 空了隐藏窗口 → Task 5
- [x] SKILL.md hook 配置 SessionEnd → Task 6
- [x] README/CHANGELOG 同步 → Task 7,8
- [x] 测试(SessionEnd 回归 + deadRowIds 单测) → Task 1,2
- [x] HITL 验证 → Task 9
- [x] Push 远端 → Task 10

### 2. Placeholder 扫描

无 TBD/TODO/实现细节占位符。所有代码块完整可执行。

### 3. 类型/命名一致性

- `deadRowIds(rowPids, isAlive)` → 各任务统一
- `ccPid` / `rowPids` / `processIsAlive` → 统一
- `removeRowById(id)` → 统一调用点

