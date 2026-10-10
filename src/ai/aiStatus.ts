// ============================================================
// 电脑玩家运行状况 —— ai 层与 game/界面之间的"状态通道"
//
// 类型放在 ai 层（game/session.ts 再导出，界面照旧从 session 引用），
// 这样 ai 不必反向依赖 game。会话只认两个动作：reset（新局开始）与 subscribe（有变化就推送），
// 谁来产生状态（熔断器 / 其他策略）是 ai 层自己的事。
// ============================================================

export interface AiRuntimeStatus {
  /** 本局是否启用了 LLM（未配置 = false，全程启发式） */
  llmEnabled: boolean
  /** ok：LLM 正常；degraded：近期有回退；down：熔断中，暂时全用启发式 */
  health: 'ok' | 'degraded' | 'down'
  /** 最近一次回退原因（中文短句） */
  lastFallbackReason: string | null
  /** 本局累计回退次数 */
  fallbackCount: number
}

export const IDLE_AI_STATUS: AiRuntimeStatus = { llmEnabled: false, health: 'ok', lastFallbackReason: null, fallbackCount: 0 }

/** 会话订阅的状态源：get 取当前值，subscribe 订阅变化，reset 在新局 / 载入存档时由会话调用一次 */
export interface AiStatusSource {
  get(): AiRuntimeStatus
  subscribe(listener: (status: AiRuntimeStatus) => void): () => void
  /** 新的一局开始：清零回退计数、重新读取本局固定的配置（桌风等）；熔断状态是否保留由实现决定 */
  reset?(): void
}

export function sameStatus(a: AiRuntimeStatus, b: AiRuntimeStatus): boolean {
  return a.llmEnabled === b.llmEnabled && a.health === b.health && a.lastFallbackReason === b.lastFallbackReason && a.fallbackCount === b.fallbackCount
}
