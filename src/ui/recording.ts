// ============================================================
// Recording — 一局的"录像"：把开局参数 + 动作日志重放一遍，整理成复盘 / 统计 / 精彩时刻共用的索引（纯逻辑，无 React）
//
//   · steps[i]   第 i 条日志（动作）产生的事件、所属交易、之后的现金；成交那一步还记着"成交前桌上有哪些代表"
//   · events     整局的全部事件（状态里只保留最近 300 条，这里是完整的）
//   · deals      每笔交易（成交与流局都占号，与 dealHistory 下标 + 1 一致）的起止步
//   · stateAt(p) 第 p 个位置的状态（p = 已应用的动作数；0 = 开局，length = 终局）。只存检查点，随机访问按需前推
//
// "位置" position 与"步" step 的关系：第 i 步（日志下标 i）的动作应用之后，就是位置 i + 1。
// 重放校验沿用 game/replay.ts：任何不一致抛 ReplayError，tryBuildRecording 把它吞成 null（= 不可复盘）。
// ============================================================

import type { FamilyId, GameState, LoggedEvent, PlayerAction, RepSource } from '../engine/types'
import { gameReducer } from '../engine/gameEngine'
import { createStartState, replaySteps, type ActionLogEntry, type StartParams } from '../game/replay'

/** 成交那一刻桌上的一个代表（成交前的快照） */
export interface TableRep {
  key: string
  ownerId: number
  familyId: FamilyId
  source: RepSource
  /** 已被旅行牌打飞 */
  travelled: boolean
}

/** 成交那一步附带的信息：谁是 Boss、桌上有哪些代表、方案用了哪些 */
export interface ClosingInfo {
  dealNo: number
  bossId: number
  table: TableRep[]
  usedKeys: string[]
}

export interface RecordedStep {
  /** 日志下标（= entry.index） */
  index: number
  entry: ActionLogEntry
  action: PlayerAction
  /** 该动作产生的事件（完整，不受 300 条上限影响） */
  events: LoggedEvent[]
  /** 该步属于第几次开单；谈判之外的步为 null */
  dealNo: number | null
  /** 该步之后各玩家的现金 */
  cash: number[]
  /** 仅"成交"那一步有 */
  closing?: ClosingInfo
}

export interface DealSpan {
  /** 第几次开单（成交与流局都占号） */
  dealNo: number
  /** 成交笔序（流局为 null）：与交易历史里"第 N 笔"一致 */
  dealNumber: number | null
  spaceId: number
  success: boolean
  bossId: number
  /** 开单那一步（DEAL_OPENED）的日志下标 */
  openStep: number
  /** 成交 / 流局那一步的日志下标 */
  endStep: number
}

/** 每隔多少步存一个状态检查点（越小跳转越快、占内存越多） */
const CHECKPOINT_EVERY = 48
/** 最近算出的状态缓存条数：连续前进 / 后退时命中 */
const CACHE_SIZE = 96

export class Recording {
  readonly length: number
  private readonly checkpoints = new Map<number, GameState>()
  private readonly cache = new Map<number, GameState>()
  private readonly eventStep = new Map<number, number>()

  constructor(
    readonly origin: StartParams,
    readonly log: readonly ActionLogEntry[],
    readonly steps: readonly RecordedStep[],
    readonly events: readonly LoggedEvent[],
    readonly deals: readonly DealSpan[],
    checkpoints: Iterable<[number, GameState]>,
    readonly finalState: GameState,
  ) {
    this.length = steps.length
    for (const [p, s] of checkpoints) this.checkpoints.set(p, s)
    this.checkpoints.set(this.length, finalState)
    steps.forEach((st, i) => { for (const e of st.events) this.eventStep.set(e.id, i) })
  }

  /** 第 position 个位置的状态（越界取边界）；返回值只读，不要修改 */
  stateAt(position: number): GameState {
    const p = Math.min(Math.max(0, Math.trunc(position)), this.length)
    const hit = this.cache.get(p) ?? this.checkpoints.get(p)
    if (hit) {
      if (this.cache.has(p)) { this.cache.delete(p); this.cache.set(p, hit) }
      return hit
    }
    // 从最近的已知状态（缓存或检查点）向前推
    let from = Math.floor(p / CHECKPOINT_EVERY) * CHECKPOINT_EVERY
    for (let q = p - 1; q > from; q--) {
      if (this.cache.has(q)) { from = q; break }
    }
    let s = this.cache.get(from) ?? this.checkpoints.get(from)
    if (!s) throw new Error(`复盘检查点缺失：${from}`)
    for (let i = from; i < p; i++) {
      const next = gameReducer(s, this.steps[i].action)
      if (!next) throw new Error(`复盘重放失败：第 ${i + 1} 步`)
      s = next
      if (i + 1 > from) this.remember(i + 1, s)
    }
    return s
  }

  private remember(p: number, s: GameState) {
    this.cache.set(p, s)
    if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value as number)
  }

  /** 导致第 position 个位置的那一步（position = 0 返回 null） */
  stepInto(position: number): RecordedStep | null {
    return position >= 1 && position <= this.length ? this.steps[position - 1] : null
  }

  /** 第 position 个位置时各玩家的现金（0 = 开局全 0） */
  cashAt(position: number): number[] {
    if (position <= 0) return this.finalState.players.map(() => 0)
    return this.steps[Math.min(position, this.length) - 1].cash
  }

  /** 事件 id → 产生它的步（日志下标） */
  stepOfEvent(eventId: number): number | null {
    return this.eventStep.get(eventId) ?? null
  }

  /** 第 dealNo 次开单的起止信息 */
  dealSpan(dealNo: number): DealSpan | null {
    return this.deals[dealNo - 1] ?? null
  }

  /**
   * 位置所处的交易：谈判中取当前交易；交易之间（掷骰 / 抽牌）取刚结束的那笔；还没开过单返回 0。
   * 用来在复盘里高亮"当前交易"、给事件流选 dealNo。
   */
  dealAtPosition(position: number): number {
    const p = Math.min(Math.max(0, position), this.length)
    let found = 0
    for (const d of this.deals) {
      if (d.openStep + 1 <= p) found = d.dealNo
      else break
    }
    return found
  }

  /** 一笔交易开单后的位置（Boss 刚宣布开单） */
  positionOpened(dealNo: number): number | null {
    const d = this.dealSpan(dealNo)
    return d ? d.openStep + 1 : null
  }

  /** 一笔交易结算后的位置（成交 / 流局刚发生） */
  positionClosed(dealNo: number): number | null {
    const d = this.dealSpan(dealNo)
    return d ? d.endStep + 1 : null
  }
}

/**
 * 增量构建器：一次重放整局，分片执行（run(budgetMs)）以免终局时卡住界面。
 * 同步场景（测试 / 脚本）直接用 buildRecording。
 */
export class RecordingBuilder {
  private readonly gen: Generator<{ entry: ActionLogEntry; before: GameState; after: GameState }, GameState, void>
  private readonly steps: RecordedStep[] = []
  private readonly events: LoggedEvent[] = []
  private readonly checkpoints: Array<[number, GameState]> = []
  private readonly open = new Map<number, { stepIndex: number }>()
  private readonly spans: DealSpan[] = []
  private finalState: GameState | null = null
  private done = false

  constructor(private readonly origin: StartParams, private readonly log: readonly ActionLogEntry[]) {
    this.gen = replaySteps(origin, log)
    this.checkpoints.push([0, createStartState(origin)])
  }

  get total(): number { return this.log.length }
  get processed(): number { return this.steps.length }
  get finished(): boolean { return this.done }

  /** 处理一步；返回是否已全部完成。重放校验失败时抛 ReplayError */
  private advance(): boolean {
    if (this.done) return true
    const r = this.gen.next()
    if (r.done) {
      this.finalState = r.value
      this.done = true
      return true
    }
    const { entry, before, after } = r.value
    const events = after.events.filter(e => e.id >= entry.eventFrom && e.id <= entry.eventTo)
    const index = this.steps.length
    const dealNo = before.negotiation ? before.dealHistory.length + 1 : after.negotiation ? after.dealHistory.length + 1 : null
    const step: RecordedStep = { index, entry, action: entry.action, events, dealNo, cash: after.players.map(p => p.cash) }

    for (const e of events) {
      this.events.push(e)
      if (e.kind === 'DEAL_OPENED' && e.dealNo != null) this.open.set(e.dealNo, { stepIndex: index })
      if ((e.kind === 'DEAL_CLOSED' || e.kind === 'DEAL_FAILED') && e.dealNo != null) {
        const opened = this.open.get(e.dealNo)
        const rec = after.dealHistory[e.dealNo - 1]
        if (opened && rec) {
          this.spans[e.dealNo - 1] = {
            dealNo: e.dealNo, dealNumber: rec.success ? rec.dealNumber : null, spaceId: rec.spaceId, success: rec.success,
            bossId: rec.bossId, openStep: opened.stepIndex, endStep: index,
          }
        }
        if (e.kind === 'DEAL_CLOSED' && before.negotiation) {
          const neg = before.negotiation
          step.closing = {
            dealNo: e.dealNo,
            bossId: neg.bossId,
            table: neg.reps.map(r => ({ key: r.key, ownerId: r.ownerId, familyId: r.familyId, source: r.source, travelled: r.travelled })),
            usedKeys: [...(neg.offer?.repKeys ?? [])],
          }
        }
      }
    }
    this.steps.push(step)
    if ((index + 1) % CHECKPOINT_EVERY === 0) this.checkpoints.push([index + 1, after])
    return false
  }

  /** 在时间预算内尽量多处理几步；返回是否全部完成 */
  run(budgetMs = 24): boolean {
    const t0 = Date.now()
    while (!this.done) {
      for (let i = 0; i < 16 && !this.advance(); i++) { /* 每 16 步看一次时钟 */ }
      if (this.done || Date.now() - t0 >= budgetMs) break
    }
    return this.done
  }

  result(): Recording {
    if (!this.done || !this.finalState) throw new Error('录像尚未构建完成')
    return new Recording(this.origin, this.log, this.steps, this.events, this.spans.filter(Boolean), this.checkpoints, this.finalState)
  }
}

/** 同步构建整局录像；日志与开局参数不自洽时抛 ReplayError */
export function buildRecording(origin: StartParams, log: readonly ActionLogEntry[]): Recording {
  const b = new RecordingBuilder(origin, log)
  b.run(Number.POSITIVE_INFINITY)
  return b.result()
}

/** 不抛异常的版本：不能重放（或与 expected 终态对不上）返回 null */
export function tryBuildRecording(origin: StartParams | null, log: readonly ActionLogEntry[], expected?: GameState | null): Recording | null {
  if (!origin) return null
  try {
    const rec = buildRecording(origin, log)
    return matchesState(rec, expected) ? rec : null
  } catch {
    return null
  }
}

/** 录像的终态与界面上的终局状态是否对得上（版本号 + 每人现金 + 交易笔数） */
export function matchesState(rec: Recording, expected?: GameState | null): boolean {
  if (!expected) return true
  const f = rec.finalState
  return f.stateVersion === expected.stateVersion
    && f.dealHistory.length === expected.dealHistory.length
    && f.players.length === expected.players.length
    && f.players.every((p, i) => p.cash === expected.players[i].cash)
}

/** 日志是否正好接在状态上（廉价的预检：空日志 ⇒ 刚开局；否则末条 versionBefore + 1 = 状态版本） */
export function logFitsState(log: readonly ActionLogEntry[], state: GameState): boolean {
  if (log.length === 0) return state.stateVersion === 1
  return log[log.length - 1].versionBefore + 1 === state.stateVersion
}
