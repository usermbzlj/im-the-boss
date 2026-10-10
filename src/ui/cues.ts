// ============================================================
// 演出调度（纯逻辑）：新增事件 → 要播放的演出（Cue）列表
//
//   cuesFor        一批新事件 → 原始演出（类型 / 目标 / 时长 / 音效）
//   mergeCues      同批内同 key 的演出合并（同座位的金额累加、抽牌张数累加…）
//   staggerCues    关键镜头错开播放，常规动画 ≤ 0.8 秒、整批不叠成一团
//   planCues       = cuesFor → mergeCues → staggerCues
//   motionFilter   快进 / 页面后台 / 减少动画 / 无动画环境 → 跳过视觉演出
//   pickSounds     一批演出 → 要播的音效（按优先级挑至多两个，快进时只保留重要的）
//   mergeActive    把新演出并入正在播放的列表：短时间内的同类更新合并而不是叠加
//
// 只依赖"已落地的事件"：不会产生"谁在考虑 / 谁被询问"的演出，他人抽牌只给张数（architecture §7.1）。
// 演出只是覆盖层——不改变游戏推进，也不阻塞任何操作。
// ============================================================

import type { FamilyId, GameState, LoggedEvent, ReactionKind } from '../engine/types'
import type { SfxId } from '../audio/sfx'
import { SFX_PRIORITY } from '../audio/sfx'
import { famName, playerName, reactionKindName } from '../text/narrate'
import { motionBlocked, type MotionEnv } from './motion'

export type CueKind =
  | 'money'   // 金额飘字
  | 'play'    // 出牌小提示（座位闪一下 + 牌种图标）
  | 'boss'    // 老板牌夺权：Boss 徽标飞向新 Boss
  | 'travel'  // 旅行牌：代表被送走
  | 'recruit' // 招募：代表换主
  | 'stop'    // 阻止牌：被取消的牌划掉 / 碎裂
  | 'price'   // 利好 / 利空：股价变动
  | 'close'   // 成交：版图格关闭 + 克制的光效
  | 'fail'    // 流局
  | 'dice'    // 掷骰
  | 'marker'  // 金钱标记沿版图移动
  | 'draw'    // 抽牌
  | 'win'     // 终局胜者庆祝

/** 演出目标：座位 / 版图格 / 家族代表（某座位或公共区的某个家族标识）/ 手牌 / 中央景气牌 */
export type CueTarget =
  | { type: 'seat'; playerId: number }
  | { type: 'cell'; spaceId: number }
  | { type: 'rep'; playerId: number | null; familyId: FamilyId }
  | { type: 'hand' }
  | { type: 'pile' }

export type CueTone = 'good' | 'bad' | 'neutral'

export interface Cue {
  /** 合并键：同批内同 key 合并；短时间内重复更新同 key 的活动演出也合并 */
  key: string
  kind: CueKind
  target: CueTarget
  from?: CueTarget
  familyId?: FamilyId
  icon?: string
  /** 飘字 / 简短文字（金额、"+3 张"、"▲ +$2M/份"） */
  text?: string
  /** 关键镜头的一行说明 */
  caption?: string
  /** money：带符号金额；draw：张数 */
  amount?: number
  /** dice：点数 */
  die?: number
  tone: CueTone
  /** 与视角玩家有关（飘字放大） */
  mine: boolean
  /** 持续时间（毫秒，不含 delay） */
  ms: number
  /** 开始前的等待（毫秒） */
  delay: number
  /** 关键镜头：错开播放、优先保留 */
  drama: boolean
  sfx?: SfxId
  /** 合并了多少条 */
  count: number
}

/** 各类演出的时长（毫秒）。关键牌镜头 ≤ 0.8 秒（BGA 规范：常规 ~0.5 秒、最长 0.8 秒） */
export const CUE_MS: Record<CueKind, number> = {
  money: 1100, play: 600, boss: 800, travel: 800, recruit: 800, stop: 800, price: 800,
  close: 900, fail: 800, dice: 800, marker: 700, draw: 700, win: 4200,
}
/** 关键镜头的时长上限 */
export const SHOT_MAX_MS = 800
/** 同一批里相邻关键镜头的错开间隔 / 最大错开 */
export const STAGGER_STEP_MS = 450
export const STAGGER_MAX_MS = 900
/** 活动演出的合并窗口：同 key 的常规演出在这段时间内再来一次，就合并成一个 */
export const MERGE_WINDOW_MS = 500
/** 同时在播的演出上限 */
export const MAX_ACTIVE_CUES = 10

export const CARD_ICON: Record<ReactionKind | 'CLAN' | 'STOP', string> = {
  CLAN: '👤', TRAVEL: '✈️', RECRUITMENT: '📋', BOSS: '👑', STOP: '🛑', BOOM: '📈', BUST: '📉', EXCLUSIVE: '🔒', SICK: '🤒',
}

export function moneyLabel(amount: number): string {
  return `${amount >= 0 ? '+' : '−'}$${Math.abs(amount)}M`
}

export function drawLabel(count: number): string {
  return `+${count} 张`
}

export interface CueContext {
  /** 本批事件发生之前金钱标记所在的格（用于画标记移动的起点） */
  prevMarkerPos?: number | null
}

const seat = (playerId: number): CueTarget => ({ type: 'seat', playerId })

function base(partial: Pick<Cue, 'key' | 'kind' | 'target'> & Partial<Cue>): Cue {
  return { tone: 'neutral', mine: false, ms: CUE_MS[partial.kind], delay: 0, drama: false, count: 1, ...partial }
}

function moneyCue(playerId: number, amount: number, viewerId: number, delay = 0): Cue | null {
  if (!amount) return null
  return base({
    key: `money:${playerId}`, kind: 'money', target: seat(playerId), amount, text: moneyLabel(amount),
    tone: amount > 0 ? 'good' : 'bad', mine: playerId === viewerId, delay, sfx: amount > 0 ? 'coin' : 'pay',
  })
}

/** 一批新事件（时间正序）→ 原始演出。state 是这批事件之后的局面（用于取名字）。 */
export function cuesFor(state: GameState, events: readonly LoggedEvent[], viewerId: number, ctx: CueContext = {}): Cue[] {
  const out: Cue[] = []
  const push = (c: Cue | null) => { if (c) out.push(c) }
  const n = (id: number | null | undefined) => (id === viewerId ? '你' : playerName(state, id))
  let markerPos = ctx.prevMarkerPos ?? null

  for (const e of events) {
    switch (e.kind) {
      case 'CLAN_PLAYED':
        push(base({ key: `play:${e.playerId}`, kind: 'play', target: seat(e.playerId), icon: CARD_ICON.CLAN, familyId: e.familyId, sfx: 'play' }))
        break
      case 'TRAVEL_PLAYED':
      case 'RECRUITMENT_PLAYED':
      case 'BOSS_PLAYED':
      case 'BOOM_PLAYED':
      case 'BUST_PLAYED':
      case 'EXCLUSIVE_PLAYED':
      case 'SICK_PLAYED': {
        const type = e.kind.replace('_PLAYED', '') as ReactionKind
        push(base({ key: `play:${e.playerId}`, kind: 'play', target: seat(e.playerId), icon: CARD_ICON[type], sfx: 'play' }))
        break
      }

      case 'BOSS_RESOLVED':
        push(base({
          key: `boss:${e.id}`, kind: 'boss', target: seat(e.playerId), from: seat(e.previousBossId), icon: '👑', drama: true, sfx: 'boss',
          caption: `${n(e.playerId)}夺走了 ${n(e.previousBossId)} 的 Boss！`, mine: e.playerId === viewerId || e.previousBossId === viewerId,
          tone: e.playerId === viewerId ? 'good' : e.previousBossId === viewerId ? 'bad' : 'neutral',
        }))
        break
      case 'TRAVEL_RESOLVED':
        push(base({
          key: `travel:${e.id}`, kind: 'travel', target: { type: 'rep', playerId: e.target.ownerId, familyId: e.target.familyId },
          familyId: e.target.familyId, icon: '✈️', drama: true, sfx: 'swoosh', mine: e.target.ownerId === viewerId,
          tone: e.target.ownerId === viewerId ? 'bad' : 'neutral', caption: `${famName(e.target.familyId)}代表被送去出差`,
        }))
        break
      case 'RECRUITMENT_RESOLVED':
        push(base({
          key: `recruit:${e.id}`, kind: 'recruit', familyId: e.familyId, icon: '📋', drama: true, sfx: 'swoosh',
          from: e.fromId == null ? { type: 'rep', playerId: null, familyId: e.familyId } : { type: 'rep', playerId: e.fromId, familyId: e.familyId },
          target: { type: 'rep', playerId: e.playerId, familyId: e.familyId },
          mine: e.playerId === viewerId || e.fromId === viewerId,
          tone: e.playerId === viewerId ? 'good' : e.fromId === viewerId ? 'bad' : 'neutral',
          caption: `${n(e.playerId)}招募了 ${famName(e.familyId)}`,
        }))
        break
      case 'STOP_PLAYED':
        push(base({
          key: `stop:${e.id}`, kind: 'stop', target: seat(e.actorId), from: seat(e.playerId), icon: CARD_ICON[e.cancelled], drama: true, sfx: 'stop',
          caption: `${n(e.actorId)}的${reactionKindName(e.cancelled)}被阻止`, mine: e.actorId === viewerId || e.playerId === viewerId,
          tone: e.actorId === viewerId ? 'bad' : e.playerId === viewerId ? 'good' : 'neutral',
        }))
        break
      case 'PRICE_CHANGED':
        if (e.delta !== 0) {
          push(base({
            key: `price:${e.id}`, kind: 'price', target: { type: 'pile' }, drama: true, sfx: e.delta > 0 ? 'up' : 'down',
            text: `${e.delta > 0 ? '▲' : '▼'} ${e.delta > 0 ? '+' : '−'}$${Math.abs(e.delta)}M/份`, tone: e.delta > 0 ? 'good' : 'bad', amount: e.delta,
          }))
        }
        break

      case 'DEAL_CLOSED': {
        push(base({
          key: `close:${e.id}`, kind: 'close', target: { type: 'cell', spaceId: e.spaceId }, drama: true, sfx: 'deal',
          text: `第 ${e.dealNumber} 笔`, caption: `成交！$${e.gross}M`, tone: 'good', mine: e.bossId === viewerId || e.payouts.some(p => p.playerId === viewerId && p.amount > 0),
        }))
        const gains = new Map<number, number>()
        gains.set(e.bossId, e.bossKeep)
        for (const p of e.payouts) gains.set(p.playerId, (gains.get(p.playerId) ?? 0) + p.amount)
        for (const [pid, amount] of gains) push(moneyCue(pid, amount, viewerId, 250))
        break
      }
      case 'RENT_PAID':
        for (const p of e.payments) push(moneyCue(p.playerId, p.amount, viewerId, 600))
        break
      case 'DEAL_FAILED':
        push(base({
          key: `fail:${e.id}`, kind: 'fail', target: { type: 'cell', spaceId: e.spaceId }, tone: 'bad', sfx: 'fail',
          text: '流局', mine: e.bossId === viewerId,
        }))
        break

      case 'CARDS_BOUGHT':
        push(moneyCue(e.playerId, -e.cost, viewerId))
        push(drawCue(e.playerId, e.count, viewerId))
        break
      case 'CARDS_TRADED':
        push(moneyCue(e.playerId, -e.cost, viewerId))
        break
      case 'CARDS_DRAWN':
        push(drawCue(e.playerId, e.count, viewerId))
        break

      case 'MARKER_MOVED':
        push(base({ key: `dice:${e.id}`, kind: 'dice', target: { type: 'pile' }, die: e.die, sfx: 'dice', tone: 'neutral' }))
        if (markerPos != null && markerPos !== e.spaceId) {
          push(base({ key: `marker:${e.id}`, kind: 'marker', target: { type: 'cell', spaceId: e.spaceId }, from: { type: 'cell', spaceId: markerPos }, icon: '💰', delay: 380 }))
        }
        markerPos = e.spaceId
        break
      case 'MARKER_PLACED':
        push(base({ key: `marker:${e.id}`, kind: 'marker', target: { type: 'cell', spaceId: e.spaceId }, icon: '💰' }))
        markerPos = e.spaceId
        break
      case 'END_ROLL':
        push(base({ key: `dice:${e.id}`, kind: 'dice', target: { type: 'pile' }, die: e.die, sfx: 'dice', tone: e.hit ? 'bad' : 'neutral' }))
        break

      case 'GAME_OVER': {
        const won = e.winnerIds.includes(viewerId)
        push(base({
          key: `win:${e.id}`, kind: 'win', target: { type: 'pile' }, drama: true, sfx: won ? 'win' : 'end', tone: won ? 'good' : 'neutral', mine: won,
          caption: e.winnerIds.map(n).join('、'),
        }))
        break
      }
      default:
        break
    }
  }
  return out
}

function drawCue(playerId: number, count: number, viewerId: number): Cue | null {
  if (count <= 0) return null
  // 信息隐藏：他人抽牌只给张数（飘在座位上）；自己抽牌才有"飞入手牌"
  if (playerId === viewerId) {
    return base({ key: 'draw:hand', kind: 'draw', target: { type: 'hand' }, from: { type: 'pile' }, amount: count, text: drawLabel(count), mine: true, sfx: 'draw' })
  }
  return base({ key: `draw:${playerId}`, kind: 'draw', target: seat(playerId), amount: count, text: drawLabel(count) })
}

function retext(c: Cue): Cue {
  if (c.kind === 'money' && c.amount != null) return { ...c, text: moneyLabel(c.amount), tone: c.amount > 0 ? 'good' : 'bad', sfx: c.amount > 0 ? 'coin' : 'pay' }
  if (c.kind === 'draw' && c.amount != null) return { ...c, text: drawLabel(c.amount) }
  return c
}

/** 把 incoming 合并进 target（同 key）：金额 / 张数累加，其余取较新的 */
function combine(target: Cue, incoming: Cue): Cue {
  const sum = (target.kind === 'money' || target.kind === 'draw') ? (target.amount ?? 0) + (incoming.amount ?? 0) : incoming.amount
  return retext({ ...target, ...incoming, amount: sum, count: target.count + incoming.count, delay: Math.min(target.delay, incoming.delay) })
}

/** 同批内同 key 合并；金额合计为 0 的飘字丢弃 */
export function mergeCues(cues: readonly Cue[]): Cue[] {
  const order: string[] = []
  const byKey = new Map<string, Cue>()
  for (const c of cues) {
    const cur = byKey.get(c.key)
    if (cur) byKey.set(c.key, combine(cur, c))
    else { byKey.set(c.key, c); order.push(c.key) }
  }
  return order.map(k => byKey.get(k)!).filter(c => !(c.kind === 'money' && !c.amount))
}

/** 关键镜头依次错开（第 i 个晚 i×450ms，最多 900ms）；其余演出保持各自的 delay */
export function staggerCues(cues: readonly Cue[]): Cue[] {
  let shot = 0
  return cues.map(c => {
    if (!c.drama) return c
    const extra = Math.min(shot * STAGGER_STEP_MS, STAGGER_MAX_MS)
    shot++
    return extra ? { ...c, delay: c.delay + extra } : c
  })
}

export function planCues(state: GameState, events: readonly LoggedEvent[], viewerId: number, ctx: CueContext = {}): Cue[] {
  return staggerCues(mergeCues(cuesFor(state, events, viewerId, ctx)))
}

/** 视觉演出的跳过策略：快进 / 后台 / 减少动画 / 无动画环境 → 全部跳过 */
export function motionFilter(cues: readonly Cue[], env: MotionEnv): Cue[] {
  return motionBlocked(env) ? [] : [...cues]
}

export interface SoundPlan { id: SfxId; delayMs: number }

/** 快进时仍然保留的重要音效（成交 / 流局 / 终局） */
const FAST_FORWARD_KEEP: ReadonlySet<SfxId> = new Set<SfxId>(['deal', 'fail', 'win', 'end'])

/**
 * 一批演出 → 要播的音效。规则：
 *   · 页面在后台不播；快进时只保留成交 / 流局 / 终局
 *   · 同一批按优先级挑至多两个不同的音效（成交压过入账、终局压过一切）
 *   · 第二个音效晚 170ms，不糊成一团
 */
export function pickSounds(cues: readonly Cue[], env: Pick<MotionEnv, 'hidden' | 'fastForward'>): SoundPlan[] {
  if (env.hidden) return []
  let ids = [...new Set(cues.flatMap(c => (c.sfx ? [c.sfx] : [])))]
  if (env.fastForward) ids = ids.filter(id => FAST_FORWARD_KEEP.has(id))
  if (ids.includes('win') || ids.includes('end')) ids = ids.filter(id => id === 'win' || id === 'end')
  if (ids.includes('deal')) ids = ids.filter(id => id !== 'coin' && id !== 'play' && id !== 'draw')
  ids.sort((a, b) => SFX_PRIORITY[b] - SFX_PRIORITY[a])
  return ids.slice(0, 2).map((id, i) => ({ id, delayMs: i * 170 }))
}

/** 正在播放的演出 */
export interface ActiveCue extends Cue {
  id: number
  startedAt: number
  /** 每次合并 +1：界面据此重新挂载、重播动画并重置到期计时 */
  version: number
}

/**
 * 并入正在播放的列表：
 *   · 常规演出：同 key 且还在合并窗口内 → 合并（金额累加、版本 +1、重新计时）
 *   · 关键镜头：同 key 的重复直接丢弃
 *   · 超出上限时先挤掉最早的非关键演出
 */
export function mergeActive(active: readonly ActiveCue[], incoming: readonly Cue[], now: number, nextId: () => number, max = MAX_ACTIVE_CUES): ActiveCue[] {
  let list = [...active]
  for (const c of incoming) {
    const i = list.findIndex(a => a.key === c.key && (c.drama || now - a.startedAt < MERGE_WINDOW_MS + a.delay))
    if (i >= 0) {
      if (c.drama) continue
      const merged = combine(list[i], c)
      list[i] = { ...list[i], ...merged, startedAt: now, version: list[i].version + 1, id: list[i].id }
      continue
    }
    list.push({ ...c, id: nextId(), startedAt: now, version: 0 })
  }
  while (list.length > max) {
    const idx = list.findIndex(a => !a.drama)
    list = list.filter((_, k) => k !== (idx >= 0 ? idx : 0))
  }
  return list
}

/** 一条活动演出到期的时刻（相对 startedAt，毫秒），留一点余量让淡出完成 */
export function cueLifetime(c: Pick<Cue, 'ms' | 'delay'>): number {
  return c.delay + c.ms + 60
}
