import { describe, expect, it } from 'vitest'
import { parseChoiceResponse, parseQuotes, resolveChoice, resolvePayees } from '../src/ai/llmPolicy'
import { annotateOption, buildDecisionPrompt, buildGameContext, describeCoverage } from '../src/ai/prompts'
import { getActingPlayerId, getLegalActions } from '../src/engine/validator'
import { getGrossValue, investorRepKey } from '../src/engine/rules'
import { baseState, clearHand, giveCards, openDealAt, setInvestors, step, toBoss } from './helpers'

describe('日志暴露的上下文与协议回归', () => {
  function nineMillionDeal() {
    let s = baseState(4, 87)
    for (let i = 0; i < 4; i++) clearHand(s, i)
    s.players[0].name = '姚老板'; s.players[1].name = '顾曼宁'
    s.players[2].name = '苏澜'; s.players[3].name = '程亦舟'
    setInvestors(s, { A: 2, B: 0, D: 1, F: 3 })
    s.dealTileIndex = s.dealTiles.findIndex(t => t.shareValue === 3)
    expect(s.dealTileIndex).toBeGreaterThanOrEqual(0)
    s = openDealAt(s, 1, 1)
    expect(getGrossValue(s)).toBe(9)
    s = step(s, { type: 'SPEAK', playerId: 2, say: '星桥六百万', quotes: [{ familyId: 'A', amount: 6 }] })
    s = step(s, { type: 'SPEAK', playerId: 3, say: '封口费两百万', quotes: [{ amount: 2 }] })
    return step(s, { type: 'SPEAK', playerId: 0, say: '赤岩四百万', quotes: [{ familyId: 'B', amount: 4 }] })
  }

  it('9M交易的Boss喊话不再被注释成索封口费，代表与交易资金归属明确', () => {
    const s = nineMillionDeal()
    const prompt = buildDecisionPrompt(s, 1, getLegalActions(s, 1))
    const speak = prompt.options.find(a => a.type === 'SPEAK')!
    const annotation = annotateOption(s, 1, speak)
    expect(annotation).toContain('你就是本笔 Boss')
    expect(annotation).toContain('demand 必须填 null')
    expect(annotation).not.toContain('可施压 / 索要封口费')
    expect(prompt.user).toContain('你就是本笔 Boss 顾曼宁')
    expect(prompt.user).toContain('不扣你的已有现金')
    expect(prompt.user).toContain('超出总额 $1M')
    expect(prompt.system).toContain('只有非 Boss 可以用 demand')
  })

  it('原始Boss demand=4回复被修成纯喊话，不生成自付封口费或回灌错误笔记', () => {
    const s = nineMillionDeal()
    const legal = getLegalActions(s, 1)
    const choice = legal.findIndex(a => a.type === 'SPEAK') + 1
    for (const speech of ['$4M，作为不干预的对价。', '顾Boss这单我不吃亏:赤岩集团$4M,照你方才的价,付到就成。']) {
      const action = resolveChoice(JSON.stringify({ choice, speech, demand: 4, note: '我报4M守住，先不提方案' }), legal, s)!
      expect(action.type).toBe('SPEAK')
      expect(action.type === 'SPEAK' && action.quotes).toBeUndefined()
      expect(action.say).not.toContain('不干预')
      expect(action.say).not.toContain('顾Boss')
      expect(action.note).toBeUndefined()
      const next = step(s, action)
      expect(next.negotiation!.demands.some(d => d.playerId === 1)).toBe(false)
      expect(next.players[1].notes).toEqual([])
    }
  })

  it('Boss派家族牌时忽略模型自己的出借价，非Boss合法承诺仍正常落成', () => {
    const s = nineMillionDeal()
    const [card] = giveCards(s, 1, [{ type: 'CLAN', familyId: 'B' }])
    const legal = getLegalActions(s, 1)
    const choice = legal.findIndex(a => a.type === 'PLAY_CLAN' && a.cardId === card.id) + 1
    expect(choice).toBeGreaterThan(0)
    const action = resolveChoice(JSON.stringify({ choice, demand: { B: 4 }, speech: '我出赤岩集团，四百万付到就成。', note: '我的赤岩报价4M' }), legal, s)!
    expect(action.type).toBe('PLAY_CLAN')
    expect(action.type === 'PLAY_CLAN' && action.demand).toBeUndefined()
    expect(action.note).toBeUndefined()
    expect(step(s, action).negotiation!.demands.some(d => d.playerId === 1)).toBe(false)
    const original = baseState(4, 88)
    setInvestors(original, { A: 2, B: 0 })
    const nonBoss = openDealAt(original, 1, 1)
    const borrower = resolveChoice(JSON.stringify({ choice: 1, demand: { A: 6 }, speech: '我的星桥资本，$6M付到就成。', note: '本笔星桥报价6M' }), [{ type: 'SPEAK', playerId: 2, say: '…' }], nonBoss)!
    expect(borrower.type === 'SPEAK' && borrower.quotes).toEqual([{ familyId: 'A', amount: 6 }])
    expect(borrower.note).toBe('本笔星桥报价6M')
  })

  it('Boss对其他人说支付或还价仍可保留；冒领代表的台词与笔记一并替换', () => {
    const s = nineMillionDeal()
    const legal = getLegalActions(s, 1)
    const choice = legal.findIndex(a => a.type === 'SPEAK') + 1
    const speech = '姚老板，赤岩集团我按$4M支付；苏澜，星桥资本请降到$3M。'
    const payment = resolveChoice(JSON.stringify({ choice, speech, demand: null, note: '询问星桥能否降价' }), legal, s)!
    expect(payment.say).toBe(speech)
    expect(payment.note).toBe('询问星桥能否降价')
    const falseClaim = resolveChoice(JSON.stringify({ choice, speech: '顾Boss，赤岩集团我出借，$4M付到就成。', note: '守住我的赤岩4M' }), legal, s)!
    expect(falseClaim.say).not.toContain('顾Boss')
    expect(falseClaim.say).not.toContain('我出借')
    expect(falseClaim.note).toBeUndefined()
  })

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
