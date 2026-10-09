// useGameSession：可注入环境、开局记录种子（含 0）、继续上一局（含终局）、旧调用方式向后兼容
//
// 需要 jsdom 与 @testing-library/react（界面代理的 package.json 里才有）。这里动态加载：
// 依赖不在时整组用例跳过，依赖到位（合并后）自动启用，不会让只改运行时的分支测试失败。

import { describe, it, expect } from 'vitest'
import { useGameSession } from '../src/hooks/useGameSession'
import { GameSaveStore, type StorageLike } from '../src/utils/storage'
import { startGameSession, type SessionEnv } from '../src/game/createSession'
import { heuristicPolicy } from '../src/ai/heuristic'
import type { Policy } from '../src/ai/policy'

/* eslint-disable @typescript-eslint/no-explicit-any */
const dyn = (name: string): Promise<any> => import(/* @vite-ignore */ name).catch(() => null)
const jsdom = await dyn('jsdom')
if (jsdom) {
  const dom = new jsdom.JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const g = globalThis as any
  g.window = dom.window
  g.document = dom.window.document
  Object.defineProperty(g, 'navigator', { value: dom.window.navigator, configurable: true })
  for (const k of ['HTMLElement', 'Node', 'Event', 'MutationObserver', 'getComputedStyle']) g[k] = dom.window[k]
  g.IS_REACT_ACT_ENVIRONMENT = true
}
const rtl = jsdom ? await dyn('@testing-library/react') : null
const renderHook = (...a: unknown[]) => rtl.renderHook(...a)
const act = (fn: () => void) => rtl.act(fn)

class Mem implements StorageLike {
  m = new Map<string, string>()
  getItem(k: string) { return this.m.get(k) ?? null }
  setItem(k: string, v: string) { this.m.set(k, v) }
  removeItem(k: string) { this.m.delete(k) }
}

const hold: Policy = { name: 'hold', decide: () => new Promise(() => {}) }
const env = (mem: Mem, policy: Policy = hold): SessionEnv => ({ policy, delayFor: () => 0, store: new GameSaveStore(mem), loadSaved: () => new GameSaveStore(mem).load(), saveThrottleMs: 0 })

describe.skipIf(!rtl)('useGameSession', () => {
  it('start：记录开局参数（种子 0 不被当成随机）并立刻存档；返回字段向后兼容', () => {
    const mem = new Mem()
    const { result } = renderHook(() => useGameSession(() => env(mem))) as { result: { current: ReturnType<typeof useGameSession> } }
    expect(result.current.snapshot).toBeNull()
    act(() => { result.current.start(4, '我', 0, 'full', false) })
    expect(Object.keys(result.current)).toEqual(expect.arrayContaining(['snapshot', 'start', 'load', 'leave', 'act']))
    expect(result.current.snapshot!.state.variantId).toBe('full')
    expect(result.current.getOrigin()).toMatchObject({ seed: 0, houseRules: false, playerCount: 4 })
    expect(new GameSaveStore(mem).load()!.origin!.seed).toBe(0)
    act(() => result.current.leave())
    expect(result.current.snapshot).toBeNull()
  })

  it('动作日志随快照增长；离开后再"继续上一局"能接上', () => {
    const mem = new Mem()
    const { result } = renderHook(() => useGameSession(() => env(mem))) as { result: { current: ReturnType<typeof useGameSession> } }
    act(() => { result.current.start(3, '我', 5) })
    const s0 = result.current.snapshot!.state
    expect(result.current.getLog()).toHaveLength(0)
    act(() => { result.current.act({ type: 'PLACE_MARKER', playerId: s0.markerChooserId!, spaceId: 4 }) })
    expect(result.current.snapshot!.logLength).toBe(1)
    expect(result.current.getLog()[0].action.type).toBe('PLACE_MARKER')
    const version = result.current.snapshot!.state.stateVersion
    act(() => result.current.leave())

    let ok = false
    act(() => { ok = result.current.continueSaved() })
    expect(ok).toBe(true)
    expect(result.current.snapshot!.state.stateVersion).toBe(version)
    expect(result.current.getLog()).toHaveLength(1)
    expect(result.current.getOrigin()!.seed).toBe(5)
  })

  it('终局也存档：回首页再继续，直接是终局状态', async () => {
    const mem = new Mem()
    const e = env(mem, heuristicPolicy)
    const s = startGameSession({ playerCount: 4, humanName: 'x', seed: 9, variantId: 'classic', allAI: true }, e)
    const final = await s.runUntil()
    s.destroy()
    expect(final.phase).toBe('GAME_OVER')

    const { result } = renderHook(() => useGameSession(() => env(mem, heuristicPolicy))) as { result: { current: ReturnType<typeof useGameSession> } }
    let ok = false
    act(() => { ok = result.current.continueSaved() })
    expect(ok).toBe(true)
    expect(result.current.snapshot!.state.phase).toBe('GAME_OVER')
    expect(result.current.snapshot!.state.winnerIds).toEqual(final.winnerIds)
    await new Promise(r => setTimeout(r, 20))
    expect(result.current.snapshot!.state.stateVersion).toBe(final.stateVersion)
  })

  it('没有存档时 continueSaved 返回 false', () => {
    const { result } = renderHook(() => useGameSession(() => env(new Mem()))) as { result: { current: ReturnType<typeof useGameSession> } }
    let ok = true
    act(() => { ok = result.current.continueSaved() })
    expect(ok).toBe(false)
    expect(result.current.snapshot).toBeNull()
  })
})

