// ============================================================
// 浏览器环境：混合决策（LLM 管关键决策 + 熔断 + 人物化启发式兜底）+ localStorage 存档 + 按"电脑速度"设置的拟人停顿
// 测试 / 仿真不用它，直接给 createSession.ts 的 SessionEnv 传假策略 / 内存存储 / 零延迟。
// ============================================================

import type { GameState, PlayerAction } from '../engine/types'
import type { SessionEnv } from '../game/createSession'
import { createAiRuntime, type AiRuntime } from '../ai/aiPolicy'
import { loadLLMConfig } from '../ai/llmClient'
import { paceFor } from '../ai/pacing'
import { getDefaultStore } from '../utils/storage'

/**
 * 默认停顿（速度档读设置，实时生效）。算法在 ai/pacing.ts：
 * 反应窗口 / 成交倒计时的停顿只看"窗口里第几位"，与手牌无关；无信息量的行动用很短的停顿。
 */
export function defaultDelayFor(state: GameState, actorId: number, legalActions: readonly PlayerAction[]): number {
  return paceFor(loadLLMConfig().aiSpeed, state, actorId, legalActions)
}

/**
 * 熔断状态跨局保留（接口挂了，下一局不必再白等两次超时才发现）；每局开始会话会调用 status.reset()：
 * 回退计数清零、固定本局桌风，熔断则改为"第一次关键决策立即探测"（用户可能刚改好了设置）。
 */
let runtime: AiRuntime | null = null

/** envFactory 每开 / 载入一局调用一次 */
export function createBrowserEnv(): SessionEnv {
  const ai = (runtime ??= createAiRuntime(loadLLMConfig))
  return {
    policy: ai.policy,
    aiStatus: ai.status,
    delayFor: defaultDelayFor,
    store: getDefaultStore(),
    loadSaved: () => getDefaultStore().load(),
    onError: message => console.error('[GameSession]', message),
  }
}
