// ============================================================
// 自动存档（带节流）
//
// 写入频率评估：一个状态约 80–120 KB JSON（含最近 300 条事件、牌堆、版图），电脑玩家每 0.4–1.5 秒一步，
// 每步全量序列化 + 写入会让主线程与磁盘白白忙碌。因此：
//   · 状态（head）节流：脏了之后最多每 throttleMs 写一次，写的永远是最新状态；
//   · 动作日志分块（见 utils/storage.ts），只重写最后一块，体积与步数无关；
//   · 终局、销毁会话、页面隐藏时立即落盘，不丢最后一步。
// throttleMs <= 0 表示每次变化同步写（测试 / 仿真）。
// ============================================================

import type { GameState } from '../engine/types'
import type { SavedGame } from './replay'

export interface SaveSink {
  save(game: SavedGame): boolean
}

export interface AutosaveOptions {
  /** 两次写入的最小间隔（毫秒）。默认 400；<= 0 同步写 */
  throttleMs?: number
  /** 可注入的定时器（测试用） */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export const DEFAULT_SAVE_THROTTLE_MS = 400

export class Autosaver {
  private dirty = false
  private timer: unknown = null
  private source: { toSaved(): SavedGame } | null = null
  private readonly throttleMs: number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly sink: SaveSink, opts: AutosaveOptions = {}) {
    this.throttleMs = opts.throttleMs ?? DEFAULT_SAVE_THROTTLE_MS
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = opts.clearTimer ?? (h => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  /** 绑定要保存的会话，并立刻写入当前状态（刚开局 / 刚续局就能"继续上一局"） */
  attach(source: { toSaved(): SavedGame }) {
    this.source = source
    this.dirty = true
    this.flush()
  }

  /** 状态变化时调用 */
  touch(state: GameState) {
    this.dirty = true
    if (state.phase === 'GAME_OVER' || this.throttleMs <= 0) return this.flush()
    if (this.timer === null) this.timer = this.setTimer(() => { this.timer = null; this.flush() }, this.throttleMs)
  }

  /** 立即把最新状态写下去（无变化则不写） */
  flush() {
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null }
    if (!this.dirty || !this.source) return
    this.dirty = false
    this.sink.save(this.source.toSaved())
  }
}
