// 引擎规则场景：按官方规则书逐条验证成交 / 分成 / 影响牌 / 流局 / 终局，
// 以及本实现的桌面化约定：叫价轮（Boss 末位行动）、报价即承诺（付到即自动同意）

import { describe, it, expect } from 'vitest'
import { HAND_LIMIT, MAX_STALEMATE_ROUNDS, MAX_OFFERS_PER_BOSS, MAX_SPEECHES_PER_PLAYER } from '../src/engine/config'
import { getActingPlayerId, getLegalActions, canClose, isLegal } from '../src/engine/validator'
import { findRep, investorRepKey, clanRepKey, getGrossValue, recruitTargets, demandOf, commitmentPrice } from '../src/engine/rules'
import { baseState, setInvestors, giveCards, clearHand, step, rejects, openDealAt, toBoss, eventsOf, totalCash } from './helpers'

describe('叫价轮', () => {
  it('开单后从 Boss 左手边起依次行动，Boss 在第一轮末位；Boss 未轮到时不能提案 / 成交', () => {
    let s = baseState(4, 1)
    setInvestors(s, { A: 0, B: 0, C: 1, D: 2, E: 3 })
    s = openDealAt(s, 1, 0)
    expect(s.phase).toBe('NEGOTIATION')
    expect(getActingPlayerId(s)).toBe(1)
    expect(canClose(s)).toBe(true) // 结构上可成交，但还没轮到 Boss
    rejects(s, { type: 'CLOSE_DEAL', playerId: 0 })
    expect(getLegalActions(s, 1).map(a => a.type)).toEqual(expect.arrayContaining(['SPEAK', 'PASS']))
    expect(getLegalActions(s, 1).map(a => a.type)).not.toContain('PROPOSE_OFFER')
    for (const id of [1, 2, 3]) {
      expect(getActingPlayerId(s)).toBe(id)
      s = step(s, { type: 'PASS', playerId: id })
    }
    expect(getActingPlayerId(s)).toBe(0)
    expect(getLegalActions(s, 0).map(a => a.type)).toContain('CLOSE_DEAL')
  })

  it('非 Boss 在叫价轮里可以报价、打家族卡，Boss 听完再拼方案', () => {
    let s = baseState(4, 2)
    setInvestors(s, { A: 0, B: 1, C: 2, D: 3 })
    clearHand(s, 2)
    const [clan] = giveCards(s, 2, [{ type: 'CLAN', familyId: 'B' }])
    s = openDealAt(s, 1, 0) // 需要 A+B
    s = step(s, { type: 'SPEAK', playerId: 1, say: 'B 要 3', quotes: [{ familyId: 'B', amount: 3 }] })
    s = step(s, { type: 'PLAY_CLAN', playerId: 2, cardId: clan.id, demand: 2 })
    s = step(s, { type: 'PASS', playerId: 3 })
    expect(getActingPlayerId(s)).toBe(0)
    expect(s.negotiation!.demands).toEqual([{ playerId: 1, amount: 3, familyId: 'B' }, { playerId: 2, amount: 2, familyId: 'B' }])
    // Boss 选便宜的家族卡，付到承诺价 → 自动同意 → 直接可成交
    s = step(s, { type: 'PROPOSE_OFFER', playerId: 0, repKeys: [investorRepKey('A'), clanRepKey(clan.id)], payouts: [{ playerId: 2, amount: 2 }] })
    expect(s.phase).toBe('NEGOTIATION')
    expect(getActingPlayerId(s)).toBe(0)
    expect(canClose(s)).toBe(true)
  })
})

describe('发起交易与 Boss 独立成交', () => {
  it('Boss 自己的投资者自动同意；宣布成交 → 其他人依次放行 → 银行付全款给 Boss', () => {
    let s = baseState(4, 1)
    setInvestors(s, { A: 0, B: 0, C: 1, D: 2, E: 3 })
    s = openDealAt(s, 1, 0) // #1 需要 A+B，3 份
    expect(s.negotiation!.bossId).toBe(0)
    expect(getGrossValue(s)).toBe(2 * 3)
    s = toBoss(s)
    expect(canClose(s)).toBe(true)

    s = step(s, { type: 'CLOSE_DEAL', playerId: 0 })
    expect(s.phase).toBe('CLOSING')
    expect(s.negotiation!.closingOrder).toEqual([1, 2, 3])
    for (const id of [1, 2, 3]) {
      expect(getActingPlayerId(s)).toBe(id)
      s = step(s, { type: 'PASS_CLOSING', playerId: id })
    }
    expect(s.phase).toBe('TURN')
    expect(s.players[0].cash).toBe(6)
    expect(totalCash(s)).toBe(6)
    expect(s.board.find(b => b.id === 1)!.closedByTileId).toBe(1)
    expect(s.dealTileIndex).toBe(1)
    expect(s.completedDeals).toBe(1)
    expect(s.markerPos).toBe(2) // 顺时针下一个未关闭格
    expect(s.currentId).toBe(1) // Boss 左手边玩家接着行动
    expect(s.negotiation).toBeNull()
    expect(eventsOf(s, 'DEAL_CLOSED')).toHaveLength(1)
    expect(s.dealHistory[0]).toMatchObject({ dealNumber: 1, spaceId: 1, bossId: 0, success: true, grossValue: 6, payouts: [] })
  })

  it('凑不齐需求时不能宣布成交，也不能提案', () => {
    let s = baseState(4, 1)
    setInvestors(s, { A: 0, C: 1, D: 2, E: 3 }) // B 在公共区，没人能代表
    s = toBoss(openDealAt(s, 1, 0))
    expect(canClose(s)).toBe(false)
    rejects(s, { type: 'CLOSE_DEAL', playerId: 0 })
    rejects(s, { type: 'PROPOSE_OFFER', playerId: 0, repKeys: [investorRepKey('A')], payouts: [] })
    expect(getLegalActions(s, 0).map(a => a.type)).not.toContain('CLOSE_DEAL')
  })

  it('金钱标记移动时跳过已关闭的格子', () => {
    let s = baseState(4, 1)
    setInvestors(s, { A: 0, B: 0, C: 1, D: 2, E: 3 })
    s.board.find(b => b.id === 2)!.closedByTileId = 99
    s.board.find(b => b.id === 3)!.closedByTileId = 99
    s = toBoss(openDealAt(s, 1, 0))
    s = step(s, { type: 'CLOSE_DEAL', playerId: 0 })
    for (const id of [1, 2, 3]) s = step(s, { type: 'PASS_CLOSING', playerId: id })
    expect(s.markerPos).toBe(4)
  })
})

describe('方案 / 应答 / 分成', () => {
  function twoOwnerDeal() {
    let s = baseState(4, 2)
    setInvestors(s, { A: 0, B: 1, C: 2, D: 3 })
    s = toBoss(openDealAt(s, 1, 0)) // A(Boss) + B(玩家1)
    return s
  }

  it('代表持有者拒绝并反报价 → 方案作废、报价登记；再提案付到反报价即自动同意，可成交并按方案付款', () => {
    let s = twoOwnerDeal()
    const keys = [investorRepKey('A'), investorRepKey('B')]
    expect(canClose(s)).toBe(false)

    s = step(s, { type: 'PROPOSE_OFFER', playerId: 0, repKeys: keys, payouts: [{ playerId: 1, amount: 1 }] })
    expect(s.phase).toBe('OFFER_RESPONSE')
    expect(getActingPlayerId(s)).toBe(1)
    expect(s.negotiation!.offersMade).toBe(1)
    expect(eventsOf(s, 'OFFER_PROPOSED').at(-1)).toMatchObject({ waitingFor: [1], autoAccepted: [] })

    s = step(s, { type: 'DECLINE_OFFER', playerId: 1, quotes: [{ amount: 3 }] })
    expect(s.phase).toBe('NEGOTIATION')
    expect(getActingPlayerId(s)).toBe(0)
    expect(canClose(s)).toBe(false)
    expect(s.negotiation!.demands).toEqual([{ playerId: 1, amount: 3, familyId: 'B' }]) // 反报价记为 B 代表的出借价
    expect(eventsOf(s, 'OFFER_DECLINED').at(-1)).toMatchObject({ playerId: 1, counters: [{ familyIds: ['B'], amount: 3 }] })
    expect(eventsOf(s, 'DEMAND')).toHaveLength(0) // 反报价随拒绝事件叙述，不另刷一条报价
    expect(eventsOf(s, 'OFFER_RESOLVED').at(-1)).toMatchObject({ agreed: false, declinerIds: [1] })

    // 付到承诺价：不再询问，自动同意
    s = step(s, { type: 'PROPOSE_OFFER', playerId: 0, repKeys: keys, payouts: [{ playerId: 1, amount: 3 }] })
    expect(s.phase).toBe('NEGOTIATION')
    expect(getActingPlayerId(s)).toBe(0)
    expect(eventsOf(s, 'OFFER_PROPOSED').at(-1)).toMatchObject({ waitingFor: [], autoAccepted: [1] })
    expect(eventsOf(s, 'OFFER_ACCEPTED').at(-1)).toMatchObject({ playerId: 1, auto: true })
    expect(eventsOf(s, 'OFFER_RESOLVED').at(-1)).toMatchObject({ agreed: true })
    expect(canClose(s)).toBe(true)
    expect(s.negotiation!.offersMade).toBe(2)

    s = step(s, { type: 'CLOSE_DEAL', playerId: 0 })
    for (const id of [1, 2, 3]) s = step(s, { type: 'PASS_CLOSING', playerId: id })
    expect(s.players[0].cash).toBe(3)
    expect(s.players[1].cash).toBe(3)
    expect(totalCash(s)).toBe(6)
    expect(s.dealHistory[0].payouts).toEqual([{ playerId: 1, amount: 3 }])
  })

  it('任何人拒绝即结束应答、回到 Boss：排在后面的人不再被询问，也不会改写自己的承诺价', () => {
    let s = baseState(4, 2)
    setInvestors(s, { A: 0, B: 1, C: 2, D: 3 })
    s.board[0].groups = [{ families: ['A', 'B', 'C'], need: 3 }]; s.board[0].dividends = 4 // #1 改为必需 A+B+C
    s = openDealAt(s, 1, 0)
    s = step(s, { type: 'PASS', playerId: 1 })
    s = step(s, { type: 'SPEAK', playerId: 2, say: 'C 3 块', quotes: [{ familyId: 'C', amount: 3 }] })
    s = toBoss(s)
    const keys = [investorRepKey('A'), investorRepKey('B'), investorRepKey('C')]
    s = step(s, { type: 'PROPOSE_OFFER', playerId: 0, repKeys: keys, payouts: [{ playerId: 1, amount: 1 }, { playerId: 2, amount: 1 }] })
    expect(s.phase).toBe('OFFER_RESPONSE')
    expect(s.negotiation!.responseQueue).toEqual([1, 2])

    s = step(s, { type: 'DECLINE_OFFER', playerId: 1 })
    expect(s.phase).toBe('NEGOTIATION')
    expect(getActingPlayerId(s)).toBe(0)
    rejects(s, { type: 'ACCEPT_OFFER', playerId: 2 }) // 玩家 2 不再被询问
    expect(s.negotiation!.offer!.responses[2]).toBeUndefined()
    expect(demandOf(s.negotiation!, 2, 'C')).toBe(3) // 承诺价没有被"同意 $1M"改写
    expect(eventsOf(s, 'OFFER_ACCEPTED')).toHaveLength(0)
    expect(eventsOf(s, 'OFFER_RESOLVED').at(-1)).toMatchObject({ agreed: false, declinerIds: [1] })
    expect(canClose(s)).toBe(false)
  })

  it('前面的人同意、后面的人拒绝：同样回到 Boss，方案不能成交', () => {
    let s = baseState(4, 2)
    setInvestors(s, { A: 0, B: 1, C: 2, D: 3 })
    s.board[0].groups = [{ families: ['A', 'B', 'C'], need: 3 }]; s.board[0].dividends = 4
    s = toBoss(openDealAt(s, 1, 0))
    const keys = [investorRepKey('A'), investorRepKey('B'), investorRepKey('C')]
    s = step(s, { type: 'PROPOSE_OFFER', playerId: 0, repKeys: keys, payouts: [{ playerId: 1, amount: 2 }, { playerId: 2, amount: 2 }] })
    s = step(s, { type: 'ACCEPT_OFFER', playerId: 1 })
    expect(getActingPlayerId(s)).toBe(2)
    s = step(s, { type: 'DECLINE_OFFER', playerId: 2 })
    expect(s.phase).toBe('NEGOTIATION')
    expect(getActingPlayerId(s)).toBe(0)
    expect(canClose(s)).toBe(false)
  })

  it('付不到承诺价则仍需表态；点头同意的价格成为新的承诺价', () => {
    let s = baseState(4, 2)
    setInvestors(s, { A: 0, B: 1, C: 2, D: 3 })
    s = openDealAt(s, 1, 0)
    s = step(s, { type: 'SPEAK', playerId: 1, say: '3 块', quotes: [{ familyId: 'B', amount: 3 }] })
    s = toBoss(s)
    const keys = [investorRepKey('A'), investorRepKey('B')]
    s = step(s, { type: 'PROPOSE_OFFER', playerId: 0, repKeys: keys, payouts: [{ playerId: 1, amount: 2 }] })
    expect(s.phase).toBe('OFFER_RESPONSE') // 2 < 3：要问
    s = step(s, { type: 'ACCEPT_OFFER', playerId: 1 })
    expect(demandOf(s.negotiation!, 1, 'B')).toBe(2) // 同意了 2，就以 2 为 B 代表的承诺价
    expect(demandOf(s.negotiation!, 1)).toBeUndefined() // 通用价（封口费）不受影响
    expect(eventsOf(s, 'DEMAND')).toHaveLength(1) // 静默更新，不再刷一条报价事件
    expect(canClose(s)).toBe(true)
  })

  it('同一玩家可对不同家族报不同价；方案按所用代表各自的价累计承诺', () => {
    let s = baseState(4, 2)
    setInvestors(s, { A: 0, B: 1, C: 1, D: 3 }) // 玩家 1 同时持有 B、C
    s.board[0].groups = [{ families: ['A', 'B', 'C'], need: 3 }]; s.board[0].dividends = 4 // #1 改为必需 A+B+C
    s = openDealAt(s, 1, 0)
    // 只对 B 报价 4；再对 C 报价 1
    s = step(s, { type: 'SPEAK', playerId: 1, say: 'B 要 4', quotes: [{ familyId: 'B', amount: 4 }] })
    expect(demandOf(s.negotiation!, 1, 'B')).toBe(4)
    expect(demandOf(s.negotiation!, 1, 'C')).toBeUndefined()
    s = step(s, { type: 'PASS', playerId: 2 }); s = step(s, { type: 'PASS', playerId: 3 }); s = step(s, { type: 'PASS', playerId: 0 })
    s = step(s, { type: 'SPEAK', playerId: 1, say: 'C 便宜，1 块', quotes: [{ familyId: 'C', amount: 1 }] })
    expect(demandOf(s.negotiation!, 1, 'B')).toBe(4) // B 的价不受 C 报价影响
    expect(demandOf(s.negotiation!, 1, 'C')).toBe(1)
    expect(eventsOf(s, 'DEMAND').map(e => e.kind === 'DEMAND' && e.quotes)).toEqual([[{ familyIds: ['B'], amount: 4 }], [{ familyIds: ['C'], amount: 1 }]])
    s = toBoss(s)
    const keys = [investorRepKey('A'), investorRepKey('B'), investorRepKey('C')]
    expect(commitmentPrice(s.negotiation!, { repKeys: keys }, 1)).toBe(5) // 4 + 1
    // 付 5 → 自动同意；付 4 → 仍需表态
    const paid5 = step(s, { type: 'PROPOSE_OFFER', playerId: 0, repKeys: keys, payouts: [{ playerId: 1, amount: 5 }] })
    expect(paid5.phase).toBe('NEGOTIATION')
    expect(canClose(paid5)).toBe(true)
    const paid4 = step(s, { type: 'PROPOSE_OFFER', playerId: 0, repKeys: keys, payouts: [{ playerId: 1, amount: 4 }] })
    expect(paid4.phase).toBe('OFFER_RESPONSE')
  })

  it('一句话里给每个代表各报各的价；通用价补到没单独报的家族', () => {
    let s = baseState(4, 2)
    setInvestors(s, { A: 0, B: 1, C: 1, D: 3 })
    s.board[0].groups = [{ families: ['A', 'B', 'C'], need: 3 }]; s.board[0].dividends = 4
    s = openDealAt(s, 1, 0)
    // 一次说完：B 4、C 1 —— 只占一次喊话
    s = step(s, { type: 'SPEAK', playerId: 1, say: 'B 4 块、C 1 块', quotes: [{ familyId: 'B', amount: 4 }, { familyId: 'C', amount: 1 }] })
    expect(s.negotiation!.speakCounts[1]).toBe(1)
    expect(demandOf(s.negotiation!, 1, 'B')).toBe(4)
    expect(demandOf(s.negotiation!, 1, 'C')).toBe(1)
    expect(demandOf(s.negotiation!, 1)).toBeUndefined()
    expect(eventsOf(s, 'DEMAND').at(-1)).toMatchObject({ playerId: 1, quotes: [{ familyIds: ['B'], amount: 4 }, { familyIds: ['C'], amount: 1 }] })
    expect(commitmentPrice(s.negotiation!, { repKeys: [investorRepKey('A'), investorRepKey('B'), investorRepKey('C')] }, 1)).toBe(5)
    // 显式 + 通用：C 改 2，其余（B）按通用价 3
    s = step(s, { type: 'PASS', playerId: 2 }); s = step(s, { type: 'PASS', playerId: 3 }); s = step(s, { type: 'PASS', playerId: 0 })
    s = step(s, { type: 'SPEAK', playerId: 1, say: 'C 2，别的 3', quotes: [{ amount: 3 }, { familyId: 'C', amount: 2 }] })
    expect(demandOf(s.negotiation!, 1, 'B')).toBe(3)
    expect(demandOf(s.negotiation!, 1, 'C')).toBe(2)
    expect(demandOf(s.negotiation!, 1)).toBeUndefined() // 有相关代表时通用价不会变成封口费
  })

  it('不指定家族的报价覆盖本格所有相关代表；没有相关代表时是封口费', () => {
    let s = baseState(4, 2)
    setInvestors(s, { A: 0, B: 1, C: 1, D: 3 })
    s.board[0].groups = [{ families: ['A', 'B', 'C'], need: 3 }]; s.board[0].dividends = 4
    s = openDealAt(s, 1, 0)
    s = step(s, { type: 'SPEAK', playerId: 1, say: '都是 2', quotes: [{ amount: 2 }] })
    expect(demandOf(s.negotiation!, 1, 'B')).toBe(2)
    expect(demandOf(s.negotiation!, 1, 'C')).toBe(2)
    expect(demandOf(s.negotiation!, 1)).toBeUndefined()
    expect(eventsOf(s, 'DEMAND').at(-1)).toMatchObject({ quotes: [{ familyIds: ['B', 'C'], amount: 2 }] })
    // 玩家 3 的 D 与本格无关：报价就是封口费
    s = step(s, { type: 'PASS', playerId: 2 })
    s = step(s, { type: 'SPEAK', playerId: 3, say: '给 1 块我不闹', quotes: [{ amount: 1 }] })
    expect(s.negotiation!.demands).toContainEqual({ playerId: 3, amount: 1 })
    expect(demandOf(s.negotiation!, 3)).toBe(1)
    expect(eventsOf(s, 'DEMAND').at(-1)).toMatchObject({ playerId: 3, quotes: [{ familyIds: [], amount: 1 }] })
  })

  it('报价校验：无关家族、重复家族、两条通用价、越界金额都不合法', () => {
    let s = baseState(4, 2)
    setInvestors(s, { A: 0, B: 1, C: 1, D: 3 })
    s.board[0].groups = [{ families: ['A', 'B', 'C'], need: 3 }]; s.board[0].dividends = 4
    s = openDealAt(s, 1, 0)
    rejects(s, { type: 'SPEAK', playerId: 1, say: 'x', quotes: [{ familyId: 'D', amount: 1 }] })                       // D 不是玩家 1 的相关家族
    rejects(s, { type: 'SPEAK', playerId: 1, say: 'x', quotes: [{ familyId: 'B', amount: 1 }, { familyId: 'B', amount: 2 }] })
    rejects(s, { type: 'SPEAK', playerId: 1, say: 'x', quotes: [{ amount: 1 }, { amount: 2 }] })
    rejects(s, { type: 'SPEAK', playerId: 1, say: 'x', quotes: [{ familyId: 'B', amount: getGrossValue(s) + 1 }] })
    rejects(s, { type: 'SPEAK', playerId: 1, say: 'x', quotes: [{ familyId: 'B', amount: 1.5 }] })
    expect(isLegal(s, { type: 'SPEAK', playerId: 1, say: 'x', quotes: [] })).toBe(true)
    // 反报价的作用域是方案所用的我的家族
    s = toBoss(s)
    s = step(s, { type: 'PROPOSE_OFFER', playerId: 0, repKeys: [investorRepKey('A'), investorRepKey('B'), investorRepKey('C')], payouts: [{ playerId: 1, amount: 1 }] })
    expect(s.phase).toBe('OFFER_RESPONSE')
    rejects(s, { type: 'DECLINE_OFFER', playerId: 1, quotes: [{ familyId: 'D', amount: 2 }] })
    s = step(s, { type: 'DECLINE_OFFER', playerId: 1, quotes: [{ familyId: 'B', amount: 3 }, { familyId: 'C', amount: 1 }] })
    expect(demandOf(s.negotiation!, 1, 'B')).toBe(3)
    expect(demandOf(s.negotiation!, 1, 'C')).toBe(1)
    expect(eventsOf(s, 'OFFER_DECLINED').at(-1)).toMatchObject({ counters: [{ familyIds: ['B'], amount: 3 }, { familyIds: ['C'], amount: 1 }] })
  })

  it('方案结构校验：重复家族、无关家族、给 Boss 分钱、超额分成都不合法', () => {
    const s = twoOwnerDeal()
    const A = investorRepKey('A'), B = investorRepKey('B'), C = investorRepKey('C')
    rejects(s, { type: 'PROPOSE_OFFER', playerId: 0, repKeys: [A], payouts: [] })          // 缺 B
    rejects(s, { type: 'PROPOSE_OFFER', playerId: 0, repKeys: [A, B, C], payouts: [] })    // C 与本格无关
    rejects(s, { type: 'PROPOSE_OFFER', playerId: 0, repKeys: [A, B], payouts: [{ playerId: 0, amount: 1 }] })
    rejects(s, { type: 'PROPOSE_OFFER', playerId: 0, repKeys: [A, B], payouts: [{ playerId: 1, amount: 7 }] })
    rejects(s, { type: 'PROPOSE_OFFER', playerId: 0, repKeys: [A, B], payouts: [{ playerId: 1, amount: -1 }] })
    rejects(s, { type: 'PROPOSE_OFFER', playerId: 1, repKeys: [A, B], payouts: [] })      // 非 Boss
    // 可以给没出代表的人分钱（封口费）
    expect(step(s, { type: 'PROPOSE_OFFER', playerId: 0, repKeys: [A, B], payouts: [{ playerId: 1, amount: 2 }, { playerId: 2, amount: 1 }] }).phase).toBe('OFFER_RESPONSE')
  })

  it('每任 Boss 最多提 5 次方案', () => {
    let s = twoOwnerDeal()
    const keys = [investorRepKey('A'), investorRepKey('B')]
    for (let i = 0; i < MAX_OFFERS_PER_BOSS; i++) {
      s = step(s, { type: 'PROPOSE_OFFER', playerId: 0, repKeys: keys, payouts: [] })
      s = step(s, { type: 'DECLINE_OFFER', playerId: 1 })
    }
    rejects(s, { type: 'PROPOSE_OFFER', playerId: 0, repKeys: keys, payouts: [] })
    expect(getLegalActions(s, 0).map(a => a.type)).not.toContain('PROPOSE_OFFER')
  })

  it('家族成员卡可替代投资者；成交后被选用的弃掉、未选用的回手', () => {
    let s = baseState(4, 3)
    setInvestors(s, { A: 0, C: 1, D: 2, E: 3 }) // B 无人持有
    clearHand(s, 1); clearHand(s, 2)
    const [clan1] = giveCards(s, 1, [{ type: 'CLAN', familyId: 'B' }])
    const [clan2] = giveCards(s, 2, [{ type: 'CLAN', familyId: 'B' }])
    s = openDealAt(s, 1, 0)
    s = step(s, { type: 'PLAY_CLAN', playerId: 1, cardId: clan1.id, demand: 2 })
    expect(s.players[1].hand).toHaveLength(0)
    expect(findRep(s.negotiation!, clanRepKey(clan1.id))).toMatchObject({ familyId: 'B', source: 'CLAN', ownerId: 1 })
    expect(s.negotiation!.demands).toEqual([{ playerId: 1, amount: 2, familyId: 'B' }])
    s = step(s, { type: 'PLAY_CLAN', playerId: 2, cardId: clan2.id })
    s = step(s, { type: 'PASS', playerId: 3 })

    // Boss 选玩家 2 的卡（更便宜），玩家 1 的卡落选
    s = step(s, { type: 'PROPOSE_OFFER', playerId: 0, repKeys: [investorRepKey('A'), clanRepKey(clan2.id)], payouts: [{ playerId: 2, amount: 1 }] })
    s = step(s, { type: 'ACCEPT_OFFER', playerId: 2 })
    s = step(s, { type: 'CLOSE_DEAL', playerId: 0 })
    for (const id of [1, 2, 3]) s = step(s, { type: 'PASS_CLOSING', playerId: id })
    expect(s.players[1].hand.map(c => c.id)).toEqual([clan1.id]) // 回手
    expect(s.players[2].hand).toHaveLength(0)
    expect(s.discardPile.map(c => c.id)).toContain(clan2.id)    // 弃置
    expect(s.players[2].cash).toBe(1)
    expect(s.players[0].cash).toBe(5)
  })

  it('同一家族已有自己的有效代表时不能再打同家族的家族卡', () => {
    let s = baseState(4, 3)
    setInvestors(s, { A: 0, B: 1, C: 2, D: 3 })
    clearHand(s, 1)
    const [clan] = giveCards(s, 1, [{ type: 'CLAN', familyId: 'B' }])
    s = openDealAt(s, 1, 0)
    rejects(s, { type: 'PLAY_CLAN', playerId: 1, cardId: clan.id })
  })

  it('Boss 打出自己的家族卡后仍由 Boss 行动，可紧接着成交；别人打卡则轮到下一位', () => {
    let s = baseState(4, 3)
    setInvestors(s, { A: 0, B: 1, C: 2, D: 3 })
    clearHand(s, 0); clearHand(s, 2)
    const [bossClan] = giveCards(s, 0, [{ type: 'CLAN', familyId: 'B' }])
    const [otherClan] = giveCards(s, 2, [{ type: 'CLAN', familyId: 'B' }])
    s = openDealAt(s, 1, 0)
    // 叫价轮：玩家 2 打卡后轮到玩家 3
    s = step(s, { type: 'PASS', playerId: 1 })
    s = step(s, { type: 'PLAY_CLAN', playerId: 2, cardId: otherClan.id, demand: 1 })
    expect(getActingPlayerId(s)).toBe(3)
    s = step(s, { type: 'PASS', playerId: 3 })
    // Boss 用自己的 B 卡替代玩家 1 / 2 的代表：仍是 Boss 行动，且已能独立成交
    s = step(s, { type: 'PLAY_CLAN', playerId: 0, cardId: bossClan.id })
    expect(getActingPlayerId(s)).toBe(0)
    expect(getLegalActions(s, 0).map(a => a.type)).toContain('CLOSE_DEAL')
    s = step(s, { type: 'CLOSE_DEAL', playerId: 0 })
    expect(s.phase).toBe('CLOSING')
  })
})

describe('影响牌', () => {
  function tableWithCards() {
    let s = baseState(4, 4)
    setInvestors(s, { A: 0, B: 1, C: 2, D: 3 })
    for (let i = 0; i < 4; i++) clearHand(s, i)
    return s
  }

  it('旅行牌：反应窗口依次询问出牌者以外的所有人；无人阻止则投资者本局失效、方案作废、回合回到 Boss', () => {
    let s = tableWithCards()
    const [travel] = giveCards(s, 2, [{ type: 'TRAVEL', familyId: 'B' }])
    s = toBoss(openDealAt(s, 1, 0))
    const keys = [investorRepKey('A'), investorRepKey('B')]
    s = step(s, { type: 'PROPOSE_OFFER', playerId: 0, repKeys: keys, payouts: [{ playerId: 1, amount: 2 }] })
    s = step(s, { type: 'ACCEPT_OFFER', playerId: 1 })
    s = step(s, { type: 'PASS', playerId: 0 })
    s = step(s, { type: 'PASS', playerId: 1 })
    // 定向旅行牌只能打同家族
    rejects(s, { type: 'PLAY_TRAVEL', playerId: 2, cardId: travel.id, targetRepKey: investorRepKey('A') })
    s = step(s, { type: 'PLAY_TRAVEL', playerId: 2, cardId: travel.id, targetRepKey: investorRepKey('B') })
    expect(s.phase).toBe('REACTION')
    expect(s.pendingReaction).toMatchObject({ actorId: 2, kind: 'TRAVEL', reactorId: 3 })
    expect(s.negotiation!.disruptors).toEqual([2])
    for (const id of [3, 0, 1]) {
      expect(getActingPlayerId(s)).toBe(id)
      expect(getLegalActions(s, id).map(a => a.type)).toEqual(['PASS_REACTION']) // 没人有阻止牌
      s = step(s, { type: 'PASS_REACTION', playerId: id })
    }
    expect(s.phase).toBe('NEGOTIATION')
    expect(findRep(s.negotiation!, investorRepKey('B'))!.travelled).toBe(true)
    expect(s.negotiation!.travelledInvestors).toEqual(['B'])
    expect(s.negotiation!.offer).toBeNull()
    expect(eventsOf(s, 'OFFER_VOIDED')).toHaveLength(1)
    expect(s.discardPile.map(c => c.id)).toContain(travel.id)
    expect(canClose(s)).toBe(false)
    expect(getActingPlayerId(s)).toBe(0) // 方案被打掉：回合回到 Boss 重新拿方案
  })

  it('旅行牌没打到方案里的代表 → 出牌者的下一位继续', () => {
    let s = tableWithCards()
    const [travel] = giveCards(s, 2, [{ type: 'TRAVEL' }])
    s = openDealAt(s, 2, 0) // #2：C/D/E 中选 2；桌上 C(2)、D(3)
    s = step(s, { type: 'PASS', playerId: 1 })
    s = step(s, { type: 'PLAY_TRAVEL', playerId: 2, cardId: travel.id, targetRepKey: investorRepKey('D') })
    for (const id of [3, 0, 1]) s = step(s, { type: 'PASS_REACTION', playerId: id })
    expect(s.phase).toBe('NEGOTIATION')
    expect(getActingPlayerId(s)).toBe(3)
  })

  it('阻止牌取消旅行牌：两张牌都弃掉，代表仍然有效', () => {
    let s = tableWithCards()
    const [travel] = giveCards(s, 2, [{ type: 'TRAVEL' }]) // 万能旅行
    const [stop] = giveCards(s, 1, [{ type: 'STOP' }])
    s = openDealAt(s, 1, 0)
    s = step(s, { type: 'PASS', playerId: 1 })
    s = step(s, { type: 'PLAY_TRAVEL', playerId: 2, cardId: travel.id, targetRepKey: investorRepKey('B') })
    s = step(s, { type: 'PASS_REACTION', playerId: 3 })
    s = step(s, { type: 'PASS_REACTION', playerId: 0 })
    expect(getLegalActions(s, 1).map(a => a.type)).toEqual(['PLAY_STOP', 'PASS_REACTION'])
    s = step(s, { type: 'PLAY_STOP', playerId: 1 })
    expect(s.phase).toBe('NEGOTIATION')
    expect(findRep(s.negotiation!, investorRepKey('B'))!.travelled).toBe(false)
    expect(s.discardPile.map(c => c.id)).toEqual(expect.arrayContaining([travel.id, stop.id]))
    expect(s.players[1].hand).toHaveLength(0)
    expect(eventsOf(s, 'STOP_PLAYED')).toHaveLength(1)
  })

  it('旅行牌打在家族卡上：两张牌立即弃置', () => {
    let s = tableWithCards()
    const [clan] = giveCards(s, 1, [{ type: 'CLAN', familyId: 'C' }])
    const [travel] = giveCards(s, 2, [{ type: 'TRAVEL', familyId: 'C' }])
    s = openDealAt(s, 2, 0) // #2：C/D/E 中选 2
    s = step(s, { type: 'PLAY_CLAN', playerId: 1, cardId: clan.id })
    s = step(s, { type: 'PLAY_TRAVEL', playerId: 2, cardId: travel.id, targetRepKey: clanRepKey(clan.id) })
    for (const id of [3, 0, 1]) s = step(s, { type: 'PASS_REACTION', playerId: id })
    expect(findRep(s.negotiation!, clanRepKey(clan.id))!.travelled).toBe(true)
    expect(s.discardPile.map(c => c.id)).toEqual(expect.arrayContaining([clan.id, travel.id]))
    expect(s.negotiation!.travelledInvestors).toEqual([]) // 家族卡不影响投资者
  })

  it('老板牌：夺权后接管谈判，原方案作废、提案次数清零；原 Boss 仍可参与', () => {
    let s = tableWithCards()
    const [boss] = giveCards(s, 2, [{ type: 'BOSS' }])
    s = toBoss(openDealAt(s, 1, 0))
    s = step(s, { type: 'PROPOSE_OFFER', playerId: 0, repKeys: [investorRepKey('A'), investorRepKey('B')], payouts: [{ playerId: 1, amount: 2 }] })
    s = step(s, { type: 'ACCEPT_OFFER', playerId: 1 })
    s = step(s, { type: 'PASS', playerId: 0 })
    s = step(s, { type: 'PASS', playerId: 1 })
    s = step(s, { type: 'PLAY_BOSS', playerId: 2, cardId: boss.id })
    expect(s.phase).toBe('REACTION')
    for (const id of [3, 0, 1]) s = step(s, { type: 'PASS_REACTION', playerId: id })
    expect(s.negotiation!.bossId).toBe(2)
    expect(s.negotiation!.openerId).toBe(0)
    expect(s.negotiation!.offer).toBeNull()
    expect(s.negotiation!.offersMade).toBe(0)
    expect(getActingPlayerId(s)).toBe(2) // 新 Boss 立刻行动
    // 现在的 Boss 不能再对自己打老板牌；原 Boss 可以
    const [boss2] = giveCards(s, 0, [{ type: 'BOSS' }])
    s = step(s, { type: 'PASS', playerId: 2 })
    s = step(s, { type: 'PASS', playerId: 3 })
    expect(getLegalActions(s, 0).map(a => a.type)).toContain('PLAY_BOSS')
    s = step(s, { type: 'PLAY_BOSS', playerId: 0, cardId: boss2.id })
    for (const id of [1, 2, 3]) s = step(s, { type: 'PASS_REACTION', playerId: id })
    expect(s.negotiation!.bossId).toBe(0)
  })

  it('招募三连：有公共区投资者时必须先招公共区；成功后所有权永久转移且谈判中的代表随之易主', () => {
    let s = tableWithCards() // E、F 在公共区
    giveCards(s, 3, [{ type: 'RECRUITMENT' }, { type: 'RECRUITMENT' }, { type: 'RECRUITMENT' }])
    const ids = s.players[3].hand.map(c => c.id)
    expect(recruitTargets(s, 3)).toEqual(['E', 'F'])
    s = openDealAt(s, 5, 0) // #5 需要 E+F
    for (const id of [1, 2]) s = step(s, { type: 'PASS', playerId: id })
    rejects(s, { type: 'PLAY_RECRUITMENT', playerId: 3, cardIds: ids, targetFamilyId: 'A' })
    rejects(s, { type: 'PLAY_RECRUITMENT', playerId: 3, cardIds: ids.slice(0, 2), targetFamilyId: 'E' })
    s = step(s, { type: 'PLAY_RECRUITMENT', playerId: 3, cardIds: ids, targetFamilyId: 'E' })
    for (const id of [0, 1, 2]) s = step(s, { type: 'PASS_REACTION', playerId: id })
    expect(s.investors.find(i => i.familyId === 'E')!.ownerId).toBe(3)
    expect(findRep(s.negotiation!, investorRepKey('E'))).toMatchObject({ ownerId: 3, source: 'INVESTOR' })
    expect(s.players[3].hand).toHaveLength(0)
    expect(s.discardPile.filter(c => c.type === 'RECRUITMENT')).toHaveLength(3)
    // 公共区只剩 F 时仍须先招 F
    giveCards(s, 3, [{ type: 'RECRUITMENT' }, { type: 'RECRUITMENT' }, { type: 'RECRUITMENT' }])
    expect(recruitTargets(s, 3)).toEqual(['F'])
  })

  it('公共区为空时可以夺取任意其他玩家的投资者，且自己的不在目标里', () => {
    const s = baseState(6, 5)
    giveCards(s, 0, [{ type: 'RECRUITMENT' }, { type: 'RECRUITMENT' }, { type: 'RECRUITMENT' }])
    const mine = s.investors.find(i => i.ownerId === 0)!.familyId
    const targets = recruitTargets(s, 0)
    expect(targets).toHaveLength(5)
    expect(targets).not.toContain(mine)
  })

  it('成交倒计时中打出干扰牌并生效 → 倒计时中断回到谈判；被阻止 → 同一玩家继续决定', () => {
    let s = tableWithCards()
    const [travel] = giveCards(s, 2, [{ type: 'TRAVEL' }])
    const [stop] = giveCards(s, 0, [{ type: 'STOP' }])
    s = toBoss(openDealAt(s, 1, 0))
    s = step(s, { type: 'PROPOSE_OFFER', playerId: 0, repKeys: [investorRepKey('A'), investorRepKey('B')], payouts: [{ playerId: 1, amount: 2 }] })
    s = step(s, { type: 'ACCEPT_OFFER', playerId: 1 })
    s = step(s, { type: 'CLOSE_DEAL', playerId: 0 })
    s = step(s, { type: 'PASS_CLOSING', playerId: 1 })
    expect(getActingPlayerId(s)).toBe(2)
    s = step(s, { type: 'PLAY_TRAVEL', playerId: 2, cardId: travel.id, targetRepKey: investorRepKey('B') })
    expect(s.pendingReaction!.returnPhase).toBe('CLOSING')
    s = step(s, { type: 'PASS_REACTION', playerId: 3 })
    s = step(s, { type: 'PLAY_STOP', playerId: 0 })
    expect(s.phase).toBe('CLOSING')
    expect(getActingPlayerId(s)).toBe(2) // 被阻止：还是玩家 2 决定放行与否
    s = step(s, { type: 'PASS_CLOSING', playerId: 2 })
    s = step(s, { type: 'PASS_CLOSING', playerId: 3 })
    expect(s.phase).toBe('TURN')
    expect(s.players[0].cash).toBe(4)
    expect(s.players[1].cash).toBe(2)
    expect(s.discardPile.map(c => c.id)).toEqual(expect.arrayContaining([travel.id, stop.id]))
  })

  it('成交倒计时中的旅行牌生效后回到谈判，方案作废', () => {
    let s = tableWithCards()
    const [travel] = giveCards(s, 2, [{ type: 'TRAVEL' }])
    s = toBoss(openDealAt(s, 1, 0))
    s = step(s, { type: 'PROPOSE_OFFER', playerId: 0, repKeys: [investorRepKey('A'), investorRepKey('B')], payouts: [{ playerId: 1, amount: 2 }] })
    s = step(s, { type: 'ACCEPT_OFFER', playerId: 1 })
    s = step(s, { type: 'CLOSE_DEAL', playerId: 0 })
    s = step(s, { type: 'PASS_CLOSING', playerId: 1 })
    s = step(s, { type: 'PLAY_TRAVEL', playerId: 2, cardId: travel.id, targetRepKey: investorRepKey('B') })
    for (const id of [3, 0, 1]) s = step(s, { type: 'PASS_REACTION', playerId: id })
    expect(s.phase).toBe('NEGOTIATION')
    expect(getActingPlayerId(s)).toBe(0)
    expect(s.negotiation!.offer).toBeNull()
    expect(eventsOf(s, 'CLOSING_INTERRUPTED')).toHaveLength(1)
  })
})

describe('流局', () => {
  it('Boss 放弃：家族卡回手、无人拿钱、标记留在原地、Boss 左手边接着行动', () => {
    let s = baseState(4, 6)
    setInvestors(s, { A: 0, C: 1, D: 2, E: 3 })
    clearHand(s, 1)
    const [clan] = giveCards(s, 1, [{ type: 'CLAN', familyId: 'B' }])
    s = openDealAt(s, 1, 0)
    s = step(s, { type: 'PLAY_CLAN', playerId: 1, cardId: clan.id })
    s = step(s, { type: 'PASS', playerId: 2 })
    s = step(s, { type: 'PASS', playerId: 3 })
    s = step(s, { type: 'ABANDON_DEAL', playerId: 0 })
    expect(s.phase).toBe('TURN')
    expect(s.currentId).toBe(1)
    expect(s.markerPos).toBe(1)
    expect(s.players[1].hand.map(c => c.id)).toEqual([clan.id])
    expect(totalCash(s)).toBe(0)
    expect(s.dealHistory[0]).toMatchObject({ success: false, failReason: 'ABANDONED', bossId: 0 })
    expect(s.board.every(b => b.closedByTileId == null)).toBe(true)
  })

  it('连续两整轮全员跳过判僵局流局', () => {
    let s = baseState(3, 7)
    s = openDealAt(s, 14, 0) // #14 需要 5 个家族，3 人局理论上凑得齐但大家都不动
    const n = s.players.length
    for (let round = 0; round < MAX_STALEMATE_ROUNDS; round++) {
      for (let i = 0; i < n; i++) {
        expect(s.phase).toBe('NEGOTIATION')
        s = step(s, { type: 'PASS', playerId: getActingPlayerId(s) })
      }
    }
    expect(s.phase).toBe('TURN')
    expect(s.dealHistory[0]).toMatchObject({ success: false, failReason: 'STALEMATE' })
    expect(eventsOf(s, 'STALEMATE_ROUND')).toHaveLength(MAX_STALEMATE_ROUNDS - 1)
  })

  it('任何实质行动都会重置跳过计数', () => {
    let s = baseState(3, 7)
    s = openDealAt(s, 14, 0)
    s = step(s, { type: 'PASS', playerId: 1 })
    s = step(s, { type: 'PASS', playerId: 2 })
    s = step(s, { type: 'SPEAK', playerId: 0, say: '等等，我有话说' })
    expect(s.negotiation!.passStreak).toBe(0)
    expect(s.negotiation!.stalemateRounds).toBe(0)
  })
})

describe('回合与手牌', () => {
  it('掷骰移动后可以发起交易或抽 3 张牌结束回合', () => {
    let s = baseState(4, 8)
    s.phase = 'TURN'; s.currentId = 0; s.markerChooserId = null; s.markerPos = 1
    s = step(s, { type: 'ROLL_MOVE', playerId: 0 })
    expect(s.phase).toBe('AFTER_MOVE')
    expect(s.lastDie).toBeGreaterThanOrEqual(1)
    expect(s.markerPos).toBe(1 + s.lastDie!)
    expect(getLegalActions(s, 0).map(a => a.type).sort()).toEqual(['DRAW_CARDS', 'OPEN_DEAL'])
    const before = s.players[0].hand.length
    s = step(s, { type: 'DRAW_CARDS', playerId: 0 })
    expect(s.players[0].hand).toHaveLength(before + 3)
    expect(s.phase).toBe('TURN')
    expect(s.currentId).toBe(1)
  })

  it('抽牌超过 12 张必须立刻弃到 12 张（弃牌数必须恰好等于超出数）', () => {
    let s = baseState(4, 8)
    clearHand(s, 0)
    giveCards(s, 0, Array.from({ length: 11 }, () => ({ type: 'RECRUITMENT' as const })))
    // 11 张招募牌 + 抽 3 张 → 14 张；招募三连也是合法出路
    s.phase = 'AFTER_MOVE'; s.currentId = 0; s.markerChooserId = null
    s = step(s, { type: 'DRAW_CARDS', playerId: 0 })
    expect(s.phase).toBe('HAND_LIMIT')
    expect(s.players[0].hand).toHaveLength(14)
    const ids = s.players[0].hand.map(c => c.id)
    rejects(s, { type: 'DISCARD', playerId: 0, cardIds: ids.slice(0, 1) })
    rejects(s, { type: 'DISCARD', playerId: 0, cardIds: ids.slice(0, 3) })
    rejects(s, { type: 'DISCARD', playerId: 0, cardIds: [ids[0], ids[0]] })
    expect(getLegalActions(s, 0).some(a => a.type === 'PLAY_RECRUITMENT')).toBe(true)
    s = step(s, { type: 'DISCARD', playerId: 0, cardIds: ids.slice(0, 2) })
    expect(s.players[0].hand).toHaveLength(HAND_LIMIT)
    expect(s.phase).toBe('TURN')
    expect(s.currentId).toBe(1)
  })

  it('手牌超限时打出招募三连（无谈判也可）；解决后若仍超限继续处理', () => {
    let s = baseState(4, 8)
    clearHand(s, 0)
    giveCards(s, 0, Array.from({ length: 11 }, () => ({ type: 'RECRUITMENT' as const })))
    s.phase = 'AFTER_MOVE'; s.currentId = 0; s.markerChooserId = null
    s = step(s, { type: 'DRAW_CARDS', playerId: 0 })
    const recruits = s.players[0].hand.filter(c => c.type === 'RECRUITMENT').slice(0, 3).map(c => c.id)
    const target = recruitTargets(s, 0)[0]
    s = step(s, { type: 'PLAY_RECRUITMENT', playerId: 0, cardIds: recruits, targetFamilyId: target })
    expect(s.phase).toBe('REACTION')
    expect(s.pendingReaction!.returnPhase).toBe('HAND_LIMIT')
    for (const id of [1, 2, 3]) s = step(s, { type: 'PASS_REACTION', playerId: id })
    expect(s.investors.find(i => i.familyId === target)!.ownerId).toBe(0)
    expect(s.players[0].hand).toHaveLength(11)
    expect(s.phase).toBe('TURN') // 11 ≤ 12，回合结束
    expect(s.currentId).toBe(1)
  })

  it(`每人每笔交易最多喊话 ${MAX_SPEECHES_PER_PLAYER} 次，喊话必须有内容`, () => {
    let s = baseState(3, 9)
    s = openDealAt(s, 14, 0)
    for (let i = 0; i < MAX_SPEECHES_PER_PLAYER; i++) {
      s = step(s, { type: 'SPEAK', playerId: 1, say: `第 ${i + 1} 句` })
      s = step(s, { type: 'PASS', playerId: 2 })
      s = step(s, { type: 'PASS', playerId: 0 })
    }
    rejects(s, { type: 'SPEAK', playerId: 1, say: `第 ${MAX_SPEECHES_PER_PLAYER + 1} 句` })
    s = step(s, { type: 'PASS', playerId: 1 })
    rejects(s, { type: 'SPEAK', playerId: 2, say: '   ' })
    expect(s.negotiation!.speeches).toHaveLength(MAX_SPEECHES_PER_PLAYER)
  })
})

describe('台词与事件', () => {
  it('任何动作附带 say 都会产生 SPEECH 事件并更新座位气泡；反应窗口的放行保持沉默', () => {
    let s = baseState(4, 10)
    for (let i = 0; i < 4; i++) clearHand(s, i)
    const [travel] = giveCards(s, 1, [{ type: 'TRAVEL' }])
    setInvestors(s, { A: 0, B: 1, C: 2, D: 3 })
    s = openDealAt(s, 1, 0)
    s = step(s, { type: 'PASS', playerId: 1, say: '你们先说。' })
    expect(s.players[1].lastSpeech).toBe('你们先说。')
    expect(eventsOf(s, 'SPEECH').at(-1)).toMatchObject({ playerId: 1, text: '你们先说。' })
    expect(s.negotiation!.speeches.at(-1)).toMatchObject({ playerId: 1, text: '你们先说。' })
    s = step(s, { type: 'PASS', playerId: 2 })
    s = step(s, { type: 'PASS', playerId: 3 })
    s = step(s, { type: 'PASS', playerId: 0 })
    s = step(s, { type: 'PLAY_TRAVEL', playerId: 1, cardId: travel.id, targetRepKey: investorRepKey('A') })
    const before = eventsOf(s, 'SPEECH').length
    s = step(s, { type: 'PASS_REACTION', playerId: 2, say: '我可没阻止牌' })
    expect(eventsOf(s, 'SPEECH')).toHaveLength(before)
    expect(s.players[2].lastSpeech).toBeUndefined()
  })

  it('谈判开始与结束会清空座位气泡', () => {
    let s = baseState(4, 10)
    setInvestors(s, { A: 0, B: 0, C: 1, D: 2, E: 3 })
    s = toBoss(openDealAt(s, 1, 0))
    s = step(s, { type: 'CLOSE_DEAL', playerId: 0, say: '成交！' })
    expect(s.players[0].lastSpeech).toBe('成交！')
    for (const id of [1, 2, 3]) s = step(s, { type: 'PASS_CLOSING', playerId: id })
    expect(s.players.every(p => p.lastSpeech === undefined)).toBe(true)
  })
})

describe('非法动作', () => {
  it('不是行动者 / 阶段不对 / 引用不存在的牌，一律原状态返回', () => {
    let s = baseState(4, 11)
    setInvestors(s, { A: 0, B: 1, C: 2, D: 3 })
    rejects(s, { type: 'OPEN_DEAL', playerId: 0 }) // 还在放置标记阶段
    s = openDealAt(s, 1, 0)
    rejects(s, { type: 'PASS', playerId: 0 })       // 叫价轮先轮到 1
    rejects(s, { type: 'ROLL_MOVE', playerId: 1 })  // 谈判中不能掷骰
    rejects(s, { type: 'PLAY_TRAVEL', playerId: 1, cardId: 99999, targetRepKey: investorRepKey('B') })
    rejects(s, { type: 'PLAY_STOP', playerId: 1 })
    rejects(s, { type: 'ACCEPT_OFFER', playerId: 1 })
    rejects(s, { type: 'PASS', playerId: 42 })
  })
})

describe('终局', () => {
  function closeSoloDeal(s: ReturnType<typeof baseState>, spaceId: number) {
    s = toBoss(openDealAt(s, spaceId, 0))
    s = step(s, { type: 'CLOSE_DEAL', playerId: 0 })
    for (const id of [1, 2, 3]) s = step(s, { type: 'PASS_CLOSING', playerId: id })
    return s
  }

  it('第 10 笔起成交后 Boss 掷骰：命中景气牌背面数字则结束，否则继续', () => {
    const base = baseState(4, 12)
    setInvestors(base, { A: 0, B: 0, C: 1, D: 2, E: 3 })
    base.completedDeals = 9
    base.dealTileIndex = 9 // 景气牌 #10，终局骰面 [1]
    for (let i = 2; i <= 10; i++) base.board.find(b => b.id === i)!.closedByTileId = i - 1
    let s = closeSoloDeal(base, 1)
    expect(s.phase).toBe('END_ROLL')
    expect(s.currentId).toBe(0)
    expect(eventsOf(s, 'END_ROLL_DUE').at(-1)).toMatchObject({ faces: [1] })

    // 穷举 rng 直到分别观察到命中与未命中
    let sawHit = false, sawMiss = false
    for (let r = 1; r < 200 && !(sawHit && sawMiss); r++) {
      const trial = structuredClone(s)
      trial.rng = r
      const after = step(trial, { type: 'ROLL_END', playerId: 0 })
      const ev = eventsOf(after, 'END_ROLL').at(-1)!
      expect(ev.kind === 'END_ROLL' && ev.hit).toBe(after.lastDie === 1)
      if (after.lastDie === 1) { sawHit = true; expect(after.phase).toBe('GAME_OVER'); expect(after.winnerIds).toEqual([0]) }
      else { sawMiss = true; expect(after.phase).toBe('TURN'); expect(after.currentId).toBe(1) }
    }
    expect(sawHit && sawMiss).toBe(true)
  })

  it('第 15 笔成交后直接结束，不掷骰；现金最多者胜，同分并列', () => {
    const base = baseState(4, 13)
    setInvestors(base, { A: 0, B: 0, C: 1, D: 2, E: 3 })
    base.completedDeals = 14
    base.dealTileIndex = 14
    for (let i = 2; i <= 15; i++) base.board.find(b => b.id === i)!.closedByTileId = i - 1
    base.players[1].cash = 15 // 与 Boss 本笔所得并列：#1 3 份 × $5M = 15
    const s = closeSoloDeal(base, 1)
    expect(s.phase).toBe('GAME_OVER')
    expect(s.players[0].cash).toBe(15)
    expect(s.winnerIds).toEqual([0, 1])
    expect(eventsOf(s, 'GAME_OVER').at(-1)).toMatchObject({ winnerIds: [0, 1], cash: 15 })
    expect(getLegalActions(s, 0)).toEqual([])
  })
})
