// ============================================================
// LLM 熔断器与健康监视
//
// 两层：
//   · CircuitBreaker —— 纯状态机（时钟可注入，便于测试）：决定"这次还要不要请求 LLM"
//   · AiHealth       —— 在熔断器之上维护界面要显示的 AiRuntimeStatus（中文原因、累计回退次数），
//                       并把变化推给订阅者（GameSession）
//
// 状态：
//   ok        正常
//   degraded  近期有过失败（偶发）；连续成功 recoverAfterSuccesses 次后回到 ok
//   down      熔断：连续失败 downAfterFailures 次、或连续超时 downAfterTimeouts 次后进入。
//             熔断期间所有决策直接用启发式（不发请求）；经过 cooldownMs 或跳过 skipDecisions 次决策后，
//             放行一次"探测"请求：成功 → degraded，失败 → 重新熔断（冷却时间翻倍，封顶 maxCooldownMs）
// 超时比普通错误更贵（用户白等一整个超时），所以更早熔断。
// ============================================================

import { IDLE_AI_STATUS, sameStatus, type AiRuntimeStatus, type AiStatusSource } from './aiStatus'

export type FailureKind = 'timeout' | 'network' | 'invalid'

export interface BreakerOptions {
  downAfterFailures?: number
  downAfterTimeouts?: number
  cooldownMs?: number
  maxCooldownMs?: number
  skipDecisions?: number
  recoverAfterSuccesses?: number
  now?: () => number
}

export type Gate = 'call' | 'probe' | 'skip'

export class CircuitBreaker {
  health: AiRuntimeStatus['health'] = 'ok'
  private failures = 0
  private timeouts = 0
  private successes = 0
  private openedAt = 0
  private skipped = 0
  private probing = false
  private cooldown: number
  private readonly o: Required<Omit<BreakerOptions, 'now'>>
  private readonly now: () => number

  constructor(opts: BreakerOptions = {}) {
    this.o = {
      downAfterFailures: opts.downAfterFailures ?? 3,
      downAfterTimeouts: opts.downAfterTimeouts ?? 2,
      cooldownMs: opts.cooldownMs ?? 30_000,
      maxCooldownMs: opts.maxCooldownMs ?? 120_000,
      skipDecisions: opts.skipDecisions ?? 8,
      recoverAfterSuccesses: opts.recoverAfterSuccesses ?? 3,
    }
    this.cooldown = this.o.cooldownMs
    this.now = opts.now ?? Date.now
  }

  /** 请求之前问一句：call = 正常请求；probe = 熔断后的探测请求；skip = 不要请求（直接用启发式） */
  gate(): Gate {
    if (this.health !== 'down') return 'call'
    if (this.probing) { this.skipped++; return 'skip' } // 已有一个探测在路上
    if (this.now() - this.openedAt >= this.cooldown || this.skipped >= this.o.skipDecisions) {
      this.probing = true
      return 'probe'
    }
    this.skipped++
    return 'skip'
  }

  success(): void {
    this.failures = 0
    this.timeouts = 0
    if (this.health === 'down') {
      // 探测成功：先降为"降级"，再靠连续成功回到正常
      this.probing = false
      this.cooldown = this.o.cooldownMs
      this.health = 'degraded'
      this.successes = 1
    } else if (this.health === 'degraded') {
      this.successes++
      if (this.successes >= this.o.recoverAfterSuccesses) { this.health = 'ok'; this.successes = 0 }
    }
  }

  /** 返回这次失败是否让熔断器（重新）打开 */
  failure(kind: FailureKind): boolean {
    this.successes = 0
    this.failures++
    this.timeouts = kind === 'timeout' ? this.timeouts + 1 : 0
    if (this.health === 'down') {
      // 探测失败（或探测期间到达的迟到失败）：重新计时，冷却翻倍
      if (this.probing) this.cooldown = Math.min(this.cooldown * 2, this.o.maxCooldownMs)
      this.open()
      return true
    }
    if (this.failures >= this.o.downAfterFailures || this.timeouts >= this.o.downAfterTimeouts) {
      this.open()
      return true
    }
    this.health = 'degraded'
    return false
  }

  /** 新局开始：熔断不清零，但允许第一次决策立即探测（用户可能刚改好了配置）；降级回到正常 */
  rearm(): void {
    if (this.health === 'down') { this.openedAt = this.now() - this.cooldown; this.probing = false }
    else { this.health = 'ok'; this.failures = 0; this.timeouts = 0; this.successes = 0 }
  }

  /** 当前连续失败次数（原因文案用） */
  get consecutiveFailures(): number { return this.failures }

  private open(): void {
    this.health = 'down'
    this.openedAt = this.now()
    this.skipped = 0
    this.probing = false
  }
}

// ---------- 健康监视：熔断器 + 界面状态 ----------

export interface AiHealthOptions extends BreakerOptions {
  /** 当前 LLM 是否已配置可用（读设置；每次状态变化时取一次） */
  isEnabled: () => boolean
  /** 熔断 / 回退 / 恢复写入调用日志（设置面板可见）；省略则不记 */
  onLog?: (tag: 'fallback' | 'breaker' | 'recover', text: string) => void
}

export class AiHealth implements AiStatusSource {
  readonly breaker: CircuitBreaker
  private status: AiRuntimeStatus = IDLE_AI_STATUS
  private listeners = new Set<(s: AiRuntimeStatus) => void>()
  private count = 0
  private lastReason: string | null = null

  constructor(private readonly opts: AiHealthOptions) {
    this.breaker = new CircuitBreaker(opts)
    this.status = this.build()
  }

  get(): AiRuntimeStatus { return this.status }

  subscribe(listener: (s: AiRuntimeStatus) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  reset(): void {
    this.count = 0
    this.lastReason = null
    this.breaker.rearm()
    this.publish()
  }

  /** 请求之前调用。skip 时已经记为一次回退，调用方直接用启发式 */
  gate(): Gate {
    const g = this.breaker.gate()
    if (g === 'skip') this.noteFallback('LLM 暂停调用（连续失败），暂用内置策略，稍后自动重试')
    return g
  }

  succeeded(): void {
    const before = this.breaker.health
    this.breaker.success()
    if (before !== this.breaker.health && this.breaker.health === 'ok') this.opts.onLog?.('recover', 'LLM 已恢复正常')
    this.publish()
  }

  failed(kind: FailureKind, detail: string): void {
    const wasDown = this.breaker.health === 'down'
    const opened = this.breaker.failure(kind)
    const reason = opened
      ? `LLM ${kind === 'timeout' ? '连续超时' : '连续失败'}，已暂停调用，稍后自动重试（${detail}）`
      : kind === 'timeout' ? `LLM 响应超时，本次改用内置策略（${detail}）`
      : kind === 'network' ? `LLM 请求失败，本次改用内置策略（${detail}）`
      : `LLM 回复无法解析，本次改用内置策略（${detail}）`
    this.noteFallback(reason, opened && !wasDown ? 'breaker' : 'fallback')
  }

  private noteFallback(reason: string, tag: 'fallback' | 'breaker' = 'fallback'): void {
    this.count++
    this.lastReason = reason
    // 熔断期间每次跳过都会走到这里，不往日志里刷屏
    if (tag === 'breaker' || !reason.startsWith('LLM 暂停')) this.opts.onLog?.(tag, reason)
    this.publish()
  }

  private build(): AiRuntimeStatus {
    return { llmEnabled: this.opts.isEnabled(), health: this.breaker.health, lastFallbackReason: this.lastReason, fallbackCount: this.count }
  }

  private publish(): void {
    const next = this.build()
    if (sameStatus(next, this.status)) return
    this.status = next
    for (const l of this.listeners) l(next)
  }
}
