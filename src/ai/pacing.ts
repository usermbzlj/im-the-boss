// ============================================================
// 电脑行动前的节奏停顿（纯函数，只看状态 + 速度档）
//
// 设计要点：
//   1. 反应窗口 / 成交倒计时：停顿由"窗口里的第几位"决定，与手牌、合法动作个数完全无关——
//      否则"有阻止牌的人停得更久"会泄露手牌。窗口内连续放行逐位缩短，多位 AI 连着放行的总时长有上限。
//   2. 无信息量的行动（唯一合法动作、与这一笔无关的旁观者）用很短的停顿，不让人干等。
//      旁观者的判断只看公开信息（有没有相关家族 / 有没有报价），不看手牌。
//   3. 其余（自己回合、Boss 与相关方的谈判发言、应答）用该速度档的"谈判"停顿。
// 会话把停顿与决策并行，最终等待 max(停顿, 决策)。
// ============================================================

import type { GameState, PlayerAction } from '../engine/types'
import { hasDemand, playerRelevantFamilies } from '../engine/rules'
import { AI_SPEED_DELAYS_MS, type AISpeed } from './llmClient'

/** 窗口内第 k 位的停顿：第一位全额，之后逐位减半，不低于 30ms（5 位 AI 连续放行 ≈ 2.4 × 基准） */
export function windowStepDelay(base: number, k: number): number {
  if (base <= 0) return 0
  return Math.max(Math.min(base, 30), Math.round(base * Math.pow(0.5, Math.min(k, 6))))
}

/** 一整个窗口（n 位依次放行）的总停顿上限，供测试与文档引用 */
export function windowTotalDelay(base: number, n: number): number {
  let total = 0
  for (let k = 0; k < n; k++) total += windowStepDelay(base, k)
  return total
}

/** 与这一笔交易无关的旁观者：不是 Boss、没有相关家族代表、没公开报过价（只看公开信息） */
export function isBystander(state: GameState, actorId: number): boolean {
  const neg = state.negotiation
  if (!neg || neg.bossId === actorId) return false
  return playerRelevantFamilies(state, actorId).length === 0 && !hasDemand(neg, actorId)
}

export function paceFor(speed: AISpeed, state: GameState, actorId: number, legal: readonly PlayerAction[]): number {
  const d = AI_SPEED_DELAYS_MS[speed]
  switch (state.phase) {
    case 'REACTION':
      // 只看"窗口里已经问过几位"，绝不看 legal / 手牌
      return windowStepDelay(d.reaction, state.pendingReaction?.askedIds.length ?? 0)
    case 'CLOSING':
      return windowStepDelay(d.reaction, state.negotiation?.closingIndex ?? 0)
    default:
      break
  }
  if (legal.length <= 1) return d.quiet
  if (state.phase === 'NEGOTIATION' && isBystander(state, actorId)) return d.quiet
  return d.negotiation
}
