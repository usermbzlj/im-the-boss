// ============================================================
// GameOverCard — 终局结果卡：胜者 + 最终排名（并列同名次）
// ============================================================

import type { GameState, Player } from '../engine/types'
import { useViewerId } from './ViewerContext'

export interface Standing {
  player: Player
  /** 名次：现金相同者同名次（1、1、3 的竞赛排名） */
  rank: number
  /** 与别人并列该名次 */
  tied: boolean
}

/** 按现金降序排名；现金相同并列同一名次，之后的名次跳过（1、1、3） */
export function rankStandings(players: Player[]): Standing[] {
  const sorted = [...players].sort((a, b) => b.cash - a.cash)
  return sorted.map(player => {
    const rank = 1 + sorted.filter(p => p.cash > player.cash).length
    return { player, rank, tied: sorted.filter(p => p.cash === player.cash).length > 1 }
  })
}

interface GameOverCardProps {
  state: GameState
  onRestart: () => void
  onReview: () => void
}

export default function GameOverCard({ state, onRestart, onReview }: GameOverCardProps) {
  const viewerId = useViewerId()
  const standings = rankStandings(state.players)
  return (
    <div className="modal-overlay">
      <div className="game-over-card" role="dialog" aria-label="游戏结束">
        <h2>🎉 游戏结束</h2>
        <p className="winner-name">
          {state.winnerIds.map(id => state.players[id].name).join('、')}{state.winnerIds.length > 1 ? ' 并列' : ''}获胜！
        </p>
        <div className="final-standings">
          {standings.map(({ player: p, rank, tied }) => (
            <div key={p.id} className={`standing${state.winnerIds.includes(p.id) ? ' winner' : ''}`} data-rank={rank}>
              <span>{rank}{tied ? '（并列）' : ''}. {p.name}{p.id === viewerId ? '（你）' : ''}</span>
              <span>${p.cash}M</span>
            </div>
          ))}
        </div>
        <div className="neg-actions">
          <button className="btn-primary" onClick={onRestart}>再来一局</button>
          <button className="btn" onClick={onReview}>回牌桌复盘</button>
        </div>
      </div>
    </div>
  )
}
