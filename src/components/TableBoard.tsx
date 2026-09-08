// ============================================================
// TableBoard — 16 格环形版图 + 中央景气牌 + 公共区 + 座位
// ============================================================

import type { GameState, BoardSpace } from '../engine/types'
import { FAMILIES } from '../engine/config'
import { getCurrentTile, getGrossValue, getEndProbability, isRequiredGroup, canCompleteAlone } from '../engine/rules'
import { getActingPlayerId } from '../engine/validator'
import FamilyChip from './FamilyChip'
import PlayerSeat from './PlayerSeat'

interface TableBoardProps {
  state: GameState
  thinkingId: number | null
  onPlaceMarker?: (spaceId: number) => void
}

// 环形：上 6 / 右 2 / 下 6 / 左 2（顺时针）
const RING: Record<number, { row: number; col: number }> = {
  1: { row: 1, col: 1 }, 2: { row: 1, col: 2 }, 3: { row: 1, col: 3 }, 4: { row: 1, col: 4 }, 5: { row: 1, col: 5 }, 6: { row: 1, col: 6 },
  7: { row: 2, col: 6 }, 8: { row: 3, col: 6 },
  9: { row: 4, col: 6 }, 10: { row: 4, col: 5 }, 11: { row: 4, col: 4 }, 12: { row: 4, col: 3 }, 13: { row: 4, col: 2 }, 14: { row: 4, col: 1 },
  15: { row: 3, col: 1 }, 16: { row: 2, col: 1 },
}

function spaceTooltip(space: BoardSpace): string {
  const parts = space.groups.map(g => isRequiredGroup(g)
    ? `必需：${g.families.map(f => `${f}·${FAMILIES[f].name}`).join('、')}`
    : `${g.families.map(f => `${f}·${FAMILIES[f].name}`).join('/')} 中选 ${g.need}`)
  return `#${space.id}｜${parts.join('｜')}｜${space.dividends} 份分红`
}

export default function TableBoard({ state, thinkingId, onPlaceMarker }: TableBoardProps) {
  const tile = getCurrentTile(state)
  const nextTile = state.dealTiles[state.dealTileIndex + 1]
  const gross = getGrossValue(state)
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
        <div className="ring-grid">
          {state.board.map(space => {
            const pos = RING[space.id]
            const isCurrent = space.id === state.markerPos
            const closed = space.closedByTileId != null
            const clickable = canPlace && !closed
            const soloOk = !closed && canCompleteAlone(state, 0, space)
            return (
              <div
                key={space.id}
                className={`ring-cell${isCurrent ? ' current' : ''}${closed ? ' closed' : ''}${clickable ? ' selectable' : ''}${state.negotiation?.spaceId === space.id ? ' negotiating' : ''}`}
                style={{ gridRow: pos.row, gridColumn: pos.col }}
                onClick={() => clickable && onPlaceMarker?.(space.id)}
                title={clickable ? `点击把金钱标记放在 #${space.id}` : spaceTooltip(space)}
              >
                {isCurrent && <span className="marker-icon" title="金钱标记">💰</span>}
                <div className="cell-top">
                  <span className="cell-id">#{space.id}</span>
                  <span className="cell-div">{space.dividends}份</span>
                  {isCurrent && !closed && <span className="cell-total">${gross}M</span>}
                  {soloOk && !isCurrent && <span className="cell-solo" title="仅凭你的投资者 + 手中家族卡即可凑齐">✓自足</span>}
                </div>
                {closed ? (
                  <div className="cell-closed">
                    <span>已成交</span>
                    <span className="cell-tile">景气牌 #{space.closedByTileId}</span>
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

          <div className="table-center">
            <div className="deal-pile">
              <div className="pile-label">景气牌 #{tile?.id ?? '-'} · 当前股价</div>
              <div className="pile-value">${tile?.shareValue ?? 0}M<span>/份</span></div>
              <div className="pile-gross">当前格 #{state.markerPos} 总额 <b>${gross}M</b></div>
              <div className="pile-next">
                {nextTile ? `下一张 $${nextTile.shareValue}M/份` : '最后一张'}
                {tile && tile.endFaces.length > 0 && (
                  <span className="pile-endgame"> · 成交后 {getEndProbability(tile)}% 终局（骰 {tile.endFaces.join('/')}）</span>
                )}
              </div>
              <div className="pile-meta">已成交 {closedCount}/15 · 牌堆 {state.drawPile.length} · 弃牌 {state.discardPile.length}</div>
              {state.lastDie != null && <div className="die-display">🎲 {state.lastDie}</div>}
            </div>
            {neutral.length > 0 && (
              <div className="public-market" title="4/5 人局多出的投资者：招募三连必须先从这里夺取">
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
