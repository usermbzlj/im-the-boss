// ============================================================
// 规则辅助层 — 纯函数，不修改状态
// 引擎、合法动作枚举、AI 与 UI 共用同一份判定口径
// ============================================================

import type {
  GameState, BoardSpace, DealGroup, DealTile, FamilyId, Negotiation,
  Representative, Offer, Payout, Player, InfluenceCard,
} from './types'
import { FAMILY_IDS } from './config'

// ---------- 基础查询 ----------

export function getPlayer(state: GameState, id: number): Player | undefined {
  return state.players[id]
}

export function nextPlayerId(state: GameState, from: number): number {
  return (from + 1) % state.players.length
}

export function prevPlayerId(state: GameState, from: number): number {
  return (from - 1 + state.players.length) % state.players.length
}

/** 从 from 左手边开始的其他玩家顺序 */
export function othersFrom(state: GameState, from: number): number[] {
  const n = state.players.length
  const out: number[] = []
  for (let i = 1; i < n; i++) out.push((from + i) % n)
  return out
}

export function getSpace(state: GameState, id: number): BoardSpace | undefined {
  return state.board.find(s => s.id === id)
}

export function getCurrentSpace(state: GameState): BoardSpace | undefined {
  return getSpace(state, state.negotiation?.spaceId ?? state.markerPos)
}

export function getCurrentTile(state: GameState): DealTile | undefined {
  return state.dealTiles[state.dealTileIndex]
}

export function getGrossValue(state: GameState): number {
  const tile = getCurrentTile(state)
  const space = getCurrentSpace(state)
  if (!tile || !space) return 0
  return tile.shareValue * space.dividends
}

export function getEndProbability(tile: DealTile | undefined): number {
  if (!tile || tile.endFaces.length === 0) return 0
  return Math.round((tile.endFaces.length / 6) * 100)
}

// ---------- 交易格需求 ----------

export function isRequiredGroup(g: DealGroup): boolean {
  return g.need >= g.families.length
}

export function spaceInvestorCount(space: Pick<BoardSpace, 'groups'>): number {
  return space.groups.reduce((s, g) => s + g.need, 0)
}

export function relevantFamilies(space: Pick<BoardSpace, 'groups'>): FamilyId[] {
  const set = new Set<FamilyId>()
  for (const g of space.groups) for (const f of g.families) set.add(f)
  return FAMILY_IDS.filter(f => set.has(f))
}

export function groupOfFamily(space: BoardSpace, f: FamilyId): DealGroup | undefined {
  return space.groups.find(g => g.families.includes(f))
}

/** 给定一组家族，是否恰好/足以满足全部需求组 */
export function familiesSatisfy(space: BoardSpace, families: Iterable<FamilyId>): boolean {
  const set = new Set(families)
  return space.groups.every(g => g.families.filter(f => set.has(f)).length >= g.need)
}

// ---------- 代表 ----------

export function activeReps(neg: Negotiation): Representative[] {
  return neg.reps.filter(r => !r.travelled)
}

export function activeRepsOfFamily(neg: Negotiation, f: FamilyId): Representative[] {
  return neg.reps.filter(r => !r.travelled && r.familyId === f)
}

export function findRep(neg: Negotiation, key: string): Representative | undefined {
  return neg.reps.find(r => r.key === key)
}

export function investorRepKey(f: FamilyId): string {
  return `INV:${f}`
}

export function clanRepKey(cardId: number): string {
  return `CLAN:${cardId}`
}

/** 玩家在本局拥有有效代表的家族集合 */
export function playerActiveFamilies(neg: Negotiation, playerId: number): Set<FamilyId> {
  const set = new Set<FamilyId>()
  for (const r of neg.reps) if (!r.travelled && r.ownerId === playerId) set.add(r.familyId)
  return set
}

/** 玩家是否有与本格需求相关的有效代表 */
export function playerHasRelevantRep(state: GameState, playerId: number): boolean {
  const neg = state.negotiation
  const space = getCurrentSpace(state)
  if (!neg || !space) return false
  const relevant = new Set(relevantFamilies(space))
  return neg.reps.some(r => !r.travelled && r.ownerId === playerId && relevant.has(r.familyId))
}

/** 每位玩家最多一条公开报价（后报覆盖先报），familyId 仅作展示标注 */
export function demandOf(neg: Negotiation, playerId: number): number | undefined {
  return neg.demands.find(d => d.playerId === playerId)?.amount
}

/** 一份分红的默认心理价：总额 / (投资者数 + 1) */
export function oneShareOf(state: GameState): number {
  const space = getCurrentSpace(state)
  const gross = getGrossValue(state)
  return Math.max(1, Math.round(gross / ((space ? spaceInvestorCount(space) : 3) + 1)))
}

/**
 * 代表的"使用成本"：Boss 自己的代表免费；其他人按其公开报价；
 * 没报价的按"一份分红"估算默认心理价。
 */
export function repCost(state: GameState, rep: Representative): number {
  const neg = state.negotiation
  if (!neg) return 0
  if (rep.ownerId === neg.bossId) return 0
  const asked = demandOf(neg, rep.ownerId)
  if (asked != null) return asked
  return oneShareOf(state)
}

export interface RepSelection {
  repKeys: string[]
  complete: boolean
  /** 无法凑齐的需求组（用于提示缺口） */
  missing: Array<{ group: DealGroup; have: number }>
}

/**
 * 自动挑选代表：每个家族取成本最低的代表（同价优先投资者牌，省家族卡），
 * 每个需求组按成本从低到高凑满 need 个家族。
 * preferOwner：为该玩家"自算成本"（视其为 Boss），供 AI 评估自己当 Boss 的可行性。
 */
export function selectReps(state: GameState, opts: { excludeOwners?: number[]; preferOwner?: number } = {}): RepSelection {
  const neg = state.negotiation
  const space = getCurrentSpace(state)
  if (!neg || !space) return { repKeys: [], complete: false, missing: [] }
  const exclude = new Set(opts.excludeOwners ?? [])
  const bossId = opts.preferOwner ?? neg.bossId
  const cost = (r: Representative) => (r.ownerId === bossId ? 0 : repCost(state, r))
  const rank = (a: Representative, b: Representative) =>
    cost(a) - cost(b) || (a.source === b.source ? 0 : a.source === 'INVESTOR' ? -1 : 1)

  const cheapestOf = (f: FamilyId) =>
    neg.reps.filter(r => !r.travelled && r.familyId === f && !exclude.has(r.ownerId)).sort(rank)[0]

  const keys: string[] = []
  const missing: RepSelection['missing'] = []
  for (const g of space.groups) {
    const candidates = g.families
      .map(f => cheapestOf(f))
      .filter((r): r is Representative => !!r)
      .sort(rank)
      .slice(0, g.need)
    for (const r of candidates) keys.push(r.key)
    if (candidates.length < g.need) missing.push({ group: g, have: candidates.length })
  }
  return { repKeys: keys, complete: missing.length === 0, missing }
}

/** 当前桌面上的有效代表能否凑齐需求 */
export function tableCanComplete(state: GameState): boolean {
  const neg = state.negotiation
  const space = getCurrentSpace(state)
  if (!neg || !space) return false
  return familiesSatisfy(space, activeReps(neg).map(r => r.familyId))
}

/** 玩家仅凭自己的投资者牌（未被旅行）+ 手中家族卡能否凑齐某格 */
export function canCompleteAlone(state: GameState, playerId: number, space: BoardSpace): boolean {
  const owned = new Set<FamilyId>()
  const travelled = new Set(state.negotiation?.travelledInvestors ?? [])
  for (const inv of state.investors) {
    if (inv.ownerId === playerId && !travelled.has(inv.familyId)) owned.add(inv.familyId)
  }
  const player = getPlayer(state, playerId)
  for (const c of player?.hand ?? []) if (c.type === 'CLAN' && c.familyId) owned.add(c.familyId)
  return familiesSatisfy(space, owned)
}

/** 玩家的投资者牌 + 手中家族卡能覆盖的家族 */
export function playerCoverableFamilies(state: GameState, playerId: number): Set<FamilyId> {
  const set = new Set<FamilyId>()
  for (const inv of state.investors) if (inv.ownerId === playerId) set.add(inv.familyId)
  const player = getPlayer(state, playerId)
  for (const c of player?.hand ?? []) if (c.type === 'CLAN' && c.familyId) set.add(c.familyId)
  return set
}

// ---------- 方案 ----------

export function offerOwners(neg: Negotiation, offer: Pick<Offer, 'repKeys'>): number[] {
  const set = new Set<number>()
  for (const key of offer.repKeys) {
    const rep = findRep(neg, key)
    if (rep && rep.ownerId !== neg.bossId) set.add(rep.ownerId)
  }
  return [...set]
}

export function isOfferAgreed(neg: Negotiation, offer: Offer): boolean {
  return offerOwners(neg, offer).every(id => offer.responses[id] === 'ACCEPTED')
}

export function offerDecliners(neg: Negotiation, offer: Offer): number[] {
  return offerOwners(neg, offer).filter(id => offer.responses[id] === 'DECLINED')
}

export function payoutTotal(payouts: Payout[]): number {
  return payouts.reduce((s, p) => s + p.amount, 0)
}

export function offerShareOf(offer: Offer | null | undefined, playerId: number): number {
  return offer?.payouts.find(p => p.playerId === playerId)?.amount ?? 0
}

export type OfferError =
  | { code: 'NO_NEGOTIATION' }
  | { code: 'BAD_SHAPE' }
  | { code: 'UNKNOWN_REP' }
  | { code: 'REP_TRAVELLED'; familyId: FamilyId }
  | { code: 'DUPLICATE_FAMILY'; familyId: FamilyId }
  | { code: 'IRRELEVANT_FAMILY'; familyId: FamilyId }
  | { code: 'GROUP_SHORT'; group: DealGroup; have: number }
  | { code: 'GROUP_OVER'; group: DealGroup; have: number }
  | { code: 'UNKNOWN_PAYEE' }
  | { code: 'PAY_TO_BOSS' }
  | { code: 'DUPLICATE_PAYEE' }
  | { code: 'BAD_AMOUNT' }
  | { code: 'OVER_GROSS'; total: number; gross: number }

/** 校验方案结构：返回错误（结构化，文案由 text 层渲染），合法返回 null */
export function validateOfferShape(state: GameState, repKeys: string[], payouts: Payout[]): OfferError | null {
  const neg = state.negotiation
  const space = getCurrentSpace(state)
  if (!neg || !space) return { code: 'NO_NEGOTIATION' }
  if (!Array.isArray(repKeys) || !Array.isArray(payouts)) return { code: 'BAD_SHAPE' }

  const families: FamilyId[] = []
  for (const key of repKeys) {
    const rep = typeof key === 'string' ? findRep(neg, key) : undefined
    if (!rep) return { code: 'UNKNOWN_REP' }
    if (rep.travelled) return { code: 'REP_TRAVELLED', familyId: rep.familyId }
    if (families.includes(rep.familyId)) return { code: 'DUPLICATE_FAMILY', familyId: rep.familyId }
    families.push(rep.familyId)
  }
  const relevant = new Set(relevantFamilies(space))
  const stray = families.find(f => !relevant.has(f))
  if (stray) return { code: 'IRRELEVANT_FAMILY', familyId: stray }
  for (const g of space.groups) {
    const have = g.families.filter(f => families.includes(f)).length
    if (have < g.need) return { code: 'GROUP_SHORT', group: g, have }
    if (have > g.need) return { code: 'GROUP_OVER', group: g, have }
  }

  const seen = new Set<number>()
  let total = 0
  for (const p of payouts) {
    if (!p || typeof p !== 'object' || !Number.isInteger(p.playerId) || !getPlayer(state, p.playerId)) return { code: 'UNKNOWN_PAYEE' }
    if (p.playerId === neg.bossId) return { code: 'PAY_TO_BOSS' }
    if (seen.has(p.playerId)) return { code: 'DUPLICATE_PAYEE' }
    seen.add(p.playerId)
    if (!Number.isInteger(p.amount) || p.amount < 0) return { code: 'BAD_AMOUNT' }
    total += p.amount
  }
  const gross = getGrossValue(state)
  if (total > gross) return { code: 'OVER_GROSS', total, gross }
  return null
}

/** 方案是否仍有效（代表未失效、未易主导致需重新确认等） */
export function offerStillValid(state: GameState, offer: Offer): boolean {
  return validateOfferShape(state, offer.repKeys, offer.payouts) === null
}

// ---------- 手牌 ----------

export function countCards(hand: InfluenceCard[], type: InfluenceCard['type']): number {
  return hand.filter(c => c.type === type).length
}

export function hasStop(player: Player | undefined): boolean {
  return !!player?.hand.some(c => c.type === 'STOP')
}

/** 招募合法目标：有公共区投资者时必须先招公共区，否则可夺任意他人投资者 */
export function recruitTargets(state: GameState, playerId: number): FamilyId[] {
  const neutral = state.investors.filter(inv => inv.ownerId === null)
  const pool = neutral.length > 0 ? neutral : state.investors.filter(inv => inv.ownerId !== null && inv.ownerId !== playerId)
  const set = new Set(pool.map(inv => inv.familyId))
  return FAMILY_IDS.filter(f => set.has(f))
}

/** 未关闭格子里每个家族出现的次数（评估投资者长期价值） */
export function familyDemandOnBoard(state: GameState): Record<FamilyId, number> {
  const freq = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 } as Record<FamilyId, number>
  for (const space of state.board) {
    if (space.closedByTileId != null) continue
    for (const g of space.groups) {
      const weight = g.need / g.families.length
      for (const f of g.families) freq[f] += weight
    }
  }
  return freq
}

/** 当前谈判中，玩家手里可打出的家族卡（属于本格需求且该玩家在该家族尚无有效代表） */
export function playableClanCards(state: GameState, playerId: number): InfluenceCard[] {
  const neg = state.negotiation
  const space = getCurrentSpace(state)
  const player = getPlayer(state, playerId)
  if (!neg || !space || !player) return []
  const relevant = new Set(relevantFamilies(space))
  const mine = playerActiveFamilies(neg, playerId)
  const seen = new Set<FamilyId>()
  const out: InfluenceCard[] = []
  for (const c of player.hand) {
    if (c.type !== 'CLAN' || !c.familyId) continue
    if (!relevant.has(c.familyId) || mine.has(c.familyId) || seen.has(c.familyId)) continue
    seen.add(c.familyId)
    out.push(c)
  }
  return out
}

/** 旅行牌可打的目标代表 */
export function travelTargets(state: GameState, card: InfluenceCard): Representative[] {
  const neg = state.negotiation
  if (!neg || card.type !== 'TRAVEL') return []
  return neg.reps.filter(r => !r.travelled && (!card.familyId || r.familyId === card.familyId))
}
