import { describe, expect, it } from 'vitest'
import { parseChoiceResponse, parseQuotes, resolveChoice, resolvePayees } from '../src/ai/llmPolicy'
import { annotateOption, buildDecisionPrompt, buildGameContext, describeCoverage } from '../src/ai/prompts'
import { getActingPlayerId, getLegalActions } from '../src/engine/validator'
import { investorRepKey } from '../src/engine/rules'
import { baseState, clearHand, giveCards, openDealAt, setInvestors, step, toBoss } from './helpers'

describe('日志暴露的上下文与协议回归', () => {
  it('编号、玩家ID和金额不静默取整；空报价与显式未知家族不能变成免费或通用报价', () => {
    for (const choice of [1.9, '1.9', '', ' ', Infinity]) {
      expect(parseChoiceResponse(JSON.stringify({ choice }))).toBeNull()
    }
    expect(parseChoiceResponse('{"choice":"2"}')!.choice).toBe(2)
    for (const demand of ['', ' ', { amount: 3, family: 'Boss' }, [{ amount: 3, family: 'xyz' }], 2.5]) {
      expect(parseQuotes(demand)).toBeUndefined()
    }
    expect(parseQuotes(3, 'xyz')).toBeUndefined()
    expect(parseQuotes({ amount: 3, family: '*' })).toEqual([{ amount: 3 }])
    expect(parseChoiceResponse('{"choice":1,"cardIds":[3,1.5]}')!.cardIds).toBeUndefined()
    const s = baseState()
    expect(resolvePayees(s, [{ playerId: 1.9, amount: 3 }])).toBeNull()
    expect(parseChoiceResponse('{"choice":1,"payouts":[{"playerId":"1.9","amount":3}]}')!.payouts).toBeUndefined()
  })

  it('马拉松#17明确只需两家；#18现有A/B/D已齐，任选缺口只要求补足所缺数量', () => {
    const s = baseState(4, 81, 'marathon')
    setInvestors(s, { A: 1, B: 0, C: 2, D: 3 })
    s.markerPos = 17
    expect(describeCoverage(s)).toContain('共需 2 个不同家族')
    expect(describeCoverage(s)).toContain('A/B/F 选 2')
    expect(describeCoverage(s)).toContain('公开代表可凑齐')
    s.markerPos = 18
    expect(describeCoverage(s)).toContain('共需 3 个不同家族')
    expect(describeCoverage(s)).toContain('D/E 选 1')
    expect(describeCoverage(s)).toContain('已满足')
    setInvestors(s, { A: 1, B: 0, C: 2 })
    expect(describeCoverage(s)).toContain('还缺 1 个不同家族，从 D·蓝鲸实业 / E·绿洲商会 中补足 1 个即可')
  })

  it('5+4+3超过8的缺口被写清，流局后的近期动态和新报价不复用旧谈判', () => {
    let s = baseState(4, 82, 'marathon')
    setInvestors(s, { A: 1, B: 0, C: 2, D: 3 })
    s = openDealAt(s, 8, 1)
    s = step(s, { type: 'SPEAK', playerId: 2, say: '银湾四百万', quotes: [{ familyId: 'C', amount: 4 }] })
    s = step(s, { type: 'SPEAK', playerId: 3, say: '蓝鲸三百万', quotes: [{ familyId: 'D', amount: 3 }], note: '这笔守蓝鲸3M，等苏澜让价' })
    s = step(s, { type: 'SPEAK', playerId: 0, say: '赤岩五百万', quotes: [{ familyId: 'B', amount: 5 }], note: '这笔我坚持5M，等苏澜让价' })
    expect(buildGameContext(s, 1)).toContain('超出总额 $4M')
    s = step(s, { type: 'ABANDON_DEAL', playerId: 1 })
    s.markerPos = 17; s.currentId = 3; s.phase = 'AFTER_MOVE'
    const context = buildDecisionPrompt(s, 3, getLegalActions(s, 3)).user
    expect(context).toContain('现在没有正在进行的谈判')
    expect(context).toContain('上一笔 #8 已流局')
    expect(context).toContain('历史印象（旧报价、旧Boss、旧计划均已失效')
    const dynamics = context.split('【最近动态】')[1]?.split('【交易历史')[0] ?? ''
    expect(dynamics).not.toContain('报价')
    s = step(s, { type: 'OPEN_DEAL', playerId: 3 })
    expect(s.negotiation!.demands).toEqual([])
    const next = buildGameContext(s, 0)
    expect(next).toContain('第2次开单 #17')
    expect(next).not.toContain('你已公开承诺价')
    expect(next).not.toContain('同笔备忘')
  })

  it('非法自定义分成沿用候选时，不能保留原来承诺的金额', () => {
    let s = baseState(4, 83)
    setInvestors(s, { A: 0, B: 1 })
    s = toBoss(openDealAt(s, 1, 0))
    const legal = getLegalActions(s, 0)
    const index = legal.findIndex(a => a.type === 'PROPOSE_OFFER' && a.payouts.length > 0)
    const action = resolveChoice(JSON.stringify({ choice: index + 1, speech: '我付你99M，付到就成', payouts: [{ playerId: 1, amount: 99 }], note: '我已承诺99M' }), legal, s)!
    expect(action.type).toBe('PROPOSE_OFFER')
    expect(action.say).not.toContain('99')
    expect(action.note).toBeUndefined()
    expect(action.type === 'PROPOSE_OFFER' && action.payouts).toEqual((legal[index] as { payouts: unknown }).payouts)
  })

  it('弃牌编号含小数或错牌时整组回退，不悄悄弃掉合法子集或复述原选牌', () => {
    const s = baseState(4, 86)
    clearHand(s, 0)
    giveCards(s, 0, Array.from({ length: 13 }, () => ({ type: 'RECRUITMENT' as const })))
    s.phase = 'HAND_LIMIT'; s.currentId = 0; s.markerChooserId = null
    const legal = getLegalActions(s, 0)
    const index = legal.findIndex(a => a.type === 'DISCARD')
    const valid = s.players[0].hand.at(-1)!.id
    const action = resolveChoice(JSON.stringify({ choice: index + 1, cardIds: [valid, 1.5], speech: '我把这两张都弃掉', note: '刚弃了两张牌' }), legal, s)!
    expect(action.type === 'DISCARD' && action.cardIds).toEqual((legal[index] as { cardIds: number[] }).cardIds)
    expect(action.say).not.toContain('两张')
    expect(action.note).toBeUndefined()
  })

  it('旅行状态只属于本笔，流局后下一笔的投资者恢复且不带旧标签', () => {
    let s = baseState(4, 85)
    setInvestors(s, { A: 0, B: 1, C: 2, D: 3 })
    const [travel] = giveCards(s, 2, [{ type: 'TRAVEL', familyId: 'B' }])
    s = openDealAt(s, 1, 0)
    s = step(s, { type: 'PASS', playerId: 1 })
    s = step(s, { type: 'PLAY_TRAVEL', playerId: 2, cardId: travel.id, targetRepKey: investorRepKey('B') })
    while (s.phase === 'REACTION') s = step(s, { type: 'PASS_REACTION', playerId: getActingPlayerId(s) })
    expect(buildGameContext(s, 0)).toContain('[本笔失效]')
    expect(buildGameContext(s, 0)).not.toContain('[本局失效]')
    s = toBoss(s)
    s = step(s, { type: 'ABANDON_DEAL', playerId: 0 })
    s.markerPos = 1
    s = step(s, { type: 'OPEN_DEAL', playerId: 1 })
    expect(s.negotiation!.reps.find(r => r.key === investorRepKey('B'))!.travelled).toBe(false)
    expect(buildGameContext(s, 1)).not.toContain('[本笔失效]')
  })

  it('利空使总额不足时，提示中的预计到账与真实结算一致', () => {
    let s = baseState(4, 84, 'marathon')
    setInvestors(s, { A: 0, B: 1, C: 2, D: 3 })
    for (let i = 0; i < 4; i++) clearHand(s, i)
    const [bust] = giveCards(s, 1, [{ type: 'BUST' }])
    s = toBoss(openDealAt(s, 8, 0))
    s = step(s, { type: 'PROPOSE_OFFER', playerId: 0, repKeys: ['B', 'C', 'D'].map(f => investorRepKey(f as 'B' | 'C' | 'D')), payouts: [{ playerId: 1, amount: 3 }, { playerId: 2, amount: 3 }] })
    while (s.phase === 'OFFER_RESPONSE') s = step(s, { type: 'ACCEPT_OFFER', playerId: getActingPlayerId(s) })
    s = step(s, { type: 'CLOSE_DEAL', playerId: 0 })
    s = step(s, { type: 'PLAY_BUST', playerId: 1, cardId: bust.id })
    s = step(s, { type: 'CLOSE_DEAL', playerId: 0 })
    expect(buildGameContext(s, 2)).toContain('预计实际分得 $1M')
    expect(annotateOption(s, 2, { type: 'PASS_CLOSING', playerId: 2 })).toContain('实际到账 $1M')
    while (s.phase === 'CLOSING') s = step(s, { type: 'PASS_CLOSING', playerId: getActingPlayerId(s) })
    expect(s.dealHistory.at(-1)!.payouts).toEqual([{ playerId: 1, amount: 3 }, { playerId: 2, amount: 1 }])
  })
})
