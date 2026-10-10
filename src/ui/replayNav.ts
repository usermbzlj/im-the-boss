// ============================================================
// 复盘导航（纯函数）：自动播放跳过无关步骤、按交易 / 精彩时刻跳转
// 位置 position = 已应用的动作数（0 = 开局，recording.length = 终局）
// ============================================================

import { isMinorEvent } from '../text/narrate'
import { highlightPosition, type Highlight } from './highlights'
import type { Recording, RecordedStep } from './recording'

/** 无关紧要的一步：只有放行 / 跳过，没有台词、没有产生别的事件（自动播放可略过） */
export function isMinorStep(step: RecordedStep): boolean {
  if (step.action.say) return false
  return step.events.every(e => isMinorEvent(e))
}

/** 自动播放的下一个位置：skipMinor 时越过连续的无关步骤，但至少前进一步；已在终点返回终点 */
export function nextPosition(rec: Recording, position: number, skipMinor = false): number {
  let p = Math.min(rec.length, position + 1)
  if (!skipMinor) return p
  while (p < rec.length && isMinorStep(rec.steps[p - 1])) p++
  return p
}

export function prevPosition(position: number): number {
  return Math.max(0, position - 1)
}

/** 下一笔交易开单后的位置（没有更后面的返回 null） */
export function nextDealPosition(rec: Recording, position: number): number | null {
  for (const d of rec.deals) if (d.openStep + 1 > position) return d.openStep + 1
  return null
}

/**
 * 上一笔交易开单后的位置：已经过了本笔开单位置就回到本笔开头，否则回到再上一笔
 * （像播放器的"上一曲"：先回到本曲开头）
 */
export function prevDealPosition(rec: Recording, position: number): number | null {
  let found: number | null = null
  for (const d of rec.deals) {
    if (d.openStep + 1 < position) found = d.openStep + 1
    else break
  }
  return found
}

/** 精彩时刻的复盘位置，升序去重 */
export function highlightPositions(highlights: readonly Highlight[]): number[] {
  const set = new Set<number>()
  for (const h of highlights) {
    const p = highlightPosition(h)
    if (p != null) set.add(p)
  }
  return [...set].sort((a, b) => a - b)
}

export function nextHighlightPosition(highlights: readonly Highlight[], position: number): number | null {
  return highlightPositions(highlights).find(p => p > position) ?? null
}

export function prevHighlightPosition(highlights: readonly Highlight[], position: number): number | null {
  const ps = highlightPositions(highlights).filter(p => p < position)
  return ps.length ? ps[ps.length - 1] : null
}

/** 自动播放每一步的停留毫秒数：台词多停一会儿；speed 为倍速 */
export function stepDelayMs(step: RecordedStep | null, speed: number): number {
  const base = 900
  const say = step?.action.say ? Math.min(1800, 300 + step.action.say.length * 45) : 0
  return Math.max(40, Math.round((base + say) / Math.max(0.25, speed)))
}
