// ============================================================
// GameSession — 一局游戏的运行时（框架无关，浏览器与 Node 共用）
//
// 职责：持有状态、接收动作、在轮到电脑玩家时驱动 Policy 决策并把结果喂回 reducer。
// 进度保证不靠计时器看门狗，而靠结构：
//   · Policy 返回的动作必须合法，否则改用兜底策略（启发式，纯函数、必有合法动作）
//   · reducer 只接受合法动作，接受即 stateVersion+1，因此每次决策周期状态必然推进
//   · 决策期间状态一旦变化（人类操作 / 载入存档），旧决策通过 AbortSignal 作废
// ============================================================

import type { GameState, PlayerAction } from '../engine/types'
import { gameReducer } from '../engine/gameEngine'
import { getActingPlayerId, getLegalActions, isLegal } from '../engine/validator'
import { hasStop } from '../engine/rules'
import type { Policy } from '../ai/policy'
import { heuristicPolicy } from '../ai/heuristic'
import { IDLE_AI_STATUS, type AiRuntimeStatus, type AiStatusSource } from '../ai/aiStatus'
import type { ActionLogEntry, ActionSource, SavedGame, StartParams } from './replay'

/**
 * 电脑（或自动放行）行动前的停顿毫秒数。参数里带上合法动作，便于对"无信息量"的动作（只有一个合法选项等）跳过停顿。
 * 注意信息隐藏：反应窗口的停顿不能取决于"谁持有阻止牌"。
 */
export type DelayFor = (state: GameState, actorId: number, legalActions: readonly PlayerAction[]) => number

export interface SessionOptions {
  /** 电脑玩家的决策策略 */
  policy: Policy
  /** 兜底策略：policy 失败时使用（默认启发式） */
  fallback?: Policy
  /** 电脑行动前的停顿（营造节奏；省略 = 不停顿）。优先于 delay */
  delayFor?: DelayFor
  /** @deprecated 旧写法，只看状态；新代码用 delayFor */
  delay?: (state: GameState) => number
  /**
   * 恢复 / 续局：提供开局参数与已有动作日志，会话继续在其后追加，保持"开局参数 + 日志 = 当前状态"可重放。
   * 与初始状态不衔接（版本号对不上）则按不可回放处理，不抛错。
   * 省略 = 不可回放的会话（日志仍从此刻起记录，供 UI 按动作分组事件）
   */
  replay?: { origin: StartParams; log: readonly ActionLogEntry[] }
  /** 人类只能放行的窗口（反应窗口无阻止牌 / 成交倒计时无干扰牌）：停顿同样时长后自动放行（默认开） */
  autoPassHuman?: boolean
  /** 电脑玩家运行状况的来源（LLM 熔断监视）；省略 = 一直是 IDLE_AI_STATUS。会话构造时调用 reset()，之后订阅变化写入 snapshot.ai */
  aiStatus?: AiStatusSource
  onChange?: (state: GameState) => void
  /** 每个被引擎接受的动作（人类 / 电脑 / 自动放行）提交后调用，晚于 onChange 之前的状态更新 */
  onAction?: (entry: ActionLogEntry, state: GameState) => void
  /** destroy() 时调用（存档层在这里做最后一次落盘） */
  onDestroy?: () => void
  onError?: (message: string) => void
}

/**
 * 电脑玩家运行状况（界面据此显示 LLM 是否在线、是否已降级为启发式）。
 * 类型与状态源定义在 ai/aiStatus.ts（由 ai/breaker.ts 的熔断监视产生），这里再导出，界面照旧从 session 引用。
 */
export type { AiRuntimeStatus, AiStatusSource }
export { IDLE_AI_STATUS }

export interface SessionSnapshot {
  state: GameState
  /** 正在思考的电脑玩家 id（用于 UI 提示） */
  thinkingId: number | null
  /** 电脑玩家运行状况 */
  ai: AiRuntimeStatus
  /** 最近一次被接受的动作（载入 / 替换状态后为 null）；订阅者据此拿到最新日志条目 */
  lastEntry: ActionLogEntry | null
  /** 日志条数：每条动作 +1，可用于判断日志是否增长 */
  logLength: number
}

type Listener = () => void

/** 可提前结束的停顿：到点 / 被 skip / 被 abort 都会 resolve */
interface Pause { promise: Promise<void>; skip(): void }

function makePause(ms: number, signal: AbortSignal): Pause {
  let skip = () => {}
  const promise = new Promise<void>(resolve => {
    if (ms <= 0 || signal.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    skip = () => { clearTimeout(t); resolve() }
    signal.addEventListener('abort', skip, { once: true })
  })
  return { promise, skip: () => skip() }
}

export class GameSession {
  private snap: SessionSnapshot
  private listeners = new Set<Listener>()
  private controller: AbortController | null = null
  private destroyed = false
  private readonly fallback: Policy
  /** 当前这次电脑行动前的节奏停顿（skipWait 用） */
  private pause: Pause | null = null
  private unsubscribeAi: (() => void) | null = null
  /** 只增不改的动作日志（实例内唯一数组；对外只读） */
  private entries: ActionLogEntry[] = []
  private originParams: StartParams | null = null

  constructor(initial: GameState, private readonly opts: SessionOptions) {
    this.adopt(opts.replay)
    this.checkContinuity(initial)
    this.snap = { state: initial, thinkingId: null, ai: IDLE_AI_STATUS, lastEntry: null, logLength: this.entries.length }
    this.fallback = opts.fallback ?? heuristicPolicy
    this.attachAiStatus()
    this.schedule()
  }

  get snapshot(): SessionSnapshot { return this.snap }
  get state(): GameState { return this.snap.state }
  get isDestroyed(): boolean { return this.destroyed }
  /** 动作日志（只读；数组引用恒定，随动作增长） */
  get log(): readonly ActionLogEntry[] { return this.entries }
  /** 开局参数；null = 不可回放的会话（旧存档 / 自定义局面） */
  get origin(): StartParams | null { return this.originParams }
  /** 开局参数 + 日志能否完整重放到当前状态 */
  get replayable(): boolean { return this.originParams !== null }
  /** 导出可持久化的完整内容 */
  toSaved(): SavedGame {
    return { state: this.snap.state, origin: this.originParams, log: this.originParams ? [...this.entries] : [], replayable: this.replayable }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 人类或电脑的动作都从这里进入；返回是否被 reducer 接受 */
  dispatch(action: PlayerAction, source?: ActionSource): boolean {
    if (this.destroyed) return false
    const prev = this.snap.state
    return this.accept(action, source ?? (prev.players[action.playerId]?.isAI ? 'ai' : 'human'))
  }

  /** 载入另一份状态（存档）。可附带该状态对应的开局参数与日志；省略则这份状态不可回放，日志从头重记 */
  replace(state: GameState, replay?: { origin: StartParams; log: readonly ActionLogEntry[] }) {
    if (this.destroyed) return
    this.entries = []
    this.originParams = null
    this.adopt(replay)
    this.checkContinuity(state)
    this.commit(state, null)
  }

  /**
   * 跳过当前电脑 / 自动放行行动前的节奏停顿（"快进"）：立即结束这一次停顿；
   * 决策本身（含 LLM 请求）仍须完成，之后的行动照常停顿。没有正在进行的停顿时无效果。
   */
  skipWait() {
    this.pause?.skip()
  }

  /** 等待直到谓词成立或游戏结束（仿真 / 测试用） */
  runUntil(predicate: (state: GameState) => boolean = s => s.phase === 'GAME_OVER'): Promise<GameState> {
    return new Promise(resolve => {
      const check = () => {
        const s = this.snap.state
        if (predicate(s) || s.phase === 'GAME_OVER' || this.destroyed) { unsubscribe(); resolve(s) }
      }
      const unsubscribe = this.subscribe(check)
      check()
    })
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.controller?.abort()
    this.controller = null
    this.pause = null
    this.unsubscribeAi?.()
    this.unsubscribeAi = null
    this.listeners.clear()
    this.opts.onDestroy?.()
  }

  // ---------- 内部 ----------

  private adopt(replay: SessionOptions['replay']) {
    if (!replay) return
    this.originParams = replay.origin
    this.entries = [...replay.log]
  }

  /** 日志必须正好接到初始状态上：空日志 ⇒ stateVersion 1；否则最后一条 versionBefore + 1。对不上就放弃回放资格 */
  private checkContinuity(state: GameState) {
    if (!this.originParams) return
    const last = this.entries[this.entries.length - 1]
    const expected = last ? last.versionBefore + 1 : 1
    if (state.stateVersion !== expected) {
      this.originParams = null
      this.entries = []
    }
  }

  private accept(action: PlayerAction, source: ActionSource): boolean {
    const prev = this.snap.state
    const next = gameReducer(prev, action)
    if (!next || next === prev) return false
    const entry: ActionLogEntry = {
      index: this.entries.length,
      action: structuredClone(action),
      versionBefore: prev.stateVersion,
      eventFrom: prev.nextId,
      eventTo: next.nextId - 1,
      source,
    }
    this.entries.push(entry)
    this.commit(next, entry)
    return true
  }

  private commit(state: GameState, entry: ActionLogEntry | null) {
    this.snap = { state, thinkingId: null, ai: this.snap?.ai ?? IDLE_AI_STATUS, lastEntry: entry, logLength: this.entries.length }
    this.opts.onChange?.(state)
    if (entry) this.opts.onAction?.(entry, state)
    this.notify()
    this.schedule()
  }

  private setThinking(id: number | null) {
    if (this.snap.thinkingId === id) return
    this.snap = { ...this.snap, thinkingId: id }
    this.notify()
  }

  private notify() {
    for (const l of this.listeners) l()
  }

  /** 每次状态变化后决定接下来由谁推进 */
  private schedule() {
    this.controller?.abort()
    this.controller = null
    this.pause = null
    const state = this.snap.state
    if (state.phase === 'GAME_OVER') return
    const actorId = getActingPlayerId(state)
    const actor = state.players[actorId]
    if (!actor) return

    const controller = new AbortController()
    this.controller = controller

    if (actor.isAI) {
      void this.runAI(state, actorId, controller.signal)
    } else if (this.opts.autoPassHuman ?? true) {
      // 只能放行的窗口不必等人点：反应窗口没有阻止牌 / 成交倒计时没有任何可打的干扰牌。
      // 停顿同样时长，使窗口时长与"谁持有什么牌"无关，不泄露手牌信息
      if (state.phase === 'REACTION' && !hasStop(actor)) void this.autoPass(state, actorId, controller.signal, 'PASS_REACTION')
      else if (state.phase === 'CLOSING' && getLegalActions(state, actorId).every(a => a.type === 'PASS_CLOSING')) void this.autoPass(state, actorId, controller.signal, 'PASS_CLOSING')
    }
  }

  private async autoPass(state: GameState, actorId: number, signal: AbortSignal, type: 'PASS_REACTION' | 'PASS_CLOSING') {
    await this.startPause(this.delayOf(state, actorId), signal)
    if (signal.aborted || this.snap.state !== state) return
    this.accept({ type, playerId: actorId }, 'auto')
  }

  /** 开始一次节奏停顿并登记为"当前停顿"（skipWait 结束的就是它） */
  private startPause(ms: number, signal: AbortSignal): Promise<void> {
    const pause = makePause(ms, signal)
    this.pause = pause
    return pause.promise
  }

  /** 接上状态源：新局清零、订阅变化写入 snapshot.ai */
  private attachAiStatus() {
    const source = this.opts.aiStatus
    if (!source) return
    source.reset?.()
    this.snap = { ...this.snap, ai: source.get() }
    this.unsubscribeAi = source.subscribe(status => {
      if (this.destroyed) return
      this.snap = { ...this.snap, ai: status }
      this.notify()
    })
  }

  private delayOf(state: GameState, actorId: number): number {
    const { delayFor, delay } = this.opts
    if (delayFor) return delayFor(state, actorId, getLegalActions(state, actorId))
    return delay?.(state) ?? 0
  }

  private async runAI(state: GameState, actorId: number, signal: AbortSignal) {
    // 停顿与决策并行：最终等待 max(停顿, 决策)。停顿期间界面显示"思考中"，快进只结束停顿，不打断决策
    const pause = this.startPause(this.delayOf(state, actorId), signal)
    this.setThinking(actorId)

    let action: PlayerAction | null = null
    try {
      action = await this.opts.policy.decide(state, signal)
    } catch (e) {
      if (!signal.aborted) this.opts.onError?.(`策略异常：${e instanceof Error ? e.message : String(e)}`)
    }
    if (signal.aborted || this.snap.state !== state) return

    if (!action || !isLegal(state, action)) {
      if (action) this.opts.onError?.(`策略 ${this.opts.policy.name} 返回非法动作 ${action.type}，改用兜底`)
      action = await this.fallback.decide(state, signal)
      if (signal.aborted || this.snap.state !== state) return
    }
    await pause
    if (signal.aborted || this.snap.state !== state) return
    if (!action) {
      this.opts.onError?.(`玩家 #${actorId} 没有任何合法动作，游戏无法推进`)
      this.setThinking(null)
      return
    }
    if (!this.accept(action, 'ai')) {
      // 合法却被拒绝：违反引擎契约，用兜底再试一次并上报
      this.opts.onError?.(`动作 ${action.type} 通过校验却被引擎拒绝`)
      const backup = await this.fallback.decide(state, signal)
      if (!signal.aborted && backup && !this.accept(backup, 'ai')) this.setThinking(null)
    }
  }
}
