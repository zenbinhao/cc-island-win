// IPC path shared by companion daemon and bridge client.
// Windows: Named pipe at \\.\pipe\claude-island
// CLAUDE_ISLAND_SOCK 环境变量可覆盖(测试 seam:island-test 用独立管道起 fake companion)

export const SOCK = process.env.CLAUDE_ISLAND_SOCK || "//./pipe/claude-island";
