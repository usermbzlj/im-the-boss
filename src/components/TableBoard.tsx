// ============================================================
// TableBoard — 环形版图（16 / 24 / 32 格，按变体自适应）+ 中央景气牌 + 公共区 + 座位
// ============================================================

import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { GameState, BoardSpace, SpaceKind } from '../engine/types'
import { FAMILIES, ringLayout, ringRowOptions, getVariant } from '../engine/config'
import { getCurrentTile, getGrossValue, getEndProbability, isRequiredGroup, canCompleteAlone, effectiveShareValue } from '../engine/rules'
import { getActingPlayerId } from '../engine/validator'
import { relationsToward } from '../ai/relations'
import { spaceKindName, spaceKindEffect } from '../text/narrate'
import FamilyChip from './FamilyChip'
import PlayerSeat from './PlayerSeat'
import { useViewerId } from './ViewerContext'

interface TableBoardProps {
  state: GameState
  thinkingId: number | null
  onPlaceMarker?: (spaceId: number) => void
  /** 复盘用的只读模式：不可放置标记、不显示“可独成”提示，也不隐藏反应窗口里的行动者（终局后一切公开）。默认 false，行为不变 */
  readOnly?: boolean
}

const KIND_ICON: Record<SpaceKind, string> = { STANDARD: '', LANDMARK: '🏛', PREMIUM: '🔥', BLACK_MARKET: '🕶', HEADHUNT: '🎯' }

/** 三档格子尺寸（与 game.css 的 .ring-grid / .ring-lg / .ring-xl 对应）：最小宽、典型高（含内容撑高余量）、间距 */
const RING_METRICS = {
  '': { w: 112, h: 100, gap: 6 },
  ' ring-lg': { w: 96, h: 84, gap: 5 },
  ' ring-xl': { w: 84, h: 72, gap: 4 },
} as const
type SizeClass = keyof typeof RING_METRICS

/**
 * 按版图区域的实际宽高挑外圈行数：越扁的区域（宽屏 / 矮窗口）用越少的行、越多的列。
 * 对每种行数估算外圈的自然尺寸，取"缩放最少"的一种；同样放得下时保留更方的（行数更多的）。
 */
function pickRingRows(n: number, availW: number, availH: number, m: { w: number; h: number; gap: number }): number {
  const options = ringRowOptions(n)
  let best = options[options.length - 1]
  let bestFit = -1
  for (const rows of options) {
    const cols = Math.round((n - 2 * (rows - 2)) / 2)
    const need = { w: cols * m.w + (cols - 1) * m.gap, h: rows * m.h + (rows - 1) * m.gap }
    const fit = Math.min(1, availW / need.w, availH / need.h)
    if (fit >= bestFit - 1e-6) { best = rows; bestFit = fit }
  }
  return best
}

/**
 * 让整张版图始终完整可见：量出版图区域尺寸 → 选行数；再量外圈自然尺寸 → 放不下就整体等比缩小。
 * 之前外圈在区域内滚动，大版图 / 矮窗口下上排会被滚出视野，看起来像少了一排。
 */
function useRingFit(n: number, sizeClass: SizeClass) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const [avail, setAvail] = useState<{ w: number; h: number } | null>(null)
  const [scale, setScale] = useState(1)

  useLayoutEffect(() => {
    const wrap = wrapRef.current
    const grid = gridRef.current
    if (!wrap || !grid) return
    const measure = () => {
      const w = wrap.clientWidth - 4, h = wrap.clientHeight - 4 // 扣掉 .ring-wrap 的 2px 内边距
      setAvail(prev => (prev && prev.w === w && prev.h === h ? prev : { w, h }))
      // offsetWidth / offsetHeight 不受 transform 影响：量的是未缩放的自然尺寸
      const gw = grid.offsetWidth, gh = grid.offsetHeight
      const k = Math.min(1, gw > 0 ? w / gw : 1, gh > 0 ? h / gh : 1)
      setScale(prev => (Math.abs(prev - k) < 0.005 ? prev : k))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(wrap)
    ro.observe(grid)
    return () => ro.disconnect()
  }, [])

  const rows = avail ? pickRingRows(n, avail.w, avail.h, RING_METRICS[sizeClass]) : undefined
  return { wrapRef, gridRef, rows, scale }
}

function spaceTooltip(state: GameState, space: BoardSpace): string {
  const parts = space.groups.map(g => isRequiredGroup(g)
    ? `必需：${g.families.map(f => `${f}·${FAMILIES[f].name}`).join('、')}`
    : `${g.families.map(f => `${f}·${FAMILIES[f].name}`).join('/')} 中选 ${g.need}`)
  const kind = space.kind !== 'STANDARD' ? `｜${spaceKindName(space.kind)}：${spaceKindEffect(space.kind)}` : ''
  const landlord = space.landlordId != null ? `｜主人：${state.players[space.landlordId]?.name}` : ''
  return `#${space.id}｜${parts.join('｜')}｜${space.dividends} 份分红${kind}${landlord}`
}

export default function TableBoard({ state, thinkingId, onPlaceMarker, readOnly = false }: TableBoardProps) {
  const viewerId = useViewerId()
  const tile = getCurrentTile(state)
  const nextTile = state.dealTiles[state.dealTileIndex + 1]
  const gross = getGrossValue(state)
  const sizeClass: SizeClass = state.board.length > 24 ? ' ring-xl' : state.board.length > 16 ? ' ring-lg' : ''
  const fit = useRingFit(state.board.length, sizeClass)
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

  return (
    <div className="table-board">
      <div className="seats-row">
        {state.players.map(p => (
          <PlayerSeat key={p.id} state={state} playerId={p.id} isActing={actingId === p.id} isThinking={shownThinking === p.id} relation={relations[p.id]} />
        ))}
      </div>

      <div className="ring-wrap" ref={fit.wrapRef}>
        <div
          className={`ring-grid${sizeClass}`}
          ref={fit.gridRef}
          style={{
            gridTemplateColumns: `repeat(${layout.cols}, minmax(var(--cell-min), 1fr))`,
            gridTemplateRows: `repeat(${layout.rows}, minmax(var(--cell-min-h), auto))`,
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
            return (
              <div
                key={space.id}
                className={`ring-cell${isCurrent ? ' current' : ''}${closed ? ' closed' : ''}${clickable ? ' selectable' : ''}${state.negotiation?.spaceId === space.id ? ' negotiating' : ''}${special ? ` kind-${space.kind.toLowerCase()}` : ''}`}
                style={{ gridRow: pos.row, gridColumn: pos.col }}
                onClick={() => clickable && onPlaceMarker?.(space.id)}
                title={clickable ? `点击把金钱标记放在 #${space.id}` : spaceTooltip(state, space)}
              >
                {isCurrent && <span className="marker-icon" title="金钱标记">💰</span>}
                <div className="cell-top">
                  <span className="cell-id">#{space.id}</span>
                  <span className="cell-div">{space.dividends}份</span>
                  {special && <span className="cell-kind" title={spaceKindEffect(space.kind)}>{KIND_ICON[space.kind]}{spaceKindName(space.kind)}</span>}
                  {isCurrent && !closed && <span className="cell-total">${gross}M</span>}
                  {soloOk && !isCurrent && <span className="cell-solo" title="仅凭你的投资者 + 手中家族卡即可凑齐">✓自足</span>}
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
              <div className="pile-value">
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
              {state.lastDie != null && <div className="die-display">🎲 {state.lastDie}</div>}
            </div>
            {neutral.length > 0 && (
              <div className="public-market" title="4/5 人局多出的投资者：招募必须先从这里夺取">
                <span className="market-title">公共区</span>
                {neutral.map(inv => <FamilyChip key={inv.familyId} familyId={inv.familyId} size="sm" />)}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
