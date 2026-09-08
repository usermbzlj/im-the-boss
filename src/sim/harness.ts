// ============================================================
// 仿真工具：用真实引擎 / validator / 策略跑完整局，并在每一步检查不变量
// 被 scripts/simulate.ts（命令行）与 vitest 回归测试共用
// ============================================================

import type { GameState, PlayerAction, GameVariantId, LoggedEvent } from '../engine/types'
import { createInitialState, gameReducer } from '../engine/gameEngine'
import { getActingPlayerId, getLegalActions, isLegal } from '../engine/validator'
import { HAND_LIMIT, getVariant, createDeckFor } from '../engine/config'
import { heuristicAction, heuristicPolicy } from '../ai/heuristic'
import type { Policy } from '../ai/policy'
import { GameSession } from '../game/session'
import { narrate } from '../text/narrate'

export type SimMode = 'heuristic' | 'random'

export interface SimOptions {
  playerCount: number
  seed: number
  mode: SimMode
  variantId?: GameVariantId
  maxSteps?: number
  /** 记录每步摘要（失败时打印） */
  trace?: boolean
  /** 每个新事件回调（统计脚本用；状态里只保留最近 MAX_EVENTS 条，这里能拿到全部） */
  onEvent?: (event: LoggedEvent, state: GameState) => void
}

export interface SimResult {
  ok: boolean
  steps: number
  reason?: string
  playerCount: number
  mode: SimMode
  seed: number
  variantId: GameVariantId
  deals: number
  failedDeals: number
  cash: number[]
  trace: string[]
  final: GameState
}

/** 兼容旧引用：经典牌堆张数 */
export const TOTAL_CARDS = 98

/** 该局牌堆总张数（由变体决定：经典 98、完整 105、扩张 117、马拉松 129） */
export function totalCardsOf(s: GameState): number {
  return createDeckFor(getVariant(s.variantId)).length
}

function mulberry(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 状态不变量：任何合法动作之后都必须成立。返回违反描述或 null */
export function checkInvariants(s: GameState): string | null {
  const inHands = s.players.reduce((n, p) => n + p.hand.length, 0)
  const onTable = s.negotiation?.reps.filter(r => r.source === 'CLAN' && !r.travelled).length ?? 0
  const pending = s.pendingReaction?.cards.length ?? 0
  const total = inHands + onTable + pending + s.drawPile.length + s.discardPile.length
  const expected = totalCardsOf(s)
  if (total !== expected) return `卡牌不守恒：${total} ≠ ${expected}（手牌${inHands} 桌面${onTable} 待反应${pending} 牌堆${s.drawPile.length} 弃牌${s.discardPile.length}）`
  const ids = new Set<number>()
  const seen = (id: number) => { if (ids.has(id)) return true; ids.add(id); return false }
  for (const p of s.players) for (const c of p.hand) if (seen(c.id)) return `重复卡牌 id ${c.id}`
  for (const c of s.drawPile) if (seen(c.id)) return `重复卡牌 id ${c.id}`
  for (const c of s.discardPile) if (seen(c.id)) return `重复卡牌 id ${c.id}`
  for (const r of s.negotiation?.reps ?? []) if (r.source === 'CLAN' && !r.travelled && seen(r.cardId!)) return `重复卡牌 id ${r.cardId}`
  for (const c of s.pendingReaction?.cards ?? []) if (seen(c.id)) return `重复卡牌 id ${c.id}`
  // 终局后允许标记停在已关闭格（"完整 16 笔"变体会把 16 格全部关闭）
  if (s.phase !== 'GAME_OVER' && s.board.find(b => b.id === s.markerPos)?.closedByTileId != null) return `金钱标记落在已关闭格 #${s.markerPos}`
  const cash = s.players.reduce((n, p) => n + p.cash, 0)
  const paidOut = s.dealHistory.filter(d => d.success).reduce((n, d) => n + d.grossValue + d.rents.reduce((m, r) => m + r.amount, 0), 0)
  if (cash !== paidOut) return `现金不守恒：玩家总现金 ${cash} ≠ 成交总额 + 地标租金 ${paidOut}`
  if (s.players.some(p => p.cash < 0)) return '出现负现金'
  for (const b of s.board) {
    if (b.kind !== 'LANDMARK' && b.landlordId != null) return `非地标格 #${b.id} 却有主人`
    if (b.kind === 'LANDMARK' && b.closedByTileId != null && b.landlordId == null) return `地标 #${b.id} 已成交却无主`
    if (b.landlordId != null && b.closedByTileId == null) return `地标 #${b.id} 未成交却有主`
  }
  for (const p of s.players) {
    if (p.reclaim && s.investors.some(i => i.ownerId === p.id)) return `${p.name} 已有投资者却仍持有夺回权`
  }
  if (s.negotiation && s.negotiation.priceDelta !== 0 && !getVariant(s.variantId).rareCards) return '经典变体出现股价变动'
  if (s.phase !== 'HAND_LIMIT' && s.phase !== 'REACTION' && s.players.some(p => p.hand.length > HAND_LIMIT)) {
    return `手牌超限：${s.players.map(p => p.hand.length).join(',')} phase=${s.phase}`
  }
  const closed = s.board.filter(b => b.closedByTileId != null).length
  if (closed !== s.completedDeals) return `已关闭格数 ${closed} ≠ 成交数 ${s.completedDeals}`
  if (s.dealTileIndex !== s.completedDeals) return `景气牌下标 ${s.dealTileIndex} ≠ 成交数 ${s.completedDeals}`
  for (const inv of s.investors) {
    if (inv.ownerId != null && !s.players[inv.ownerId]) return `投资者 ${inv.familyId} 的持有者 #${inv.ownerId} 不存在`
  }
  if (s.phase === 'GAME_OVER' && s.winnerIds.length === 0) return '游戏结束但没有胜者'
  return null
}

function allAI(state: GameState): GameState {
  for (const p of state.players) p.isAI = true
  return state
}

function summarize(state: GameState, steps: number, legal: PlayerAction[]): string {
  const neg = state.negotiation
  return `#${steps} ${state.phase} acting=${getActingPlayerId(state)} boss=${neg?.bossId ?? '-'} offers=${neg?.offersMade ?? '-'} pass=${neg?.passStreak ?? '-'} legal=[${legal.map(a => a.type).join(',')}]`
}

function finish(opts: SimOptions, state: GameState, steps: number, trace: string[], reason?: string): SimResult {
  return {
    ok: !reason, steps, reason, playerCount: opts.playerCount, mode: opts.mode, seed: opts.seed, variantId: state.variantId,
    deals: state.completedDeals, failedDeals: state.dealHistory.filter(d => !d.success).length,
    cash: state.players.map(p => p.cash), trace, final: state,
  }
}

/** 同步跑一局：直接驱动 reducer（最快，用于大批量回归） */
export function runGame(opts: SimOptions): SimResult {
  const maxSteps = opts.maxSteps ?? 30000
  const rng = mulberry(opts.seed * 7919 + 17)
  let state = allAI(createInitialState(opts.playerCount, '测试玩家', opts.seed, opts.variantId))
  const trace: string[] = []
  let steps = 0

  while (state.phase !== 'GAME_OVER' && steps < maxSteps) {
    steps++
    const actingId = getActingPlayerId(state)
    const legal = getLegalActions(state, actingId)
    if (opts.trace) { trace.push(summarize(state, steps, legal)); if (trace.length > 80) trace.shift() }
    if (legal.length === 0) return finish(opts, state, steps, trace, `第${steps}步 phase=${state.phase} acting=${actingId} 无合法动作`)

    let action: PlayerAction | null = opts.mode === 'heuristic' ? heuristicAction(state) : null
    if (!action) action = legal[Math.floor(rng() * legal.length)]
    if (!isLegal(state, action)) return finish(opts, state, steps, trace, `第${steps}步 动作未通过 isLegal：${JSON.stringify(action)} phase=${state.phase}`)

    const next = gameReducer(state, action)
    if (!next || next.stateVersion === state.stateVersion) return finish(opts, state, steps, trace, `第${steps}步 reducer 拒绝了合法动作：${JSON.stringify(action)} phase=${state.phase}`)
    if (opts.onEvent) {
      const lastId = state.events.length ? state.events[state.events.length - 1].id : 0
      for (const e of next.events) if (e.id > lastId) opts.onEvent(e, next)
    }
    state = next
    const bad = checkInvariants(state)
    if (bad) return finish(opts, state, steps, trace, `第${steps}步 ${bad}（action=${action.type}）`)
  }
  if (state.phase !== 'GAME_OVER') return finish(opts, state, steps, trace, `超过 ${maxSteps} 步未结束 phase=${state.phase}`)
  return finish(opts, state, steps, trace)
}

/** 通过 GameSession 运行时跑一局（验证运行时本身：调度、兜底、终止） */
export async function runGameViaSession(opts: { playerCount: number; seed: number; policy?: Policy; maxSteps?: number; variantId?: GameVariantId }): Promise<SimResult> {
  const maxSteps = opts.maxSteps ?? 30000
  const initial = allAI(createInitialState(opts.playerCount, '测试玩家', opts.seed, opts.variantId))
  const errors: string[] = []
  let steps = 0
  let violation: string | null = null
  const session = new GameSession(initial, {
    policy: opts.policy ?? heuristicPolicy,
    delay: () => 0,
    onError: m => errors.push(m),
    onChange: s => { steps++; violation ??= checkInvariants(s) },
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const final = await Promise.race([
    session.runUntil(s => s.phase === 'GAME_OVER' || steps >= maxSteps || violation != null),
    new Promise<GameState>((_, reject) => { timer = setTimeout(() => reject(new Error('session 超时')), 60_000) }),
  ]).finally(() => { clearTimeout(timer); session.destroy() })
  const simOpts: SimOptions = { playerCount: opts.playerCount, seed: opts.seed, mode: 'heuristic', variantId: opts.variantId }
  const reason = violation ?? (errors.length ? errors[0] : final.phase !== 'GAME_OVER' ? `超过 ${maxSteps} 步未结束` : undefined)
  return finish(simOpts, final, steps, [], reason)
}

/** 把一局的事件流讲成文字（追踪 / 调试用） */
export function narrateGame(state: GameState): string[] {
  return state.events.map(e => narrate(state, e).text)
}
