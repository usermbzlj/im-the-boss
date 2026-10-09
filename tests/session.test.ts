// GameSession 运行时：自动驱动电脑玩家、兜底非法策略、人类回合等待、销毁即停

import { describe, it, expect } from 'vitest'
import { GameSession } from '../src/game/session'
import { heuristicPolicy } from '../src/ai/heuristic'
import { withFallback, type Policy } from '../src/ai/policy'
import { getActingPlayerId } from '../src/engine/validator'
import { createInitialState } from '../src/engine/gameEngine'
import { checkInvariants } from '../src/sim/harness'
import { baseState, giveCards, setInvestors, openDealAt, clearHand } from './helpers'
import { investorRepKey } from '../src/engine/rules'
import { createGame, checkReplay, type ActionLogEntry } from '../src/game/replay'

const tick = () => new Promise<void>(r => setTimeout(r, 0))

describe('GameSession', () => {
  it('全员电脑：从开局自动跑到结束，全程不变量成立，每步 stateVersion 递增', async () => {
    const initial = baseState(4, 100)
    const problems: string[] = []
    let lastVersion = initial.stateVersion
    const session = new GameSession(initial, {
      policy: heuristicPolicy,
      delay: () => 0,
      onChange: s => {
        const bad = checkInvariants(s)
        if (bad) problems.push(bad)
        if (s.stateVersion !== lastVersion + 1) problems.push(`stateVersion 跳变 ${lastVersion} → ${s.stateVersion}`)
        lastVersion = s.stateVersion
      },
      onError: m => problems.push(m),
    })
    const final = await session.runUntil()
    session.destroy()
    expect(final.phase).toBe('GAME_OVER')
    expect(problems).toEqual([])
    expect(final.completedDeals).toBeGreaterThanOrEqual(10)
  })

  it('人类回合：运行时停下等待；人类动作通过 dispatch 进入后电脑继续', async () => {
    const initial = createInitialState(3, '我', 101) // 玩家 0 是人类
    const session = new GameSession(initial, { policy: heuristicPolicy, delay: () => 0 })
    const s1 = await session.runUntil(s => !s.players[getActingPlayerId(s)].isAI)
    expect(s1.players[getActingPlayerId(s1)].isAI).toBe(false)
    const v = s1.stateVersion
    await tick(); await tick()
    expect(session.state.stateVersion).toBe(v) // 没有人类输入就不会推进
    const legalPhase = session.state.phase
    if (legalPhase === 'PLACE_MARKER') {
      expect(session.dispatch({ type: 'PLACE_MARKER', playerId: 0, spaceId: 3 })).toBe(true)
    } else if (legalPhase === 'TURN') {
      expect(session.dispatch({ type: 'ROLL_MOVE', playerId: 0 })).toBe(true)
    }
    expect(session.dispatch({ type: 'PASS', playerId: 1 })).toBe(false) // 非法动作被拒绝
    session.destroy()
  })

  it('策略返回非法动作或抛异常 → 上报并改用兜底策略，游戏照常推进', async () => {
    const initial = baseState(4, 102)
    const errors: string[] = []
    let calls = 0
    const flaky: Policy = {
      name: 'flaky',
      async decide(state) {
        calls++
        if (calls % 3 === 0) throw new Error('boom')
        if (calls % 3 === 1) return { type: 'ROLL_END', playerId: getActingPlayerId(state) } // 几乎总是非法
        return heuristicPolicy.decide(state, new AbortController().signal)
      },
    }
    const session = new GameSession(initial, {
      policy: withFallback(flaky, heuristicPolicy, m => errors.push(m)),
      delay: () => 0,
      onError: m => errors.push(m),
    })
    const final = await session.runUntil(s => s.completedDeals >= 3)
    session.destroy()
    expect(final.completedDeals).toBeGreaterThanOrEqual(3)
    expect(errors.length).toBeGreaterThan(0)
    expect(checkInvariants(final)).toBeNull()
  })

  it('反应窗口里没有阻止牌的人类会自动放行；有阻止牌则等待', async () => {
    let s = baseState(4, 103)
    s.players[3].isAI = false
    for (let i = 0; i < 4; i++) clearHand(s, i)
    setInvestors(s, { A: 0, B: 1, C: 2, D: 3 })
    const [travel] = giveCards(s, 2, [{ type: 'TRAVEL' }])
    s = openDealAt(s, 1, 0)
    s.negotiation!.turnId = 2
    const held: Policy = { name: 'hold', decide: () => new Promise(() => {}) } // 电脑永远不决策
    const session = new GameSession(s, { policy: held, delay: () => 0 })
    expect(session.dispatch({ type: 'PLAY_TRAVEL', playerId: 2, cardId: travel.id, targetRepKey: investorRepKey('A') })).toBe(true)
    expect(getActingPlayerId(session.state)).toBe(3)
    await tick(); await tick()
    expect(getActingPlayerId(session.state)).toBe(0) // 3 号没有阻止牌，自动放行
    session.destroy()

    let t = baseState(4, 104)
    t.players[3].isAI = false
    for (let i = 0; i < 4; i++) clearHand(t, i)
    setInvestors(t, { A: 0, B: 1, C: 2, D: 3 })
    const [travel2] = giveCards(t, 2, [{ type: 'TRAVEL' }])
    giveCards(t, 3, [{ type: 'STOP' }])
    t = openDealAt(t, 1, 0)
    t.negotiation!.turnId = 2
    const session2 = new GameSession(t, { policy: held, delay: () => 0 })
    session2.dispatch({ type: 'PLAY_TRAVEL', playerId: 2, cardId: travel2.id, targetRepKey: investorRepKey('A') })
    await tick(); await tick()
    expect(getActingPlayerId(session2.state)).toBe(3) // 有阻止牌：等人类决定
    expect(session2.dispatch({ type: 'PLAY_STOP', playerId: 3 })).toBe(true)
    session2.destroy()
  })

  it('成交倒计时里没有任何干扰牌的人类自动放行；有牌则等待', async () => {
    let s = baseState(4, 107)
    s.players[3].isAI = false
    for (let i = 0; i < 4; i++) clearHand(s, i)
    setInvestors(s, { A: 0, B: 0, C: 1, D: 2, E: 3 })
    s = openDealAt(s, 1, 0) // Boss 独立凑齐
    s.negotiation!.turnId = 0
    const held: Policy = { name: 'hold', decide: () => new Promise(() => {}) }
    const session = new GameSession(s, { policy: held, delay: () => 0 })
    expect(session.dispatch({ type: 'CLOSE_DEAL', playerId: 0 })).toBe(true)
    expect(session.dispatch({ type: 'PASS_CLOSING', playerId: 1 })).toBe(true)
    expect(session.dispatch({ type: 'PASS_CLOSING', playerId: 2 })).toBe(true)
    expect(getActingPlayerId(session.state)).toBe(3)
    await tick(); await tick()
    expect(session.state.phase).toBe('TURN') // 3 号无牌可打，自动放行 → 结算
    expect(session.state.players[0].cash).toBe(6)
    session.destroy()

    let t = baseState(4, 108)
    t.players[3].isAI = false
    for (let i = 0; i < 4; i++) clearHand(t, i)
    setInvestors(t, { A: 0, B: 0, C: 1, D: 2, E: 3 })
    giveCards(t, 3, [{ type: 'TRAVEL' }])
    t = openDealAt(t, 1, 0)
    t.negotiation!.turnId = 0
    const session2 = new GameSession(t, { policy: held, delay: () => 0 })
    session2.dispatch({ type: 'CLOSE_DEAL', playerId: 0 })
    session2.dispatch({ type: 'PASS_CLOSING', playerId: 1 })
    session2.dispatch({ type: 'PASS_CLOSING', playerId: 2 })
    await tick(); await tick()
    expect(session2.state.phase).toBe('CLOSING')
    expect(getActingPlayerId(session2.state)).toBe(3) // 有旅行牌：等人类决定
    session2.destroy()
  })

  it('销毁后不再推进，也不接受动作', async () => {
    const session = new GameSession(baseState(4, 105), { policy: heuristicPolicy, delay: () => 5 })
    const v = session.state.stateVersion
    session.destroy()
    await new Promise(r => setTimeout(r, 30))
    expect(session.state.stateVersion).toBe(v)
    expect(session.dispatch({ type: 'PASS', playerId: 0 })).toBe(false)
  })

  it('订阅者在每次状态变化时收到通知，thinkingId 在电脑思考期间可见', async () => {
    let notifications = 0
    let sawThinking = false
    const slow: Policy = {
      name: 'slow',
      decide: (state, signal) => new Promise(resolve => {
        const t = setTimeout(() => resolve(heuristicPolicy.decide(state, signal)), 5)
        signal.addEventListener('abort', () => clearTimeout(t))
      }),
    }
    const session = new GameSession(baseState(3, 106), { policy: slow, delay: () => 0 })
    session.subscribe(() => { notifications++; if (session.snapshot.thinkingId != null) sawThinking = true })
    await session.runUntil(s => s.stateVersion >= 4)
    session.destroy()
    expect(notifications).toBeGreaterThanOrEqual(3)
    expect(sawThinking).toBe(true)
  })
})

describe('GameSession 动作日志', () => {
  it('每个被接受的动作（人类 / 电脑 / 自动放行）都记一条：序号连续、提交前版本、事件 id 区间', async () => {
    const { state, origin } = createGame({ playerCount: 4, humanName: '我', seed: 201 })
    const session = new GameSession(state, { policy: heuristicPolicy, delayFor: () => 0, replay: { origin, log: [] } })
    expect(session.log).toHaveLength(0)
    const seen: ActionLogEntry[] = []
    session.subscribe(() => { const e = session.snapshot.lastEntry; if (e && seen[seen.length - 1] !== e) seen.push(e) })
    const s1 = await session.runUntil(s => !s.players[getActingPlayerId(s)].isAI)
    expect(session.log.length).toBe(s1.stateVersion - 1)
    expect(session.snapshot.logLength).toBe(session.log.length)
    session.log.forEach((e, i) => {
      expect(e.index).toBe(i)
      expect(e.versionBefore).toBe(i + 1)
      expect(e.source).toBe('ai')
      expect(e.eventTo).toBeGreaterThanOrEqual(e.eventFrom - 1)
      if (i > 0) expect(e.eventFrom).toBe(session.log[i - 1].eventTo + 1)
    })
    // 人类的动作也入日志，且区间覆盖它产生的事件
    const before = session.state
    const human = before.phase === 'PLACE_MARKER'
      ? { type: 'PLACE_MARKER' as const, playerId: 0, spaceId: 3 }
      : { type: 'ROLL_MOVE' as const, playerId: 0 }
    expect(session.dispatch(human)).toBe(true)
    const last = session.log[session.log.length - 1]
    expect(last).toMatchObject({ source: 'human', versionBefore: before.stateVersion, eventFrom: before.nextId })
    expect(last.action).toEqual(human)
    const produced = session.state.events.filter(e => e.id >= before.nextId)
    expect(produced.length).toBeGreaterThan(0)
    expect(produced.every(e => e.id >= last.eventFrom && e.id <= last.eventTo)).toBe(true)
    // 订阅者每次变化都能拿到最新条目
    expect(session.snapshot.lastEntry).toBe(last)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.map(e => e.index)).toEqual([...seen.map(e => e.index)].sort((a, b) => a - b))
    expect(checkReplay({ origin, log: session.log }, session.state)).toBeNull()
    session.destroy()
  })

  it('被拒绝的动作不入日志；日志里的动作是副本，事后改外部对象不影响记录', () => {
    const { state, origin } = createGame({ playerCount: 4, humanName: '我', seed: 202 })
    const session = new GameSession(state, { policy: { name: 'hold', decide: () => new Promise(() => {}) }, delayFor: () => 0, replay: { origin, log: [] } })
    expect(session.dispatch({ type: 'PASS', playerId: 3 })).toBe(false)
    expect(session.log).toHaveLength(0)
    const action = { type: 'PLACE_MARKER' as const, playerId: session.state.markerChooserId!, spaceId: 5 }
    expect(session.dispatch(action)).toBe(true)
    action.spaceId = 9
    expect((session.log[0].action as { spaceId: number }).spaceId).toBe(5)
    session.destroy()
    expect(session.dispatch({ type: 'ROLL_MOVE', playerId: 0 })).toBe(false)
    expect(session.log).toHaveLength(1)
  })

  it('没有开局参数的会话（自定义局面）：日志照记，但不可回放；日志对不上初始状态时同样降级', () => {
    const hold: Policy = { name: 'hold', decide: () => new Promise(() => {}) }
    const plain = new GameSession(baseState(4, 203), { policy: hold })
    expect(plain.replayable).toBe(false)
    expect(plain.origin).toBeNull()
    expect(plain.toSaved().log).toEqual([])
    plain.destroy()

    const { state, origin } = createGame({ playerCount: 4, humanName: '我', seed: 204 })
    const bogus = new GameSession({ ...state, stateVersion: 9 }, { policy: hold, replay: { origin, log: [] } })
    expect(bogus.replayable).toBe(false) // 空日志只能接在 stateVersion 1 上
    bogus.destroy()
  })

  it('replace() 载入另一份状态：日志按新来源重置', () => {
    const hold: Policy = { name: 'hold', decide: () => new Promise(() => {}) }
    const a = createGame({ playerCount: 3, humanName: '甲', seed: 205 })
    const session = new GameSession(a.state, { policy: hold, replay: { origin: a.origin, log: [] } })
    session.dispatch({ type: 'PLACE_MARKER', playerId: session.state.markerChooserId!, spaceId: 2 })
    expect(session.log).toHaveLength(1)
    const b = createGame({ playerCount: 3, humanName: '乙', seed: 206 })
    session.replace(b.state)
    expect(session.log).toHaveLength(0)
    expect(session.replayable).toBe(false)
    expect(session.snapshot.lastEntry).toBeNull()
    session.replace(b.state, { origin: b.origin, log: [] })
    expect(session.replayable).toBe(true)
    session.destroy()
  })

  it('delayFor 优先于旧的 delay；二者都省略则不停顿', async () => {
    const calls: string[] = []
    const s1 = new GameSession(baseState(3, 207), { policy: heuristicPolicy, delay: () => { calls.push('delay'); return 0 }, delayFor: () => { calls.push('delayFor'); return 0 } })
    await s1.runUntil(s => s.stateVersion >= 3)
    s1.destroy()
    expect(new Set(calls)).toEqual(new Set(['delayFor']))

    const s2 = new GameSession(baseState(3, 208), { policy: heuristicPolicy })
    const final = await s2.runUntil()
    s2.destroy()
    expect(final.phase).toBe('GAME_OVER')
  })
})
