// ============================================================
// 启发式策略 — 不依赖 LLM，任何局面都能立刻给出合法动作。
// 既是"无 LLM"模式下的电脑玩家，也是 LLM 失败 / 超时时的兜底，
// 还作为 LLM 提示词里的"默认建议"（基线）。
// 决策只依赖状态（随机数由 stateVersion 派生），仿真可复现。
//
// 博弈直觉（和真实桌面一致）：
//   · 报价即承诺：先叫价，价格围绕一份分红；唯一代表抬价，有竞争者压价
//   · Boss 先用自己的家族卡省钱，再贴着对方承诺价付；别为几块钱流局
//   · 搅局只在被排除 / 分得太少且交易值钱时；记仇者对搅过自己的人加倍
//   · 终局：领先者盼成交（骰子可能直接赢），落后者拦领先者的单
// ============================================================

import type { GameState, PlayerAction, FamilyId, BoardSpace, Representative } from '../engine/types'
import { FAMILIES, MAX_OFFERS_PER_BOSS } from '../engine/config'
import {
  getPlayer, getCurrentSpace, getGrossValue, oneShareOf, spaceInvestorCount,
  selectReps, tableCanComplete, canCompleteAlone, playerCoverableFamilies, playerActiveFamilies,
  activeRepsOfFamily, findRep, offerShareOf, offerOwners, repCost, payoutTotal, repsUsedOf,
  familyDemandOnBoard, groupOfFamily, soleRepFamilies, leaderIds, endChance, grudgeCount, meetsCommitment,
  commitmentPrice, repPriceOf, hasDemand,
} from '../engine/rules'
import { getActingPlayerId, getLegalActions, isLegal, buildOfferCandidates, canClose, type OfferCandidate } from '../engine/validator'
import type { Policy } from './policy'

interface PersonaParams {
  /** 要价倍率（相对一份分红） */
  askMult: number
  /** 接受阈值倍率（相对自己的要价） */
  acceptMult: number
  /** 搅局倾向 0~1 */
  disrupt: number
  /** 用阻止牌保护自身利益的倾向 0~1 */
  protect: number
  /** 是否会索要封口费 */
  bribe: boolean
  /** 当 Boss 时先压价试探的倾向 0~1 */
  haggle: number
  /** 记仇权重：对搅过自己的人加倍搅回去 */
  grudge: number
  /** 虚张声势倾向 0~1（没牌也放狠话） */
  bluff: number
}

// 平衡目标：各人格胜率相近（仿真 400 局内差距 < 1.5 倍），风格不同但都能赢。
//   steady 是"公道但不好欺负"：要价一份、基本不让、少搅局；不是随便压价都点头的软柿子。
export const PERSONA_PARAMS: Record<string, PersonaParams> = {
  greedy: { askMult: 1.4, acceptMult: 0.9, disrupt: 0.55, protect: 0.7, bribe: true, haggle: 0.6, grudge: 0.2, bluff: 0.4 },
  grudge: { askMult: 1.1, acceptMult: 1.0, disrupt: 0.75, protect: 0.6, bribe: true, haggle: 0.3, grudge: 0.8, bluff: 0.3 },
  steady: { askMult: 1.0, acceptMult: 0.95, disrupt: 0.5, protect: 0.85, bribe: false, haggle: 0.25, grudge: 0.2, bluff: 0.1 },
  smile: { askMult: 1.2, acceptMult: 0.9, disrupt: 0.55, protect: 0.7, bribe: true, haggle: 0.5, grudge: 0.3, bluff: 0.6 },
  stingy: { askMult: 1.3, acceptMult: 0.9, disrupt: 0.55, protect: 0.5, bribe: true, haggle: 0.7, grudge: 0.3, bluff: 0.3 },
}

function persona(state: GameState, id: number): PersonaParams {
  return PERSONA_PARAMS[getPlayer(state, id)?.personaId ?? 'steady'] ?? PERSONA_PARAMS.steady
}

/** 由状态版本派生的可复现伪随机数 */
function rand(state: GameState, salt: number): number {
  let h = (state.stateVersion * 2654435761 + salt * 40503 + state.rng) >>> 0
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b); h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

const pick = <T,>(arr: T[], r: number) => arr[Math.floor(r * arr.length)]
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))

/**
 * 当前行动者的启发式动作（含台词）。没有行动者或没有合法动作时返回 null。
 * 结果一定通过 isLegal：决策若产生非法动作，退回合法列表的第一项。
 */
export function heuristicAction(state: GameState): PlayerAction | null {
  const id = getActingPlayerId(state)
  if (id < 0) return null
  const legal = getLegalActions(state, id)
  if (legal.length === 0) return null
  const decided = decide(state, id, legal)
  const action = decided && isLegal(state, decided) ? decided : legal[0]
  return action.say ? action : { ...action, say: heuristicSpeech(state, action) || undefined }
}

export const heuristicPolicy: Policy = {
  name: 'heuristic',
  decide: async state => heuristicAction(state),
}

function decide(state: GameState, id: number, legal: PlayerAction[]): PlayerAction | null {
  switch (state.phase) {
    case 'PLACE_MARKER': return placeMarker(state, id, legal)
    case 'TURN': return wantsToOpen(state, id, false) ? { type: 'OPEN_DEAL', playerId: id } : { type: 'ROLL_MOVE', playerId: id }
    case 'AFTER_MOVE': return wantsToOpen(state, id, true) ? { type: 'OPEN_DEAL', playerId: id } : { type: 'DRAW_CARDS', playerId: id }
    case 'HAND_LIMIT': return handLimit(state, id, legal)
    case 'NEGOTIATION': return state.negotiation!.bossId === id ? bossTurn(state, id, legal) : otherTurn(state, id, legal)
    case 'OFFER_RESPONSE': return respond(state, id)
    case 'REACTION': return reaction(state, id, legal)
    case 'CLOSING': return closing(state, id, legal)
    case 'END_ROLL': return { type: 'ROLL_END', playerId: id }
    default: return legal[0] ?? null
  }
}

// ---------- 局势 ----------

interface Stance {
  /** 本笔成交后游戏结束的概率 */
  end: number
  /** 我是否现金领先（含并列） */
  iAmLeader: boolean
  /** Boss 是否领先且我落后于他 */
  bossIsLeader: boolean
  /** 我落后于领先的 Boss，且成交可能直接终局 → 拦 */
  blockLeader: boolean
  /** 若本笔按当前方案成交，是否有人会反超我 */
  wouldOvertake: boolean
}

function stance(state: GameState, id: number): Stance {
  const neg = state.negotiation
  const end = endChance(state)
  const leaders = leaderIds(state)
  const me = getPlayer(state, id)!
  const iAmLeader = leaders.includes(id)
  const bossIsLeader = !!neg && leaders.includes(neg.bossId) && neg.bossId !== id && !iAmLeader
  let wouldOvertake = false
  if (neg) {
    const gross = getGrossValue(state)
    const paid = neg.offer ? payoutTotal(neg.offer.payouts) : 0
    for (const q of state.players) {
      if (q.id === id) continue
      const gain = q.id === neg.bossId ? gross - paid : offerShareOf(neg.offer, q.id)
      if (q.cash + gain > me.cash + offerShareOf(neg.offer, id)) { wouldOvertake = true; break }
    }
  }
  return { end, iAmLeader, bossIsLeader, blockLeader: bossIsLeader && end > 0, wouldOvertake }
}

// ---------- 回合决策 ----------

function placeMarker(state: GameState, id: number, legal: PlayerAction[]): PlayerAction {
  const starter = state.currentId
  let best: PlayerAction | null = null
  let bestScore = -Infinity
  for (const a of legal) {
    if (a.type !== 'PLACE_MARKER') continue
    const space = state.board.find(s => s.id === a.spaceId)!
    const mine = canCompleteAlone(state, id, space) ? space.dividends : 0
    const theirs = canCompleteAlone(state, starter, space) ? space.dividends : 0
    const score = mine * 2 - theirs * 3 - space.dividends * 0.1 + rand(state, space.id) * 0.5
    if (score > bestScore) { bestScore = score; best = a }
  }
  return best ?? legal[0]
}

/** 评估当前格：估算自己当 Boss 需要向别人买几个代表 */
export function estimateDeal(state: GameState, id: number, space: BoardSpace): { feasible: boolean; buyCount: number } {
  const mine = playerCoverableFamilies(state, id)
  const owned = new Map<FamilyId, number | null>()
  for (const inv of state.investors) owned.set(inv.familyId, inv.ownerId)
  let buy = 0
  for (const g of space.groups) {
    const free = g.families.filter(f => mine.has(f)).length
    const buyable = g.families.filter(f => !mine.has(f) && owned.get(f) != null).length
    const need = Math.max(0, g.need - free)
    if (need > buyable) return { feasible: false, buyCount: 0 }
    buy += need
  }
  return { feasible: true, buyCount: buy }
}

function wantsToOpen(state: GameState, id: number, afterMove: boolean): boolean {
  const space = getCurrentSpace(state)
  if (!space) return false
  const gross = getGrossValue(state)
  const share = Math.max(1, Math.round(gross / (spaceInvestorCount(space) + 1)))
  const hand = getPlayer(state, id)!.hand.length
  const est = estimateDeal(state, id, space)
  if (!est.feasible) return false
  const expectedProfit = gross - est.buyCount * share * 1.2
  const end = endChance(state)
  const leader = leaderIds(state).includes(id)
  // 终局：领先者只要有得赚就想开单（成交后掷骰可能直接赢）
  const minProfit = leader && end > 0 ? 1 : Math.max(4, gross * 0.3)
  if (afterMove && hand <= 4 && expectedProfit < gross * 0.6 && !(leader && end > 0)) return false // 手牌太少先补牌
  if (est.buyCount === 0) return true
  return expectedProfit >= minProfit && rand(state, 7) < 0.85
}

function handLimit(state: GameState, id: number, legal: PlayerAction[]): PlayerAction {
  return bestRecruit(state, id, legal) ?? legal.find(a => a.type === 'DISCARD') ?? legal[0]
}

function bestRecruit(state: GameState, id: number, legal: PlayerAction[]): PlayerAction | null {
  const options = legal.filter(a => a.type === 'PLAY_RECRUITMENT')
  if (options.length === 0) return null
  const freq = familyDemandOnBoard(state)
  const richest = [...state.players].sort((a, b) => b.cash - a.cash)[0]
  const neg = state.negotiation
  let best: PlayerAction | null = null
  let bestScore = -Infinity
  for (const a of options) {
    if (a.type !== 'PLAY_RECRUITMENT') continue
    const f = a.targetFamilyId
    const owner = state.investors.find(i => i.familyId === f)?.ownerId
    let score = freq[f] * 2
    if (owner === richest.id && owner !== id) score += 1.5
    if (neg && groupOfFamily(getCurrentSpace(state)!, f)) score += 2
    if (neg?.offer?.repKeys.includes(`INV:${f}`) && offerShareOf(neg.offer, id) === 0) score += 2 // 顺手掀了排除我的方案
    if (score > bestScore) { bestScore = score; best = a }
  }
  return best
}

// ---------- Boss ----------

/** 用自己的家族卡替代别人要钱的代表能省多少（模拟加入该卡后的最省方案） */
function clanSavings(state: GameState, id: number, f: FamilyId): number {
  const neg = state.negotiation!
  const costOf = (st: GameState, keys: string[]) =>
    keys.reduce((sum, k) => { const r = findRep(st.negotiation!, k); return sum + (r ? repCost(st, r) : 0) }, 0)
  const before = selectReps(state)
  if (!before.complete) return 0
  const fake: Representative = { key: 'CLAN:hypothetical', familyId: f, source: 'CLAN', ownerId: id, travelled: false }
  const hypo: GameState = { ...state, negotiation: { ...neg, reps: [...neg.reps, fake] } }
  const after = selectReps(hypo)
  return costOf(state, before.repKeys) - costOf(hypo, after.repKeys)
}

function bossTurn(state: GameState, id: number, legal: PlayerAction[]): PlayerAction {
  const neg = state.negotiation!
  const gross = getGrossValue(state)
  const share = oneShareOf(state)
  const p = persona(state, id)
  const st = stance(state, id)

  if (canClose(state)) return { type: 'CLOSE_DEAL', playerId: id }

  if (!tableCanComplete(state)) {
    const space = getCurrentSpace(state)!
    const clan = legal.find(a => a.type === 'PLAY_CLAN' && isFamilyMissing(state, cardFamily(state, id, a.cardId)))
    if (clan) return clan
    const recruit = legal.find(a => a.type === 'PLAY_RECRUITMENT' && isFamilyMissing(state, a.targetFamilyId) && groupOfFamily(space, a.targetFamilyId))
    if (recruit) return recruit
    // 给别人一轮机会打家族卡；再没进展就放弃
    if (neg.stalemateRounds === 0 && neg.passStreak < state.players.length - 1) return { type: 'PASS', playerId: id }
    return { type: 'ABANDON_DEAL', playerId: id }
  }

  // 自己有家族卡就别花钱买别人的代表：省下的钱 ≥ 大半份分红就打
  for (const a of legal) {
    if (a.type !== 'PLAY_CLAN') continue
    const f = cardFamily(state, id, a.cardId)
    if (f && clanSavings(state, id, f) >= Math.max(1, Math.round(share * 0.75))) {
      return { ...a, say: pick([`${FAMILIES[f].name}我自己有人，不劳各位。`, `这家我不用买，自己人。`], rand(state, 47)) }
    }
  }

  if (neg.offersMade >= MAX_OFFERS_PER_BOSS) return { type: 'ABANDON_DEAL', playerId: id }
  const candidates = buildOfferCandidates(state)
  if (candidates.length === 0) return { type: 'ABANDON_DEAL', playerId: id }

  // 预测每个方案会不会被接受：有承诺价的付到即成（按所用代表、各家族报价累计）；没报价的按其人格心理价估
  const willAccept = (owner: number, got: number, repKeys: string[]) => {
    const committed = commitmentPrice(neg, { repKeys }, owner)
    if (committed != null) return got >= committed
    const used = Math.max(1, repsUsedOf(neg, { repKeys }, owner))
    const q = persona(state, owner)
    return got >= Math.max(1, Math.round(share * q.askMult * q.acceptMult * 0.95)) * used
  }
  // 终局领先：赶紧成交比多赚几块钱重要
  const minKeep = st.iAmLeader && st.end > 0
    ? Math.max(1, Math.round(share * (1 - st.end)))
    : Math.max(share, Math.round(gross * 0.3))
  // 方案价值 = 我净得 − 终局阶段"送给成交后会压过我的人"的钱（帮对手赢的钱按终局概率加倍算亏）
  const me = getPlayer(state, id)!
  const value = (c: OfferCandidate) => {
    let v = c.bossKeep
    if (st.end > 0) {
      const myAfter = me.cash + c.bossKeep
      for (const pay of c.payouts) {
        const q = getPlayer(state, pay.playerId)
        if (q && q.cash + pay.amount > myAfter) v -= pay.amount * (0.5 + st.end)
      }
    }
    return v
  }
  const scored = candidates.map(c => ({
    c,
    okAll: offerOwners(neg, c).every(o => willAccept(o, c.payouts.find(x => x.playerId === o)?.amount ?? 0, c.repKeys)),
    keep: c.bossKeep,
    value: value(c),
  }))
  const byValue = (a: { value: number }, b: { value: number }) => b.value - a.value
  const acceptable = scored.filter(x => x.okAll && x.keep >= Math.min(minKeep, gross - 1)).sort(byValue)

  // 首次提案：会压价的人格先试探一手（对方要么接受要么反报价，下轮再照价付）
  if (neg.offersMade === 0 && !(st.iAmLeader && st.end > 0)) {
    const haggle = scored.find(x => x.c.key === 'haggle')
    const best = acceptable[0]
    if (haggle && best && haggle.value > best.value && rand(state, 53) < p.haggle) {
      return { type: 'PROPOSE_OFFER', playerId: id, repKeys: haggle.c.repKeys, payouts: haggle.c.payouts }
    }
  }

  const choice = acceptable[0]
    ?? (neg.offersMade === 0 ? scored.sort(byValue).find(x => x.keep >= minKeep) : null)
    // 最后一次机会：只要还有得赚就照单全付
    ?? (neg.offersMade < MAX_OFFERS_PER_BOSS - 1 ? scored.filter(x => x.okAll && x.keep >= 1).sort(byValue)[0] : null)
  if (!choice) return { type: 'ABANDON_DEAL', playerId: id }
  // 终局：这单只会把对手送上领先位 → 宁可流局
  if (choice.value <= 0 && st.end > 0) {
    return { type: 'ABANDON_DEAL', playerId: id, say: pick(['这单便宜的是别人，我不做。', '给你们抬轿子？算了，流了。'], rand(state, 61)) }
  }
  return { type: 'PROPOSE_OFFER', playerId: id, repKeys: choice.c.repKeys, payouts: choice.c.payouts }
}

function cardFamily(state: GameState, id: number, cardId: number): FamilyId | undefined {
  return getPlayer(state, id)?.hand.find(c => c.id === cardId)?.familyId
}

/** 该家族所在需求组当前是否还缺人（且该家族尚无有效代表） */
function isFamilyMissing(state: GameState, f: FamilyId | undefined): boolean {
  const neg = state.negotiation
  const space = getCurrentSpace(state)
  if (!neg || !space || !f) return false
  const g = groupOfFamily(space, f)
  if (!g) return false
  if (activeRepsOfFamily(neg, f).length > 0) return false
  const have = g.families.filter(x => activeRepsOfFamily(neg, x).length > 0).length
  return have < g.need
}

// ---------- 非 Boss ----------

/** 我的出借价：一份分红 × 人格倍率 × 杠杆 × 终局因素，且不高于对手的竞争价 */
export function askPrice(state: GameState, id: number, family?: FamilyId): number {
  const neg = state.negotiation!
  const space = getCurrentSpace(state)!
  const share = oneShareOf(state)
  const p = persona(state, id)
  const st = stance(state, id)
  const mine = family ? [family] : [...playerActiveFamilies(neg, id)].filter(f => groupOfFamily(space, f))
  const sole = new Set(soleRepFamilies(state, id))
  let mult = p.askMult
  if (mine.some(f => sole.has(f))) mult *= 1.4                  // 没我凑不齐：抬价
  if (st.blockLeader) mult *= 1 + st.end                        // 落后于领先的 Boss：不便宜给
  if (st.iAmLeader && st.end > 0) mult *= 0.85                  // 我领先：让交易快点成
  let ask = Math.round(share * mult)
  // 有竞争者且我不是唯一：得比对手便宜才会被选
  for (const f of mine) {
    if (sole.has(f)) continue
    const rivals = activeRepsOfFamily(neg, f).filter(r => r.ownerId !== id && r.ownerId !== neg.bossId)
    if (rivals.length === 0) continue
    const rivalMin = Math.min(...rivals.map(r => repPriceOf(neg, r) ?? share))
    ask = Math.min(ask, Math.max(1, rivalMin - 1))
  }
  const gross = getGrossValue(state)
  return clamp(ask, 1, Math.max(1, gross - 1))
}

function canCompleteAsBoss(state: GameState, id: number): boolean {
  return selectReps(state, { preferOwner: id }).complete
}

function myRepUsed(state: GameState, id: number): boolean {
  const neg = state.negotiation!
  return !!neg.offer && neg.offer.repKeys.some(k => findRep(neg, k)?.ownerId === id)
}

/** 我当 Boss 时要付多少钱（0 = 全用自己的人） */
function myBossCost(state: GameState, id: number): number {
  const sel = selectReps(state, { preferOwner: id })
  if (!sel.complete) return Infinity
  const neg = state.negotiation!
  // 以"我当 Boss"视角估价：现任 Boss 的代表对我来说不是免费的
  return sel.repKeys.reduce((sum, k) => sum + repCost(state, findRep(neg, k)!, id), 0)
}

function disruptChance(state: GameState, id: number, base: number): number {
  const neg = state.negotiation!
  const p = persona(state, id)
  const st = stance(state, id)
  let chance = base * p.disrupt
  if (st.bossIsLeader) chance *= 1.3
  if (st.blockLeader) chance *= 1 + st.end
  if (st.iAmLeader && st.end > 0 && !st.wouldOvertake) chance *= 0.1 // 成交可能让我直接赢：别拦
  chance *= 1 + p.grudge * Math.min(2, grudgeCount(state, id, neg.bossId))
  return chance
}

function otherTurn(state: GameState, id: number, legal: PlayerAction[]): PlayerAction {
  const neg = state.negotiation!
  const space = getCurrentSpace(state)!
  const gross = getGrossValue(state)
  const share = oneShareOf(state)
  const p = persona(state, id)
  const st = stance(state, id)
  const myShare = offerShareOf(neg.offer, id)
  const mine = playerActiveFamilies(neg, id)
  const relevantMine = [...mine].filter(f => groupOfFamily(space, f))
  const excluded = neg.offer ? !myRepUsed(state, id) && myShare === 0 : false
  const underpaid = neg.offer ? myShare < (commitmentPrice(neg, neg.offer, id) ?? share * Math.max(1, repsUsedOf(neg, neg.offer, id))) : false

  // 1. 夺权：交易值钱、我当 Boss 也能凑齐，且（被排除/分太少 | 我不用花钱就能独吞 | 拦领先者的终局单）
  const bossOpt = legal.find(a => a.type === 'PLAY_BOSS')
  if (bossOpt && gross >= 9 && canCompleteAsBoss(state, id)) {
    const cost = myBossCost(state, id)
    const strong = !neg.offer && cost <= share && gross - cost >= gross * 0.6
    const reason = (neg.offer && (excluded || underpaid)) || strong || st.blockLeader
    if (reason && rand(state, 11) < disruptChance(state, id, 0.45) + (strong ? 0.25 : 0) + (st.blockLeader ? 0.3 * st.end : 0)) return bossOpt
  }

  // 2. 打家族卡：补缺口（能拿钱），或与竞争者抢单
  //    抢单只在"我在这一组里没有自己的席位"时才值得：已有相关代表就先叫价，别白扔一张卡
  for (const a of legal) {
    if (a.type !== 'PLAY_CLAN') continue
    const f = cardFamily(state, id, a.cardId)!
    if (isFamilyMissing(state, f)) {
      const ask = askPrice(state, id, f)
      return { ...a, demand: ask, say: pick([`${FAMILIES[f].name}的人我有，$${ask}M 就出场。`, `缺${FAMILIES[f].name}？我这儿有，$${ask}M。`], rand(state, 59)) }
    }
    const g = groupOfFamily(space, f)
    const seatedInGroup = !!g && relevantMine.some(x => g.families.includes(x))
    const rivals = activeRepsOfFamily(neg, f).filter(r => r.ownerId !== id && r.ownerId !== neg.bossId)
    if (rivals.length > 0 && !seatedInGroup && !myRepUsed(state, id) && gross >= 8 && rand(state, 13) < 0.5) {
      const rivalMin = Math.min(...rivals.map(r => repPriceOf(neg, r) ?? share))
      const undercut = Math.max(1, Math.min(rivalMin - 1, askPrice(state, id, f)))
      return { ...a, demand: undercut, say: `别找他，我的${FAMILIES[f].name}只要 $${undercut}M。` }
    }
  }

  // 3. 叫价：有相关代表但还没开价的家族 → 报承诺价。
  //    每个家族按各自筹码定价（唯一代表抬价、有竞争者压价）；各家同价就一句话报完，不同价则先报最值钱的那家
  const canSpeak = legal.some(a => a.type === 'SPEAK')
  const unpriced = relevantMine.filter(f => repPriceOf(neg, { ownerId: id, familyId: f } as Representative) == null)
  if (canSpeak && unpriced.length > 0) {
    const priced = unpriced.map(f => ({ f, ask: askPrice(state, id, f) })).sort((a, b) => b.ask - a.ask)
    const allSame = priced.every(x => x.ask === priced[0].ask)
    const batch = allSame ? priced : [priced[0]]
    const ask = batch[0].ask
    const fam = batch.map(x => FAMILIES[x.f].name).join('/')
    const soleSet = new Set(soleRepFamilies(state, id))
    const sole = batch.some(x => soleSet.has(x.f))
    const say = sole
      ? pick([`没我的${fam}这单做不成，$${ask}M。`, `${fam}只有我有，$${ask}M，不二价。`], rand(state, 17))
      : pick([`想用我的${fam}？$${ask}M，一口价。`, `${fam}这边可以谈，我要 $${ask}M。`, `$${ask}M，付到就成。`], rand(state, 17))
    // 一句话报完所有家族：不指定 demandFamily（引擎按本格相关代表全部记价）；只报一家则指定
    return allSame && batch.length === relevantMine.length
      ? { type: 'SPEAK', playerId: id, say, demand: ask }
      : { type: 'SPEAK', playerId: id, say, demand: ask, demandFamily: batch[0].f }
  }

  // 3b. 被竞争者顶掉：主动降价抢回来（一次），只降被顶掉的那一家的价
  if (canSpeak && neg.offer && excluded && relevantMine.length > 0 && rand(state, 61) < 0.6) {
    for (const f of relevantMine) {
      const chosen = neg.offer.repKeys.map(k => findRep(neg, k)).find(r => r?.familyId === f && r.ownerId !== id && r.ownerId !== neg.bossId)
      if (!chosen) continue
      const myAsk = repPriceOf(neg, { ownerId: id, familyId: f } as Representative)
      const rivalPrice = repPriceOf(neg, chosen) ?? Math.max(1, Math.floor(offerShareOf(neg.offer, chosen.ownerId) / Math.max(1, repsUsedOf(neg, neg.offer, chosen.ownerId))))
      const cut = Math.max(1, rivalPrice - 1)
      if (myAsk == null || cut < myAsk) {
        return { type: 'SPEAK', playerId: id, say: `Boss，换我的${FAMILIES[f].name}，$${cut}M 就行，比他便宜。`, demand: cut, demandFamily: f }
      }
    }
  }

  // 4. 被排除 / 没份：搅局
  if ((excluded || (relevantMine.length === 0 && myShare === 0)) && gross >= 8) {
    if (rand(state, 19) < disruptChance(state, id, neg.offer ? 1 : 0.5)) {
      const travel = bestTravel(state, id, legal)
      if (travel) return travel
    }
  }

  // 5. 招募：长期资产，手里有三连就找机会用
  const recruit = bestRecruit(state, id, legal)
  if (recruit && rand(state, 23) < 0.7) return recruit

  // 6. 封口费：没代表也想分一口
  if (canSpeak && relevantMine.length === 0 && !hasDemand(neg, id) && p.bribe && gross >= 12 && rand(state, 29) < 0.4) {
    const ask = Math.max(1, Math.round(share * 0.5))
    const say = pick([`我手里有牌，$${ask}M 买个安静怎么样？`, `分我 $${ask}M，我保证不捣乱。`], rand(state, 31))
    return { type: 'SPEAK', playerId: id, say, demand: ask }
  }

  // 7. 跳过（被排除时偶尔放狠话——有牌是威胁，没牌是虚张声势）
  const hasTeeth = getPlayer(state, id)!.hand.some(c => c.type === 'BOSS' || c.type === 'TRAVEL')
  if ((excluded || (relevantMine.length === 0 && myShare === 0)) && gross >= 8 && rand(state, 67) < (hasTeeth ? 0.35 : p.bluff * 0.5)) {
    const say = neg.offer
      ? pick(['方案里没我的份？Boss 你可想清楚了。', '我手里的牌可不是摆设。', '不带我玩，这单怕是成不了。'], rand(state, 71))
      : pick(['这单没我的事？那我就看看热闹——手里的牌可不是摆设。', '各位慢慢谈，别忘了桌上还有我。', '不带我玩也行，就怕这单成不了。'], rand(state, 71))
    return { type: 'PASS', playerId: id, say }
  }
  return { type: 'PASS', playerId: id }
}

/** 挑一张最值得打的旅行牌：优先打方案里"顶掉我"的竞争代表，其次打 Boss 的关键代表 */
function bestTravel(state: GameState, id: number, legal: PlayerAction[]): PlayerAction | null {
  const neg = state.negotiation!
  const mine = playerActiveFamilies(neg, id)
  const coverable = playerCoverableFamilies(state, id)
  let best: PlayerAction | null = null
  let bestScore = 0
  for (const a of legal) {
    if (a.type !== 'PLAY_TRAVEL') continue
    const rep = findRep(neg, a.targetRepKey)!
    if (rep.ownerId === id) continue
    let score = 0
    const inOffer = !!neg.offer?.repKeys.includes(rep.key)
    if (inOffer) score += 2
    if (mine.has(rep.familyId) || coverable.has(rep.familyId)) score += 3 // 打掉后我成为唯一选择
    if (rep.ownerId === neg.bossId) score += 1
    const others = activeRepsOfFamily(neg, rep.familyId).filter(r => r.key !== rep.key && r.ownerId !== id).length
    if (others === 0 && !coverable.has(rep.familyId)) score += 0.5 // 直接让交易难产
    if (score > bestScore) { bestScore = score; best = a }
  }
  return bestScore >= 2 ? best : null
}

// ---------- 应答 / 反应 / 倒计时 ----------

function respond(state: GameState, id: number): PlayerAction {
  const neg = state.negotiation!
  const p = persona(state, id)
  const st = stance(state, id)
  const share = oneShareOf(state)
  const myShare = offerShareOf(neg.offer, id)
  const used = Math.max(1, repsUsedOf(neg, neg.offer!, id))
  // 我对这份方案的承诺价（各家族报价累计）；没报过就按人格心理价
  const committed = commitmentPrice(neg, neg.offer!, id)
  const myAsk = committed != null ? committed / used : Math.round(share * p.askMult)
  let threshold = Math.max(1, Math.round(myAsk * p.acceptMult)) * used
  if (st.blockLeader) threshold = Math.round(threshold * (1 + st.end))
  if (st.iAmLeader && st.end > 0 && !st.wouldOvertake) threshold = 1 // 成交就可能赢：给钱就点头
  if (myShare >= threshold) return { type: 'ACCEPT_OFFER', playerId: id }
  if (neg.offersMade >= MAX_OFFERS_PER_BOSS - 1 && myShare >= Math.max(1, Math.round(share * 0.5)) * used) return { type: 'ACCEPT_OFFER', playerId: id }
  // 反报价是每个代表的出借价
  const counter = Math.max(Math.ceil(threshold / used), Math.floor(myShare / used) + 1)
  return { type: 'DECLINE_OFFER', playerId: id, counter: Math.min(counter, Math.max(1, Math.floor((getGrossValue(state) - 1) / used))) }
}

function reaction(state: GameState, id: number, legal: PlayerAction[]): PlayerAction {
  const pr = state.pendingReaction!
  const neg = state.negotiation
  const p = persona(state, id)
  const stop = legal.find(a => a.type === 'PLAY_STOP')
  const pass: PlayerAction = { type: 'PASS_REACTION', playerId: id }
  if (!stop) return pass
  const gross = getGrossValue(state)
  const myShare = offerShareOf(neg?.offer, id)
  const iAmBoss = neg?.bossId === id
  const st = stance(state, id)
  const r = rand(state, 37)

  if (pr.kind === 'TRAVEL' && neg) {
    const rep = findRep(neg, pr.targetRepKey!)
    if (!rep) return pass
    const inOffer = !!neg.offer?.repKeys.includes(rep.key)
    if (rep.ownerId === id && (inOffer || repPriceOf(neg, rep) != null)) return r < p.protect ? stop : pass
    if (iAmBoss && inOffer && canClose(state)) return r < p.protect + 0.1 ? stop : pass
    if (myShare > 0 && inOffer) return r < p.protect * 0.8 ? stop : pass
    if (inOffer && st.iAmLeader && st.end > 0 && !st.wouldOvertake) return r < p.protect ? stop : pass // 保住可能让我赢的成交
    return pass
  }
  if (pr.kind === 'BOSS' && neg) {
    if (iAmBoss) return r < (tableCanComplete(state) ? 0.9 : 0.6) ? stop : pass
    if (myShare > 0) return r < p.protect * 0.6 ? stop : pass
    return pass
  }
  if (pr.kind === 'RECRUITMENT') {
    const inv = state.investors.find(i => i.familyId === pr.targetFamilyId)
    if (inv?.ownerId === id) return r < 0.95 ? stop : pass
    const actor = getPlayer(state, pr.actorId)!
    const richest = [...state.players].sort((a, b) => b.cash - a.cash)[0]
    if (actor.id === richest.id && gross >= 12 && r < 0.3) return stop
  }
  return pass
}

function closing(state: GameState, id: number, legal: PlayerAction[]): PlayerAction {
  const neg = state.negotiation!
  const gross = getGrossValue(state)
  const myShare = offerShareOf(neg.offer, id)
  const pass: PlayerAction = { type: 'PASS_CLOSING', playerId: id }
  if (myShare > 0) return pass
  const chance = disruptChance(state, id, gross >= 12 ? 0.8 : 0.5)
  const r = rand(state, 41)

  const bossOpt = legal.find(a => a.type === 'PLAY_BOSS')
  if (bossOpt && gross >= 9 && canCompleteAsBoss(state, id) && r < chance) return bossOpt
  if (r < chance) {
    const travel = bestTravel(state, id, legal)
    if (travel) return travel
    const recruit = legal.find(a => a.type === 'PLAY_RECRUITMENT' && neg.offer?.repKeys.includes(`INV:${a.targetFamilyId}`))
    if (recruit) return recruit
  }
  return pass
}

// ---------- 台词 ----------

/** 启发式玩家的随口台词；空串表示沉默 */
export function heuristicSpeech(state: GameState, action: PlayerAction): string {
  const r = rand(state, 43)
  const neg = state.negotiation
  switch (action.type) {
    case 'OPEN_DEAL': {
      const space = getCurrentSpace(state)
      if (!space) return ''
      const est = estimateDeal(state, action.playerId, space)
      if (est.buyCount === 0) return pick(['这单我自己就能凑齐，各位看着就行。', '我的人够了，这笔我做。'], r)
      const need = missingForBoss(state, action.playerId, space)
      const fams = need.map(f => FAMILIES[f].name).join('、')
      return pick([`这单我做。缺${fams}，谁出人？开个价。`, `Let's make a deal！${fams}那边的人，报个价。`, `我当 Boss。要${fams}，价钱好说。`], r)
    }
    case 'PLAY_BOSS': return pick(['I\'m the Boss！这单换我做主。', '让一让，现在我是老板。'], r)
    case 'PLAY_TRAVEL': return pick(['不好意思，有人得出个差。', '这位投资人临时有事，走不开。'], r)
    case 'PLAY_RECRUITMENT': return pick(['来，这位投资人跟我走。', '挖个人，不介意吧？'], r)
    case 'PLAY_STOP': return pick(['想都别想！', '这招对我没用。'], r)
    case 'ACCEPT_OFFER': return pick(['成交，我同意出人。', '这个价可以，合作愉快。'], r)
    case 'DECLINE_OFFER': return action.counter != null ? pick([`这价不行，$${action.counter}M 才谈。`, `加到 $${action.counter}M 我就点头。`], r) : '这价钱我不干。'
    case 'CLOSE_DEAL': return pick(['Going once, going twice… 成交！', '没人有意见？那就这么定了。'], r)
    case 'ABANDON_DEAL': return pick(['算了，这单不做了。', '要价太狠，我不玩了。'], r)
    case 'PROPOSE_OFFER': {
      if (!neg) return ''
      const paid = action.payouts.filter(p => p.amount > 0)
      const owners = offerOwners(neg, action)
      if (owners.length === 0) return pick(['全是我自己的人，钱我拿。', '方案在这，不用别人。'], r)
      if (paid.length === 0) {
        const names = owners.map(o => getPlayer(state, o)?.name).join('、')
        return pick([`${names}，这单利薄，帮个忙白出个人？`, `${names} 先把人借我，这回不算钱，下回补上。`], r)
      }
      const parts = paid.map(p => `${getPlayer(state, p.playerId)?.name} $${p.amount}M`).join('、')
      const lowball = offerOwners(neg, action).some(o => { const ask = commitmentPrice(neg, action, o); return ask != null && (action.payouts.find(x => x.playerId === o)?.amount ?? 0) < ask })
      return lowball
        ? pick([`${parts}——别嫌少，市面就这价。`, `我出 ${parts}，行就点头。`], r)
        : pick([`${parts}，按各位说的价。`, `方案：${parts}，成不成？`], r)
    }
    case 'PASS':
      if (neg?.bossId === action.playerId) return pick(['还有人要报价吗？', '再听听，谁的价格合适。'], r) 
      return ''
    case 'PASS_CLOSING':
      return neg && offerShareOf(neg.offer, action.playerId) > 0 && r < 0.4 ? pick(['拿钱走人，成交。', '这单我没意见。'], r) : ''
    default: return ''
  }
}

/** 开单时 Boss 自己（投资者 + 手中家族卡）凑不齐的家族 */
function missingForBoss(state: GameState, id: number, space: BoardSpace): FamilyId[] {
  const mine = playerCoverableFamilies(state, id)
  const out: FamilyId[] = []
  for (const g of space.groups) {
    const have = g.families.filter(f => mine.has(f)).length
    if (have >= g.need) continue
    for (const f of g.families) if (!mine.has(f)) out.push(f)
  }
  return out
}

/** 供 LLM 提示词使用：解释启发式为什么给出这个建议 */
export function explainSuggestion(state: GameState, action: PlayerAction): string {
  const neg = state.negotiation
  const id = action.playerId
  switch (action.type) {
    case 'CLOSE_DEAL': return '方案已获全员同意，立刻落锤，拖下去只会多给别人出牌机会'
    case 'PROPOSE_OFFER': {
      const owners = neg ? offerOwners(neg, action) : []
      if (owners.length === 0) return '全用自己的代表，无需任何人同意'
      const auto = owners.filter(o => meetsCommitment(neg!, action, o))
      const avoided = endChance(state) > 0 ? leaderIds(state).filter(l => l !== id && !owners.includes(l) && [...playerActiveFamilies(neg!, l)].length > 0) : []
      const tail = avoided.length ? `；绕开了领先者 ${avoided.map(l => getPlayer(state, l)?.name).join('、')}，终局别给对手送钱` : ''
      return (auto.length === owners.length ? '付到了所有人的承诺价，提出即全员自动同意，然后可直接成交' : '在对方报价与自己净得之间的平衡方案') + tail
    }
    case 'ABANDON_DEAL': return endChance(state) > 0 ? '凑不齐、要价太高，或这单只会把对手送上领先位——终局宁可流局' : '凑不齐或要价太高，继续耗只会白给别人出牌机会'
    case 'SPEAK': return action.demand != null ? `报出承诺价 $${action.demand}M：Boss 付到即成，价格参考一份分红与竞争者` : '表态施压'
    case 'PLAY_CLAN': return action.demand != null ? `该家族桌上缺人或可压价抢单，附带报价 $${action.demand}M` : '用自己的家族卡替代要钱的代表，省钱'
    case 'PLAY_BOSS': return '交易值钱、你当 Boss 也能凑齐，且现在的方案对你不利'
    case 'PLAY_TRAVEL': return '被排除在方案外，打飞关键代表让 Boss 回来求你'
    case 'PLAY_RECRUITMENT': return '永久夺取高频家族的投资者，长期收益'
    case 'ACCEPT_OFFER': return neg ? `分到 $${offerShareOf(neg.offer, id)}M，达到心理价` : '达到心理价'
    case 'DECLINE_OFFER': return action.counter != null ? `低于心理价，反报价 $${action.counter}M（成为新的承诺价）` : '低于心理价'
    case 'PASS_CLOSING': return neg && offerShareOf(neg.offer, id) > 0 ? '方案里有你的钱，放行即到账' : '没有值得打的牌，或搅局对你无益'
    case 'PLAY_STOP': return '被打的是你的利益，阻止它'
    case 'PASS_REACTION': return '这张牌不损害你，留着阻止牌'
    case 'OPEN_DEAL': return '当 Boss 拿大头：估算需要买的代表少、利润够'
    case 'ROLL_MOVE': return '当前格对你不划算，移动找更好的格子'
    case 'DRAW_CARDS': return '当前格不划算，补牌积蓄影响力'
    case 'PASS': return neg?.bossId === id ? '让其他人先叫价，再拼方案' : '没有必要行动，观望'
    default: return ''
  }
}
