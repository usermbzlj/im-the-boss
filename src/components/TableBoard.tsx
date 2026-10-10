// ============================================================
// TableBoard — 环形版图（16 / 24 / 32 格，按变体自适应）+ 中央景气牌 + 公共区 + 座位
// ============================================================

import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import type { GameState, BoardSpace, SpaceKind } from '../engine/types'
import { FAMILIES, ringLayout, getVariant } from '../engine/config'
import { getCurrentTile, getGrossValue, getEndProbability, isRequiredGroup, canCompleteAlone, effectiveShareValue } from '../engine/rules'
import { getActingPlayerId } from '../engine/validator'
import { relationsToward } from '../ai/relations'
import { spaceKindName, spaceKindEffect } from '../text/narrate'
import FamilyChip from './FamilyChip'
import PlayerSeat from './PlayerSeat'
import DieFace from './DieFace'
import { useCuesOf } from './CueProvider'
import { useViewerId } from './ViewerContext'
import { useLayout } from './useLayout'
import { MIN_COMPACT_SCALE, RING_METRICS, fitScale, ringNeed, pickRingRows, type SizeClass } from '../ui/ringFit'

interface TableBoardProps {
  state: GameState
  thinkingId: number | null
  onPlaceMarker?: (spaceId: number) => void
  /** 复盘用的只读模式：不可放置标记、不显示“可独成”提示，也不隐藏反应窗口里的行动者（终局后一切公开）。默认 false，行为不变 */
  readOnly?: boolean
}

const KIND_ICON: Record<SpaceKind, string> = { STANDARD: '', LANDMARK: '🏛', PREMIUM: '🔥', BLACK_MARKET: '🕶', HEADHUNT: '🎯' }

/**
 * 让整张版图始终完整可见：量出版图区域尺寸 → 选行数；再量外圈自然尺寸 → 放不下就整体等比缩小。
 * 之前外圈在区域内滚动，大版图 / 矮窗口下上排会被滚出视野，看起来像少了一排。
 *
 * 紧凑模式（手机 / 矮屏）：缩放有下限（MIN_COMPACT_SCALE），再小字就看不清了——放不下的部分让 .ring-wrap 滚动；
 * 此时外圈放在一个按缩放后尺寸占位的 .ring-scaler 里（transform 不改变布局尺寸，不占位滚动区会多出一大片空白）。
 */
function useRingFit(n: number, sizeClass: SizeClass, compact: boolean) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const [avail, setAvail] = useState<{ w: number; h: number } | null>(null)
  const [scale, setScale] = useState(1)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)

  useLayoutEffect(() => {
    const wrap = wrapRef.current
    const grid = gridRef.current
    if (!wrap || !grid) return
    const measure = () => {
      const w = wrap.clientWidth - 4, h = wrap.clientHeight - 4 // 扣掉 .ring-wrap 的 2px 内边距
      setAvail(prev => (prev && prev.w === w && prev.h === h ? prev : { w, h }))
      // offsetWidth / offsetHeight 不受 transform 影响：量的是未缩放的自然尺寸
      const gw = grid.offsetWidth, gh = grid.offsetHeight
      const k = fitScale(gw, gh, w, h, compact ? MIN_COMPACT_SCALE : 0)
      setScale(prev => (Math.abs(prev - k) < 0.005 ? prev : k))
      if (compact) setNatural(prev => (prev && prev.w === gw && prev.h === gh ? prev : { w: gw, h: gh }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(wrap)
    ro.observe(grid)
    return () => ro.disconnect()
  }, [compact])

  const rows = avail ? pickRingRows(n, avail.w, avail.h, RING_METRICS[sizeClass]) : undefined
  return { wrapRef, gridRef, rows, scale, natural }
}

/** 一格的说明行（title / 触屏点按提示共用）：编号 / 需求 / 分红 / 特殊格效果 / 地标主人 */
function spaceLines(state: GameState, space: BoardSpace): string[] {
  const parts = space.groups.map(g => isRequiredGroup(g)
    ? `必需：${g.families.map(f => `${f}·${FAMILIES[f].name}`).join('、')}`
    : `${g.families.map(f => `${f}·${FAMILIES[f].name}`).join('/')} 中选 ${g.need}`)
  const lines = [`#${space.id}`, ...parts, `${space.dividends} 份分红`]
  if (space.kind !== 'STANDARD') lines.push(`${spaceKindName(space.kind)}：${spaceKindEffect(space.kind)}`)
  if (space.landlordId != null) lines.push(`主人：${state.players[space.landlordId]?.name}`)
  return lines
}

function spaceTooltip(state: GameState, space: BoardSpace): string {
  return spaceLines(state, space).join('｜')
}

export default function TableBoard({ state, thinkingId, onPlaceMarker, readOnly = false }: TableBoardProps) {
  const viewerId = useViewerId()
  const tile = getCurrentTile(state)
  const nextTile = state.dealTiles[state.dealTileIndex + 1]
  const gross = getGrossValue(state)
  const env = useLayout()
  /** 手机 / 矮屏：用紧凑格子（见 game.css 的 .ring-compact），缩放有下限，放不下就滚动 */
  const compact = env.compactBoard
  const sizeClass: SizeClass = compact ? ' ring-compact' : state.board.length > 24 ? ' ring-xl' : state.board.length > 16 ? ' ring-lg' : ''
  const fit = useRingFit(state.board.length, sizeClass, compact)
  const layout = ringLayout(state.board.length, fit.rows)
  const currentSpace = state.board.find(b => b.id === state.markerPos)
  const shareNow = currentSpace ? effectiveShareValue(state, currentSpace) : (tile?.shareValue ?? 0)
  const variant = getVariant(state.variantId)
  const rawActing = getActingPlayerId(state)
  // 反应窗口与成交倒计时都依次询问所有人，但不向视角玩家显示"别人谁在行动 / 思考"：
  // 持阻止牌 / 干扰牌者需要真正决策（LLM 耗时更长），显示"谁在想"会暴露手牌。视角玩家自己行动时照常显示。
  const hideActor = !readOnly && (state.phase === 'REACTION' || state.phase === 'CLOSING') && rawActing !== viewerId
  const actingId = hideActor ? -1 : rawActing
  const shownThinking = hideActor ? null : thinkingId
  const canPlace = !readOnly && state.phase === 'PLACE_MARKER' && state.markerChooserId === viewerId
  const neutral = state.investors.filter(inv => inv.ownerId === null)
  const closedCount = state.board.filter(b => b.closedByTileId != null).length
  // 每位电脑玩家对视角玩家的态度：每次状态变化算一次，分发给各座位
  const relations = useMemo(() => relationsToward(state, viewerId), [state, viewerId])
  // 演出层（不在 CueProvider 内时为空）：成交的格子短暂高亮、飞行中的金钱标记先隐藏、股价变动闪一下
  const closeCues = useCuesOf('close')
  const markerCues = useCuesOf('marker')
  const priceCues = useCuesOf('price')
  const priceFlash = priceCues.length ? (priceCues[priceCues.length - 1].tone === 'good' ? ' flash-up' : ' flash-down') : ''

  return (
    <div className="table-board">
      <div className="seats-row">
        {state.players.map(p => (
          <PlayerSeat key={p.id} state={state} playerId={p.id} isActing={actingId === p.id} isThinking={shownThinking === p.id} relation={relations[p.id]} />
        ))}
      </div>

      <div className={`ring-wrap${compact ? ' ring-wrap-compact' : ''}`} ref={fit.wrapRef} role="group" aria-label="版图">
        <RingScaler compact={compact} scale={fit.scale} natural={fit.natural}>
        <div
          className={`ring-grid${sizeClass}`}
          ref={fit.gridRef}
          style={{
            gridTemplateColumns: `repeat(${layout.cols}, minmax(var(--cell-min), 1fr))`,
            gridTemplateRows: `repeat(${layout.rows}, minmax(var(--cell-min-h), auto))`,
            ...(compact ? { width: ringNeed(state.board.length, layout.rows, RING_METRICS[' ring-compact']).w, maxWidth: 'none', transformOrigin: '0 0' } : null),
            transform: fit.scale < 1 ? `scale(${fit.scale})` : undefined,
          }}
        >
          {state.board.map((space, idx) => {
            const pos = layout.cells[idx]
            const isCurrent = space.id === state.markerPos
            const closed = space.closedByTileId != null
            const clickable = canPlace && !closed
            const soloOk = !readOnly && !closed && canCompleteAlone(state, viewerId, space)
            const special = space.kind !== 'STANDARD'
            const closing = closeCues.some(cue => cue.target.type === 'cell' && cue.target.spaceId === space.id)
            const markerIncoming = markerCues.some(cue => cue.target.type === 'cell' && cue.target.spaceId === space.id)
            // 可放置标记的格子是真正的按钮（可聚焦、Enter / 空格放置）；其余格子是只读分组，说明写在 aria-label 里
            const place = () => { if (clickable) onPlaceMarker?.(space.id) }
            const a11y = clickable
              ? { role: 'button', tabIndex: 0, 'aria-label': `把金钱标记放在 #${space.id}（${spaceTooltip(state, space)}）`,
                onKeyDown: (e: KeyboardEvent<HTMLElement>) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); place() } } }
              : { role: 'group', 'aria-label': `${spaceTooltip(state, space)}${isCurrent ? '｜金钱标记在这里' : ''}${closed ? '｜已成交' : ''}` }
            return (
              <div
                key={space.id}
                className={`ring-cell${isCurrent ? ' current' : ''}${closed ? ' closed' : ''}${closing ? ' cue-closing' : ''}${clickable ? ' selectable' : ''}${state.negotiation?.spaceId === space.id ? ' negotiating' : ''}${special ? ` kind-${space.kind.toLowerCase()}` : ''}`}
                data-space-id={space.id}
                style={{ gridRow: pos.row, gridColumn: pos.col }}
                onClick={place}
                title={clickable ? `点击把金钱标记放在 #${space.id}` : spaceTooltip(state, space)}
                {...a11y}
              >
                {isCurrent && <span className={`marker-icon${markerIncoming ? ' incoming' : ''}`} title="金钱标记">💰</span>}
                <div className="cell-top">
                  <span className="cell-id">#{space.id}</span>
                  <span className="cell-div">{space.dividends}份</span>
                  {special && <span className="cell-kind" title={spaceKindEffect(space.kind)}>{KIND_ICON[space.kind]}<span className="cell-kind-name">{spaceKindName(space.kind)}</span></span>}
                  {isCurrent && !closed && <span className="cell-total">${gross}M</span>}
                  {soloOk && !isCurrent && <span className="cell-solo" title="仅凭你的投资者 + 手中家族卡即可凑齐">✓<span className="cell-solo-text">自足</span></span>}
                </div>
                {closed ? (
                  <div className="cell-closed">
                    <span>已成交</span>
                    <span className="cell-tile">景气牌 #{space.closedByTileId}</span>
                    {space.landlordId != null && <span className="cell-landlord" title="地标主人：每笔成交收租">🏛 {state.players[space.landlordId]?.name}</span>}
                  </div>
                ) : (
                  space.groups.map((g, i) => (
                    <div key={i} className="cell-group">
                      <span className={`cell-group-label ${isRequiredGroup(g) ? 'req' : 'opt'}`}>
                        {isRequiredGroup(g) ? '必' : `选${g.need}`}
                      </span>
                      {g.families.map(f => (
                        <FamilyChip key={f} familyId={f} size="sm" kind={isRequiredGroup(g) ? 'required' : 'optional'} />
                      ))}
                    </div>
                  ))
                )}
              </div>
            )
          })}

          <div className="table-center" style={{ gridRow: `2 / span ${layout.rows - 2}`, gridColumn: `2 / span ${layout.cols - 2}` }}>
            <div className="deal-pile">
              <div className="pile-label">景气牌 #{tile?.id ?? '-'} / {state.dealTiles.length} · 当前股价</div>
              <div className={`pile-value${priceFlash}`}>
                ${shareNow}M<span>/份</span>
                {shareNow !== (tile?.shareValue ?? 0) && <span className="pile-adjust" title="景气牌股价 + 抢手格 / 利好 / 利空">（景气牌 ${tile?.shareValue ?? 0}M）</span>}
              </div>
              <div className="pile-gross">当前格 #{state.markerPos} 总额 <b>${gross}M</b></div>
              <div className="pile-next">
                {nextTile ? `下一张 $${nextTile.shareValue}M/份` : '最后一张'}
                {tile && tile.endFaces.length > 0 && (
                  <span className="pile-endgame"> · 成交后 {getEndProbability(tile)}% 终局（骰 {tile.endFaces.join('/')}）</span>
                )}
              </div>
              <div className="pile-meta">{variant.name} · 已成交 {closedCount}/{state.dealTiles.length} · 牌堆 {state.drawPile.length} · 弃牌 {state.discardPile.length}</div>
              {state.lastDie != null && <div className="die-display"><DieFace value={state.lastDie} className="die-sm" /></div>}
            </div>
            {neutral.length > 0 && (
              <div className="public-market" title="4/5 人局多出的投资者：招募必须先从这里夺取">
                <span className="market-title">公共区</span>
                {neutral.map(inv => <FamilyChip key={inv.familyId} familyId={inv.familyId} size="sm" />)}
              </div>
            )}
          </div>
        </div>
        </RingScaler>
      </div>
    </div>
  )
}

/** 紧凑模式：按缩放后的尺寸占位（transform 不改变布局尺寸），让 .ring-wrap 的滚动范围正好；其余模式原样返回 */
function RingScaler({ compact, scale, natural, children }: { compact: boolean; scale: number; natural: { w: number; h: number } | null; children: ReactNode }) {
  if (!compact) return <>{children}</>
  const style = natural ? { width: Math.ceil(natural.w * scale), height: Math.ceil(natural.h * scale) } : undefined
  return <div className="ring-scaler" style={style}>{children}</div>
}
