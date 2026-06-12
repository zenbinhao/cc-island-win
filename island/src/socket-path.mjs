// IPC 端点,companion 服务端与 bridge 客户端共用(net.connect / server.listen 通吃)。
// 默认 TCP 回环 127.0.0.1:38917,显式绑回环以免暴露到局域网。
// 为什么不用命名管道:管道句柄携带创建者的安全描述符——管理员 WT 里拉起的
// companion,其管道会拒绝非提权 Claude Code(普通 cmd)连接(实测 EPERM),
// 表现为该会话的灵动岛永远不显示 + bridge 反复 spawn 注定 EADDRINUSE 的
// companion;回环 TCP 无完整性级别限制,高并发 connect 也不再瞬时失败。
// CLAUDE_ISLAND_SOCK 可覆盖:纯数字 → 端口;其它 → 管道/套接字路径(测试 seam)。

const RAW = process.env.CLAUDE_ISLAND_SOCK || "38917";
export const SOCK = /^\d+$/.test(RAW)
  ? { port: Number(RAW), host: "127.0.0.1" }
  : { path: RAW };
