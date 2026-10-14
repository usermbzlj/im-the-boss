import type { GameState, LoggedEvent, PlayerAction } from '../engine/types'
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

/** 留出一次自由喊话/等待；同一公开局面已等待过时，再次空转可以走实质兜底。 */
export function alreadyWaited(state: GameState, playerId: number): boolean {
  for (const event of currentDealEvents(state).reverse()) {
    switch (event.kind) {
      case 'DEAL_OPENED': case 'OFFER_PROPOSED': case 'OFFER_RESOLVED':
      case 'CLAN_PLAYED': case 'TRAVEL_RESOLVED': case 'RECRUITMENT_RESOLVED':
      case 'BOSS_RESOLVED': case 'PRICE_CHANGED': case 'EXCLUSIVE_RESOLVED':
      case 'SICK_RESOLVED': case 'COMMITMENT_UPDATED':
      case 'CARD_SWAPPED': case 'CARDS_TRADED': case 'STOP_PLAYED':
        return false
      case 'DEMAND':
        // 引擎只记录真正改变承诺价的 DEMAND；新价格值得重新考虑。
        return false
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
