import { describe, expect, it } from 'vitest'
import type { FamilyId, GameState } from '../src/engine/types'
import { MAX_SPEECHES_PER_PLAYER } from '../src/engine/config'
import { SAVE_VERSION } from '../src/engine/gameEngine'
import { getActingPlayerId, getLegalActions } from '../src/engine/validator'
import { demandOf, investorRepKey } from '../src/engine/rules'
import { migrateState } from '../src/utils/saveMigrations'
import { GameSaveStore, type StorageLike } from '../src/utils/storage'
import { createGame } from '../src/game/replay'
import { baseState, clearHand, eventsOf, giveCards, openDealAt, rejects, setInvestors, step, toBoss } from './helpers'

const idleRound = (s: GameState) => {
  for (let i = 0; i < s.players.length; i++) s = step(s, { type: 'PASS', playerId: getActingPlayerId(s) })
  return s
}

describe('谈判以实质进展收敛', () => {
  it('日志复现：#8 的 $12M 原价重复两轮后流局，同价重报不再重置 1/2', () => {
    let s = baseState(4, 5, 'marathon')
    setInvestors(s, { A: 0, B: 1, C: 2, D: 3 })
    s = openDealAt(s, 8, 0)
    const asks: Array<{ playerId: number; familyId: FamilyId; amount: number }> = [
      { playerId: 1, familyId: 'B', amount: 5 },
      { playerId: 2, familyId: 'C', amount: 4 },
      { playerId: 3, familyId: 'D', amount: 3 },
    ]
    const quoteRound = () => {
      for (const { playerId, familyId, amount } of asks) {
        s = step(s, { type: 'SPEAK', playerId, say: `${familyId} 仍然 ${amount}，一分不让`, quotes: [{ familyId, amount }] })
      }
      s = step(s, { type: 'SPEAK', playerId: 0, say: '谁先松口，我再考虑怎么凑' })
    }
    quoteRound()
    expect(s.negotiation!.demands).toHaveLength(3)
    quoteRound()
    expect(s.negotiation!.stalemateRounds).toBe(1)
    expect(eventsOf(s, 'DEMAND')).toHaveLength(3)
    quoteRound()
    expect(s.phase).toBe('TURN')
    expect(s.dealHistory[0]).toMatchObject({ spaceId: 8, success: false, failReason: 'STALEMATE' })
    expect(s.markerPos).toBe(8)
    expect(s.currentId).toBe(1)
    expect(s.players.every(p => p.cash === 0)).toBe(true)
    expect(eventsOf(s, 'STALEMATE_ROUND')).toHaveLength(1)
    expect(eventsOf(s, 'DEMAND')).toHaveLength(3)
  })

  it('换措辞不延长没有报价 / 出牌 / 提案的等待；每人首次纯喊话仍正常刷新', () => {
    let s = openDealAt(baseState(3, 6), 14, 0)
    for (let i = 0; i < 3; i++) s = step(s, { type: 'SPEAK', playerId: getActingPlayerId(s), say: '先想想' })
    expect(s.negotiation!.stalemateRounds).toBe(0)
    for (let i = 0; i < 6; i++) {
      s = step(s, { type: 'SPEAK', playerId: getActingPlayerId(s), say: `我换个说法再等等 ${i}` })
      if (i === 2) expect(s.negotiation!.stalemateRounds).toBe(1)
    }
    expect(s.dealHistory[0].failReason).toBe('STALEMATE')
  })

  it('真实改价刷新已满的一轮及部分第二轮，通用价同价重报不刷新', () => {
    let s = baseState(4, 7)
    setInvestors(s, { A: 0, B: 1, C: 2, D: 3 })
    s = openDealAt(s, 1, 0)
    s = step(s, { type: 'SPEAK', playerId: 1, say: 'B 4', quotes: [{ familyId: 'B', amount: 4 }] })
    for (const playerId of [2, 3, 0, 1, 2, 3, 0]) s = step(s, { type: 'PASS', playerId })
    expect(s.negotiation).toMatchObject({ stalemateRounds: 1, passStreak: 3 })
    s = step(s, { type: 'SPEAK', playerId: 1, say: 'B 3，可以让一块', quotes: [{ amount: 3 }] })
    expect(s.negotiation).toMatchObject({ stalemateRounds: 0, passStreak: 0 })
    expect(demandOf(s.negotiation!, 1, 'B')).toBe(3)
    for (const playerId of [2, 3, 0]) s = step(s, { type: 'PASS', playerId })
    s = step(s, { type: 'SPEAK', playerId: 1, say: '还是 B 3', quotes: [{ familyId: 'B', amount: 3 }] })
    expect(s.negotiation).toMatchObject({ stalemateRounds: 1, passStreak: 0 })
    expect(eventsOf(s, 'DEMAND')).toHaveLength(2)
  })

  it('不涉及代表的封口费也按实际改价判进展', () => {
    let s = baseState(4, 8)
    setInvestors(s, { A: 0, B: 0, C: 1, D: 2 })
    s = openDealAt(s, 1, 0)
    s = step(s, { type: 'SPEAK', playerId: 1, say: '给 1 我就不搅局', quotes: [{ amount: 1 }] })
    s = idleRound(s)
    expect(s.negotiation!.stalemateRounds).toBe(1)
    s = step(s, { type: 'PASS', playerId: 2 })
    s = step(s, { type: 'PASS', playerId: 3 })
    s = step(s, { type: 'PASS', playerId: 0 })
    s = step(s, { type: 'SPEAK', playerId: 1, say: '还是给 1 我就不搅局', quotes: [{ amount: 1 }] })
    expect(s.dealHistory[0].failReason).toBe('STALEMATE')
    expect(eventsOf(s, 'DEMAND')).toHaveLength(1)
  })

  it('喊话限额耗尽后，PASS 台词不能公开发言或改写当前正式喊话', () => {
    let s = baseState(3, 9)
    setInvestors(s, { A: 0, B: 1, C: 2, D: 0, E: 1, F: 2 })
    s = openDealAt(s, 14, 0)
    for (let i = 0; i < MAX_SPEECHES_PER_PLAYER; i++) {
      s = step(s, { type: 'SPEAK', playerId: 1, say: `承诺价 ${i + 1}`, quotes: [{ amount: i + 1 }] })
      s = step(s, { type: 'PASS', playerId: 2 })
      s = step(s, { type: 'PASS', playerId: 0 })
    }
    rejects(s, { type: 'SPEAK', playerId: 1, say: '第五次喊话' })
    const speeches = structuredClone(s.negotiation!.speeches)
    const lastSpeech = s.players[1].lastSpeech
    const eventCount = eventsOf(s, 'SPEECH').length
    s = step(s, { type: 'PASS', playerId: 1, say: '我用跳过再喊一次价' })
    expect(s.negotiation!.speeches).toEqual(speeches)
    expect(s.players[1].lastSpeech).toBe(lastSpeech)
    expect(eventsOf(s, 'SPEECH')).toHaveLength(eventCount)
    expect(getLegalActions(s, 2).some(a => a.type === 'PASS')).toBe(true)
  })

  it('缺代表时，首次喊话以后的一轮重复喊话即流局', () => {
    let s = baseState(3, 10)
    setInvestors(s, { A: 0 })
    s = openDealAt(s, 1, 0)
    for (let i = 0; i < 3; i++) s = step(s, { type: 'SPEAK', playerId: getActingPlayerId(s), say: '我在考虑是否补位' })
    for (let i = 0; i < 3; i++) s = step(s, { type: 'SPEAK', playerId: getActingPlayerId(s), say: '我继续考虑' })
    expect(s.dealHistory[0]).toMatchObject({ failReason: 'INCOMPLETE', success: false })
  })

  it('换牌 / 出牌仍会刷新部分轮计数，不会因之前的跳过提前流局', () => {
    let s = baseState(4, 11, 'full', true)
    setInvestors(s, { A: 0, B: 1, C: 2, D: 3 })
    clearHand(s, 1)
    const [clan] = giveCards(s, 1, [{ type: 'CLAN', familyId: 'B' }])
    s = openDealAt(s, 1, 0)
    s = idleRound(s)
    s = step(s, { type: 'SWAP_CARD', playerId: 1, cardId: clan.id })
    expect(s.negotiation).toMatchObject({ stalemateRounds: 0, passStreak: 0 })
    s = idleRound(s)
    expect(s.phase).toBe('NEGOTIATION')
    expect(s.negotiation!.stalemateRounds).toBe(1)
    const travel = s.players[1].hand.find(c => c.type === 'TRAVEL' && c.familyId === 'B')!
    s = step(s, { type: 'PLAY_TRAVEL', playerId: 1, cardId: travel.id, targetRepKey: investorRepKey('B') })
    expect(s.negotiation).toMatchObject({ stalemateRounds: 0, passStreak: 0 })
  })

  it('成交倒计时放行的 say 也不污染已谈妥的台词', () => {
    let s = baseState(4, 12)
    setInvestors(s, { A: 0, B: 0, C: 1, D: 2 })
    s = toBoss(openDealAt(s, 1, 0))
    s = step(s, { type: 'CLOSE_DEAL', playerId: 0, say: '成交倒计时' })
    const before = structuredClone(s.negotiation!.speeches)
    s = step(s, { type: 'PASS_CLOSING', playerId: 1, say: '再给我三百万' })
    expect(s.negotiation!.speeches).toEqual(before)
    expect(s.players[1].lastSpeech).toBeUndefined()
    expect(eventsOf(s, 'SPEECH')).toHaveLength(1)
  })
})

describe('笔记作用域与 v10 续局兼容', () => {
  it('引擎自动注明 note 的交易 / 格子 / 阶段，流局后再记笔记不会沿用旧交易编号', () => {
    let s = baseState(4, 13)
    setInvestors(s, { A: 0, B: 0, C: 1, D: 2 })
    s = openDealAt(s, 1, 0)
    s = step(s, { type: 'PASS', playerId: 1, note: '这笔报价是四百万' })
    expect(s.players[1].notes.at(-1)).toEqual({ text: '这笔报价是四百万', dealNo: 1, spaceId: 1, phase: 'NEGOTIATION' })
    s = toBoss(s)
    s = step(s, { type: 'ABANDON_DEAL', playerId: 0 })
    s = step(s, { type: 'ROLL_MOVE', playerId: 1, note: '接下来考察新格子' })
    expect(s.players[1].notes.at(-1)).toEqual({ text: '接下来考察新格子', dealNo: null, spaceId: 1, phase: 'TURN' })
    s = step(s, { type: 'OPEN_DEAL', playerId: 1 })
    s = step(s, { type: 'PASS', playerId: 2, note: '这里开始一笔新谈判' })
    expect(s.players[2].notes.at(-1)).toMatchObject({ text: '这里开始一笔新谈判', dealNo: 2, spaceId: s.markerPos, phase: 'NEGOTIATION' })
  })

  it('v10 现有局面可继续玩，保留钱 / 牌 / 报价 / 历史；不确认旧笔记作用域或旧喊话', () => {
    let s = baseState(4, 14)
    setInvestors(s, { A: 0, B: 1, C: 2, D: 3 })
    s = openDealAt(s, 1, 0)
    s = step(s, { type: 'SPEAK', playerId: 1, say: 'B 四百万', quotes: [{ familyId: 'B', amount: 4 }] })
    const old = JSON.parse(JSON.stringify(s))
    old.saveVersion = 10
    old.players[1].notes = ['老价四百万，旧存档没有注明哪一笔']
    old.players[2].lastSpeech = '旧 PASS 里的四百万'
    old.negotiation.speeches.push({ id: old.nextId++, playerId: 2, text: '旧 PASS 里的四百万' })
    const result = migrateState(old)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('迁移失败')
    expect(result.migrated).toBe(true)
    expect(result.keepsReplay).toBe(false)
    expect(result.state.saveVersion).toBe(SAVE_VERSION)
    expect(result.state.investors).toEqual(s.investors)
    expect(result.state.players.map(p => [p.cash, p.hand])).toEqual(s.players.map(p => [p.cash, p.hand]))
    expect(result.state.negotiation!.demands).toEqual(s.negotiation!.demands)
    expect(result.state.events).toEqual(s.events)
    expect(result.state.players[1].notes).toEqual([{ text: '老价四百万，旧存档没有注明哪一笔', dealNo: null, spaceId: null, phase: null }])
    expect(result.state.players.every(p => p.lastSpeech == null)).toBe(true)
    expect(result.state.negotiation!.speeches).toEqual([])
    const continued = step(result.state, { type: 'PASS', playerId: 2 })
    expect(continued.phase).toBe('NEGOTIATION')
    expect(continued.negotiation!.demands).toEqual(s.negotiation!.demands)
  })

  it('分块 v10 存档的旧动作日志被降级，旧日志块移除，迁移后的谈判可继续', () => {
    const data = new Map<string, string>()
    const mem: StorageLike = {
      getItem: key => data.get(key) ?? null,
      setItem: (key, value) => { data.set(key, value) },
      removeItem: key => { data.delete(key) },
    }
    const { origin, state } = createGame({ playerCount: 4, humanName: '你', seed: 15 })
    setInvestors(state, { A: 0, B: 1, C: 2, D: 3 })
    const current = openDealAt(state, 1, 0)
    const old = JSON.parse(JSON.stringify(current))
    old.saveVersion = 10
    data.set('im-the-boss:save:head', JSON.stringify({ storageFormat: 2, state: old, origin, replayable: true, logLength: 1, chunkSize: 100 }))
    data.set('im-the-boss:save:log:0', JSON.stringify([{ action: { type: 'PASS', playerId: 1, say: '旧格式台词' } }]))
    const loaded = new GameSaveStore(mem).load()!
    expect(loaded).not.toBeNull()
    expect(loaded.replayable).toBe(false)
    expect(loaded.origin).toBeNull()
    expect(loaded.log).toEqual([])
    expect(data.has('im-the-boss:save:log:0')).toBe(false)
    expect(loaded.state.saveVersion).toBe(SAVE_VERSION)
    const continued = step(loaded.state, { type: 'SPEAK', playerId: 1, say: 'B 改为三百万', quotes: [{ familyId: 'B', amount: 3 }] })
    expect(demandOf(continued.negotiation!, 1, 'B')).toBe(3)
  })
})
