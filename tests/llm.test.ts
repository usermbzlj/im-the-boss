// LLM 策略的"按编号选择"协议：解析容错 + 落成合法动作 + 失败时安全兜底

import { describe, it, expect } from 'vitest'
import { extractJsonObject, parseChoiceResponse, resolveChoice, createLLMPolicy } from '../src/ai/llmPolicy'
import { buildDecisionPrompt } from '../src/ai/prompts'
import { getActingPlayerId, getLegalActions } from '../src/engine/validator'
import { investorRepKey } from '../src/engine/rules'
import { withFallback } from '../src/ai/policy'
import { DEFAULT_LLM_CONFIG } from '../src/ai/llmClient'
import { heuristicPolicy } from '../src/ai/heuristic'
import { baseState, setInvestors, openDealAt, step, clearHand, giveCards } from './helpers'

describe('回复解析', () => {
  it('能从 <think>、代码围栏、前后废话中抠出第一个 JSON 对象', () => {
    expect(extractJsonObject('<think>先想想{}</think>好的：```json\n{"choice": 2, "speech": "成交}"}\n```')).toBe('{"choice": 2, "speech": "成交}"}')
    expect(extractJsonObject('没有 json')).toBeNull()
    expect(extractJsonObject('{"a": {"b": 1}} 尾巴 {"c": 2}')).toBe('{"a": {"b": 1}}')
    expect(extractJsonObject('{"未闭合": 1')).toBeNull()
  })

  it('字段宽容：字符串数字、demand 对象、payout 单数、非法项过滤', () => {
    expect(parseChoiceResponse('{"choice": "3", "demand": {"amount": "2"}, "payout": [{"playerId": 1, "amount": 2}, {"playerId": "x"}]}'))
      .toEqual({ choice: 3, speech: undefined, demand: 2, payouts: [{ playerId: 1, amount: 2 }], cardIds: undefined })
    expect(parseChoiceResponse('{"choice": 0}')).toBeNull()
    expect(parseChoiceResponse('{"speech": "没选"}')).toBeNull()
    expect(parseChoiceResponse('{"choice": 1, "cardIds": [3, "4", null, "x"]}')!.cardIds).toEqual([3, 4])
  })
})

describe('落成动作', () => {
  function bossTurn() {
    let s = baseState(4, 31)
    setInvestors(s, { A: 0, B: 1, C: 2, D: 3 })
    s = openDealAt(s, 1, 0)
    return s
  }

  it('序号越界 / 解析失败 → null；合法序号 → 对应动作并附台词', () => {
    const s = bossTurn()
    const legal = getLegalActions(s, 0)
    expect(resolveChoice('胡言乱语', legal, s)).toBeNull()
    expect(resolveChoice(`{"choice": ${legal.length + 1}}`, legal, s)).toBeNull()
    const idx = legal.findIndex(a => a.type === 'PASS')
    const a = resolveChoice(`{"choice": ${idx + 1}, "speech": "  你们先谈  "}`, legal, s)!
    expect(a.type).toBe('PASS')
    expect(a.say).toBe('你们先谈')
  })

  it('SPEAK 可附带要价（被夹到 [0, 总额]），无内容时用默认台词', () => {
    const s = bossTurn()
    const legal = getLegalActions(s, 0)
    const idx = legal.findIndex(a => a.type === 'SPEAK')
    const a = resolveChoice(`{"choice": ${idx + 1}, "demand": 99}`, legal, s)!
    expect(a.type).toBe('SPEAK')
    expect(a.type === 'SPEAK' && a.demand).toBe(6)
    expect(a.say!.length).toBeGreaterThan(0)
    const b = resolveChoice(`{"choice": ${idx + 1}, "demand": -5, "speech": "${'长'.repeat(200)}"}`, legal, s)!
    expect(b.type === 'SPEAK' && b.demand).toBe(0)
    expect(b.say!.length).toBe(120)
  })

  it('PROPOSE_OFFER 的自定义分成合法则采用，非法则退回候选方案', () => {
    const s = bossTurn()
    const legal = getLegalActions(s, 0)
    const idx = legal.findIndex(a => a.type === 'PROPOSE_OFFER')
    const good = resolveChoice(`{"choice": ${idx + 1}, "payouts": [{"playerId": 1, "amount": 4}]}`, legal, s)!
    expect(good.type === 'PROPOSE_OFFER' && good.payouts).toEqual([{ playerId: 1, amount: 4 }])
    const bad = resolveChoice(`{"choice": ${idx + 1}, "payouts": [{"playerId": 1, "amount": 40}]}`, legal, s)!
    expect(bad.type === 'PROPOSE_OFFER' && bad.payouts).toEqual((legal[idx] as { payouts: unknown }).payouts)
    // 给 Boss 自己分钱的条目会被剔除
    const self = resolveChoice(`{"choice": ${idx + 1}, "payouts": [{"playerId": 0, "amount": 2}, {"playerId": 1, "amount": 1}]}`, legal, s)!
    expect(self.type === 'PROPOSE_OFFER' && self.payouts).toEqual([{ playerId: 1, amount: 1 }])
  })

  it('DECLINE_OFFER 可附反报价；DISCARD 可指定弃牌', () => {
    let s = bossTurn()
    s = step(s, { type: 'PROPOSE_OFFER', playerId: 0, repKeys: [investorRepKey('A'), investorRepKey('B')], payouts: [{ playerId: 1, amount: 1 }] })
    const legal = getLegalActions(s, 1)
    const idx = legal.findIndex(a => a.type === 'DECLINE_OFFER')
    const a = resolveChoice(`{"choice": ${idx + 1}, "demand": 3}`, legal, s)!
    expect(a.type === 'DECLINE_OFFER' && a.counter).toBe(3)

    const h = baseState(4, 32)
    clearHand(h, 0)
    giveCards(h, 0, Array.from({ length: 14 }, () => ({ type: 'RECRUITMENT' as const })))
    h.phase = 'HAND_LIMIT'; h.currentId = 0; h.markerChooserId = null
    const hl = getLegalActions(h, 0)
    const di = hl.findIndex(x => x.type === 'DISCARD')
    const pick = h.players[0].hand.slice(-2).map(c => c.id)
    const d = resolveChoice(`{"choice": ${di + 1}, "cardIds": [${pick.join(',')}]}`, hl, h)!
    expect(d.type === 'DISCARD' && d.cardIds).toEqual(pick)
    const wrong = resolveChoice(`{"choice": ${di + 1}, "cardIds": [999]}`, hl, h)!
    expect(wrong.type === 'DISCARD' && wrong.cardIds).toEqual((hl[di] as { cardIds: unknown }).cardIds)
  })
})

describe('提示词与策略', () => {
  it('决策提示词包含编号列表、人格与规则摘要；不会泄露他人手牌内容', () => {
    let s = baseState(4, 33)
    setInvestors(s, { A: 0, B: 1, C: 2, D: 3 })
    for (let i = 0; i < 4; i++) clearHand(s, i)
    giveCards(s, 3, [{ type: 'STOP' }])
    s = openDealAt(s, 1, 0)
    const legal = getLegalActions(s, 0)
    const { system, user } = buildDecisionPrompt(s, 0, legal)
    expect(system.length).toBeGreaterThan(50)
    for (let i = 1; i <= legal.length; i++) expect(user).toContain(`${i}. `)
    expect(user).toContain('【你的身份】')
    expect(user).not.toContain('阻止牌#') // 3 号的阻止牌不能出现在 0 号的提示词里
    expect(user).toContain('手牌1张')
  })

  it('未配置 LLM 时策略返回 null，withFallback 交给启发式；唯一合法动作不请求模型', async () => {
    const policy = createLLMPolicy(() => ({ ...DEFAULT_LLM_CONFIG, enabled: true, apiKey: '' }))
    const s = baseState(4, 34)
    setInvestors(s, { A: 0, B: 1, C: 2, D: 3 })
    const t = openDealAt(s, 1, 0)
    expect(await policy.decide(t, new AbortController().signal)).toBeNull()
    const combined = withFallback(policy, heuristicPolicy)
    const a = await combined.decide(t, new AbortController().signal)
    expect(a).not.toBeNull()
    expect(a!.playerId).toBe(getActingPlayerId(t))

    // 终局掷骰只有一个合法动作：无需模型即可决策
    const e = baseState(4, 35)
    e.phase = 'END_ROLL'; e.currentId = 0; e.markerChooserId = null
    const only = await policy.decide(e, new AbortController().signal)
    expect(only?.type).toBe('ROLL_END')
  })
})
