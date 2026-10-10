// 精彩时刻：真实对局里引用的交易 / 动作序号必须存在；手摆的事件流验证各条识别规则
import { describe, it, expect } from 'vitest'
import { computeHighlights, highlightPosition, MAX_HIGHLIGHTS, HIGHLIGHT_META, type HighlightKind } from '../../src/ui/highlights'
import { computeStats } from '../../src/ui/stats'
import { buildReview } from '../../src/ui/review'
import type { DealRecord, GameEvent, GameState, LoggedEvent } from '../../src/engine/types'
import { gameOverState } from './fixtures'
import { playedGame, SAMPLE_GAMES } from './played'

const CAP: Record<HighlightKind, number> = { COMEBACK: 2, INTERCEPT: 2, DECIDER: 1, SOLO: 1, BIGGEST: 1, REVENGE: 2, LOWBALL: 2, STOPSAVE: 2 }

describe('computeHighlights × 真实对局', () => {
  const seen = new Set<HighlightKind>()

  for (const [pc, seed, variant, house] of SAMPLE_GAMES) {
    it(`${pc} 人 ${variant} 种子 ${seed}${house ? ' 桌规' : ''}：数量 / 排序 / 上限 / 引用的步骤都存在`, () => {
      const { state, recording, log } = playedGame(pc, seed, variant, house)
      const { stats, highlights } = buildReview(state, recording)

      expect(highlights.length).toBeGreaterThan(0)
      expect(highlights.length).toBeLessThanOrEqual(MAX_HIGHLIGHTS)
      // 按精彩度降序
      for (let i = 1; i < highlights.length; i++) expect(highlights[i - 1].score).toBeGreaterThanOrEqual(highlights[i].score)
      // 同类 / 同一笔交易有上限；id 唯一
      const perKind = new Map<string, number>(), perDeal = new Map<number, number>()
      for (const h of highlights) {
        perKind.set(h.kind, (perKind.get(h.kind) ?? 0) + 1)
        perDeal.set(h.dealNo, (perDeal.get(h.dealNo) ?? 0) + 1)
        seen.add(h.kind)
      }
      for (const [k, n] of perKind) expect(n).toBeLessThanOrEqual(CAP[k as HighlightKind])
      for (const n of perDeal.values()) expect(n).toBeLessThanOrEqual(2)
      expect(new Set(highlights.map(h => h.id)).size).toBe(highlights.length)

      for (const h of highlights) {
        expect(HIGHLIGHT_META[h.kind]).toBeDefined()
        expect(h.title).not.toBe('')
        expect(h.text.length).toBeGreaterThan(5)
        expect(h.dealNo).toBeGreaterThanOrEqual(1)
        expect(h.dealNo).toBeLessThanOrEqual(state.dealHistory.length)
        expect(h.playerIds.length).toBeGreaterThan(0)
        for (const id of h.playerIds) expect(state.players[id]).toBeDefined()
        // 有录像：动作序号落在日志里，且那一步确实属于这笔交易，对应位置的状态能取到
        expect(h.actionIndex).not.toBeNull()
        expect(h.actionIndex!).toBeGreaterThanOrEqual(0)
        expect(h.actionIndex!).toBeLessThan(log.length)
        expect(recording.steps[h.actionIndex!].dealNo).toBe(h.dealNo)
        const pos = highlightPosition(h)!
        expect(recording.stateAt(pos).stateVersion).toBe(1 + pos)
      }
      expect(stats.deals.total).toBe(state.dealHistory.length)
    })
  }

  it('没有录像：只用交易历史 / 残余事件，仍有精彩时刻，且不给动作序号', () => {
    const { state } = playedGame(5, 3, 'marathon')
    const stats = computeStats(state, null)
    const hs = computeHighlights(state, stats, null)
    expect(hs.length).toBeGreaterThan(0)
    for (const h of hs) {
      expect(h.actionIndex).toBeNull()
      expect(highlightPosition(h)).toBeNull()
      expect(h.dealNo).toBeGreaterThanOrEqual(1)
      expect(h.dealNo).toBeLessThanOrEqual(state.dealHistory.length)
    }
    // 需要完整录像才能还原的"被排除后报复"不会凭空出现
    expect(hs.some(h => h.kind === 'REVENGE')).toBe(false)
  })

  it('跨多局：夺权翻盘 / 截胡 / 一锤定音 / 最大单笔 / 阻止牌救场 / 报复 都能被识别出来', () => {
    expect(seen.has('COMEBACK')).toBe(true)
    expect(seen.has('INTERCEPT')).toBe(true)
    expect(seen.has('DECIDER')).toBe(true)
    expect(seen.has('BIGGEST')).toBe(true)
    expect(seen.has('STOPSAVE')).toBe(true)
    expect(seen.has('REVENGE')).toBe(true)
  })
})

describe('computeHighlights × 手摆的局面', () => {
  const rec = (over: Partial<DealRecord>): DealRecord => ({
    id: 1, dealNumber: 1, spaceId: 1, bossId: 0, openerId: 0, success: true, grossValue: 10,
    payouts: [], rents: [], disruptors: [], ...over,
  })
  const ev = (id: number, e: GameEvent, dealNo?: number): LoggedEvent => ({ id, ...e, ...(dealNo != null ? { dealNo } : {}) })
  const kinds = (s: GameState) => computeHighlights(s, computeStats(s, null), null).map(h => h.kind)
  const clean = (s: GameState) => { s.events = []; return s }

  it('夺权翻盘：成交的 Boss 不是发起者（只靠交易历史就能识别）', () => {
    const s = clean(gameOverState([0, 9, 0]))
    s.dealHistory = [rec({ bossId: 1, openerId: 0, grossValue: 9 })]
    const h = computeHighlights(s, computeStats(s, null), null).find(x => x.kind === 'COMEBACK')!
    expect(h.dealNo).toBe(1)
    expect(h.playerIds).toEqual([1, 0])
    expect(h.text).toContain(s.players[1].name)
  })

  it('一锤定音：胜者在最后一笔交易才登上榜首', () => {
    const s = clean(gameOverState([8, 11, 0]))
    s.dealHistory = [
      rec({ bossId: 0, grossValue: 8 }),
      rec({ id: 2, dealNumber: 2, bossId: 1, grossValue: 3 }),
      rec({ id: 3, dealNumber: 3, bossId: 1, grossValue: 8 }),
    ]
    // 逐笔现金：[8,0,0] → [8,3,0] → [8,11,0]：1 号在第 3 笔登顶
    const h = computeHighlights(s, computeStats(s, null), null).find(x => x.kind === 'DECIDER')!
    expect(h.dealNo).toBe(3)
    expect(h.title).toContain('最后一笔')
    expect(h.playerIds).toEqual([1])
  })

  it('一锤定音：一路领先则取拉开差距最多的一笔', () => {
    const s = clean(gameOverState([3, 14, 0]))
    s.dealHistory = [
      rec({ bossId: 1, openerId: 1, grossValue: 4 }),
      rec({ id: 2, dealNumber: 2, bossId: 0, grossValue: 3 }),
      rec({ id: 3, dealNumber: 3, bossId: 1, openerId: 1, grossValue: 10 }),
    ]
    const h = computeHighlights(s, computeStats(s, null), null).find(x => x.kind === 'DECIDER')!
    expect(h.dealNo).toBe(3)
    expect(h.title).toContain('拉开差距')
  })

  it('独吞 / 最大单笔：同一笔不重复；不同笔各出一条', () => {
    const a = clean(gameOverState([12, 3, 0]))
    a.dealHistory = [rec({ bossId: 0, grossValue: 12 }), rec({ id: 2, dealNumber: 2, bossId: 1, grossValue: 3 })]
    expect(kinds(a).filter(k => k === 'SOLO' || k === 'BIGGEST')).toEqual(['BIGGEST']) // 同一笔：并入最大单笔
    const text = computeHighlights(a, computeStats(a, null), null).find(x => x.kind === 'BIGGEST')!.text
    expect(text).toContain('一分没分给别人')

    const b = clean(gameOverState([9, 3, 2]))
    b.dealHistory = [
      rec({ bossId: 0, grossValue: 9 }),
      rec({ id: 2, dealNumber: 2, bossId: 1, grossValue: 7, payouts: [{ playerId: 2, amount: 4 }] }),
    ]
    // 最大单笔是 0 号的 9（独吞）；这里独吞与最大单笔是同一笔，所以只有最大单笔
    expect(kinds(b)).toContain('BIGGEST')
    b.dealHistory[1] = rec({ id: 2, dealNumber: 2, bossId: 1, grossValue: 5 })
    b.dealHistory[0] = rec({ bossId: 0, grossValue: 6, payouts: [{ playerId: 2, amount: 1 }] })
    expect(kinds(b)).toEqual(expect.arrayContaining(['SOLO', 'BIGGEST']))
  })

  const openDeal = (id: number, boss: number, dealNo: number) => ev(id, { kind: 'DEAL_OPENED', playerId: boss, spaceId: 1, gross: 10 }, dealNo)

  it('截胡：旅行牌让 Boss 的方案作废；倒计时里的截胡分更高', () => {
    const mk = (closing: boolean) => {
      const s = gameOverState([12, 0, 0])
      // 第 1 笔是大额独吞（占满最大单笔 / 一锤定音的名额），截胡发生在第 2 笔，免得被"同一笔最多 2 条"挤掉
      s.dealHistory = [rec({ bossId: 0, grossValue: 10 }), rec({ id: 2, dealNumber: 2, bossId: 0, grossValue: 2, disruptors: [1] })]
      s.events = [
        ev(1, { kind: 'GAME_STARTED', playerCount: 3, startPlayerId: 0, markerChooserId: 2, variantId: 'classic', deals: 15 }),
        openDeal(2, 0, 2),
        ev(3, { kind: 'OFFER_PROPOSED', bossId: 0, offerNo: 1, reps: [], payouts: [], bossKeep: 7, waitingFor: [], autoAccepted: [] }, 2),
        ...(closing ? [ev(4, { kind: 'CLOSING_STARTED', bossId: 0 }, 2)] : []),
        ev(5, { kind: 'TRAVEL_PLAYED', playerId: 1, wildcard: false, target: { familyId: 'A', ownerId: 0, source: 'INVESTOR' } }, 2),
        ev(6, { kind: 'TRAVEL_RESOLVED', target: { familyId: 'A', ownerId: 0, source: 'INVESTOR' } }, 2),
        ev(7, { kind: 'OFFER_VOIDED', reason: 'TRAVELLED' }, 2),
        ...(closing ? [ev(8, { kind: 'CLOSING_INTERRUPTED', by: 'TRAVEL', actorId: 1 }, 2)] : []),
        ev(9, { kind: 'DEAL_CLOSED', dealNumber: 2, spaceId: 1, tileId: 1, bossId: 0, gross: 2, payouts: [], bossKeep: 2, reps: [] }, 2),
      ]
      return computeHighlights(s, computeStats(s, null), null).find(x => x.kind === 'INTERCEPT')
    }
    const plain = mk(false)!, last = mk(true)!
    expect(plain.playerIds).toEqual([1, 0])
    expect(plain.text).toContain('方案作废')
    expect(last.title).toContain('最后一刻')
    expect(last.score).toBeGreaterThan(plain.score)
  })

  it('阻止牌救场：倒计时里取消老板牌；谈判里取消招募牌', () => {
    const s = gameOverState([10, 0, 0])
    s.dealHistory = [rec({ bossId: 0, grossValue: 10 })]
    s.events = [
      openDeal(2, 0, 1),
      ev(3, { kind: 'CLOSING_STARTED', bossId: 0 }, 1),
      ev(4, { kind: 'BOSS_PLAYED', playerId: 1, bossId: 0 }, 1),
      ev(5, { kind: 'STOP_PLAYED', playerId: 2, actorId: 1, cancelled: 'BOSS' }, 1),
      ev(6, { kind: 'DEAL_CLOSED', dealNumber: 1, spaceId: 1, tileId: 1, bossId: 0, gross: 10, payouts: [], bossKeep: 10, reps: [] }, 1),
    ]
    const h = computeHighlights(s, computeStats(s, null), null).find(x => x.kind === 'STOPSAVE')!
    expect(h.title).toContain('倒计时')
    expect(h.playerIds).toEqual([2, 1])

    // 阻止的不是干扰牌（利好）不算
    s.events[3] = ev(5, { kind: 'STOP_PLAYED', playerId: 2, actorId: 1, cancelled: 'BOOM' }, 1)
    expect(computeHighlights(s, computeStats(s, null), null).some(x => x.kind === 'STOPSAVE')).toBe(false)
  })

  it('压价成交：开价 $5M，最终只给 $2M', () => {
    const s = gameOverState([6, 2, 0])
    s.dealHistory = [rec({ bossId: 0, grossValue: 8, payouts: [{ playerId: 1, amount: 2 }] })]
    s.events = [
      openDeal(2, 0, 1),
      ev(3, { kind: 'DEMAND', playerId: 1, quotes: [{ familyIds: ['B'], amount: 5 }] }, 1),
      ev(4, { kind: 'DEAL_CLOSED', dealNumber: 1, spaceId: 1, tileId: 1, bossId: 0, gross: 8, payouts: [{ playerId: 1, amount: 2 }], bossKeep: 6, reps: [{ familyId: 'B', ownerId: 1, source: 'INVESTOR' }] }, 1),
    ]
    const h = computeHighlights(s, computeStats(s, null), null).find(x => x.kind === 'LOWBALL')!
    expect(h).toBeDefined()
    expect(h.text).toContain('$5M')
    expect(h.text).toContain('$2M')
    // 只压了 $1M 不算
    s.events[2] = ev(3, { kind: 'DEMAND', playerId: 1, quotes: [{ familyIds: ['B'], amount: 3 }] }, 1)
    expect(computeHighlights(s, computeStats(s, null), null).some(x => x.kind === 'LOWBALL')).toBe(false)
  })

  it('空交易历史：没有精彩时刻', () => {
    const s = gameOverState([0, 0, 0])
    expect(computeHighlights(s, computeStats(s, null), null)).toEqual([])
  })
})
