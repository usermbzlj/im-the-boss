// ============================================================
// 终局名次（纯函数）：现金相同并列同一名次，之后的名次跳过（1、1、3）
// 终局卡、统计与复盘共用；GameOverCard 仍再导出 rankStandings / Standing，保持旧引用不变。
// ============================================================

import type { Player } from '../engine/types'

export interface Standing {
  player: Player
  /** 名次：现金相同者同名次（1、1、3 的竞赛排名） */
  rank: number
  /** 与别人并列该名次 */
  tied: boolean
}

/** 按现金降序排名；现金相同并列同一名次，之后的名次跳过（1、1、3）。现金相同时保持座位顺序 */
export function rankStandings(players: Player[]): Standing[] {
  const sorted = [...players].sort((a, b) => b.cash - a.cash)
  return sorted.map(player => {
    const rank = 1 + sorted.filter(p => p.cash > player.cash).length
    return { player, rank, tied: sorted.filter(p => p.cash === player.cash).length > 1 }
  })
}
