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
