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
import { FAMILIES, MAX_OFFERS_PER_BOSS } from '../engine/config'
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
import { stateRand as rand } from './stateRand'
import { pickLine, type Situation, type LineVars } from './lines'
import { relationsOf, type Relation } from './relations'
import { STYLE_PARAMS, type StyleParams, type TableStyle } from './tableStyle'
import { currentDealEvents } from './negotiationProgress'

/** 人物的行为骨架（参数与人设在 personas.ts；平衡目标：各人物胜率相近、风格不同但都能赢） */
function persona(state: GameState, id: number): PersonaParams {
  return getPersonaForPlayer(getPlayer(state, id)?.personaId).play
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))

// ---------- 一次决策的上下文：桌风与关系记忆 ----------
// heuristicAction 是同步的纯函数（同一个 state + 同一个 style 永远同一个结果）；
// 这里的模块级变量只是"本次调用内"的缓存与参数，入口处每次重置，不跨调用携带任何信息。

interface Ctx {
  style: StyleParams
  /** 缓存对应的状态（引用比较；换了状态就丢弃关系缓存） */
  state: GameState | null
  rels: Map<number, Record<number, Relation>>
}
const ctx: Ctx = { style: STYLE_PARAMS.business, state: null, rels: new Map() }

/** fromId 对 toId 的态度分（-2..2）；找不到视为 0 */
function relScore(state: GameState, fromId: number, toId: number): number {
  if (ctx.state !== state) { ctx.state = state; ctx.rels = new Map() }
  let all = ctx.rels.get(fromId)
  if (!all) { all = relationsOf(state, fromId); ctx.rels.set(fromId, all) }
  return all[toId]?.score ?? 0
}

/** 对 toId 的敌意（0..2）：交易历史里的搅局次数与关系记忆取大者 */
function hostility(state: GameState, fromId: number, toId: number): number {
  return Math.max(Math.min(2, grudgeCount(state, fromId, toId)), -relScore(state, fromId, toId), 0)
}

/** 给定情境挑一句本人物的台词（纯函数；避开最近说过的） */
function L(state: GameState, id: number, situation: Situation, vars: LineVars = {}, salt = 43): string {
  return pickLine(state, id, situation, vars, salt)
}

export interface HeuristicOptions {
  /** 桌风（默认商战）：缩放报价、让步、搅局、压价与记仇 */
  style?: TableStyle
}

/**
 * 当前行动者的启发式动作（含台词）。没有行动者或没有合法动作时返回 null。
 * 结果一定通过 isLegal：决策若产生非法动作，退回合法列表的第一项。
 */
export function heuristicAction(state: GameState, opts: HeuristicOptions = {}): PlayerAction | null {
  const id = getActingPlayerId(state)
  if (id < 0) return null
  const legal = getLegalActions(state, id)
  if (legal.length === 0) return null
  ctx.style = STYLE_PARAMS[opts.style ?? defaultStyle]
  ctx.state = state; ctx.rels = new Map()
  const decided = decide(state, id, legal)
  const action = decided && isLegal(state, decided) ? decided : legal[0]
  return action.say ? action : { ...action, say: heuristicSpeech(state, action) || undefined }
}

/** 启发式策略。getStyle 每次决策时读取（桌风来自设置，开局时读一次即可，也可以随时换） */
export function createHeuristicPolicy(getStyle?: () => TableStyle | undefined): Policy {
  return {
    name: 'heuristic',
    decide: async state => heuristicAction(state, { style: getStyle?.() }),
  }
}

/**
 * 脚本 / 仿真用的默认桌风（SIM_STYLE）。游戏本身不用它——会话里的策略显式传桌风。
 * 只是让不方便传参的入口（sim/harness.ts 的 heuristicAction(state)）也能跑不同桌风。
 */
let defaultStyle: TableStyle = 'business'
export function setDefaultHeuristicStyle(style: TableStyle) { defaultStyle = style }

export const heuristicPolicy: Policy = createHeuristicPolicy()

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
    // 对手的家族卡属于秘密手牌；只以其公开投资者评估起始玩家。
    const publicFamilies = new Set(state.investors.filter(inv => inv.ownerId === starter).map(inv => inv.familyId))
    const theirs = space.groups.every(g => g.families.filter(f => publicFamilies.has(f)).length >= g.need) ? weight : 0
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
  const expectedProfit = value - est.buyCount * share
  const end = endChance(state)
  const leader = leaderIds(state).includes(id)
  // 终局：领先者只要有得赚就想开单（成交后掷骰可能直接赢）
  // 其余时候要挑单：要向别人买代表的薄利单，开了也是替别人分钱，还白白放弃这回合的抽牌。
  // 门槛 = 人物底线 × 4（上限总额的 3/4）；竞技场里比旧版的 1 倍门槛相对胜率高约四成，流局也更少。
  const p = persona(state, id)
  const minProfit = leader && end > 0 ? 1 : Math.max(1, Math.round(gross * Math.min(0.75, p.floor * ctx.style.keep * 4)))
  if (afterMove && hand <= 4 && expectedProfit < value * 0.6 && !(leader && end > 0)) return false // 手牌太少先补牌
  if (est.buyCount === 0) return true
  return expectedProfit >= minProfit && rand(state, 7) < clamp(0.7 + 0.2 * p.flex * ctx.style.flex, 0.7, 0.95)
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
    const score = p.hand.length * 2 + p.cash * 0.05 + hostility(state, id, q) * 1.5 - Math.max(0, relScore(state, id, q)) * 0.8
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
      return { ...a, say: bossClanLine(state, id, f) }
    }
  }

  // 代表已经齐全但买不起时，招募关键投资者或利好扩盘也是有成本的实际出路。
  const selected = selectReps(state)
  const recruitment = legal.filter(a => a.type === 'PLAY_RECRUITMENT').map(a => {
    if (a.type !== 'PLAY_RECRUITMENT') return { action: a, saving: 0 }
    const rep = selected.repKeys.map(k => findRep(neg, k)).find(r => r?.familyId === a.targetFamilyId && r.ownerId !== id)
    return { action: a, saving: rep ? repCost(state, rep) : 0 }
  }).sort((a, b) => b.saving - a.saving)[0]
  if (recruitment && recruitment.saving >= Math.max(2, Math.round(share * 1.5))) return recruitment.action
  const currentCost = selected.repKeys.reduce((sum, k) => sum + repCost(state, findRep(neg, k)!), 0)
  const boom = legal.find(a => a.type === 'PLAY_BOOM')
  if (boom && currentCost >= gross - bossFloor(gross, st, p)) return boom

  if (neg.offersMade >= MAX_OFFERS_PER_BOSS) return { type: 'ABANDON_DEAL', playerId: id }
  const candidates = buildOfferCandidates(state).filter(c => c.payouts.length > 0 || offerOwners(neg, c).every(o =>
    (commitmentPrice(neg, c, o) ?? Infinity) <= (c.payouts.find(p => p.playerId === o)?.amount ?? 0)))

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
  // 走人底线：低于它就不再"照单全付"（被唯一代表狮子大开口时拖 / 威胁 / 找替代 / 放弃，而不是认栽）
  const floor = bossFloor(gross, st, p)
  // 全体要价超过盘子时，仍可提出具体的、每位代表都有收入的预算内还价。
  // 保留舒服底线与走人底线两档，不能重复拿已被拒绝的同一方案消耗轮次。
  for (const keep of new Set([Math.max(floor, minKeep), floor])) {
    const counter = budgetOffer(state, gross - keep)
    if (counter && !candidates.some(c => sameOffer(c, counter))) candidates.push(counter)
  }
  // 方案价值 = 我净得 − 终局阶段"送给成交后会压过我的人"的钱（帮对手赢的钱按终局概率加倍算亏）
  // 记仇者不愿把钱送给坑过自己的人
  const me = getPlayer(state, id)!
  const value = (c: OfferCandidate) => {
    let v = c.bossKeep
    for (const pay of c.payouts) {
      const h = hostility(state, id, pay.playerId)
      if (h >= 1) v -= pay.amount * 0.2 * h * p.grudge * ctx.style.grudge
    }
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
  })).filter(x => x.okAll || !offeredBefore(state, id, x.c))
  const byValue = (a: { value: number }, b: { value: number }) => b.value - a.value
  const acceptable = scored.filter(x => x.okAll && x.keep >= Math.min(minKeep, gross - 1)).sort(byValue)

  // 首次提案：会压价的人先试探一手（对方要么接受要么反报价，下轮再照价付）
  if (neg.offersMade === 0 && !(st.iAmLeader && st.end > 0)) {
    const haggle = squeezedOffer(gross, scored.find(x => x.c.key === 'fair')?.c, p.squeeze)
    const best = acceptable[0]
    if (haggle && best && value(haggle) > best.value && rand(state, 53) < p.haggle * ctx.style.haggle) {
      return { type: 'PROPOSE_OFFER', playerId: id, repKeys: haggle.repKeys, payouts: haggle.payouts }
    }
  }

  let choice = acceptable[0]
    ?? scored.filter(x => x.okAll && x.keep >= floor).sort(byValue)[0]
    ?? scored.filter(x => x.c.payouts.length > 0 && x.keep >= floor).sort(byValue)[0]
  if (!choice) {
    // 没有舒服的方案：只付到自己的底线为止（旧版"有得赚就照单全付"会被唯一代表按着头要价）
    choice = scored.filter(x => x.okAll && x.keep >= floor).sort(byValue)[0]
    if (!choice) return holdOut(state, id, scored, floor, p)
  }
  // 终局：这单只会把对手送上领先位 → 宁可流局
  if (choice.value <= 0 && st.end > 0) {
    return { type: 'ABANDON_DEAL', playerId: id, say: L(state, id, 'abandon_end', {}, 61) }
  }
  const sweetened = shareWithFriend(state, id, choice, minKeep, p)
  if (sweetened) return sweetened
  return { type: 'PROPOSE_OFFER', playerId: id, repKeys: choice.c.repKeys, payouts: choice.c.payouts }
}

function sameOffer(a: Pick<OfferCandidate, 'repKeys' | 'payouts'>, b: Pick<OfferCandidate, 'repKeys' | 'payouts'>): boolean {
  const signature = (offer: Pick<OfferCandidate, 'repKeys' | 'payouts'>) => JSON.stringify({
    reps: [...offer.repKeys].sort(),
    payouts: offer.payouts.filter(p => p.amount > 0).map(p => [p.playerId, p.amount]).sort((x, y) => x[0] - y[0]),
  })
  return signature(a) === signature(b)
}

/** 是否本笔由同一 Boss 提过相同的公开代表组合和分成。 */
function offeredBefore(state: GameState, id: number, candidate: OfferCandidate): boolean {
  const neg = state.negotiation!
  const signature = (refs: { familyId: FamilyId; ownerId: number; source: string }[]) =>
    refs.map(r => `${r.familyId}:${r.ownerId}:${r.source}`).sort().join('|')
  const refs = candidate.repKeys.map(k => findRep(neg, k)).filter((r): r is Representative => !!r)
  return currentDealEvents(state).some(e => e.kind === 'OFFER_PROPOSED' && e.bossId === id &&
    signature(e.reps) === signature(refs) && sameOffer({ repKeys: [], payouts: e.payouts }, { repKeys: [], payouts: candidate.payouts }))
}

/** 按公开要价比例分配可用预算，未承诺免费的代表至少 $1M。 */
function budgetOffer(state: GameState, budget: number): OfferCandidate | null {
  const neg = state.negotiation!
  const selected = selectReps(state)
  if (!selected.complete) return null
  const owners = offerOwners(neg, selected)
  if (owners.length === 0) return null
  const minima = owners.map(o => commitmentPrice(neg, selected, o) === 0 ? 0 : repsUsedOf(neg, selected, o))
  const minimum = minima.reduce((sum, n) => sum + n, 0)
  if (budget < minimum) return null
  const weights = owners.map((o, i) => Math.max(minima[i], commitmentPrice(neg, selected, o) ?? minima[i] * oneShareOf(state)))
  const total = Math.min(Math.floor(budget), weights.reduce((sum, n) => sum + n, 0))
  const remainder = total - minimum
  const excess = weights.map((n, i) => n - minima[i])
  const excessTotal = excess.reduce((sum, n) => sum + n, 0)
  const exact = excess.map(n => excessTotal > 0 ? n * remainder / excessTotal : 0)
  const amounts = exact.map((n, i) => minima[i] + Math.floor(n))
  let left = total - amounts.reduce((sum, n) => sum + n, 0)
  const order = exact.map((n, i) => ({ i, fraction: n - Math.floor(n) })).sort((a, b) => b.fraction - a.fraction || a.i - b.i)
  for (const { i } of order) { if (left-- <= 0) break; amounts[i]++ }
  const payouts = owners.map((playerId, i) => ({ playerId, amount: amounts[i] }))
  const candidate: OfferCandidate = { key: 'haggle', repKeys: selected.repKeys, payouts, bossKeep: getGrossValue(state) - total, needsConsent: true }
  return isLegal(state, { type: 'PROPOSE_OFFER', playerId: neg.bossId, ...candidate }) ? candidate : null
}

/** Boss 的走人底线：自留低于它就不再照单全付。领先且可能终局时放得很低（只求成交） */
function bossFloor(gross: number, st: Stance, p: PersonaParams): number {
  let frac = p.floor * ctx.style.keep
  if (st.iAmLeader && st.end > 0) frac *= 0.3
  return clamp(Math.round(gross * frac), 1, Math.max(1, gross - 1))
}
/** 精明者的压价试探：在"公道价"方案上每人再砍到 ratio 成（和库里固定的七折不同，按人物走） */
function squeezedOffer(gross: number, fair: OfferCandidate | undefined, ratio: number): OfferCandidate | null {
  if (!fair || fair.payouts.length === 0) return null
  const payouts = fair.payouts.map(x => ({ ...x, amount: Math.max(1, Math.round(x.amount * ratio)) }))
  if (JSON.stringify(payouts) === JSON.stringify(fair.payouts)) return null
  const total = payoutTotal(payouts)
  return total >= gross ? null : { ...fair, key: 'haggle', payouts, bossKeep: gross - total }
}

/** 仗义：Boss 有富余时，对"对自己好"的人多分 1~2 块（并说一句交情话） */
function shareWithFriend(
  state: GameState, id: number, choice: { c: OfferCandidate; keep: number }, minKeep: number, p: PersonaParams,
): PlayerAction | null {
  const payees = choice.c.payouts.filter(x => x.amount > 0)
  if (payees.length === 0 || stance(state, id).end > 0) return null
  const surplus = choice.keep - Math.max(minKeep, 1)
  if (surplus < 2) return null
  if (rand(state, 157) >= clamp(p.generous * ctx.style.flex * 0.7, 0, 0.9)) return null
  const friend = [...payees].sort((a, b) => relScore(state, id, b.playerId) - relScore(state, id, a.playerId))[0]
  if (relScore(state, id, friend.playerId) < 1) return null
  const bonus = surplus >= 4 && p.generous > 0.6 ? 2 : 1
  const payouts = choice.c.payouts.map(x => x.playerId === friend.playerId ? { ...x, amount: x.amount + bonus } : x)
  const name = getPlayer(state, friend.playerId)?.name ?? ''
  return { type: 'PROPOSE_OFFER', playerId: id, repKeys: choice.c.repKeys, payouts, say: L(state, id, 'ally', { name }, 159) }
}

/**
 * 没有谁的价能让我在底线之上成交时的出路（按顺序）：
 *   1. 绕开要价最狠的人，换一组代表（找替代）；
 *   2. 至多等一轮，让要价的人掂量；
 *   3. 务实者（flex 高）在最后几次提案里咬牙付；其余人宁可放弃。
 */
function holdOut(
  state: GameState, id: number, scored: { c: OfferCandidate; okAll: boolean; keep: number; value: number }[],
  floor: number, p: PersonaParams,
): PlayerAction {
  const neg = state.negotiation!
  const gross = getGrossValue(state)
  const share = oneShareOf(state)
  const base = selectReps(state)
  const baseOwners = base.complete ? offerOwners(neg, { repKeys: base.repKeys }) : []
  // 要价最狠的人（按他在这组代表里的承诺价总额）
  const askOf = (o: number) => base.repKeys.reduce((s, k) => {
    const r = findRep(neg, k)
    return r && r.ownerId === o ? s + (repPriceOf(neg, r) ?? share) : s
  }, 0)
  const greedy = [...baseOwners].sort((a, b) => askOf(b) - askOf(a))[0]

  // 1. 找替代：排除要价最狠的人
  if (greedy != null) {
    const alt = selectReps(state, { excludeOwners: [greedy] })
    if (alt.complete && JSON.stringify(alt.repKeys) !== JSON.stringify(base.repKeys)) {
      const owners = offerOwners(neg, { repKeys: alt.repKeys })
      const payouts = owners.map(o => ({
        playerId: o,
        amount: Math.max(1, alt.repKeys.reduce((s, k) => {
          const r = findRep(neg, k)
          if (!r || r.ownerId !== o) return s
          const asked = repPriceOf(neg, r)
          return s + (asked != null ? Math.min(asked, share * 2) : share)
        }, 0)),
      }))
      const action: PlayerAction = { type: 'PROPOSE_OFFER', playerId: id, repKeys: alt.repKeys, payouts }
      const candidate: OfferCandidate = { key: 'switch', repKeys: alt.repKeys, payouts, bossKeep: gross - payoutTotal(payouts), needsConsent: true }
      if (candidate.bossKeep >= floor && !offeredBefore(state, id, candidate) && isLegal(state, action)) return action
    }
  }

  // 2. 放话：本轮先晾一晾，要价的人自己会掂量（见 otherTurn 的 3c）
  const flex = p.flex * ctx.style.flex
  const alreadyPassed = currentDealEvents(state).some(e => e.kind === 'PASSED' && e.phase === 'NEGOTIATION' && e.playerId === id)
  if (!alreadyPassed && neg.stalemateRounds === 0 && neg.passStreak < state.players.length - 1 && rand(state, 151) < clamp(0.85 - 0.5 * flex, 0.25, 0.9)) {
    return { type: 'PASS', playerId: id }
  }

  // 3. 最后几次提案：务实者咬牙付（自留至少 1），其余人宁可不做
  const swallow = scored.filter(x => x.okAll && x.keep >= 1).sort((a, b) => b.value - a.value)[0]
  if (swallow && (flex >= 0.45 || swallow.keep >= Math.ceil(floor * 0.5))) {
    return { type: 'PROPOSE_OFFER', playerId: id, repKeys: swallow.c.repKeys, payouts: swallow.c.payouts }
  }
  return { type: 'ABANDON_DEAL', playerId: id, say: L(state, id, 'abandon', {}, 155) }
}

function cardFamily(state: GameState, id: number, cardId: number): FamilyId | undefined {
  return getPlayer(state, id)?.hand.find(c => c.id === cardId)?.familyId
}

/** 只在这张牌入场后有效自有代表真正齐全时，才能说自己独立完成。 */
function bossClanLine(state: GameState, id: number, f: FamilyId | undefined): string {
  const space = getCurrentSpace(state)
  const own = state.negotiation ? playerActiveFamilies(state.negotiation, id) : new Set<FamilyId>()
  if (f) own.add(f)
  const complete = !!space && space.groups.every(g => g.families.filter(family => own.has(family)).length >= g.need)
  return L(state, id, complete ? 'open_solo' : 'clan_self', { fam: f ? FAMILIES[f].name : '这家' }, 47)
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
  let mult = p.askMult * ctx.style.ask
  if (mine.some(f => sole.has(f))) mult *= 1.4                  // 没我凑不齐：抬价
  if (st.blockLeader) mult *= 1 + st.end                        // 落后于领先的 Boss：不便宜给
  if (st.iAmLeader && st.end > 0) mult *= 0.85                  // 我领先：让交易快点成
  // 交情：对 Boss 友好的人少要一点，记仇的人多要一点
  const rel = relScore(state, id, neg.bossId)
  if (rel > 0) mult *= 1 - 0.06 * rel
  else if (rel < 0) mult *= 1 + 0.06 * -rel * (1 + persona(state, id).grudge)
  // 取整：贪婪的人向上取，宽厚的人向下取（同一个报价在不同人嘴里差一块）
  let ask = Math.floor(share * mult + 0.5 + 0.3 * persona(state, id).roundBias)
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

/** 非 Boss 视角：Boss 的最省组合里用了我几个代表，付完别人、保住他的底线后，平均每个能给我多少（给 LLM 的事实） */
export function askBudget(state: GameState, id: number): { perRep: number; reps: number; othersCost: number; bossKeep: number } | null {
  const neg = state.negotiation
  if (!neg || neg.bossId === id) return null
  const sel = selectReps(state)
  const myKeys = sel.complete ? sel.repKeys.filter(k => findRep(neg, k)?.ownerId === id) : []
  if (myKeys.length === 0) return null
  const othersCost = sel.repKeys.reduce((s, k) => { const r = findRep(neg, k); return r && r.ownerId !== id ? s + repCost(state, r) : s }, 0)
  const bossKeep = bossKeepEstimate(state, neg.bossId)
  return { perRep: Math.floor((getGrossValue(state) - othersCost - bossKeep) / myKeys.length), reps: myKeys.length, othersCost, bossKeep }
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
  let chance = base * p.disrupt * ctx.style.disrupt
  if (st.bossIsLeader) chance *= 1.3
  if (st.blockLeader) chance *= 1 + st.end
  if (st.iAmLeader && st.end > 0 && !st.wouldOvertake) chance *= 0.1 // 成交可能让我直接赢：别拦
  // 记仇：坑过我的人（交易历史 + 关系记忆）加倍；对自己人手软
  chance *= 1 + p.grudge * ctx.style.grudge * hostility(state, id, neg.bossId)
  const friend = relScore(state, id, neg.bossId)
  if (friend > 0) chance *= 1 - 0.25 * friend
  return chance
}

/** 本笔 Boss 的等待信号保留到每个人下一次行动，不被中间玩家的 PASS 覆盖。 */
function bossWaitingSinceMyLastTurn(state: GameState, id: number): boolean {
  const bossId = state.negotiation!.bossId
  for (const e of currentDealEvents(state).reverse()) {
    if (e.kind === 'OFFER_PROPOSED' || e.kind === 'BOSS_RESOLVED') return false
    if (e.kind === 'PASSED' && e.phase === 'NEGOTIATION') {
      if (e.playerId === bossId) return true
      if (e.playerId === id) return false
    }
    if ('playerId' in e && e.playerId === id &&
      ['SPEECH', 'DEMAND', 'CLAN_PLAYED', 'OFFER_ACCEPTED', 'OFFER_DECLINED', 'BOSS_PLAYED', 'TRAVEL_PLAYED', 'RECRUITMENT_PLAYED'].includes(e.kind)) return false
  }
  return false
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
  if (clear) return { ...clear, say: L(state, id, 'clear', {}, 139) }

  // 1. 夺权：交易值钱、我当 Boss 也能凑齐，且（被排除/分太少 | 我不用花钱就能独吞 | 拦领先者的终局单）
  const bossOpt = legal.find(a => a.type === 'PLAY_BOSS')
  if (bossOpt && prize >= 9 && canCompleteAsBoss(state, id)) {
    const cost = myBossCost(state, id)
    const strong = !neg.offer && cost <= share && prize - cost >= prize * 0.6
    // 赌徒气质：交易够大，即使没吃亏也想翻盘
    const thrilled = prize >= 12 && rand(state, 173) < p.thrill * ctx.style.disrupt * 0.6
    const reason = (neg.offer && (excluded || underpaid)) || strong || st.blockLeader || thrilled
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
      return { ...a, demand: ask, say: L(state, id, 'clan_fill', { fam: FAMILIES[f].name, ask: ask }, 59) }
    }
    const g = groupOfFamily(space, f)
    const seatedInGroup = !!g && relevantMine.some(x => g.families.includes(x))
    const rivals = activeRepsOfFamily(neg, f).filter(r => r.ownerId !== id && r.ownerId !== neg.bossId)
    if (rivals.length > 0 && !seatedInGroup && !myRepUsed(state, id) && gross >= 8 && rand(state, 13) < 0.5) {
      const rivalMin = Math.min(...rivals.map(r => repPriceOf(neg, r) ?? share))
      const undercut = Math.max(1, Math.min(rivalMin - 1, askPrice(state, id, f)))
      return { ...a, demand: undercut, say: L(state, id, 'undercut', { fam: FAMILIES[f].name, ask: undercut }, 61) }
    }
  }

  // 3. 叫价：有相关代表但还没开价的家族 → 一句话报完，每个家族各按自己的筹码定价（唯一代表抬价、有竞争者压价）
  const canSpeak = legal.some(a => a.type === 'SPEAK')
  const unpriced = relevantMine.filter(f => repPriceOf(neg, { ownerId: id, familyId: f } as Representative) == null)
  if (canSpeak && unpriced.length > 0) {
    const priced = unpriced.map(f => ({ f, ask: askPrice(state, id, f) })).sort((a, b) => b.ask - a.ask)
    // 各家各价，一次说完；已经报过价的家族不动
    const quotes = priced.map(x => ({ familyId: x.f, amount: x.ask }))
    return { type: 'SPEAK', playerId: id, say: quoteLine(state, id, quotes), quotes }
  }

  // 3b. 被竞争者顶掉：主动降价抢回来（一次），只降被顶掉的那一家的价；越有弹性的人越肯降
  if (canSpeak && neg.offer && excluded && relevantMine.length > 0 && rand(state, 61) < 0.2 + 0.5 * p.flex * ctx.style.flex) {
    for (const f of relevantMine) {
      const chosen = neg.offer.repKeys.map(k => findRep(neg, k)).find(r => r?.familyId === f && r.ownerId !== id && r.ownerId !== neg.bossId)
      if (!chosen) continue
      const myAsk = repPriceOf(neg, { ownerId: id, familyId: f } as Representative)
      const rivalPrice = repPriceOf(neg, chosen) ?? Math.max(1, Math.floor(offerShareOf(neg.offer, chosen.ownerId) / Math.max(1, repsUsedOf(neg, neg.offer, chosen.ownerId))))
      const cut = Math.max(1, rivalPrice - 1)
      if (myAsk == null || cut < myAsk) {
        return { type: 'SPEAK', playerId: id, say: L(state, id, 'cut_back', { fam: FAMILIES[f].name, cut }, 63), quotes: [{ familyId: f, amount: cut }] }
      }
    }
  }

  // 3c. Boss 仍在等待且公开总价妨碍保留一份收益：弹性大的代表持有者考虑降价；
  //     没弹性的人（沈 / 周）宁可让这单流掉也不改口
  const bossWaited = bossWaitingSinceMyLastTurn(state, id)
  const selectedCost = selectReps(state).repKeys.reduce((sum, k) => sum + repCost(state, findRep(neg, k)!), 0)
  if (canSpeak && bossWaited && tableCanComplete(state) && selectedCost > gross - share) {
    const flex = p.flex * ctx.style.flex
    for (const f of relevantMine) {
      const myAsk = repPriceOf(neg, { ownerId: id, familyId: f } as Representative)
      if (myAsk == null || myAsk <= Math.max(1, Math.round(share * 0.8))) continue
      if (rand(state, 177) >= 0.25 + 0.6 * flex) continue
      const cut = Math.max(Math.round(share * 0.8), myAsk - Math.max(1, Math.round(myAsk * (0.2 + 0.2 * flex))))
      if (cut < myAsk) return { type: 'SPEAK', playerId: id, say: L(state, id, 'cut_back', { fam: FAMILIES[f].name, cut }, 65), quotes: [{ familyId: f, amount: cut }] }
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
    const say = L(state, id, 'bribe', { ask }, 31)
    return { type: 'SPEAK', playerId: id, say, quotes: [{ amount: ask }] }
  }

  // 7. 跳过（被排除时偶尔放狠话——有牌是威胁，没牌是虚张声势；桌子被独家协议锁了就没牌可威胁）
  const hasTeeth = !isExclusiveLocked(state) && getPlayer(state, id)!.hand.some(c => c.type === 'BOSS' || c.type === 'TRAVEL' || c.type === 'BUST' || c.type === 'SICK')
  if ((excluded || (relevantMine.length === 0 && myShare === 0)) && gross >= 8 && rand(state, 67) < (hasTeeth ? 0.35 : p.bluff * ctx.style.bluff * 0.5)) {
    const hostile = hostility(state, id, neg.bossId) >= 1
    const bossName = getPlayer(state, neg.bossId)?.name ?? ''
    const say = hostile && neg.offer
      ? L(state, id, 'revenge', { name: bossName }, 71)
      : L(state, id, neg.offer ? 'excluded' : 'sidelined', { name: bossName }, 71)
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

/** 应答方案的条件：我的出借价、点头线（含让步 / 终局因素）、最后一轮的低线 */
function responseTerms(state: GameState, id: number) {
  const neg = state.negotiation!
  const p = persona(state, id)
  const st = stance(state, id)
  const share = oneShareOf(state)
  const used = Math.max(1, repsUsedOf(neg, neg.offer!, id))
  // 我对这份方案的承诺价（各家族报价累计）；没报过就按人物心理价
  const committed = commitmentPrice(neg, neg.offer!, id)
  const myAsk = committed != null ? committed / used : Math.round(share * p.askMult * ctx.style.ask)
  const rel = relScore(state, id, neg.bossId)
  const flex = clamp(p.flex * ctx.style.flex, 0, 1)
  // 第 n 次提案时的让步：弹性大的人每轮多让一点（最多约三成）；对 Boss 友好再让一点，记仇的不让
  const round = Math.max(0, neg.offersMade - 1)
  let relief = 1 - flex * 0.08 * round
  relief *= rel > 0 ? 1 - 0.05 * rel : 1 + 0.06 * -rel * p.grudge
  let threshold = Math.max(1, Math.round(myAsk * p.acceptMult * ctx.style.accept * Math.max(0.55, relief))) * used
  if (st.blockLeader) threshold = Math.round(threshold * (1 + st.end))
  if (st.iAmLeader && st.end > 0 && !st.wouldOvertake) threshold = 1 // 成交就可能赢：给钱就点头
  // 最后一次提案：怕一拍流局，接受"自己报价的一部分"——部分多少看弹性（沈 / 周几乎不让；陆 / 程肯让到约一半），
  // 相对自己的报价而不是相对一份分红，所以拿小钱的人不会被白嫖（旧版"只要有半份就接"可被唯一代表的 Boss 利用）
  const last = Math.max(1, Math.round(myAsk * (1 - 0.5 * flex) * (1 + 0.05 * Math.max(0, -rel)))) * used
  return { neg, used, myAsk, rel, flex, threshold, last }
}

/** 他人当 Boss 时大致不肯低于的自留（按人物底线估，不含桌风：这是对别人的估计） */
export function bossKeepEstimate(state: GameState, bossId: number): number {
  const gross = getGrossValue(state)
  return clamp(Math.round(gross * persona(state, bossId).floor), 1, Math.max(1, gross - 1))
}

/**
 * 拒绝之后我还剩什么：
 *   · replace —— Boss 绕开我换用别人的代表要多花多少（没有替代则 Infinity）。分给我的钱不低于它，拒绝只会把位置让给对手；
 *   · cap     —— Boss 在保住自己底线的前提下最多还能给我多少。我的要价超过它，坚持只会流局。
 */
export function outsideOption(state: GameState, id: number): { replace: number; cap: number } {
  const neg = state.negotiation!
  const offer = neg.offer!
  const gross = getGrossValue(state)
  const costOf = (keys: string[]) => keys.reduce((s, k) => { const r = findRep(neg, k); return r && r.ownerId !== id ? s + repCost(state, r) : s }, 0)
  const alt = selectReps(state, { excludeOwners: [id] })
  const replace = alt.complete ? Math.max(0, costOf(alt.repKeys) - costOf(offer.repKeys)) : Infinity
  const others = offer.payouts.filter(x => x.playerId !== id).reduce((s, x) => s + x.amount, 0)
  const cap = Math.max(0, gross - others - bossKeepEstimate(state, neg.bossId))
  return { replace, cap }
}

function respond(state: GameState, id: number): PlayerAction {
  const { neg, used, myAsk, flex, threshold, last } = responseTerms(state, id)
  const myShare = offerShareOf(neg.offer, id)
  if (myShare >= threshold) return { type: 'ACCEPT_OFFER', playerId: id }
  if (neg.offersMade >= MAX_OFFERS_PER_BOSS - 1 && myShare >= last) return { type: 'ACCEPT_OFFER', playerId: id }
  // 反报价是每个代表的出借价（通用价：方案所用的我的每个家族同价）；每轮略降，但不低于当前方案之上 1 块
  const counterAsk = Math.max(1, Math.round(myAsk * Math.max(0.6, 1 - flex * 0.08 * neg.offersMade)))
  const counter = Math.max(counterAsk, Math.floor(myShare / used) + 1)
  return { type: 'DECLINE_OFFER', playerId: id, quotes: [{ amount: Math.min(counter, Math.max(1, Math.floor((getGrossValue(state) - 1) / used))) }] }
}

// ---------- 给 LLM 的"性格参考价位" ----------

/** 由人物参数 / 桌风 / 关系推导出的数字参考；LLM 看到它，但保留偏离的自由 */
export interface DecisionHints {
  /** 报价参考：每个相关家族的性格价（已含唯一代表加价、竞争压价） */
  asks?: { familyId: FamilyId; amount: number }[]
  /** 报价的"白送线"：低于它基本等于送钱 */
  askFloor?: number
  /** Boss：自留底线（低于它宁可压价 / 换代表 / 放弃） */
  keepFloor?: number
  /** Boss：舒服的自留额 */
  keepGood?: number
  /** 应答：每个代表的心理价、点头线（本方案合计）、当前方案分给我的钱 */
  accept?: { perRep: number; threshold: number; offered: number }
}

export function decisionHints(state: GameState, id: number, style: TableStyle = 'business'): DecisionHints {
  const neg = state.negotiation
  if (!neg || getActingPlayerId(state) !== id) return {}
  ctx.style = STYLE_PARAMS[style]
  ctx.state = state; ctx.rels = new Map()
  const share = oneShareOf(state)
  const gross = getGrossValue(state)
  if (state.phase === 'OFFER_RESPONSE' && neg.offer) {
    const t = responseTerms(state, id)
    return { accept: { perRep: Math.round(t.myAsk), threshold: t.threshold, offered: offerShareOf(neg.offer, id) } }
  }
  if (state.phase !== 'NEGOTIATION') return {}
  if (neg.bossId === id) {
    const p = persona(state, id)
    const st = stance(state, id)
    const floor = bossFloor(gross, st, p)
    const minKeep = st.iAmLeader && st.end > 0 ? Math.max(1, Math.round(share * (1 - st.end))) : Math.max(share, Math.round(gross * 0.3))
    return { keepFloor: floor, keepGood: Math.min(gross - 1, Math.max(minKeep, floor)) }
  }
  const space = getCurrentSpace(state)
  if (!space) return {}
  const mine = [...playerActiveFamilies(neg, id)].filter(f => groupOfFamily(space, f))
  if (mine.length === 0) return {}
  return {
    asks: mine.map(f => ({ familyId: f, amount: askPrice(state, id, f) })),
    askFloor: Math.max(1, Math.round(share * 0.7)),
  }
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
  // 对出牌人的态度：坑过我的人，我更舍得拦；自己人出的牌，我手更软（r 越小越容易拦）
  const rs = relScore(state, id, pr.actorId)
  const r = rand(state, 37) * (rs < 0 ? 1 + 0.12 * rs * Math.max(0.5, p.grudge) : 1 + 0.15 * rs)

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
// 台词全部来自 lines.ts 的人物台词库（按情境 × 人物，确定性挑选、避开最近说过的话），
// 所以 LLM 失败 / 降级时说话的仍是同一个人。

/** 一句话报完所有家族的价（SPEAK / 打家族卡前的叫价都用它） */
export function quoteLine(state: GameState, id: number, quotes: { familyId?: FamilyId; amount: number }[]): string {
  if (quotes.length === 0) return L(state, id, 'chat', {}, 17)
  if (quotes.every(q => !q.familyId)) return L(state, id, 'bribe', { ask: quotes[0].amount }, 17)
  const priced = quotes.filter(q => q.familyId)
  const soleSet = new Set(soleRepFamilies(state, id))
  const sole = priced.some(q => soleSet.has(q.familyId!))
  const allSame = priced.every(q => q.amount === priced[0].amount)
  if (allSame) {
    const fam = priced.map(q => FAMILIES[q.familyId!].name).join('/')
    return L(state, id, sole ? 'ask_sole' : 'ask_rival', { fam, ask: priced[0].amount }, 17)
  }
  const list = priced.map(q => `${FAMILIES[q.familyId!].name} $${q.amount}M`).join('、')
  return L(state, id, 'ask_multi', { list }, 17)
}

/** 启发式玩家的随口台词；空串表示沉默 */
export function heuristicSpeech(state: GameState, action: PlayerAction): string {
  const id = action.playerId
  const r = rand(state, 43)
  const neg = state.negotiation
  const bossName = neg ? getPlayer(state, neg.bossId)?.name ?? '' : ''
  const nameOf = (pid: number | undefined) => (pid == null ? '' : getPlayer(state, pid)?.name ?? '')
  switch (action.type) {
    case 'OPEN_DEAL': {
      const space = getCurrentSpace(state)
      if (!space) return ''
      const est = estimateDeal(state, id, space)
      if (est.buyCount === 0) return L(state, id, 'open_solo')
      const fams = missingForBoss(state, id, space).map(f => FAMILIES[f].name).join('、')
      return L(state, id, 'open_need', { fams })
    }
    case 'PLAY_BOSS': {
      // 夺的是坑过我的人的权 → 带点私怨；拦领先者 → 拦的话
      if (neg && hostility(state, id, neg.bossId) >= 1 && r < 0.6) return L(state, id, 'revenge', { name: bossName })
      if (neg && stance(state, id).blockLeader) return L(state, id, 'trail', { name: bossName })
      return L(state, id, 'boss_play', { name: bossName })
    }
    case 'PLAY_TRAVEL': {
      const rep = neg ? findRep(neg, action.targetRepKey) : undefined
      const name = nameOf(rep?.ownerId)
      if (rep && hostility(state, id, rep.ownerId) >= 1 && r < 0.6) return L(state, id, 'revenge', { name })
      return L(state, id, 'travel', { name, fam: rep ? FAMILIES[rep.familyId].name : '' })
    }
    case 'PLAY_RECRUITMENT':
      return L(state, id, canReclaim(state, id, action.targetFamilyId) ? 'reclaim' : action.cardIds.length < 3 ? 'headhunt' : 'recruit', { fam: FAMILIES[action.targetFamilyId].name })
    case 'PLAY_BOOM': return L(state, id, 'boom')
    case 'PLAY_BUST': return L(state, id, neg && stance(state, id).blockLeader ? 'trail' : 'bust', { name: bossName })
    case 'PLAY_EXCLUSIVE': return L(state, id, 'exclusive')
    case 'PLAY_SICK': return L(state, id, 'sick', { name: nameOf(action.targetPlayerId) })
    case 'PLAY_CLAN': {
      const f = cardFamily(state, id, action.cardId)
      const fam = f ? FAMILIES[f].name : '这家'
      if (neg && neg.bossId === id) return bossClanLine(state, id, f)
      return L(state, id, action.demand != null ? 'clan_fill' : 'undercut', { fam, ask: action.demand })
    }
    case 'SWAP_CARD': return L(state, id, 'swap')
    case 'BUY_CARDS': return L(state, id, 'buy')
    case 'TRADE_CARDS': return L(state, id, 'trade')
    case 'PLAY_STOP': return L(state, id, 'stop')
    case 'ACCEPT_OFFER': {
      if (neg && relScore(state, id, neg.bossId) >= 1 && r < 0.6) return L(state, id, 'ally', { name: bossName })
      if (stance(state, id).iAmLeader && stance(state, id).end > 0 && r < 0.5) return L(state, id, 'lead')
      return L(state, id, 'accept')
    }
    case 'DECLINE_OFFER': return L(state, id, 'decline', { counter: action.quotes?.[0]?.amount })
    case 'CLOSE_DEAL': return L(state, id, stance(state, id).iAmLeader && stance(state, id).end > 0 && r < 0.5 ? 'lead' : 'close')
    case 'ABANDON_DEAL': return L(state, id, stance(state, id).end > 0 && r < 0.4 ? 'abandon_end' : 'abandon')
    case 'SPEAK': return action.quotes ? quoteLine(state, id, action.quotes) : L(state, id, 'chat')
    case 'PROPOSE_OFFER': {
      if (!neg) return ''
      const paid = action.payouts.filter(p => p.amount > 0)
      const owners = offerOwners(neg, action)
      if (owners.length === 0) return L(state, id, 'propose_solo')
      if (paid.length === 0) {
        if (owners.every(o => commitmentPrice(neg, action, o) === 0)) {
          return L(state, id, 'propose_fair', { parts: owners.map(o => `${nameOf(o)} 按免费承诺 $0M`).join('、') })
        }
        return L(state, id, 'propose_favor', { names: owners.map(nameOf).join('、') })
      }
      const parts = paid.map(p => `${nameOf(p.playerId)} $${p.amount}M`).join('、')
      const lowball = owners.some(o => { const ask = commitmentPrice(neg, action, o); return ask != null && (action.payouts.find(x => x.playerId === o)?.amount ?? 0) < ask })
      if (neg.offersMade === 0 && lowball) return L(state, id, 'haggle', { parts })
      return L(state, id, lowball ? 'propose_low' : 'propose_fair', { parts })
    }
    case 'PASS': case 'PASS_CLOSING': case 'PASS_REACTION':
      return ''
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
