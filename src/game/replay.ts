// ============================================================
// 动作日志与重放（纯函数，框架无关）
//
// 一局游戏 = 开局参数（StartParams）+ 被引擎接受的动作序列（ActionLogEntry[]）。
// 引擎的全部随机性来自 state.rng，LLM 的"私人笔记 / 台词"也是动作负载（action.note / action.say），
// 因此重放不需要策略、网络或时钟：把日志逐条喂给 gameReducer 就得到逐位相同的状态。
// ============================================================

import type { GameState, PlayerAction, GameVariantId } from '../engine/types'
import { createInitialState, gameReducer } from '../engine/gameEngine'
import { getVariant, randomSeed } from '../engine/config'

/** 动作来源：人类点击 / 电脑策略（含兜底） / 运行时自动放行（人类无牌可打的窗口） */
export type ActionSource = 'human' | 'ai' | 'auto'

/** 开局参数：配合动作日志可完整重放一局。所有字段都已"解析"成具体值（种子必有，版本与桌规不依赖默认值） */
export interface StartParams {
  playerCount: number
  humanName: string
  seed: number
  variantId: GameVariantId
  houseRules: boolean
  /** 全员电脑（仿真 / 测试）：开局后把 0 号座位也改成电脑 */
  allAI?: boolean
  /** 开局时的电脑玩家（座位 1 起）：由种子决定，这里留底用于重放校验——人物表变了，旧日志就不再等价 */
  aiPlayers: Array<{ name: string; personaId?: string }>
}

/** 一条被引擎接受的动作 */
export interface ActionLogEntry {
  /** 在日志中的序号（从 0 起，连续） */
  index: number
  action: PlayerAction
  /** 提交前的 stateVersion（提交后恒为 +1） */
  versionBefore: number
  /**
   * 该动作产生的 id 区间 [eventFrom, eventTo]（闭区间）：事件与台词气泡共用 state.nextId，
   * 因此用 id 而不是数组下标——状态里只留最近 300 条事件，id 才是稳定的。
   * eventTo < eventFrom 表示没有产生任何 id。UI 要找"由这个动作产生的事件"：filter(e => e.id >= eventFrom && e.id <= eventTo)
   */
  eventFrom: number
  eventTo: number
  source: ActionSource
}

/** 重放所需的全部数据 */
export interface ReplayData {
  origin: StartParams
  log: readonly ActionLogEntry[]
}

/** 一局可持久化的完整内容（存档层与运行时之间的交换格式） */
export interface SavedGame {
  state: GameState
  /** 开局参数；null = 旧存档 / 非参数化开局，不可回放 */
  origin: StartParams | null
  /** 动作日志；origin 为 null 时恒为空 */
  log: ActionLogEntry[]
  /** origin + log 能否完整重放到 state */
  replayable: boolean
}

export class ReplayError extends Error {
  constructor(message: string, readonly step?: number) {
    super(step === undefined ? message : `第 ${step + 1} 步：${message}`)
    this.name = 'ReplayError'
  }
}

// ---------- 开局 ----------

export interface StartInput {
  playerCount: number
  humanName: string
  /** 省略则随机抽一个并记录下来 */
  seed?: number
  variantId?: GameVariantId
  houseRules?: boolean
  allAI?: boolean
}

/** 开一局并产出可重放的开局参数。随机种子在这里一次性定下来，之后一切确定 */
export function createGame(input: StartInput): { state: GameState; origin: StartParams } {
  const variant = getVariant(input.variantId)
  const seed = input.seed ?? randomSeed()
  const houseRules = input.houseRules ?? variant.houseRules
  const state = build(input.playerCount, input.humanName, seed, variant.id, houseRules, input.allAI)
  const origin: StartParams = {
    playerCount: state.players.length,
    humanName: state.players[0].name,
    seed,
    variantId: variant.id,
    houseRules,
    ...(input.allAI ? { allAI: true } : {}),
    aiPlayers: state.players.slice(1).map(p => ({ name: p.name, personaId: p.personaId })),
  }
  return { state, origin }
}

function build(playerCount: number, humanName: string, seed: number, variantId: GameVariantId, houseRules: boolean, allAI?: boolean): GameState {
  const state = createInitialState(playerCount, humanName, seed, variantId, { houseRules })
  if (allAI) for (const p of state.players) p.isAI = true
  return state
}

/** 按开局参数重建初始状态（stateVersion = 1） */
export function createStartState(origin: StartParams): GameState {
  const state = build(origin.playerCount, origin.humanName, origin.seed, origin.variantId, origin.houseRules, origin.allAI)
  const same = state.players.slice(1).every((p, i) => p.name === origin.aiPlayers[i]?.name && p.personaId === origin.aiPlayers[i]?.personaId)
  if (!same || state.players.length - 1 !== origin.aiPlayers.length) {
    throw new ReplayError('电脑玩家名单与日志记录的不一致（人物表在日志之后变过），无法重放')
  }
  return state
}

// ---------- 重放 ----------

export interface ReplayStep {
  /** 刚应用的日志条目 */
  entry: ActionLogEntry
  /** 应用之前 / 之后的状态（只读，不要修改） */
  before: GameState
  after: GameState
}

/**
 * 逐步重放迭代器：每步 yield 一次 { entry, before, after }。
 * 每步都校验：引擎接受动作、版本号衔接、事件 id 区间与日志一致；任何不符抛 ReplayError。
 * 复盘浏览器可以直接遍历它缓存各步状态，或配合 replayTo 取任意一步。
 */
export function* replaySteps(origin: StartParams, log: readonly ActionLogEntry[], upTo: number = log.length): Generator<ReplayStep, GameState, void> {
  let state = createStartState(origin)
  const end = Math.min(Math.max(0, upTo), log.length)
  for (let i = 0; i < end; i++) {
    const entry = log[i]
    if (entry.versionBefore !== state.stateVersion) {
      throw new ReplayError(`版本号不衔接：日志记录提交前为 ${entry.versionBefore}，重放得到 ${state.stateVersion}`, i)
    }
    const next = gameReducer(state, entry.action)
    if (!next || next === state) throw new ReplayError(`引擎拒绝了动作 ${entry.action.type}`, i)
    if (entry.eventFrom !== state.nextId || entry.eventTo !== next.nextId - 1) {
      throw new ReplayError(`事件 id 区间不一致：日志 [${entry.eventFrom}, ${entry.eventTo}]，重放 [${state.nextId}, ${next.nextId - 1}]`, i)
    }
    yield { entry, before: state, after: next }
    state = next
  }
  return state
}

/** 重放到第 step 步之后（0 = 开局状态，log.length = 终态；越界取边界） */
export function replayTo(origin: StartParams, log: readonly ActionLogEntry[], step: number = log.length): GameState {
  const it = replaySteps(origin, log, step)
  for (;;) {
    const r = it.next()
    if (r.done) return r.value
  }
}

/** 重放全部日志得到终态 */
export function replayAll(data: ReplayData): GameState {
  return replayTo(data.origin, data.log, data.log.length)
}

/** 按事件 id 找到产生它的那条日志（二分；区间是递增且互不重叠的）。找不到返回 null */
export function entryForEventId(log: readonly ActionLogEntry[], eventId: number): ActionLogEntry | null {
  let lo = 0, hi = log.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const e = log[mid]
    if (eventId < e.eventFrom) hi = mid - 1
    else if (eventId > e.eventTo) lo = mid + 1
    else return e
  }
  return null
}

// ---------- 比较 ----------

/** 深度比较两份（JSON 形态的）状态；返回第一处差异的路径与值，完全相等返回 null */
export function firstDifference(a: unknown, b: unknown, path = '$'): string | null {
  if (Object.is(a, b)) return null
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return `${path}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`
  const aIsArr = Array.isArray(a)
  if (aIsArr !== Array.isArray(b)) return `${path}: 数组 / 对象不一致`
  if (aIsArr) {
    const x = a as unknown[], y = b as unknown[]
    if (x.length !== y.length) return `${path}.length: ${x.length} ≠ ${y.length}`
    for (let i = 0; i < x.length; i++) {
      const d = firstDifference(x[i], y[i], `${path}[${i}]`)
      if (d) return d
    }
    return null
  }
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>
  const keys = new Set([...Object.keys(x), ...Object.keys(y)])
  for (const k of keys) {
    // undefined 与"缺字段"等价（JSON 往返会丢掉 undefined 字段）
    if (x[k] === undefined && y[k] === undefined) continue
    const d = firstDifference(x[k], y[k], `${path}.${k}`)
    if (d) return d
  }
  return null
}

/** 重放日志并与 expected 比较：一致返回 null，否则返回描述（第一处差异或重放失败原因） */
export function checkReplay(data: ReplayData, expected: GameState): string | null {
  try {
    return firstDifference(replayAll(data), expected)
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
