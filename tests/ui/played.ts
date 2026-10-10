// 复盘测试夹具：用仿真 harness 跑真实对局（启发式策略），拿到终局状态、开局参数、动作日志与录像。
// 同参数只跑一次（终局状态与录像只读，可以在测试间共享）。

import { runGame } from '../../src/sim/harness'
import { buildRecording, type Recording } from '../../src/ui/recording'
import type { GameState, GameVariantId } from '../../src/engine/types'
import type { ActionLogEntry, StartParams } from '../../src/game/replay'

export interface PlayedGame {
  state: GameState
  origin: StartParams
  log: ActionLogEntry[]
  recording: Recording
}

const cache = new Map<string, PlayedGame>()

export function playedGame(playerCount = 4, seed = 11, variantId: GameVariantId = 'classic', houseRules?: boolean): PlayedGame {
  const key = `${playerCount}:${seed}:${variantId}:${houseRules}`
  let hit = cache.get(key)
  if (!hit) {
    const r = runGame({ playerCount, seed, mode: 'heuristic', variantId, houseRules, checkReplay: true })
    if (!r.ok) throw new Error(`仿真失败：${r.reason}`)
    hit = { state: r.final, origin: r.origin, log: r.log, recording: buildRecording(r.origin, r.log) }
    cache.set(key, hit)
  }
  return hit
}

/** 一组覆盖不同人数 / 版本 / 桌规的对局（长局事件流会被截断，短局不会） */
export const SAMPLE_GAMES: Array<[number, number, GameVariantId, boolean?]> = [
  [3, 7, 'expansion'],
  [4, 11, 'classic'],
  [4, 5, 'full'],
  [5, 3, 'marathon'],
  [3, 21, 'classic', true],
  [5, 8, 'expansion', true],
]
