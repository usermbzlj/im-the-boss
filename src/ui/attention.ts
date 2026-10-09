// ============================================================
// "轮到你了"的判定（纯函数）
// 轮到视角玩家、且确实需要他做决定时才提醒：只能放行的窗口（反应窗口没有阻止牌 / 成交倒计时没有可打的牌）
// 运行时会自动放行，不应闪烁标题、不应抢注意力。
// ============================================================

import type { GameState, PlayerAction } from '../engine/types'

/** 页面不在前台时，标题交替显示这句 */
export const TURN_ALERT_TITLE = '【轮到你了】'

/** legal = 视角玩家此刻的合法动作（getLegalActions(state, viewerId)） */
export function needsAttention(state: GameState, legal: readonly PlayerAction[]): boolean {
  if (state.phase === 'GAME_OVER' || legal.length === 0) return false
  if (state.phase === 'REACTION') return legal.some(a => a.type === 'PLAY_STOP')
  if (state.phase === 'CLOSING') return legal.some(a => a.type !== 'PASS_CLOSING')
  return true
}

/** 现在能不能"快进"：只要不是在等视角玩家做决定，就是电脑（或自动放行）在行动 */
export function canSkipWait(state: GameState, legal: readonly PlayerAction[]): boolean {
  return state.phase !== 'GAME_OVER' && !needsAttention(state, legal)
}
