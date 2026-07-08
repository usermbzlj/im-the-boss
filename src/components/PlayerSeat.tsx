// ============================================================
// PlayerSeat — 环形桌游席位
// ============================================================

import type { GameState } from '../engine/types'
import FamilyChip from './FamilyChip'
import { getPersonaForPlayer } from '../ai/personas'

interface PlayerSeatProps {
  state: GameState
  playerId: number
  position: 'top' | 'right' | 'bottom' | 'left'
  stackIndex?: number
  stackTotal?: number
  isActing: boolean
}

export default function PlayerSeat({ state, playerId, position, stackIndex = 0, stackTotal = 1, isActing }: PlayerSeatProps) {
  const player = state.players[playerId]
  if (!player) return null

  const myInvestors = state.investors.filter(inv => inv.ownerPlayerId === playerId)
  const lastSpeech = [...(state.negotiation?.speeches ?? [])]
    .reverse()
    .find(s => s.playerId === playerId)
  const persona = player.isAI ? getPersonaForPlayer(player.personaId) : null
  const isThinking = state.thinkingPlayerId === playerId
  const isHuman = !player.isAI

  return (
    <div
      className={`player-seat pos-${position}${isActing ? ' acting' : ''}${player.isCurrentBoss ? ' is-boss' : ''}`}
      style={{
        ...(stackTotal > 1 ? {
          transform: position === 'top' || position === 'bottom'
            ? `translateX(${(stackIndex - (stackTotal - 1) / 2) * 110}px)`
            : `translateY(${(stackIndex - (stackTotal - 1) / 2) * 90}px)`,
        } : {}),
      }}
    >
      {player.isCurrentBoss && <div className="seat-crown">👑 Boss</div>}
      {isThinking && <div className="seat-thinking"><span className="dot" /><span className="dot" /><span className="dot" /></div>}
      {lastSpeech && (
        <div className="seat-bubble">「{lastSpeech.text}」</div>
      )}
      <div className="seat-avatar">{persona?.emoji ?? (isHuman ? '🧑' : '🤖')}</div>
      <div className="seat-name">
        {player.name}
        {isHuman && <span className="seat-you">你</span>}
      </div>
      <div className="seat-cash">${player.cash}M</div>
      <div className="seat-investors">
        {myInvestors.map(inv => {
          const travelled = state.investors.find(i => i.familyId === inv.familyId)?.isTravelled
          return (
            <FamilyChip key={inv.familyId} familyId={inv.familyId} size="sm" travelled={travelled} />
          )
        })}
        {myInvestors.length === 0 && <span className="seat-no-inv">无投资者</span>}
      </div>
      <div className="seat-meta">手牌 {player.hand.length}/12</div>
      {/* 名字与人格现在是绑定的同一身份（见 config.ts AI_ROSTER），
          player.name 与 persona.name 恒等，这里改显示人格风格描述，
          避免同一个名字在座位卡片上重复出现两次 */}
      {persona && <div className="seat-persona" title={persona.style}>{persona.style}</div>}
    </div>
  )
}

export function PublicMarket({ state }: { state: GameState }) {
  const neutral = state.investors.filter(inv => inv.ownerPlayerId === null)
  if (neutral.length === 0) return null
  return (
    <div className="public-market">
      <div className="market-title">📢 公共市场</div>
      <div className="market-hint">招募须优先从此处夺取</div>
      <div className="market-chips">
        {neutral.map(inv => (
          <FamilyChip key={inv.familyId} familyId={inv.familyId} size="md" />
        ))}
      </div>
    </div>
  )
}
