import type { FamilyId, GameState, LoggedEvent, PlayerAction } from '../engine/types'
import { demandOf, playerRelevantFamilies, resolveQuotes } from '../engine/rules'

/** 本笔公开事件；旧存档没有 dealNo 时仍以最近一次开单为边界。 */
export function currentDealEvents(state: GameState): LoggedEvent[] {
  if (!state.negotiation) return []
  const dealNo = state.dealHistory.length + 1
  let start = 0
  for (let i = state.events.length - 1; i >= 0; i--) {
    if (state.events[i].kind === 'DEAL_OPENED') { start = i; break }
  }
  return state.events.slice(start).filter(e => e.dealNo == null || e.dealNo === dealNo)
}

export function speechChangesQuote(state: GameState, action: PlayerAction): boolean {
  const neg = state.negotiation
  if (!neg || action.type !== 'SPEAK' || !action.quotes?.length) return false
  return resolveQuotes(action.quotes, playerRelevantFamilies(state, action.playerId)).some(q =>
    q.familyIds.length
      ? q.familyIds.some(f => demandOf(neg, action.playerId, f) !== q.amount)
      : demandOf(neg, action.playerId) !== q.amount)
}

/** 出牌、方案与应答改变了谈判条件；纯喊价不能清空已经尝试过的报价。 */
function isMaterialProgress(event: LoggedEvent): boolean {
  switch (event.kind) {
    case 'DEAL_OPENED': case 'OFFER_PROPOSED': case 'OFFER_RESOLVED':
    case 'CLAN_PLAYED': case 'TRAVEL_RESOLVED': case 'RECRUITMENT_RESOLVED':
    case 'BOSS_RESOLVED': case 'PRICE_CHANGED': case 'EXCLUSIVE_RESOLVED':
    case 'SICK_RESOLVED': case 'COMMITMENT_UPDATED':
    case 'CARD_SWAPPED': case 'CARDS_TRADED': case 'STOP_PLAYED':
      return true
    default:
      return false
  }
}

/** 最近一次公开实质行动以来，此人曾用过的家族价 / 封口费。 */
function usedPrices(events: LoggedEvent[], playerId: number, familyId?: FamilyId): Set<number> {
  const prices = new Set<number>()
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (isMaterialProgress(event)) break
    if (event.kind !== 'DEMAND' || event.playerId !== playerId) continue
    for (const quote of event.quotes) {
      if (familyId == null ? quote.familyIds.length === 0 : quote.familyIds.includes(familyId)) prices.add(quote.amount)
    }
  }
  return prices
}

/** 新价可以试探；已用价格的往返、已有封口费后的纯抬价不算推进。仅用于 AI。 */
export function speechAdvancesNegotiation(state: GameState, action: PlayerAction): boolean {
  const neg = state.negotiation
  if (!neg || action.type !== 'SPEAK' || !action.quotes?.length || action.playerId === neg.bossId) return false
  const scope = playerRelevantFamilies(state, action.playerId)
  const events = currentDealEvents(state)
  const changes = resolveQuotes(action.quotes, scope).flatMap(q =>
    (q.familyIds.length ? q.familyIds : [undefined]).map(familyId => ({
      familyId, amount: q.amount, previous: demandOf(neg, action.playerId, familyId),
    }))).filter(q => q.previous !== q.amount)
  return changes.length > 0 && changes.every(q => {
    const used = usedPrices(events, action.playerId, q.familyId)
    if (used.has(q.amount)) return false
    // 无相关代表：本局面已经报过封口费，不能靠越叫越高消耗谈判轮次。
    return q.familyId != null || used.size === 0 || q.previous == null || q.amount < q.previous
  })
}

/** 其他相关代表报出尚未用过的新价，给行动者一次重新考虑；封口费不能不断重开等待。 */
function freshRepresentativeQuote(state: GameState, events: LoggedEvent[], index: number): boolean {
  const event = events[index]
  if (event.kind !== 'DEMAND') return false
  const relevant = new Set(playerRelevantFamilies(state, event.playerId))
  return event.quotes.some(q => q.familyIds.some(f => relevant.has(f) && !usedPrices(events.slice(0, index), event.playerId, f).has(q.amount)))
}

/** 留出一次自由喊话/等待；自己的报价与无关封口费不会替自己不断重置机会。 */
export function alreadyWaited(state: GameState, playerId: number): boolean {
  const events = currentDealEvents(state)
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (isMaterialProgress(event)) return false
    switch (event.kind) {
      case 'DEMAND':
        if (event.playerId === playerId) return true
        if (freshRepresentativeQuote(state, events, index)) return false
        break
      case 'PASSED':
        if (event.phase === 'NEGOTIATION' && event.playerId === playerId) return true
        break
      case 'SPEECH':
        if (event.playerId === playerId) return true
        break
    }
  }
  return false
}
