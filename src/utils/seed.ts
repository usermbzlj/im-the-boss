// 开局页的种子输入解析

/**
 * 把输入框文本解析成种子：空串 / 非数字 → undefined（随机）；"0" 是合法种子。
 * 取绝对值、向下取整、折成 32 位无符号整数。
 */
export function parseSeed(text: string): number | undefined {
  const t = text.trim()
  if (t === '') return undefined
  const n = Number(t)
  if (!Number.isFinite(n)) return undefined
  return Math.abs(Math.floor(n)) >>> 0
}
