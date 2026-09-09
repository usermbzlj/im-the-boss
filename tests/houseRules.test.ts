// 桌规（houseRules）与缺代表速流局：换牌 / 买牌 / 兑换招募牌 / 病假牌 / 回合标记 / 银行 / 全局仿真
// 场景全部从真实初始状态搭出来，卡牌与现金守恒不变量始终成立。

import { describe, it, expect } from 'vitest'
import type { GameState } from '../src/engine/types'
import {
  VARIANT_IDS, getVariant, sickCardCount, createDeckFor, HAND_LIMIT,
  BUY_CARDS_COST_SHARES, TRADE_RECRUIT_COUNT, TRADE_COST_SHARES,
} from '../src/engine/config'
import { createInitialState } from '../src/engine/gameEngine'
import { getActingPlayerId, getLegalActions, isLegal } from '../src/engine/validator'
import {
  isSick, canSwapCard, buyableCardCounts, buyCardsCost, tradeCost, canTradeCards, isValidTradePair,
  baseShareValue, tableCanComplete, canReclaim, recruitCost, countCards,
} from '../src/engine/rules'
import { runGame, checkInvariants } from '../src/sim/harness'
import { baseState, setInvestors, giveCards, clearHand, step, rejects, openDealAt, toBoss, eventsOf, closeSolo, ownSpaceFamilies } from './helpers'

/** 开桌规的经典局（4 人），全员清空手牌，投资者全部放公共区，便于按需摆放 */
function houseState(playerCount = 4, seed = 5): GameState {
  const s = baseState(playerCount, seed, 'classic', true)
  for (const p of s.players) clearHand(s, p.id)
  setInvestors(s, {})
  return s
}

/** 让 playerId 处于自己的回合开单前（TURN），标记在 spaceId */
function myTurn(s: GameState, playerId: number, spaceId = 1): GameState {
  s.phase = 'TURN'
  s.currentId = playerId
  s.markerPos = spaceId
  s.markerChooserId = null
  return s
}

/** 先让 playerId 在 1 号格独立成交一笔挣到钱，然后把回合还给他（标记放到尚未成交的 2 号格） */
function earn(s: GameState, playerId: number): GameState {
  ownSpaceFamilies(s, s.board[0], playerId)
  s = closeSolo(s, 1, playerId)
  expect(s.players[playerId].cash).toBeGreaterThan(0)
  setInvestors(s, {})
  return myTurn(s, playerId, 2)
}

/** 第一个尚未成交、需要家族 f 的格子 */
const spaceNeeding = (s: GameState, f: 'A' | 'B' | 'C' | 'D' | 'E' | 'F') =>
  s.board.find(b => b.closedByTileId == null && b.groups.some(g => g.families.includes(f)))!

const noInvariantBreak = (s: GameState) => expect(checkInvariants(s)).toBeNull()

describe('桌规开关与牌堆', () => {
  it('开桌规的牌堆多出病假牌；关掉则一张没有；经典默认关、其余版本默认开', () => {
    for (const id of VARIANT_IDS) {
      const v = getVariant(id)
      const on = createDeckFor(v, true).filter(c => c.type === 'SICK').length
      const off = createDeckFor(v, false).filter(c => c.type === 'SICK').length
      expect(on).toBe(sickCardCount(v))
      expect(on).toBeGreaterThanOrEqual(3)
      expect(off).toBe(0)
      expect(createInitialState(4, '我', 1, id).houseRules).toBe(v.houseRules)
    }
    expect(getVariant('classic').houseRules).toBe(false)
    expect(getVariant('full').houseRules).toBe(true)
    const s = createInitialState(4, '我', 1, 'classic', { houseRules: true })
    expect(s.houseRules).toBe(true)
    expect(s.turn).toEqual({ swapped: [], bought: [], traded: [], sick: [] })
    expect(s.bank).toBe(0)
    noInvariantBreak(s)
  })

  it('关闭桌规时：不会列出换牌 / 买牌 / 兑换动作，isLegal 也拒绝', () => {
    let s = baseState(4, 2, 'classic', false)
    for (const p of s.players) clearHand(s, p.id)
    setInvestors(s, { A: 1 })
    const [clan, travel] = giveCards(s, 1, [{ type: 'CLAN', familyId: 'A' }, { type: 'TRAVEL', familyId: 'B' }])
    s = myTurn(s, 1)
    s.players[1].cash = 20; s.bank = 0 // 仅为本用例造钱（之后不查现金守恒）
    const legal = getLegalActions(s, 1)
    expect(legal.some(a => ['SWAP_CARD', 'BUY_CARDS', 'TRADE_CARDS', 'PLAY_SICK'].includes(a.type))).toBe(false)
    rejects(s, { type: 'SWAP_CARD', playerId: 1, cardId: clan.id })
    rejects(s, { type: 'BUY_CARDS', playerId: 1, count: 1 })
    rejects(s, { type: 'TRADE_CARDS', playerId: 1, cardIds: [clan.id, travel.id] })
  })
})

describe('换牌：家族成员 ↔ 同家族旅行牌', () => {
  it('持有 A 投资者时，A 成员卡可换成 A 旅行牌；不结束行动；每回合限一次', () => {
    let s = houseState()
    setInvestors(s, { A: 1 })
    const [clan, clan2] = giveCards(s, 1, [{ type: 'CLAN', familyId: 'A' }, { type: 'CLAN', familyId: 'A' }])
    s = myTurn(s, 1)
    expect(canSwapCard(s, 1, clan)).toBe(true)
    expect(getLegalActions(s, 1).filter(a => a.type === 'SWAP_CARD')).toHaveLength(2)

    s = step(s, { type: 'SWAP_CARD', playerId: 1, cardId: clan.id })
    const hand = s.players[1].hand
    expect(hand).toHaveLength(2)
    expect(hand.some(c => c.id === clan.id)).toBe(false)
    expect(hand.filter(c => c.type === 'TRAVEL' && c.familyId === 'A')).toHaveLength(1)
    expect(s.discardPile.some(c => c.id === clan.id)).toBe(true)
    expect(s.phase).toBe('TURN')
    expect(s.currentId).toBe(1)
    expect(s.turn.swapped).toEqual([1])
    expect(eventsOf(s, 'CARD_SWAPPED').at(-1)).toMatchObject({ playerId: 1, familyId: 'A', to: 'TRAVEL' })
    noInvariantBreak(s)

    // 同一回合第二次不行；回合结束后标记清零
    rejects(s, { type: 'SWAP_CARD', playerId: 1, cardId: clan2.id })
    expect(getLegalActions(s, 1).some(a => a.type === 'SWAP_CARD')).toBe(false)
    s = step(s, { type: 'ROLL_MOVE', playerId: 1 })
    s = step(s, { type: 'DRAW_CARDS', playerId: 1 })
    expect(s.turn).toEqual({ swapped: [], bought: [], traded: [], sick: [] })
  })

  it('反向：A 旅行牌换回 A 成员卡；万能旅行牌与非自家家族的牌不能换', () => {
    let s = houseState()
    setInvestors(s, { A: 1, B: 2 })
    const [travelA, wild, clanB] = giveCards(s, 1, [{ type: 'TRAVEL', familyId: 'A' }, { type: 'TRAVEL' }, { type: 'CLAN', familyId: 'B' }])
    s = myTurn(s, 1)
    expect(canSwapCard(s, 1, travelA)).toBe(true)
    expect(canSwapCard(s, 1, wild)).toBe(false)
    expect(canSwapCard(s, 1, clanB)).toBe(false) // B 的投资者在别人手里
    rejects(s, { type: 'SWAP_CARD', playerId: 1, cardId: wild.id })
    rejects(s, { type: 'SWAP_CARD', playerId: 1, cardId: clanB.id })
    s = step(s, { type: 'SWAP_CARD', playerId: 1, cardId: travelA.id })
    expect(s.players[1].hand.filter(c => c.type === 'CLAN' && c.familyId === 'A')).toHaveLength(1)
    expect(eventsOf(s, 'CARD_SWAPPED').at(-1)).toMatchObject({ to: 'CLAN' })
    noInvariantBreak(s)
  })

  it('谈判中轮到自己也能换：换到的旅行牌可以紧接着打飞竞争者的同家族代表', () => {
    let s = houseState()
    setInvestors(s, { A: 1, B: 2, C: 2 }) // A 家族投资者在 1 号手里；再给 2 号一张 A 成员卡上桌竞争
    const space = spaceNeeding(s, 'A')
    giveCards(s, 2, [{ type: 'CLAN', familyId: 'A' }])
    const [clanA] = giveCards(s, 1, [{ type: 'CLAN', familyId: 'A' }])
    s = openDealAt(s, space.id, 3) // 3 号当 Boss，叫价轮从 0 号开始
    // 走到 2 号：打出 A 成员卡与 1 号竞争
    while (getActingPlayerId(s) !== 2) s = step(s, { type: 'PASS', playerId: getActingPlayerId(s) })
    s = step(s, { type: 'PLAY_CLAN', playerId: 2, cardId: s.players[2].hand[0].id })
    // 轮到 Boss（3 号）→ 跳过 → 0 号跳过 → 1 号
    while (getActingPlayerId(s) !== 1) s = step(s, { type: 'PASS', playerId: getActingPlayerId(s) })
    expect(s.negotiation!.reps.filter(r => r.familyId === 'A' && !r.travelled)).toHaveLength(2)
    s = step(s, { type: 'SWAP_CARD', playerId: 1, cardId: clanA.id })
    expect(s.phase).toBe('NEGOTIATION')
    expect(s.negotiation!.turnId).toBe(1) // 不结束行动
    const travelA = s.players[1].hand.find(c => c.type === 'TRAVEL' && c.familyId === 'A')!
    const rivalKey = s.negotiation!.reps.find(r => r.familyId === 'A' && r.ownerId === 2)!.key
    s = step(s, { type: 'PLAY_TRAVEL', playerId: 1, cardId: travelA.id, targetRepKey: rivalKey })
    expect(s.phase).toBe('REACTION')
    while (s.phase === 'REACTION') s = step(s, { type: 'PASS_REACTION', playerId: getActingPlayerId(s) })
    expect(s.negotiation!.reps.filter(r => r.familyId === 'A' && !r.travelled).map(r => r.ownerId)).toEqual([1])
    noInvariantBreak(s)
  })
})

describe('买牌：付 1 / 3 / 6 份股价多抽 1 / 2 / 3 张', () => {
  it('价钱按当前股价计；钱进银行；抽到手；每回合限一次；不能超手牌上限', () => {
    let s = houseState()
    s = earn(s, 1)
    const cash = s.players[1].cash
    const share = baseShareValue(s)
    expect(share).toBeGreaterThan(0)
    expect(buyCardsCost(s, 1)).toBe(BUY_CARDS_COST_SHARES[0] * share)
    expect(buyCardsCost(s, 2)).toBe(BUY_CARDS_COST_SHARES[1] * share)
    expect(buyCardsCost(s, 3)).toBe(BUY_CARDS_COST_SHARES[2] * share)
    const counts = buyableCardCounts(s, 1)
    expect(counts.length).toBeGreaterThan(0)
    expect(counts.every(n => buyCardsCost(s, n) <= cash)).toBe(true)
    expect(getLegalActions(s, 1).filter(a => a.type === 'BUY_CARDS').map(a => (a as { count: number }).count)).toEqual(counts)
    // 付不起的张数被拒绝
    const tooMany = ([1, 2, 3] as const).find(n => buyCardsCost(s, n) > cash)
    if (tooMany) rejects(s, { type: 'BUY_CARDS', playerId: 1, count: tooMany })

    const n = counts[counts.length - 1] as 1 | 2 | 3
    const cost = buyCardsCost(s, n)
    s = step(s, { type: 'BUY_CARDS', playerId: 1, count: n })
    expect(s.players[1].cash).toBe(cash - cost)
    expect(s.bank).toBe(cost)
    expect(s.players[1].hand).toHaveLength(n)
    expect(s.phase).toBe('TURN')
    expect(s.currentId).toBe(1)
    expect(s.turn.bought).toEqual([1])
    expect(eventsOf(s, 'CARDS_BOUGHT').at(-1)).toMatchObject({ playerId: 1, count: n, cost })
    noInvariantBreak(s)
    rejects(s, { type: 'BUY_CARDS', playerId: 1, count: 1 })
    expect(buyableCardCounts(s, 1)).toEqual([])
  })

  it('手牌上限约束：11 张时只能买 1 张；12 张一张都不能买；谈判中不能买', () => {
    let s = houseState()
    s = earn(s, 1)
    s.players[1].cash = Math.max(s.players[1].cash, 100); s.bank = 0 // 只测张数约束，钱给够
    giveCards(s, 1, Array.from({ length: HAND_LIMIT - 1 }, () => ({ type: 'RECRUITMENT' as const })))
    expect(buyableCardCounts(s, 1)).toEqual([1])
    giveCards(s, 1, [{ type: 'RECRUITMENT' }])
    expect(buyableCardCounts(s, 1)).toEqual([])
    rejects(s, { type: 'BUY_CARDS', playerId: 1, count: 1 })
    // 谈判中不列买牌
    clearHand(s, 1)
    ownSpaceFamilies(s, s.board[s.markerPos - 1], 1)
    s = openDealAt(s, s.markerPos, 1)
    s = toBoss(s)
    expect(getLegalActions(s, 1).some(a => a.type === 'BUY_CARDS')).toBe(false)
    rejects(s, { type: 'BUY_CARDS', playerId: 1, count: 1 })
  })
})

describe('兑换：两张不同种类的牌 + 一份股价 → 两张招募牌', () => {
  it('交出的牌进弃牌堆，招募牌到手，钱进银行；同种两张 / 只给一张 / 不在手里的牌都不行；每回合限一次', () => {
    let s = houseState()
    s = earn(s, 1)
    const [clan, travel, boss, stop] = giveCards(s, 1, [{ type: 'CLAN', familyId: 'B' }, { type: 'TRAVEL', familyId: 'C' }, { type: 'BOSS' }, { type: 'STOP' }])
    const cash = s.players[1].cash
    const cost = tradeCost(s)
    expect(cost).toBe(TRADE_COST_SHARES * baseShareValue(s))
    expect(canTradeCards(s, 1)).toBe(true)
    expect(isValidTradePair(s, 1, [clan.id, travel.id])).toBe(true)
    expect(isValidTradePair(s, 1, [clan.id, clan.id])).toBe(false)
    expect(isValidTradePair(s, 1, [clan.id])).toBe(false)
    expect(isValidTradePair(s, 1, [clan.id, 99999])).toBe(false)
    rejects(s, { type: 'TRADE_CARDS', playerId: 1, cardIds: [clan.id] })
    rejects(s, { type: 'TRADE_CARDS', playerId: 1, cardIds: [clan.id, 99999] })
    // 合法动作列表给出一个默认选牌，且玩家可以自己改选
    const listed = getLegalActions(s, 1).find(a => a.type === 'TRADE_CARDS')
    expect(listed).toBeTruthy()
    expect(isLegal(s, { type: 'TRADE_CARDS', playerId: 1, cardIds: [boss.id, stop.id] })).toBe(true)

    s = step(s, { type: 'TRADE_CARDS', playerId: 1, cardIds: [clan.id, travel.id] })
    const hand = s.players[1].hand
    expect(hand.map(c => c.id)).not.toContain(clan.id)
    expect(hand.map(c => c.id)).not.toContain(travel.id)
    expect(countCards(hand, 'RECRUITMENT')).toBe(TRADE_RECRUIT_COUNT)
    expect(hand).toHaveLength(2 + TRADE_RECRUIT_COUNT)
    expect(s.discardPile.filter(c => c.id === clan.id || c.id === travel.id)).toHaveLength(2)
    expect(s.players[1].cash).toBe(cash - cost)
    expect(s.bank).toBe(cost)
    expect(s.phase).toBe('TURN')
    expect(s.turn.traded).toEqual([1])
    expect(eventsOf(s, 'CARDS_TRADED').at(-1)).toMatchObject({ playerId: 1, cost, recruitCount: TRADE_RECRUIT_COUNT })
    noInvariantBreak(s)
    rejects(s, { type: 'TRADE_CARDS', playerId: 1, cardIds: [boss.id, stop.id] })
  })

  it('夺回权联动：没有招募牌的人兑换后立刻能用 1 张招募牌抢回自家投资者（谈判中不结束行动）', () => {
    let s = houseState()
    s = earn(s, 1)
    // 1 号的最后一位投资者 A 被 2 号夺走 → 夺回权
    setInvestors(s, { A: 2, B: 3 })
    s.players[1].reclaim = 'A'
    expect(canReclaim(s, 1, 'A')).toBe(true)
    expect(recruitCost(s, 1, 'A')).toBe(1)
    const space = spaceNeeding(s, 'A')
    const [clan, travel] = giveCards(s, 1, [{ type: 'CLAN', familyId: 'D' }, { type: 'TRAVEL', familyId: 'D' }])
    s = openDealAt(s, space.id, 3)
    while (getActingPlayerId(s) !== 1) s = step(s, { type: 'PASS', playerId: getActingPlayerId(s) })
    expect(getLegalActions(s, 1).some(a => a.type === 'PLAY_RECRUITMENT')).toBe(false)
    s = step(s, { type: 'TRADE_CARDS', playerId: 1, cardIds: [clan.id, travel.id] })
    expect(s.negotiation!.turnId).toBe(1)
    const recruit = getLegalActions(s, 1).find(a => a.type === 'PLAY_RECRUITMENT' && a.targetFamilyId === 'A')
    expect(recruit).toBeTruthy()
    expect((recruit as { cardIds: number[] }).cardIds).toHaveLength(1)
    s = step(s, recruit!)
    while (s.phase === 'REACTION') s = step(s, { type: 'PASS_REACTION', playerId: getActingPlayerId(s) })
    expect(s.investors.find(i => i.familyId === 'A')!.ownerId).toBe(1)
    expect(s.players[1].reclaim).toBeNull()
    noInvariantBreak(s)
  })

  it('钱不够 / 牌堆里招募牌不足两张 / 手里只有一种牌时不能兑换', () => {
    let s = houseState()
    setInvestors(s, {})
    giveCards(s, 1, [{ type: 'CLAN', familyId: 'A' }, { type: 'TRAVEL', familyId: 'A' }])
    s = myTurn(s, 1)
    expect(s.players[1].cash).toBe(0)
    expect(canTradeCards(s, 1)).toBe(false)
    rejects(s, { type: 'TRADE_CARDS', playerId: 1, cardIds: s.players[1].hand.map(c => c.id) })
    // 有钱但只有一种牌
    s = houseState()
    s = earn(s, 1)
    giveCards(s, 1, [{ type: 'CLAN', familyId: 'A' }, { type: 'CLAN', familyId: 'B' }])
    expect(canTradeCards(s, 1)).toBe(false)
    expect(getLegalActions(s, 1).some(a => a.type === 'TRADE_CARDS')).toBe(false)
  })
})

describe('病假牌：本回合禁止一名玩家主动出牌', () => {
  /** 搭一桌：Boss 3 号开单；1 号手里有病假牌；2 号有成员卡与阻止牌 */
  function table(seed = 9) {
    let s = houseState(4, seed)
    setInvestors(s, { A: 3, B: 3, C: 2, D: 1 })
    const space = spaceNeeding(s, 'A')
    const [sick] = giveCards(s, 1, [{ type: 'SICK' }])
    giveCards(s, 2, [{ type: 'CLAN', familyId: 'A' }, { type: 'TRAVEL' }])
    s = openDealAt(s, space.id, 3)
    while (getActingPlayerId(s) !== 1) s = step(s, { type: 'PASS', playerId: getActingPlayerId(s) })
    return { s, sick, space }
  }

  it('打出进反应窗口；全员放行后目标病假：不能出牌 / 换牌，只能喊话、跳过；阻止牌仍可打；回合结束解除', () => {
    let { s, sick } = table()
    expect(getLegalActions(s, 1).filter(a => a.type === 'PLAY_SICK').map(a => (a as { targetPlayerId: number }).targetPlayerId)).toEqual([0, 2, 3])
    rejects(s, { type: 'PLAY_SICK', playerId: 1, cardId: sick.id, targetPlayerId: 1 }) // 不能对自己
    s = step(s, { type: 'PLAY_SICK', playerId: 1, cardId: sick.id, targetPlayerId: 2 })
    expect(s.phase).toBe('REACTION')
    expect(s.pendingReaction).toMatchObject({ kind: 'SICK', actorId: 1, targetPlayerId: 2, returnPhase: 'NEGOTIATION' })
    expect(eventsOf(s, 'SICK_PLAYED').at(-1)).toMatchObject({ playerId: 1, targetId: 2 })
    while (s.phase === 'REACTION') s = step(s, { type: 'PASS_REACTION', playerId: getActingPlayerId(s) })
    expect(isSick(s, 2)).toBe(true)
    expect(s.turn.sick).toEqual([2])
    expect(eventsOf(s, 'SICK_RESOLVED').at(-1)).toMatchObject({ playerId: 1, targetId: 2 })
    expect(s.phase).toBe('NEGOTIATION')
    expect(s.negotiation!.turnId).toBe(2) // 出牌者的下一位
    noInvariantBreak(s)

    // 2 号：成员卡 / 旅行牌都打不了，只能喊话或跳过
    const legal2 = getLegalActions(s, 2)
    expect(legal2.some(a => a.type === 'PLAY_CLAN' || a.type === 'PLAY_TRAVEL' || a.type === 'SWAP_CARD' || a.type === 'TRADE_CARDS')).toBe(false)
    expect(legal2.some(a => a.type === 'SPEAK')).toBe(true)
    expect(legal2.some(a => a.type === 'PASS')).toBe(true)
    const clanA = s.players[2].hand.find(c => c.type === 'CLAN')!
    rejects(s, { type: 'PLAY_CLAN', playerId: 2, cardId: clanA.id })
    s = step(s, { type: 'SPEAK', playerId: 2, say: '我今天不太舒服……' })

    // 病假的人被动打阻止牌仍然可以：0 号（Boss 左手）打旅行牌飞 2 号的 C 投资者，2 号有阻止牌就能拦
    giveCards(s, 2, [{ type: 'STOP' }])
    const [travel0] = giveCards(s, 0, [{ type: 'TRAVEL' }])
    while (getActingPlayerId(s) !== 0) s = step(s, { type: 'PASS', playerId: getActingPlayerId(s) })
    const cKey = s.negotiation!.reps.find(r => r.familyId === 'C')?.key
    if (cKey) {
      s = step(s, { type: 'PLAY_TRAVEL', playerId: 0, cardId: travel0.id, targetRepKey: cKey })
      while (s.phase === 'REACTION' && getActingPlayerId(s) !== 2) s = step(s, { type: 'PASS_REACTION', playerId: getActingPlayerId(s) })
      expect(s.phase).toBe('REACTION')
      expect(isLegal(s, { type: 'PLAY_STOP', playerId: 2 })).toBe(true)
      s = step(s, { type: 'PLAY_STOP', playerId: 2 })
      expect(eventsOf(s, 'STOP_PLAYED').at(-1)).toMatchObject({ playerId: 2, cancelled: 'TRAVEL' })
    }

    // Boss 放弃 → 回合结束 → 病假解除
    s = toBoss(s)
    s = step(s, { type: 'ABANDON_DEAL', playerId: 3 })
    expect(s.turn.sick).toEqual([])
    expect(isSick(s, 2)).toBe(false)
    noInvariantBreak(s)
  })

  it('目标用阻止牌取消病假；病假中的人不能再打病假牌；同一人不会被列为二次目标', () => {
    let { s, sick } = table(10)
    giveCards(s, 2, [{ type: 'STOP' }])
    s = step(s, { type: 'PLAY_SICK', playerId: 1, cardId: sick.id, targetPlayerId: 2 })
    while (s.phase === 'REACTION' && getActingPlayerId(s) !== 2) s = step(s, { type: 'PASS_REACTION', playerId: getActingPlayerId(s) })
    s = step(s, { type: 'PLAY_STOP', playerId: 2 })
    expect(isSick(s, 2)).toBe(false)
    expect(s.turn.sick).toEqual([])
    expect(s.discardPile.some(c => c.id === sick.id)).toBe(true)
    noInvariantBreak(s)

    // 让 0 号病假，再给 0 号一张病假牌：他打不出去；1 号手里的第二张病假牌不能再选 0 号
    s.turn.sick.push(0)
    const [sick0] = giveCards(s, 0, [{ type: 'SICK' }])
    const [sick1] = giveCards(s, 1, [{ type: 'SICK' }])
    while (getActingPlayerId(s) !== 0) s = step(s, { type: 'PASS', playerId: getActingPlayerId(s) })
    rejects(s, { type: 'PLAY_SICK', playerId: 0, cardId: sick0.id, targetPlayerId: 2 })
    expect(getLegalActions(s, 0).some(a => a.type === 'PLAY_SICK')).toBe(false)
    s = step(s, { type: 'PASS', playerId: 0 })
    expect(getActingPlayerId(s)).toBe(1)
    expect(getLegalActions(s, 1).filter(a => a.type === 'PLAY_SICK').map(a => (a as { targetPlayerId: number }).targetPlayerId)).toEqual([2, 3])
    rejects(s, { type: 'PLAY_SICK', playerId: 1, cardId: sick1.id, targetPlayerId: 0 })
  })

  it('开单前打病假牌：窗口结束后回到自己的回合继续开单', () => {
    let s = houseState()
    const [sick] = giveCards(s, 1, [{ type: 'SICK' }])
    s = myTurn(s, 1)
    expect(getLegalActions(s, 1).some(a => a.type === 'PLAY_SICK')).toBe(true)
    s = step(s, { type: 'PLAY_SICK', playerId: 1, cardId: sick.id, targetPlayerId: 3 })
    expect(s.pendingReaction!.returnPhase).toBe('TURN')
    while (s.phase === 'REACTION') s = step(s, { type: 'PASS_REACTION', playerId: getActingPlayerId(s) })
    expect(s.phase).toBe('TURN')
    expect(s.currentId).toBe(1)
    expect(isSick(s, 3)).toBe(true)
    s = step(s, { type: 'OPEN_DEAL', playerId: 1 })
    expect(s.negotiation!.bossId).toBe(1)
    // 3 号轮到时只能喊话 / 跳过
    while (getActingPlayerId(s) !== 3) s = step(s, { type: 'PASS', playerId: getActingPlayerId(s) })
    expect(getLegalActions(s, 3).every(a => a.type === 'SPEAK' || a.type === 'PASS')).toBe(true)
    noInvariantBreak(s)
  })

  it('Boss 自己打病假牌：窗口结束后回合仍在 Boss；倒计时里打病假牌不打断倒计时', () => {
    let s = houseState()
    setInvestors(s, { A: 1, B: 1, C: 1, D: 1, E: 1, F: 1 })
    const space = s.board[0]
    const [sickBoss] = giveCards(s, 1, [{ type: 'SICK' }])
    const [sick2] = giveCards(s, 2, [{ type: 'SICK' }])
    s = toBoss(openDealAt(s, space.id, 1))
    s = step(s, { type: 'PLAY_SICK', playerId: 1, cardId: sickBoss.id, targetPlayerId: 3 })
    while (s.phase === 'REACTION') s = step(s, { type: 'PASS_REACTION', playerId: getActingPlayerId(s) })
    expect(s.phase).toBe('NEGOTIATION')
    expect(s.negotiation!.turnId).toBe(1)
    expect(isSick(s, 3)).toBe(true)
    // Boss 独立成交 → 倒计时；2 号在倒计时里打病假牌放倒 0 号，倒计时继续（同一位玩家仍需放行）
    s = step(s, { type: 'CLOSE_DEAL', playerId: 1 })
    expect(s.phase).toBe('CLOSING')
    while (s.phase === 'CLOSING' && getActingPlayerId(s) !== 2) s = step(s, { type: 'PASS_CLOSING', playerId: getActingPlayerId(s) })
    expect(getLegalActions(s, 2).some(a => a.type === 'PLAY_SICK')).toBe(true)
    s = step(s, { type: 'PLAY_SICK', playerId: 2, cardId: sick2.id, targetPlayerId: 0 })
    expect(s.pendingReaction!.returnPhase).toBe('CLOSING')
    while (s.phase === 'REACTION') s = step(s, { type: 'PASS_REACTION', playerId: getActingPlayerId(s) })
    expect(s.phase).toBe('CLOSING')
    expect(getActingPlayerId(s)).toBe(2)
    expect(eventsOf(s, 'CLOSING_INTERRUPTED')).toHaveLength(0)
    while (s.phase === 'CLOSING') s = step(s, { type: 'PASS_CLOSING', playerId: getActingPlayerId(s) })
    expect(eventsOf(s, 'DEAL_CLOSED')).toHaveLength(1)
    expect(s.turn.sick).toEqual([]) // 成交 → 回合结束 → 全部解除
    noInvariantBreak(s)
  })
})

describe('缺代表速流局（不依赖桌规）', () => {
  it('桌上凑不齐需求且全员跳过一轮 → 立即流局（INCOMPLETE），家族卡收回', () => {
    let s = baseState(4, 3, 'classic', false)
    for (const p of s.players) clearHand(s, p.id)
    setInvestors(s, {}) // 全部在公共区：谁都凑不齐
    giveCards(s, 2, [{ type: 'CLAN', familyId: 'A' }])
    const space = spaceNeeding(s, 'A')
    s = openDealAt(s, space.id, 3)
    expect(tableCanComplete(s)).toBe(false)
    // 2 号打一张成员卡上桌（仍凑不齐），其余人依次跳过一整轮
    while (getActingPlayerId(s) !== 2) s = step(s, { type: 'PASS', playerId: getActingPlayerId(s) })
    s = step(s, { type: 'PLAY_CLAN', playerId: 2, cardId: s.players[2].hand[0].id })
    expect(tableCanComplete(s)).toBe(false)
    for (let i = 0; i < s.players.length; i++) {
      expect(s.phase).toBe('NEGOTIATION')
      s = step(s, { type: 'PASS', playerId: getActingPlayerId(s) })
    }
    expect(s.negotiation).toBeNull()
    expect(eventsOf(s, 'DEAL_FAILED').at(-1)).toMatchObject({ spaceId: space.id, bossId: 3, reason: 'INCOMPLETE' })
    expect(eventsOf(s, 'STALEMATE_ROUND')).toHaveLength(0)
    expect(s.dealHistory.at(-1)).toMatchObject({ success: false, failReason: 'INCOMPLETE' })
    expect(s.players[2].hand.filter(c => c.type === 'CLAN' && c.familyId === 'A')).toHaveLength(1) // 家族卡收回
    expect(s.phase).toBe('TURN')
    expect(s.currentId).toBe(0) // Boss 左手边接着行动
    noInvariantBreak(s)
  })

  it('凑得齐时全员跳过一轮只记僵局一轮，第二轮才流局（原规则不变）', () => {
    let s = baseState(4, 4, 'classic', false)
    for (const p of s.players) clearHand(s, p.id)
    ownSpaceFamilies(s, s.board[0], 2) // 2 号一个人就能凑齐，但 Boss 是 3 号
    s = openDealAt(s, 1, 3)
    expect(tableCanComplete(s)).toBe(true)
    for (let i = 0; i < s.players.length; i++) s = step(s, { type: 'PASS', playerId: getActingPlayerId(s) })
    expect(s.negotiation).not.toBeNull()
    expect(eventsOf(s, 'STALEMATE_ROUND')).toHaveLength(1)
    for (let i = 0; i < s.players.length; i++) s = step(s, { type: 'PASS', playerId: getActingPlayerId(s) })
    expect(eventsOf(s, 'DEAL_FAILED').at(-1)).toMatchObject({ reason: 'STALEMATE' })
  })
})

describe('整局仿真（开桌规）', () => {
  it.each(VARIANT_IDS)('%s：启发式 4 人局跑到终局，现金（含银行）与牌数守恒', variantId => {
    const r = runGame({ playerCount: 4, seed: 31, mode: 'heuristic', variantId, houseRules: true, maxSteps: 80000 })
    expect(r.ok, r.reason).toBe(true)
    expect(r.final.phase).toBe('GAME_OVER')
    expect(r.final.houseRules).toBe(true)
    expect(r.final.bank).toBeGreaterThanOrEqual(0)
    expect(r.final.turn).toEqual({ swapped: [], bought: [], traded: [], sick: [] })
  })

  it('随机 AI 乱打（含病假 / 换牌 / 买牌 / 兑换）也不破坏不变量', () => {
    for (const seed of [1, 2]) {
      for (const playerCount of [3, 5]) {
        const r = runGame({ playerCount, seed, mode: 'random', variantId: 'expansion', houseRules: true, maxSteps: 80000 })
        expect(r.ok, `seed=${seed} n=${playerCount}: ${r.reason}`).toBe(true)
        expect(r.final.phase).toBe('GAME_OVER')
      }
    }
  })

  it('启发式 AI 真的会用桌规：整局里出现过换牌 / 买牌 / 兑换 / 病假中的至少两种', () => {
    const kinds = new Set<string>()
    for (const seed of [11, 12]) {
      runGame({
        playerCount: 4, seed, mode: 'heuristic', variantId: 'marathon', houseRules: true, maxSteps: 80000,
        onEvent: e => { if (['CARD_SWAPPED', 'CARDS_BOUGHT', 'CARDS_TRADED', 'SICK_RESOLVED'].includes(e.kind)) kinds.add(e.kind) },
      })
    }
    expect(kinds.size).toBeGreaterThanOrEqual(2)
  })
})
