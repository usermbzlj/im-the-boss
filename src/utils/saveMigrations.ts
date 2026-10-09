// ============================================================
// 存档迁移表
//
// 存档有两层版本号，各自逐级迁移，互不干扰：
//
//   1. 存档格式 storageFormat（本文件的 STORAGE_FORMAT）——"盒子"的结构：状态放哪、日志怎么分块、开局参数存哪。
//      只有 utils/storage.ts 关心；STORAGE_MIGRATIONS[n] 把格式 n 的原始 JSON 升到 n+1。
//   2. 引擎状态版本 saveVersion（engine/gameEngine.ts 的 SAVE_VERSION）——"盒子里的东西"：GameState 的字段。
//      引擎改了 GameState 结构就把 SAVE_VERSION + 1，同时在 STATE_MIGRATIONS 里补一条"从旧版本升上来"的迁移；
//      读取时按存档里记录的 saveVersion 一级一级往上走，直到等于当前 SAVE_VERSION。
//
// 常见的"只加字段补默认值"升级只需要一行：
//   STATE_MIGRATIONS[10] = { migrate: addFields({ nextTradeId: 1 }) }          // GameState 新增顶层字段
//   STATE_MIGRATIONS[11] = { migrate: addPlayerFields({ strikes: 0 }) }        // Player 新增字段
// tests/storage.test.ts 会检查 [MIN_SAVE_VERSION, SAVE_VERSION) 里每个版本都有迁移，
// 因此改了 SAVE_VERSION 却忘记写迁移，测试会直接失败。
// ============================================================

import type { GameState } from '../engine/types'
import { SAVE_VERSION } from '../engine/gameEngine'

// ---------- 存档格式（盒子） ----------

/** 当前存档格式。1 = 旧版：整个 GameState 直接放在 'im-the-boss-save' 一个 key 里；2 = 状态 + 开局参数 + 分块动作日志 */
export const STORAGE_FORMAT = 2

/** 动作日志每块条数：每步只重写最后一块，避免整份日志反复序列化 */
export const LOG_CHUNK_SIZE = 100

type Raw = Record<string, unknown>

/** key = 来源格式；把该格式的原始 JSON 升到下一格式 */
export const STORAGE_MIGRATIONS: Record<number, (raw: Raw) => Raw> = {
  // 1 → 2：旧存档整个就是 GameState，没有开局参数与动作日志 ⇒ 不可回放
  1: raw => ({ storageFormat: 2, state: raw, origin: null, replayable: false, logLength: 0, chunkSize: LOG_CHUNK_SIZE }),
}

// ---------- 引擎状态版本（盒子里的东西） ----------

/** 能迁移的最老引擎版本。更老的存档直接丢弃（没有对应迁移链） */
export const MIN_SAVE_VERSION = 10

export interface StateMigration {
  /** 把 saveVersion = n 的状态升到 n + 1（不必自己改 saveVersion，迁移框架统一设置）。可原地修改并返回 */
  migrate: (state: Raw) => Raw
  /**
   * 这次升级是否保证"旧日志在新引擎上仍能重放出（迁移后的）同一状态"。
   * 默认 false：升级后旧日志作废、存档标为不可回放。
   * 只有纯加字段、且不改变 nextId / rng / 事件产生方式时才能声明 true。
   */
  keepsReplay?: boolean
}

/** key = 来源 saveVersion */
export const STATE_MIGRATIONS: Record<number, StateMigration> = {
  // 目前 SAVE_VERSION = MIN_SAVE_VERSION，没有需要补的迁移。
  // 引擎把 SAVE_VERSION 升到 11 时，在这里加：  10: { migrate: addFields({ ... }) },
}

/** 给 GameState 顶层补默认值（已有的字段不覆盖）。默认值每次深拷贝，避免存档之间共享引用 */
export function addFields(defaults: Raw): (state: Raw) => Raw {
  return state => {
    const d = structuredClone(defaults)
    for (const k of Object.keys(d)) if (state[k] === undefined) state[k] = d[k]
    return state
  }
}

/** 给每个 Player 补默认值 */
export function addPlayerFields(defaults: Raw): (state: Raw) => Raw {
  return state => {
    for (const p of state.players as Raw[]) {
      const d = structuredClone(defaults)
      for (const k of Object.keys(d)) if (p[k] === undefined) p[k] = d[k]
    }
    return state
  }
}

/** 迁移表里缺失的版本（应为空；测试用它防止"升了 SAVE_VERSION 忘写迁移"） */
export function missingStateMigrations(): number[] {
  const out: number[] = []
  for (let v = MIN_SAVE_VERSION; v < SAVE_VERSION; v++) if (!STATE_MIGRATIONS[v]) out.push(v)
  return out
}

export type MigrateStateResult =
  | { ok: true; state: GameState; /** 是否真的升了级 */ migrated: boolean; /** 旧日志在升级后是否仍可重放 */ keepsReplay: boolean }
  | { ok: false; reason: 'invalid' | 'too-old' | 'future' }

/** 粗略的结构校验：足以避免载入后立刻崩溃（精细的一致性由引擎不变量保证） */
function looksLikeState(s: Raw): boolean {
  return Array.isArray(s.players) && s.players.length >= 3 && typeof s.phase === 'string'
    && Array.isArray(s.board) && Array.isArray(s.drawPile) && Array.isArray(s.discardPile)
    && Array.isArray(s.events) && Array.isArray(s.investors) && typeof s.stateVersion === 'number'
}

/** 迁移环境（默认就是引擎当前版本与本文件的迁移表；测试里可以换成假的版本 / 假的表来演练"引擎升版"） */
export interface MigrateContext {
  target?: number
  min?: number
  table?: Record<number, StateMigration>
}

/** 按存档里的 saveVersion 逐级迁移到当前 SAVE_VERSION */
export function migrateState(input: unknown, ctx: MigrateContext = {}): MigrateStateResult {
  const target = ctx.target ?? SAVE_VERSION
  const min = ctx.min ?? MIN_SAVE_VERSION
  const table = ctx.table ?? STATE_MIGRATIONS
  if (!input || typeof input !== 'object') return { ok: false, reason: 'invalid' }
  let state = input as Raw
  if (!looksLikeState(state)) return { ok: false, reason: 'invalid' }
  const from = state.saveVersion
  if (typeof from !== 'number' || !Number.isInteger(from)) return { ok: false, reason: 'invalid' }
  if (from > target) return { ok: false, reason: 'future' }
  if (from < min) return { ok: false, reason: 'too-old' }
  let keepsReplay = true
  for (let v = from; v < target; v++) {
    const step = table[v]
    if (!step) return { ok: false, reason: 'too-old' }
    state = step.migrate(state)
    state.saveVersion = v + 1
    if (!step.keepsReplay) keepsReplay = false
  }
  return { ok: true, state: state as unknown as GameState, migrated: from !== target, keepsReplay }
}
