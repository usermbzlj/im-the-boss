// ============================================================
// I'm the Boss! — 游戏引擎（纯 reducer）
//
// 谈判流程（官方规则的回合制近似，模拟真实桌面的"叫价 → 拼盘 → 落锤"）：
//   OPEN_DEAL → NEGOTIATION 叫价轮：Boss 左手边起轮流出牌 / 喊话报价 / 跳过，Boss 在
//   第一轮末位行动（听完叫价再拼方案）；之后继续轮转，Boss 轮到时可提案
//   PROPOSE_OFFER → 报价即承诺：方案付到某人公开报价的，自动视为同意；其余被选用代表的
//   持有者进入 OFFER_RESPONSE 依次同意 / 拒绝（拒绝可反报价 = 更新承诺价）→ 回到 Boss
//   CLOSE_DEAL（须方案全员同意）→ CLOSING（"going once, going twice"：其他人依次
//   可打干扰牌或放行）→ 全员放行即结算；有牌生效则回到谈判
//   旅行 / 招募 / 老板 / 利好 / 利空 / 独家协议牌打出后进入 REACTION，按座位顺序逐个询问其他玩家是否打阻止牌
//   （无阻止牌者只能放行；询问所有人是为了不暴露谁持有阻止牌）；方案被打掉则回合回到 Boss
//   黑市格的交易没有反应窗口：牌打出即生效
//
// 扩展规则（变体与特殊格见 config.ts / docs/rules.md §10）：
//   · 夺回权：最后一位常驻投资者被招募夺走 → 1 张招募牌即可抢回该家族
//   · 猎头格：交易进行中招募只需 2 张；地标格：成交归 Boss，此后每笔成交收 $1M 租金
//   · 抢手格：股价 +$1M/份；利好 / 利空牌改变本笔股价；独家协议锁定本笔交易
// 桌规（state.houseRules，开局可选；docs/rules.md §10.5）：
//   · 互换：持有某家族投资者时，手中该家族的成员牌可换成同家族旅行牌（反向亦可），每回合一次
//   · 买牌：自己回合开单前付 1 / 3 / 6 份股价抽 1 / 2 / 3 张，每回合一次，不得超出手牌上限
//   · 兑换：两张不同种类的牌 + 一份股价 → 2 张招募牌，每回合一次，不可逆（钱付给银行）
//   · 病假牌：指定一人本回合不能主动出牌（进反应窗口，可被阻止牌取消）
//   · 桌上凑不齐代表且全员跳过一轮 → 直接流局，不再多等
//
// 契约：
//   · reducer 只接受通过 validator.isLegal 的动作；被拒绝的动作原样返回旧状态
//   · 每个被接受的动作 stateVersion + 1；所有随机性来自 state.rng（可复现）
//   · 引擎不产生任何文案，只记录 GameEvent；文字由 text/ 层渲染
// ============================================================

import type {
  GameState, GameAction, PlayerAction, Player, InfluenceCard, Negotiation, Offer, GameVariantId,
  GameEvent, FamilyId, Payout, Representative, RepRef, ReactionKind, FailReason, Quote, ResolvedQuote, TurnFlags,
} from './types'
import {
  FAMILY_IDS, AI_ROSTER,
  HAND_LIMIT, CARDS_PER_DRAW, STARTING_HAND, MAX_STALEMATE_ROUNDS, MAX_EVENTS,
  LANDMARK_RENT, BOOM_BONUS, BUST_PENALTY, MIN_SHARE_VALUE, PREMIUM_BONUS, TRADE_RECRUIT_COUNT,
  getVariant, buildBoard, makeDealTiles, createDeckFor, shuffleWith, rollDieWith, randomSeed,
} from './config'
import {
  getPlayer, nextPlayerId, prevPlayerId, othersFrom, getSpace, getCurrentTile,
  getGrossValue, effectiveShareValue, offerOwners, findRep, selectReps, investorRepKey, clanRepKey, payoutTotal, meetsCommitment,
  playerRelevantFamilies, usedFamiliesOf, resolveQuotes, recruitCost, isBlackMarketDeal, landlords,
  tableCanComplete, swapTargetType, buyCardsCost, tradeCost, countCards, settlePayouts,
  missingFamilies, acceptedCommitments, closeDealMode,
} from './rules'
import { isLegal } from './validator'

export const SAVE_VERSION = 10

export interface StartOptions {
  variantId?: GameVariantId
  /** 桌规开关；省略则按变体默认（经典关、其余开） */
  houseRules?: boolean
}

const emptyTurn = (): TurnFlags => ({ swapped: [], bought: [], traded: [], sick: [] })

// ---------- 工具 ----------

/**
 * 记录事件。交易进行中（s.negotiation 存在）的事件自动带 dealNo = 第几次开单（成交 / 流局都占号，
 * 与 dealHistory 下标 + 1 一致）。成交 / 流局记入 dealHistory 之后再发的事件须显式传入 dealNo。
 */
function emit(s: GameState, event: GameEvent, dealNo: number | undefined = s.negotiation ? s.dealHistory.length + 1 : undefined) {
  s.events.push({ id: s.nextId++, ...event, ...(dealNo != null ? { dealNo } : {}) })
  if (s.events.length > MAX_EVENTS) s.events = s.events.slice(-MAX_EVENTS)
}

const repRef = (r: Representative): RepRef => ({ familyId: r.familyId, ownerId: r.ownerId, source: r.source })

function clanCard(rep: Representative): InfluenceCard {
  return { id: rep.cardId!, type: 'CLAN', familyId: rep.familyId }
}

function drawCards(s: GameState, playerId: number, count: number) {
  const player = getPlayer(s, playerId)
  if (!player) return
  for (let i = 0; i < count; i++) {
    if (s.drawPile.length === 0) {
      if (s.discardPile.length === 0) break
      s.drawPile = shuffleWith(s, s.discardPile)
      s.discardPile = []
      emit(s, { kind: 'DECK_RESHUFFLED', size: s.drawPile.length })
    }
    player.hand.push(s.drawPile.pop()!)
  }
}

/** 从手牌移出指定牌（不进弃牌堆），返回移出的牌 */
function takeFromHand(player: Player, cardIds: number[]): InfluenceCard[] {
  const taken: InfluenceCard[] = []
  for (const id of cardIds) {
    const idx = player.hand.findIndex(c => c.id === id)
    if (idx >= 0) taken.push(player.hand.splice(idx, 1)[0])
  }
  return taken
}

/**
 * 从抽牌堆（先）/ 弃牌堆（后）里找出符合条件的牌——互换 / 兑换用。
 * 调用方须先用 validator 确认数量足够；牌堆里的顺序对任何人都是未知的，从底部取不泄露信息。
 */
function fetchFromPiles(s: GameState, pred: (c: InfluenceCard) => boolean, count: number): InfluenceCard[] {
  const out: InfluenceCard[] = []
  for (const pile of [s.drawPile, s.discardPile]) {
    for (let i = 0; i < pile.length && out.length < count; ) {
      if (pred(pile[i])) out.push(pile.splice(i, 1)[0])
      else i++
    }
  }
  return out
}

/** 付钱给银行（买牌 / 兑换）：这些钱离开游戏，现金守恒时以 bank 计 */
function payBank(s: GameState, player: Player, amount: number) {
  player.cash -= amount
  s.bank += amount
}

function endTurn(s: GameState, fromId: number) {
  s.currentId = nextPlayerId(s, fromId)
  s.phase = 'TURN'
  s.lastDie = null
  s.turn = emptyTurn()
}

function clearSpeeches(s: GameState) {
  for (const p of s.players) p.lastSpeech = undefined
}

function say(s: GameState, playerId: number, text: string | undefined) {
  const player = getPlayer(s, playerId)
  const clean = (text ?? '').trim().slice(0, 120)
  if (!player || !clean) return
  player.lastSpeech = clean
  if (s.negotiation) s.negotiation.speeches.push({ id: s.nextId++, playerId, text: clean })
  emit(s, { kind: 'SPEECH', playerId, text: clean })
}

const MAX_NOTES = 8
const NOTE_MAX_LEN = 80

/** 电脑玩家的私人笔记：不发事件、不进日志，只留在它自己的状态里 */
function remember(s: GameState, playerId: number, text: string | undefined) {
  const player = getPlayer(s, playerId)
  const clean = (text ?? '').trim().slice(0, NOTE_MAX_LEN)
  if (!player || !clean) return
  player.notes.push(clean)
  if (player.notes.length > MAX_NOTES) player.notes.splice(0, player.notes.length - MAX_NOTES)
}

/**
 * 记录公开报价（每个代表的出借价）：一次动作里可以给每个家族各报各的价。
 * scope 是本次报价的作用域（喊话 = 我在本格的相关家族；反报价 = 方案所用的我的家族）；
 * 通用价补到作用域内未单独报价的家族，作用域为空时通用价就是封口费。
 * 同一玩家对不同家族的价互不影响。quiet：只更新承诺、不发事件（同意方案 / 拒绝时用，由调用方自己叙述）。
 */
function applyQuotes(s: GameState, playerId: number, quotes: Quote[], scope: FamilyId[], quiet = false): ResolvedQuote[] {
  const neg = s.negotiation
  if (!neg) return []
  const resolved = resolveQuotes(quotes, scope)
  for (const { amount, familyIds } of resolved) {
    if (familyIds.length === 0) {
      neg.demands = neg.demands.filter(d => !(d.playerId === playerId && d.familyId == null))
      neg.demands.push({ playerId, amount })
    } else {
      neg.demands = neg.demands.filter(d => !(d.playerId === playerId && d.familyId != null && familyIds.includes(d.familyId)))
      for (const familyId of familyIds) neg.demands.push({ playerId, amount, familyId })
    }
  }
  if (!quiet && resolved.length > 0) emit(s, { kind: 'DEMAND', playerId, quotes: resolved })
  return resolved
}

function markDisruptor(neg: Negotiation, playerId: number) {
  if (playerId !== neg.bossId && !neg.disruptors.includes(playerId)) neg.disruptors.push(playerId)
}

// ---------- 初始化 ----------

export function createInitialState(playerCount: number, humanName: string, seed?: number, variantId?: GameVariantId, opts: StartOptions = {}): GameState {
  const count = Math.min(6, Math.max(3, playerCount))
  const variant = getVariant(variantId ?? opts.variantId)
  const houseRules = opts.houseRules ?? variant.houseRules
  const holder = { rng: seed ?? randomSeed() }
  const roster = shuffleWith(holder, AI_ROSTER)

  const players: Player[] = [{ id: 0, name: humanName.trim() || '你', isAI: false, cash: 0, hand: [], notes: [] }]
  for (let i = 1; i < count; i++) {
    const entry = roster[(i - 1) % roster.length]
    players.push({ id: i, name: entry.name, isAI: true, cash: 0, hand: [], personaId: entry.personaId, notes: [] })
  }

  // 投资者牌随机分配：3 人各 2 张；4/5 人各 1 张、余下放公共区；6 人各 1 张
  const shuffledFamilies = shuffleWith(holder, FAMILY_IDS)
  const investors = shuffledFamilies.map((familyId, idx) => ({
    familyId,
    ownerId: count === 3 ? Math.floor(idx / 2) : idx < count ? idx : null,
  }))

  const drawPile = shuffleWith(holder, createDeckFor(variant, houseRules))
  for (const p of players) for (let j = 0; j < STARTING_HAND; j++) p.hand.push(drawPile.pop()!)

  // 起始玩家：持有字母序最靠前投资者的人（投资者已随机分配，等价于随机起始）；其右手边玩家放置金钱标记
  let startId = 0
  for (const f of FAMILY_IDS) {
    const inv = investors.find(i => i.familyId === f && i.ownerId !== null)
    if (inv) { startId = inv.ownerId!; break }
  }

  const s: GameState = {
    saveVersion: SAVE_VERSION,
    variantId: variant.id,
    houseRules,
    turn: emptyTurn(),
    bank: 0,
    phase: 'PLACE_MARKER',
    players,
    investors,
    board: buildBoard(variant.spaces),
    dealTiles: makeDealTiles(variant.deals, variant.maxShare),
    dealTileIndex: 0,
    drawPile,
    discardPile: [],
    markerPos: 1,
    currentId: startId,
    markerChooserId: 0,
    completedDeals: 0,
    negotiation: null,
    pendingReaction: null,
    dealHistory: [],
    events: [],
    lastDie: null,
    winnerIds: [],
    stateVersion: 1,
    rng: holder.rng,
    nextId: 1,
  }
  s.markerChooserId = prevPlayerId(s, startId)
  emit(s, { kind: 'GAME_STARTED', playerCount: count, startPlayerId: startId, markerChooserId: s.markerChooserId, variantId: variant.id, deals: variant.deals })
  return s
}

/** 金钱标记顺时针移到下一个未关闭格（版图长度由变体决定） */
function advanceMarker(s: GameState) {
  const n = s.board.length
  for (let i = 0; i < n; i++) {
    s.markerPos = (s.markerPos % n) + 1
    if (getSpace(s, s.markerPos)!.closedByTileId == null) return
  }
}

// ---------- 谈判 ----------

function openNegotiation(s: GameState, bossId: number) {
  const space = getSpace(s, s.markerPos)!
  const neg: Negotiation = {
    spaceId: space.id,
    bossId,
    openerId: bossId,
    reps: [],
    travelledInvestors: [],
    offer: null,
    offersMade: 0,
    // 叫价轮：Boss 开单后先听桌上叫价（左手边起），自己在第一轮末位行动再出方案
    turnId: nextPlayerId(s, bossId),
    passStreak: 0,
    stalemateRounds: 0,
    speeches: [],
    demands: [],
    speakCounts: {},
    responseQueue: [],
    responseIndex: 0,
    closingOrder: [],
    closingIndex: 0,
    disruptors: [],
    priceDelta: 0,
    exclusive: false,
  }
  for (const inv of s.investors) {
    if (inv.ownerId === null) continue
    neg.reps.push({ key: investorRepKey(inv.familyId), familyId: inv.familyId, source: 'INVESTOR', ownerId: inv.ownerId, travelled: false })
  }
  s.negotiation = neg
  s.phase = 'NEGOTIATION'
  clearSpeeches(s)
  emit(s, { kind: 'DEAL_OPENED', playerId: bossId, spaceId: space.id, gross: getGrossValue(s) })
}

/**
 * 反应窗口按座位顺序询问出牌者以外的所有玩家（无阻止牌者只能放行）。
 * 不按"是否持有阻止牌"筛选，否则窗口是否出现本身就泄露了手牌信息。
 */
function nextReactor(s: GameState, from: number, exclude: Set<number>): number | null {
  const n = s.players.length
  for (let i = 1; i <= n; i++) {
    const id = (from + i) % n
    if (!exclude.has(id)) return id
  }
  return null
}

function beginReaction(s: GameState, actorId: number, kind: ReactionKind, cards: InfluenceCard[], target: { targetRepKey?: string; targetFamilyId?: FamilyId; targetPlayerId?: number }) {
  const returnPhase = s.phase === 'HAND_LIMIT' || s.phase === 'CLOSING' || s.phase === 'TURN' || s.phase === 'AFTER_MOVE' ? s.phase : 'NEGOTIATION'
  if (s.negotiation) markDisruptor(s.negotiation, actorId)
  s.pendingReaction = {
    actorId, kind, cards, reactorId: -1, askedIds: [actorId], returnPhase,
    targetRepKey: target.targetRepKey, targetFamilyId: target.targetFamilyId, targetPlayerId: target.targetPlayerId,
  }
  s.phase = 'REACTION'
  // 黑市：没有反应窗口，牌打出即生效（也就没有阻止牌的用武之地）
  if (isBlackMarketDeal(s) && returnPhase !== 'HAND_LIMIT') {
    emit(s, { kind: 'BLACK_MARKET', actorId, card: kind })
    resolveReaction(s)
    return
  }
  const first = nextReactor(s, actorId, new Set([actorId]))
  if (first === null) resolveReaction(s)
  else s.pendingReaction.reactorId = first
}

function voidOfferIfTouched(s: GameState, repKey: string, reason: 'TRAVELLED' | 'RECRUITED') {
  const neg = s.negotiation
  if (!neg?.offer) return
  if (neg.offer.repKeys.includes(repKey)) {
    neg.offer = null
    emit(s, { kind: 'OFFER_VOIDED', reason })
  }
}

/** 反应窗口里那张牌的目标快照（事件用；代表随后可能失效 / 易主，所以在生效前取） */
function reactionTarget(s: GameState, pr: NonNullable<GameState['pendingReaction']>): { targetRep?: RepRef; targetFamilyId?: FamilyId; targetPlayerId?: number } {
  const out: { targetRep?: RepRef; targetFamilyId?: FamilyId; targetPlayerId?: number } = {}
  const rep = pr.targetRepKey && s.negotiation ? findRep(s.negotiation, pr.targetRepKey) : undefined
  if (rep) out.targetRep = repRef(rep)
  if (pr.targetFamilyId) out.targetFamilyId = pr.targetFamilyId
  if (pr.targetPlayerId != null) out.targetPlayerId = pr.targetPlayerId
  return out
}

function resolveReaction(s: GameState) {
  const pr = s.pendingReaction!
  const neg = s.negotiation
  const hadOffer = !!neg?.offer
  const target = reactionTarget(s, pr)

  if (pr.kind === 'TRAVEL' && neg) {
    const rep = findRep(neg, pr.targetRepKey!)
    if (rep && !rep.travelled) {
      rep.travelled = true
      if (rep.source === 'CLAN') s.discardPile.push(clanCard(rep))
      else neg.travelledInvestors.push(rep.familyId)
      emit(s, { kind: 'TRAVEL_RESOLVED', target: repRef(rep) })
      voidOfferIfTouched(s, rep.key, 'TRAVELLED')
    }
    s.discardPile.push(...pr.cards)
  } else if (pr.kind === 'BOSS' && neg) {
    const previous = neg.bossId
    neg.bossId = pr.actorId
    neg.offer = null
    neg.offersMade = 0
    neg.stalemateRounds = 0
    neg.passStreak = 0
    // 夺权成功：新 Boss 不再是本笔交易的"干扰者"（他现在是主人，不该被记仇 / 计入干扰名单）
    neg.disruptors = neg.disruptors.filter(id => id !== pr.actorId)
    s.discardPile.push(...pr.cards)
    emit(s, { kind: 'BOSS_RESOLVED', playerId: pr.actorId, previousBossId: previous })
  } else if (pr.kind === 'RECRUITMENT') {
    const f = pr.targetFamilyId!
    const inv = s.investors.find(i => i.familyId === f)!
    const fromId = inv.ownerId
    inv.ownerId = pr.actorId
    s.discardPile.push(...pr.cards)
    emit(s, { kind: 'RECRUITMENT_RESOLVED', playerId: pr.actorId, familyId: f, fromId })
    // 重新有了常驻投资者 → 夺回权用掉 / 失效
    const actor = getPlayer(s, pr.actorId)
    if (actor?.reclaim) actor.reclaim = null
    // 被夺走的是对方最后一位常驻投资者 → 他获得夺回权（1 张招募牌即可抢回这个家族）
    if (fromId != null && !s.investors.some(i => i.ownerId === fromId)) {
      const victim = getPlayer(s, fromId)
      if (victim) {
        victim.reclaim = f
        emit(s, { kind: 'RECLAIM_GRANTED', playerId: fromId, familyId: f })
      }
    }
    if (neg) {
      const key = investorRepKey(f)
      const rep = findRep(neg, key)
      if (rep) rep.ownerId = pr.actorId
      else neg.reps.push({ key, familyId: f, source: 'INVESTOR', ownerId: pr.actorId, travelled: neg.travelledInvestors.includes(f) })
      voidOfferIfTouched(s, key, 'RECRUITED')
    }
  } else if ((pr.kind === 'BOOM' || pr.kind === 'BUST') && neg) {
    // 一张一张结算，下限在每张牌之后套，不能先把加减加总再封底（否则下限吃掉的利空会抵消后面的利好）
    const before = effectiveShareValue(s)
    const nominal = pr.kind === 'BOOM' ? BOOM_BONUS : -BUST_PENALTY
    const after = Math.max(MIN_SHARE_VALUE, before + nominal)
    const tile = getCurrentTile(s)!
    const space = getSpace(s, neg.spaceId)!
    const base = tile.shareValue + (space.kind === 'PREMIUM' ? PREMIUM_BONUS : 0)
    neg.priceDelta = after - base
    s.discardPile.push(...pr.cards)
    emit(s, { kind: 'PRICE_CHANGED', playerId: pr.actorId, delta: after - before, gross: getGrossValue(s) })
  } else if (pr.kind === 'EXCLUSIVE' && neg) {
    neg.exclusive = true
    s.discardPile.push(...pr.cards)
    emit(s, { kind: 'EXCLUSIVE_RESOLVED', playerId: pr.actorId })
  } else if (pr.kind === 'SICK') {
    const target = pr.targetPlayerId!
    if (!s.turn.sick.includes(target)) s.turn.sick.push(target)
    s.discardPile.push(...pr.cards)
    emit(s, { kind: 'SICK_RESOLVED', playerId: pr.actorId, targetId: target })
  } else {
    s.discardPile.push(...pr.cards)
  }
  afterReaction(s, false, hadOffer && !s.negotiation?.offer, target)
}

/** Boss 自己打的"拼方案"牌（利好 / 独家协议 / 病假）：窗口结束后回合仍在 Boss，他紧接着就该提案 / 成交 */
const BOSS_OWN_KINDS = new Set<ReactionKind>(['BOOM', 'EXCLUSIVE', 'SICK'])

/**
 * 反应窗口结束后回到原阶段。
 * 谈判中：方案被打掉 → 回合直接回到 Boss（他要立刻重新拿出方案）；否则出牌者的下一位继续。
 * 开单前（TURN / AFTER_MOVE）打出的病假牌：行动者继续自己的回合。
 * 倒计时里的病假牌不改变方案，倒计时不重来：同一位玩家继续（可放行）。
 */
function afterReaction(s: GameState, cancelled: boolean, offerVoided = false, target: { targetRep?: RepRef; targetFamilyId?: FamilyId } = {}) {
  const pr = s.pendingReaction!
  s.pendingReaction = null
  const neg = s.negotiation
  if (pr.returnPhase === 'TURN' || pr.returnPhase === 'AFTER_MOVE') {
    s.phase = pr.returnPhase
    s.currentId = pr.actorId
    return
  }
  if (pr.returnPhase === 'HAND_LIMIT' || !neg) {
    const actor = getPlayer(s, pr.actorId)!
    s.currentId = pr.actorId
    if (actor.hand.length > HAND_LIMIT) {
      s.phase = 'HAND_LIMIT'
      emit(s, { kind: 'HAND_LIMIT', playerId: actor.id, handSize: actor.hand.length })
    } else {
      endTurn(s, pr.actorId)
    }
    return
  }
  if (pr.returnPhase === 'CLOSING') {
    if (cancelled || pr.kind === 'SICK') {
      s.phase = 'CLOSING' // 同一位玩家仍可继续出牌或放行
      return
    }
    neg.closingOrder = []
    neg.closingIndex = 0
    neg.passStreak = 0
    neg.turnId = neg.bossId
    s.phase = 'NEGOTIATION'
    emit(s, { kind: 'CLOSING_INTERRUPTED', by: pr.kind, actorId: pr.actorId, ...target })
    return
  }
  s.phase = 'NEGOTIATION'
  neg.passStreak = 0
  if (!cancelled && pr.kind === 'BOSS') neg.turnId = pr.actorId
  else if (offerVoided) neg.turnId = neg.bossId
  else if (pr.actorId === neg.bossId && BOSS_OWN_KINDS.has(pr.kind)) neg.turnId = neg.bossId
  else neg.turnId = nextPlayerId(s, pr.actorId)
}

/**
 * 应答推进到下一位。endNow：有人拒绝即方案作废、回到 Boss（docs/rules.md §9），
 * 后面排队的人不再被询问，也不会再改写自己的承诺价。
 */
function advanceResponse(s: GameState, endNow = false) {
  const neg = s.negotiation!
  neg.responseIndex = endNow ? neg.responseQueue.length : neg.responseIndex + 1
  if (neg.responseIndex < neg.responseQueue.length) return
  s.phase = 'NEGOTIATION'
  neg.turnId = neg.bossId
  neg.passStreak = 0
  const offer = neg.offer
  if (!offer) return
  const declinerIds = offerOwners(neg, offer).filter(id => offer.responses[id] === 'DECLINED')
  emit(s, { kind: 'OFFER_RESOLVED', agreed: declinerIds.length === 0, declinerIds })
}

function finalizeDeal(s: GameState) {
  const neg = s.negotiation!
  const offer = neg.offer!
  const space = getSpace(s, neg.spaceId)!
  const tile = getCurrentTile(s)!
  const gross = getGrossValue(s)
  const boss = getPlayer(s, neg.bossId)!

  boss.cash += gross
  // 分成合计可能因利空牌超过总额：按总额封顶（docs/rules.md §10.4）
  let paid = 0
  const finalPayouts: Payout[] = []
  for (const p of settlePayouts(offer.payouts, gross, boss.id)) {
    const to = getPlayer(s, p.playerId)
    if (!to) continue
    boss.cash -= p.amount
    to.cash += p.amount
    paid += p.amount
    finalPayouts.push(p)
  }

  // 被选用的家族卡弃置；未选用且未被打飞的回手
  for (const rep of neg.reps) {
    if (rep.source !== 'CLAN' || rep.travelled) continue
    if (offer.repKeys.includes(rep.key)) s.discardPile.push(clanCard(rep))
    else getPlayer(s, rep.ownerId)?.hand.push(clanCard(rep))
  }

  space.closedByTileId = tile.id
  s.dealTileIndex++
  s.completedDeals++

  // 地标：先给已有的地标主人发租金，再把这一格记到本笔 Boss 名下（本格的租金从下一笔起算）
  const rents: Payout[] = []
  for (const { ownerId } of landlords(s)) {
    const owner = getPlayer(s, ownerId)
    if (!owner) continue
    owner.cash += LANDMARK_RENT
    const line = rents.find(r => r.playerId === ownerId)
    if (line) line.amount += LANDMARK_RENT
    else rents.push({ playerId: ownerId, amount: LANDMARK_RENT })
  }
  if (space.kind === 'LANDMARK') {
    space.landlordId = boss.id
    emit(s, { kind: 'LANDMARK_CLAIMED', playerId: boss.id, spaceId: space.id })
  }

  s.dealHistory.push({
    id: s.nextId++, dealNumber: s.completedDeals, spaceId: space.id, bossId: neg.bossId, openerId: neg.openerId,
    success: true, grossValue: gross, payouts: finalPayouts, rents, disruptors: [...neg.disruptors],
  })
  const dealNo = s.dealHistory.length // 刚记入历史：本笔就是第 dealNo 次开单
  const usedReps = offer.repKeys.map(k => findRep(neg, k)).filter((r): r is Representative => !!r).map(repRef)
  emit(s, { kind: 'DEAL_CLOSED', dealNumber: s.completedDeals, spaceId: space.id, tileId: tile.id, bossId: boss.id, gross, payouts: finalPayouts, bossKeep: gross - paid, reps: usedReps }, dealNo)
  if (rents.length) emit(s, { kind: 'RENT_PAID', payments: rents }, dealNo)

  // 金钱标记移到顺时针下一个未关闭格
  advanceMarker(s)

  const bossId = neg.bossId
  s.negotiation = null
  clearSpeeches(s)

  if (s.completedDeals >= s.dealTiles.length) {
    finishGame(s)
  } else if (tile.endFaces.length > 0) {
    s.phase = 'END_ROLL'
    s.currentId = bossId
    s.lastDie = null
    emit(s, { kind: 'END_ROLL_DUE', playerId: bossId, faces: [...tile.endFaces] })
  } else {
    endTurn(s, bossId)
  }
}

function failDeal(s: GameState, reason: FailReason) {
  const neg = s.negotiation!
  for (const rep of neg.reps) {
    if (rep.source === 'CLAN' && !rep.travelled) getPlayer(s, rep.ownerId)?.hand.push(clanCard(rep))
  }
  s.dealHistory.push({
    id: s.nextId++, dealNumber: s.completedDeals + 1, spaceId: neg.spaceId, bossId: neg.bossId, openerId: neg.openerId,
    success: false, grossValue: getGrossValue(s), payouts: [], rents: [], disruptors: [...neg.disruptors], failReason: reason,
  })
  emit(s, {
    kind: 'DEAL_FAILED', spaceId: neg.spaceId, bossId: neg.bossId, reason,
    ...(reason === 'INCOMPLETE' ? { missing: missingFamilies(s) } : {}),
  }, s.dealHistory.length)
  const bossId = neg.bossId
  s.negotiation = null
  s.pendingReaction = null
  clearSpeeches(s)
  endTurn(s, bossId)
}

function finishGame(s: GameState) {
  s.phase = 'GAME_OVER'
  const max = Math.max(...s.players.map(p => p.cash))
  s.winnerIds = s.players.filter(p => p.cash === max).map(p => p.id)
  emit(s, { kind: 'GAME_OVER', winnerIds: [...s.winnerIds], cash: max })
}

// ---------- reducer ----------

export function gameReducer(state: GameState | null, action: GameAction): GameState | null {
  if (action.type === 'START_GAME') return createInitialState(action.playerCount, action.humanName, action.seed, action.variantId, { houseRules: action.houseRules })
  if (action.type === 'LOAD_GAME') return action.state.saveVersion === SAVE_VERSION ? structuredClone(action.state) : state
  if (!state) return state
  if (!isLegal(state, action)) return state

  const s = structuredClone(state)
  s.stateVersion++
  apply(s, action)
  return s
}

function apply(s: GameState, action: PlayerAction) {
  const neg = s.negotiation
  const player = getPlayer(s, action.playerId)!

  // 台词先落地（SPEAK 的主体就是台词；其他动作可附带一句）。
  // 反应窗口的放行保持沉默：只有持阻止牌者才真正在"决定"，说话会暴露手牌。
  if (action.type !== 'PASS_REACTION') say(s, player.id, action.say)
  remember(s, player.id, action.note)
  // 僵局只数"连续"的全员跳过：除了跳过 / 放行，任何实质行动（喊话 / 出牌 / 提案 / 应答 / 宣布成交…）都把停滞轮数清零
  if (neg && action.type !== 'PASS' && action.type !== 'PASS_CLOSING' && action.type !== 'PASS_REACTION') neg.stalemateRounds = 0

  switch (action.type) {
    case 'PLACE_MARKER':
      s.markerPos = action.spaceId
      s.markerChooserId = null
      s.phase = 'TURN'
      emit(s, { kind: 'MARKER_PLACED', playerId: player.id, spaceId: action.spaceId, nextPlayerId: s.currentId })
      return

    case 'OPEN_DEAL':
      openNegotiation(s, player.id)
      return

    case 'ROLL_MOVE': {
      const die = rollDieWith(s)
      s.lastDie = die
      for (let moved = 0; moved < die; moved++) advanceMarker(s)
      s.phase = 'AFTER_MOVE'
      emit(s, { kind: 'MARKER_MOVED', playerId: player.id, die, spaceId: s.markerPos, gross: getGrossValue(s) })
      return
    }

    case 'DRAW_CARDS':
      drawCards(s, player.id, CARDS_PER_DRAW)
      emit(s, { kind: 'CARDS_DRAWN', playerId: player.id, count: CARDS_PER_DRAW, handSize: player.hand.length })
      if (player.hand.length > HAND_LIMIT) {
        s.phase = 'HAND_LIMIT'
        emit(s, { kind: 'HAND_LIMIT', playerId: player.id, handSize: player.hand.length })
      } else {
        endTurn(s, player.id)
      }
      return

    case 'DISCARD':
      s.discardPile.push(...takeFromHand(player, action.cardIds))
      emit(s, { kind: 'CARDS_DISCARDED', playerId: player.id, count: action.cardIds.length })
      endTurn(s, player.id)
      return

    case 'PLAY_CLAN': {
      const [card] = takeFromHand(player, [action.cardId])
      neg!.reps.push({ key: clanRepKey(card.id), familyId: card.familyId!, source: 'CLAN', ownerId: player.id, cardId: card.id, travelled: false })
      emit(s, { kind: 'CLAN_PLAYED', playerId: player.id, familyId: card.familyId! })
      if (action.demand != null) applyQuotes(s, player.id, [{ familyId: card.familyId!, amount: action.demand }], [card.familyId!])
      neg!.passStreak = 0
      // Boss 打自己的家族卡是在"拼方案"，紧接着就该提案 / 成交，不必等一整圈；别人打卡则轮到下一位
      neg!.turnId = player.id === neg!.bossId ? player.id : nextPlayerId(s, player.id)
      return
    }

    case 'PLAY_TRAVEL': {
      const cards = takeFromHand(player, [action.cardId])
      const rep = findRep(neg!, action.targetRepKey)!
      emit(s, { kind: 'TRAVEL_PLAYED', playerId: player.id, wildcard: !cards[0].familyId, target: repRef(rep) })
      beginReaction(s, player.id, 'TRAVEL', cards, { targetRepKey: rep.key })
      return
    }

    case 'PLAY_RECRUITMENT': {
      const cost = recruitCost(s, player.id, action.targetFamilyId)
      const cards = takeFromHand(player, action.cardIds)
      const fromId = s.investors.find(i => i.familyId === action.targetFamilyId)?.ownerId ?? null
      emit(s, { kind: 'RECRUITMENT_PLAYED', playerId: player.id, familyId: action.targetFamilyId, fromId, cost })
      beginReaction(s, player.id, 'RECRUITMENT', cards, { targetFamilyId: action.targetFamilyId })
      return
    }

    case 'PLAY_BOSS': {
      const cards = takeFromHand(player, [action.cardId])
      emit(s, { kind: 'BOSS_PLAYED', playerId: player.id, bossId: neg!.bossId })
      beginReaction(s, player.id, 'BOSS', cards, {})
      return
    }

    case 'PLAY_BOOM': {
      const cards = takeFromHand(player, [action.cardId])
      emit(s, { kind: 'BOOM_PLAYED', playerId: player.id })
      beginReaction(s, player.id, 'BOOM', cards, {})
      return
    }

    case 'PLAY_BUST': {
      const cards = takeFromHand(player, [action.cardId])
      emit(s, { kind: 'BUST_PLAYED', playerId: player.id })
      beginReaction(s, player.id, 'BUST', cards, {})
      return
    }

    case 'PLAY_EXCLUSIVE': {
      const cards = takeFromHand(player, [action.cardId])
      emit(s, { kind: 'EXCLUSIVE_PLAYED', playerId: player.id })
      beginReaction(s, player.id, 'EXCLUSIVE', cards, {})
      return
    }

    case 'PLAY_SICK': {
      const cards = takeFromHand(player, [action.cardId])
      emit(s, { kind: 'SICK_PLAYED', playerId: player.id, targetId: action.targetPlayerId })
      beginReaction(s, player.id, 'SICK', cards, { targetPlayerId: action.targetPlayerId })
      return
    }

    case 'SWAP_CARD': {
      // 家族成员 ↔ 同家族旅行牌：交出的牌进弃牌堆，从抽牌堆 / 弃牌堆找一张对应的牌回手。牌数守恒，回合不轮转
      const [card] = takeFromHand(player, [action.cardId])
      const to = swapTargetType(card)!
      const [got] = fetchFromPiles(s, c => c.type === to && c.familyId === card.familyId, 1)
      s.discardPile.push(card)
      player.hand.push(got)
      s.turn.swapped.push(player.id)
      emit(s, { kind: 'CARD_SWAPPED', playerId: player.id, familyId: card.familyId!, to })
      return
    }

    case 'BUY_CARDS': {
      const cost = buyCardsCost(s, action.count)
      payBank(s, player, cost)
      drawCards(s, player.id, action.count)
      s.turn.bought.push(player.id)
      emit(s, { kind: 'CARDS_BOUGHT', playerId: player.id, count: action.count, cost, handSize: player.hand.length })
      return
    }

    case 'TRADE_CARDS': {
      const given = takeFromHand(player, action.cardIds)
      const cost = tradeCost(s)
      payBank(s, player, cost)
      player.hand.push(...fetchFromPiles(s, c => c.type === 'RECRUITMENT', TRADE_RECRUIT_COUNT))
      s.discardPile.push(...given)
      s.turn.traded.push(player.id)
      emit(s, { kind: 'CARDS_TRADED', playerId: player.id, given: given.map(c => c.type), cost, recruitCount: countCards(player.hand, 'RECRUITMENT') })
      return
    }

    case 'PLAY_STOP': {
      const pr = s.pendingReaction!
      const stop = player.hand.splice(player.hand.findIndex(c => c.type === 'STOP'), 1)[0]
      s.discardPile.push(stop, ...pr.cards)
      emit(s, { kind: 'STOP_PLAYED', playerId: player.id, actorId: pr.actorId, cancelled: pr.kind, ...reactionTarget(s, pr) })
      afterReaction(s, true)
      return
    }

    case 'PASS_REACTION': {
      const pr = s.pendingReaction!
      emit(s, { kind: 'PASSED', playerId: player.id, phase: 'REACTION' })
      pr.askedIds.push(player.id)
      const next = nextReactor(s, player.id, new Set(pr.askedIds))
      if (next === null) resolveReaction(s)
      else pr.reactorId = next
      return
    }

    case 'SPEAK':
      neg!.speakCounts[player.id] = (neg!.speakCounts[player.id] ?? 0) + 1
      // 一次说完：每个相关家族各自的出借价；通用价补到没单独报的家族；没有相关代表 → 封口费
      if (action.quotes?.length) applyQuotes(s, player.id, action.quotes, playerRelevantFamilies(s, player.id))
      neg!.passStreak = 0
      neg!.turnId = nextPlayerId(s, player.id)
      return

    case 'PASS':
      emit(s, { kind: 'PASSED', playerId: player.id, phase: 'NEGOTIATION' })
      neg!.passStreak++
      if (neg!.passStreak >= s.players.length) {
        // 桌上凑不齐代表、又没人愿意补（全员跳过一轮）：再转几圈也不会有结果，直接流局
        if (!tableCanComplete(s)) {
          failDeal(s, 'INCOMPLETE')
          return
        }
        neg!.passStreak = 0
        neg!.stalemateRounds++
        if (neg!.stalemateRounds >= MAX_STALEMATE_ROUNDS) {
          failDeal(s, 'STALEMATE')
          return
        }
        emit(s, { kind: 'STALEMATE_ROUND', rounds: neg!.stalemateRounds, max: MAX_STALEMATE_ROUNDS })
      }
      neg!.turnId = nextPlayerId(s, player.id)
      return

    case 'PROPOSE_OFFER': {
      const payouts = action.payouts.filter(p => p.amount > 0)
      neg!.offersMade++
      const offer: Offer = { id: s.nextId++, bossId: player.id, repKeys: [...action.repKeys], payouts, responses: {} }
      neg!.offer = offer
      neg!.passStreak = 0
      const owners = offerOwners(neg!, offer)
      // 报价即承诺：方案付到某人的公开报价，他按约视为同意，不再询问
      const autoAccepted = othersFrom(s, player.id).filter(id => owners.includes(id) && meetsCommitment(neg!, offer, id))
      const order = othersFrom(s, player.id).filter(id => owners.includes(id) && !autoAccepted.includes(id))
      emit(s, {
        kind: 'OFFER_PROPOSED', bossId: player.id, offerNo: neg!.offersMade,
        reps: action.repKeys.map(k => findRep(neg!, k)).filter((r): r is Representative => !!r).map(repRef),
        payouts, bossKeep: getGrossValue(s) - payoutTotal(payouts), waitingFor: order, autoAccepted,
      })
      for (const id of autoAccepted) {
        offer.responses[id] = 'ACCEPTED'
        emit(s, { kind: 'OFFER_ACCEPTED', playerId: id, auto: true })
      }
      if (order.length === 0) {
        // 无需他人表态（只用自己的代表 / 全部按承诺价自动同意）：Boss 可直接宣布成交
        if (owners.length > 0) emit(s, { kind: 'OFFER_RESOLVED', agreed: true, declinerIds: [] })
        neg!.turnId = player.id
        return
      }
      neg!.responseQueue = order
      neg!.responseIndex = 0
      s.phase = 'OFFER_RESPONSE'
      return
    }

    case 'ACCEPT_OFFER': {
      const offer = neg!.offer!
      offer.responses[player.id] = 'ACCEPTED'
      emit(s, { kind: 'OFFER_ACCEPTED', playerId: player.id })
      // 点头就是承诺：所用家族的新价之和 = 实付（将来同一组代表付同样总额即自动同意），
      // 不抬高任何家族的价、尽量保留原有价差、取整数（算法见 rules.acceptedCommitments）
      const changes = acceptedCommitments(neg!, offer, player.id)
      if (changes.length > 0) {
        applyQuotes(s, player.id, changes.map(c => ({ familyId: c.familyId, amount: c.to })), usedFamiliesOf(neg!, offer, player.id), true)
        emit(s, { kind: 'COMMITMENT_UPDATED', playerId: player.id, changes })
      }
      advanceResponse(s)
      return
    }

    case 'DECLINE_OFFER': {
      neg!.offer!.responses[player.id] = 'DECLINED'
      // 反报价是对"方案里用到的我的代表"（每个）的出借价，可按家族分别给；不是封口费
      const counters = action.quotes?.length ? applyQuotes(s, player.id, action.quotes, usedFamiliesOf(neg!, neg!.offer!, player.id), true) : []
      emit(s, { kind: 'OFFER_DECLINED', playerId: player.id, counters })
      advanceResponse(s, true)
      return
    }

    case 'CLOSE_DEAL': {
      if (closeDealMode(s) === 'SOLO') {
        // 只用自己的代表直接成交（没有方案，或旧方案已无效 / 被拒绝而被搁置）：不算一次提案，也不付任何人。
        // 倒计时被打断、方案作废也不扣次数
        neg!.offer = { id: s.nextId++, bossId: player.id, repKeys: selectReps(s).repKeys, payouts: [], responses: {} }
      }
      neg!.closingOrder = othersFrom(s, player.id)
      neg!.closingIndex = 0
      s.phase = 'CLOSING'
      emit(s, { kind: 'CLOSING_STARTED', bossId: player.id })
      if (neg!.closingOrder.length === 0) finalizeDeal(s) // 没有别人可放行（单人局）→ 直接结算
      return
    }

    case 'PASS_CLOSING':
      emit(s, { kind: 'PASSED', playerId: player.id, phase: 'CLOSING' })
      neg!.closingIndex++
      if (neg!.closingIndex >= neg!.closingOrder.length) finalizeDeal(s)
      return

    case 'ABANDON_DEAL':
      failDeal(s, 'ABANDONED')
      return

    case 'ROLL_END': {
      const die = rollDieWith(s)
      s.lastDie = die
      const tile = s.dealTiles[s.dealTileIndex - 1]
      const hit = tile.endFaces.includes(die)
      emit(s, { kind: 'END_ROLL', playerId: player.id, die, hit })
      if (hit) finishGame(s)
      else endTurn(s, player.id)
      return
    }
  }
}
