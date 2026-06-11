// scales.mjs — 尺寸/缩放常量与窗口尺寸计算(纯函数,companion 与 island.html 共用)
// 基准(scale=1,即 medium):行 540×40,收起手柄 20 高,窗口比行宽多 40 边距。

export const SCALES = { small: 0.88, medium: 1.0, large: 1.18, xlarge: 1.35 };
export const ROW_W = 540;
export const ROW_H = 40;
export const HANDLE_H = 20;
export const WIN_MARGIN = 40;

/**
 * 计算原生窗口应有尺寸。
 * @param {number} rowCount 活跃行数
 * @param {boolean} collapsed 是否收起
 * @param {string} scaleName small|medium|large|xlarge(未知回退 medium)
 * @returns {{w:number,h:number}} 设备无关 px(host 侧按窗口所在屏 DPI 呈现)
 */
export function windowSize(rowCount, collapsed, scaleName) {
  const f = SCALES[scaleName] ?? SCALES.medium;
  const w = Math.ceil((ROW_W + WIN_MARGIN) * f);
  if (rowCount === 0) return { w, h: 0 };
  const handleH = Math.ceil(HANDLE_H * f);
  if (collapsed) return { w, h: handleH };
  return { w, h: Math.ceil(rowCount * ROW_H * f) + handleH };
}
