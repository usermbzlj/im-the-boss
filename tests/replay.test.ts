// 动作日志与重放：开局参数 + 动作日志 ⇒ 逐位相同的状态

import { describe, it, expect } from 'vitest'
import type { GameState, GameVariantId, PlayerAction } from '../src/engine/types'
import { VARIANT_IDS, getVariant } from '../src/engine/config'
import { getActingPlayerId } from '../src/engine/validator'
import { GameSession } from '../src/game/session'
import { startGameSession, type SessionEnv } from '../src/game/createSession'
import {
  createGame, createStartState, replayTo, replayAll, replaySteps, checkReplay, firstDifference, entryForEventId,
  ReplayError, type ActionLogEntry,
} from '../src/game/replay'
import { heuristicAction, heuristicPolicy } from '../src/ai/heuristic'
import type { Policy } from '../src/ai/policy'
import { runGame, runGameViaSession, type SimMode } from '../src/sim/harness'

/** 日志自身的结构约束：序号连续、版本衔接、事件 id 区间首尾相接 */
function expectWellFormed(log: readonly ActionLogEntry[], initial: GameState) {
  let version = initial.stateVersion
  let nextId = initial.nextId
  log.forEach((e, i) => {
    expect(e.index).toBe(i)
    expect(e.versionBefore).toBe(version)
    expect(e.eventFrom).toBe(nextId)
    expect(e.eventTo).toBeGreaterThanOrEqual(e.eventFrom - 1)
    version++
    nextId = e.eventTo + 1
  })
}

describe('开局参数', () => {
  it('createGame 解析出具体参数：种子必有、版本与桌规不依赖默认值；createStartState 复现同一初始状态', () => {
    const { state, origin } = createGame({ playerCount: 5, humanName: '  小明 ', variantId: 'marathon' })
    expect(origin.seed).toBeTypeOf('number')
    expect(origin.variantId).toBe('marathon')
    expect(origin.houseRules).toBe(getVariant('marathon').houseRules)
    expect(origin.humanName).toBe('小明')
    expect(origin.aiPlayers).toHaveLength(4)
    expect(firstDifference(createStartState(origin), state)).toBeNull()
  })

  it('种子 0 是合法种子（不被当成"随机"）', () => {
    const a = createGame({ playerCount: 4, humanName: 'x', seed: 0 })
    const b = createGame({ playerCount: 4, humanName: 'x', seed: 0 })
    expect(a.origin.seed).toBe(0)
    expect(firstDifference(a.state, b.state)).toBeNull()
  })

  it('allAI 记入参数并在重建时生效', () => {
    const { origin, state } = createGame({ playerCount: 3, humanName: 'x', seed: 5, allAI: true })
    expect(state.players.every(p => p.isAI)).toBe(true)
    expect(createStartState(origin).players.every(p => p.isAI)).toBe(true)
  })
})

describe('同步仿真的日志可重放', () => {
  // 四个版本 × 桌规开 / 关 × 3–6 人轮换 × 两种策略
  const cases: Array<{ variantId: GameVariantId; houseRules: boolean; playerCount: number; mode: SimMode }> = []
  VARIANT_IDS.forEach((variantId, vi) => {
    ([false, true] as const).forEach((houseRules, hi) => {
      ;(['heuristic', 'random'] as const).forEach((mode, mi) => {
        if (mode === 'random' && variantId === 'marathon') return // 马拉松 random 局太长（约 3300 步），启发式已覆盖该版本
        cases.push({ variantId, houseRules, mode, playerCount: 3 + ((vi + hi * 2 + mi) % 4) })
      })
    })
  })

  it.each(cases)('$variantId 桌规=$houseRules $playerCount 人 $mode：重放终态与真实终态深度相等', ({ variantId, houseRules, playerCount, mode }) => {
    const r = runGame({ playerCount, seed: 700 + playerCount, mode, variantId, houseRules, checkReplay: true })
    expect(r.reason).toBeUndefined()
    expect(r.ok).toBe(true)
    expect(r.log.length).toBe(r.steps)
    expect(checkReplay({ origin: r.origin, log: r.log }, r.final)).toBeNull()
  })

  it('日志结构良好；逐步迭代器每步状态版本 +1，事件落在各自的 id 区间里', () => {
    const r = runGame({ playerCount: 4, seed: 41, mode: 'heuristic', variantId: 'full' })
    expectWellFormed(r.log, createStartState(r.origin))
    let steps = 0
    let produced = 0
    for (const { entry, before, after } of replaySteps(r.origin, r.log)) {
      steps++
      expect(after.stateVersion).toBe(before.stateVersion + 1)
      expect(after.stateVersion).toBe(entry.versionBefore + 1)
      for (const e of after.events) {
        if (e.id < before.nextId) continue // 之前动作的事件
        expect(e.id).toBeGreaterThanOrEqual(entry.eventFrom)
        expect(e.id).toBeLessThanOrEqual(entry.eventTo)
        produced++
      }
    }
    expect(steps).toBe(r.log.length)
    expect(produced).toBeGreaterThan(r.log.length / 2) // 多数动作都会产生事件
  })

  it('replayTo 任意一步：与同一局边走边存的状态相同；越界取边界', () => {
    const r = runGame({ playerCount: 3, seed: 8, mode: 'heuristic', variantId: 'classic' })
    const stepStates: GameState[] = [createStartState(r.origin)]
    for (const s of replaySteps(r.origin, r.log)) stepStates.push(s.after)
    for (const k of [0, 1, 7, Math.floor(r.log.length / 2), r.log.length]) {
      expect(firstDifference(replayTo(r.origin, r.log, k), stepStates[k])).toBeNull()
    }
    expect(replayTo(r.origin, r.log, 999999).stateVersion).toBe(r.final.stateVersion)
    expect(replayTo(r.origin, r.log, -3).stateVersion).toBe(1)
    expect(replayAll({ origin: r.origin, log: r.log }).phase).toBe('GAME_OVER')
  })

  it('日志经 JSON 往返（存档）后仍可重放', () => {
    const r = runGame({ playerCount: 5, seed: 12, mode: 'random', variantId: 'expansion' })
    const log = JSON.parse(JSON.stringify(r.log)) as ActionLogEntry[]
    const origin = JSON.parse(JSON.stringify(r.origin))
    expect(checkReplay({ origin, log }, r.final)).toBeNull()
  })

  it('entryForEventId 按事件 id 找到产生它的动作', () => {
    const r = runGame({ playerCount: 4, seed: 3, mode: 'heuristic' })
    for (const e of r.final.events.slice(-40)) {
      const entry = entryForEventId(r.log, e.id)
      expect(entry, `事件 #${e.id}`).not.toBeNull()
      expect(e.id).toBeGreaterThanOrEqual(entry!.eventFrom)
      expect(e.id).toBeLessThanOrEqual(entry!.eventTo)
    }
    expect(entryForEventId(r.log, 0)).toBeNull()
    expect(entryForEventId(r.log, 10 ** 9)).toBeNull()
  })
})

describe('GameSession 的日志可重放', () => {
  it.each(VARIANT_IDS)('全员电脑 %s：日志重放等于真实终态', async variantId => {
    const r = await runGameViaSession({ playerCount: 4, seed: 900, variantId, checkReplay: true })
    expect(r.reason).toBeUndefined()
    expect(r.log.length).toBeGreaterThan(50)
    expect(r.log.every(e => e.source === 'ai')).toBe(true)
  })

  it('有人类座位：人类 / 电脑 / 自动放行动作都入日志，来源标注正确，重放一致', async () => {
    const env: SessionEnv = { policy: heuristicPolicy, delayFor: () => 0, saveThrottleMs: 0 }
    const session = startGameSession({ playerCount: 4, humanName: '我', seed: 31, variantId: 'full' }, env)
    // 替"人类"出主意：用启发式；没有可点的时候（只能放行的窗口）由运行时自动放行
    const drive = () => {
      const s = session.state
      if (s.phase === 'GAME_OVER') return
      const actor = getActingPlayerId(s)
      if (!s.players[actor].isAI) {
        const a = heuristicAction(s)
        if (!a) return
        // 纯放行动作稍后再点：给运行时的"自动放行"让出先手（有阻止牌时它不会自动放行，这里兜底）
        const passOnly = a.type === 'PASS_REACTION' || a.type === 'PASS_CLOSING'
        setTimeout(() => { if (session.state === s) session.dispatch(a) }, passOnly ? 5 : 0)
      }
    }
    session.subscribe(drive)
    drive()
    const final = await session.runUntil()
    session.destroy()
    expect(final.phase).toBe('GAME_OVER')
    const sources = new Set(session.log.map(e => e.source))
    expect(sources.has('human')).toBe(true)
    expect(sources.has('ai')).toBe(true)
    expect(sources.has('auto')).toBe(true)
    for (const e of session.log) {
      if (e.source === 'human') expect(final.players[e.action.playerId].isAI).toBe(false)
      if (e.source === 'ai') expect(final.players[e.action.playerId].isAI).toBe(true)
    }
    expect(session.replayable).toBe(true)
    expect(checkReplay({ origin: session.origin!, log: session.log }, final)).toBeNull()
  })

  it('电脑的台词与私人笔记来自动作负载：策略附带 say / note 时同样可重放', async () => {
    let n = 0
    const chatty: Policy = {
      name: 'chatty',
      async decide(state, signal) {
        const a = await heuristicPolicy.decide(state, signal)
        if (!a) return a
        n++
        return { ...a, say: a.type === 'PASS_REACTION' ? undefined : `第${n}句`, note: `笔记${n}` } as PlayerAction
      },
    }
    const { state, origin } = createGame({ playerCount: 4, humanName: 'x', seed: 77, variantId: 'full', allAI: true })
    const session = new GameSession(state, { policy: chatty, delayFor: () => 0, replay: { origin, log: [] } })
    const final = await session.runUntil()
    session.destroy()
    expect(final.players.some(p => p.notes.length > 0)).toBe(true)
    expect(final.players.some(p => p.lastSpeech)).toBe(true)
    expect(session.log.some(e => e.action.note)).toBe(true)
    expect(checkReplay({ origin, log: session.log }, final)).toBeNull()
  })
})

describe('重放的失败模式', () => {
  const run = () => runGame({ playerCount: 4, seed: 55, mode: 'heuristic', variantId: 'classic' })

  it('篡改动作 → 引擎拒绝并指出是第几步', () => {
    const r = run()
    const log = structuredClone(r.log)
    log[5].action = { type: 'PASS_CLOSING', playerId: 3 }
    expect(() => replayAll({ origin: r.origin, log })).toThrow(ReplayError)
    expect(checkReplay({ origin: r.origin, log }, r.final)).toMatch(/第 6 步/)
  })

  it('缺一条日志 → 版本号不衔接', () => {
    const r = run()
    const log = r.log.filter((_, i) => i !== 10)
    expect(checkReplay({ origin: r.origin, log }, r.final)).toMatch(/版本号不衔接|引擎拒绝/)
  })

  it('日志与终态不符 → 报出第一处差异路径', () => {
    const r = run()
    const tampered = structuredClone(r.final)
    tampered.players[1].cash += 1
    expect(checkReplay({ origin: r.origin, log: r.log }, tampered)).toMatch(/players\[1\]\.cash/)
  })

  it('人物表对不上（记录的电脑玩家与种子推出的不同）→ 拒绝重放', () => {
    const r = run()
    const origin = { ...r.origin, aiPlayers: r.origin.aiPlayers.map(p => ({ ...p, name: p.name + '？' })) }
    expect(() => createStartState(origin)).toThrow(ReplayError)
  })
})
