// ============================================================
// CardHand — 人类手牌：可打的牌由合法动作列表驱动，点牌弹出目标/参数选择
// ============================================================

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react'
import type { InfluenceCard, GameState, PlayerAction, FamilyId } from '../engine/types'
import { FAMILIES, HAND_LIMIT, BOOM_BONUS, BUST_PENALTY } from '../engine/config'
import { findRep, oneShareOf, canReclaim, recruitCost, standardRecruitCost, getGrossValue, swapTargetType, isSick } from '../engine/rules'
import { grossAfterDelta } from '../text/labels'
import { cardFace } from '../ui/cardInfo'
import { useViewerId } from './ViewerContext'

/** 手牌多选模式：弃牌（超上限）/ 兑换（桌规：两张异类牌换招募） */
export type HandSelectMode = 'discard' | 'trade' | null

interface CardHandProps {
  state: GameState
  legal: PlayerAction[]
  act: (action: PlayerAction) => void
  selectMode: HandSelectMode
  selection: Set<number>
  onToggleSelect: (cardId: number) => void
}

/** 新抽到的牌保留"新"标记的时间（毫秒） */
export const NEW_CARD_MS = 2800
/** 悬停多久后放大（毫秒）/ 触屏长按多久后放大 */
const HOVER_ZOOM_MS = 280
const LONG_PRESS_MS = 450
const ZOOM_WIDTH = 268

/** 键盘聚焦才放大（鼠标点击聚焦不算）；不支持 :focus-visible 的环境一律当作键盘聚焦 */
function focusVisible(el: HTMLElement): boolean {
  try { return el.matches(':focus-visible') } catch { return true }
}

/**
 * 跟踪"新进手牌"的牌：渲染后对比上一次的手牌 id，新增的标记 NEW_CARD_MS 毫秒。
 * 首次渲染（含载入存档）不算新；打出 / 弃掉的牌离开不影响其他牌。
 */
function useFreshCards(ids: readonly number[]): Set<number> {
  const prev = useRef<Set<number> | null>(null)
  const [fresh, setFresh] = useState<ReadonlySet<number>>(new Set())
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const key = ids.join(',')

  useLayoutEffect(() => {
    const before = prev.current
    prev.current = new Set(ids)
    if (!before) return
    const added = ids.filter(id => !before.has(id))
    if (added.length === 0) return
    setFresh(cur => new Set([...cur, ...added]))
    const h = setTimeout(() => {
      timers.current.delete(h)
      setFresh(cur => new Set([...cur].filter(id => !added.includes(id))))
    }, NEW_CARD_MS)
    timers.current.add(h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => () => { timers.current.forEach(clearTimeout); timers.current.clear() }, [])
  return new Set([...fresh].filter(id => ids.includes(id)))
}
function actionsForCard(legal: PlayerAction[], card: InfluenceCard): PlayerAction[] {
  return legal.filter(action => {
    switch (action.type) {
      case 'PLAY_CLAN': return action.cardId === card.id
      case 'PLAY_TRAVEL': return action.cardId === card.id
      case 'PLAY_BOSS': return action.cardId === card.id
      case 'PLAY_BOOM': return action.cardId === card.id
      case 'PLAY_BUST': return action.cardId === card.id
      case 'PLAY_EXCLUSIVE': return action.cardId === card.id
      case 'PLAY_SICK': return action.cardId === card.id
      case 'SWAP_CARD': return action.cardId === card.id
      case 'PLAY_RECRUITMENT': return action.cardIds.includes(card.id)
      case 'PLAY_STOP': return card.type === 'STOP'
      default: return false
    }
  })
}

export default function CardHand({ state, legal, act, selectMode, selection, onToggleSelect }: CardHandProps) {
  const viewerId = useViewerId()
  const [openCardId, setOpenCardId] = useState<number | null>(null)
  const [popoverLeft, setPopoverLeft] = useState(0)
  const [clanDemand, setClanDemand] = useState<string>('')
  const [clanText, setClanText] = useState('')
  const handRef = useRef<HTMLDivElement>(null)
  const [zoomId, setZoomId] = useState<number | null>(null)
  const [zoomLeft, setZoomLeft] = useState(0)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 长按放大之后的那次 click 不应当触发"打牌" */
  const suppressClick = useRef(false)
  const fresh = useFreshCards((state.players[viewerId]?.hand ?? []).map(c => c.id))
  const clearTimers = () => {
    if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null }
    if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null }
  }
  useEffect(() => clearTimers, [])
  // 状态推进后关闭弹层（牌可能已不可打 / 目标已变化）
  useEffect(() => { setOpenCardId(null); setZoomId(null) }, [state.stateVersion])
  // 放大预览：点击空白处（触屏长按后）收起
  useEffect(() => {
    if (zoomId == null) return
    const onDown = (e: Event) => { if (!(e.target as HTMLElement | null)?.closest('.card')) setZoomId(null) }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [zoomId])
  // 点击弹层与手牌以外的区域关闭弹层
  useEffect(() => {
    if (openCardId == null) return
    const onDown = (e: Event) => {
      const t = e.target as HTMLElement | null
      if (t?.closest('.card-popover') || t?.closest('.card')) return
      setOpenCardId(null)
    }
    // pointerdown：触屏轻点空白处同样收起（mousedown 在部分触屏浏览器上延迟 / 不触发）
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [openCardId])
  // 键盘：弹层打开后焦点进入弹层第一个控件；Esc 收起并把焦点还给那张牌
  useEffect(() => {
    if (openCardId == null) return
    const pop = handRef.current?.querySelector<HTMLElement>('.card-popover')
    pop?.querySelector<HTMLElement>('input, button:not(.popover-close)')?.focus({ preventScroll: true })
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      setOpenCardId(null)
      handRef.current?.querySelector<HTMLElement>(`[data-card-id="${openCardId}"]`)?.focus({ preventScroll: true })
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [openCardId])
  const player = state.players[viewerId]
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
    setZoomId(null)
    setOpenCardId(cardId)
  }

  /** 放大预览挂在 .hand 下（同弹层），位置贴着那张牌 */
  const showZoom = (cardId: number, el: HTMLElement) => {
    const hand = handRef.current
    if (hand) {
      const hr = hand.getBoundingClientRect()
      const cr = el.getBoundingClientRect()
      setZoomLeft(Math.max(8, Math.min(cr.left - hr.left, hr.width - ZOOM_WIDTH - 8)))
    }
    setZoomId(cardId)
  }

  const neg = state.negotiation
  const recruitCount = player.hand.filter(c => c.type === 'RECRUITMENT').length
  const recruitNeed = standardRecruitCost(state)
  const openCard = player.hand.find(c => c.id === openCardId) ?? null
  const zoomCard = player.hand.find(c => c.id === zoomId) ?? null
  const openActions = openCard ? actionsForCard(legal, openCard) : []

  const fire = (action: PlayerAction) => {
    act(action)
    setOpenCardId(null)
    setClanDemand('')
    setClanText('')
  }

  /** 桌规换牌按钮：家族成员卡 ↔ 同家族旅行牌（有该家族投资者时，每回合一次） */
  const renderSwap = (card: InfluenceCard) => {
    const a = openActions.find(x => x.type === 'SWAP_CARD')
    if (!a || !card.familyId) return null
    const fam = FAMILIES[card.familyId].name
    const toTravel = swapTargetType(card) === 'TRAVEL'
    return (
      <div className="popover-swap">
        <div className="popover-title muted">
          {toTravel
            ? `桌规·换牌：你有 ${fam} 投资者，这张成员卡多余——可换成 ${fam} 旅行牌，用来打飞别人的 ${fam} 代表（本回合限一次）`
            : `桌规·换牌：这张 ${fam} 旅行牌可换回 ${fam} 成员卡，在你的投资者被打飞时补位（本回合限一次）`}
        </div>
        <button className="btn" onClick={() => fire(a)}>🔁 换成 {fam} {toTravel ? '旅行牌' : '成员卡'}</button>
      </div>
    )
  }

  const renderPopover = (card: InfluenceCard) => {
    switch (card.type) {
      case 'CLAN': {
        const base = openActions.find(a => a.type === 'PLAY_CLAN')
        const swap = renderSwap(card)
        if (!base || base.type !== 'PLAY_CLAN') return swap ? <div className="popover-body">{swap}</div> : null
        const suggest = oneShareOf(state)
        const iAmBoss = state.negotiation?.bossId === viewerId
        return (
          <div className="popover-body">
            <div className="popover-title">
              {iAmBoss
                ? `打出 ${FAMILIES[card.familyId!].name} 家族成员卡：你自己的代表，免费，不用再买别人的`
                : `打出 ${FAMILIES[card.familyId!].name} 家族成员卡，成为该家族的临时代表`}
            </div>
            {!iAmBoss && (
              <label className="popover-field">
                承诺价（$M / 每个代表，可空；Boss 付到即自动同意）
                <input type="number" min={0} value={clanDemand} placeholder={`建议 ${suggest}`} onChange={e => setClanDemand(e.target.value)} />
              </label>
            )}
            <label className="popover-field">
              台词（可空）
              <input value={clanText} maxLength={60} placeholder={iAmBoss ? '例：这家我自己有人，不劳各位' : '例：我家的人到了，谈个价吧'} onChange={e => setClanText(e.target.value)} />
            </label>
            <button className="btn btn-success" onClick={() => {
              const d = iAmBoss || clanDemand.trim() === '' ? undefined : Math.max(0, Math.floor(Number(clanDemand) || 0))
              fire({ ...base, demand: d, say: clanText.trim() || undefined })
            }}>打出</button>
            {swap}
          </div>
        )
      }
      case 'TRAVEL': {
        const targets = openActions.filter(a => a.type === 'PLAY_TRAVEL')
        const swap = renderSwap(card)
        return (
          <div className="popover-body">
            {targets.length > 0 && (
              <>
                <div className="popover-title">{card.familyId ? `旅行牌（${FAMILIES[card.familyId].name}）` : '万能旅行牌'}：选择要打飞的代表</div>
                <div className="popover-targets">
                  {targets.map((a, i) => {
                    if (a.type !== 'PLAY_TRAVEL' || !neg) return null
                    const rep = findRep(neg, a.targetRepKey)!
                    const owner = state.players[rep.ownerId]
                    const inOffer = neg.offer?.repKeys.includes(rep.key)
                    return (
                      <button key={i} className="btn target-btn" onClick={() => fire(a)}
                        style={{ borderColor: FAMILIES[rep.familyId].color }}>
                        {owner?.name}{rep.ownerId === viewerId ? '（你）' : ''} 的 {FAMILIES[rep.familyId].name}
                        <em>{rep.source === 'INVESTOR' ? '投资者' : '家族卡'}{inOffer ? ' ★方案中' : ''}</em>
                      </button>
                    )
                  })}
                </div>
              </>
            )}
            {swap}
          </div>
        )
      }
      case 'SICK': {
        const targets = openActions.filter(a => a.type === 'PLAY_SICK')
        return (
          <div className="popover-body">
            <div className="popover-title">病假牌：指定一名玩家，本回合内他不能再主动出牌（家族 / 旅行 / 招募 / 老板 / 稀有牌与换牌都不行），只能被动打阻止牌</div>
            <div className="popover-targets">
              {targets.map((a, i) => {
                if (a.type !== 'PLAY_SICK') return null
                const p = state.players[a.targetPlayerId]
                const role = neg?.bossId === p.id ? 'Boss · 仍能提案成交' : neg?.offer?.payouts.some(x => x.playerId === p.id && x.amount > 0) ? '方案里有钱' : neg ? '不在方案里' : ''
                return (
                  <button key={i} className="btn target-btn" onClick={() => fire(a)}>
                    {p.name}<em>手牌 {p.hand.length} 张{role ? ` · ${role}` : ''}</em>
                  </button>
                )
              })}
            </div>
          </div>
        )
      }
      case 'RECRUITMENT': {
        const costs = openActions.map(a => a.type === 'PLAY_RECRUITMENT' ? a.cardIds.length : 3)
        const minCost = Math.min(...costs)
        return (
          <div className="popover-body">
            <div className="popover-title">
              招募：选择要夺取的投资者（{minCost === 1 ? '夺回权：只需 1 张' : minCost === 2 ? '猎头格：只需 2 张' : '消耗 3 张招募牌'}）
            </div>
            <div className="popover-targets">
              {openActions.map((a, i) => {
                if (a.type !== 'PLAY_RECRUITMENT') return null
                const f: FamilyId = a.targetFamilyId
                const owner = state.investors.find(inv => inv.familyId === f)?.ownerId
                const cost = recruitCost(state, viewerId, f)
                const reclaim = canReclaim(state, viewerId, f)
                return (
                  <button key={i} className="btn target-btn" style={{ borderColor: FAMILIES[f].color }} onClick={() => fire(a)}>
                    {FAMILIES[f].name}<em>{owner == null ? '公共区' : `来自 ${state.players[owner]?.name}`} · {reclaim ? '夺回 · 1 张' : `${cost} 张`}</em>
                  </button>
                )
              })}
            </div>
          </div>
        )
      }
      case 'BOOM': {
        const a = openActions.find(x => x.type === 'PLAY_BOOM')
        return a ? (
          <div className="popover-body">
            <div className="popover-title">利好：本笔股价 +${BOOM_BONUS}M/份，总额 ${getGrossValue(state)}M → ${grossAfterDelta(state, BOOM_BONUS)}M（已有方案的分成不变，多出的全归你）</div>
            <button className="btn btn-success" onClick={() => fire(a)}>打出利好</button>
          </div>
        ) : null
      }
      case 'BUST': {
        const a = openActions.find(x => x.type === 'PLAY_BUST')
        return a ? (
          <div className="popover-body">
            <div className="popover-title">利空：本笔股价 −${BUST_PENALTY}M/份，总额 ${getGrossValue(state)}M → ${grossAfterDelta(state, -BUST_PENALTY)}M（砍的是 Boss 的净得，方案里别人的分成不变）</div>
            <button className="btn btn-danger" onClick={() => fire(a)}>打出利空</button>
          </div>
        ) : null
      }
      case 'EXCLUSIVE': {
        const a = openActions.find(x => x.type === 'PLAY_EXCLUSIVE')
        return a ? (
          <div className="popover-body">
            <div className="popover-title">独家协议：锁定本笔交易——之后谁都不能再打老板牌 / 旅行牌 / 利空牌（招募仍可）</div>
            <button className="btn btn-success" onClick={() => fire(a)}>签独家协议</button>
          </div>
        ) : null
      }
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

  const selecting = selectMode != null
  const sick = isSick(state, viewerId)
  /** 兑换模式下：最多选两张，且第二张必须与第一张种类不同 */
  const selectedTypes = new Set(player.hand.filter(c => selection.has(c.id)).map(c => c.type))
  const canPick = (card: InfluenceCard) => {
    if (selection.has(card.id)) return true
    if (selectMode === 'trade') return selection.size < 2 && !selectedTypes.has(card.type)
    return true
  }
  const cardTitle = (card: InfluenceCard, playable: boolean) => {
    if (selectMode === 'discard') return '点击选择 / 取消弃牌'
    if (selectMode === 'trade') return canPick(card) ? '点击选择 / 取消（两张须是不同种类）' : selection.size >= 2 ? '已选满两张' : '与已选的牌种类相同，不能凑对'
    if (playable) return '点击查看可执行的操作'
    return sick ? '你本回合病假：不能主动出牌' : '当前不可打出'
  }

  return (
    <div className="hand" ref={handRef}>
      {openCard && !selecting && openActions.length > 0 && (
        <div className="card-popover" role="group" aria-label={`${cardFace(openCard).title}：出牌选项`} style={{ left: popoverLeft }} onClick={e => e.stopPropagation()}>
          {renderPopover(openCard)}
          <button className="popover-close" aria-label="关闭出牌选项" onClick={() => setOpenCardId(null)}>×</button>
        </div>
      )}
      <div className="hand-title">
        <span>你的手牌 {player.hand.length}/{HAND_LIMIT}</span>
        {selectMode === 'discard' && <span className="red">点选要弃的牌</span>}
        {selectMode === 'trade' && <span className="gold">兑换：点选两张不同种类的牌（{selection.size}/2）</span>}
        {sick && !selecting && <span className="red" title="本回合内不能主动出牌 / 换牌，只能喊话、报价、应答、跳过；阻止牌仍可打">🤒 病假中</span>}
        {recruitCount > 0 && recruitCount < recruitNeed && <span className="muted" title={recruitNeed < 3 ? '猎头格：本笔交易中招募只需 2 张' : '3 张招募牌一组'}>招募 {recruitCount}/{recruitNeed}</span>}
        {player.reclaim && <span className="gold" title="你的最后一位常驻投资者被夺走了：只需 1 张招募牌即可抢回">夺回权：{FAMILIES[player.reclaim].name}</span>}
      </div>
      <div className="hand-cards" role="group" aria-label="你的手牌">
        {player.hand.map(card => {
          const playable = !selecting && actionsForCard(legal, card).length > 0
          const selected = selection.has(card.id)
          const pickable = selecting && canPick(card)
          const open = openCardId === card.id
          const face = cardFace(card)
          const isNew = fresh.has(card.id)
          const idle = (!playable && !selecting) || (selecting && !pickable)
          const activate = (el: HTMLElement) => {
            if (selecting) { if (pickable) onToggleSelect(card.id) }
            else if (playable) { if (open) setOpenCardId(null); else openPopoverAt(card.id, el) }
            // 当前打不出的牌：点按 / Enter 直接看说明与"为什么不能打"（触屏没有悬停；键盘聚焦本来就会放大，再按一次切换）
            else if (zoomId !== card.id) showZoom(card.id, el)
          }
          const onPointerEnter = (e: PointerEvent<HTMLElement>) => {
            if (e.pointerType !== 'mouse' || open) return
            const el = e.currentTarget
            clearTimers()
            hoverTimer.current = setTimeout(() => showZoom(card.id, el), HOVER_ZOOM_MS)
          }
          const onPointerLeave = (e: PointerEvent<HTMLElement>) => {
            if (e.pointerType !== 'mouse') return
            clearTimers()
            setZoomId(z => (z === card.id ? null : z))
          }
          const onPointerDown = (e: PointerEvent<HTMLElement>) => {
            clearTimers()
            if (e.pointerType === 'mouse') { setZoomId(null); return }
            const el = e.currentTarget
            pressTimer.current = setTimeout(() => { suppressClick.current = true; showZoom(card.id, el) }, LONG_PRESS_MS)
          }
          const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(e.currentTarget) }
            else if (e.key === 'Escape') setZoomId(null)
          }
          return (
            <div key={card.id} className="card-slot">
              <div
                role="button"
                tabIndex={0}
                aria-disabled={idle || undefined}
                aria-pressed={selecting ? selected : undefined}
                aria-expanded={playable ? open : undefined}
                aria-label={`${face.kind}：${face.title}，${face.summary}${isNew ? '（新抽到）' : ''}`}
                aria-describedby={zoomId === card.id ? 'card-zoom' : undefined}
                data-card-id={card.id}
                className={`card type-${card.type.toLowerCase()}${card.familyId ? ' has-family' : ''}${playable ? ' playable' : ''}${open ? ' open' : ''}${selected ? ' selected' : ''}${selectMode === 'trade' && selected ? ' trade-selected' : ''}${pickable ? ' discard-mode' : ''}${idle ? ' idle' : ''}${isNew ? ' card-new' : ''}`}
                style={{ '--accent': face.accent, '--i': isNew ? [...fresh].indexOf(card.id) : 0 } as CSSProperties}
                onClick={e => {
                  if (suppressClick.current) { suppressClick.current = false; return }
                  activate(e.currentTarget)
                }}
                onKeyDown={onKeyDown}
                onFocus={e => { if (!open && focusVisible(e.currentTarget)) showZoom(card.id, e.currentTarget) }}
                onBlur={() => setZoomId(z => (z === card.id ? null : z))}
                onPointerEnter={onPointerEnter}
                onPointerLeave={onPointerLeave}
                onPointerDown={onPointerDown}
                onPointerUp={clearTimers}
                onPointerCancel={clearTimers}
                onContextMenu={e => { if (pressTimer.current || zoomId === card.id) e.preventDefault() }}
              >
                <div className="card-head">
                  <span className="card-icon" aria-hidden="true">{face.icon}</span>
                  <span className="card-type">{face.kind}</span>
                  {face.badge && <span className="card-badge">{face.badge}</span>}
                </div>
                <div className="card-name">
                  {card.familyId && <span className="card-letter" aria-hidden="true">{card.familyId}</span>}
                  <span className="card-title">{face.title}</span>
                </div>
                <div className="card-effect">{face.summary}</div>
                {isNew && <span className="card-new-badge">新</span>}
                {selected && <div className="card-discard-mark">{selectMode === 'trade' ? '换' : '弃'}</div>}
              </div>
            </div>
          )
        })}
        {player.hand.length === 0 && <span className="muted">空手</span>}
      </div>
      {zoomCard && !selecting && openCardId == null && (() => {
        const face = cardFace(zoomCard)
        const playable = actionsForCard(legal, zoomCard).length > 0
        return (
          <div id="card-zoom" role="tooltip" className={`card-zoom type-${zoomCard.type.toLowerCase()}`} style={{ left: zoomLeft, '--accent': face.accent } as CSSProperties}>
            <div className="zoom-head">
              <span className="zoom-icon" aria-hidden="true">{face.icon}</span>
              <span className="zoom-kind">{face.kind}{face.badge ? ` · ${face.badge}` : ''}</span>
            </div>
            <div className="zoom-title">
              {zoomCard.familyId && <span className="card-letter" aria-hidden="true">{zoomCard.familyId}</span>}
              {face.title}
            </div>
            <div className="zoom-summary">{face.summary}</div>
            <p className="zoom-detail">{face.detail}</p>
            <div className={`zoom-status${playable ? ' ok' : ''}`}>{cardTitle(zoomCard, playable)}</div>
          </div>
        )
      })()}
    </div>
  )
}
