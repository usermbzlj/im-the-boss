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
