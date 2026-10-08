// ============================================================
// 启发式策略 — 不依赖 LLM，任何局面都能立刻给出合法动作。
// 既是"无 LLM"模式下的电脑玩家，也是 LLM 失败 / 超时时的兜底。
// 行为参数按人物（personas.ts）取：同一座位在两种模式下是同一个人。
// 决策只依赖状态（随机数由 stateVersion 派生），仿真可复现。
//
// 博弈直觉（和真实桌面一致）：
//   · 报价即承诺：先叫价，价格围绕一份分红；唯一代表抬价，有竞争者压价
//   · Boss 先用自己的家族卡省钱，再贴着对方承诺价付；别为几块钱流局
//   · 搅局只在被排除 / 分得太少且交易值钱时；记仇者对搅过自己的人加倍
//   · 终局：领先者盼成交（骰子可能直接赢），落后者拦领先者的单
// ============================================================

import type { GameState, PlayerAction, FamilyId, BoardSpace, Representative } from '../engine/types'
import { FAMILIES, MAX_OFFERS_PER_BOSS, BOOM_BONUS } from '../engine/config'
import {
  getPlayer, getCurrentSpace, getGrossValue, oneShareOf, spaceInvestorCount,
  selectReps, tableCanComplete, canCompleteAlone, playerCoverableFamilies, playerActiveFamilies,
  activeRepsOfFamily, findRep, offerShareOf, offerOwners, repCost, payoutTotal, repsUsedOf,
  familyDemandOnBoard, groupOfFamily, soleRepFamilies, leaderIds, endChance, grudgeCount,
  commitmentPrice, repPriceOf, hasDemand, landmarkRentEstimate, canReclaim, isBlackMarketDeal, isExclusiveLocked,
  isSick, swapTargetType, buyCardsCost, tradeCost, recruitCountAfterTrade, cardKeepValue, recruitTargets, recruitCost, countCards,
} from '../engine/rules'
import { getActingPlayerId, getLegalActions, isLegal, buildOfferCandidates, canClose, type OfferCandidate } from '../engine/validator'
import type { Policy } from './policy'
import { getPersonaForPlayer, type PersonaParams } from './personas'

/** 人物的行为骨架（参数与人设在 personas.ts；平衡目标：各人物胜率相近、风格不同但都能赢） */
function persona(state: GameState, id: number): PersonaParams {
  return getPersonaForPlayer(getPlayer(state, id)?.personaId).play
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
    case 'TURN': return preDeal(state, id, legal, false) ?? (wantsToOpen(state, id, false) ? { type: 'OPEN_DEAL', playerId: id } : { type: 'ROLL_MOVE', playerId: id })
    case 'AFTER_MOVE': return preDeal(state, id, legal, true) ?? (wantsToOpen(state, id, true) ? { type: 'OPEN_DEAL', playerId: id } : { type: 'DRAW_CARDS', playerId: id })
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
    // 格子的分量：分红份数 + 地标未来租金折算成份数（别把能独立凑齐的地标送给起始玩家）
    const weight = space.dividends + landmarkRentEstimate(state, space) / 2
    const mine = canCompleteAlone(state, id, space) ? weight : 0
    const theirs = canCompleteAlone(state, starter, space) ? weight : 0
    const score = mine * 2 - theirs * 3 - weight * 0.1 + rand(state, space.id) * 0.5
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
  // 地标格：这单的价值还包括此后每笔成交的租金
  const value = gross + landmarkRentEstimate(state, space)
  const share = Math.max(1, Math.round(gross / (spaceInvestorCount(space) + 1)))
  const hand = getPlayer(state, id)!.hand.length
  const est = estimateDeal(state, id, space)
  if (!est.feasible) return false
  const expectedProfit = value - est.buyCount * share * 1.2
  const end = endChance(state)
  const leader = leaderIds(state).includes(id)
  // 终局：领先者只要有得赚就想开单（成交后掷骰可能直接赢）
  const minProfit = leader && end > 0 ? 1 : Math.max(4, gross * 0.3)
  if (afterMove && hand <= 4 && expectedProfit < value * 0.6 && !(leader && end > 0)) return false // 手牌太少先补牌
  if (est.buyCount === 0) return true
  return expectedProfit >= minProfit && rand(state, 7) < 0.85
}

function handLimit(state: GameState, id: number, legal: PlayerAction[]): PlayerAction {
  return bestRecruit(state, id, legal) ?? legal.find(a => a.type === 'DISCARD') ?? legal[0]
}

/** 招募目标评分：版图需求、抢富人的、补本格缺口、掀掉排除我的方案；夺回自己的人（1 张）与猎头价（2 张）更划算 */
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
    if (canReclaim(state, id, f)) score += 5                          // 一张牌换回常驻投资者，没有不做的道理
    else if (a.cardIds.length < 3) score += 1.5                       // 猎头价
    if (score > bestScore) { bestScore = score; best = a }
  }
  return best
}

/** 夺回权可用就立刻用：1 张招募牌换回一位常驻投资者 */
function reclaimOption(state: GameState, id: number, legal: PlayerAction[]): PlayerAction | null {
  return legal.find(a => a.type === 'PLAY_RECRUITMENT' && canReclaim(state, id, a.targetFamilyId)) ?? null
}

// ---------- 桌规：买牌 / 互换 / 兑换 / 病假 ----------

/** 谁对这单最危险：不在方案里拿钱、手牌最多的人（同牌数取现金多者 / 坑过我的人） */
function mostDangerous(state: GameState, id: number, candidates: number[], minHand: number): number | null {
  const neg = state.negotiation
  let best: number | null = null
  let bestScore = -Infinity
  for (const q of candidates) {
    const p = getPlayer(state, q)
    if (!p || q === id || isSick(state, q) || p.hand.length < minHand) continue
    if (neg && offerShareOf(neg.offer, q) > 0) continue
    const score = p.hand.length * 2 + p.cash * 0.05 + grudgeCount(state, id, q) * 1.5
    if (score > bestScore) { bestScore = score; best = q }
  }
  return best
}

function sickOptionFor(legal: PlayerAction[], target: number | null): PlayerAction | null {
  if (target == null) return null
  return legal.find(a => a.type === 'PLAY_SICK' && a.targetPlayerId === target) ?? null
}

/**
 * 自己回合开单前的桌规动作：
 *   · 手牌见底且现金宽裕（非终局）→ 花钱补 1 张（穷得只剩 1 张时补 2 张）
 *   · 手里有能换来"下一步就能招"的兑换 → 先兑换
 *   · 准备开一单值钱的交易 → 先把手牌最多的对手放倒（病假），他这一轮就翻不了桌
 */
function preDeal(state: GameState, id: number, legal: PlayerAction[], afterMove: boolean): PlayerAction | null {
  if (!state.houseRules) return null
  const me = getPlayer(state, id)!
  const end = endChance(state)
  const buy = (n: number) => legal.find(a => a.type === 'BUY_CARDS' && a.count === n)
  // 一张牌的期望价值有限（省下一份分红的机会而已）：股价便宜时才买，贵了只有很有钱才买
  const affordable = (n: number) => { const cost = buyCardsCost(state, n); return cost <= 3 * n || cost * 8 <= me.cash }
  if (end === 0 && me.hand.length <= 2) {
    const two = buy(2)
    if (two && me.hand.length <= 1 && affordable(2) && me.cash >= buyCardsCost(state, 2) * 3 && rand(state, 101) < 0.4) return two
    const one = buy(1)
    if (one && affordable(1) && me.cash >= buyCardsCost(state, 1) * 3 && rand(state, 103) < 0.6) return one
  }
  const trade = tradeOption(state, id, legal)
  if (trade) return trade
  const gross = getGrossValue(state)
  if (gross >= 10 && wantsToOpen(state, id, afterMove) && rand(state, 107) < 0.6) {
    const target = mostDangerous(state, id, state.players.map(p => p.id), 3)
    const sick = sickOptionFor(legal, target)
    if (sick) return sick
  }
  return null
}

/**
 * 兑换招募牌（两张异类牌 + 一份股价 → 2 张招募）值不值：换完就能招人才做——
 * 夺回权只要 1 张（没招募牌时兑换即可立刻夺回）；猎头格 2 张；常规 3 张须已有 1 张。
 * 交出的必须是废牌（已关闭家族的家族卡 / 定向旅行、凑不成组的单张招募），且别把现金掏空。
 */
function tradeOption(state: GameState, id: number, legal: PlayerAction[]): PlayerAction | null {
  const trade = legal.find(a => a.type === 'TRADE_CARDS')
  if (!trade || trade.type !== 'TRADE_CARDS') return null
  const me = getPlayer(state, id)!
  const have = countCards(me.hand, 'RECRUITMENT')
  const after = recruitCountAfterTrade(state, id, trade.cardIds)
  const given = trade.cardIds.map(cid => me.hand.find(c => c.id === cid)!)
  const junkScore = given.reduce((s, c) => s + cardKeepValue(state, id, c), 0)
  const reclaimable = !!me.reclaim && canReclaim(state, id, me.reclaim)
  if (reclaimable && have < 1 && after >= 1 && junkScore <= 6) return trade
  const targets = recruitTargets(state, id).filter(f => !canReclaim(state, id, f))
  if (targets.length === 0 || junkScore > 2 || endChance(state) > 0) return null
  const minCost = Math.min(...targets.map(f => recruitCost(state, id, f)))
  if (have >= minCost || after < minCost) return null
  if (me.cash < tradeCost(state) * 3) return null
  return rand(state, 109) < 0.7 ? trade : null
}

/**
 * 互换（家族成员 ↔ 同家族旅行牌，须持有该家族投资者）：
 *   · 成员 → 旅行：桌上有别人的同家族代表在和我的投资者抢位置 → 换出旅行牌，下一步就把他打飞，Boss 只能找我
 *   · 旅行 → 成员：我的投资者被打飞、这家又缺人 / 被别人顶了 → 换回成员卡补位
 * 互换不结束行动，换完紧接着就能打。
 */
function swapOption(state: GameState, id: number, legal: PlayerAction[]): PlayerAction | null {
  const neg = state.negotiation
  if (!neg) return null
  const space = getCurrentSpace(state)!
  const me = getPlayer(state, id)!
  const gross = getGrossValue(state)
  const isBoss = neg.bossId === id
  for (const a of legal) {
    if (a.type !== 'SWAP_CARD') continue
    const card = me.hand.find(c => c.id === a.cardId)
    const f = card?.familyId
    if (!card || !f || !groupOfFamily(space, f)) continue
    const to = swapTargetType(card)
    if (to === 'TRAVEL') {
      if (isBoss || isExclusiveLocked(state) || gross < 8) continue
      const myInvestorActive = neg.reps.some(r => r.familyId === f && r.source === 'INVESTOR' && r.ownerId === id && !r.travelled)
      const rivals = activeRepsOfFamily(neg, f).filter(r => r.ownerId !== id)
      if (!myInvestorActive || rivals.length === 0) continue
      const rivalInOffer = rivals.some(r => neg.offer?.repKeys.includes(r.key))
      const iAmUsed = !!neg.offer && neg.offer.repKeys.some(k => findRep(neg, k)?.ownerId === id && findRep(neg, k)?.familyId === f)
      if (iAmUsed) continue
      if (rivalInOffer || !neg.offer) { if (rand(state, 113) < 0.8) return a }
    } else if (to === 'CLAN') {
      if (!neg.travelledInvestors.includes(f)) continue
      const rivals = activeRepsOfFamily(neg, f).filter(r => r.ownerId !== id)
      const needed = isFamilyMissing(state, f) || (isBoss ? selectReps(state).repKeys.some(k => findRep(neg, k)?.familyId === f && findRep(neg, k)?.ownerId !== id) : rivals.some(r => neg.offer?.repKeys.includes(r.key)))
      if (needed && gross >= 6) return a
    }
  }
  return null
}

/** 清场：打飞与我的投资者同家族、正在和我抢位置的竞争代表（打掉后 Boss 只能找我） */
function travelForMyInvestor(state: GameState, id: number, legal: PlayerAction[]): PlayerAction | null {
  const neg = state.negotiation
  if (!neg || getGrossValue(state) < 8) return null
  const myInvestors = new Set(state.investors.filter(i => i.ownerId === id).map(i => i.familyId))
  let best: PlayerAction | null = null
  let bestScore = 0
  for (const a of legal) {
    if (a.type !== 'PLAY_TRAVEL') continue
    const rep = findRep(neg, a.targetRepKey)
    if (!rep || rep.ownerId === id || !myInvestors.has(rep.familyId) || neg.travelledInvestors.includes(rep.familyId)) continue
    const inOffer = !!neg.offer?.repKeys.includes(rep.key)
    const iAmUsed = !!neg.offer && neg.offer.repKeys.some(k => { const r = findRep(neg, k); return r?.ownerId === id && r.familyId === rep.familyId })
    if (iAmUsed) continue
    const others = activeRepsOfFamily(neg, rep.familyId).filter(r => r.key !== rep.key && r.ownerId !== id).length
    const score = (inOffer ? 3 : 1) + (others === 0 ? 2 : 0) + (rep.ownerId === neg.bossId ? 1 : 0)
    if (score > bestScore) { bestScore = score; best = a }
  }
  return best && bestScore >= 3 && rand(state, 127) < 0.85 ? best : null
}

/** 谈判中的病假：我在方案里有钱 → 把不在方案里、手牌多的人放倒，保住这单；Boss 落锤前也一样 */
function protectiveSick(state: GameState, id: number, legal: PlayerAction[], chance: number): PlayerAction | null {
  const neg = state.negotiation
  if (!neg || getGrossValue(state) < 10 || rand(state, 131) >= chance) return null
  const target = mostDangerous(state, id, state.players.filter(p => p.id !== neg.bossId).map(p => p.id), 3)
  return sickOptionFor(legal, target)
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

  // 夺回权：1 张牌换回常驻投资者，任何时候都先做
  const reclaim = reclaimOption(state, id, legal)
  if (reclaim) return reclaim

  // 桌规：兑换 / 互换不结束行动，先做（兑换后下一步就能夺回；换回成员卡后下一步就能补位）
  const exchange = tradeOption(state, id, legal) ?? swapOption(state, id, legal)
  if (exchange) return exchange

  if (canClose(state)) {
    // 落锤前的"拼方案"牌：独家协议先把桌子锁上（别人手牌多、这单值钱时），利好再把盘子做大（分成已定，多出的全归我）
    const exclusive = legal.find(a => a.type === 'PLAY_EXCLUSIVE')
    const threat = state.players.some(q => q.id !== id && q.hand.length >= 3)
    if (exclusive && threat && gross >= 10 && !isBlackMarketDeal(state) && rand(state, 83) < 0.8) return exclusive
    // 病假：把不在方案里、手牌最多的人放倒，他这一轮翻不了桌
    const sick = protectiveSick(state, id, legal, 0.7)
    if (sick) return sick
    const boom = legal.find(a => a.type === 'PLAY_BOOM')
    if (boom && rand(state, 89) < 0.9) return boom
    return { type: 'CLOSE_DEAL', playerId: id }
  }

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

  // 预测每个方案会不会被接受：有承诺价的付到即成（按所用代表、各家族报价累计）；没报价的按其人物心理价估
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

  // 首次提案：会压价的人先试探一手（对方要么接受要么反报价，下轮再照价付）
  if (neg.offersMade === 0 && !(st.iAmLeader && st.end > 0)) {
    const haggle = scored.find(x => x.c.key === 'haggle')
    const best = acceptable[0]
    if (haggle && best && haggle.value > best.value && rand(state, 53) < p.haggle) {
      return { type: 'PROPOSE_OFFER', playerId: id, repKeys: haggle.c.repKeys, payouts: haggle.c.payouts }
    }
  }

  const choice = acceptable[0]
    ?? (neg.offersMade === 0 ? scored.sort(byValue).find(x => x.keep >= minKeep) : null)
    // 只要还没到提案上限（含第 5 次，offersMade === 4）且有得赚，就照单全付，不要提前一拍放弃
    ?? (neg.offersMade < MAX_OFFERS_PER_BOSS ? scored.filter(x => x.okAll && x.keep >= 1).sort(byValue)[0] : null)
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

/** 我的出借价：一份分红 × 人物倍率 × 杠杆 × 终局因素，且不高于对手的竞争价 */
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
  // 地标格：当上 Boss 还能拿到此后每笔的租金，夺权更值
  const prize = gross + landmarkRentEstimate(state, space)

  // 0. 夺回权：1 张牌换回常驻投资者，任何时候都先做
  const reclaim = reclaimOption(state, id, legal)
  if (reclaim) return reclaim

  // 0b. 桌规：不结束行动的换牌先做——兑换后立刻能夺回 / 招募；互换出旅行牌后立刻能打飞竞争者，换回成员卡后立刻能补位
  const exchange = tradeOption(state, id, legal) ?? swapOption(state, id, legal)
  if (exchange) return exchange
  // 0c. 清场：打飞正在和我的投资者抢同一个位置的代表，Boss 就只能找我
  const clear = travelForMyInvestor(state, id, legal)
  if (clear) return { ...clear, say: pick(['这位先出个差，这家的事找我谈。', '不好意思，同一家有我就够了。'], rand(state, 139)) }

  // 1. 夺权：交易值钱、我当 Boss 也能凑齐，且（被排除/分太少 | 我不用花钱就能独吞 | 拦领先者的终局单）
  const bossOpt = legal.find(a => a.type === 'PLAY_BOSS')
  if (bossOpt && prize >= 9 && canCompleteAsBoss(state, id)) {
    const cost = myBossCost(state, id)
    const strong = !neg.offer && cost <= share && prize - cost >= prize * 0.6
    const reason = (neg.offer && (excluded || underpaid)) || strong || st.blockLeader
    if (reason && rand(state, 11) < disruptChance(state, id, 0.45) + (strong ? 0.25 : 0) + (st.blockLeader ? 0.3 * st.end : 0)) return bossOpt
  }

  // 1b. 保住我的分成：方案里有我的钱 → 把不在方案里、手牌多的人放倒（病假）
  if (myShare > 0) {
    const sick = protectiveSick(state, id, legal, p.protect * 0.7)
    if (sick) return sick
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

  // 3. 叫价：有相关代表但还没开价的家族 → 一句话报完，每个家族各按自己的筹码定价（唯一代表抬价、有竞争者压价）
  const canSpeak = legal.some(a => a.type === 'SPEAK')
  const unpriced = relevantMine.filter(f => repPriceOf(neg, { ownerId: id, familyId: f } as Representative) == null)
  if (canSpeak && unpriced.length > 0) {
    const priced = unpriced.map(f => ({ f, ask: askPrice(state, id, f) })).sort((a, b) => b.ask - a.ask)
    const allSame = priced.every(x => x.ask === priced[0].ask)
    const soleSet = new Set(soleRepFamilies(state, id))
    const sole = priced.some(x => soleSet.has(x.f))
    let say: string
    if (allSame) {
      const ask = priced[0].ask
      const fam = priced.map(x => FAMILIES[x.f].name).join('/')
      say = sole
        ? pick([`没我的${fam}这单做不成，$${ask}M。`, `${fam}只有我有，$${ask}M，不二价。`], rand(state, 17))
        : pick([`想用我的${fam}？$${ask}M，一口价。`, `${fam}这边可以谈，我要 $${ask}M。`, `$${ask}M，付到就成。`], rand(state, 17))
    } else {
      const list = priced.map(x => `${FAMILIES[x.f].name} $${x.ask}M`).join('、')
      say = sole
        ? pick([`我的价：${list}。${FAMILIES[priced.find(x => soleSet.has(x.f))!.f].name}没我做不成，不二价。`, `${list}——各是各的价，付到就成。`], rand(state, 17))
        : pick([`${list}，一口价。`, `我这边：${list}，付到就成。`], rand(state, 17))
    }
    // 各家各价，一次说完；已经报过价的家族不动
    return { type: 'SPEAK', playerId: id, say, quotes: priced.map(x => ({ familyId: x.f, amount: x.ask })) }
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
        return { type: 'SPEAK', playerId: id, say: `Boss，换我的${FAMILIES[f].name}，$${cut}M 就行，比他便宜。`, quotes: [{ familyId: f, amount: cut }] }
      }
    }
  }

  // 4. 被排除 / 没份：搅局（黑市里没人能阻止我，出手更果断）
  if ((excluded || (relevantMine.length === 0 && myShare === 0)) && gross >= 8) {
    const chance = disruptChance(state, id, neg.offer ? 1 : 0.5) * (isBlackMarketDeal(state) ? 1.3 : 1)
    if (rand(state, 19) < chance) {
      const travel = bestTravel(state, id, legal)
      if (travel) return travel
      // 利空：打不掉这单就砍 Boss 的净得——领先的 Boss、或坑过我的人，才值得花这张稀有牌
      const bust = legal.find(a => a.type === 'PLAY_BUST')
      if (bust && gross >= 12 && (st.bossIsLeader || grudgeCount(state, id, neg.bossId) > 0) && rand(state, 97) < 0.7) return bust
    }
  }

  // 5. 招募：长期资产，手里有三连就找机会用（猎头格两张就够，更要抓住）
  const recruit = bestRecruit(state, id, legal)
  if (recruit && rand(state, 23) < (recruit.type === 'PLAY_RECRUITMENT' && recruit.cardIds.length < 3 ? 0.9 : 0.7)) return recruit

  // 6. 封口费：没代表也想分一口
  if (canSpeak && relevantMine.length === 0 && !hasDemand(neg, id) && p.bribe && gross >= 12 && rand(state, 29) < 0.4) {
    const ask = Math.max(1, Math.round(share * 0.5))
    const say = pick([`我手里有牌，$${ask}M 买个安静怎么样？`, `分我 $${ask}M，我保证不捣乱。`], rand(state, 31))
    return { type: 'SPEAK', playerId: id, say, quotes: [{ amount: ask }] }
  }

  // 7. 跳过（被排除时偶尔放狠话——有牌是威胁，没牌是虚张声势；桌子被独家协议锁了就没牌可威胁）
  const hasTeeth = !isExclusiveLocked(state) && getPlayer(state, id)!.hand.some(c => c.type === 'BOSS' || c.type === 'TRAVEL' || c.type === 'BUST' || c.type === 'SICK')
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
  // 我对这份方案的承诺价（各家族报价累计）；没报过就按人物心理价
  const committed = commitmentPrice(neg, neg.offer!, id)
  const myAsk = committed != null ? committed / used : Math.round(share * p.askMult)
  let threshold = Math.max(1, Math.round(myAsk * p.acceptMult)) * used
  if (st.blockLeader) threshold = Math.round(threshold * (1 + st.end))
  if (st.iAmLeader && st.end > 0 && !st.wouldOvertake) threshold = 1 // 成交就可能赢：给钱就点头
  if (myShare >= threshold) return { type: 'ACCEPT_OFFER', playerId: id }
  if (neg.offersMade >= MAX_OFFERS_PER_BOSS - 1 && myShare >= Math.max(1, Math.round(share * 0.5)) * used) return { type: 'ACCEPT_OFFER', playerId: id }
  // 反报价是每个代表的出借价（通用价：方案所用的我的每个家族同价）
  const counter = Math.max(Math.ceil(threshold / used), Math.floor(myShare / used) + 1)
  return { type: 'DECLINE_OFFER', playerId: id, quotes: [{ amount: Math.min(counter, Math.max(1, Math.floor((getGrossValue(state) - 1) / used))) }] }
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
  if (pr.kind === 'BOOM' && neg) {
    // 利好只肥 Boss：他领先 / 终局阶段就别让他多拿
    if (!iAmBoss && (st.bossIsLeader || st.end > 0) && r < p.protect * 0.8) return stop
    return pass
  }
  if (pr.kind === 'BUST' && neg) {
    if (iAmBoss) return r < 0.85 ? stop : pass // 砍的是我的钱
    return pass
  }
  if (pr.kind === 'EXCLUSIVE' && neg) {
    // 桌子一锁我的老板 / 旅行 / 利空牌就废了：被排除、手里又有牙齿时拦下
    const teeth = getPlayer(state, id)!.hand.some(c => c.type === 'BOSS' || c.type === 'TRAVEL' || c.type === 'BUST')
    if (!iAmBoss && teeth && myShare === 0 && r < p.protect) return stop
    return pass
  }
  if (pr.kind === 'SICK') {
    // 病假针对的是我：手里有能打的牌、而这单又与我有关（没我的份 / 单子够大）才值得用阻止牌保住出牌权
    if (pr.targetPlayerId !== id) return pass
    const me = getPlayer(state, id)!
    const teeth = me.hand.some(c => c.type === 'BOSS' || c.type === 'TRAVEL' || c.type === 'BUST' || c.type === 'SICK' || c.type === 'CLAN')
      || countCards(me.hand, 'RECRUITMENT') >= 2
    if (teeth && (myShare === 0 || gross >= 12) && r < p.protect) return stop
    return pass
  }
  return pass
}

function closing(state: GameState, id: number, legal: PlayerAction[]): PlayerAction {
  const neg = state.negotiation!
  const gross = getGrossValue(state)
  const myShare = offerShareOf(neg.offer, id)
  const pass: PlayerAction = { type: 'PASS_CLOSING', playerId: id }
  if (myShare > 0) {
    // 倒计时里我有钱拿：还没轮到、手里有牌的局外人先放倒（病假），他就只能放行
    const later = neg.closingOrder.slice(neg.closingIndex + 1)
    const sick = sickOptionFor(legal, mostDangerous(state, id, later, 2))
    if (sick && gross >= 10 && rand(state, 137) < persona(state, id).protect) return sick
    return pass
  }
  const st = stance(state, id)
  const chance = disruptChance(state, id, gross >= 12 ? 0.8 : 0.5)
  const r = rand(state, 41)

  const bossOpt = legal.find(a => a.type === 'PLAY_BOSS')
  if (bossOpt && gross + landmarkRentEstimate(state, getCurrentSpace(state)!) >= 9 && canCompleteAsBoss(state, id) && r < chance) return bossOpt
  if (r < chance) {
    const travel = bestTravel(state, id, legal)
    if (travel) return travel
    const recruit = legal.find(a => a.type === 'PLAY_RECRUITMENT' && neg.offer?.repKeys.includes(`INV:${a.targetFamilyId}`))
    if (recruit) return recruit
    // 最后一手：利空砍掉领先 Boss 的净得（稀有牌，只在终局 / 对领先者用）
    const bust = legal.find(a => a.type === 'PLAY_BUST')
    if (bust && gross >= 12 && (st.bossIsLeader || st.end > 0) && r < chance * 0.6) return bust
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
    case 'PLAY_RECRUITMENT':
      return canReclaim(state, action.playerId, action.targetFamilyId)
        ? pick(['我的人，我领回去了。', '一张牌就够——这位投资人本来就是我的。'], r)
        : action.cardIds.length < 3
          ? pick(['猎头价，这位投资人我带走了。', '这地方挖人便宜，不客气了。'], r)
          : pick(['来，这位投资人跟我走。', '挖个人，不介意吧？'], r)
    case 'PLAY_BOOM': return pick([`利好消息：这单每份再加 $${BOOM_BONUS}M——多出来的，归我。`, '行情看涨，这盘子我做大一点。'], r)
    case 'PLAY_BUST': return pick(['利空消息。这单，不值那个价了。', '不带我玩？那这单就没那么香了。'], r)
    case 'PLAY_EXCLUSIVE': return pick(['独家协议，签了。这单谁也别想再翻。', '桌子我锁上了，各位收好手里的牌。'], r)
    case 'PLAY_SICK': {
      const target = getPlayer(state, action.targetPlayerId)?.name ?? '你'
      return pick([`${target}，脸色不太好，这一轮回去歇着吧。`, `${target}请病假——这单你就看着。`, `听说${target}病了？那手里的牌就先别动了。`], r)
    }
    case 'SWAP_CARD': {
      const card = getPlayer(state, action.playerId)?.hand.find(c => c.id === action.cardId)
      const fam = card?.familyId ? FAMILIES[card.familyId].name : '这家'
      return card?.type === 'CLAN'
        ? pick([`${fam}是我的人，换张机票用用。`, `我自家的${fam}，让他们换个差事。`], r)
        : pick([`${fam}的人我叫得动，机票换成人。`, `不出差了，${fam}这边我再派个人来。`], r)
    }
    case 'BUY_CARDS': return pick(['手里没牌不行，花点钱补几张。', '钱是用来生钱的，先补牌。'], r)
    case 'TRADE_CARDS': return pick(['废牌加点钱，换两张招募——猎头费。', '这几张没用了，换成招人的本钱。'], r)
    case 'PLAY_STOP': return pick(['想都别想！', '这招对我没用。'], r)
    case 'ACCEPT_OFFER': return pick(['成交，我同意出人。', '这个价可以，合作愉快。'], r)
    case 'DECLINE_OFFER': {
      const counter = action.quotes?.[0]?.amount
      return counter != null ? pick([`这价不行，每个代表 $${counter}M 才谈。`, `加到 $${counter}M 一个我就点头。`], r) : '这价钱我不干。'
    }
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
