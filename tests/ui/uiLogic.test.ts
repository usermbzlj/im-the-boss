// src/ui 下的其余纯函数：轮到你判定、人物配色、后果计算、结算摘要、提案并成交

import { describe, it, expect } from 'vitest'
import { gameReducer } from '../../src/engine/gameEngine'
import { getLegalActions } from '../../src/engine/validator'
import { acceptedCommitments } from '../../src/engine/rules'
import type { GameState, PlayerAction } from '../../src/engine/types'
import { needsAttention, canSkipWait } from '../../src/ui/attention'
import { personaColor, seatColor, HUMAN_COLOR, hashString, monogram } from '../../src/ui/personaColor'
import { PERSONA_IDS } from '../../src/ai/personas'
import { acceptOutcome, describeAcceptOutcome, isCostly } from '../../src/ui/consequences'
import { summarizeDeal, latestDealSummary } from '../../src/ui/dealSummary'
import { proposeAndClose } from '../../src/ui/proposeAndClose'
import {
  abandonedDealState, biddingState, closedDealState, closingState, offerKeysOf, offerResponseState,
  placeMarkerState, quotedBossState, turnState, legalFor, giveCards, clearHand, step,
} from './fixtures'

describe('needsAttention / canSkipWait', () => {
  it('轮到我做决定：回合、叫价轮、方案应答都提醒', () => {
    expect(needsAttention(turnState(0), legalFor(turnState(0), 0))).toBe(true)
    expect(needsAttention(biddingState(1, 0), legalFor(biddingState(1, 0), 0))).toBe(true)
    const resp = offerResponseState()
    expect(needsAttention(resp, legalFor(resp, 1))).toBe(true)
  })

  it('不是我的回合（没有合法动作）：不提醒，可以快进', () => {
    const s = turnState(2)
    expect(needsAttention(s, legalFor(s, 0))).toBe(false)
    expect(canSkipWait(s, legalFor(s, 0))).toBe(true)
  })

  it('成交倒计时里只能放行：自动放行，不提醒；有可打的牌才提醒', () => {
    const s = closingState() // 先问 1 号
    clearHand(s, 1)
    expect(legalFor(s, 1).every(a => a.type === 'PASS_CLOSING')).toBe(true)
    expect(needsAttention(s, legalFor(s, 1))).toBe(false)
    giveCards(s, 1, [{ type: 'TRAVEL', familyId: 'A' }])
    expect(needsAttention(s, legalFor(s, 1))).toBe(true)
  })

  it('反应窗口：没有阻止牌不提醒；有阻止牌才提醒', () => {
    // 0 号出旅行牌 → 其他人依次被询问；先问到的人没有阻止牌时不提醒，给他一张阻止牌才提醒
    let r = biddingState(1, 0)
    giveCards(r, 0, [{ type: 'TRAVEL', familyId: 'B' }])
    const target = r.negotiation!.reps.find(x => x.familyId === 'B')!
    const card = r.players[0].hand.find(c => c.type === 'TRAVEL' && c.familyId === 'B')!
    r = step(r, { type: 'PLAY_TRAVEL', playerId: 0, cardId: card.id, targetRepKey: target.key })
    expect(r.phase).toBe('REACTION')
    const asked = r.pendingReaction!.reactorId
    clearHand(r, asked)
    expect(needsAttention(r, legalFor(r, asked))).toBe(false)
    giveCards(r, asked, [{ type: 'STOP' }])
    expect(needsAttention(r, legalFor(r, asked))).toBe(true)
  })

  it('终局不提醒、不快进', () => {
    const s: GameState = { ...placeMarkerState(), phase: 'GAME_OVER' }
    expect(needsAttention(s, [{ type: 'ROLL_END', playerId: 0 }])).toBe(false)
    expect(canSkipWait(s, [])).toBe(false)
  })
})

describe('personaColor', () => {
  it('同一个 personaId 永远同一组颜色', () => {
    expect(personaColor('shen')).toEqual(personaColor('shen'))
    expect(personaColor('unknown-x', 1)).toEqual(personaColor('unknown-x', 2))
  })
  it('八位已知人物的主色互不相同', () => {
    const accents = PERSONA_IDS.map(id => personaColor(id).accent)
    expect(new Set(accents).size).toBe(PERSONA_IDS.length)
  })
  it('人类固定绿色；电脑按人物；没有 personaId 用座位号兜底', () => {
    expect(seatColor({ id: 0, isAI: false }, 0)).toBe(HUMAN_COLOR)
    expect(seatColor({ id: 2, isAI: true, personaId: 'lu' }, 0)).toEqual(personaColor('lu'))
    expect(seatColor({ id: 2, isAI: true }, 0)).toEqual(personaColor(undefined, 2))
    // 换视角：原来的人类座位现在是普通电脑配色
    expect(seatColor({ id: 0, isAI: true, personaId: 'lu' }, 1)).toEqual(personaColor('lu'))
  })
  it('哈希稳定；印章取首字', () => {
    expect(hashString('abc')).toBe(hashString('abc'))
    expect(hashString('abc')).not.toBe(hashString('abd'))
    expect(monogram('沈砚舟')).toBe('沈')
    expect(monogram('alice')).toBe('A')
  })
})

describe('acceptOutcome：与引擎同口径', () => {
  it('同意后的承诺价 = 引擎 acceptedCommitments 的结果', () => {
    const s = offerResponseState() // 1 号被分 $1，此前没报价
    const o = acceptOutcome(s, 1)!
    const neg = s.negotiation!
    const changes = acceptedCommitments(neg, neg.offer!, 1)
    expect(o.amount).toBe(1)
    expect(o.changed).toBe(changes.length > 0)
    expect(o.prices).toEqual(changes.map(c => ({ familyId: c.familyId, price: c.to, from: c.from, changed: true })))
    expect(describeAcceptOutcome(o)).toContain('$1M')
  })

  it('已报价且分成不低于报价：承诺价不变', () => {
    // 1 号先报 B=$1，Boss 付 $3 → 报价之和 1 ≤ 3 且每家都报过价 → 不改
    let s = biddingState(0)
    s = step(s, { type: 'SPEAK', playerId: 1, say: '黑松一百万', quotes: [{ familyId: 'B', amount: 1 }] })
    s = step(s, { type: 'PASS', playerId: 2 })
    s = step(s, { type: 'PASS', playerId: 3 })
    s = step(s, { type: 'PROPOSE_OFFER', playerId: 0, repKeys: offerKeysOf(s), payouts: [{ playerId: 1, amount: 3 }] })
    const o = acceptOutcome(s, 1)!
    expect(o.changed).toBe(false)
    expect(describeAcceptOutcome(o)).toBe('承诺价不变')
  })

  it('没有方案或方案没用我的代表：null', () => {
    expect(acceptOutcome(biddingState(0), 1)).toBeNull()
    expect(acceptOutcome(offerResponseState(), 2)).toBeNull()
  })

  it('isCostly：花费达到现金一半才需要确认', () => {
    expect(isCostly(3, 20)).toBe(false)
    expect(isCostly(10, 20)).toBe(true)
    expect(isCostly(0, 0)).toBe(false)
  })
})

describe('dealSummary', () => {
  it('成交：Boss / 每人所得 / 视角收益 / 所用代表按持有者归并', () => {
    const s = closedDealState()
    const sum = latestDealSummary(s, 0)!
    expect(sum.outcome).toBe('closed')
    if (sum.outcome !== 'closed') return
    expect(sum.bossId).toBe(0)
    expect(sum.viewerIsBoss).toBe(true)
    expect(sum.rows[0]).toMatchObject({ kind: 'boss', mine: true })
    expect(sum.viewerGain).toBe(sum.bossKeep)
    expect(sum.repOwners.some(o => o.playerId === 0 && o.families.length >= 2)).toBe(true)
    const asOther = latestDealSummary(s, 2)!
    expect(asOther.outcome === 'closed' && asOther.viewerGain).toBe(0)
  })

  it('成交：分成与租金都计入视角收益', () => {
    const s = closedDealState()
    const rec = { ...s.dealHistory[0], payouts: [{ playerId: 2, amount: 2 }], rents: [{ playerId: 2, amount: 1 }] }
    const sum = summarizeDeal({ ...s, dealHistory: [rec] }, rec, 2)
    expect(sum.outcome === 'closed' && sum.viewerGain).toBe(3)
    expect(sum.outcome === 'closed' && sum.rows.map(r => r.kind)).toEqual(['boss', 'payout', 'rent'])
  })

  it('流局：原因文案；缺代表时列出缺哪些家族', () => {
    const s = abandonedDealState()
    const sum = latestDealSummary(s, 0)!
    expect(sum).toMatchObject({ outcome: 'failed', reason: 'ABANDONED', viewerIsBoss: true })

    const rec = { ...s.dealHistory[0], failReason: 'INCOMPLETE' as const }
    const events = s.events.map(e => (e.kind === 'DEAL_FAILED' ? { ...e, reason: 'INCOMPLETE' as const, missing: ['C' as const, 'D' as const] } : e))
    const incomplete = summarizeDeal({ ...s, dealHistory: [rec], events }, rec, 0)
    expect(incomplete.outcome === 'failed' && incomplete.missing).toEqual(['C', 'D'])
    expect(incomplete.outcome === 'failed' && incomplete.reasonText).toMatch(/缺/)
  })

  it('没有交易历史：null', () => {
    expect(latestDealSummary(placeMarkerState(), 0)).toBeNull()
  })
})

describe('proposeAndClose', () => {
  /** 用真实 reducer 搭一个"会话"：act 推进状态，getState 同步读最新 */
  function session(initial: GameState) {
    let state = initial
    const acts: PlayerAction[] = []
    return {
      act: (a: PlayerAction) => { acts.push(a); state = gameReducer(state, a) ?? state },
      getState: () => state,
      acts,
    }
  }

  it('所有人都会按承诺价自动同意：提案后立刻宣布成交', () => {
    const s = quotedBossState()
    const sess = session(s)
    const result = proposeAndClose(sess.act, sess.getState, 0, offerKeysOf(s), [{ playerId: 1, amount: 2 }])
    expect(result).toBe('closed')
    expect(sess.acts.map(a => a.type)).toEqual(['PROPOSE_OFFER', 'CLOSE_DEAL'])
    expect(sess.getState().phase).toBe('CLOSING')
  })

  it('还有人需要表态：只提案，不宣布成交', () => {
    const s = quotedBossState()
    const sess = session(s)
    const result = proposeAndClose(sess.act, sess.getState, 0, offerKeysOf(s), [{ playerId: 1, amount: 1 }])
    expect(result).toBe('proposed')
    expect(sess.acts.map(a => a.type)).toEqual(['PROPOSE_OFFER'])
    expect(sess.getState().phase).toBe('OFFER_RESPONSE')
  })

  it('提案被引擎拒绝（状态没变）：不发宣布成交', () => {
    const s = quotedBossState()
    const sess = session(s)
    const result = proposeAndClose(sess.act, sess.getState, 0, offerKeysOf(s), [{ playerId: 0, amount: 1 }]) // 给 Boss 自己分钱：非法
    expect(result).toBe('rejected')
    expect(sess.acts.map(a => a.type)).toEqual(['PROPOSE_OFFER'])
  })

  it('用 getState 的最新状态判断：act 之后读到的是提案后的状态', () => {
    const s = quotedBossState()
    const sess = session(s)
    proposeAndClose(sess.act, sess.getState, 0, offerKeysOf(s), [{ playerId: 1, amount: 2 }])
    expect(getLegalActions(sess.getState(), 1).some(a => a.type === 'PASS_CLOSING')).toBe(true)
  })
})
