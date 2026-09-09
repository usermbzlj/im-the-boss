// ============================================================
// 规则辅助层 — 纯函数，不修改状态
// 引擎、合法动作枚举、AI 与 UI 共用同一份判定口径
// ============================================================

import type {
  GameState, BoardSpace, DealGroup, DealTile, FamilyId, Negotiation, GamePhase, PlayerActionType,
  Representative, Offer, Payout, Player, InfluenceCard, Demand, Quote, ResolvedQuote,
} from './types'
import {
  FAMILY_IDS, RECRUIT_COST, HEADHUNT_RECRUIT_COST, RECLAIM_RECRUIT_COST, PREMIUM_BONUS, MIN_SHARE_VALUE, LANDMARK_RENT,
  BUY_CARDS_COST_SHARES, MAX_BUY_CARDS, TRADE_GIVE_COUNT, TRADE_COST_SHARES, TRADE_RECRUIT_COUNT, HAND_LIMIT,
} from './config'

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

/**
 * 当前格每份的实际股价：景气牌股价 + 抢手格加成 + 本笔利好 / 利空牌的累计变动，不低于下限。
 * 谈判外（标记所在格）同样计入抢手加成，这样开单前看到的总额就是开单后的总额。
 */
export function effectiveShareValue(state: GameState, space?: BoardSpace): number {
  const tile = getCurrentTile(state)
  const sp = space ?? getCurrentSpace(state)
  if (!tile || !sp) return 0
  const delta = state.negotiation && state.negotiation.spaceId === sp.id ? state.negotiation.priceDelta : 0
  return Math.max(MIN_SHARE_VALUE, tile.shareValue + (sp.kind === 'PREMIUM' ? PREMIUM_BONUS : 0) + delta)
}

export function getGrossValue(state: GameState): number {
  const space = getCurrentSpace(state)
  if (!space || !getCurrentTile(state)) return 0
  return effectiveShareValue(state, space) * space.dividends
}

/** 某格若现在开单的交易总额（用于评估版图上的其他格子） */
export function grossValueOf(state: GameState, space: BoardSpace): number {
  if (!getCurrentTile(state)) return 0
  return effectiveShareValue(state, space) * space.dividends
}

/** 还剩几张景气牌可成交（含当前这张） */
export function remainingDeals(state: GameState): number {
  return Math.max(0, state.dealTiles.length - state.dealTileIndex)
}

/** 当前交易所在格是否为某种特殊格（谈判外按标记所在格） */
export function currentSpaceKind(state: GameState): BoardSpace['kind'] {
  return getCurrentSpace(state)?.kind ?? 'STANDARD'
}

/** 黑市：本格交易中打出的牌不经反应窗口 */
export function isBlackMarketDeal(state: GameState): boolean {
  return !!state.negotiation && getCurrentSpace(state)?.kind === 'BLACK_MARKET'
}

/** 已被人拿下的地标（收租人 → 格子） */
export function landlords(state: GameState): Array<{ spaceId: number; ownerId: number }> {
  return state.board.filter(b => b.kind === 'LANDMARK' && b.landlordId != null).map(b => ({ spaceId: b.id, ownerId: b.landlordId! }))
}

/**
 * 拿下某地标格预期还能收多少租：此后每笔成交 $1M，按剩余景气牌张数估（本笔之后还剩几张），
 * 再打个折扣——不是每张景气牌都会成交、游戏也可能提前终局。
 */
export function landmarkRentEstimate(state: GameState, space: BoardSpace): number {
  if (space.kind !== 'LANDMARK') return 0
  const left = Math.max(0, remainingDeals(state) - 1)
  return Math.round(left * LANDMARK_RENT * 0.7)
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

/**
 * 玩家的公开报价。指定 familyId：该家族代表的出借价（专门报价优先，否则用其通用价）；
 * 不指定：只返回通用价（封口费 / 兜底价）。返回 undefined = 没报过。
 */
export function demandOf(neg: Negotiation, playerId: number, familyId?: FamilyId): number | undefined {
  const mine = neg.demands.filter(d => d.playerId === playerId)
  if (familyId) {
    const specific = mine.find(d => d.familyId === familyId)
    if (specific) return specific.amount
  }
  return mine.find(d => d.familyId == null)?.amount
}

/** 该玩家是否报过任何价 */
export function hasDemand(neg: Negotiation, playerId: number): boolean {
  return neg.demands.some(d => d.playerId === playerId)
}

/** 某个代表的出借价（Boss 自己的代表不适用，由调用方处理） */
export function repPriceOf(neg: Negotiation, rep: Representative): number | undefined {
  return demandOf(neg, rep.ownerId, rep.familyId)
}

/** 玩家在当前格相关的、有有效代表的家族 */
export function playerRelevantFamilies(state: GameState, playerId: number): FamilyId[] {
  const neg = state.negotiation
  const space = getCurrentSpace(state)
  if (!neg || !space) return []
  const relevant = new Set(relevantFamilies(space))
  return [...playerActiveFamilies(neg, playerId)].filter(f => relevant.has(f))
}

/** 展示用：玩家的全部报价，按家族 */
export function demandsOf(neg: Negotiation, playerId: number): Demand[] {
  return neg.demands.filter(d => d.playerId === playerId)
}

/** 方案中用到的、属于该玩家的代表所属家族（去重）——反报价的作用域 */
export function usedFamiliesOf(neg: Negotiation, offer: Pick<Offer, 'repKeys'>, playerId: number): FamilyId[] {
  const out: FamilyId[] = []
  for (const k of offer.repKeys) {
    const r = findRep(neg, k)
    if (r && r.ownerId === playerId && !out.includes(r.familyId)) out.push(r.familyId)
  }
  return out
}

/**
 * 报价是否成形：金额是 [0, 总额] 内的整数；指定的家族必须在作用域内（我在本格的相关家族 / 方案所用的我的家族）
 * 且不重复；通用价最多一条。空数组视为"没报价"。
 */
export function validQuotes(quotes: unknown, scope: FamilyId[], gross: number): quotes is Quote[] {
  if (quotes === undefined) return true
  if (!Array.isArray(quotes)) return false
  const seen = new Set<string>()
  for (const q of quotes as Array<Partial<Quote> | null>) {
    if (!q || typeof q !== 'object') return false
    if (!Number.isInteger(q.amount) || (q.amount as number) < 0 || (q.amount as number) > gross) return false
    if (q.familyId != null && !scope.includes(q.familyId)) return false
    const key = q.familyId ?? '*'
    if (seen.has(key)) return false
    seen.add(key)
  }
  return true
}

/**
 * 把一次报价落成到家族：显式家族条目各记各的价；通用价补到作用域内其余家族；
 * 作用域为空（没有相关代表）时通用价就是封口费（familyIds 为空）。
 * 返回按金额归并的列表（同价家族合成一条），供引擎记账与叙述。
 */
export function resolveQuotes(quotes: Quote[], scope: FamilyId[]): ResolvedQuote[] {
  const byAmount = new Map<number, FamilyId[]>()
  const explicit = new Set<FamilyId>()
  let general: number | undefined
  for (const q of quotes) {
    if (q.familyId != null) {
      explicit.add(q.familyId)
      byAmount.set(q.amount, [...(byAmount.get(q.amount) ?? []), q.familyId])
    } else general = q.amount
  }
  if (general != null) {
    const rest = scope.filter(f => !explicit.has(f))
    if (rest.length > 0) byAmount.set(general, [...(byAmount.get(general) ?? []), ...rest])
    else if (scope.length === 0) return [...toResolved(byAmount), { familyIds: [], amount: general }]
  }
  return toResolved(byAmount)
}

function toResolved(byAmount: Map<number, FamilyId[]>): ResolvedQuote[] {
  return [...byAmount.entries()].map(([amount, familyIds]) => ({ amount, familyIds }))
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
/**
 * 一个代表的预期出借价：Boss 自有免费；报过价按承诺价；没报价按一份分红估。
 * asBossId：以"某人当 Boss"的视角估价（评估夺权后的成本时用），默认为现任 Boss。
 */
export function repCost(state: GameState, rep: Representative, asBossId?: number): number {
  const neg = state.negotiation
  if (!neg) return 0
  if (rep.ownerId === (asBossId ?? neg.bossId)) return 0
  const asked = repPriceOf(neg, rep)
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
  const cost = (r: Representative) => repCost(state, r, bossId)
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

/** 方案里用了该玩家几个代表 */
export function repsUsedOf(neg: Negotiation, offer: Pick<Offer, 'repKeys'>, playerId: number): number {
  return offer.repKeys.filter(k => findRep(neg, k)?.ownerId === playerId).length
}

/**
 * 该玩家对这份方案的承诺价：方案里用到的他的每个代表按各自家族的出借价相加；
 * 任一被选用的代表没报过价 → undefined（没有承诺，需要他表态）。
 * 没用其代表时就是其通用报价（封口费）。
 */
export function commitmentPrice(neg: Negotiation, offer: Pick<Offer, 'repKeys'>, playerId: number): number | undefined {
  const used = offer.repKeys.map(k => findRep(neg, k)).filter((r): r is Representative => !!r && r.ownerId === playerId)
  if (used.length === 0) return demandOf(neg, playerId)
  let sum = 0
  for (const r of used) {
    const price = repPriceOf(neg, r)
    if (price == null) return undefined
    sum += price
  }
  return sum
}

/** 报价即承诺：方案付到该玩家的承诺价（有报价且分成 ≥ 报价 × 所用代表数）即视为其同意 */
export function meetsCommitment(neg: Negotiation, offer: Pick<Offer, 'repKeys' | 'payouts'>, playerId: number): boolean {
  const price = commitmentPrice(neg, offer, playerId)
  return price != null && (offer.payouts.find(p => p.playerId === playerId)?.amount ?? 0) >= price
}

/** 方案若提出，哪些代表持有者会自动同意、哪些还需表态 */
export function offerConsent(neg: Negotiation, offer: Pick<Offer, 'repKeys' | 'payouts'>): { auto: number[]; asked: number[] } {
  const owners = offerOwners(neg, offer)
  return {
    auto: owners.filter(id => meetsCommitment(neg, offer, id)),
    asked: owners.filter(id => !meetsCommitment(neg, offer, id)),
  }
}

// ---------- 局势 ----------

/** 现金最多的玩家（可并列） */
export function leaderIds(state: GameState): number[] {
  const top = Math.max(...state.players.map(p => p.cash))
  return state.players.filter(p => p.cash === top).map(p => p.id)
}

/** 本笔交易成交后游戏结束的概率（0~1） */
export function endChance(state: GameState): number {
  return getEndProbability(getCurrentTile(state)) / 100
}

/** 当前需求中还缺代表的家族（按需求组：组内已有代表数不足 need 时，列出组内无代表的家族） */
export function missingFamilies(state: GameState): FamilyId[] {
  const neg = state.negotiation
  const space = getCurrentSpace(state)
  if (!neg || !space) return []
  const covered = new Set(activeReps(neg).map(r => r.familyId))
  const out: FamilyId[] = []
  for (const g of space.groups) {
    const have = g.families.filter(f => covered.has(f)).length
    if (have >= g.need) continue
    for (const f of g.families) if (!covered.has(f) && !out.includes(f)) out.push(f)
  }
  return out
}

/**
 * 玩家的"杠杆"家族：本格需要、桌上只有他一个人有有效代表、且没有他就凑不齐的家族。
 * 有杠杆 = 可以抬价；没有 = 只能靠价格竞争或干扰牌。
 */
export function soleRepFamilies(state: GameState, playerId: number): FamilyId[] {
  const neg = state.negotiation
  const space = getCurrentSpace(state)
  if (!neg || !space) return []
  const reps = activeReps(neg)
  const out: FamilyId[] = []
  for (const g of space.groups) {
    const coveredFamilies = g.families.filter(f => reps.some(r => r.familyId === f))
    const slack = coveredFamilies.length - g.need // 组内多出来的可替换家族数
    for (const f of g.families) {
      const holders = reps.filter(r => r.familyId === f)
      if (holders.length === 1 && holders[0].ownerId === playerId && slack <= 0) out.push(f)
    }
  }
  return out
}

/** 同家族里与该玩家竞争的其他代表（他们的最低报价决定了这位玩家的价格上限） */
export function rivalReps(state: GameState, playerId: number, f: FamilyId): Representative[] {
  const neg = state.negotiation
  if (!neg) return []
  return activeRepsOfFamily(neg, f).filter(r => r.ownerId !== playerId)
}

/** target 过去搅了 me 当 Boss 的几笔交易（记仇用） */
export function grudgeCount(state: GameState, me: number, target: number): number {
  return state.dealHistory.filter(d => d.bossId === me && d.disruptors.includes(target)).length
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

/** 玩家对某家族的有效夺回权：有夺回权、目标正是那个家族、且它现在在别人手里 */
export function canReclaim(state: GameState, playerId: number, familyId: FamilyId): boolean {
  const player = getPlayer(state, playerId)
  if (!player || player.reclaim !== familyId) return false
  const inv = state.investors.find(i => i.familyId === familyId)
  return !!inv && inv.ownerId != null && inv.ownerId !== playerId
}

/**
 * 招募某家族要几张招募牌：夺回权 1 张；本格交易进行中（谈判 / 倒计时）且是猎头格 2 张；否则 3 张。
 * 手牌上限阶段不在任何交易里，按常规价。
 */
export function recruitCost(state: GameState, playerId: number, familyId: FamilyId): number {
  if (canReclaim(state, playerId, familyId)) return RECLAIM_RECRUIT_COST
  return standardRecruitCost(state)
}

/** 不计夺回权时，此刻凑一组招募要几张：猎头格交易进行中 2 张，其余 3 张（手牌区"招募 n/3"的分母） */
export function standardRecruitCost(state: GameState): number {
  const inDeal = !!state.negotiation && (state.phase === 'NEGOTIATION' || state.phase === 'CLOSING' || state.phase === 'REACTION')
  return inDeal && getCurrentSpace(state)?.kind === 'HEADHUNT' ? HEADHUNT_RECRUIT_COST : RECRUIT_COST
}

/**
 * 招募合法目标：有公共区投资者时必须先招公共区，否则可夺任意他人投资者；
 * 夺回权的目标家族不受"先招公共区"限制——那是抢回自己的人。
 */
export function recruitTargets(state: GameState, playerId: number): FamilyId[] {
  const neutral = state.investors.filter(inv => inv.ownerId === null)
  const pool = neutral.length > 0 ? neutral : state.investors.filter(inv => inv.ownerId !== null && inv.ownerId !== playerId)
  const set = new Set(pool.map(inv => inv.familyId))
  const reclaim = getPlayer(state, playerId)?.reclaim
  if (reclaim && canReclaim(state, playerId, reclaim)) set.add(reclaim)
  return FAMILY_IDS.filter(f => set.has(f))
}

/** 玩家手里的招募牌够不够招某家族 */
export function canAffordRecruit(state: GameState, playerId: number, familyId: FamilyId): boolean {
  const player = getPlayer(state, playerId)
  return !!player && countCards(player.hand, 'RECRUITMENT') >= recruitCost(state, playerId, familyId)
}

/** 独家协议生效中：老板牌 / 旅行牌 / 利空牌不能再打 */
export function isExclusiveLocked(state: GameState): boolean {
  return !!state.negotiation?.exclusive
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

/**
 * 一张牌对持有者的"保留价值"（越低越先弃 / 越适合拿去兑换）：
 * 已关闭家族的家族卡 / 定向旅行牌几乎无用；招募牌凑不成组时价值低；阻止 / 老板牌最珍贵。
 */
export function cardKeepValue(state: GameState, playerId: number, c: InfluenceCard): number {
  const player = getPlayer(state, playerId)
  const recruitCount = player ? countCards(player.hand, 'RECRUITMENT') : 0
  const open = new Set<FamilyId>()
  for (const s of state.board) if (s.closedByTileId == null) for (const g of s.groups) for (const f of g.families) open.add(f)
  switch (c.type) {
    case 'RECRUITMENT': return recruitCount >= RECRUIT_COST || player?.reclaim ? 4 : 1
    case 'CLAN': return c.familyId && open.has(c.familyId) ? 3 : 0
    case 'TRAVEL': return c.familyId ? (open.has(c.familyId) ? 3 : 0) : 5
    case 'SICK': return 4
    case 'BUST': return 4
    case 'BOOM': return 5
    case 'EXCLUSIVE': return 5
    case 'BOSS': return 6
    case 'STOP': return 7
  }
}

// ---------- 桌规（houseRules）：互换 / 买牌 / 兑换 / 病假 ----------

/** 病假中：本回合不能主动出牌（家族 / 旅行 / 招募 / 老板 / 稀有牌 / 病假牌 / 互换 / 兑换），只能被动打阻止牌 */
export function isSick(state: GameState, playerId: number): boolean {
  return state.turn.sick.includes(playerId)
}

/** 病假期间被禁止的动作 */
export const ACTIVE_CARD_ACTIONS: ReadonlySet<PlayerActionType> = new Set<PlayerActionType>([
  'PLAY_CLAN', 'PLAY_TRAVEL', 'PLAY_RECRUITMENT', 'PLAY_BOSS', 'PLAY_BOOM', 'PLAY_BUST', 'PLAY_EXCLUSIVE', 'PLAY_SICK',
  'SWAP_CARD', 'TRADE_CARDS',
])

/** 互换 / 兑换可以发生的阶段：自己回合开单前，或谈判中轮到自己（不含成交倒计时——那里只留干扰牌） */
const EXCHANGE_PHASES: ReadonlySet<GamePhase> = new Set<GamePhase>(['TURN', 'AFTER_MOVE', 'NEGOTIATION'])
export function isExchangePhase(phase: GamePhase): boolean {
  return EXCHANGE_PHASES.has(phase)
}

/** 病假牌可以打出的阶段：开单前（先把危险人物放倒）、谈判中、成交倒计时 */
const SICK_PHASES: ReadonlySet<GamePhase> = new Set<GamePhase>(['TURN', 'AFTER_MOVE', 'NEGOTIATION', 'CLOSING'])
export function isSickPlayPhase(phase: GamePhase): boolean {
  return SICK_PHASES.has(phase)
}

/** 病假牌的可选目标：其他尚未病假的玩家 */
export function sickTargets(state: GameState, playerId: number): number[] {
  return state.players.filter(p => p.id !== playerId && !isSick(state, p.id)).map(p => p.id)
}

/** 抽牌堆 + 弃牌堆里符合条件的牌数（互换 / 兑换要从这里"找"牌） */
export function availableInPiles(state: GameState, pred: (c: InfluenceCard) => boolean): number {
  return state.drawPile.filter(pred).length + state.discardPile.filter(pred).length
}

/** 一张牌互换后的种类：家族成员 → 旅行；定向旅行 → 家族成员；其他不可互换 */
export function swapTargetType(card: InfluenceCard): 'CLAN' | 'TRAVEL' | null {
  if (!card.familyId) return null
  if (card.type === 'CLAN') return 'TRAVEL'
  if (card.type === 'TRAVEL') return 'CLAN'
  return null
}

/**
 * 这张牌现在能否互换：桌规开启、本回合未换过、牌是家族成员 / 定向旅行、
 * 我持有该家族的投资者（"与自己的常驻代表相同的家族"）、牌堆 / 弃牌堆里找得到对应的牌。
 */
export function canSwapCard(state: GameState, playerId: number, card: InfluenceCard): boolean {
  if (!state.houseRules || state.turn.swapped.includes(playerId)) return false
  const to = swapTargetType(card)
  if (!to) return false
  const inv = state.investors.find(i => i.familyId === card.familyId)
  if (!inv || inv.ownerId !== playerId) return false
  return availableInPiles(state, c => c.type === to && c.familyId === card.familyId) > 0
}

export function swappableCards(state: GameState, playerId: number): InfluenceCard[] {
  const player = getPlayer(state, playerId)
  if (!player) return []
  return player.hand.filter(c => canSwapCard(state, playerId, c))
}

/** 当前景气牌股价（买牌 / 兑换的计价单位；不含抢手加成与本笔利好利空） */
export function baseShareValue(state: GameState): number {
  return getCurrentTile(state)?.shareValue ?? 0
}

/** 花钱补 n 张牌的价钱（1 张 1 份、2 张 3 份、3 张 6 份股价） */
export function buyCardsCost(state: GameState, count: number): number {
  const shares = BUY_CARDS_COST_SHARES[count - 1]
  return shares == null ? Infinity : shares * baseShareValue(state)
}

/** 现在能买几张牌（0 = 不能买）：桌规、自己回合开单前、本回合未买过、付得起、不超手牌上限、牌够 */
export function buyableCardCounts(state: GameState, playerId: number): number[] {
  const player = getPlayer(state, playerId)
  if (!player || !state.houseRules || state.turn.bought.includes(playerId)) return []
  if (state.phase !== 'TURN' && state.phase !== 'AFTER_MOVE') return []
  const out: number[] = []
  for (let n = 1; n <= MAX_BUY_CARDS; n++) {
    if (player.hand.length + n > HAND_LIMIT) break
    if (player.cash < buyCardsCost(state, n)) break
    if (state.drawPile.length + state.discardPile.length < n) break
    out.push(n)
  }
  return out
}

/** 兑换招募牌要付的钱（一份股价） */
export function tradeCost(state: GameState): number {
  return TRADE_COST_SHARES * baseShareValue(state)
}

/** 兑换的前提（不含选牌）：桌规、可兑换阶段、本回合未兑换过、付得起、牌堆里还有两张招募牌、手里至少有两种牌 */
export function canTradeCards(state: GameState, playerId: number): boolean {
  const player = getPlayer(state, playerId)
  if (!player || !state.houseRules || state.turn.traded.includes(playerId) || !isExchangePhase(state.phase)) return false
  if (player.cash < tradeCost(state)) return false
  if (availableInPiles(state, c => c.type === 'RECRUITMENT') < TRADE_RECRUIT_COUNT) return false
  return new Set(player.hand.map(c => c.type)).size >= TRADE_GIVE_COUNT
}

/** 这组牌能否作为兑换的"两张不同种类的牌" */
export function isValidTradePair(state: GameState, playerId: number, cardIds: unknown): cardIds is number[] {
  const player = getPlayer(state, playerId)
  if (!player || !Array.isArray(cardIds) || cardIds.length !== TRADE_GIVE_COUNT || new Set(cardIds).size !== TRADE_GIVE_COUNT) return false
  const cards = cardIds.map(id => player.hand.find(c => c.id === id))
  if (cards.some(c => !c)) return false
  return new Set(cards.map(c => c!.type)).size === TRADE_GIVE_COUNT
}

/** 兑换的默认选牌：保留价值最低的两张不同种类的牌（AI 的代表性取值 / 界面的推荐） */
export function defaultTradePair(state: GameState, playerId: number): number[] | null {
  const player = getPlayer(state, playerId)
  if (!player) return null
  const sorted = [...player.hand].sort((a, b) => cardKeepValue(state, playerId, a) - cardKeepValue(state, playerId, b))
  for (const a of sorted) {
    const b = sorted.find(c => c.id !== a.id && c.type !== a.type)
    if (b) return [a.id, b.id]
  }
  return null
}

/** 兑换后手里会有几张招募牌 */
export function recruitCountAfterTrade(state: GameState, playerId: number, cardIds: number[]): number {
  const player = getPlayer(state, playerId)
  if (!player) return 0
  const given = player.hand.filter(c => cardIds.includes(c.id) && c.type === 'RECRUITMENT').length
  return countCards(player.hand, 'RECRUITMENT') - given + TRADE_RECRUIT_COUNT
}

/** 桌上是否有人病假（座位徽标 / 提示用） */
export function sickPlayerIds(state: GameState): number[] {
  return [...state.turn.sick]
}
