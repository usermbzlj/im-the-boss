// ============================================================
// 复盘数据的一站式入口：统计 + 精彩时刻（纯函数，GameOverCard / DealHistoryPanel / ReplayViewer 共用）
// ============================================================

import type { GameState } from '../engine/types'
import { computeStats, type GameStats } from './stats'
import { computeHighlights, type Highlight } from './highlights'
import type { Recording } from './recording'

export interface GameReview {
  stats: GameStats
  highlights: Highlight[]
}

/** 有录像（动作日志重放）时数据最完整；没有录像只用交易历史 */
export function buildReview(state: GameState, recording?: Recording | null): GameReview {
  const stats = computeStats(state, recording)
  return { stats, highlights: computeHighlights(state, stats, recording) }
}

/** 某笔交易上的精彩标签（交易历史面板用） */
export function highlightsOfDeal(highlights: readonly Highlight[], dealNo: number): Highlight[] {
  return highlights.filter(h => h.dealNo === dealNo)
}
