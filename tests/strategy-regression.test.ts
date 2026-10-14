import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GameState, PlayerAction } from '../src/engine/types'
import { getActingPlayerId, getLegalActions, isLegal } from '../src/engine/validator'
import { getGrossValue } from '../src/engine/rules'
import { heuristicAction, heuristicSpeech, estimateDeal } from '../src/ai/heuristic'
import { decisionTier } from '../src/ai/decisionTier'
import { createAiPolicy, ensureNegotiationProgress } from '../src/ai/aiPolicy'
import { DEFAULT_LLM_CONFIG } from '../src/ai/llmClient'
import { alreadyWaited, currentDealEvents } from '../src/ai/negotiationProgress'
import { baseState, clearHand, giveCards, openDealAt, setInvestors, step, toBoss } from './helpers'

afterEach(() => vi.unstubAllGlobals())

function expensiveDeal(seed = 1): GameState {
  let s = baseState(4, seed, 'marathon', false)
  for (const p of s.players) clearHand(s, p.id)
  setInvestors(s, { A: 0, E: 0, B: 1, C: 2, D: 3 })
  s.players[0].personaId = 'su'
  s.players[2].personaId = 'he'
  s.players[3].personaId = 'zhou'
  s = openDealAt(s, 8, 0)
  for (const [playerId, familyId, amount] of [[1, 'B', 5], [2, 'C', 4], [3, 'D', 3]] as const) {
    s = step(s, { type: 'SPEAK', playerId, say: `报价 ${amount}`, quotes: [{ familyId, amount }] })
  }
  return s
}

describe('超预算谈判的实质出路', () => {
  it('$8M 对 $5M+$4M+$3M：Boss 提具体预算内还价，每位所用代表有收入', () => {
    const s = expensiveDeal()
    expect(getGrossValue(s)).toBe(8)
    const a = heuristicAction(s)!
    expect(a.type).toBe('PROPOSE_OFFER')
    if (a.type !== 'PROPOSE_OFFER') throw new Error('应提出具体方案')
    expect(a.payouts).toHaveLength(3)
    expect(a.payouts.every(p => p.amount >= 1)).toBe(true)
    expect(a.payouts.reduce((sum, p) => sum + p.amount, 0)).toBeLessThan(8)
    expect(a.say).toContain('$')
    expect(isLegal(s, a)).toBe(true)
    expect(heuristicAction(s)).toEqual(a)
  })

  it('三位坚持原价：不重复同一分配方案，有限提案后明确结束', () => {
    let s = expensiveDeal(13)
    const signatures: string[] = []
    let turns = 0
    while (s.negotiation && turns++ < 40) {
      const playerId = getActingPlayerId(s)
      let action: PlayerAction
      if (s.phase === 'OFFER_RESPONSE') {
        action = { type: 'DECLINE_OFFER', playerId, quotes: [{ amount: [0, 5, 4, 3][playerId] }] }
      } else if (playerId === 0) {
        action = heuristicAction(s)!
      } else {
        action = { type: 'PASS', playerId }
      }
      if (action.type === 'PROPOSE_OFFER') {
        signatures.push(JSON.stringify({ reps: [...action.repKeys].sort(), payouts: action.payouts }))
        expect(action.payouts.every(p => p.amount >= 1)).toBe(true)
      }
      s = step(s, action)
    }
    expect(turns).toBeLessThan(40)
    expect(signatures.length).toBeGreaterThan(0)
    expect(new Set(signatures).size).toBe(signatures.length)
    expect(s.negotiation).toBeNull()
    expect(s.dealHistory.at(-1)?.success).toBe(false)
  })

  it('超预算时可用自己的成员卡替代昂贵代表，或用利好扩盘', () => {
    const clanState = expensiveDeal(7)
    const [clan] = giveCards(clanState, 0, [{ type: 'CLAN', familyId: 'B' }])
    expect(heuristicAction(clanState)).toMatchObject({ type: 'PLAY_CLAN', cardId: clan.id })
    const boomState = expensiveDeal(7)
    const [boom] = giveCards(boomState, 0, [{ type: 'BOOM' }])
    expect(heuristicAction(boomState)).toMatchObject({ type: 'PLAY_BOOM', cardId: boom.id })
  })

  it('Boss 只替代一家昂贵代表时，派牌台词不宣称全部自有或独吞', () => {
    const says = new Set<string>()
    for (const personaId of ['shen', 'lu', 'gu', 'he', 'zhou', 'su', 'cheng', 'bai']) {
      const s = expensiveDeal(7)
      s.players[0].personaId = personaId
      const [clan] = giveCards(s, 0, [{ type: 'CLAN', familyId: 'B' }])
      const action = heuristicAction(s)!
      expect(action).toMatchObject({ type: 'PLAY_CLAN', cardId: clan.id })
      expect(action.say).toContain('赤岩集团')
      expect(action.say).not.toMatch(/人我全有|都[是用在]|人手齐|不[用劳麻烦]|独[吞立]|成本为零|自己能凑齐|全[是用部]/)
      expect(heuristicSpeech(s, { type: 'PLAY_CLAN', playerId: 0, cardId: clan.id })).toBe(action.say)
      says.add(action.say!)
    }
    expect(says.size).toBeGreaterThanOrEqual(6)
  })

  it('其他手牌尚未派出时仍不宣称有效代表全齐，真正派齐后才用独立成交台词', () => {
    const s = expensiveDeal(7)
    const [b] = giveCards(s, 0, [{ type: 'CLAN', familyId: 'B' }, { type: 'CLAN', familyId: 'C' }, { type: 'CLAN', familyId: 'D' }])
    const before = heuristicSpeech(s, { type: 'PLAY_CLAN', playerId: 0, cardId: b.id })
    expect(before).toContain('赤岩集团')
    for (const r of s.negotiation!.reps) if (r.familyId === 'C' || r.familyId === 'D') r.ownerId = 0
    const ready = heuristicSpeech(s, { type: 'PLAY_CLAN', playerId: 0, cardId: b.id })
    expect(ready).not.toBe(before)
  })

  it('外家代表明确承诺免费，空分成方案得到保留且按约自动同意', () => {
    let s = baseState(4, 6)
    for (const p of s.players) clearHand(s, p.id)
    setInvestors(s, { A: 0, B: 1 })
    s = openDealAt(s, 1, 0)
    s = step(s, { type: 'SPEAK', playerId: 1, say: '这次免费', quotes: [{ familyId: 'B', amount: 0 }] })
    s = toBoss(s)
    const action = heuristicAction(s)!
    expect(action.type).toBe('PROPOSE_OFFER')
    if (action.type !== 'PROPOSE_OFFER') throw new Error('应该按免费承诺提案')
    expect(action.payouts).toEqual([])
    expect(action.say).toContain('免费承诺 $0M')
    expect(action.say).not.toMatch(/下[次回]|欠|人情|借/)
    s = step(s, action)
    expect(s.phase).toBe('NEGOTIATION')
    expect(s.negotiation!.offer!.responses[1]).toBe('ACCEPTED')
    expect(heuristicAction(s)?.type).toBe('CLOSE_DEAL')
  })

  it('人类先跳过后，后面的 AI 仍能接到 Boss 等待信号而降价', () => {
    let concessions = 0
    for (let seed = 1; seed <= 30; seed++) {
      let s = expensiveDeal(seed)
      s = step(s, { type: 'PASS', playerId: 0 })
      s = step(s, { type: 'PASS', playerId: 1 })
      expect(getActingPlayerId(s)).toBe(2)
      const action = heuristicAction(s)!
      if (action.type === 'SPEAK' && action.quotes?.some(q => q.familyId === 'C' && q.amount < 4)) {
        concessions++
        const withoutSignal = structuredClone(s)
        withoutSignal.events = withoutSignal.events.filter(e => !(e.kind === 'PASSED' && e.playerId === 0))
        expect(heuristicAction(withoutSignal)?.type).toBe('PASS')
      }
    }
    expect(concessions).toBeGreaterThan(0)
  })
})

describe('交易入口与信息边界', () => {
  function thinDeal(spaceId: number, seed: number): GameState {
    const s = baseState(4, seed, 'marathon', false)
    for (const p of s.players) clearHand(s, p.id)
    setInvestors(s, { A: 0, B: 1, D: 2, C: 3 })
    // 开单者没有本格相关投资者，但拥有足够多的其他牌，不会被补牌偏好挡住。
    giveCards(s, 3, Array.from({ length: 5 }, () => ({ type: 'RECRUITMENT' as const })))
    s.currentId = 3; s.markerChooserId = null; s.phase = 'AFTER_MOVE'; s.markerPos = spaceId
    return s
  }

  it('马拉松 #17 二选组和 #18 组合在公开代表齐全时薄利也会尝试开单', () => {
    for (const spaceId of [17, 18]) {
      let opened = 0
      for (let seed = 1; seed <= 30; seed++) {
        const s = thinDeal(spaceId, seed)
        expect(estimateDeal(s, 3, s.board[spaceId - 1]).feasible).toBe(true)
        const a = heuristicAction(s)!
        expect(isLegal(s, a)).toBe(true)
        if (a.type === 'OPEN_DEAL') opened++
      }
      expect(opened).toBeGreaterThan(15)
      expect(opened).toBeLessThan(30)
    }
  })

  it('开单有真实取舍时 critical；公开缺代表时 trivial；掷骰唯一动作仍 trivial', () => {
    const s = thinDeal(17, 3)
    const legal = getLegalActions(s, 3)
    expect(decisionTier(s, 3, legal, { type: 'DRAW_CARDS', playerId: 3 })).toBe('critical')
    setInvestors(s, { C: 3 })
    expect(decisionTier(s, 3, getLegalActions(s, 3), heuristicAction(s))).toBe('trivial')
    expect(decisionTier(s, 3, [{ type: 'ROLL_MOVE', playerId: 3 }], null)).toBe('trivial')
    setInvestors(s, { A: 3, B: 3 })
    expect(decisionTier(s, 3, getLegalActions(s, 3), heuristicAction(s))).toBe('trivial')
  })

  it('critical 配置会为可行开单请求模型，缺代表局面保持本地判断', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"choice":1}' } }] }), text: async () => '' }))
    vi.stubGlobal('fetch', fetcher)
    const policy = createAiPolicy({ getConfig: () => ({ ...DEFAULT_LLM_CONFIG, enabled: true, apiKey: 'k', decisionScope: 'critical' }) })
    const s = thinDeal(17, 3)
    expect(await policy.decide(s, new AbortController().signal)).toBeTruthy()
    expect(fetcher).toHaveBeenCalledTimes(1)
    setInvestors(s, { C: 3 })
    await policy.decide(s, new AbortController().signal)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('起始玩家秘密家族卡不同、牌数相同，放标记动作完全相同', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const a = baseState(4, seed)
      const starter = a.currentId
      clearHand(a, starter)
      const b = structuredClone(a)
      giveCards(a, starter, [{ type: 'CLAN', familyId: 'A' }])
      giveCards(b, starter, [{ type: 'CLAN', familyId: 'F' }])
      expect(getActingPlayerId(a)).not.toBe(starter)
      expect(heuristicAction(a)).toEqual(heuristicAction(b))
    }
  })
})

describe('模型的重复空转保护', () => {
  it('换牌和兑换是公开实质行动，随后首次等待不能被其附带台词误判为空转', () => {
    let swapped = expensiveDeal(9)
    swapped.houseRules = true
    const [clan] = giveCards(swapped, 0, [{ type: 'CLAN', familyId: 'A' }])
    swapped = step(swapped, { type: 'SWAP_CARD', playerId: 0, cardId: clan.id, say: '换张票' })
    expect(swapped.events.at(-1)?.kind).toBe('CARD_SWAPPED')
    expect(alreadyWaited(swapped, 0)).toBe(false)

    let traded = expensiveDeal(9)
    traded.houseRules = true
    traded.players[0].cash = 20
    const pair = giveCards(traded, 0, [{ type: 'CLAN', familyId: 'A' }, { type: 'TRAVEL', familyId: 'A' }])
    traded = step(traded, { type: 'TRADE_CARDS', playerId: 0, cardIds: pair.map(c => c.id), say: '换成招募' })
    expect(traded.events.at(-1)?.kind).toBe('CARDS_TRADED')
    expect(alreadyWaited(traded, 0)).toBe(false)
  })

  it('阻止牌消耗后的公开局面允许重新考虑，不把附带台词算成空转', () => {
    let s = baseState(4, 4)
    for (const p of s.players) clearHand(s, p.id)
    setInvestors(s, { A: 0, B: 1 })
    const [travel] = giveCards(s, 1, [{ type: 'TRAVEL', familyId: 'A' }])
    s = openDealAt(s, 1, 0)
    s = step(s, { type: 'PLAY_TRAVEL', playerId: 1, cardId: travel.id, targetRepKey: 'INV:A' })
    const reactor = getActingPlayerId(s)
    giveCards(s, reactor, [{ type: 'STOP' }])
    s = step(s, { type: 'PLAY_STOP', playerId: reactor, say: '这张我阻止' })
    expect(s.events.at(-1)?.kind).toBe('STOP_PLAYED')
    expect(alreadyWaited(s, reactor)).toBe(false)
  })

  it('模型每次都回复 PASS，真实策略运行仍会还价并在僵局中结束', async () => {
    let s = expensiveDeal(9)
    const fetcher = vi.fn(async () => {
      const legal = getLegalActions(s, 0)
      const choice = legal.findIndex(a => a.type === 'PASS') + 1
      expect(choice).toBeGreaterThan(0)
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ choice, speech: '再等等' }) } }] }), text: async () => '' }
    })
    vi.stubGlobal('fetch', fetcher)
    const policy = createAiPolicy({ getConfig: () => ({ ...DEFAULT_LLM_CONFIG, enabled: true, apiKey: 'k' }) })
    let turns = 0
    let proposed = 0
    while (s.negotiation && turns++ < 45) {
      const playerId = getActingPlayerId(s)
      let action: PlayerAction
      if (s.phase === 'OFFER_RESPONSE') action = { type: 'DECLINE_OFFER', playerId, quotes: [{ amount: [0, 5, 4, 3][playerId] }] }
      else if (playerId === 0) action = (await policy.decide(s, new AbortController().signal))!
      else action = { type: 'PASS', playerId }
      if (action.type === 'PROPOSE_OFFER') proposed++
      s = step(s, action)
    }
    expect(fetcher).toHaveBeenCalled()
    expect(proposed).toBeGreaterThan(0)
    expect(turns).toBeLessThan(45)
    expect(s.negotiation).toBeNull()
  })

  it('首次等待被保留，同一公开局面再次跳过改为合法实质提案', () => {
    let s = expensiveDeal()
    const pass: PlayerAction = { type: 'PASS', playerId: 0 }
    expect(ensureNegotiationProgress(s, pass, heuristicAction(s)!)).toEqual(pass)
    s = toBoss(step(s, pass))
    expect(alreadyWaited(s, 0)).toBe(true)
    const action = ensureNegotiationProgress(s, pass, heuristicAction(s)!)
    expect(action.type).toBe('PROPOSE_OFFER')
    expect(isLegal(s, action)).toBe(true)
  })

  it('重复同价喊话安静跳过，真实改价保持模型决定', () => {
    let s = expensiveDeal()
    s = step(s, { type: 'PASS', playerId: 0 })
    const unchanged: PlayerAction = { type: 'SPEAK', playerId: 1, say: '还是五百万', quotes: [{ familyId: 'B', amount: 5 }] }
    const pass: PlayerAction = { type: 'PASS', playerId: 1 }
    s = toBoss(step(s, unchanged))
    s = step(s, { type: 'PASS', playerId: 0 })
    expect(ensureNegotiationProgress(s, unchanged, pass)).toEqual(pass)
    const changed: PlayerAction = { ...unchanged, quotes: [{ familyId: 'B', amount: 4 }] }
    expect(ensureNegotiationProgress(s, changed, pass)).toEqual(changed)
  })

  it('旧交易的喊话不构成本笔等待记录，新公开价格也允许重新考虑', () => {
    let s = expensiveDeal()
    s.events.unshift({ id: -2, dealNo: 0, kind: 'SPEECH', playerId: 0, text: '旧单' })
    expect(currentDealEvents(s).every(e => e.dealNo !== 0)).toBe(true)
    expect(alreadyWaited(s, 0)).toBe(false)
    s = step(s, { type: 'PASS', playerId: 0 })
    s = step(s, { type: 'SPEAK', playerId: 1, say: '降价', quotes: [{ familyId: 'B', amount: 4 }] })
    s = toBoss(s)
    expect(alreadyWaited(s, 0)).toBe(false)
  })
})
