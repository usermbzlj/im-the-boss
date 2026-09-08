// ============================================================
// Policy — 电脑玩家的决策接口
//
// 运行时（GameSession）只认识这个接口：给它当前状态，拿回一个 PlayerAction。
// 具体是启发式还是 LLM、要不要人格扮演，都是 Policy 内部的事。
// 契约：返回的动作必须通过 validator.isLegal；返回 null 表示"我放弃，请兜底"。
// ============================================================

import type { GameState, PlayerAction } from '../engine/types'
import { isLegal } from '../engine/validator'

export interface Policy {
  name: string
  /**
   * @param state 当前状态（行动者 = getActingPlayerId(state)，保证是 AI）
   * @param signal 状态已推进 / 会话销毁时触发，实现方应尽快放弃
   */
  decide(state: GameState, signal: AbortSignal): Promise<PlayerAction | null>
}

/**
 * 主策略失败（异常 / 超时 / 返回 null 或非法动作）时改用备用策略。
 * 主策略的异常只记录不抛出，保证运行时永远拿得到动作。
 */
export function withFallback(primary: Policy, fallback: Policy, onFallback?: (reason: string) => void): Policy {
  return {
    name: `${primary.name}→${fallback.name}`,
    async decide(state, signal) {
      try {
        const action = await primary.decide(state, signal)
        if (signal.aborted) return null
        if (action && isLegal(state, action)) return action
        onFallback?.(action ? `${primary.name} 返回了非法动作 ${action.type}` : `${primary.name} 未给出动作`)
      } catch (e) {
        if (signal.aborted) return null
        onFallback?.(e instanceof Error ? e.message : String(e))
      }
      return fallback.decide(state, signal)
    },
  }
}
