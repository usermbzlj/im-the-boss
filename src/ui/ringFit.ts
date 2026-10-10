// ============================================================
// ringFit — 环形版图的"挑行数 + 缩放"纯函数（从 TableBoard 抽出，便于单测）
//   pickRingRows：按可用宽高挑外圈行数（越扁的区域用越少的行）
//   fitScale：整张外圈放不下时的等比缩放；手机上有最小缩放，放不下就让版图区域滚动，不再缩到看不清
// ============================================================

import { ringRowOptions } from '../engine/config'

/** 格子的自然尺寸：最小宽、典型高（含内容撑高余量）、间距（px） */
export interface RingMetric { w: number; h: number; gap: number }

/** 三档格子尺寸（与 game.css 的 .ring-grid / .ring-lg / .ring-xl 对应）+ 紧凑档（手机 / 矮屏，对应 .ring-compact） */
export const RING_METRICS = {
  '': { w: 112, h: 100, gap: 6 },
  ' ring-lg': { w: 96, h: 84, gap: 5 },
  ' ring-xl': { w: 84, h: 72, gap: 4 },
  ' ring-compact': { w: 60, h: 56, gap: 3 },
} as const satisfies Record<string, RingMetric>
export type SizeClass = keyof typeof RING_METRICS

/** 手机上版图允许缩到的最小比例：再小字就看不清了，宁可让版图区域滚动 */
export const MIN_COMPACT_SCALE = 0.8

/** 行数对应的外圈列数 */
export function ringCols(n: number, rows: number): number {
  return Math.round((n - 2 * (rows - 2)) / 2)
}

/** 某行数下外圈的自然尺寸 */
export function ringNeed(n: number, rows: number, m: RingMetric): { w: number; h: number } {
  const cols = ringCols(n, rows)
  return { w: cols * m.w + (cols - 1) * m.gap, h: rows * m.h + (rows - 1) * m.gap }
}

/**
 * 按版图区域的实际宽高挑外圈行数：对每种行数估算外圈的自然尺寸，取"缩放最少"的一种；
 * 同样放得下时保留更方的（行数更多的）。
 */
export function pickRingRows(n: number, availW: number, availH: number, m: RingMetric): number {
  const options = ringRowOptions(n)
  let best = options[options.length - 1]
  let bestFit = -1
  for (const rows of options) {
    const need = ringNeed(n, rows, m)
    const fit = Math.min(1, availW / need.w, availH / need.h)
    if (fit >= bestFit - 1e-6) { best = rows; bestFit = fit }
  }
  return best
}

/** 自然尺寸 (gw × gh) 放进 (w × h) 的缩放比；min 给出下限（手机用），超出区域的部分靠滚动 */
export function fitScale(gw: number, gh: number, w: number, h: number, min = 0): number {
  const k = Math.min(1, gw > 0 ? w / gw : 1, gh > 0 ? h / gh : 1)
  return Math.max(Math.min(1, Math.max(0, min)), k)
}
