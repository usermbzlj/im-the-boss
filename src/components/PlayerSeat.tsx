// ============================================================
// PlayerSeat — 座位卡：名字 / 现金 / 投资者 / 手牌数 / 台词气泡 / 人物主题色 / 对你的态度
// ============================================================

import { useState } from 'react'
import type { CSSProperties } from 'react'
import type { GameState } from '../engine/types'
import { HAND_LIMIT, FAMILIES, LANDMARK_RENT } from '../engine/config'
import { isSick } from '../engine/rules'
import FamilyChip from './FamilyChip'
import AnimatedNumber from './AnimatedNumber'
import { getPersonaForPlayer } from '../ai/personas'
import type { Relation } from '../ai/relations'
import { monogram, seatColor } from '../ui/personaColor'
import { useViewerId } from './ViewerContext'

interface PlayerSeatProps {
  state: GameState
  playerId: number
  isActing: boolean
  isThinking: boolean
  /** 这位电脑玩家对视角玩家的态度（来自 relationsToward）；score = 0 / 省略 = 不显示 */
  relation?: Relation | null
}

/** 态度图标：-2 记仇 … +2 交好 */
const RELATION_ICON: Record<number, { icon: string; label: string }> = {
  [-2]: { icon: '😡', label: '对你很不满' },
  [-1]: { icon: '😠', label: '对你有些不满' },
  [1]: { icon: '🙂', label: '对你有好感' },
  [2]: { icon: '🤝', label: '和你交情不错' },
}

export default function PlayerSeat({ state, playerId, isActing, isThinking, relation }: PlayerSeatProps) {
  const viewerId = useViewerId()
  /** 点开的气泡（记台词原文：换了新台词自动收起） */
  const [openBubble, setOpenBubble] = useState<string | null>(null)
  const player = state.players[playerId]
  if (!player) return null
  const isViewer = playerId === viewerId
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
  const landmarks = state.board.filter(b => b.landlordId === playerId)
  const color = seatColor(player, viewerId)
  const style = { '--seat-accent': color.accent, '--seat-soft': color.soft } as CSSProperties
  const speech = player.lastSpeech
  const expanded = !!speech && openBubble === speech
  const att = !isViewer && relation && relation.score !== 0 ? RELATION_ICON[relation.score] : null

  return (
    <div className={`player-seat${isActing ? ' acting' : ''}${isBoss ? ' is-boss' : ''}${isViewer ? ' is-human' : ''}`} style={style} data-seat-id={playerId}>
      {speech && (
        <button
          key={speech}
          type="button"
          className={`seat-bubble${expanded ? ' expanded' : ''}`}
          title={expanded ? '点击收起' : '点击查看全文'}
          aria-expanded={expanded}
          onClick={() => setOpenBubble(expanded ? null : speech)}
        >
          {speech}
        </button>
      )}
      <div className="seat-head">
        <span className="seat-avatar" aria-hidden="true">{monogram(player.name)}</span>
        <div className="seat-title">
          <div className="seat-name">
            {player.name}
            {isViewer && <span className="seat-you">你</span>}
            {isBoss && <span className="seat-boss">👑 Boss</span>}
            {att && (
              <span className="seat-relation" role="img" aria-label={att.label}
                title={`${persona?.name ?? player.name}${att.label}${relation!.reasons.length ? `：\n${relation!.reasons.join('\n')}` : ''}`}>
                {att.icon}
              </span>
            )}
          </div>
          <div className="seat-sub" title={persona?.title}>
            {persona ? persona.title.split(' · ')[0] : '人类玩家'}
          </div>
        </div>
        <div className="seat-cash"><AnimatedNumber value={player.cash} format={n => `$${n}M`} /></div>
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
        {player.reclaim && (
          <span className="seat-reclaim" title={`最后一位常驻投资者被夺走：只需 1 张招募牌即可抢回 ${FAMILIES[player.reclaim].name}`}>
            夺回权 {player.reclaim}
          </span>
        )}
        {isSick(state, player.id) && (
          <span className="seat-sick" title="病假牌生效：本回合内不能主动出牌 / 换牌，只能被动打阻止牌">🤒 病假</span>
        )}
        {landmarks.length > 0 && (
          <span className="seat-landmark" title={`地标主人：${landmarks.map(b => `#${b.id}`).join('、')}，每笔成交各收 $${LANDMARK_RENT}M`}>
            🏛×{landmarks.length}
          </span>
        )}
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
