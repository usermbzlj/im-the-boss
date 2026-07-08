// ============================================================
// CardHand — 玩家手牌
// ============================================================

import { useState } from 'react'
import type { InfluenceCard, GameState, GameAction } from '../engine/types'
import { FAMILIES } from '../engine/config'
import FamilyChip from './FamilyChip'

interface CardHandProps {
  state: GameState
  dispatch: React.Dispatch<GameAction>
}

const HUMAN_ID = 0
const CARD_LABELS: Record<string, string> = {
  CLAN: '家族', TRAVEL: '旅行', RECRUITMENT: '招募', BOSS: '老板', STOP: '阻止',
}

export default function CardHand({ state, dispatch }: CardHandProps) {
  const [selectedCardId, setSelectedCardId] = useState<number | null>(null)
  const player = state.players[HUMAN_ID]
  if (!player) return null

  const neg = state.negotiation
  const pw = state.pendingReactionWindow
  const myNegTurn = state.phase === 'NEGOTIATION' && !!neg && neg.turnPlayerId === HUMAN_ID
  const myReactTurn = state.phase === 'REACTION_WINDOW' && !!pw && pw.reactorId === HUMAN_ID
  const isHandLimit = state.phase === 'HAND_LIMIT_CHECK' && state.currentPlayerId === HUMAN_ID
  const isBoss = neg?.bossPlayerId === HUMAN_ID
  const recruitmentCards = player.hand.filter(c => c.type === 'RECRUITMENT')

  function canPlay(card: InfluenceCard): boolean {
    switch (card.type) {
      case 'STOP': return myReactTurn
      case 'CLAN': return myNegTurn
      case 'TRAVEL': return myNegTurn
      case 'BOSS': return myNegTurn && !isBoss
      case 'RECRUITMENT': return (myNegTurn || isHandLimit) && recruitmentCards.length >= 3
      default: return false
    }
  }

  const renderCardAction = (card: InfluenceCard) => {
    if (selectedCardId !== card.id) return null
    switch (card.type) {
      case 'CLAN':
        return (
          <button className="btn btn-success" onClick={() => {
            dispatch({ type: 'PLAY_CLAN', playerId: HUMAN_ID, cardId: card.id, familyId: card.familyId! })
            setSelectedCardId(null)
          }}>打出 {FAMILIES[card.familyId!].name}</button>
        )
      case 'TRAVEL': {
        const reps = (neg?.representatives ?? []).filter(
          r => !r.isTravelled && (!card.familyId || r.familyId === card.familyId),
        )
        if (!reps.length) return <span className="muted">无可打飞目标</span>
        return (
          <div className="card-targets">
            {reps.map((rep, i) => (
              <button key={i} className="btn" onClick={() => {
                dispatch({
                  type: 'PLAY_TRAVEL', playerId: HUMAN_ID, cardId: card.id,
                  targetFamilyId: rep.familyId,
                  targetCardId: rep.sourceType === 'CLAN' ? rep.cardId : undefined,
                })
                setSelectedCardId(null)
              }}>
                飞 {FAMILIES[rep.familyId].name}({rep.sourceType === 'CLAN' ? '卡' : '牌'})
              </button>
            ))}
          </div>
        )
      }
      case 'BOSS':
        return <button className="btn btn-danger" onClick={() => {
          dispatch({ type: 'PLAY_BOSS', playerId: HUMAN_ID })
          setSelectedCardId(null)
        }}>夺权！</button>
      case 'STOP':
        return <button className="btn btn-danger" onClick={() => {
          dispatch({ type: 'PLAY_STOP', playerId: HUMAN_ID })
          setSelectedCardId(null)
        }}>阻止！</button>
      case 'RECRUITMENT': {
        const hasNeutral = state.investors.some(inv => inv.ownerPlayerId === null)
        const targets = hasNeutral
          ? state.investors.filter(inv => inv.ownerPlayerId === null)
          : state.investors.filter(inv => inv.ownerPlayerId !== null && inv.ownerPlayerId !== HUMAN_ID)
        return (
          <div className="card-targets">
            {targets.map(inv => (
              <button key={inv.familyId} className="btn" onClick={() => {
                dispatch({
                  type: 'PLAY_RECRUITMENT', playerId: HUMAN_ID,
                  cardIds: recruitmentCards.slice(0, 3).map(c => c.id),
                  targetFamilyId: inv.familyId,
                })
                setSelectedCardId(null)
              }}>招募 {FAMILIES[inv.familyId].name}</button>
            ))}
          </div>
        )
      }
      default: return null
    }
  }

  // 我的常驻资本身份（投资者牌）与本局谈判打出的临时身份（家族成员卡）
  const myInvestors = state.investors.filter(inv => inv.ownerPlayerId === HUMAN_ID)
  const myTempReps = neg?.representatives.filter(
    r => r.ownerPlayerId === HUMAN_ID && r.sourceType === 'CLAN',
  ) ?? []

  return (
    <div className="hand-container">
      {/* 个人资产栏：现金 / 常驻资本 / 临时身份，一眼看清自己的谈判筹码 */}
      <div className="my-status-bar">
        <span className="status-cash" title="你的现金">💰 ${player.cash}M</span>
        <span className="status-group" title="你持有的投资者牌：长期资本身份，出差中表示本笔交易失效">
          <span className="status-label">常驻资本</span>
          {myInvestors.length > 0
            ? myInvestors.map(inv => (
              <FamilyChip key={inv.familyId} familyId={inv.familyId} size="md" travelled={inv.isTravelled} />
            ))
            : <span className="status-empty">无（可用招募三连获取）</span>}
        </span>
        {neg && (
          <span className="status-group" title="你在本笔谈判中打出的家族成员卡：临时身份，被选用成交后弃掉，未选用则收回">
            <span className="status-label">本局临时身份</span>
            {myTempReps.length > 0
              ? myTempReps.map((r, i) => (
                <FamilyChip key={i} familyId={r.familyId} size="md" travelled={r.isTravelled} />
              ))
              : <span className="status-empty">未打出家族卡</span>}
          </span>
        )}
      </div>
      <div className="hand-title">
        🃏 你的手牌 ({player.hand.length}/12)
        {isHandLimit && <span className="red"> — 超限！弃牌或招募三连</span>}
        {myReactTurn && <span className="gold"> — 可打阻止牌</span>}
        {myNegTurn && <span className="blue"> — 轮到你行动</span>}
      </div>
      <div className="hand-cards">
        {player.hand.map(card => {
          const playable = canPlay(card)
          return (
            <div
              key={card.id}
              className={`card${selectedCardId === card.id ? ' selected' : ''}${playable ? '' : ' disabled'}`}
              style={{ borderColor: card.familyId ? FAMILIES[card.familyId].color : undefined }}
              onClick={() => playable && setSelectedCardId(prev => prev === card.id ? null : card.id)}
            >
              <div className="card-type">{CARD_LABELS[card.type]}</div>
              <div className="card-name">
                {card.familyId ? (
                  <><span className="card-letter">{card.familyId}</span> {FAMILIES[card.familyId].name}</>
                ) : card.type === 'TRAVEL' ? '万能旅行' : CARD_LABELS[card.type]}
              </div>
              {selectedCardId === card.id && <div className="card-action">{renderCardAction(card)}</div>}
            </div>
          )
        })}
      </div>
      {isHandLimit && player.hand.length > 12 && (
        <button className="btn btn-danger" onClick={() => {
          const sorted = [...player.hand].sort((a, b) => {
            const p: Record<string, number> = { RECRUITMENT: 0, CLAN: 1, STOP: 2, TRAVEL: 3, BOSS: 4 }
            return (p[a.type] ?? 5) - (p[b.type] ?? 5)
          })
          dispatch({ type: 'DISCARD_CARDS', cardIds: sorted.slice(0, player.hand.length - 12).map(c => c.id) })
        }}>自动弃至12张</button>
      )}
    </div>
  )
}
