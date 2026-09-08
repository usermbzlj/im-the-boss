// 变体与扩展规则：15 / 16 / 22 / 30 笔版本、夺回权、特殊格、稀有牌
// 经典变体的官方规则由 config.test / engine.test 覆盖；这里只验证新增内容及其对经典规则的兼容

import { describe, it, expect } from 'vitest'
import {
  VARIANTS, VARIANT_IDS, VARIANT_LIST, getVariant, makeDealTiles, DEAL_TILES, buildBoard, createDeckFor, ringLayout,
  STARTING_HAND, LANDMARK_RENT, PREMIUM_BONUS, BOOM_BONUS, BUST_PENALTY, MIN_SHARE_VALUE, HEADHUNT_RECRUIT_COST, RECLAIM_RECRUIT_COST, RECRUIT_COST,
} from '../src/engine/config'
import { createInitialState, SAVE_VERSION, gameReducer } from '../src/engine/gameEngine'
import { getActingPlayerId, getLegalActions } from '../src/engine/validator'
import {
  spaceInvestorCount, investorRepKey, getGrossValue, effectiveShareValue, recruitCost, recruitTargets, canReclaim,
  isExclusiveLocked, isBlackMarketDeal, landlords, landmarkRentEstimate,
} from '../src/engine/rules'
import { runGame } from '../src/sim/harness'
import { baseState, setInvestors, giveCards, clearHand, step, rejects, openDealAt, toBoss, eventsOf, totalCash, spaceOfKind, ownSpaceFamilies, closeSolo } from './helpers'

describe('变体配置', () => {
  it('四个变体：成交笔数 15 / 16 / 22 / 30，版图 16 / 16 / 24 / 32 格，牌堆 98 / 105 / 117 / 129 张', () => {
    expect(VARIANT_IDS).toEqual(['classic', 'full', 'expansion', 'marathon'])
    const rows = VARIANT_LIST.map(v => [v.deals, v.boardSize, v.deckSize])
    expect(rows).toEqual([[15, 16, 98], [16, 16, 105], [22, 24, 117], [30, 32, 129]])
    expect(getVariant(undefined).id).toBe('classic')
    expect(getVariant('marathon').maxShare).toBe(7)
  })

  it('景气牌生成器复现官方 15 张；各变体股价从 $2M 单调升到 maxShare，最后 6 张带 1..k 终局骰面', () => {
    expect(makeDealTiles(15, 5)).toEqual(DEAL_TILES)
    for (const v of Object.values(VARIANTS)) {
      const tiles = makeDealTiles(v.deals, v.maxShare)
      expect(tiles).toHaveLength(v.deals)
      expect(tiles[0].shareValue).toBe(2)
      expect(tiles.at(-1)!.shareValue).toBe(v.maxShare)
      for (let i = 1; i < tiles.length; i++) expect(tiles[i].shareValue).toBeGreaterThanOrEqual(tiles[i - 1].shareValue)
      for (const [i, t] of tiles.entries()) {
        const k = i - (tiles.length - 6)
        expect(t.endFaces, `${v.id} 第 ${t.id} 张`).toEqual(k < 0 ? [] : Array.from({ length: k + 1 }, (_, f) => f + 1))
      }
    }
  })

  it('所有版图：分红份数 = 所需投资者数 + 1；同格家族不重叠；特殊格只出现在扩张 / 马拉松', () => {
    for (const v of Object.values(VARIANTS)) {
      const board = buildBoard(v.spaces)
      expect(board.map(b => b.id)).toEqual(board.map((_, i) => i + 1))
      for (const space of board) {
        expect(space.dividends, `${v.id} #${space.id}`).toBe(spaceInvestorCount(space) + 1)
        const seen = new Set<string>()
        for (const g of space.groups) {
          expect(g.need).toBeLessThanOrEqual(g.families.length)
          for (const f of g.families) { expect(seen.has(f)).toBe(false); seen.add(f) }
        }
      }
      const special = board.filter(b => b.kind !== 'STANDARD')
      if (v.id === 'classic' || v.id === 'full') expect(special).toHaveLength(0)
      else {
        for (const kind of ['LANDMARK', 'PREMIUM', 'BLACK_MARKET', 'HEADHUNT'] as const) {
          expect(special.some(b => b.kind === kind), `${v.id} 缺 ${kind}`).toBe(true)
        }
        // 新格交错散布，而不是堆在末尾
        const ids = special.map(b => b.id)
        expect(Math.min(...ids)).toBeLessThan(board.length / 2)
      }
    }
    expect(buildBoard(VARIANTS.marathon.spaces).filter(b => b.kind === 'LANDMARK')).toHaveLength(4)
  })

  it('牌堆：稀有牌只在扩展变体；补充包按比例；id 唯一', () => {
    const classic = createDeckFor(VARIANTS.classic)
    expect(classic.some(c => c.type === 'BOOM' || c.type === 'BUST' || c.type === 'EXCLUSIVE')).toBe(false)
    const full = createDeckFor(VARIANTS.full)
    expect(full.filter(c => c.type === 'BOOM')).toHaveLength(3)
    expect(full.filter(c => c.type === 'BUST')).toHaveLength(2)
    expect(full.filter(c => c.type === 'EXCLUSIVE')).toHaveLength(2)
    const marathon = createDeckFor(VARIANTS.marathon)
    expect(marathon.filter(c => c.type === 'CLAN')).toHaveLength(24 + 12)
    expect(marathon.filter(c => c.type === 'RECRUITMENT')).toHaveLength(33 + 6)
    expect(marathon.filter(c => c.type === 'STOP')).toHaveLength(12)
    for (const deck of [classic, full, marathon]) expect(new Set(deck.map(c => c.id)).size).toBe(deck.length)
  })

  it('环形布局：n 格正好铺满外圈且互不重叠', () => {
    for (const n of [16, 24, 32]) {
      const { cols, rows, cells } = ringLayout(n)
      expect(cells).toHaveLength(n)
      expect(2 * cols + 2 * (rows - 2)).toBe(n)
      expect(new Set(cells.map(c => `${c.row},${c.col}`)).size).toBe(n)
      for (const c of cells) expect(c.row === 1 || c.row === rows || c.col === 1 || c.col === cols).toBe(true)
    }
  })

  it('开局按变体组桌：版图 / 景气牌 / 牌堆 / 存档版本', () => {
    const s = createInitialState(5, '我', 3, 'marathon')
    expect(s.variantId).toBe('marathon')
    expect(s.board).toHaveLength(32)
    expect(s.dealTiles).toHaveLength(30)
    expect(s.drawPile).toHaveLength(129 - STARTING_HAND * 5)
    expect(s.saveVersion).toBe(SAVE_VERSION)
    expect(eventsOf(s, 'GAME_STARTED')[0]).toMatchObject({ variantId: 'marathon', deals: 30 })
    expect(createInitialState(4, '我', 3).variantId).toBe('classic')
    // 旧存档不兼容
    const old = { ...s, saveVersion: SAVE_VERSION - 1 }
    expect(gameReducer(null, { type: 'LOAD_GAME', state: old })).toBeNull()
  })
})

describe('夺回权（任何变体）', () => {
  function sixSeats() {
    const s = baseState(6, 21)
    for (let i = 0; i < 6; i++) clearHand(s, i)
    setInvestors(s, { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5 })
    return s
  }

  it('最后一位常驻投资者被招募走 → 受害者获得夺回权：1 张招募牌即可抢回，成功后夺回权消失', () => {
    let s = sixSeats()
    const ids = giveCards(s, 3, [{ type: 'RECRUITMENT' }, { type: 'RECRUITMENT' }, { type: 'RECRUITMENT' }]).map(c => c.id)
    s = openDealAt(s, 1, 0) // #1 需要 A+B
    for (const id of [1, 2]) s = step(s, { type: 'PASS', playerId: id })
    s = step(s, { type: 'PLAY_RECRUITMENT', playerId: 3, cardIds: ids, targetFamilyId: 'B' })
    while (s.phase === 'REACTION') s = step(s, { type: 'PASS_REACTION', playerId: getActingPlayerId(s) })
    expect(s.investors.find(i => i.familyId === 'B')!.ownerId).toBe(3)
    expect(s.players[1].reclaim).toBe('B')
    expect(eventsOf(s, 'RECLAIM_GRANTED').at(-1)).toMatchObject({ playerId: 1, familyId: 'B' })
    expect(canReclaim(s, 1, 'B')).toBe(true)
    expect(recruitCost(s, 1, 'B')).toBe(RECLAIM_RECRUIT_COST)
    expect(recruitCost(s, 1, 'C')).toBe(RECRUIT_COST)
    expect(recruitTargets(s, 1)).toContain('B')
    // 招募者自己没有失去最后一位（还有 D）→ 没有夺回权
    expect(s.players[3].reclaim ?? null).toBeNull()

    // 受害者只有 1 张招募牌：只能夺回 B，招别家不够
    const [one] = giveCards(s, 1, [{ type: 'RECRUITMENT' }])
    while (getActingPlayerId(s) !== 1) s = step(s, { type: 'PASS', playerId: getActingPlayerId(s) })
    const options = getLegalActions(s, 1).filter(a => a.type === 'PLAY_RECRUITMENT')
    expect(options).toEqual([expect.objectContaining({ cardIds: [one.id], targetFamilyId: 'B' })])
    rejects(s, { type: 'PLAY_RECRUITMENT', playerId: 1, cardIds: [one.id], targetFamilyId: 'C' })
    s = step(s, { type: 'PLAY_RECRUITMENT', playerId: 1, cardIds: [one.id], targetFamilyId: 'B' })
    expect(eventsOf(s, 'RECRUITMENT_PLAYED').at(-1)).toMatchObject({ playerId: 1, familyId: 'B', fromId: 3, cost: 1 })
    while (s.phase === 'REACTION') s = step(s, { type: 'PASS_REACTION', playerId: getActingPlayerId(s) })
    expect(s.investors.find(i => i.familyId === 'B')!.ownerId).toBe(1)
    expect(s.players[1].reclaim ?? null).toBeNull()
    expect(s.players[1].hand).toHaveLength(0)
    // 3 还剩 D，不触发夺回权
    expect(s.players[3].reclaim ?? null).toBeNull()
    // 谈判中的代表随之易主
    expect(s.negotiation!.reps.find(r => r.key === investorRepKey('B'))!.ownerId).toBe(1)
  })

  it('夺回权在重新拥有任何投资者后失效；招募者若因此失去最后一位，也获得夺回权（拉锯）', () => {
    let s = sixSeats()
    // 4 只有 E；1 只有 B。1 招走 E → 4 得到夺回权
    const ids = giveCards(s, 1, [{ type: 'RECRUITMENT' }, { type: 'RECRUITMENT' }, { type: 'RECRUITMENT' }]).map(c => c.id)
    s = openDealAt(s, 5, 0) // #5 需要 E+F
    s = step(s, { type: 'PLAY_RECRUITMENT', playerId: 1, cardIds: ids, targetFamilyId: 'E' })
    while (s.phase === 'REACTION') s = step(s, { type: 'PASS_REACTION', playerId: getActingPlayerId(s) })
    expect(s.players[4].reclaim).toBe('E')
    // 4 花 3 张招别家（F）→ 夺回权失效
    const more = giveCards(s, 4, [{ type: 'RECRUITMENT' }, { type: 'RECRUITMENT' }, { type: 'RECRUITMENT' }]).map(c => c.id)
    while (getActingPlayerId(s) !== 4) s = step(s, { type: 'PASS', playerId: getActingPlayerId(s) })
    s = step(s, { type: 'PLAY_RECRUITMENT', playerId: 4, cardIds: more, targetFamilyId: 'F' })
    while (s.phase === 'REACTION') s = step(s, { type: 'PASS_REACTION', playerId: getActingPlayerId(s) })
    expect(s.players[4].reclaim ?? null).toBeNull()
    // 5 失去了唯一的 F → 得到夺回权
    expect(s.players[5].reclaim).toBe('F')
  })

  it('手牌超限时也可用 1 张招募牌夺回（无谈判）', () => {
    let s = sixSeats()
    s.players[2].reclaim = 'C'
    s.investors.find(i => i.familyId === 'C')!.ownerId = 0
    giveCards(s, 2, Array.from({ length: 13 }, () => ({ type: 'RECRUITMENT' as const })))
    s.phase = 'HAND_LIMIT'
    s.currentId = 2
    const opts = getLegalActions(s, 2).filter(a => a.type === 'PLAY_RECRUITMENT')
    // 手里 13 张：任何家族都招得起（3 张），夺回 C 只要 1 张
    expect(opts.map(a => a.type === 'PLAY_RECRUITMENT' && [a.targetFamilyId, a.cardIds.length])).toEqual([
      ['A', 3], ['B', 3], ['C', 1], ['D', 3], ['E', 3], ['F', 3],
    ])
    s = step(s, opts.find(a => a.type === 'PLAY_RECRUITMENT' && a.targetFamilyId === 'C')!)
    expect(s.phase).toBe('REACTION')
    while (s.phase === 'REACTION') s = step(s, { type: 'PASS_REACTION', playerId: getActingPlayerId(s) })
    expect(s.investors.find(i => i.familyId === 'C')!.ownerId).toBe(2)
    expect(s.players[2].reclaim ?? null).toBeNull()
    expect(s.players[0].reclaim ?? null).toBeNull() // 0 还有 A，不触发夺回权
    expect(s.players[2].hand).toHaveLength(12) // 13 − 1 = 12，刚好达标 → 回合结束
    expect(s.phase).toBe('TURN')
  })
})

describe('特殊格', () => {
  function expansion(seed = 31) {
    const s = baseState(4, seed, 'expansion')
    for (let i = 0; i < 4; i++) clearHand(s, i)
    return s
  }

  it('抢手格：股价 +$1M/份，总额随之变化', () => {
    let s = expansion()
    const space = spaceOfKind(s, 'PREMIUM')
    ownSpaceFamilies(s, space, 0)
    s = openDealAt(s, space.id, 0)
    const tile = s.dealTiles[s.dealTileIndex]
    expect(effectiveShareValue(s, space)).toBe(tile.shareValue + PREMIUM_BONUS)
    expect(getGrossValue(s)).toBe(space.dividends * (tile.shareValue + PREMIUM_BONUS))
    s = toBoss(s)
    s = step(s, { type: 'CLOSE_DEAL', playerId: 0 })
    while (s.phase === 'CLOSING') s = step(s, { type: 'PASS_CLOSING', playerId: getActingPlayerId(s) })
    expect(s.players[0].cash).toBe(space.dividends * (tile.shareValue + PREMIUM_BONUS))
  })

  it('猎头格：招募只需 2 张（夺回权仍 1 张）；3 张的动作不合法', () => {
    let s = expansion()
    const space = spaceOfKind(s, 'HEADHUNT')
    setInvestors(s, { A: 0, B: 1, C: 2, D: 3, E: 3, F: 3 })
    const ids = giveCards(s, 1, [{ type: 'RECRUITMENT' }, { type: 'RECRUITMENT' }, { type: 'RECRUITMENT' }]).map(c => c.id)
    s = openDealAt(s, space.id, 0)
    expect(recruitCost(s, 1, 'C')).toBe(HEADHUNT_RECRUIT_COST)
    s.players[1].reclaim = 'D'
    expect(recruitCost(s, 1, 'D')).toBe(RECLAIM_RECRUIT_COST)
    expect(getActingPlayerId(s)).toBe(1)
    rejects(s, { type: 'PLAY_RECRUITMENT', playerId: 1, cardIds: ids, targetFamilyId: 'C' })
    s = step(s, { type: 'PLAY_RECRUITMENT', playerId: 1, cardIds: ids.slice(0, 2), targetFamilyId: 'C' })
    expect(eventsOf(s, 'RECRUITMENT_PLAYED').at(-1)).toMatchObject({ cost: 2 })
    while (s.phase === 'REACTION') s = step(s, { type: 'PASS_REACTION', playerId: getActingPlayerId(s) })
    expect(s.investors.find(i => i.familyId === 'C')!.ownerId).toBe(1)
    expect(s.players[1].hand).toHaveLength(1)
  })

  it('黑市格：出牌没有反应窗口，立即生效；阻止牌持有者没有机会', () => {
    let s = expansion()
    const space = spaceOfKind(s, 'BLACK_MARKET')
    const fam = space.groups[0].families[0]
    setInvestors(s, Object.fromEntries(space.groups.flatMap(g => g.families).map((f, i) => [f, i % 4])) as never)
    s.investors.find(i => i.familyId === fam)!.ownerId = 1
    const [travel] = giveCards(s, 2, [{ type: 'TRAVEL' }])
    giveCards(s, 3, [{ type: 'STOP' }])
    s = openDealAt(s, space.id, 0)
    expect(isBlackMarketDeal(s)).toBe(true)
    s = step(s, { type: 'PASS', playerId: 1 })
    s = step(s, { type: 'PLAY_TRAVEL', playerId: 2, cardId: travel.id, targetRepKey: investorRepKey(fam) })
    expect(s.phase).toBe('NEGOTIATION')
    expect(s.pendingReaction).toBeNull()
    expect(eventsOf(s, 'BLACK_MARKET').at(-1)).toMatchObject({ actorId: 2, card: 'TRAVEL' })
    expect(s.negotiation!.travelledInvestors).toEqual([fam])
    expect(s.players[3].hand.filter(c => c.type === 'STOP')).toHaveLength(1) // 阻止牌没用上
    expect(getActingPlayerId(s)).toBe(3)
  })

  it('地标格：成交者成为主人，此后每笔成交由银行付租金；现金 = 成交总额 + 租金', () => {
    let s = expansion()
    const landmark = spaceOfKind(s, 'LANDMARK')
    ownSpaceFamilies(s, landmark, 0)
    expect(landmarkRentEstimate(s, landmark)).toBeGreaterThan(0)
    s = closeSolo(s, landmark.id, 0)
    expect(s.board.find(b => b.id === landmark.id)!.landlordId).toBe(0)
    expect(landlords(s)).toEqual([{ spaceId: landmark.id, ownerId: 0 }])
    expect(eventsOf(s, 'LANDMARK_CLAIMED').at(-1)).toMatchObject({ playerId: 0, spaceId: landmark.id })
    expect(eventsOf(s, 'RENT_PAID')).toHaveLength(0) // 本格自己的租金从下一笔起算
    const gross1 = s.dealHistory[0].grossValue
    expect(s.players[0].cash).toBe(gross1)

    // 第二笔：玩家 1 在一个标准格独立成交 → 0 收 $1M 租金
    const other = s.board.find(b => b.kind === 'STANDARD' && b.closedByTileId == null)!
    ownSpaceFamilies(s, other, 1)
    s = closeSolo(s, other.id, 1)
    const gross2 = s.dealHistory[1].grossValue
    expect(s.players[1].cash).toBe(gross2)
    expect(s.players[0].cash).toBe(gross1 + LANDMARK_RENT)
    expect(s.dealHistory[1].rents).toEqual([{ playerId: 0, amount: LANDMARK_RENT }])
    expect(eventsOf(s, 'RENT_PAID').at(-1)).toMatchObject({ payments: [{ playerId: 0, amount: LANDMARK_RENT }] })
    expect(totalCash(s)).toBe(gross1 + gross2 + LANDMARK_RENT)
    // 流局不付租金
    const third = s.board.find(b => b.kind === 'STANDARD' && b.closedByTileId == null && b.id !== other.id)!
    ownSpaceFamilies(s, third, 2)
    s = toBoss(openDealAt(s, third.id, 2))
    s = step(s, { type: 'ABANDON_DEAL', playerId: 2 })
    expect(s.players[0].cash).toBe(gross1 + LANDMARK_RENT)
    expect(s.dealHistory[2].rents).toEqual([])
  })
})

describe('稀有牌', () => {
  function table(seed = 41) {
    const s = baseState(4, seed, 'full')
    for (let i = 0; i < 4; i++) clearHand(s, i)
    setInvestors(s, { A: 0, B: 1, C: 2, D: 3 })
    return s
  }

  it('利好：只有 Boss 能打，反应窗口后股价 +$2M/份；已有方案分成不变，多出的归 Boss', () => {
    let s = table()
    const [boom] = giveCards(s, 0, [{ type: 'BOOM' }])
    const [boom2] = giveCards(s, 1, [{ type: 'BOOM' }])
    s = toBoss(openDealAt(s, 1, 0)) // #1 A+B，3 份 × $2M = 6
    expect(getGrossValue(s)).toBe(6)
    s = step(s, { type: 'PROPOSE_OFFER', playerId: 0, repKeys: [investorRepKey('A'), investorRepKey('B')], payouts: [{ playerId: 1, amount: 2 }] })
    s = step(s, { type: 'ACCEPT_OFFER', playerId: 1 })
    expect(getLegalActions(s, 0).map(a => a.type)).toContain('PLAY_BOOM')
    s = step(s, { type: 'PLAY_BOOM', playerId: 0, cardId: boom.id })
    expect(s.phase).toBe('REACTION')
    while (s.phase === 'REACTION') s = step(s, { type: 'PASS_REACTION', playerId: getActingPlayerId(s) })
    expect(s.negotiation!.priceDelta).toBe(BOOM_BONUS)
    expect(getGrossValue(s)).toBe(3 * (2 + BOOM_BONUS))
    expect(s.negotiation!.offer).not.toBeNull() // 方案没作废
    expect(eventsOf(s, 'PRICE_CHANGED').at(-1)).toMatchObject({ delta: BOOM_BONUS, gross: 12 })
    expect(getActingPlayerId(s)).toBe(0) // 回合仍在 Boss
    s = step(s, { type: 'CLOSE_DEAL', playerId: 0 })
    while (s.phase === 'CLOSING') s = step(s, { type: 'PASS_CLOSING', playerId: getActingPlayerId(s) })
    expect(s.players[1].cash).toBe(2)
    expect(s.players[0].cash).toBe(12 - 2)
    expect(totalCash(s)).toBe(12)
    expect(s.dealHistory[0].grossValue).toBe(12)
    // 非 Boss 不能打利好：第二笔由 1 当 Boss，1 手里的利好合法，而 0 的不合法
    const [boom3] = giveCards(s, 0, [{ type: 'BOOM' }])
    s = openDealAt(s, 2, 1) // #2 C/D/E 中选 2
    expect(getActingPlayerId(s)).toBe(2)
    while (getActingPlayerId(s) !== 0) s = step(s, { type: 'PASS', playerId: getActingPlayerId(s) })
    rejects(s, { type: 'PLAY_BOOM', playerId: 0, cardId: boom3.id })
    expect(getLegalActions(s, 0).map(a => a.type)).not.toContain('PLAY_BOOM')
    s = toBoss(s)
    expect(getLegalActions(s, 1)).toContainEqual({ type: 'PLAY_BOOM', playerId: 1, cardId: boom2.id })
  })

  it('利空：只有非 Boss 能打，股价 −$1M/份，下限 $1M；可被阻止', () => {
    let s = table()
    const [bust] = giveCards(s, 0, [{ type: 'BUST' }]) // 先放在 Boss 手里：Boss 不能打
    const [stop] = giveCards(s, 3, [{ type: 'STOP' }])
    s = openDealAt(s, 1, 0)
    rejects(s, { type: 'PLAY_BUST', playerId: 0, cardId: bust.id })
    s = toBoss(s)
    rejects(s, { type: 'PLAY_BUST', playerId: 0, cardId: bust.id })
    expect(getLegalActions(s, 0).map(a => a.type)).not.toContain('PLAY_BUST')
    // 牌堆只有 2 张利空：把这张挪给 2
    s.players[2].hand.push(s.players[0].hand.pop()!)
    s = step(s, { type: 'PASS', playerId: 0 })
    s = step(s, { type: 'PASS', playerId: 1 })
    expect(getLegalActions(s, 2)).toContainEqual({ type: 'PLAY_BUST', playerId: 2, cardId: bust.id })
    s = step(s, { type: 'PLAY_BUST', playerId: 2, cardId: bust.id })
    expect(s.phase).toBe('REACTION')
    expect(getLegalActions(s, 3).map(a => a.type)).toEqual(['PLAY_STOP', 'PASS_REACTION'])
    s = step(s, { type: 'PLAY_STOP', playerId: 3 })
    expect(s.negotiation!.priceDelta).toBe(0)
    expect(s.discardPile.map(c => c.id)).toEqual(expect.arrayContaining([bust.id, stop.id]))
    // 再来一张不被阻止的
    const [bust2] = giveCards(s, 2, [{ type: 'BUST' }])
    while (getActingPlayerId(s) !== 2) s = step(s, { type: 'PASS', playerId: getActingPlayerId(s) })
    s = step(s, { type: 'PLAY_BUST', playerId: 2, cardId: bust2.id })
    while (s.phase === 'REACTION') s = step(s, { type: 'PASS_REACTION', playerId: getActingPlayerId(s) })
    expect(s.negotiation!.priceDelta).toBe(-BUST_PENALTY)
    expect(getGrossValue(s)).toBe(3 * (2 - BUST_PENALTY))
    expect(s.negotiation!.disruptors).toContain(2)
    // 下限
    s.negotiation!.priceDelta = -10
    expect(effectiveShareValue(s)).toBe(MIN_SHARE_VALUE)
  })

  it('独家协议：只有 Boss 能打；生效后老板 / 旅行 / 利空牌全部封锁，招募仍可', () => {
    let s = table()
    const [excl] = giveCards(s, 0, [{ type: 'EXCLUSIVE' }])
    const [bossCard] = giveCards(s, 2, [{ type: 'BOSS' }])
    const [travel] = giveCards(s, 2, [{ type: 'TRAVEL' }])
    const [bust] = giveCards(s, 2, [{ type: 'BUST' }])
    const [exclOther] = giveCards(s, 2, [{ type: 'EXCLUSIVE' }])
    const recruits = giveCards(s, 2, [{ type: 'RECRUITMENT' }, { type: 'RECRUITMENT' }, { type: 'RECRUITMENT' }]).map(c => c.id)
    s = openDealAt(s, 1, 0)
    s = step(s, { type: 'PASS', playerId: 1 })
    rejects(s, { type: 'PLAY_EXCLUSIVE', playerId: 2, cardId: exclOther.id })
    s = step(s, { type: 'PASS', playerId: 2 })
    s = step(s, { type: 'PASS', playerId: 3 })
    expect(getLegalActions(s, 0).map(a => a.type)).toContain('PLAY_EXCLUSIVE')
    s = step(s, { type: 'PLAY_EXCLUSIVE', playerId: 0, cardId: excl.id })
    while (s.phase === 'REACTION') s = step(s, { type: 'PASS_REACTION', playerId: getActingPlayerId(s) })
    expect(isExclusiveLocked(s)).toBe(true)
    expect(eventsOf(s, 'EXCLUSIVE_RESOLVED')).toHaveLength(1)
    expect(getActingPlayerId(s)).toBe(0)
    // 不能再打第二张（牌堆只有 2 张：把 2 手里那张挪给 Boss 试）
    s.players[0].hand.push(s.players[2].hand.splice(s.players[2].hand.findIndex(c => c.id === exclOther.id), 1)[0])
    rejects(s, { type: 'PLAY_EXCLUSIVE', playerId: 0, cardId: exclOther.id })
    expect(getLegalActions(s, 0).map(a => a.type)).not.toContain('PLAY_EXCLUSIVE')
    s = step(s, { type: 'PASS', playerId: 0 })
    s = step(s, { type: 'PASS', playerId: 1 })
    expect(getActingPlayerId(s)).toBe(2)
    const types = getLegalActions(s, 2).map(a => a.type)
    expect(types).not.toContain('PLAY_BOSS')
    expect(types).not.toContain('PLAY_TRAVEL')
    expect(types).not.toContain('PLAY_BUST')
    expect(types).toContain('PLAY_RECRUITMENT')
    rejects(s, { type: 'PLAY_BOSS', playerId: 2, cardId: bossCard.id })
    rejects(s, { type: 'PLAY_TRAVEL', playerId: 2, cardId: travel.id, targetRepKey: investorRepKey('B') })
    rejects(s, { type: 'PLAY_BUST', playerId: 2, cardId: bust.id })
    s = step(s, { type: 'PLAY_RECRUITMENT', playerId: 2, cardIds: recruits, targetFamilyId: 'E' })
    expect(s.phase).toBe('REACTION')
  })

  it('经典变体的牌堆没有稀有牌，动作也不会被列出', () => {
    const s = baseState(4, 1)
    expect(s.drawPile.some(c => ['BOOM', 'BUST', 'EXCLUSIVE'].includes(c.type))).toBe(false)
  })
})

describe('各变体整局仿真', () => {
  it.each(VARIANT_IDS)('%s：启发式 4 人局跑到终局，不变量成立，成交数不超过景气牌数', variantId => {
    const r = runGame({ playerCount: 4, seed: 77, mode: 'heuristic', variantId, maxSteps: 60000 })
    expect(r.ok, r.reason).toBe(true)
    expect(r.final.phase).toBe('GAME_OVER')
    expect(r.deals).toBeLessThanOrEqual(r.final.dealTiles.length)
    expect(r.deals).toBeGreaterThanOrEqual(r.final.dealTiles.length - 5) // 最早在倒数第 6 张开始掷终局骰
  })

  it('完整 16 笔：把 16 格全部关闭时直接结束', () => {
    let found = false
    for (let seed = 0; seed < 60 && !found; seed++) {
      const r = runGame({ playerCount: 3, seed, mode: 'random', variantId: 'full', maxSteps: 60000 })
      expect(r.ok, r.reason).toBe(true)
      if (r.deals === 16) {
        found = true
        expect(r.final.board.every(b => b.closedByTileId != null)).toBe(true)
        expect(r.final.phase).toBe('GAME_OVER')
      }
    }
    expect(found).toBe(true)
  })
})
