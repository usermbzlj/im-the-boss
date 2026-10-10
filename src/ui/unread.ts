// ============================================================
// unread — 侧栏抽屉的"未读"计数（抽屉收起时，谈判 / 日志里有多少条你还没看的动态）
//   只数有意义的：别人的喊话，以及会弹提示的事件（出牌 / 夺权 / 提案 / 成交 / 流局 …，不含你自己刚做的动作）。
//   放行 / 跳过等噪音事件、"谁在考虑"都不算——与提示框同一套筛选（ui/toasts.briefOf），也不会泄露隐藏信息。
// ============================================================

import type { GameState, LoggedEvent } from '../engine/types'
import { briefOf } from './toasts'

/** 一条事件算不算"值得提醒的未读" */
export function isUnreadWorthy(state: GameState, e: LoggedEvent, viewerId: number): boolean {
  if (e.kind === 'SPEECH') return e.playerId !== viewerId
  const b = briefOf(state, e, viewerId)
  return !!b && b.toast && !b.selfEcho
}

/** lastSeenId 之后的未读条数 */
export function unreadCount(state: GameState, lastSeenId: number, viewerId: number): number {
  let n = 0
  for (let i = state.events.length - 1; i >= 0; i--) {
    const e = state.events[i]
    if (e.id <= lastSeenId) break
    if (isUnreadWorthy(state, e, viewerId)) n++
  }
  return n
}

/** 状态里最后一条事件的 id（没有 = 0） */
export function lastEventId(state: GameState): number {
  return state.events[state.events.length - 1]?.id ?? 0
}

/** 未读徽标上的文字：> 9 显示 9+ */
export function unreadLabel(n: number): string {
  return n > 9 ? '9+' : String(n)
}
