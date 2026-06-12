// liveness.mjs — 进程探活纯逻辑(深模块:可测、无副作用)

/**
 * 返回已死进程对应的行 id 列表。
 * pid 并非总是可信:cmd 宿主的 CC 经一次性 `cmd /c` 包装进程调 hook,
 * bridge 记下的 ppid 在 hook 结束后立刻死亡——凭它判死会把活跃会话误删。
 * 判定规则:
 *   - pid 存活 → 记入 seenAlive,保留;
 *   - pid 已死且曾存活(seenAlive)→ 终端真关了,立即移除;
 *   - pid 从未存活 → 不可信,改按更新静默期兜底(超过 graceMs 无更新才移除)。
 * @param {Map<string, number>} rowPids - id → pid 映射
 * @param {(pid: number) => boolean} isAlive - 判活谓词
 * @param {{seenAlive?: Set<string>, lastUpdate?: Map<string, number>, now?: number, graceMs?: number}} [opts]
 *        seenAlive 会被本函数原地更新(记录本轮观测到的存活 id)
 * @returns {string[]} 应移除的 id 列表
 */
export function deadRowIds(rowPids, isAlive, opts = {}) {
  const {
    seenAlive = new Set(),
    lastUpdate = new Map(),
    now = Date.now(),
    graceMs = 300000,
  } = opts;
  const dead = [];
  for (const [id, pid] of rowPids) {
    if (isAlive(pid)) {
      seenAlive.add(id);
      continue;
    }
    if (seenAlive.has(id) || (now - (lastUpdate.get(id) || 0)) > graceMs) {
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
