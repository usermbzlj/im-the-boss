// ============================================================
// TableBoard — 环形版图（16 / 24 / 32 格，按变体自适应）+ 中央景气牌 + 公共区 + 座位
// ============================================================

import type { GameState, BoardSpace, SpaceKind } from '../engine/types'
import { FAMILIES, ringLayout, getVariant } from '../engine/config'
import { getCurrentTile, getGrossValue, getEndProbability, isRequiredGroup, canCompleteAlone, effectiveShareValue } from '../engine/rules'
import { getActingPlayerId } from '../engine/validator'
import { spaceKindName, spaceKindEffect } from '../text/narrate'
import FamilyChip from './FamilyChip'
import PlayerSeat from './PlayerSeat'

interface TableBoardProps {
  state: GameState
  thinkingId: number | null
  onPlaceMarker?: (spaceId: number) => void
}

const KIND_ICON: Record<SpaceKind, string> = { STANDARD: '', LANDMARK: '🏛', PREMIUM: '🔥', BLACK_MARKET: '🕶', HEADHUNT: '🎯' }

function spaceTooltip(state: GameState, space: BoardSpace): string {
  const parts = space.groups.map(g => isRequiredGroup(g)
    ? `必需：${g.families.map(f => `${f}·${FAMILIES[f].name}`).join('、')}`
    : `${g.families.map(f => `${f}·${FAMILIES[f].name}`).join('/')} 中选 ${g.need}`)
  const kind = space.kind !== 'STANDARD' ? `｜${spaceKindName(space.kind)}：${spaceKindEffect(space.kind)}` : ''
  const landlord = space.landlordId != null ? `｜主人：${state.players[space.landlordId]?.name}` : ''
  return `#${space.id}｜${parts.join('｜')}｜${space.dividends} 份分红${kind}${landlord}`
}

export default function TableBoard({ state, thinkingId, onPlaceMarker }: TableBoardProps) {
  const tile = getCurrentTile(state)
  const nextTile = state.dealTiles[state.dealTileIndex + 1]
  const gross = getGrossValue(state)
  const layout = ringLayout(state.board.length)
  const sizeClass = state.board.length > 24 ? ' ring-xl' : state.board.length > 16 ? ' ring-lg' : ''
  const currentSpace = state.board.find(b => b.id === state.markerPos)
  const shareNow = currentSpace ? effectiveShareValue(state, currentSpace) : (tile?.shareValue ?? 0)
  const variant = getVariant(state.variantId)
  const rawActing = getActingPlayerId(state)
  // 反应窗口依次询问所有人，但仍不显示当前被询问者：
  // 持阻止牌者需要真正决策（LLM 耗时更长），显示"谁在想"会暴露手牌
  const hideActor = state.phase === 'REACTION' && rawActing !== 0
  const actingId = hideActor ? -1 : rawActing
  const shownThinking = hideActor ? null : thinkingId
  const canPlace = state.phase === 'PLACE_MARKER' && state.markerChooserId === 0
  const neutral = state.investors.filter(inv => inv.ownerId === null)
  const closedCount = state.board.filter(b => b.closedByTileId != null).length

  return (
    <div className="table-board">
      <div className="seats-row">
        {state.players.map(p => (
          <PlayerSeat key={p.id} state={state} playerId={p.id} isActing={actingId === p.id} isThinking={shownThinking === p.id} />
        ))}
      </div>

      <div className="ring-wrap">
        <div
          className={`ring-grid${sizeClass}`}
          style={{
            gridTemplateColumns: `repeat(${layout.cols}, minmax(var(--cell-min), 1fr))`,
            gridTemplateRows: `repeat(${layout.rows}, minmax(var(--cell-min-h), auto))`,
          }}
        >
          {state.board.map((space, idx) => {
            const pos = layout.cells[idx]
            const isCurrent = space.id === state.markerPos
            const closed = space.closedByTileId != null
            const clickable = canPlace && !closed
            const soloOk = !closed && canCompleteAlone(state, 0, space)
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
