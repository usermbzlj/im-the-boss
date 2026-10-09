// 行动提示的纯逻辑：短句与"与你有关"的判定、自己动作不回声、合并 / 数量上限 / 时长

import { describe, it, expect } from 'vitest'
import type { GameEvent, LoggedEvent } from '../../src/engine/types'
import { briefOf, toastDraftsFor, mergeToasts, ttlFor, MAX_TOASTS, type Toast, type ToastDraft } from '../../src/ui/toasts'
import { biddingState, bossPlanningState, placeMarkerState } from './fixtures'

let seq = 100
const ev = (e: GameEvent): LoggedEvent => ({ id: ++seq, ...e }) as LoggedEvent
const state = placeMarkerState() // 4 人局：0 号是视角玩家，A–D 分属 0–3 号
const VIEWER = 0

describe('briefOf：与你有关的事件醒目、其余普通', () => {
  it('你的代表被旅行牌打飞 / 被招募挖走 / 被夺权 / 被病假：bad + mine，且不合并', () => {
    const travelled = briefOf(state, ev({ kind: 'TRAVEL_RESOLVED', target: { familyId: 'A', ownerId: VIEWER, source: 'INVESTOR' } }), VIEWER)!
    const recruited = briefOf(state, ev({ kind: 'RECRUITMENT_RESOLVED', playerId: 2, familyId: 'A', fromId: VIEWER }), VIEWER)!
    const usurped = briefOf(state, ev({ kind: 'BOSS_RESOLVED', playerId: 2, previousBossId: VIEWER }), VIEWER)!
    const sick = briefOf(state, ev({ kind: 'SICK_RESOLVED', playerId: 2, targetId: VIEWER }), VIEWER)!
    for (const b of [travelled, recruited, usurped, sick]) {
      expect(b.tone).toBe('bad')
      expect(b.mine).toBe(true)
      expect(b.toast).toBe(true)
    }
    expect(new Set([travelled, recruited, usurped, sick].map(b => b.group)).size).toBe(4)
  })

  it('同一事件对旁观者只是普通提示（info、不 mine）', () => {
    const b = briefOf(state, ev({ kind: 'TRAVEL_RESOLVED', target: { familyId: 'A', ownerId: 2, source: 'INVESTOR' } }), VIEWER)!
    expect(b.tone).toBe('info')
    expect(b.mine).toBe(false)
  })

  it('打向你的牌在"打出"时就醒目；打向别人的只是普通提示', () => {
    const atMe = briefOf(state, ev({ kind: 'TRAVEL_PLAYED', playerId: 2, wildcard: false, target: { familyId: 'A', ownerId: VIEWER, source: 'INVESTOR' } }), VIEWER)!
    const atOther = briefOf(state, ev({ kind: 'TRAVEL_PLAYED', playerId: 2, wildcard: false, target: { familyId: 'C', ownerId: 3, source: 'INVESTOR' } }), VIEWER)!
    expect(atMe).toMatchObject({ tone: 'bad', mine: true })
    expect(atOther).toMatchObject({ tone: 'info', mine: false })
  })

  it('被阻止 / 阻止成功：你的牌被取消是 bad，你的阻止牌生效是 good', () => {
    const cancelled = briefOf(state, ev({ kind: 'STOP_PLAYED', playerId: 2, actorId: VIEWER, cancelled: 'TRAVEL' }), VIEWER)!
    const stopped = briefOf(state, ev({ kind: 'STOP_PLAYED', playerId: VIEWER, actorId: 2, cancelled: 'BOSS' }), VIEWER)!
    expect(cancelled.tone).toBe('bad')
    expect(stopped.tone).toBe('good')
  })

  it('方案：用了你的代表分钱 / 付到承诺价 / 你被排除出方案 都带 mine', () => {
    const proposal = (over: Partial<Extract<GameEvent, { kind: 'OFFER_PROPOSED' }>>) => ev({
      kind: 'OFFER_PROPOSED', bossId: 2, offerNo: 1, reps: [], payouts: [], bossKeep: 5, waitingFor: [], autoAccepted: [], ...over,
    })
    const s = biddingState(2, 0) // 2 号当 Boss，0 号持有 A（本格需要）
    const asked = briefOf(s, proposal({ reps: [{ familyId: 'A', ownerId: VIEWER, source: 'INVESTOR' }], payouts: [{ playerId: VIEWER, amount: 3 }], waitingFor: [VIEWER] }), VIEWER)!
    expect(asked).toMatchObject({ mine: true, tone: 'info' })
    expect(asked.text).toContain('3')
    const auto = briefOf(s, proposal({ reps: [{ familyId: 'A', ownerId: VIEWER, source: 'INVESTOR' }], payouts: [{ playerId: VIEWER, amount: 3 }], autoAccepted: [VIEWER] }), VIEWER)!
    expect(auto).toMatchObject({ mine: true, tone: 'good' })
    const excluded = briefOf(s, proposal({ reps: [{ familyId: 'A', ownerId: 3, source: 'CLAN' }] }), VIEWER)!
    expect(excluded).toMatchObject({ mine: true, tone: 'bad' })
  })

  it('你是 Boss：别人拒绝方案是 bad；别人的报价才会提示', () => {
    const s = bossPlanningState(0)
    const declined = briefOf(s, ev({ kind: 'OFFER_DECLINED', playerId: 1, counters: [{ familyIds: ['B'], amount: 4 }] }), VIEWER)!
    expect(declined).toMatchObject({ tone: 'bad', mine: true })
    const demand = ev({ kind: 'DEMAND', playerId: 1, quotes: [{ familyIds: ['B'], amount: 3 }] })
    expect(briefOf(s, demand, VIEWER)).not.toBeNull()
    // 不是 Boss 时，别人的报价不弹（事件流里看得到）
    expect(briefOf(biddingState(2, 0), demand, VIEWER)).toBeNull()
  })

  it('成交 / 流局：你分到钱 → good；你是 Boss 的流局 → bad；与你无关 → 中性', () => {
    const closed = (bossId: number, payouts: { playerId: number; amount: number }[]) =>
      ev({ kind: 'DEAL_CLOSED', dealNumber: 1, spaceId: 1, tileId: 1, bossId, gross: 10, payouts, bossKeep: 10, reps: [] })
    expect(briefOf(state, closed(2, [{ playerId: VIEWER, amount: 3 }]), VIEWER)).toMatchObject({ tone: 'good', mine: true })
    expect(briefOf(state, closed(2, []), VIEWER)).toMatchObject({ tone: 'deal', mine: false })
    expect(briefOf(state, ev({ kind: 'DEAL_FAILED', spaceId: 1, bossId: VIEWER, reason: 'STALEMATE' }), VIEWER)).toMatchObject({ tone: 'bad', mine: true })
    expect(briefOf(state, ev({ kind: 'DEAL_FAILED', spaceId: 1, bossId: 2, reason: 'INCOMPLETE', missing: ['C'] }), VIEWER)).toMatchObject({ tone: 'fail', mine: false })
  })

  it('跳过 / 放行 / 喊话 / 抽牌不进提示（也就不会泄露谁在考虑）', () => {
    const quiet: GameEvent[] = [
      { kind: 'PASSED', playerId: 2, phase: 'REACTION' },
      { kind: 'PASSED', playerId: 2, phase: 'CLOSING' },
      { kind: 'PASSED', playerId: 2, phase: 'NEGOTIATION' },
      { kind: 'SPEECH', playerId: 2, text: '嗯' },
      { kind: 'CARDS_DRAWN', playerId: 2, count: 3, handSize: 8 },
      { kind: 'STALEMATE_ROUND', rounds: 1, max: 2 },
    ]
    for (const e of quiet) expect(briefOf(state, ev(e), VIEWER)).toBeNull()
  })
})

describe('toastDraftsFor：自己刚做的动作不回声，结果照常提示', () => {
  it('你打出的牌 / 你发起的交易不弹；你的牌的结果会弹', () => {
    const drafts = toastDraftsFor(state, [
      ev({ kind: 'DEAL_OPENED', playerId: VIEWER, spaceId: 1, gross: 10 }),
      ev({ kind: 'CLAN_PLAYED', playerId: VIEWER, familyId: 'A' }),
      ev({ kind: 'BOSS_RESOLVED', playerId: VIEWER, previousBossId: 2 }),
    ], VIEWER)
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({ tone: 'good', mine: true })
  })

  it('只用于简报的事件（掷骰移动）不弹提示', () => {
    expect(toastDraftsFor(state, [ev({ kind: 'MARKER_MOVED', playerId: 2, die: 3, spaceId: 4, gross: 8 })], VIEWER)).toHaveLength(0)
  })

  it('电脑玩家的重要动作都有草稿：开单 / 出牌 / 提案 / 承诺价变更 / 成交 / 流局 / 收租', () => {
    const drafts = toastDraftsFor(state, [
      ev({ kind: 'DEAL_OPENED', playerId: 2, spaceId: 1, gross: 10 }),
      ev({ kind: 'BOOM_PLAYED', playerId: 2 }),
      ev({ kind: 'OFFER_PROPOSED', bossId: 2, offerNo: 1, reps: [], payouts: [], bossKeep: 5, waitingFor: [], autoAccepted: [] }),
      ev({ kind: 'COMMITMENT_UPDATED', playerId: 3, changes: [{ familyId: 'D', from: null, to: 2 }] }),
      ev({ kind: 'RENT_PAID', payments: [{ playerId: 3, amount: 1 }] }),
      ev({ kind: 'DEAL_FAILED', spaceId: 1, bossId: 2, reason: 'ABANDONED' }),
    ], VIEWER)
    expect(drafts).toHaveLength(6)
    expect(drafts.every(d => d.ttl >= 2500 && d.ttl <= 4000)).toBe(true)
  })
})

describe('mergeToasts', () => {
  const draft = (over: Partial<ToastDraft> = {}): ToastDraft => ({ group: 'card:2', text: '电脑打出牌', tone: 'info', mine: false, ttl: 2600, ...over })
  const keys = () => { let k = 0; return () => ++k }

  it('连续同组合并：计数 +1、文案取最新、版本 +1（重置消失计时）', () => {
    const next = keys()
    const a = mergeToasts([], [draft({ text: '第一张' })], next)
    const b = mergeToasts(a, [draft({ text: '第二张' })], next)
    expect(b).toHaveLength(1)
    expect(b[0]).toMatchObject({ text: '第二张', count: 2, version: 1, key: a[0].key })
  })

  it('不同组不合并；中间夹了别的组也不合并（只看最新一条）', () => {
    const next = keys()
    let list: Toast[] = mergeToasts([], [draft({ group: 'card:2' }), draft({ group: 'card:3' }), draft({ group: 'card:2' })], next)
    expect(list.map(t => t.count)).toEqual([1, 1, 1])
    list = mergeToasts(list, [draft({ group: 'card:2' })], next)
    expect(list[list.length - 1].count).toBe(2)
  })

  it(`最多 ${MAX_TOASTS} 条：先挤掉最旧的与你无关的`, () => {
    const next = keys()
    const list = mergeToasts([], [
      draft({ group: 'a', text: 'A', mine: true }),
      draft({ group: 'b', text: 'B' }),
      draft({ group: 'c', text: 'C', mine: true }),
      draft({ group: 'd', text: 'D' }),
    ], next)
    expect(list).toHaveLength(MAX_TOASTS)
    expect(list.map(t => t.text)).toEqual(['A', 'C', 'D'])
  })

  it('全是与你有关的：挤掉最旧的', () => {
    const next = keys()
    const list = mergeToasts([], ['a', 'b', 'c', 'd'].map(g => draft({ group: g, text: g, mine: true })), next)
    expect(list.map(t => t.text)).toEqual(['b', 'c', 'd'])
  })

  it('不修改传入的列表', () => {
    const next = keys()
    const a = mergeToasts([], [draft()], next)
    const snapshot = JSON.stringify(a)
    mergeToasts(a, [draft()], next)
    expect(JSON.stringify(a)).toBe(snapshot)
  })
})

describe('ttlFor：约 2.5–4 秒，与你有关的更久', () => {
  it('范围与顺序', () => {
    const all = [ttlFor('info', false), ttlFor('deal', false), ttlFor('good', true), ttlFor('bad', true)]
    for (const t of all) { expect(t).toBeGreaterThanOrEqual(2500); expect(t).toBeLessThanOrEqual(4000) }
    expect(ttlFor('bad', true)).toBeGreaterThan(ttlFor('info', false))
  })
})
