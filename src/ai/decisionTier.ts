// ============================================================
// 决策分级：哪些决策值得请求 LLM
//
// 一笔交易里电脑要做十几二十次选择，大多数是机械的（掷骰、补牌、旁观者放行……）。
// 每次都问模型既慢又费调用，还会把人物台词的味道冲淡。分级后：
//   trivial  —— 直接用启发式（动作与台词都来自该人物的参数与台词库，不请求 LLM）
//   critical —— 有真正的取舍：报价 / 喊话、Boss 提案与成交、应答方案、出影响牌、封口费
//
// "想动手才问"（既省调用，也避免泄露手牌）：
//   · 反应窗口（要不要打阻止牌）：永远 trivial——有没有阻止牌不能从"思考得久不久"看出来
//   · 成交倒计时、谈判里的非 Boss（含与这一笔无关的旁观者）：只有启发式本身想报价 / 出牌 / 搅局时才请教 LLM
//     （让它定夺、配台词），启发式想放行 / 跳过的，直接放行
//   · Boss 的谈判回合与应答方案：永远 critical
// ============================================================

import type { GameState, PlayerAction } from '../engine/types'

export type DecisionTier = 'trivial' | 'critical'

export function decisionTier(state: GameState, actorId: number, legal: readonly PlayerAction[], heuristic: PlayerAction | null): DecisionTier {
  if (legal.length <= 1) return 'trivial'
  const wantsToAct = !!heuristic && heuristic.type !== 'PASS' && heuristic.type !== 'PASS_CLOSING'
  switch (state.phase) {
    case 'OFFER_RESPONSE':
      return 'critical'
    case 'NEGOTIATION':
      if (state.negotiation?.bossId === actorId) return 'critical'
      // 非 Boss：启发式要报价 / 出牌 / 搅局才问（与这一笔无关的旁观者因此几乎从不请求）；想放行的直接放行
      return wantsToAct ? 'critical' : 'trivial'
    case 'CLOSING':
      return wantsToAct ? 'critical' : 'trivial'
    default:
      // 放置标记 / 自己回合开单 / 手牌超限 / 反应窗口 / 终局掷骰
      return 'trivial'
  }
}
