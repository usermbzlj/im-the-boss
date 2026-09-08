// ============================================================
// PlayerSeat — 座位卡：名字 / 现金 / 投资者 / 手牌数 / 台词气泡
// ============================================================

import type { GameState } from '../engine/types'
import { HAND_LIMIT } from '../engine/config'
import FamilyChip from './FamilyChip'
import { getPersonaForPlayer } from '../ai/personas'

interface PlayerSeatProps {
  state: GameState
  playerId: number
  isActing: boolean
  isThinking: boolean
}

export default function PlayerSeat({ state, playerId, isActing, isThinking }: PlayerSeatProps) {
  const player = state.players[playerId]
  if (!player) return null
  const neg = state.negotiation
  const isBoss = neg?.bossId === playerId
  const travelled = new Set(neg?.travelledInvestors ?? [])
  const myInvestors = state.investors.filter(inv => inv.ownerId === playerId)
  const myClanReps = neg?.reps.filter(r => r.source === 'CLAN' && r.ownerId === playerId && !r.travelled) ?? []
  const persona = player.isAI ? getPersonaForPlayer(player.personaId) : null
  const myShare = neg?.offer?.payouts.find(p => p.playerId === playerId)?.amount
  const demand = neg?.demands.find(d => d.playerId === playerId)

  return (
    <div className={`player-seat${isActing ? ' acting' : ''}${isBoss ? ' is-boss' : ''}${player.isAI ? '' : ' is-human'}`}>
      {player.lastSpeech && <div className="seat-bubble" title={player.lastSpeech}>{player.lastSpeech}</div>}
      <div className="seat-head">
        <span className="seat-avatar">{persona?.emoji ?? '🧑'}</span>
        <div className="seat-title">
          <div className="seat-name">
            {player.name}
            {!player.isAI && <span className="seat-you">你</span>}
            {isBoss && <span className="seat-boss">👑 Boss</span>}
          </div>
          <div className="seat-sub">
            {persona ? persona.style : '人类玩家'}
          </div>
        </div>
        <div className="seat-cash">${player.cash}M</div>
      </div>
      <div className="seat-row">
        <span className="seat-label">投资者</span>
        {myInvestors.length === 0 && <span className="seat-empty">无</span>}
        {myInvestors.map(inv => (
          <FamilyChip key={inv.familyId} familyId={inv.familyId} size="sm" travelled={travelled.has(inv.familyId)} />
        ))}
        {myClanReps.map(r => (
          <FamilyChip key={r.key} familyId={r.familyId} size="sm" kind="optional" />
        ))}
      </div>
      <div className="seat-row seat-meta">
        <span>手牌 {player.hand.length}/{HAND_LIMIT}</span>
        {demand && <span className="seat-demand">要价 ${demand.amount}M</span>}
        {myShare != null && myShare > 0 && <span className="seat-share">方案 +${myShare}M</span>}
        {isThinking && <span className="seat-thinking"><span className="dot" /><span className="dot" /><span className="dot" /></span>}
      </div>
    </div>
  )
}
