import { describe, expect, it } from 'vitest'
import type { GameState, PlayerAction } from '../src/engine/types'
import { actionSpeech } from '../src/ai/speechGuard'
import { heuristicSpeech } from '../src/ai/heuristic'
import { baseState, clearHand, giveCards, openDealAt, setInvestors } from './helpers'

function negotiating(): GameState {
  const state = baseState(4, 31)
  state.players[0].name = '苏澜'; state.players[0].personaId = 'su'
  state.players[1].name = '何烬'; state.players[1].personaId = 'he'
  state.players[2].name = '周慕言'; state.players[2].personaId = 'zhou'
  state.players[3].name = '挑战者'
  setInvestors(state, { A: 0, B: 1, C: 2, D: 3 })
  state.board[0].groups = [{ families: ['A', 'B', 'C'], need: 3 }]
  state.board[0].dividends = 4 // $8M at the initial share value.
  return openDealAt(state, 1, 0)
}

const ask: PlayerAction = { type: 'SPEAK', playerId: 1, quotes: [{ familyId: 'B', amount: 3 }] }

/** Online regression: Gu is Boss, Su owns A, the human owns B; Gu lends neither family. */
function guBoss(): GameState {
  const state = baseState(4, 31)
  state.players[0].name = '顾曼宁'; state.players[0].personaId = 'gu'
  state.players[1].name = '苏澜'; state.players[1].personaId = 'su'
  state.players[2].name = '周慕言'; state.players[2].personaId = 'zhou'
  state.players[3].name = '姚老板'
  setInvestors(state, { A: 1, B: 3, C: 2 })
  state.board[0].groups = [{ families: ['A', 'B'], need: 2 }]
  state.board[0].dividends = 4
  const opened = openDealAt(state, 1, 0)
  opened.negotiation!.demands.push({ playerId: 3, familyId: 'B', amount: 4 })
  return opened
}

describe('speaker role and representative ownership', () => {
  const bossSpeech: PlayerAction = { type: 'SPEAK', playerId: 0 }
  const loan: PlayerAction = { type: 'SPEAK', playerId: 1, quotes: [{ familyId: 'A', amount: 4 }] }

  it('a Boss cannot charge their own noninterference fee, even if an old invalid demand matches', () => {
    const state = guBoss()
    state.negotiation!.demands.push({ playerId: 0, amount: 4 })
    for (const line of ['$4M，作为不干预的对价。', '四百万，换我不插手。', '给我四百万，我不干预这单。', '我的封口费：$4M。']) {
      const result = actionSpeech(state, bossSpeech, line)
      expect(result).toBeTruthy()
      expect(result).not.toBe(line)
      expect(result).not.toMatch(/封口费|不干预|不插手/)
    }
  })

  it('keeps legitimate Boss payments, counteroffers, quotes and budget discussion', () => {
    const state = guBoss()
    const lines = [
      '姚老板,赤岩集团我按$4M付到即可;苏澜,星桥的$6M不能少,价合理我就成交',
      '姚老板：赤岩集团我愿意付三百万，能否让一步？',
      '赤岩集团 $3M，星桥资本 $3M，我保留 $2M，总额 $8M。',
      '周慕言，给你两百万，作为你不干预的对价。',
      '周慕言说四百万换不干预，我建议两百万。',
      '我是顾Boss，这一笔由我主持。',
      '我不要封口费，先讨论如何凑齐这份方案。',
      '我保留两百万，不干预你们余下怎么分。',
    ]
    for (const line of lines) expect(actionSpeech(state, bossSpeech, line)).toBe(line)
  })

  it('rejects addressing oneself as the other Boss, including ASCII punctuation and case', () => {
    const state = guBoss()
    for (const line of [
      '顾Boss这单我不吃亏:赤岩集团$4M,照你方才的价,付到就成',
      '顾Boss这单我不吃亏:赤岩集团$4M,照你刚才的价,付到就成',
      '顾Boss,我的封口费是四百万。',
      '顾BOSS：赤岩集团四百万，付到就成。',
      '苏Boss，先把方案拿出来。',
      '顾律师，照你方才的价，赤岩集团四百万。',
    ]) expect(actionSpeech(state, bossSpeech, line)).not.toBe(line)
    expect(actionSpeech(state, loan, '顾Boss：我的星桥资本四百万。')).toBe('顾Boss：我的星桥资本四百万。')
    expect(actionSpeech(state, loan, '我是Boss，星桥资本四百万。')).not.toBe('我是Boss，星桥资本四百万。')
    expect(actionSpeech(state, loan, '如果我是Boss，会重新分这笔钱。')).toBe('如果我是Boss，会重新分这笔钱。')
  })

  it('uses the resulting role for taking over, while allowing an outgoing Boss to be addressed', () => {
    const state = guBoss()
    const action: PlayerAction = { type: 'PLAY_BOSS', playerId: 1, cardId: 999 }
    const line = '顾Boss，让位，这笔由我接管。我是Boss。'
    expect(actionSpeech(state, action, line)).toBe(line)
  })

  it('does not lend another family just because the price matches their prior commitment', () => {
    const state = guBoss()
    for (const line of ['赤岩集团 $4M，付到就成。', '赤岩集团:$4M;星桥资本:$4M。', 'B:$4M，A:$4M。', '我的赤岩集团，付到我就同意。', '我代表赤岩集团。']) {
      const result = actionSpeech(state, loan, line)!
      expect(result).not.toBe(line)
      expect(result).toContain('星桥资本')
      expect(result).not.toContain('赤岩集团')
    }
    expect(actionSpeech(state, loan, '星桥资本:$4M，付到即成。')).toBe('星桥资本:$4M，付到即成。')
  })

  it('keeps explicit references, counteroffers and the speaker’s actual commitment', () => {
    const state = guBoss()
    for (const line of [
      '姚老板的赤岩集团报四百万，我的星桥资本四百万。',
      '赤岩集团原价四百万，太贵；我的星桥资本四百万。',
      '赤岩集团我愿意付三百万，能否考虑；星桥资本我报四百万。',
      'B:$3M，姚老板你能不能降到这个价？A:$4M是我的报价。',
      '星桥资本旧价三百万，现在我的报价四百万。',
      '预算：A:$4M,B:$3M,Boss:$1M，总额$8M。',
    ]) expect(actionSpeech(state, loan, line)).toBe(line)
    const wrong = '我的星桥资本五百万，按你方才的价。'
    expect(actionSpeech(state, loan, wrong)).not.toBe(wrong)
  })

  it('a non-Boss spectator may discuss existing family prices while asking for a genuine bribe', () => {
    const state = guBoss()
    const action: PlayerAction = { type: 'SPEAK', playerId: 2, quotes: [{ amount: 1 }] }
    const line = '赤岩集团四百万，给我一百万，我不插手。'
    expect(actionSpeech(state, action, line)).toBe(line)
    expect(actionSpeech(state, action, '我的赤岩集团四百万，付到我就同意。')).not.toBe('我的赤岩集团四百万，付到我就同意。')
  })

  it('only resolves a surname honorific when it identifies one player', () => {
    const state = guBoss()
    state.players[3].name = '顾小明'
    const ambiguous = '顾Boss：赤岩集团我愿意付三百万，能否考虑？'
    expect(actionSpeech(state, bossSpeech, ambiguous)).toBe(ambiguous)
    const namedSelf = '顾曼宁Boss：照你方才的价，赤岩集团四百万。'
    expect(actionSpeech(state, bossSpeech, namedSelf)).not.toBe(namedSelf)
    const namedWrong = '顾小明Boss：请你提出方案。'
    expect(actionSpeech(state, bossSpeech, namedWrong)).not.toBe(namedWrong)
    const proposed: PlayerAction = { type: 'PROPOSE_OFFER', playerId: 0, repKeys: ['INV:A', 'INV:B'], payouts: [{ playerId: 1, amount: 4 }, { playerId: 3, amount: 2 }] }
    expect(actionSpeech(state, proposed, '顾总：三百万，你考虑一下。')).toBe('顾总：三百万，你考虑一下。')
    expect(actionSpeech(state, proposed, '顾小明：三百万，你考虑一下。')).not.toBe('顾小明：三百万，你考虑一下。')
    expect(actionSpeech(state, proposed, '顾小明：两百万，你考虑一下。')).toBe('顾小明：两百万，你考虑一下。')
  })

  it('permits accurate disclosure of our unplayed clan card but not lending it as a seated representative', () => {
    const state = guBoss()
    for (const player of state.players) clearHand(state, player.id)
    giveCards(state, 1, [{ type: 'CLAN', familyId: 'C' }])
    const action: PlayerAction = { type: 'SPEAK', playerId: 1 }
    for (const line of ['我有银湾基金的成员牌，下一手可以补位。', '我持有银湾基金成员卡，之后可以入场。', '我的银湾基金成员牌还在手里，下一手补位。']) {
      expect(actionSpeech(state, action, line)).toBe(line)
    }
    for (const line of ['我的银湾基金出借四百万，付到即成。', '我代表银湾基金，四百万付到我就同意。', '我有银湾基金的成员牌，银湾基金四百万，付到就成。']) {
      expect(actionSpeech(state, action, line)).not.toBe(line)
    }
    clearHand(state, 1)
    const invented = '我有银湾基金的成员牌，下一手可以补位。'
    expect(actionSpeech(state, action, invented)).not.toBe(invented)
  })
})

describe('final-action speech facts', () => {
  it.each(['PASS', 'PASS_CLOSING', 'PASS_REACTION', 'ROLL_MOVE', 'DRAW_CARDS', 'ROLL_END'] as const)('%s stays silent even with stale bargaining speech', type => {
    expect(actionSpeech(negotiating(), { type, playerId: 1 }, '银湾四百万，一分不让。')).toBeUndefined()
  })

  it('preserves an unchanged legal quote and persona expression, including Chinese amounts', () => {
    const state = negotiating()
    for (const line of ['赤岩集团 $3M，付到即成。', '三百万，少一分免谈。', '三百万元，爱用不用。', '这价我想过了，你慢慢想。']) {
      expect(actionSpeech(state, ask, line)).toBe(line)
    }
  })

  it('replaces contradictory amounts with the actual quote and repairs clamped/filtered input', () => {
    const state = negotiating()
    const result = actionSpeech(state, ask, '赤岩集团 $5M，付到即成。')!
    expect(result).not.toContain('$5M')
    expect(result).toContain('$3M')
    expect(actionSpeech(state, ask, '不让价，五百万！', true)).toBe(heuristicSpeech(state, ask))
  })

  it('allows the gross total and another player’s quoted amount alongside our own quote', () => {
    const state = negotiating()
    const line = '总额 $8M。周慕言要四百万，我的赤岩集团三百万。'
    expect(actionSpeech(state, ask, line)).toBe(line)
    expect(actionSpeech(state, ask, '总额 $12M，赤岩集团 $3M。')).not.toBe('总额 $12M，赤岩集团 $3M。')
  })

  it('checks different family quotes independently and preserves untouched commitments', () => {
    const state = negotiating()
    state.negotiation!.reps.find(r => r.familyId === 'C')!.ownerId = 1
    state.negotiation!.demands.push({ playerId: 1, familyId: 'C', amount: 1 })
    const good = '赤岩集团三百万，银湾基金一百万。'
    expect(actionSpeech(state, ask, good)).toBe(good)
    const bad = '赤岩集团一百万，银湾基金三百万。'
    expect(actionSpeech(state, ask, bad)).not.toBe(bad)
  })

  it('checks payouts by payee rather than only checking the set of numbers', () => {
    const state = negotiating()
    const action: PlayerAction = { type: 'PROPOSE_OFFER', playerId: 0, repKeys: ['INV:A', 'INV:B', 'INV:C'], payouts: [{ playerId: 1, amount: 3 }, { playerId: 2, amount: 1 }] }
    const good = '何烬三百万，周慕言一百万，我留四百万。'
    expect(actionSpeech(state, action, good)).toBe(good)
    const swapped = '何烬一百万，周慕言三百万。'
    expect(actionSpeech(state, action, swapped)).not.toBe(swapped)
    const corrected = actionSpeech(state, action, '周慕言五百万。', true)!
    expect(corrected).not.toContain('五百万')
    expect(corrected).toContain('何烬 $3M')
  })

  it('a clan card speaks its actual demand; omitted demand does not invent a commitment', () => {
    const state = negotiating()
    clearHand(state, 1)
    const [card] = giveCards(state, 1, [{ type: 'CLAN', familyId: 'B' }])
    const action: PlayerAction = { type: 'PLAY_CLAN', playerId: 1, cardId: card.id, demand: 2 }
    expect(actionSpeech(state, action, '赤岩集团两百万，我出人。')).toBe('赤岩集团两百万，我出人。')
    expect(actionSpeech(state, action, '赤岩集团五百万，我出人。')).not.toBe('赤岩集团五百万，我出人。')
    const noDemand: PlayerAction = { type: 'PLAY_CLAN', playerId: 1, cardId: card.id }
    expect(actionSpeech(state, noDemand, '赤岩集团五百万，我出人。')).not.toBe('赤岩集团五百万，我出人。')
  })

  it('uses actual capped payouts for the close after a price drop', () => {
    const state = negotiating()
    state.negotiation!.offer = { id: 999, bossId: 0, repKeys: ['INV:A', 'INV:B', 'INV:C'], payouts: [{ playerId: 1, amount: 3 }, { playerId: 2, amount: 3 }], responses: { 1: 'ACCEPTED', 2: 'ACCEPTED' } }
    state.negotiation!.priceDelta = -1 // gross $4M: 3M + 1M, Boss 0M.
    const action: PlayerAction = { type: 'CLOSE_DEAL', playerId: 0 }
    const good = '何烬三百万，周慕言一百万，我拿零百万。'
    expect(actionSpeech(state, action, good)).toBe(good)
    expect(actionSpeech(state, action, '周慕言三百万。')).not.toBe('周慕言三百万。')
  })
})

describe('speech context and repetition', () => {
  it('replaces a nonexistent roster member and honorific without rejecting a real surname', () => {
    const state = negotiating()
    for (const line of ['陆峥，出来谈谈。', '陆总，出来谈谈。', '顾律师，出来谈谈。']) {
      expect(actionSpeech(state, ask, line)).not.toBe(line)
    }
    expect(actionSpeech(state, ask, '何总，三百万。')).toBe('何总，三百万。')
    state.players[3].name = '陆小明'
    expect(actionSpeech(state, ask, '陆总，三百万。')).toBe('陆总，三百万。')
  })

  it('replaces a public completeness error but permits a claim about our own coverage', () => {
    const state = negotiating()
    const bad = '这一格桌上凑不齐三家，先等等。'
    expect(actionSpeech(state, ask, bad)).not.toBe(bad)
    expect(actionSpeech(state, ask, '这格我凑不齐，只能找各位帮忙。')).toBe('这格我凑不齐，只能找各位帮忙。')
    state.negotiation!.reps.find(r => r.familyId === 'C')!.travelled = true
    expect(actionSpeech(state, ask, bad)).toBe(bad)
  })

  it('only uses public investors before a deal; hidden opponents’ hands do not affect the guard', () => {
    const state = baseState(4, 31)
    state.phase = 'TURN'; state.markerChooserId = null; state.markerPos = 1
    setInvestors(state, { A: 0 })
    for (const p of state.players) clearHand(state, p.id)
    const action: PlayerAction = { type: 'OPEN_DEAL', playerId: 0 }
    const line = '这格桌上凑不齐，我先开单找人。'
    const original = actionSpeech(state, action, line)
    giveCards(state, 1, [{ type: 'CLAN', familyId: 'B' }])
    expect(actionSpeech(state, action, line)).toBe(original)
    setInvestors(state, { A: 0, B: 1 })
    expect(actionSpeech(state, action, line)).not.toBe(line)
  })

  it('avoids our repeated sentence and the latest opponent’s sentence deterministically', () => {
    const state = negotiating()
    state.negotiation!.speeches.push({ id: 999, playerId: 1, text: '三百万，付到就成。' })
    const repeated = '三百万, 付到就成!'
    const first = actionSpeech(state, ask, repeated)
    expect(first).not.toBe(repeated)
    expect(actionSpeech(state, ask, repeated)).toBe(first)
    state.negotiation!.speeches.push({ id: 1000, playerId: 2, text: '你慢慢想，我不急。' })
    expect(actionSpeech(state, ask, '你慢慢想，我不急。')).not.toBe('你慢慢想，我不急。')
    expect(actionSpeech(state, ask, '这个价我不让，你可以换别人。')).toBe('这个价我不让，你可以换别人。')
  })

  it('keeps SPEAK nonempty even when its heuristic fallback was just repeated', () => {
    const state = negotiating()
    const fallback = heuristicSpeech(state, ask)
    state.negotiation!.speeches.push({ id: 999, playerId: 1, text: fallback })
    expect(actionSpeech(state, ask, fallback)).toBeTruthy()
    expect(actionSpeech(state, ask, fallback)).not.toBe(fallback)
  })
})
