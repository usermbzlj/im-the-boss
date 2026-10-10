// ============================================================
// 游戏存档
//
// 存储布局（localStorage，前缀 im-the-boss:save）：
//   :head      { storageFormat, state, origin, replayable, logLength, chunkSize }
//              当前状态 + 开局参数 + 日志元数据，每次保存整体重写（原子：一个 key 一次 setItem）
//   :log:<n>   动作日志第 n 块（每块 chunkSize 条）。日志只增不改，每次保存只重写最后一块
// 旧版（storageFormat 1）把整个 GameState 放在 'im-the-boss-save'：读到时迁移成新格式并删掉旧 key。
//
// 一致性：先写日志块、后写 head。读取时校验"日志末条 versionBefore + 1 = 状态 stateVersion"，
// 对不上（写到一半被中断 / 配额不足）就丢弃日志、存档降级为"不可回放"，状态本身仍可续玩。
// 迁移机制见 saveMigrations.ts。
// ============================================================

import type { GameState } from '../engine/types'
import type { ActionLogEntry, SavedGame, StartParams } from '../game/replay'
import { STORAGE_FORMAT, LOG_CHUNK_SIZE, STORAGE_MIGRATIONS, migrateState } from './saveMigrations'

export type { SavedGame } from '../game/replay'

const PREFIX = 'im-the-boss:save'
const HEAD_KEY = `${PREFIX}:head`
const LEGACY_KEY = 'im-the-boss-save'
const logKey = (n: number) => `${PREFIX}:log:${n}`

/** localStorage 的最小子集（测试里用内存实现替换） */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

interface SaveHead {
  storageFormat: number
  state: unknown
  origin: StartParams | null
  replayable: boolean
  logLength: number
  chunkSize: number
}

function isHead(x: unknown): x is SaveHead {
  if (!x || typeof x !== 'object') return false
  const h = x as Record<string, unknown>
  return typeof h.logLength === 'number' && typeof h.chunkSize === 'number' && h.chunkSize > 0 && typeof h.replayable === 'boolean'
}

function isOrigin(x: unknown): x is StartParams {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return typeof o.seed === 'number' && typeof o.playerCount === 'number' && typeof o.humanName === 'string'
    && typeof o.variantId === 'string' && typeof o.houseRules === 'boolean' && Array.isArray(o.aiPlayers)
}

/** 日志是否自洽，并且正好接到 stateVersion 上 */
function logFitsState(log: ActionLogEntry[], stateVersion: number): boolean {
  let expected = 1
  for (let i = 0; i < log.length; i++) {
    const e = log[i]
    if (!e || e.index !== i || e.versionBefore !== expected || !e.action) return false
    expected++
  }
  return expected === stateVersion
}

export class GameSaveStore {
  /** 内存里记着"已写入的日志"，用于只重写增量块 */
  private written: { origin: StartParams; length: number } | null = null

  constructor(private readonly storage: StorageLike | null = browserStorage(), private readonly chunkSize: number = LOG_CHUNK_SIZE) {}

  /** 写一份存档。返回是否完整写入（配额不足时尽量降级保住状态，仍返回 false） */
  save(game: SavedGame): boolean {
    const st = this.storage
    if (!st) return false
    const { state, origin } = game
    const withLog = game.replayable && origin !== null
    try {
      let logLength = 0
      if (withLog) {
        logLength = game.log.length
        const incremental = this.written?.origin === origin && this.written.length <= logLength
        const first = incremental ? Math.floor(this.written!.length / this.chunkSize) : 0
        const chunks = Math.ceil(logLength / this.chunkSize)
        for (let i = first; i < chunks; i++) st.setItem(logKey(i), JSON.stringify(game.log.slice(i * this.chunkSize, (i + 1) * this.chunkSize)))
        if (!incremental) this.dropChunksFrom(chunks)
      } else {
        this.dropChunksFrom(0)
      }
      const head: SaveHead = { storageFormat: STORAGE_FORMAT, state, origin: withLog ? origin : null, replayable: withLog, logLength, chunkSize: this.chunkSize }
      st.setItem(HEAD_KEY, JSON.stringify(head))
      this.written = withLog ? { origin: origin!, length: logLength } : null
      st.removeItem(LEGACY_KEY)
      return true
    } catch {
      // 配额不足 / 隐私模式：至少保住状态（放弃日志）；仍失败就算了
      this.written = null
      try {
        this.dropChunksFrom(0)
        st.setItem(HEAD_KEY, JSON.stringify({ storageFormat: STORAGE_FORMAT, state, origin: null, replayable: false, logLength: 0, chunkSize: this.chunkSize } satisfies SaveHead))
      } catch { /* 放弃 */ }
      return false
    }
  }

  /** 读取并迁移存档；没有 / 损坏 / 太旧返回 null（损坏与太旧的会被清掉，来自未来版本的保留） */
  load(): SavedGame | null {
    const st = this.storage
    if (!st) return null
    try {
      const fromLegacy = st.getItem(HEAD_KEY) === null
      const text = fromLegacy ? st.getItem(LEGACY_KEY) : st.getItem(HEAD_KEY)
      if (text === null) return null

      let raw: Record<string, unknown> | null = JSON.parse(text)
      if (!raw || typeof raw !== 'object') return this.discard()
      let format = fromLegacy ? 1 : raw.storageFormat
      if (typeof format !== 'number') return this.discard()
      if (format > STORAGE_FORMAT) return null // 来自更新版本的存档：不认识，但也不删
      while (format < STORAGE_FORMAT) {
        const step = STORAGE_MIGRATIONS[format]
        if (!step) return this.discard()
        raw = step(raw)
        format++
      }
      if (!isHead(raw)) return this.discard()
      const head = raw

      const migrated = migrateState(head.state)
      if (!migrated.ok) return migrated.reason === 'future' ? null : this.discard()
      const state = migrated.state

      let origin: StartParams | null = null
      let log: ActionLogEntry[] = []
      if (head.replayable && isOrigin(head.origin) && migrated.keepsReplay) {
        const loaded = this.readLog(head)
        if (loaded && logFitsState(loaded, state.stateVersion)) { origin = head.origin; log = loaded }
      }
      const saved: SavedGame = { state, origin, log, replayable: origin !== null }

      // 读到旧格式 / 旧版本：立刻以新格式重写（顺带清掉旧 key）
      if (fromLegacy || migrated.migrated || head.replayable !== saved.replayable) this.save(saved)
      else this.written = origin ? { origin, length: log.length } : null
      return saved
    } catch {
      return this.discard()
    }
  }

  clear() {
    const st = this.storage
    this.written = null
    if (!st) return
    try {
      this.dropChunksFrom(0)
      st.removeItem(HEAD_KEY)
      st.removeItem(LEGACY_KEY)
    } catch { /* 忽略 */ }
  }

  has(): boolean {
    return this.load() !== null
  }

  private readLog(head: SaveHead): ActionLogEntry[] | null {
    const st = this.storage!
    const out: ActionLogEntry[] = []
    const chunks = Math.ceil(head.logLength / head.chunkSize)
    for (let i = 0; i < chunks; i++) {
      const text = st.getItem(logKey(i))
      if (text === null) return null
      let part: unknown
      try { part = JSON.parse(text) } catch { return null } // 日志块损坏：只丢日志，不丢整局
      if (!Array.isArray(part)) return null
      out.push(...(part as ActionLogEntry[]))
    }
    return out.length === head.logLength ? out : null
  }

  private dropChunksFrom(n: number) {
    const st = this.storage!
    for (let i = n; st.getItem(logKey(i)) !== null; i++) st.removeItem(logKey(i))
  }

  private discard(): null {
    this.clear()
    return null
  }
}

// ---------- 默认存储（浏览器 localStorage） ----------

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

let defaultStore: GameSaveStore | null = null
/** 浏览器默认存档（惰性创建，Node 环境下是空操作存档） */
export function getDefaultStore(): GameSaveStore {
  return (defaultStore ??= new GameSaveStore())
}

// ---------- 向后兼容的函数式接口（只有状态，没有日志） ----------

let lastLoaded: SavedGame | null = null

/** 读取完整存档（含开局参数与动作日志） */
export function loadSavedSession(): SavedGame | null {
  lastLoaded = getDefaultStore().load()
  return lastLoaded
}

/**
 * 若 state 正是 loadSavedGame / loadSavedSession 刚读出来的那份状态，返回对应的完整存档。
 * 让只拿 GameState 的旧调用方（`load(loadSavedGame())`）也不丢失动作日志。
 */
export function savedGameFor(state: GameState): SavedGame | null {
  return lastLoaded && lastLoaded.state === state ? lastLoaded : null
}

/** 只存状态（不可回放）。新代码走 GameSaveStore.save */
export function saveGame(state: GameState) {
  getDefaultStore().save({ state, origin: null, log: [], replayable: false })
}

export function loadSavedGame(): GameState | null {
  return loadSavedSession()?.state ?? null
}

export function clearSavedGame() {
  lastLoaded = null
  getDefaultStore().clear()
}

export function hasSavedGame(): boolean {
  return getDefaultStore().has()
}
