// ============================================================
// "提案并宣布成交"：先发 PROPOSE_OFFER，再基于最新状态判断 CLOSE_DEAL 是否合法，合法就立刻发出。
// 方案里所有需要表态的人都会按承诺价自动同意时，提案之后 Boss 的回合不变，可以直接宣布成交。
// ============================================================

import type { GameState, Payout, PlayerAction } from '../engine/types'
import { isLegal } from '../engine/validator'

/**
 * proposed：方案已提出，但成交还不合法（还有人要表态，或没有全员同意）
 * closed：方案已提出且已宣布成交
 * rejected：提案没被引擎接受（状态没变）
 */
export type ProposeAndCloseResult = 'closed' | 'proposed' | 'rejected'

export function proposeAndClose(
  act: (action: PlayerAction) => unknown,
  getState: () => GameState | null,
  viewerId: number,
  repKeys: string[],
  payouts: Payout[],
): ProposeAndCloseResult {
  const before = getState()
  act({ type: 'PROPOSE_OFFER', playerId: viewerId, repKeys, payouts })
  const after = getState()
  if (!after || after === before) return 'rejected'
  const close: PlayerAction = { type: 'CLOSE_DEAL', playerId: viewerId }
  if (!isLegal(after, close)) return 'proposed'
  act(close)
  return 'closed'
}
