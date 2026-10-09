// ============================================================
// 浏览器环境：真 LLM（失败回退启发式）+ localStorage 存档 + 按"电脑速度"设置的拟人停顿
// 测试 / 仿真不用它，直接给 createSession.ts 的 SessionEnv 传假策略 / 内存存储 / 零延迟。
// ============================================================

import type { GameState, PlayerAction } from '../engine/types'
import type { SessionEnv } from '../game/createSession'
import { withFallback } from '../ai/policy'
import { heuristicPolicy } from '../ai/heuristic'
import { createLLMPolicy } from '../ai/llmPolicy'
import { loadLLMConfig, AI_SPEED_DELAYS_MS } from '../ai/llmClient'
import { getDefaultStore } from '../utils/storage'

/**
 * 默认停顿：反应窗口用 reaction 档，其余用 negotiation 档（与引入 delayFor 之前完全一致）。
 * 参数里的 actorId / 合法动作暂未使用——后续可据此对"无信息量动作"跳过停顿
 * （注意：反应窗口的停顿不能随"是否持有阻止牌"变化，否则泄露手牌）。
 */
export function defaultDelayFor(state: GameState, _actorId: number, _legalActions: readonly PlayerAction[]): number {
  const d = AI_SPEED_DELAYS_MS[loadLLMConfig().aiSpeed]
  return state.phase === 'REACTION' ? d.reaction : d.negotiation
}

export function createBrowserEnv(): SessionEnv {
  return {
    policy: withFallback(createLLMPolicy(loadLLMConfig), heuristicPolicy, reason => console.warn('[AI] 回退到启发式：', reason)),
    delayFor: defaultDelayFor,
    store: getDefaultStore(),
    loadSaved: () => getDefaultStore().load(),
    onError: message => console.error('[GameSession]', message),
  }
}
