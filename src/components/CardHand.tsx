// ============================================================
// CardHand — 人类手牌：可打的牌由合法动作列表驱动，点牌弹出目标/参数选择
// ============================================================

import { useEffect, useRef, useState } from 'react'
import type { InfluenceCard, GameState, PlayerAction, FamilyId } from '../engine/types'
import { FAMILIES, HAND_LIMIT } from '../engine/config'
import { findRep, oneShareOf } from '../engine/rules'

interface CardHandProps {
  state: GameState
  legal: PlayerAction[]
  act: (action: PlayerAction) => void
  discardMode: boolean
  discardSelection: Set<number>
  onToggleDiscard: (cardId: number) => void
}

const HUMAN_ID = 0
const TYPE_LABEL: Record<InfluenceCard['type'], string> = { CLAN: '家族成员', TRAVEL: '旅行', RECRUITMENT: '招募', BOSS: '老板', STOP: '阻止' }
const TYPE_ICON: Record<InfluenceCard['type'], string> = { CLAN: '👤', TRAVEL: '✈️', RECRUITMENT: '📋', BOSS: '👑', STOP: '🛑' }

function actionsForCard(legal: PlayerAction[], card: InfluenceCard): PlayerAction[] {
  return legal.filter(action => {
    switch (action.type) {
      case 'PLAY_CLAN': return action.cardId === card.id
      case 'PLAY_TRAVEL': return action.cardId === card.id
      case 'PLAY_BOSS': return action.cardId === card.id
      case 'PLAY_RECRUITMENT': return action.cardIds.includes(card.id)
      case 'PLAY_STOP': return card.type === 'STOP'
      default: return false
    }
  })
}

export default function CardHand({ state, legal, act, discardMode, discardSelection, onToggleDiscard }: CardHandProps) {
  const [openCardId, setOpenCardId] = useState<number | null>(null)
  const [popoverLeft, setPopoverLeft] = useState(0)
  const [clanDemand, setClanDemand] = useState<string>('')
  const [clanText, setClanText] = useState('')
  const handRef = useRef<HTMLDivElement>(null)
  // 状态推进后关闭弹层（牌可能已不可打 / 目标已变化）
  useEffect(() => { setOpenCardId(null) }, [state.stateVersion])
  // 点击弹层与手牌以外的区域关闭弹层
  useEffect(() => {
    if (openCardId == null) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest('.card-popover') || t?.closest('.card')) return
      setOpenCardId(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [openCardId])
  const player = state.players[HUMAN_ID]
  if (!player) return null

  /** 弹层挂在 .hand 下而不是横向滚动的 .hand-cards 内，避免被 overflow 裁切 */
  const openPopoverAt = (cardId: number, el: HTMLElement) => {
    const hand = handRef.current
    if (hand) {
      const hr = hand.getBoundingClientRect()
      const cr = el.getBoundingClientRect()
      const width = 300
      setPopoverLeft(Math.max(8, Math.min(cr.left - hr.left, hr.width - width - 8)))
    }
    setOpenCardId(cardId)
  }

  const neg = state.negotiation
  const recruitCount = player.hand.filter(c => c.type === 'RECRUITMENT').length
  const openCard = player.hand.find(c => c.id === openCardId) ?? null
  const openActions = openCard ? actionsForCard(legal, openCard) : []

  const fire = (action: PlayerAction) => {
    act(action)
    setOpenCardId(null)
    setClanDemand('')
    setClanText('')
  }

  const renderPopover = (card: InfluenceCard) => {
    switch (card.type) {
      case 'CLAN': {
        const base = openActions.find(a => a.type === 'PLAY_CLAN')
        if (!base || base.type !== 'PLAY_CLAN') return null
        const suggest = oneShareOf(state)
        return (
          <div className="popover-body">
            <div className="popover-title">打出 {FAMILIES[card.familyId!].name} 家族成员卡，成为该家族的临时代表</div>
            <label className="popover-field">
              出借价（$M，可空）
              <input type="number" min={0} value={clanDemand} placeholder={`建议 ${suggest}`} onChange={e => setClanDemand(e.target.value)} />
            </label>
            <label className="popover-field">
              台词（可空）
              <input value={clanText} maxLength={60} placeholder="例：我家的人到了，谈个价吧" onChange={e => setClanText(e.target.value)} />
            </label>
            <button className="btn btn-success" onClick={() => {
              const d = clanDemand.trim() === '' ? undefined : Math.max(0, Math.floor(Number(clanDemand) || 0))
              fire({ ...base, demand: d, say: clanText.trim() || undefined })
            }}>打出</button>
          </div>
        )
      }
      case 'TRAVEL':
        return (
          <div className="popover-body">
            <div className="popover-title">{card.familyId ? `旅行牌（${FAMILIES[card.familyId].name}）` : '万能旅行牌'}：选择要打飞的代表</div>
            <div className="popover-targets">
              {openActions.map((a, i) => {
                if (a.type !== 'PLAY_TRAVEL' || !neg) return null
                const rep = findRep(neg, a.targetRepKey)!
                const owner = state.players[rep.ownerId]
                const inOffer = neg.offer?.repKeys.includes(rep.key)
                return (
                  <button key={i} className="btn target-btn" onClick={() => fire(a)}
                    style={{ borderColor: FAMILIES[rep.familyId].color }}>
                    {owner?.name}{rep.ownerId === HUMAN_ID ? '（你）' : ''} 的 {FAMILIES[rep.familyId].name}
                    <em>{rep.source === 'INVESTOR' ? '投资者' : '家族卡'}{inOffer ? ' ★方案中' : ''}</em>
                  </button>
                )
              })}
            </div>
          </div>
        )
      case 'RECRUITMENT':
        return (
          <div className="popover-body">
            <div className="popover-title">招募三连：选择要夺取的投资者（消耗 3 张招募牌）</div>
            <div className="popover-targets">
              {openActions.map((a, i) => {
                if (a.type !== 'PLAY_RECRUITMENT') return null
                const f: FamilyId = a.targetFamilyId
                const owner = state.investors.find(inv => inv.familyId === f)?.ownerId
                return (
                  <button key={i} className="btn target-btn" style={{ borderColor: FAMILIES[f].color }} onClick={() => fire(a)}>
                    {FAMILIES[f].name}<em>{owner == null ? '公共区' : `来自 ${state.players[owner]?.name}`}</em>
                  </button>
                )
              })}
            </div>
          </div>
        )
      case 'BOSS': {
        const a = openActions.find(x => x.type === 'PLAY_BOSS')
        return a ? (
          <div className="popover-body">
            <div className="popover-title">"I'm the Boss!" 夺取 {state.players[neg!.bossId]?.name} 的 Boss 身份，原方案作废</div>
            <button className="btn btn-danger" onClick={() => fire(a)}>夺权</button>
          </div>
        ) : null
      }
      case 'STOP': {
        const a = openActions.find(x => x.type === 'PLAY_STOP')
        return a ? (
          <div className="popover-body">
            <div className="popover-title">打出阻止牌，取消 {state.players[state.pendingReaction!.actorId]?.name} 刚打出的牌</div>
            <button className="btn btn-danger" onClick={() => fire(a)}>阻止！</button>
          </div>
        ) : null
      }
    }
  }

  return (
    <div className="hand" ref={handRef}>
      {openCard && !discardMode && openActions.length > 0 && (
        <div className="card-popover" style={{ left: popoverLeft }} onClick={e => e.stopPropagation()}>
          {renderPopover(openCard)}
          <button className="popover-close" onClick={() => setOpenCardId(null)}>×</button>
        </div>
      )}
      <div className="hand-title">
        <span>你的手牌 {player.hand.length}/{HAND_LIMIT}</span>
        {discardMode && <span className="red">点选要弃的牌</span>}
        {recruitCount > 0 && recruitCount < 3 && <span className="muted">招募 {recruitCount}/3</span>}
      </div>
      <div className="hand-cards">
        {player.hand.map(card => {
          const playable = !discardMode && actionsForCard(legal, card).length > 0
          const selected = discardSelection.has(card.id)
          const open = openCardId === card.id
          const color = card.familyId ? FAMILIES[card.familyId].color : undefined
          return (
            <div key={card.id} className="card-slot">
              <div
                className={`card type-${card.type.toLowerCase()}${playable ? ' playable' : ''}${open ? ' open' : ''}${selected ? ' selected' : ''}${discardMode ? ' discard-mode' : ''}${!playable && !discardMode ? ' idle' : ''}`}
                style={color ? { borderColor: color } : undefined}
                onClick={e => {
                  if (discardMode) onToggleDiscard(card.id)
                  else if (playable) { if (open) setOpenCardId(null); else openPopoverAt(card.id, e.currentTarget) }
                }}
                title={discardMode ? '点击选择/取消弃牌' : playable ? '点击查看可执行的操作' : '当前不可打出'}
              >
                <div className="card-type">{TYPE_ICON[card.type]} {TYPE_LABEL[card.type]}</div>
                <div className="card-name" style={color ? { color } : undefined}>
                  {card.familyId ? <><span className="card-letter" style={{ background: color }}>{card.familyId}</span>{FAMILIES[card.familyId].name}</>
                    : card.type === 'TRAVEL' ? '万能' : card.type === 'RECRUITMENT' ? '×3 成组' : card.type === 'BOSS' ? '夺权' : '取消'}
                </div>
                {selected && <div className="card-discard-mark">弃</div>}
              </div>
            </div>
          )
        })}
        {player.hand.length === 0 && <span className="muted">空手</span>}
      </div>
    </div>
  )
}
