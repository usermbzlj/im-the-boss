// ============================================================
// 事件流整理（纯函数）：把一笔交易里的事件整理成"谈判事件流"的条目
//   · 喊话 → 人物气泡条目
//   · 连续的跳过 / 放行（次要事件）→ 折叠成一行"某某等 N 人跳过"
//   · 其余事件 → 用 text/narrate 渲染成一行
// 非谈判期间的"刚刚发生"简报也在这里挑选（recentDigest）。
// ============================================================

import type { GameState, LoggedEvent, PassPhase } from '../engine/types'
import { narrate, isMinorEvent, playerName, type EventTone } from '../text/narrate'
import { briefOf, type EventBrief } from './toasts'

export type FeedItem =
  | { type: 'speech'; id: number; playerId: number; text: string }
  | { type: 'event'; id: number; text: string; tone: EventTone }
  | { type: 'passes'; id: number; lastId: number; phase: PassPhase; playerIds: number[]; text: string }

/** 当前交易的编号（= 第几次开单）；没有进行中的交易返回 null */
export function currentDealNo(state: GameState): number | null {
  return state.negotiation ? state.dealHistory.length + 1 : null
}

/** "A 跳过" / "A、B 跳过" / "A 等 4 人跳过"；谈判之外的阶段叫"放行" */
export function summarizePasses(state: GameState, playerIds: number[], phase: PassPhase): string {
  const ids = [...new Set(playerIds)]
  const verb = phase === 'NEGOTIATION' ? '跳过' : '放行'
  const names = ids.map(id => playerName(state, id))
  if (names.length <= 2) return `${names.join('、')} ${verb}`
  return `${names[0]} 等 ${names.length} 人${verb}`
}

/** 把一批事件（按时间顺序）整理成事件流条目；相邻、同阶段的跳过 / 放行合并为一条 */
export function buildFeed(state: GameState, events: readonly LoggedEvent[]): FeedItem[] {
  const items: FeedItem[] = []
  for (const e of events) {
    if (e.kind === 'SPEECH') {
      items.push({ type: 'speech', id: e.id, playerId: e.playerId, text: e.text })
      continue
    }
    if (e.kind === 'PASSED' && isMinorEvent(e)) {
      const last = items[items.length - 1]
      if (last && last.type === 'passes' && last.phase === e.phase) {
        last.playerIds.push(e.playerId)
        last.lastId = e.id
        last.text = summarizePasses(state, last.playerIds, last.phase)
      } else {
        items.push({ type: 'passes', id: e.id, lastId: e.id, phase: e.phase, playerIds: [e.playerId], text: summarizePasses(state, [e.playerId], e.phase) })
      }
      continue
    }
    const n = narrate(state, e)
    items.push({ type: 'event', id: e.id, text: n.text, tone: n.tone })
  }
  return items
}

/** 某笔交易（按 dealNo）的事件流 */
export function dealFeed(state: GameState, dealNo: number): FeedItem[] {
  return buildFeed(state, state.events.filter(e => e.dealNo === dealNo))
}

export interface DigestItem extends EventBrief {
  id: number
}

/** "刚刚发生"简报：最近 limit 条值得一看的事件（时间正序），文案是面向视角玩家的短句 */
export function recentDigest(state: GameState, viewerId: number, limit = 3): DigestItem[] {
  const out: DigestItem[] = []
  for (let i = state.events.length - 1; i >= 0 && out.length < limit; i--) {
    const e = state.events[i]
    const brief = briefOf(state, e, viewerId)
    if (brief) out.push({ id: e.id, ...brief })
  }
  return out.reverse()
}
