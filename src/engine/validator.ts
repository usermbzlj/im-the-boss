// ============================================================
// 合法动作枚举与校验 — 引擎 / AI / UI 共用的唯一口径
//
// reducer 只接受 isLegal() 通过的动作，因此"列表里有、引擎却拒绝"这类导致
// AI 卡死的口径分裂在结构上不可能发生。这里只产出动作本体，不含任何文案；
// 给人看的标签由 text/labels.ts 渲染，给 LLM 看的编号列表由 ai 层拼装。
// ============================================================

import type { GameState, PlayerAction, FamilyId, Payout, InfluenceCard } from './types'
import { HAND_LIMIT, MAX_OFFERS_PER_BOSS, MAX_SPEECHES_PER_PLAYER } from './config'
import {
  getPlayer, getCurrentSpace, getGrossValue, spaceInvestorCount,
  playableClanCards, travelTargets, recruitTargets, findRep,
  selectReps, tableCanComplete, offerOwners, isOfferAgreed, offerStillValid, offerDecliners,
  validateOfferShape, repPriceOf, hasStop, payoutTotal, endChance, leaderIds,
} from './rules'

export function getActingPlayerId(state: GameState): number {
  switch (state.phase) {
    case 'PLACE_MARKER': return state.markerChooserId ?? -1
    case 'TURN':
    case 'AFTER_MOVE':
    case 'HAND_LIMIT':
    case 'END_ROLL': return state.currentId
    case 'NEGOTIATION': return state.negotiation?.turnId ?? -1
    case 'OFFER_RESPONSE': return state.negotiation?.responseQueue[state.negotiation.responseIndex] ?? -1
    case 'REACTION': return state.pendingReaction?.reactorId ?? -1
    case 'CLOSING': return state.negotiation?.closingOrder[state.negotiation.closingIndex] ?? -1
    default: return -1
  }
}

/** 手牌上限阶段的默认弃牌：优先弃"最没用"的牌 */
export function defaultDiscardIds(state: GameState, playerId: number): number[] {
  const player = getPlayer(state, playerId)
  if (!player) return []
  const over = player.hand.length - HAND_LIMIT
  if (over <= 0) return []
  const recruitCount = player.hand.filter(c => c.type === 'RECRUITMENT').length
  const openFamilies = new Set<FamilyId>()
  for (const s of state.board) if (s.closedByTileId == null) for (const g of s.groups) for (const f of g.families) openFamilies.add(f)
  const value = (c: InfluenceCard): number => {
    switch (c.type) {
      case 'RECRUITMENT': return recruitCount >= 3 ? 4 : 1
      case 'CLAN': return c.familyId && openFamilies.has(c.familyId) ? 3 : 0
      case 'TRAVEL': return c.familyId ? (openFamilies.has(c.familyId) ? 3 : 0) : 5
      case 'BOSS': return 6
      case 'STOP': return 7
    }
  }
  return [...player.hand].sort((a, b) => value(a) - value(b)).slice(0, over).map(c => c.id)
}

/**
 * stingy：一分不给 · haggle：压价试探（报价打折）· fair：一份分红为基准、报价封顶两份
 * meet：照单全付（含封口费，全部按承诺价自动同意）· switch：绕开拒绝者改用竞争代表
 */
export type OfferCandidateKey = 'stingy' | 'haggle' | 'fair' | 'meet' | 'switch'

export interface OfferCandidate {
  key: OfferCandidateKey
  repKeys: string[]
  payouts: Payout[]
  /** 该方案下 Boss 的净得 */
  bossKeep: number
  /** 方案是否需要他人同意 */
  needsConsent: boolean
}

/** 为 Boss 预生成几套结构合法的方案，供 AI 选择、供 UI 作为快速填入 */
export function buildOfferCandidates(state: GameState): OfferCandidate[] {
  const neg = state.negotiation
  const space = getCurrentSpace(state)
  if (!neg || !space) return []
  const gross = getGrossValue(state)
  const oneShare = Math.max(1, Math.round(gross / (spaceInvestorCount(space) + 1)))
  const out: OfferCandidate[] = []
  const make = (key: OfferCandidateKey, repKeys: string[], payouts: Payout[]): OfferCandidate => ({
    key, repKeys, payouts, bossKeep: gross - payoutTotal(payouts), needsConsent: offerOwners(neg, { repKeys }).length > 0,
  })

  const makePayouts = (repKeys: string[], mode: 'haggle' | 'fair' | 'meet'): Payout[] | null => {
    const owners = offerOwners(neg, { repKeys })
    const payouts: Payout[] = []
    for (const id of owners) {
      // 承诺价按每个代表、按各自家族的报价计：用了他两个代表就付两份，两家报价不同就各算各的
      let total = 0
      for (const k of repKeys) {
        const rep = findRep(neg, k)
        if (!rep || rep.ownerId !== id) continue
        const asked = repPriceOf(neg, rep)
        total += mode === 'meet' ? (asked ?? oneShare)
          : mode === 'haggle' ? Math.max(1, Math.round((asked ?? oneShare) * 0.7))
          : Math.max(asked != null ? Math.min(asked, oneShare * 2) : oneShare, 1)
      }
      payouts.push({ playerId: id, amount: total })
    }
    if (mode === 'meet') {
      // 满足所有公开报价，包括没有代表、只想拿封口费的人
      for (const d of neg.demands) {
        if (d.playerId === neg.bossId || owners.includes(d.playerId) || d.familyId) continue
        payouts.push({ playerId: d.playerId, amount: d.amount })
      }
    }
    return payoutTotal(payouts) >= gross ? null : payouts
  }

  const base = selectReps(state)
  if (base.complete) {
    out.push(make('stingy', base.repKeys, []))
    if (offerOwners(neg, { repKeys: base.repKeys }).length > 0) {
      const fair = makePayouts(base.repKeys, 'fair')
      const haggle = makePayouts(base.repKeys, 'haggle')
      if (haggle && JSON.stringify(haggle) !== JSON.stringify(fair)) out.push(make('haggle', base.repKeys, haggle))
      if (fair) out.push(make('fair', base.repKeys, fair))
      const meet = makePayouts(base.repKeys, 'meet')
      if (meet && JSON.stringify(meet) !== JSON.stringify(fair)) out.push(make('meet', base.repKeys, meet))
    }
  }
  // 绕开某些人改用竞争代表：当前方案的拒绝者；终局阶段还有"最省组合里的领先者"（给对手送钱等于帮他赢）
  const decliners = neg.offer ? offerDecliners(neg, neg.offer) : []
  const baseOwners = base.complete ? offerOwners(neg, { repKeys: base.repKeys }) : []
  const feedLeaders = endChance(state) > 0 ? leaderIds(state).filter(l => l !== neg.bossId && baseOwners.includes(l)) : []
  const tried = new Set<string>([JSON.stringify(base.repKeys)])
  for (const exclude of [[...decliners, ...feedLeaders], decliners]) {
    if (exclude.length === 0) continue
    const alt = selectReps(state, { excludeOwners: exclude })
    const sig = JSON.stringify(alt.repKeys)
    if (!alt.complete || tried.has(sig)) continue
    tried.add(sig)
    out.push(make('switch', alt.repKeys, makePayouts(alt.repKeys, 'fair') ?? []))
  }
  return out.filter(c => validateOfferShape(state, c.repKeys, c.payouts) === null)
}

/** 谈判 / 成交倒计时中可打的干扰牌（旅行 / 老板 / 招募） */
function cardPlayOptions(state: GameState, playerId: number): PlayerAction[] {
  const neg = state.negotiation
  const player = getPlayer(state, playerId)
  if (!neg || !player) return []
  const out: PlayerAction[] = []
  const seenTravel = new Set<string>()
  let bossListed = false
  for (const card of player.hand) {
    if (card.type === 'TRAVEL') {
      for (const rep of travelTargets(state, card)) {
        const sig = `${card.familyId ?? '*'}|${rep.key}`
        if (seenTravel.has(sig)) continue
        seenTravel.add(sig)
        out.push({ type: 'PLAY_TRAVEL', playerId, cardId: card.id, targetRepKey: rep.key })
      }
    }
    if (card.type === 'BOSS' && neg.bossId !== playerId && !bossListed) {
      bossListed = true
      out.push({ type: 'PLAY_BOSS', playerId, cardId: card.id })
    }
  }
  out.push(...recruitOptions(state, playerId))
  return out
}

function recruitOptions(state: GameState, playerId: number): PlayerAction[] {
  const player = getPlayer(state, playerId)
  if (!player) return []
  const recruits = player.hand.filter(c => c.type === 'RECRUITMENT')
  if (recruits.length < 3) return []
  const cardIds = recruits.slice(0, 3).map(c => c.id)
  return recruitTargets(state, playerId).map(f => ({ type: 'PLAY_RECRUITMENT', playerId, cardIds, targetFamilyId: f }))
}

/**
 * 当前玩家的全部合法动作。含参数的动作给出一个代表性取值
 * （SPEAK 的 say 为占位、DISCARD 为默认弃牌、PROPOSE_OFFER 为候选方案）。
 */
export function getLegalActions(state: GameState, playerId: number): PlayerAction[] {
  const out: PlayerAction[] = []
  const player = getPlayer(state, playerId)
  if (!player || getActingPlayerId(state) !== playerId) return out

  switch (state.phase) {
    case 'PLACE_MARKER':
      for (const space of state.board) {
        if (space.closedByTileId == null) out.push({ type: 'PLACE_MARKER', playerId, spaceId: space.id })
      }
      break
    case 'TURN':
      out.push({ type: 'OPEN_DEAL', playerId }, { type: 'ROLL_MOVE', playerId })
      break
    case 'AFTER_MOVE':
      out.push({ type: 'OPEN_DEAL', playerId }, { type: 'DRAW_CARDS', playerId })
      break
    case 'HAND_LIMIT': {
      out.push(...recruitOptions(state, playerId))
      if (player.hand.length > HAND_LIMIT) out.push({ type: 'DISCARD', playerId, cardIds: defaultDiscardIds(state, playerId) })
      break
    }
    case 'NEGOTIATION': {
      const neg = state.negotiation!
      const isBoss = neg.bossId === playerId
      if ((neg.speakCounts[playerId] ?? 0) < MAX_SPEECHES_PER_PLAYER) out.push({ type: 'SPEAK', playerId, say: '…' })
      for (const card of playableClanCards(state, playerId)) out.push({ type: 'PLAY_CLAN', playerId, cardId: card.id })
      out.push(...cardPlayOptions(state, playerId))
      if (isBoss) {
        if (neg.offersMade < MAX_OFFERS_PER_BOSS && tableCanComplete(state)) {
          for (const c of buildOfferCandidates(state)) out.push({ type: 'PROPOSE_OFFER', playerId, repKeys: c.repKeys, payouts: c.payouts })
        }
        if (canClose(state)) out.push({ type: 'CLOSE_DEAL', playerId })
        out.push({ type: 'ABANDON_DEAL', playerId })
      }
      out.push({ type: 'PASS', playerId })
      break
    }
    case 'OFFER_RESPONSE':
      out.push({ type: 'ACCEPT_OFFER', playerId }, { type: 'DECLINE_OFFER', playerId })
      break
    case 'REACTION':
      if (hasStop(player)) out.push({ type: 'PLAY_STOP', playerId })
      out.push({ type: 'PASS_REACTION', playerId })
      break
    case 'CLOSING':
      out.push(...cardPlayOptions(state, playerId))
      out.push({ type: 'PASS_CLOSING', playerId })
      break
    case 'END_ROLL':
      out.push({ type: 'ROLL_END', playerId })
      break
  }
  return out
}

/** Boss 可否宣布成交：已有全员同意的有效方案，或无方案但仅凭自己的代表就能凑齐 */
export function canClose(state: GameState): boolean {
  const neg = state.negotiation
  if (!neg) return false
  if (neg.offer) return offerStillValid(state, neg.offer) && isOfferAgreed(neg, neg.offer)
  const sel = selectReps(state)
  return sel.complete && offerOwners(neg, { repKeys: sel.repKeys }).length === 0
}

function isValidDemand(state: GameState, amount: number | undefined): boolean {
  if (amount == null) return true
  return Number.isInteger(amount) && amount >= 0 && amount <= getGrossValue(state)
}

function isValidSay(say: unknown): boolean {
  return say === undefined || typeof say === 'string'
}

function distinctCardsOfType(state: GameState, playerId: number, ids: number[], type: InfluenceCard['type'], count: number): boolean {
  const player = getPlayer(state, playerId)
  if (!player || !Array.isArray(ids) || ids.length !== count || new Set(ids).size !== count) return false
  return ids.every(id => player.hand.some(c => c.id === id && c.type === type))
}

export function isLegal(state: GameState, action: PlayerAction): boolean {
  if (!action || typeof action !== 'object' || !isValidSay(action.say)) return false
  if (getActingPlayerId(state) !== action.playerId) return false
  const player = getPlayer(state, action.playerId)
  if (!player) return false
  const neg = state.negotiation

  switch (action.type) {
    case 'SPEAK':
      return state.phase === 'NEGOTIATION' && !!neg &&
        (neg.speakCounts[action.playerId] ?? 0) < MAX_SPEECHES_PER_PLAYER &&
        typeof action.say === 'string' && action.say.trim().length > 0 &&
        isValidDemand(state, action.demand)
    case 'PLAY_CLAN':
      return state.phase === 'NEGOTIATION' &&
        playableClanCards(state, action.playerId).some(c => c.id === action.cardId) &&
        isValidDemand(state, action.demand)
    case 'PLAY_TRAVEL': {
      if (!neg || (state.phase !== 'NEGOTIATION' && state.phase !== 'CLOSING')) return false
      const card = player.hand.find(c => c.id === action.cardId)
      if (!card || card.type !== 'TRAVEL') return false
      const rep = findRep(neg, action.targetRepKey)
      return !!rep && !rep.travelled && (!card.familyId || card.familyId === rep.familyId)
    }
    case 'PLAY_RECRUITMENT':
      return (state.phase === 'NEGOTIATION' || state.phase === 'CLOSING' || state.phase === 'HAND_LIMIT') &&
        distinctCardsOfType(state, action.playerId, action.cardIds, 'RECRUITMENT', 3) &&
        recruitTargets(state, action.playerId).includes(action.targetFamilyId)
    case 'PLAY_BOSS':
      return !!neg && (state.phase === 'NEGOTIATION' || state.phase === 'CLOSING') &&
        neg.bossId !== action.playerId &&
        player.hand.some(c => c.id === action.cardId && c.type === 'BOSS')
    case 'PROPOSE_OFFER':
      return state.phase === 'NEGOTIATION' && !!neg && neg.bossId === action.playerId &&
        neg.offersMade < MAX_OFFERS_PER_BOSS &&
        validateOfferShape(state, action.repKeys, action.payouts) === null
    case 'DISCARD': {
      if (state.phase !== 'HAND_LIMIT') return false
      const over = player.hand.length - HAND_LIMIT
      return over > 0 && Array.isArray(action.cardIds) && action.cardIds.length === over &&
        new Set(action.cardIds).size === over && action.cardIds.every(id => player.hand.some(c => c.id === id))
    }
    case 'DECLINE_OFFER':
      return state.phase === 'OFFER_RESPONSE' && isValidDemand(state, action.counter)
    case 'PLACE_MARKER':
      return state.phase === 'PLACE_MARKER' && !!state.board.find(s => s.id === action.spaceId && s.closedByTileId == null)
    default:
      return getLegalActions(state, action.playerId).some(o => o.type === action.type)
  }
}
