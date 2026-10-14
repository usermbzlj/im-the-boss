// 终局统计：用真实对局（仿真 harness）验证与引擎对账；用手摆的交易历史验证各项口径
import { describe, it, expect } from 'vitest'
import { computeStats, computeExclusions, perDealGains } from '../../src/ui/stats'
import { rankStandings } from '../../src/ui/standings'
import { tryBuildRecording, logFitsState } from '../../src/ui/recording'
import type { DealRecord, GameState } from '../../src/engine/types'
import { investorRepKey } from '../../src/engine/rules'
import { checkInvariants } from '../../src/sim/harness'
import { baseState, clearHand, giveCards, openDealAt, setInvestors, step, toBoss } from '../helpers'
import { gameOverState } from './fixtures'
import { playedGame, SAMPLE_GAMES } from './played'

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

describe('computeStats × 真实对局（对账）', () => {
  for (const [pc, seed, variant, house] of SAMPLE_GAMES) {
    const label = `${pc} 人 ${variant} 种子 ${seed}${house ? ' 桌规' : ''}`

    it(`${label}：有录像时逐位对账，现金走势每个点都等于重放出的当时现金`, () => {
      const { state, recording } = playedGame(pc, seed, variant, house)
      const stats = computeStats(state, recording)

      expect(stats.eventsComplete).toBe(true)
      expect(stats.reconciliation.ok).toBe(true)
      expect(stats.reconciliation.bank).toBe(state.bank)
      for (const p of stats.players) {
        expect(p.cash).toBe(state.players[p.playerId].cash)
        expect(p.income.total - p.spend.total).toBe(p.cash)
        expect(p.reconciles).toBe(true)
        expect(p.spend.source).toBe('events')
      }
      // 现金守恒：Σ现金 + 银行 = Σ成交总额 + Σ租金
      const gross = sum(state.dealHistory.filter(d => d.success).map(d => d.grossValue))
      const rents = sum(state.dealHistory.flatMap(d => d.rents.map(r => r.amount)))
      expect(sum(stats.players.map(p => p.cash)) + state.bank).toBe(gross + rents)
      expect(sum(stats.players.map(p => p.income.total))).toBe(gross + rents)
      expect(sum(stats.players.map(p => p.spend.total))).toBe(state.bank)

      // 走势：开局全 0 + 每笔交易一个点；终点 = 最终现金；每个点 = 重放到该笔结算时的真实现金
      const pts = stats.cashSeries.points
      expect(stats.cashSeries.exact).toBe(true)
      expect(pts).toHaveLength(state.dealHistory.length + 1)
      expect(pts[0].cash.every(c => c === 0)).toBe(true)
      expect(pts[pts.length - 1].cash).toEqual(state.players.map(p => p.cash))
      for (let k = 1; k < pts.length; k++) {
        expect(pts[k].cash).toEqual(recording.cashAt(recording.positionClosed(k)!))
      }
    })

    it(`${label}：没有录像时口径仍然自洽（支出由差额推算），收入与有录像时一致`, () => {
      const { state, recording } = playedGame(pc, seed, variant, house)
      const withRec = computeStats(state, recording)
      const without = computeStats(state, null)
      expect(without.reconciliation.ok).toBe(true)
      for (const p of without.players) {
        expect(p.income).toEqual(withRec.players[p.playerId].income)
        expect(p.spend.total).toBe(withRec.players[p.playerId].spend.total)
        expect(p.excluded).toBeNull()
        if (!without.eventsComplete) {
          expect(p.spend.source).toBe('derived')
          expect(p.cardsPlayed).toBeNull()
          expect(p.spend.buy).toBeNull()
        }
      }
      if (!without.eventsComplete) expect(without.cashSeries.exact).toBe(false)
      // 交易计数不依赖录像
      expect(without.deals).toEqual(withRec.deals)
      expect(without.deals.total).toBe(state.dealHistory.length)
      expect(without.deals.closed + without.deals.failed).toBe(without.deals.total)
    })
  }

  it('Boss 次数 / 成交 / 流局 / 夺权 / 出牌 / 排除 的汇总自洽', () => {
    const { state, recording } = playedGame(5, 3, 'marathon')
    const stats = computeStats(state, recording)
    expect(sum(stats.players.map(p => p.bossDeals))).toBe(state.dealHistory.length)
    expect(sum(stats.players.map(p => p.bossClosed))).toBe(stats.deals.closed)
    expect(sum(stats.players.map(p => p.bossFailed))).toBe(stats.deals.failed)
    expect(sum(stats.players.map(p => p.takeovers))).toBe(state.dealHistory.filter(d => d.bossId !== d.openerId).length)
    for (const p of stats.players) {
      expect(p.bossClosed + p.bossFailed).toBe(p.bossDeals)
      expect(p.cardsPlayed).toBe(sum(Object.values(p.cardsByType!).map(v => v ?? 0)))
      expect(p.excluded).not.toBeNull()
      expect(p.excluded!).toBeLessThanOrEqual(stats.deals.closed)
      expect(p.soloDeals).toBeLessThanOrEqual(p.bossClosed)
    }
    // 出牌统计与事件逐条一致
    const played = recording.events.filter(e => /_PLAYED$/.test(e.kind)).length
    expect(sum(stats.players.map(p => p.cardsPlayed!))).toBe(played)
    // 最大单笔 = 各人最大单笔的最大值
    const best = Math.max(...stats.players.map(p => p.bestDeal?.amount ?? 0))
    expect(stats.biggest?.amount).toBe(best)
  })

  it('被排除：只算本格需求涉及的家族，Boss 自己 / 被选用 / 拿到分成的不算', () => {
    const { state, recording } = playedGame(5, 3, 'marathon')
    const ex = computeExclusions(state, recording)
    expect(ex.size).toBe(state.dealHistory.filter(d => d.success).length)
    for (const e of ex.values()) {
      const rec = state.dealHistory[e.dealNo - 1]
      expect(e.out.has(rec.bossId)).toBe(false)
      for (const p of rec.payouts) if (p.amount > 0) expect(e.out.has(p.playerId)).toBe(false)
      expect(recording.steps[e.step].dealNo).toBe(e.dealNo)
    }
  })

  it('真实买牌 / 兑换动作产生支出，且逐笔核算到付款人', () => {
    let state = baseState(4, 8, 'full', true)
    setInvestors(state, { A: 0, B: 1, C: 2, D: 3 })
    for (const p of state.players) clearHand(state, p.id)
    const cards = giveCards(state, 1, [{ type: 'STOP' }, { type: 'BOSS' }])
    // 先实际成交：$6M 中给 1 号 $4M，供下一回合支付买牌和兑换各 $2M。
    state = toBoss(openDealAt(state, 1, 0))
    state = step(state, { type: 'PROPOSE_OFFER', playerId: 0, repKeys: [investorRepKey('A'), investorRepKey('B')], payouts: [{ playerId: 1, amount: 4 }] })
    state = step(state, { type: 'ACCEPT_OFFER', playerId: 1 })
    state = step(state, { type: 'CLOSE_DEAL', playerId: 0 })
    for (const playerId of [1, 2, 3]) state = step(state, { type: 'PASS_CLOSING', playerId })
    expect(state.players[1].cash).toBe(4)
    expect(checkInvariants(state)).toBeNull()
    state = step(state, { type: 'BUY_CARDS', playerId: 1, count: 1 })
    expect(checkInvariants(state)).toBeNull()
    state = step(state, { type: 'TRADE_CARDS', playerId: 1, cardIds: cards.map(c => c.id) })
    expect(checkInvariants(state)).toBeNull()
    expect(state.events.filter(e => e.kind === 'CARDS_BOUGHT')).toHaveLength(1)
    expect(state.events.filter(e => e.kind === 'CARDS_TRADED')).toHaveLength(1)
    const stats = computeStats(state, null)
    expect(state.bank).toBe(4)
    expect(stats.players[1].spend).toEqual({ buy: 2, trade: 2, total: 4, source: 'events' })
    expect(stats.players.filter(p => p.playerId !== 1).every(p => p.spend.total === 0)).toBe(true)
    expect(sum(stats.players.map(p => (p.spend.buy ?? 0) + (p.spend.trade ?? 0)))).toBe(state.bank)
    expect(stats.reconciliation.ok).toBe(true)
    expect(stats.reconciliation.notes.join()).toContain('银行收入')
  })
})

describe('computeStats × 手摆的交易历史', () => {
  const rec = (over: Partial<DealRecord>): DealRecord => ({
    id: 1, dealNumber: 1, spaceId: 1, bossId: 0, openerId: 0, success: true, grossValue: 10,
    payouts: [], rents: [], disruptors: [], ...over,
  })

  /** 三人：① 0 号当 Boss，1 号分成 4、2 号收租 1；② 流局（0 号放弃，1 号搅过局）；③ 1 号夺权后独吞 8（0 号是发起者） */
  function sample(): GameState {
    const s = gameOverState([6, 12, 1])
    s.dealHistory = [
      rec({ grossValue: 10, payouts: [{ playerId: 1, amount: 4 }], rents: [{ playerId: 2, amount: 1 }], disruptors: [2] }),
      rec({ id: 2, dealNumber: 2, success: false, grossValue: 7, disruptors: [1], failReason: 'ABANDONED' }),
      rec({ id: 3, dealNumber: 2, bossId: 1, openerId: 0, grossValue: 8 }),
    ]
    return s
  }

  it('收入构成 / 次数 / 最大单笔 / 搅局口径', () => {
    const s = sample()
    const st = computeStats(s, null)
    const [a, b, c] = st.players
    expect(a.income).toEqual({ boss: 6, share: 0, rent: 0, total: 6 })
    expect(b.income).toEqual({ boss: 8, share: 4, rent: 0, total: 12 })
    expect(c.income).toEqual({ boss: 0, share: 0, rent: 1, total: 1 })
    expect(st.reconciliation.ok).toBe(true)
    expect(st.deals).toEqual({ total: 3, closed: 2, failed: 1 })
    // 0 号：当 Boss 两次（成交 1 · 流局 1）；1 号：夺权收场 1 次，独吞 1 次
    expect([a.bossDeals, a.bossClosed, a.bossFailed]).toEqual([2, 1, 1])
    expect([b.takeovers, b.soloDeals, b.shareDeals]).toEqual([1, 1, 1])
    // 搅局：2 号第 1 笔、1 号第 2 笔、1 号第 3 笔夺权；被搅局：0 号三笔都是 Boss / 发起者
    expect([a.disrupts, b.disrupts, c.disrupts]).toEqual([0, 2, 1])
    expect(a.disrupted).toBe(3)
    expect(b.bestDeal).toEqual({ dealNo: 3, amount: 8 })
    expect(c.bestDeal).toEqual({ dealNo: 1, amount: 1 })
    expect(st.biggest).toEqual({ dealNo: 3, amount: 8, playerId: 1 })
    expect(perDealGains(s)).toEqual([[6, 4, 1], [0, 0, 0], [0, 8, 0]])
  })

  it('走势：流局那笔现金持平；没有事件流时标为"累计收入"', () => {
    const s = sample()
    const withEvents = computeStats(s, null).cashSeries
    expect(withEvents.exact).toBe(true) // 状态里的事件流还从 GAME_STARTED 开始
    expect(withEvents.points.map(p => p.cash)).toEqual([[0, 0, 0], [6, 4, 1], [6, 4, 1], [6, 12, 1]])
    s.events = s.events.slice(1)
    const truncated = computeStats(s, null).cashSeries
    expect(truncated.exact).toBe(false)
    expect(truncated.points[3].cash).toEqual([6, 12, 1])
  })

  it('对不上时明确标注：现金多于收入 / 支出与银行不符', () => {
    const s = sample()
    s.players[0].cash += 3 // 凭空多出 $3M
    const st = computeStats(s, null)
    expect(st.reconciliation.ok).toBe(false)
    expect(st.players[0].reconciles).toBe(false)
    expect(st.reconciliation.diffs[0]).toBe(-3)
    expect(st.reconciliation.notes.join()).toContain('对不上')
  })

  it('买牌支出从事件逐笔核算，并切到对应的交易之前', () => {
    const s = sample()
    s.bank = 2
    s.players[0].cash = 4
    s.events = [
      ...s.events,
      { id: 10, kind: 'DEAL_CLOSED', dealNo: 1, dealNumber: 1, spaceId: 1, tileId: 1, bossId: 0, gross: 10, payouts: [], bossKeep: 6, reps: [] },
      { id: 11, kind: 'CARDS_BOUGHT', playerId: 0, count: 1, cost: 2, handSize: 5 },
      { id: 12, kind: 'DEAL_FAILED', dealNo: 2, spaceId: 1, bossId: 0, reason: 'ABANDONED' },
      { id: 13, kind: 'DEAL_CLOSED', dealNo: 3, dealNumber: 2, spaceId: 1, tileId: 2, bossId: 1, gross: 8, payouts: [], bossKeep: 8, reps: [] },
    ]
    const st = computeStats(s, null)
    expect(st.players[0].spend).toMatchObject({ buy: 2, trade: 0, total: 2, source: 'events' })
    expect(st.reconciliation.ok).toBe(true)
    // 买牌发生在第 1 笔之后、第 2 笔（流局）之前
    expect(st.cashSeries.points.map(p => p.cash[0])).toEqual([0, 6, 4, 4])
  })
})

describe('录像与名次', () => {
  it('rankStandings 并列同名次（1、1、3）', () => {
    const s = gameOverState([10, 10, 4])
    expect(rankStandings(s.players).map(x => x.rank)).toEqual([1, 1, 3])
  })

  it('录像：任意位置的状态与逐步重放一致，检查点 / 缓存不影响随机访问', () => {
    const { recording, state } = playedGame(4, 11, 'classic')
    expect(recording.stateAt(recording.length)).toBe(recording.finalState)
    expect(recording.finalState.stateVersion).toBe(state.stateVersion)
    const probes = [0, 1, 47, 48, 49, 100, recording.length - 1, 5, 200, 3]
    for (const p of probes) {
      if (p > recording.length) continue
      const s = recording.stateAt(p)
      expect(s.stateVersion).toBe(1 + p)
      expect(recording.stateAt(p)).toBe(s)
    }
  })

  it('交易起止：openStep < endStep，状态在开单后有 negotiation、结算后没有', () => {
    const { recording, state } = playedGame(4, 11, 'classic')
    expect(recording.deals).toHaveLength(state.dealHistory.length)
    recording.deals.forEach((d, i) => {
      expect(d.dealNo).toBe(i + 1)
      expect(d.openStep).toBeLessThan(d.endStep)
      expect(recording.stateAt(recording.positionOpened(d.dealNo)!).negotiation).not.toBeNull()
      expect(recording.stateAt(recording.positionClosed(d.dealNo)!).negotiation).toBeNull()
      expect(recording.stateAt(recording.positionClosed(d.dealNo)!).dealHistory).toHaveLength(d.dealNo)
      expect(recording.dealAtPosition(recording.positionOpened(d.dealNo)!)).toBe(d.dealNo)
    })
  })

  it('日志对不上终态 / 缺开局参数时 tryBuildRecording 返回 null，不抛异常', () => {
    const { origin, log, state } = playedGame(3, 7, 'expansion')
    expect(tryBuildRecording(origin, log, state)).not.toBeNull()
    expect(tryBuildRecording(null, log, state)).toBeNull()
    expect(tryBuildRecording(origin, log.slice(0, -1), state)).toBeNull() // 少一步：终态对不上
    const broken = log.map((e, i) => (i === 3 ? { ...e, versionBefore: e.versionBefore + 5 } : e))
    expect(tryBuildRecording(origin, broken, state)).toBeNull()
    expect(logFitsState(log, state)).toBe(true)
    expect(logFitsState(log.slice(0, -1), state)).toBe(false)
  })
})
