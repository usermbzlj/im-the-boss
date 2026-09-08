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
//   旅行 / 招募 / 老板牌打出后进入 REACTION，按座位顺序逐个询问其他玩家是否打阻止牌
//   （无阻止牌者只能放行；询问所有人是为了不暴露谁持有阻止牌）；方案被打掉则回合回到 Boss
//
// 契约：
//   · reducer 只接受通过 validator.isLegal 的动作；被拒绝的动作原样返回旧状态
//   · 每个被接受的动作 stateVersion + 1；所有随机性来自 state.rng（可复现）
//   · 引擎不产生任何文案，只记录 GameEvent；文字由 text/ 层渲染
// ============================================================

import type {
  GameState, GameAction, PlayerAction, Player, InfluenceCard, Negotiation, Offer,
  GameEvent, FamilyId, Payout, Representative, RepRef, ReactionKind, FailReason,
} from './types'
import {
  FAMILY_IDS, BOARD_SPACES, DEAL_TILES, AI_ROSTER,
  HAND_LIMIT, CARDS_PER_DRAW, STARTING_HAND, TOTAL_DEALS, MAX_STALEMATE_ROUNDS, MAX_EVENTS,
  createInfluenceDeck, shuffleWith, rollDieWith, randomSeed,
} from './config'
import {
  getPlayer, nextPlayerId, prevPlayerId, othersFrom, getSpace, getCurrentTile,
  getGrossValue, offerOwners, findRep, selectReps, investorRepKey, clanRepKey, payoutTotal, offerShareOf, meetsCommitment, repsUsedOf,
  commitmentPrice, playerRelevantFamilies,
} from './rules'
import { isLegal } from './validator'

export const SAVE_VERSION = 7

// ---------- 工具 ----------

function emit(s: GameState, event: GameEvent) {
  s.events.push({ id: s.nextId++, ...event })
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

function endTurn(s: GameState, fromId: number) {
  s.currentId = nextPlayerId(s, fromId)
  s.phase = 'TURN'
  s.lastDie = null
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
 * 记录公开报价（每个代表的出借价）。familyIds 为空 = 通用价/封口费；否则覆盖这些家族各自的报价。
 * 同一玩家可以对不同家族报不同价，互不影响。quiet：只更新承诺、不发事件（同意方案时用）。
 */
function setDemand(s: GameState, playerId: number, amount: number, familyIds: FamilyId[], quiet = false) {
  const neg = s.negotiation
  if (!neg) return
  if (familyIds.length === 0) {
    neg.demands = neg.demands.filter(d => !(d.playerId === playerId && d.familyId == null))
    neg.demands.push({ playerId, amount })
  } else {
    neg.demands = neg.demands.filter(d => !(d.playerId === playerId && d.familyId != null && familyIds.includes(d.familyId)))
    for (const familyId of familyIds) neg.demands.push({ playerId, amount, familyId })
  }
  if (!quiet) emit(s, { kind: 'DEMAND', playerId, amount, familyIds })
}

/** 方案中用到的、属于该玩家的代表所属家族（去重） */
function usedFamiliesOf(neg: Negotiation, offer: Pick<Offer, 'repKeys'>, playerId: number): FamilyId[] {
  const out: FamilyId[] = []
  for (const k of offer.repKeys) {
    const r = findRep(neg, k)
    if (r && r.ownerId === playerId && !out.includes(r.familyId)) out.push(r.familyId)
  }
  return out
}

function markDisruptor(neg: Negotiation, playerId: number) {
  if (playerId !== neg.bossId && !neg.disruptors.includes(playerId)) neg.disruptors.push(playerId)
}

// ---------- 初始化 ----------

export function createInitialState(playerCount: number, humanName: string, seed?: number): GameState {
  const count = Math.min(6, Math.max(3, playerCount))
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

  const drawPile = shuffleWith(holder, createInfluenceDeck())
  for (const p of players) for (let j = 0; j < STARTING_HAND; j++) p.hand.push(drawPile.pop()!)

  // 起始玩家：持有字母序最靠前投资者的人（投资者已随机分配，等价于随机起始）；其右手边玩家放置金钱标记
  let startId = 0
  for (const f of FAMILY_IDS) {
    const inv = investors.find(i => i.familyId === f && i.ownerId !== null)
    if (inv) { startId = inv.ownerId!; break }
  }

  const s: GameState = {
    saveVersion: SAVE_VERSION,
    phase: 'PLACE_MARKER',
    players,
    investors,
    board: BOARD_SPACES.map(b => ({ ...b, groups: b.groups.map(g => ({ ...g, families: [...g.families] })), closedByTileId: null })),
    dealTiles: DEAL_TILES.map(t => ({ ...t, endFaces: [...t.endFaces] })),
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
  emit(s, { kind: 'GAME_STARTED', playerCount: count, startPlayerId: startId, markerChooserId: s.markerChooserId })
  return s
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

function beginReaction(s: GameState, actorId: number, kind: ReactionKind, cards: InfluenceCard[], target: { targetRepKey?: string; targetFamilyId?: FamilyId }) {
  const returnPhase = s.phase === 'HAND_LIMIT' ? 'HAND_LIMIT' : s.phase === 'CLOSING' ? 'CLOSING' : 'NEGOTIATION'
  if (s.negotiation) markDisruptor(s.negotiation, actorId)
  s.pendingReaction = {
    actorId, kind, cards, reactorId: -1, askedIds: [actorId], returnPhase,
    targetRepKey: target.targetRepKey, targetFamilyId: target.targetFamilyId,
  }
  s.phase = 'REACTION'
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

function resolveReaction(s: GameState) {
  const pr = s.pendingReaction!
  const neg = s.negotiation
  const hadOffer = !!neg?.offer

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
    s.discardPile.push(...pr.cards)
    emit(s, { kind: 'BOSS_RESOLVED', playerId: pr.actorId, previousBossId: previous })
  } else if (pr.kind === 'RECRUITMENT') {
    const f = pr.targetFamilyId!
    const inv = s.investors.find(i => i.familyId === f)!
    const fromId = inv.ownerId
    inv.ownerId = pr.actorId
    s.discardPile.push(...pr.cards)
    emit(s, { kind: 'RECRUITMENT_RESOLVED', playerId: pr.actorId, familyId: f, fromId })
    if (neg) {
      const key = investorRepKey(f)
      const rep = findRep(neg, key)
      if (rep) rep.ownerId = pr.actorId
      else neg.reps.push({ key, familyId: f, source: 'INVESTOR', ownerId: pr.actorId, travelled: neg.travelledInvestors.includes(f) })
      voidOfferIfTouched(s, key, 'RECRUITED')
    }
  } else {
    s.discardPile.push(...pr.cards)
  }
  afterReaction(s, false, hadOffer && !s.negotiation?.offer)
}

/**
 * 反应窗口结束后回到原阶段。
 * 谈判中：方案被打掉 → 回合直接回到 Boss（他要立刻重新拿出方案）；否则出牌者的下一位继续。
 */
function afterReaction(s: GameState, cancelled: boolean, offerVoided = false) {
  const pr = s.pendingReaction!
  s.pendingReaction = null
  const neg = s.negotiation
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
    if (cancelled) {
      s.phase = 'CLOSING' // 同一位玩家仍可继续出牌或放行
      return
    }
    neg.closingOrder = []
    neg.closingIndex = 0
    neg.passStreak = 0
    neg.turnId = neg.bossId
    s.phase = 'NEGOTIATION'
    emit(s, { kind: 'CLOSING_INTERRUPTED' })
    return
  }
  s.phase = 'NEGOTIATION'
  neg.passStreak = 0
  if (!cancelled && pr.kind === 'BOSS') neg.turnId = pr.actorId
  else if (offerVoided) neg.turnId = neg.bossId
  else neg.turnId = nextPlayerId(s, pr.actorId)
}

function advanceResponse(s: GameState) {
  const neg = s.negotiation!
  neg.responseIndex++
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
  let paid = 0
  const finalPayouts: Payout[] = []
  for (const p of offer.payouts) {
    const amount = Math.max(0, Math.min(p.amount, gross - paid))
    const to = getPlayer(s, p.playerId)
    if (!to || amount <= 0 || p.playerId === boss.id) continue
    boss.cash -= amount
    to.cash += amount
    paid += amount
    finalPayouts.push({ playerId: p.playerId, amount })
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
  s.dealHistory.push({
    id: s.nextId++, dealNumber: s.completedDeals, spaceId: space.id, bossId: neg.bossId, openerId: neg.openerId,
    success: true, grossValue: gross, payouts: finalPayouts, disruptors: [...neg.disruptors],
  })
  emit(s, { kind: 'DEAL_CLOSED', dealNumber: s.completedDeals, spaceId: space.id, tileId: tile.id, bossId: boss.id, gross, payouts: finalPayouts, bossKeep: gross - paid })

  // 金钱标记移到顺时针下一个未关闭格
  for (let i = 0; i < 16; i++) {
    const next = (s.markerPos % 16) + 1
    s.markerPos = next
    if (getSpace(s, next)!.closedByTileId == null) break
  }

  const bossId = neg.bossId
  s.negotiation = null
  clearSpeeches(s)

  if (s.completedDeals >= TOTAL_DEALS) {
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
    success: false, grossValue: getGrossValue(s), payouts: [], disruptors: [...neg.disruptors], failReason: reason,
  })
  emit(s, { kind: 'DEAL_FAILED', spaceId: neg.spaceId, bossId: neg.bossId, reason })
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
  if (action.type === 'START_GAME') return createInitialState(action.playerCount, action.humanName, action.seed)
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
      let moved = 0
      while (moved < die) {
        s.markerPos = (s.markerPos % 16) + 1
        if (getSpace(s, s.markerPos)!.closedByTileId == null) moved++
      }
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
      if (action.demand != null) setDemand(s, player.id, action.demand, [card.familyId!])
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
      const cards = takeFromHand(player, action.cardIds)
      const fromId = s.investors.find(i => i.familyId === action.targetFamilyId)?.ownerId ?? null
      emit(s, { kind: 'RECRUITMENT_PLAYED', playerId: player.id, familyId: action.targetFamilyId, fromId })
      beginReaction(s, player.id, 'RECRUITMENT', cards, { targetFamilyId: action.targetFamilyId })
      return
    }

    case 'PLAY_BOSS': {
      const cards = takeFromHand(player, [action.cardId])
      emit(s, { kind: 'BOSS_PLAYED', playerId: player.id, bossId: neg!.bossId })
      beginReaction(s, player.id, 'BOSS', cards, {})
      return
    }

    case 'PLAY_STOP': {
      const pr = s.pendingReaction!
      const stop = player.hand.splice(player.hand.findIndex(c => c.type === 'STOP'), 1)[0]
      s.discardPile.push(stop, ...pr.cards)
      emit(s, { kind: 'STOP_PLAYED', playerId: player.id, actorId: pr.actorId, cancelled: pr.kind })
      afterReaction(s, true)
      return
    }

    case 'PASS_REACTION': {
      const pr = s.pendingReaction!
      pr.askedIds.push(player.id)
      const next = nextReactor(s, player.id, new Set(pr.askedIds))
      if (next === null) resolveReaction(s)
      else pr.reactorId = next
      return
    }

    case 'SPEAK':
      neg!.speakCounts[player.id] = (neg!.speakCounts[player.id] ?? 0) + 1
      if (action.demand != null) {
        // 指定家族 → 只对该家族报价；否则对我在本格所有相关代表报同一价；没有相关代表 → 封口费
        const fams = action.demandFamily ? [action.demandFamily] : playerRelevantFamilies(s, player.id)
        setDemand(s, player.id, action.demand, fams)
      }
      neg!.passStreak = 0
      neg!.turnId = nextPlayerId(s, player.id)
      return

    case 'PASS':
      neg!.passStreak++
      if (neg!.passStreak >= s.players.length) {
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
      // 点头就是承诺：这个价（按每个代表折算）成为所用家族的公开出借价，方案若作废后 Boss 再按此价提案即自动同意
      const got = offerShareOf(offer, player.id)
      const used = Math.max(1, repsUsedOf(neg!, offer, player.id))
      const committed = commitmentPrice(neg!, offer, player.id)
      if (got % used === 0 && (committed == null || committed > got)) {
        setDemand(s, player.id, got / used, usedFamiliesOf(neg!, offer, player.id), true)
      }
      advanceResponse(s)
      return
    }

    case 'DECLINE_OFFER':
      neg!.offer!.responses[player.id] = 'DECLINED'
      emit(s, { kind: 'OFFER_DECLINED', playerId: player.id, counter: action.counter })
      if (action.counter != null) {
        // 反报价是对"方案里用到的我的代表"（每个）的出借价，而不是封口费
        setDemand(s, player.id, action.counter, usedFamiliesOf(neg!, neg!.offer!, player.id))
      }
      advanceResponse(s)
      return

    case 'CLOSE_DEAL': {
      if (!neg!.offer) {
        neg!.offer = { id: s.nextId++, bossId: player.id, repKeys: selectReps(s).repKeys, payouts: [], responses: {} }
        neg!.offersMade++
      }
      neg!.closingOrder = othersFrom(s, player.id)
      neg!.closingIndex = 0
      s.phase = 'CLOSING'
      emit(s, { kind: 'CLOSING_STARTED', bossId: player.id })
      if (neg!.closingOrder.length === 0) finalizeDeal(s) // 没有别人可放行（单人局）→ 直接结算
      return
    }

    case 'PASS_CLOSING':
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
