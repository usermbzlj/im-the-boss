import { describe, expect, it } from 'vitest'
import type { GameState } from '../src/engine/types'
import { SAVE_VERSION } from '../src/engine/gameEngine'
import { commitmentPrice, demandOf, investorRepKey, repCost } from '../src/engine/rules'
import { getActingPlayerId, getLegalActions } from '../src/engine/validator'
import { createGame } from '../src/game/replay'
import { migrateState } from '../src/utils/saveMigrations'
import { GameSaveStore, type StorageLike } from '../src/utils/storage'
import { baseState, clearHand, eventsOf, giveCards, openDealAt, rejects, setInvestors, step, toBoss } from './helpers'

function scene() {
  const s = baseState(4, 16)
  setInvestors(s, { A: 0, B: 1, C: 2, D: 3 })
  for (const p of s.players) clearHand(s, p.id)
  return s
}

/** 1 号已承诺 B4、2 号索封口费1；0 号说完组织意图后轮到1号。 */
function beforeTakeover(s: GameState): GameState {
  s = openDealAt(s, 1, 0)
  s = step(s, { type: 'SPEAK', playerId: 1, say: 'B 四百万出借', quotes: [{ familyId: 'B', amount: 4 }] })
  s = step(s, { type: 'SPEAK', playerId: 2, say: '给一百万就不搅局', quotes: [{ amount: 1 }] })
  s = step(s, { type: 'PASS', playerId: 3 })
  return step(s, { type: 'SPEAK', playerId: 0, say: 'B 请让到三百万，我再提方案' })
}

describe('Boss 的报价角色边界', () => {
  it('Boss 有代表也不能给自己报出借价或通用价；无报价喊话仍可合法谈判', () => {
    let s = toBoss(openDealAt(scene(), 1, 0))
    rejects(s, { type: 'SPEAK', playerId: 0, say: 'A 四百万出借', quotes: [{ familyId: 'A', amount: 4 }] })
    rejects(s, { type: 'SPEAK', playerId: 0, say: '我的净得要四百万', quotes: [{ amount: 4 }] })
    rejects(s, { type: 'SPEAK', playerId: 0, say: '我的代表免费', quotes: [{ familyId: 'A', amount: 0 }] })
    expect(getLegalActions(s, 0).some(a => a.type === 'SPEAK')).toBe(true)
    s = step(s, { type: 'SPEAK', playerId: 0, say: 'B 让到三百万，我保留三百万' })
    expect(s.negotiation!.demands).toEqual([])
    expect(eventsOf(s, 'DEMAND')).toHaveLength(0)
    expect(eventsOf(s, 'SPEECH').at(-1)).toMatchObject({ playerId: 0, text: 'B 让到三百万，我保留三百万' })
    for (const playerId of [1, 2, 3]) s = step(s, { type: 'PASS', playerId })
    s = step(s, { type: 'SPEAK', playerId: 0, say: '我在等新的分配意向', quotes: [] })
    expect(s.phase).toBe('NEGOTIATION')
    expect(s.negotiation!.demands).toEqual([])
  })

  it('Boss 没有所需代表时也不能索封口费，非 Boss 的出借价和封口费仍有效', () => {
    const initial = scene()
    setInvestors(initial, { A: 1, B: 2, C: 0, D: 3 })
    let s = toBoss(openDealAt(initial, 1, 0))
    rejects(s, { type: 'SPEAK', playerId: 0, say: '给我四百万就不搅局', quotes: [{ amount: 4 }] })
    s = step(s, { type: 'SPEAK', playerId: 0, say: '我会给两家提出分配方案' })
    s = step(s, { type: 'SPEAK', playerId: 1, say: 'A 三百万出借', quotes: [{ familyId: 'A', amount: 3 }] })
    s = step(s, { type: 'PASS', playerId: 2 })
    s = step(s, { type: 'SPEAK', playerId: 3, say: '一百万封口费', quotes: [{ amount: 1 }] })
    expect(demandOf(s.negotiation!, 1, 'A')).toBe(3)
    expect(demandOf(s.negotiation!, 3)).toBe(1)
    expect(s.negotiation!.demands.some(d => d.playerId === 0)).toBe(false)
  })

  it('Boss 打家族卡不能附带自己的出借价，正常补位仍合法且自己的代表成本为零', () => {
    const initial = scene()
    const [clan] = giveCards(initial, 0, [{ type: 'CLAN', familyId: 'B' }])
    let s = toBoss(openDealAt(initial, 1, 0))
    rejects(s, { type: 'PLAY_CLAN', playerId: 0, cardId: clan.id, demand: 4 })
    rejects(s, { type: 'PLAY_CLAN', playerId: 0, cardId: clan.id, demand: 0 })
    s = step(s, { type: 'PLAY_CLAN', playerId: 0, cardId: clan.id, say: '我自己补上 B，不再付外人的价' })
    const rep = s.negotiation!.reps.find(r => r.cardId === clan.id)!
    expect(repCost(s, rep)).toBe(0)
    expect(s.negotiation!.demands).toEqual([])
    expect(eventsOf(s, 'DEMAND')).toHaveLength(0)
    expect(getLegalActions(s, 0).some(a => a.type === 'CLOSE_DEAL')).toBe(true)
  })

  it('成功夺权只清新 Boss 的旧承诺；其他人的价保留，旧价不会在再次失去 Boss 后复活', () => {
    const initial = scene()
    const [boss1] = giveCards(initial, 1, [{ type: 'BOSS' }])
    const [boss2] = giveCards(initial, 2, [{ type: 'BOSS' }])
    let s = beforeTakeover(initial)
    s = step(s, { type: 'PLAY_BOSS', playerId: 1, cardId: boss1.id })
    for (const playerId of [2, 3, 0]) s = step(s, { type: 'PASS_REACTION', playerId })
    expect(s.negotiation!.bossId).toBe(1)
    expect(demandOf(s.negotiation!, 1, 'B')).toBeUndefined()
    expect(demandOf(s.negotiation!, 2)).toBe(1)
    rejects(s, { type: 'SPEAK', playerId: 1, say: 'B 还是四百万出借', quotes: [{ familyId: 'B', amount: 4 }] })
    s = step(s, { type: 'PASS', playerId: 1 })
    s = step(s, { type: 'PASS', playerId: 2 })
    s = step(s, { type: 'PASS', playerId: 3 })
    s = step(s, { type: 'SPEAK', playerId: 0, say: '我现在出借 A，两百万', quotes: [{ familyId: 'A', amount: 2 }] })
    s = step(s, { type: 'PASS', playerId: 1 })
    s = step(s, { type: 'PLAY_BOSS', playerId: 2, cardId: boss2.id })
    for (const playerId of [3, 0, 1]) s = step(s, { type: 'PASS_REACTION', playerId })
    expect(s.negotiation!.bossId).toBe(2)
    expect(demandOf(s.negotiation!, 2)).toBeUndefined()
    expect(demandOf(s.negotiation!, 0, 'A')).toBe(2)
    expect(demandOf(s.negotiation!, 1, 'B')).toBeUndefined()
    const repKeys = [investorRepKey('A'), investorRepKey('B')]
    expect(commitmentPrice(s.negotiation!, { repKeys }, 1)).toBeUndefined()
    s = step(s, { type: 'PROPOSE_OFFER', playerId: 2, repKeys, payouts: [{ playerId: 0, amount: 2 }] })
    expect(s.negotiation!.offer!.responses[0]).toBe('ACCEPTED')
    expect(s.negotiation!.responseQueue).toEqual([1])
    expect(getActingPlayerId(s)).toBe(1)
  })

  it('夺权被阻止时身份不变，出借承诺价与其他报价都不会被清除', () => {
    const initial = scene()
    const [boss] = giveCards(initial, 1, [{ type: 'BOSS' }])
    giveCards(initial, 2, [{ type: 'STOP' }])
    let s = beforeTakeover(initial)
    const demands = structuredClone(s.negotiation!.demands)
    s = step(s, { type: 'PLAY_BOSS', playerId: 1, cardId: boss.id })
    s = step(s, { type: 'PLAY_STOP', playerId: 2 })
    expect(s.negotiation!.bossId).toBe(0)
    expect(s.negotiation!.demands).toEqual(demands)
    expect(demandOf(s.negotiation!, 1, 'B')).toBe(4)
    expect(eventsOf(s, 'BOSS_RESOLVED')).toHaveLength(0)
  })

  it('黑市不经过反应窗口的夺权同样清除新 Boss 旧报价', () => {
    const initial = baseState(4, 17, 'marathon')
    setInvestors(initial, { A: 0, B: 1, C: 2, D: 3 })
    for (const p of initial.players) clearHand(initial, p.id)
    const [boss] = giveCards(initial, 1, [{ type: 'BOSS' }])
    let s = openDealAt(initial, 8, 0)
    s = step(s, { type: 'SPEAK', playerId: 1, say: 'B 四百万', quotes: [{ familyId: 'B', amount: 4 }] })
    s = step(s, { type: 'SPEAK', playerId: 2, say: 'C 两百万', quotes: [{ familyId: 'C', amount: 2 }] })
    s = step(s, { type: 'SPEAK', playerId: 3, say: 'D 一百万', quotes: [{ familyId: 'D', amount: 1 }] })
    s = step(s, { type: 'SPEAK', playerId: 0, say: '我再考虑分配' })
    s = step(s, { type: 'PLAY_BOSS', playerId: 1, cardId: boss.id })
    expect(s.phase).toBe('NEGOTIATION')
    expect(s.negotiation!.bossId).toBe(1)
    expect(s.pendingReaction).toBeNull()
    expect(s.negotiation!.demands).toEqual([
      { playerId: 2, familyId: 'C', amount: 2 },
      { playerId: 3, familyId: 'D', amount: 1 },
    ])
  })
})

describe('v11 Boss 报价兼容迁移', () => {
  it('只清当前 Boss 的旧出借价 / 封口费，其他报价、笔记和原局面均保留，可继续谈判', () => {
    let s = beforeTakeover(scene())
    // v11 允许 Boss 发布这些不应存在的报价；迁移不能误删其他人的实际承诺。
    s.saveVersion = 11
    s.negotiation!.demands.push({ playerId: 0, familyId: 'A', amount: 4 }, { playerId: 0, amount: 4 })
    const previous = structuredClone(s)
    const result = migrateState(s)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('v11 应可迁移')
    expect(result.state.saveVersion).toBe(SAVE_VERSION)
    expect(result.keepsReplay).toBe(false)
    expect(result.state.negotiation!.demands).toEqual(previous.negotiation!.demands.filter(d => d.playerId !== 0))
    expect(result.state.players).toEqual(previous.players)
    expect(result.state.board).toEqual(previous.board)
    expect(result.state.investors).toEqual(previous.investors)
    expect(result.state.events).toEqual(previous.events)
    expect(result.state.rng).toBe(previous.rng)
    expect(result.state.nextId).toBe(previous.nextId)
    const continued = step(result.state, { type: 'SPEAK', playerId: 1, say: 'B 可以让到三百万', quotes: [{ familyId: 'B', amount: 3 }] })
    expect(demandOf(continued.negotiation!, 1, 'B')).toBe(3)
  })

  it('分块 v11 旧日志降级不可回放，保留可续玩的状态并清除历史日志块', () => {
    const data = new Map<string, string>()
    const mem: StorageLike = {
      getItem: key => data.get(key) ?? null,
      setItem: (key, value) => { data.set(key, value) },
      removeItem: key => { data.delete(key) },
    }
    const { origin, state } = createGame({ playerCount: 4, humanName: '你', seed: 18 })
    setInvestors(state, { A: 0, B: 1, C: 2, D: 3 })
    const old = toBoss(openDealAt(state, 1, 0))
    old.saveVersion = 11
    old.negotiation!.demands = [{ playerId: 0, amount: 4 }, { playerId: 1, familyId: 'B', amount: 3 }]
    data.set('im-the-boss:save:head', JSON.stringify({ storageFormat: 2, state: old, origin, replayable: true, logLength: 1, chunkSize: 100 }))
    data.set('im-the-boss:save:log:0', JSON.stringify([{ action: { type: 'SPEAK', playerId: 0, say: '封口费四百万', quotes: [{ amount: 4 }] } }]))
    const loaded = new GameSaveStore(mem).load()!
    expect(loaded.replayable).toBe(false)
    expect(loaded.origin).toBeNull()
    expect(loaded.log).toEqual([])
    expect(data.has('im-the-boss:save:log:0')).toBe(false)
    expect(loaded.state.saveVersion).toBe(SAVE_VERSION)
    expect(loaded.state.negotiation!.demands).toEqual([{ playerId: 1, familyId: 'B', amount: 3 }])
    const continued = step(loaded.state, { type: 'SPEAK', playerId: 0, say: '我会依据 B 的三百万安排方案' })
    expect(continued.phase).toBe('NEGOTIATION')
    expect(continued.negotiation!.demands).toEqual(loaded.state.negotiation!.demands)
  })
})
