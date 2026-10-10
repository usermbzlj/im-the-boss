// ============================================================
// 电脑玩家的产品策略：混合决策 + 熔断 + 人物化兜底
//
//   decide(state)
//     1. 先算启发式动作 h（纯函数、瞬时、带该人物的台词）——它既是兜底，也是"分级"的依据
//     2. 唯一合法动作 / 未配置 LLM / 琐碎决策（决策范围 = 关键决策时）→ 直接用 h，不请求
//     3. 熔断中 → 用 h（记一次回退，不发请求）；到点放行一次探测
//     4. 请求 LLM：成功用它的动作；回复不合法 / 超时 / 网络错误 → 用 h（说话的仍是同一个人），并上报回退
//   被取消（局面已推进 / 会话销毁）不算失败。
//
// 状态通道：AiHealth（breaker.ts）把 health / 回退原因 / 回退次数推给会话，会话写进 snapshot.ai。
// 每局开始会话调用 status.reset()：清零计数，并在这里固定"本局桌风"（局中改设置，下一局生效）。
// ============================================================

import { getActingPlayerId, getLegalActions } from '../engine/validator'
import type { Policy } from './policy'
import type { AiStatusSource } from './aiStatus'
import { AiHealth } from './breaker'
import { decisionTier } from './decisionTier'
import { heuristicAction } from './heuristic'
import { classifyLLMError, isLLMConfigured, loadLLMConfig, recordLLMEvent, type LLMConfig, type TableStyle } from './llmClient'
import { decideWithLLM } from './llmPolicy'

export interface AiPolicyOptions {
  getConfig: () => LLMConfig
  /** 熔断监视；省略 = 不统计、不熔断（失败照样回退启发式） */
  health?: AiHealth
  /** 本局桌风；省略 = 每次读配置 */
  getStyle?: () => TableStyle
}

/** 这次决策是否会请求 LLM（决策分级 + 配置）。统计调用次数 / 测试用 */
export function wantsLLM(config: LLMConfig, tier: 'trivial' | 'critical', legalCount: number): boolean {
  if (legalCount <= 1 || !isLLMConfigured(config)) return false
  return config.decisionScope === 'all' || tier === 'critical'
}

export function createAiPolicy(opts: AiPolicyOptions): Policy {
  return {
    name: 'ai',
    async decide(state, signal) {
      const actingId = getActingPlayerId(state)
      const legal = getLegalActions(state, actingId)
      if (legal.length === 0) return null

      const config = opts.getConfig()
      const style = opts.getStyle?.() ?? config.tableStyle
      const h = heuristicAction(state, { style }) ?? legal[0]
      if (!wantsLLM(config, decisionTier(state, actingId, legal, h), legal.length)) return h

      const gate = opts.health?.gate() ?? 'call'
      if (gate === 'skip') return h

      try {
        const action = await decideWithLLM(state, actingId, legal, config, signal, { style })
        if (signal.aborted) return null
        if (action) { opts.health?.succeeded(); return action }
        opts.health?.failed('invalid', '模型的回复不是有效的选项')
      } catch (e) {
        const kind = classifyLLMError(e, signal)
        if (kind === 'aborted') return null
        opts.health?.failed(kind, kind === 'timeout' ? `超过 ${config.timeoutSecs} 秒没有回复` : shortMessage(e))
      }
      return h
    },
  }
}

function shortMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  return m.replace(/\s+/g, ' ').slice(0, 60)
}

// ---------- 装配：策略 + 状态源 ----------

export interface AiRuntime {
  policy: Policy
  /** 交给 GameSession / SessionEnv.aiStatus */
  status: AiStatusSource
  health: AiHealth
}

export function createAiRuntime(getConfig: () => LLMConfig = loadLLMConfig): AiRuntime {
  const health = new AiHealth({
    isEnabled: () => isLLMConfigured(getConfig()),
    onLog: (tag, text) => recordLLMEvent(tag, text, getConfig().model),
  })
  let sessionStyle: TableStyle | null = null
  const status: AiStatusSource = {
    get: () => health.get(),
    subscribe: l => health.subscribe(l),
    reset: () => { sessionStyle = getConfig().tableStyle; health.reset() },
  }
  const policy = createAiPolicy({ getConfig, health, getStyle: () => sessionStyle ?? getConfig().tableStyle })
  return { policy, status, health }
}
