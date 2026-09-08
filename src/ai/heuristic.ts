// ============================================================
// 启发式策略 — 不依赖 LLM，任何局面都能立刻给出合法动作。
// 既是"无 LLM"模式下的电脑玩家，也是 LLM 失败 / 超时时的兜底。
// 决策只依赖状态（随机数由 stateVersion 派生），仿真可复现。
// ============================================================

import type { GameState, PlayerAction, FamilyId, BoardSpace } from '../engine/types'
import { FAMILIES, MAX_OFFERS_PER_BOSS } from '../engine/config'
import {
  getPlayer, getCurrentSpace, getGrossValue, oneShareOf, spaceInvestorCount,
  selectReps, tableCanComplete, canCompleteAlone, playerCoverableFamilies, playerActiveFamilies,
  activeRepsOfFamily, findRep, offerShareOf, offerOwners, demandOf,
  familyDemandOnBoard, groupOfFamily,
} from '../engine/rules'
import { getActingPlayerId, getLegalActions, isLegal, buildOfferCandidates, canClose } from '../engine/validator'
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
}

export const PERSONA_PARAMS: Record<string, PersonaParams> = {
  greedy: { askMult: 1.5, acceptMult: 0.9, disrupt: 0.5, protect: 0.7, bribe: true },
  grudge: { askMult: 1.1, acceptMult: 1.0, disrupt: 0.9, protect: 0.6, bribe: true },
  steady: { askMult: 1.0, acceptMult: 0.7, disrupt: 0.2, protect: 0.85, bribe: false },
  smile: { askMult: 1.2, acceptMult: 0.8, disrupt: 0.5, protect: 0.7, bribe: true },
  stingy: { askMult: 1.3, acceptMult: 0.9, disrupt: 0.7, protect: 0.5, bribe: true },
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
function estimateDeal(state: GameState, id: number, space: BoardSpace): { feasible: boolean; buyCount: number } {
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
  const minProfit = Math.max(4, gross * 0.3)
  if (afterMove && hand <= 4 && expectedProfit < gross * 0.6) return false // 手牌太少先补牌
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
  let best: PlayerAction | null = null
  let bestScore = -Infinity
  for (const a of options) {
    if (a.type !== 'PLAY_RECRUITMENT') continue
    const f = a.targetFamilyId
    const owner = state.investors.find(i => i.familyId === f)?.ownerId
    let score = freq[f] * 2
    if (owner === richest.id && owner !== id) score += 1.5
    if (state.negotiation && groupOfFamily(getCurrentSpace(state)!, f)) score += 2
    if (score > bestScore) { bestScore = score; best = a }
  }
  return best
}

// ---------- Boss ----------

function bossTurn(state: GameState, id: number, legal: PlayerAction[]): PlayerAction {
  const neg = state.negotiation!
  const gross = getGrossValue(state)
  const share = oneShareOf(state)

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

  if (neg.offersMade >= MAX_OFFERS_PER_BOSS) return { type: 'ABANDON_DEAL', playerId: id }
  const candidates = buildOfferCandidates(state)
  if (candidates.length === 0) return { type: 'ABANDON_DEAL', playerId: id }

  // 预测每个方案会不会被接受：对方分得 ≥ 其报价（没报价按一份分红的 8 折）即认为会接受
  const minKeep = Math.max(share, Math.round(gross * 0.3))
  const scored = candidates.map(c => {
    const owners = offerOwners(neg, c)
    const okAll = owners.every(o => {
      const asked = demandOf(neg, o) ?? Math.round(share * 0.8)
      const got = c.payouts.find(p => p.playerId === o)?.amount ?? 0
      return got >= asked * (persona(state, o).acceptMult * 0.95)
    })
    return { c, okAll, keep: c.bossKeep }
  })
  const acceptable = scored.filter(x => x.okAll && x.keep >= Math.min(minKeep, gross - 1)).sort((a, b) => b.keep - a.keep)
  const choice = acceptable[0] ?? (neg.offersMade === 0 ? scored.sort((a, b) => b.keep - a.keep).find(x => x.keep >= minKeep) : null)
  if (!choice) return { type: 'ABANDON_DEAL', playerId: id }
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

function askPrice(state: GameState, id: number): number {
  const neg = state.negotiation!
  const space = getCurrentSpace(state)!
  const share = oneShareOf(state)
  const p = persona(state, id)
  const mine = playerActiveFamilies(neg, id)
  // 杠杆：某个必需家族只有我一个有效代表 → 抬价
  let leverage = 1
  for (const f of mine) {
    const g = groupOfFamily(space, f)
    if (!g) continue
    const others = activeRepsOfFamily(neg, f).filter(r => r.ownerId !== id).length
    const alternatives = g.families.filter(x => x !== f && activeRepsOfFamily(neg, x).length > 0).length
    if (others === 0 && alternatives < g.need) leverage = Math.max(leverage, 1.4)
  }
  const gross = getGrossValue(state)
  return Math.max(1, Math.min(gross - 1, Math.round(share * p.askMult * leverage)))
}

function canCompleteAsBoss(state: GameState, id: number): boolean {
  return selectReps(state, { preferOwner: id }).complete
}

function myRepUsed(state: GameState, id: number): boolean {
  const neg = state.negotiation!
  return !!neg.offer && neg.offer.repKeys.some(k => findRep(neg, k)?.ownerId === id)
}

function otherTurn(state: GameState, id: number, legal: PlayerAction[]): PlayerAction {
  const neg = state.negotiation!
  const space = getCurrentSpace(state)!
  const gross = getGrossValue(state)
  const share = oneShareOf(state)
  const p = persona(state, id)
  const myShare = offerShareOf(neg.offer, id)
  const mine = playerActiveFamilies(neg, id)
  const relevantMine = [...mine].filter(f => groupOfFamily(space, f))
  const richest = [...state.players].sort((a, b) => b.cash - a.cash)[0]
  const bossIsLeader = richest.id === neg.bossId && richest.cash > (getPlayer(state, id)!.cash + 5)
  const pass = (): PlayerAction => ({ type: 'PASS', playerId: id })

  // 1. 夺权：交易值钱、我当 Boss 也能凑齐、现在分给我的太少
  const bossOpt = legal.find(a => a.type === 'PLAY_BOSS')
  if (bossOpt && gross >= 9 && myShare < share && canCompleteAsBoss(state, id) && rand(state, 11) < 0.45 + p.disrupt * 0.4 + (bossIsLeader ? 0.15 : 0)) {
    return bossOpt
  }

  // 2. 打家族卡：补缺口（能拿钱），或与竞争者抢单
  for (const a of legal) {
    if (a.type !== 'PLAY_CLAN') continue
    const f = cardFamily(state, id, a.cardId)!
    if (isFamilyMissing(state, f)) {
      const ask = askPrice(state, id)
      return { ...a, demand: ask, say: `${FAMILIES[f].name}的人我有，$${ask}M 就出场。` }
    }
    const rivals = activeRepsOfFamily(neg, f).filter(r => r.ownerId !== id && r.ownerId !== neg.bossId)
    if (rivals.length > 0 && !myRepUsed(state, id) && gross >= 8 && rand(state, 13) < 0.5) {
      const rivalMin = Math.min(...rivals.map(r => demandOf(neg, r.ownerId) ?? share))
      const undercut = Math.max(1, Math.min(rivalMin - 1, askPrice(state, id)))
      return { ...a, demand: undercut, say: `别找他，我的${FAMILIES[f].name}只要 $${undercut}M。` }
    }
  }

  // 3. 报价：有相关代表但还没开价
  const canSpeak = legal.some(a => a.type === 'SPEAK')
  if (canSpeak && relevantMine.length > 0 && demandOf(neg, id) == null) {
    const ask = askPrice(state, id)
    const fam = relevantMine.map(f => FAMILIES[f].name).join('/')
    const say = pick([`想用我的${fam}？$${ask}M，一口价。`, `${fam}这边可以谈，我要 $${ask}M。`, `$${ask}M，少一分我不出人。`], rand(state, 17))
    return { type: 'SPEAK', playerId: id, say, demand: ask, demandFamily: relevantMine[0] }
  }

  // 4. 被排除 / 被压价：搅局
  const excluded = neg.offer ? !myRepUsed(state, id) && myShare === 0 : false
  if ((excluded || (relevantMine.length === 0 && myShare === 0)) && gross >= 8) {
    const disruptChance = p.disrupt * (bossIsLeader ? 1.3 : 1) * (neg.offer ? 1 : 0.5)
    if (rand(state, 19) < disruptChance) {
      const travel = bestTravel(state, id, legal)
      if (travel) return travel
    }
  }

  // 5. 招募：长期资产，手里有三连就找机会用
  const recruit = bestRecruit(state, id, legal)
  if (recruit && rand(state, 23) < 0.7) return recruit

  // 6. 封口费：没代表也想分一口
  if (canSpeak && relevantMine.length === 0 && demandOf(neg, id) == null && p.bribe && gross >= 12 && rand(state, 29) < 0.4) {
    const ask = Math.max(1, Math.round(share * 0.5))
    const say = pick([`我手里有牌，$${ask}M 买个安静怎么样？`, `分我 $${ask}M，我保证不捣乱。`], rand(state, 31))
    return { type: 'SPEAK', playerId: id, say, demand: ask }
  }

  return pass()
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
  const share = oneShareOf(state)
  const myShare = offerShareOf(neg.offer, id)
  const myAsk = demandOf(neg, id) ?? Math.round(share * p.askMult)
  const threshold = Math.max(1, Math.round(myAsk * p.acceptMult))
  if (myShare >= threshold) return { type: 'ACCEPT_OFFER', playerId: id }
  if (neg.offersMade >= MAX_OFFERS_PER_BOSS - 1 && myShare >= Math.max(1, Math.round(share * 0.5))) return { type: 'ACCEPT_OFFER', playerId: id }
  const counter = Math.max(threshold, myShare + 1)
  return { type: 'DECLINE_OFFER', playerId: id, counter: Math.min(counter, getGrossValue(state) - 1) }
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
  const r = rand(state, 37)

  if (pr.kind === 'TRAVEL' && neg) {
    const rep = findRep(neg, pr.targetRepKey!)
    if (!rep) return pass
    const inOffer = !!neg.offer?.repKeys.includes(rep.key)
    if (rep.ownerId === id && (inOffer || demandOf(neg, id) != null)) return r < p.protect ? stop : pass
    if (iAmBoss && inOffer && canClose(state)) return r < p.protect + 0.1 ? stop : pass
    if (myShare > 0 && inOffer) return r < p.protect * 0.8 ? stop : pass
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
  const p = persona(state, id)
  const gross = getGrossValue(state)
  const myShare = offerShareOf(neg.offer, id)
  const pass: PlayerAction = { type: 'PASS_CLOSING', playerId: id }
  if (myShare > 0) return pass
  const richest = [...state.players].sort((a, b) => b.cash - a.cash)[0]
  const bossIsLeader = richest.id === neg.bossId && richest.cash > getPlayer(state, id)!.cash
  const chance = p.disrupt * (bossIsLeader ? 1.3 : 0.8) * (gross >= 12 ? 1 : 0.6)
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
  switch (action.type) {
    case 'OPEN_DEAL': return pick(['Let\'s make a deal！这单我做。', '这笔生意我接了，各位开个价。', '有人想入伙吗？我当 Boss。'], r)
    case 'PLAY_BOSS': return pick(['I\'m the Boss！这单换我做主。', '让一让，现在我是老板。'], r)
    case 'PLAY_TRAVEL': return pick(['不好意思，有人得出个差。', '这位投资人临时有事，走不开。'], r)
    case 'PLAY_RECRUITMENT': return pick(['来，这位投资人跟我走。', '挖个人，不介意吧？'], r)
    case 'PLAY_STOP': return pick(['想都别想！', '这招对我没用。'], r)
    case 'ACCEPT_OFFER': return pick(['成交，我同意出人。', '这个价可以，合作愉快。'], r)
    case 'DECLINE_OFFER': return action.counter != null ? `这价不行，$${action.counter}M 才谈。` : '这价钱我不干。'
    case 'CLOSE_DEAL': return pick(['Going once, going twice… 成交！', '没人有意见？那就这么定了。'], r)
    case 'ABANDON_DEAL': return pick(['算了，这单不做了。', '要价太狠，我不玩了。'], r)
    case 'PROPOSE_OFFER': return pick(['方案在这，都看看。', '我出个价，愿意的就点头。'], r)
    default: return ''
  }
}
