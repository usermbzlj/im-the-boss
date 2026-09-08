// ============================================================
// PlayerSeat — 座位卡：名字 / 现金 / 投资者 / 手牌数 / 台词气泡
// ============================================================

import type { GameState } from '../engine/types'
import { HAND_LIMIT, FAMILIES } from '../engine/config'
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
  const demands = neg?.demands.filter(d => d.playerId === playerId) ?? []
  // 报价按家族分列；只有一条时不标家族名
  const demandLabel = demands.length === 0 ? null
    : demands.length === 1 ? `要价 $${demands[0].amount}M`
      : demands.map(d => `${d.familyId ? FAMILIES[d.familyId].name : '封口'} $${d.amount}M`).join(' · ')

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
        {demandLabel && <span className="seat-demand" title="公开报价（每个代表的出借价）：Boss 付到即自动同意">{demandLabel}</span>}
        {myShare != null && myShare > 0 && <span className="seat-share">方案 +${myShare}M</span>}
        {isThinking && <span className="seat-thinking"><span className="dot" /><span className="dot" /><span className="dot" /></span>}
      </div>
    </div>
  )
}
