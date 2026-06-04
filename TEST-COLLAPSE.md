# 收起/展开功能手动测试指南

## 前置条件
确保没有其他灵动岛实例在运行：
```bash
node island/src/bridge.mjs kill
```

## 测试步骤

### 1. 启动 companion
```bash
node island/src/companion.mjs
```
（保持这个终端运行）

### 2. 在另一个终端发送测试事件
```bash
echo '{"hook_event_name":"UserPromptSubmit","session_id":"test-1","cwd":"/test","prompt":"测试消息 1"}' | node island/src/bridge.mjs hook
```

**预期效果**：屏幕顶部出现灵动岛，显示一个胶囊行，底部中间有一个小尖尖向上的按钮（▲）

### 3. 测试手动收起
点击屏幕上的 ▲ 按钮

**预期效果**：
- 胶囊行渐变向上折叠消失（300ms 动画）
- 窗口高度缩小到 30px
- 小尖尖旋转 180 度变成向下（▼）
- companion 日志输出：`collapse state changed: true`

### 4. 测试手动展开
点击屏幕上的 ▼ 按钮

**预期效果**：
- 胶囊行渐变展开显示
- 窗口高度恢复正常
- 小尖尖旋转回向上（▲）
- companion 日志输出：`collapse state changed: false`

### 5. 测试自动展开
a) 先手动收起（点击 ▲）
b) 发送新的测试事件：
```bash
echo '{"hook_event_name":"UserPromptSubmit","session_id":"test-2","cwd":"/test","prompt":"测试自动展开"}' | node island/src/bridge.mjs hook
```

**预期效果**：
- 灵动岛自动展开
- 显示新的胶囊行
- companion 日志输出：`auto-expanded due to new update`

### 6. 测试多行收起/展开
发送多个事件创建多行：
```bash
echo '{"hook_event_name":"UserPromptSubmit","session_id":"sess-a","cwd":"/a","prompt":"会话 A"}' | node island/src/bridge.mjs hook
echo '{"hook_event_name":"UserPromptSubmit","session_id":"sess-b","cwd":"/b","prompt":"会话 B"}' | node island/src/bridge.mjs hook
echo '{"hook_event_name":"UserPromptSubmit","session_id":"sess-c","cwd":"/c","prompt":"会话 C"}' | node island/src/bridge.mjs hook
```

点击收起按钮（▲），确认：
- 所有胶囊行一起折叠消失
- 窗口缩小到 30px（不管有多少行）

点击展开按钮（▼），确认：
- 所有胶囊行一起展开
- 窗口高度根据行数动态调整

## 清理
```bash
node island/src/bridge.mjs kill
```

## 已知限制
- 目前命名管道被占用时无法启动新的 companion
- 需要先关闭其他 Claude Code 会话的灵动岛
