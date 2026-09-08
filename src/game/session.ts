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

export interface SessionOptions {
  /** 电脑玩家的决策策略 */
  policy: Policy
  /** 兜底策略：policy 失败时使用（默认启发式） */
  fallback?: Policy
  /** 电脑行动前的停顿毫秒数（营造节奏；仿真传 0） */
  delay?: (state: GameState) => number
  /** 人类只能放行的窗口（反应窗口无阻止牌 / 成交倒计时无干扰牌）：停顿同样时长后自动放行（默认开） */
  autoPassHuman?: boolean
  onChange?: (state: GameState) => void
  onError?: (message: string) => void
}

export interface SessionSnapshot {
  state: GameState
  /** 正在思考的电脑玩家 id（用于 UI 提示） */
  thinkingId: number | null
}

type Listener = () => void

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  if (ms <= 0) return resolve()
  const t = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
})

export class GameSession {
  private snap: SessionSnapshot
  private listeners = new Set<Listener>()
  private controller: AbortController | null = null
  private destroyed = false
  private readonly fallback: Policy

  constructor(initial: GameState, private readonly opts: SessionOptions) {
    this.snap = { state: initial, thinkingId: null }
    this.fallback = opts.fallback ?? heuristicPolicy
    this.schedule()
  }

  get snapshot(): SessionSnapshot { return this.snap }
  get state(): GameState { return this.snap.state }
  get isDestroyed(): boolean { return this.destroyed }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 人类或电脑的动作都从这里进入；返回是否被 reducer 接受 */
  dispatch(action: PlayerAction): boolean {
    if (this.destroyed) return false
    const next = gameReducer(this.snap.state, action)
    if (!next || next === this.snap.state) return false
    this.commit(next)
    return true
  }

  /** 载入另一份状态（存档） */
  replace(state: GameState) {
    if (this.destroyed) return
    this.commit(state)
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
    this.destroyed = true
    this.controller?.abort()
    this.controller = null
    this.listeners.clear()
  }

  // ---------- 内部 ----------

  private commit(state: GameState) {
    this.snap = { state, thinkingId: null }
    this.opts.onChange?.(state)
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
    await sleep(this.opts.delay?.(state) ?? 0, signal)
    if (signal.aborted || this.snap.state !== state) return
    this.dispatch({ type, playerId: actorId })
  }

  private async runAI(state: GameState, actorId: number, signal: AbortSignal) {
    await sleep(this.opts.delay?.(state) ?? 0, signal)
    if (signal.aborted || this.snap.state !== state) return
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
    if (!action) {
      this.opts.onError?.(`玩家 #${actorId} 没有任何合法动作，游戏无法推进`)
      this.setThinking(null)
      return
    }
    if (!this.dispatch(action)) {
      // 合法却被拒绝：违反引擎契约，用兜底再试一次并上报
      this.opts.onError?.(`动作 ${action.type} 通过校验却被引擎拒绝`)
      const backup = await this.fallback.decide(state, signal)
      if (!signal.aborted && backup && !this.dispatch(backup)) this.setThinking(null)
    }
  }
}
