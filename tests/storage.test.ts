// 存档：分 key 存储、动作日志、迁移（含 v10 → 新格式）、终局存档、节流、依赖注入
// vitest 环境是 node，没有 localStorage——这里用内存实现

import { describe, it, expect, vi } from 'vitest'
import type { GameState } from '../src/engine/types'
import { SAVE_VERSION } from '../src/engine/gameEngine'
import { GameSaveStore, type StorageLike, loadSavedGame, saveGame, savedGameFor, clearSavedGame, hasSavedGame, loadSavedSession } from '../src/utils/storage'
import {
  STORAGE_FORMAT, STORAGE_MIGRATIONS, STATE_MIGRATIONS, MIN_SAVE_VERSION, LOG_CHUNK_SIZE,
  migrateState, addFields, addPlayerFields, missingStateMigrations, type StateMigration,
} from '../src/utils/saveMigrations'
import { Autosaver } from '../src/game/autosave'
import { resumeGameSession, startGameSession, type SessionEnv } from '../src/game/createSession'
import { checkReplay, firstDifference, createGame, type SavedGame } from '../src/game/replay'
import { getActingPlayerId } from '../src/engine/validator'
import { heuristicPolicy } from '../src/ai/heuristic'
import { checkInvariants } from '../src/sim/harness'
import fixtureV10 from './fixtures/save-v10.json'

/** 内存 localStorage：统计写入次数，可设置配额（超出抛异常，同浏览器的 QuotaExceededError） */
class MemoryStorage implements StorageLike {
  data = new Map<string, string>()
  writes: string[] = []
  constructor(public quota = Infinity) {}
  getItem(k: string) { return this.data.get(k) ?? null }
  setItem(k: string, v: string) {
    let total = k.length + v.length
    for (const [key, val] of this.data) if (key !== k) total += key.length + val.length
    if (total > this.quota) throw new Error('QuotaExceededError')
    this.data.set(k, v)
    this.writes.push(k)
  }
  removeItem(k: string) { this.data.delete(k) }
  keys() { return [...this.data.keys()].sort() }
}

const HEAD = 'im-the-boss:save:head'
const LEGACY = 'im-the-boss-save'
const logKeys = (m: MemoryStorage) => m.keys().filter(k => k.includes(':log:'))

const fastEnv = (store: GameSaveStore | null, extra: Partial<SessionEnv> = {}): SessionEnv => ({
  policy: heuristicPolicy, delayFor: () => 0, store, saveThrottleMs: 0, ...extra,
})

const allAIInput = (seed: number, variantId: 'classic' | 'full' = 'classic') => ({ playerCount: 4, humanName: 'x', seed, variantId, allAI: true })

describe('存档：当前状态 + 开局参数 + 分块动作日志', () => {
  it('跑完一局再读回：状态、开局参数、日志完全一致，且日志可重放', async () => {
    const mem = new MemoryStorage()
    const store = new GameSaveStore(mem)
    const session = startGameSession(allAIInput(11, 'full'), fastEnv(store))
    const final = await session.runUntil()
    session.destroy()

    const loaded = new GameSaveStore(mem).load()!
    expect(loaded).not.toBeNull()
    expect(firstDifference(loaded.state, final)).toBeNull()
    expect(loaded.replayable).toBe(true)
    expect(loaded.origin).toEqual(session.origin)
    expect(loaded.log).toEqual(JSON.parse(JSON.stringify(session.log)))
    expect(checkReplay({ origin: loaded.origin!, log: loaded.log }, loaded.state)).toBeNull()
  })

  it('分 key 存：head（状态 + 参数）一个 key，日志按块存；每步只重写最后一块', async () => {
    const mem = new MemoryStorage()
    const store = new GameSaveStore(mem, 10)
    const session = startGameSession(allAIInput(12), fastEnv(store))
    const final = await session.runUntil()
    session.destroy()

    const n = session.log.length
    expect(n).toBeGreaterThan(30)
    expect(mem.keys()).toEqual([HEAD, ...Array.from({ length: Math.ceil(n / 10) }, (_, i) => `im-the-boss:save:log:${i}`)].sort())
    // 写满的块不再被重写：块 i 最多被写 10 次（它增长期间每步一次）
    for (let i = 0; i < Math.floor(n / 10); i++) {
      expect(mem.writes.filter(k => k === `im-the-boss:save:log:${i}`).length).toBeLessThanOrEqual(10)
    }
    expect(JSON.parse(mem.getItem(HEAD)!).logLength).toBe(n)
    expect(final.phase).toBe('GAME_OVER')
    expect(new GameSaveStore(mem).load()!.log).toHaveLength(n)
  })

  it('开新局会清掉上一局残留的日志块', async () => {
    const mem = new MemoryStorage()
    const store = new GameSaveStore(mem, 10)
    const a = startGameSession(allAIInput(13), fastEnv(store))
    await a.runUntil(s => s.stateVersion >= 60)
    a.destroy()
    expect(logKeys(mem).length).toBeGreaterThanOrEqual(5)
    const b = startGameSession(allAIInput(14), fastEnv(store, { policy: { name: 'hold', decide: () => new Promise(() => {}) } }))
    b.destroy()
    expect(logKeys(mem)).toEqual([]) // 新局日志为空
    expect(new GameSaveStore(mem).load()!.state.stateVersion).toBe(1)
  })

  it('续局：从存档恢复后继续追加，开局参数 + 日志仍能重放到最终状态', async () => {
    const mem = new MemoryStorage()
    const a = startGameSession(allAIInput(15, 'full'), fastEnv(new GameSaveStore(mem)))
    await a.runUntil(s => s.stateVersion >= 80)
    a.destroy()
    const savedLog = new GameSaveStore(mem).load()!.log

    const store2 = new GameSaveStore(mem)
    const saved = store2.load()!
    expect(saved.replayable).toBe(true)
    const b = resumeGameSession(saved, fastEnv(store2))
    const final = await b.runUntil()
    b.destroy()
    expect(b.log.length).toBeGreaterThan(savedLog.length)
    expect(b.log.slice(0, savedLog.length)).toEqual(savedLog)
    expect(checkReplay({ origin: b.origin!, log: b.log }, final)).toBeNull()
    expect(firstDifference(new GameSaveStore(mem).load()!.state, final)).toBeNull()
  })
})

describe('终局存档', () => {
  it('终局状态会存下来；续局时直接是终局画面，不再回到掷终局骰那一步', async () => {
    const mem = new MemoryStorage()
    const store = new GameSaveStore(mem)
    const session = startGameSession(allAIInput(21, 'full'), fastEnv(store))
    const final = await session.runUntil()
    expect(final.phase).toBe('GAME_OVER')
    session.destroy()

    const loaded = new GameSaveStore(mem).load()!
    expect(loaded.state.phase).toBe('GAME_OVER')
    expect(loaded.state.winnerIds).toEqual(final.winnerIds)
    expect(loaded.state.stateVersion).toBe(final.stateVersion)

    const resumed = resumeGameSession(loaded, fastEnv(new GameSaveStore(mem)))
    await new Promise(r => setTimeout(r, 20))
    expect(resumed.state.phase).toBe('GAME_OVER')
    expect(resumed.state.stateVersion).toBe(final.stateVersion) // 没有任何电脑在推进
    expect(resumed.replayable).toBe(true)
    resumed.destroy()
  })

  it('终局立即落盘，即使节流间隔很长', async () => {
    const mem = new MemoryStorage()
    const session = startGameSession(allAIInput(22), fastEnv(new GameSaveStore(mem), { saveThrottleMs: 60_000 }))
    const final = await session.runUntil()
    // 不 destroy：终局本身就应已写入
    expect(new GameSaveStore(mem).load()!.state.stateVersion).toBe(final.stateVersion)
    session.destroy()
  })
})

describe('写入节流', () => {
  const fakeTimers = () => {
    const pending: Array<() => void> = []
    return { pending, setTimer: (fn: () => void) => { pending.push(fn); return pending.length }, clearTimer: (h: unknown) => { pending[(h as number) - 1] = () => {} } }
  }
  const state = (phase: GameState['phase']) => ({ phase }) as GameState

  it('变化很频繁时只在间隔到期写一次；写的是最新状态', () => {
    const saves: number[] = []
    let version = 0
    const t = fakeTimers()
    const saver = new Autosaver({ save: () => { saves.push(version); return true } }, { throttleMs: 400, setTimer: t.setTimer, clearTimer: t.clearTimer })
    saver.attach({ toSaved: () => ({}) as SavedGame })
    expect(saves).toEqual([0]) // 刚开局立刻写一次
    for (version = 1; version <= 50; version++) saver.touch(state('TURN'))
    expect(saves).toEqual([0])
    expect(t.pending).toHaveLength(1) // 只排了一个定时器
    t.pending[0]()
    expect(saves).toEqual([0, 51])
  })

  it('终局 / flush 立即写；没有新变化不重复写', () => {
    const saves: number[] = []
    let n = 0
    const t = fakeTimers()
    const saver = new Autosaver({ save: () => { saves.push(++n); return true } }, { throttleMs: 400, setTimer: t.setTimer, clearTimer: t.clearTimer })
    saver.attach({ toSaved: () => ({}) as SavedGame })
    saver.touch(state('TURN'))
    saver.touch(state('GAME_OVER'))
    expect(saves).toHaveLength(2)
    saver.flush()
    expect(saves).toHaveLength(2)
  })

  it('销毁会话时落盘最后一步（不会因节流丢失）', async () => {
    const mem = new MemoryStorage()
    const session = startGameSession(allAIInput(23), fastEnv(new GameSaveStore(mem), { saveThrottleMs: 60_000 }))
    await session.runUntil(s => s.stateVersion >= 25)
    const writtenBefore = JSON.parse(mem.getItem(HEAD)!).state.stateVersion
    expect(writtenBefore).toBeLessThan(session.state.stateVersion) // 节流期间落后
    session.destroy()
    expect(JSON.parse(mem.getItem(HEAD)!).state.stateVersion).toBe(session.state.stateVersion)
  })
})

describe('迁移：v10 旧存档 → 新格式', () => {
  const v10 = () => {
    const s = structuredClone(fixtureV10) as unknown as GameState
    for (const p of s.players) p.isAI = true // 让测试里的电脑把它打完
    return s
  }

  it('夹具确实是 v10 旧格式（整个 GameState 直接放在旧 key）', () => {
    expect((fixtureV10 as { saveVersion: number }).saveVersion).toBe(10)
  })

  it('读到旧存档：迁移成新格式、标记不可回放、删除旧 key、状态内容不丢', () => {
    const mem = new MemoryStorage()
    mem.setItem(LEGACY, JSON.stringify(v10()))
    const store = new GameSaveStore(mem)
    const loaded = store.load()!
    expect(loaded).not.toBeNull()
    expect(loaded.replayable).toBe(false)
    expect(loaded.origin).toBeNull()
    expect(loaded.log).toEqual([])
    expect(loaded.state.saveVersion).toBe(SAVE_VERSION)
    expect(loaded.state.phase).toBe(v10().phase)
    expect(loaded.state.stateVersion).toBe(v10().stateVersion)
    expect(loaded.state.players.map(p => p.name)).toEqual(v10().players.map(p => p.name))
    // 已改写成新格式
    expect(mem.getItem(LEGACY)).toBeNull()
    const head = JSON.parse(mem.getItem(HEAD)!)
    expect(head.storageFormat).toBe(STORAGE_FORMAT)
    expect(head.replayable).toBe(false)
    expect(new GameSaveStore(mem).load()!.state.stateVersion).toBe(loaded.state.stateVersion)
  })

  it('迁移后的存档能继续玩到终局，全程不变量成立；之后的存档仍是新格式', async () => {
    const mem = new MemoryStorage()
    mem.setItem(LEGACY, JSON.stringify(v10()))
    const store = new GameSaveStore(mem)
    const problems: string[] = []
    const session = resumeGameSession(store.load()!, fastEnv(store, { onChange: s => { const bad = checkInvariants(s); if (bad) problems.push(bad) }, onError: m => problems.push(m) }))
    expect(session.replayable).toBe(false)
    const final = await session.runUntil()
    session.destroy()
    expect(problems).toEqual([])
    expect(final.phase).toBe('GAME_OVER')
    expect(session.log.length).toBeGreaterThan(0) // 内存里仍按动作记录（UI 可按动作分组事件）
    const reloaded = new GameSaveStore(mem).load()!
    expect(reloaded.state.phase).toBe('GAME_OVER')
    expect(reloaded.replayable).toBe(false)
    expect(logKeys(mem)).toEqual([]) // 不可回放的局不存日志
  })

  it('旧的函数式接口：loadSavedGame 读出的状态交给 load(state) 时仍能找回完整存档', () => {
    const mem = new MemoryStorage()
    vi.stubGlobal('localStorage', mem)
    try {
      mem.setItem(LEGACY, JSON.stringify(v10()))
      expect(hasSavedGame()).toBe(true)
      const state = loadSavedGame()!
      expect(state.saveVersion).toBe(SAVE_VERSION)
      expect(savedGameFor(state)?.state).toBe(state)
      expect(savedGameFor({ ...state })).toBeNull()
      const { state: s2, origin } = createGame({ playerCount: 3, humanName: 'a', seed: 4 })
      saveGame(s2)
      expect(loadSavedGame()!.stateVersion).toBe(s2.stateVersion)
      expect(origin.seed).toBe(4)
      expect(loadSavedSession()!.replayable).toBe(false)
      clearSavedGame()
      expect(mem.keys()).toEqual([])
      expect(hasSavedGame()).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('迁移机制', () => {
  it('迁移表覆盖 [MIN_SAVE_VERSION, SAVE_VERSION) 里每个版本——升了 SAVE_VERSION 就必须补迁移', () => {
    expect(MIN_SAVE_VERSION).toBeLessThanOrEqual(SAVE_VERSION)
    expect(missingStateMigrations()).toEqual([])
    for (let v = MIN_SAVE_VERSION; v < SAVE_VERSION; v++) expect(STATE_MIGRATIONS[v]).toBeDefined()
  })

  it('存档格式迁移表 1 → 2 → … → STORAGE_FORMAT 无缺口', () => {
    for (let f = 1; f < STORAGE_FORMAT; f++) expect(STORAGE_MIGRATIONS[f]).toBeTypeOf('function')
    const head = STORAGE_MIGRATIONS[1]({ saveVersion: 10, players: [] }) as Record<string, unknown>
    expect(head).toMatchObject({ storageFormat: 2, origin: null, replayable: false, logLength: 0, chunkSize: LOG_CHUNK_SIZE })
  })

  /** 演练"引擎升到 12"：10 → 11 补顶层字段，11 → 12 补玩家字段 */
  const table = (keeps: boolean): Record<number, StateMigration> => ({
    10: { migrate: addFields({ nextTradeId: 1, tradeLog: [] }), keepsReplay: keeps },
    11: { migrate: addPlayerFields({ strikes: 0 }), keepsReplay: keeps },
  })
  const base = () => structuredClone(fixtureV10) as unknown as Record<string, unknown>

  it('逐级迁移：只加字段补默认值，已有字段不覆盖，saveVersion 逐级抬到目标', () => {
    const input = base()
    ;(input.players as Array<Record<string, unknown>>)[1].strikes = 7
    const r = migrateState(input, { target: 12, table: table(false) })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const s = r.state as unknown as Record<string, unknown> & { players: Array<Record<string, unknown>> }
    expect(s.saveVersion).toBe(12)
    expect(s.nextTradeId).toBe(1)
    expect(s.tradeLog).toEqual([])
    expect(s.players.map(p => p.strikes)).toEqual([0, 7, 0, 0])
    expect(r.migrated).toBe(true)
  })

  it('默认值是深拷贝：两份存档不共享引用', () => {
    const t = table(true)
    const a = migrateState(base(), { target: 12, table: t })
    const b = migrateState(base(), { target: 12, table: t })
    if (!a.ok || !b.ok) throw new Error('应成功')
    ;((a.state as unknown as { tradeLog: unknown[] }).tradeLog).push('x')
    expect((b.state as unknown as { tradeLog: unknown[] }).tradeLog).toEqual([])
  })

  it('keepsReplay：全部步骤都声明保持重放才算保持；否则旧日志作废', () => {
    const keep = migrateState(base(), { target: 12, table: table(true) })
    const drop = migrateState(base(), { target: 12, table: table(false) })
    expect(keep.ok && keep.keepsReplay).toBe(true)
    expect(drop.ok && drop.keepsReplay).toBe(false)
  })

  it('无需迁移 / 太旧 / 来自未来 / 缺迁移步骤 / 结构损坏', () => {
    const same = migrateState(base())
    expect(same.ok && same.migrated).toBe(false)
    expect(migrateState({ ...base(), saveVersion: 9 })).toEqual({ ok: false, reason: 'too-old' })
    expect(migrateState({ ...base(), saveVersion: SAVE_VERSION + 1 })).toEqual({ ok: false, reason: 'future' })
    expect(migrateState(base(), { target: 12, table: { 10: table(true)[10] } })).toEqual({ ok: false, reason: 'too-old' })
    expect(migrateState({ saveVersion: 10 })).toEqual({ ok: false, reason: 'invalid' })
    expect(migrateState(null)).toEqual({ ok: false, reason: 'invalid' })
    expect(migrateState({ ...base(), players: 'x' })).toEqual({ ok: false, reason: 'invalid' })
  })
})

describe('存档的容错', () => {
  const makeSaved = async (mem: MemoryStorage, seed: number, upTo = 40) => {
    const session = startGameSession(allAIInput(seed), fastEnv(new GameSaveStore(mem, 10)))
    await session.runUntil(s => s.stateVersion >= upTo)
    session.destroy()
    return session
  }

  it('损坏的 JSON / 太旧 / 不是对象：返回 null 并清掉，不抛异常', () => {
    for (const junk of ['{not json', '"str"', '42', JSON.stringify({ saveVersion: 3, players: [] }), 'null']) {
      const mem = new MemoryStorage()
      mem.setItem(HEAD, junk)
      expect(new GameSaveStore(mem).load()).toBeNull()
      expect(mem.keys()).toEqual([])
    }
    const mem = new MemoryStorage()
    mem.setItem(LEGACY, '{oops')
    expect(new GameSaveStore(mem).load()).toBeNull()
    expect(mem.keys()).toEqual([])
  })

  it('来自更新版本的存档：不认识也不删', async () => {
    const mem = new MemoryStorage()
    await makeSaved(mem, 31)
    const head = JSON.parse(mem.getItem(HEAD)!)
    head.storageFormat = STORAGE_FORMAT + 1
    mem.setItem(HEAD, JSON.stringify(head))
    expect(new GameSaveStore(mem).load()).toBeNull()
    expect(mem.getItem(HEAD)).not.toBeNull()

    head.storageFormat = STORAGE_FORMAT
    head.state.saveVersion = SAVE_VERSION + 1
    mem.setItem(HEAD, JSON.stringify(head))
    expect(new GameSaveStore(mem).load()).toBeNull()
    expect(mem.getItem(HEAD)).not.toBeNull()
  })

  it('日志块缺失 / 损坏 / 与状态对不上：状态照常续玩，只是降级为不可回放', async () => {
    for (const damage of ['missing', 'corrupt', 'stale'] as const) {
      const mem = new MemoryStorage()
      const session = await makeSaved(mem, 32)
      const lastChunk = logKeys(mem).slice(-1)[0]
      if (damage === 'missing') mem.removeItem(lastChunk)
      if (damage === 'corrupt') mem.setItem(lastChunk, '[{broken')
      if (damage === 'stale') { // 日志落后于状态（写日志与写 head 之间被中断的效果）
        const entries = JSON.parse(mem.getItem(lastChunk)!) as unknown[]
        mem.setItem(lastChunk, JSON.stringify(entries.slice(0, -1)))
        const head = JSON.parse(mem.getItem(HEAD)!)
        head.logLength -= 1
        mem.setItem(HEAD, JSON.stringify(head))
      }
      const loaded = new GameSaveStore(mem).load()!
      expect(loaded, damage).not.toBeNull()
      expect(loaded.state.stateVersion, damage).toBe(session.state.stateVersion)
      expect(loaded.replayable, damage).toBe(false)
      expect(loaded.log, damage).toEqual([])
      expect(JSON.parse(mem.getItem(HEAD)!).replayable, damage).toBe(false) // 已改写
    }
  })

  it('配额不足：日志写不下时降级保住状态；游戏不受影响', async () => {
    const free = new MemoryStorage()
    const session = await makeSaved(free, 33, 60)
    const saved = session.toSaved()
    const stateOnly = JSON.stringify({ storageFormat: STORAGE_FORMAT, state: saved.state, origin: null, replayable: false, logLength: 0, chunkSize: 10 })
    const tight = new MemoryStorage(HEAD.length + stateOnly.length + 50) // 放得下"仅状态"，放不下日志块
    const store = new GameSaveStore(tight, 10)
    expect(store.save(saved)).toBe(false)
    const loaded = new GameSaveStore(tight).load()!
    expect(loaded.state.stateVersion).toBe(saved.state.stateVersion)
    expect(loaded.replayable).toBe(false)
    // 完全写不下也不抛
    expect(new GameSaveStore(new MemoryStorage(10)).save(saved)).toBe(false)
  })

  it('没有 localStorage（Node / 隐私模式）：存取都是空操作', () => {
    const store = new GameSaveStore(null)
    const { state } = createGame({ playerCount: 3, humanName: 'a', seed: 1 })
    expect(store.save({ state, origin: null, log: [], replayable: false })).toBe(false)
    expect(store.load()).toBeNull()
    expect(store.has()).toBe(false)
    store.clear()
  })
})

describe('依赖注入：createSession', () => {
  it('startGameSession 开局即存档（立刻可"继续上一局"），种子随存档保存', () => {
    const mem = new MemoryStorage()
    const session = startGameSession({ playerCount: 4, humanName: '我', seed: 0, variantId: 'full', houseRules: false }, fastEnv(new GameSaveStore(mem)))
    const head = JSON.parse(mem.getItem(HEAD)!)
    expect(head.state.stateVersion).toBe(1)
    expect(head.origin).toMatchObject({ seed: 0, variantId: 'full', houseRules: false, humanName: '我', playerCount: 4 })
    expect(head.replayable).toBe(true)
    session.destroy()
  })

  it('store 为 null：不写任何东西；省略 seed 时随机抽并记下', () => {
    const session = startGameSession({ playerCount: 3, humanName: 'a' }, fastEnv(null))
    expect(session.origin!.seed).toBeTypeOf('number')
    session.destroy()
  })

  it('delayFor 收到（状态, 行动者, 合法动作），返回值决定停顿；默认零停顿', async () => {
    const calls: Array<{ phase: string; actorId: number; legal: number; ok: boolean }> = []
    const session = startGameSession(allAIInput(41), fastEnv(null, {
      delayFor: (state, actorId, legal) => {
        calls.push({ phase: state.phase, actorId, legal: legal.length, ok: actorId === getActingPlayerId(state) && legal.every(a => a.playerId === actorId) })
        return 0
      },
    }))
    await session.runUntil(s => s.stateVersion >= 15)
    session.destroy()
    expect(calls.length).toBeGreaterThanOrEqual(14)
    expect(calls.every(c => c.ok && c.legal > 0)).toBe(true)

    const slow = startGameSession(allAIInput(42), fastEnv(null, { delayFor: () => 40 }))
    await new Promise(r => setTimeout(r, 10))
    expect(slow.state.stateVersion).toBe(1) // 停顿期间没有推进
    await new Promise(r => setTimeout(r, 80))
    expect(slow.state.stateVersion).toBeGreaterThan(1)
    slow.destroy()
  })
})
