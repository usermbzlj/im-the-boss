// ============================================================
// TableBoard — 环形桌游版图
// ============================================================

import type { GameState, FamilyId } from '../engine/types'
import FamilyChip from './FamilyChip'
import PlayerSeat, { PublicMarket } from './PlayerSeat'
import { FAMILIES } from '../engine/config'
import { getCurrentDealTile, getGrossDealValue, getEndGameProbability } from '../engine/gameEngine'
import { getActingPlayerId } from '../engine/validator'

const FAMILIES_NAME = (f: FamilyId) => FAMILIES[f].name

interface TableBoardProps {
  state: GameState
  onChooseMarker?: (spaceId: number) => void
}

// 环形布局：上6 右2 下6 左2
const RING_POSITIONS: Record<number, { row: number; col: number }> = {
  1: { row: 0, col: 0 }, 2: { row: 0, col: 1 }, 3: { row: 0, col: 2 },
  4: { row: 0, col: 3 }, 5: { row: 0, col: 4 }, 6: { row: 0, col: 5 },
  7: { row: 1, col: 5 }, 8: { row: 2, col: 5 },
  9: { row: 3, col: 5 }, 10: { row: 3, col: 4 }, 11: { row: 3, col: 3 },
  12: { row: 3, col: 2 }, 13: { row: 3, col: 1 }, 14: { row: 3, col: 0 },
  15: { row: 2, col: 0 }, 16: { row: 1, col: 0 },
}

export default function TableBoard({ state, onChooseMarker }: TableBoardProps) {
  const tile = getCurrentDealTile(state)
  const nextTile = state.dealTiles[state.dealTileIndex + 1]
  const gross = getGrossDealValue(state)
  const endProb = getEndGameProbability(tile)
  // 反应窗口中的"当前反应者"是引擎从持有阻止牌的玩家里挑出来的（见
  // gameEngine.ts nextReactorWithStop），高亮这个人等于暴露"谁手里有阻止
  // 牌"的隐藏信息。除非轮到人类自己反应，否则该阶段不对外暴露具体是谁。
  const rawActingId = getActingPlayerId(state)
  const actingId = state.phase === 'REACTION_WINDOW' && rawActingId !== 0 ? null : rawActingId
  const choosingMarker = state.phase === 'CHOOSE_MARKER_POSITION'
  const canHumanChoose = choosingMarker && state.markerChooserId === 0

  const seatLayout: Array<{ id: number; pos: 'top' | 'right' | 'bottom' | 'left'; index: number }> = []
  const n = state.players.length
  const positions: Array<'top' | 'right' | 'bottom' | 'left'> =
    n <= 3 ? ['bottom', 'left', 'top'] :
    n === 4 ? ['bottom', 'left', 'top', 'right'] :
    ['bottom', 'left', 'top', 'top', 'right', 'right']
  for (let i = 0; i < n; i++) {
    const pos = positions[i] ?? 'top'
    const index = seatLayout.filter(s => s.pos === pos).length
    seatLayout.push({ id: i, pos, index })
  }

  const renderSeats = (pos: 'top' | 'right' | 'bottom' | 'left') =>
    seatLayout.filter(s => s.pos === pos).map(s => (
      <PlayerSeat
        key={s.id}
        state={state}
        playerId={s.id}
        position={pos}
        stackIndex={s.index}
        stackTotal={seatLayout.filter(x => x.pos === pos).length}
        isActing={actingId === s.id}
      />
    ))

  return (
    <div className="table-board">
      {renderSeats('top')}
      {renderSeats('left')}

      <div className="table-center">
        <div className="deal-pile">
          <div className="pile-label">当前股价</div>
          <div className="pile-value">${tile?.shareValue ?? 0}M/股</div>
          <div className="pile-gross">本格总额 <b>${gross}M</b></div>
          {nextTile && (
            <div className="pile-next">下一张: ${nextTile.shareValue}M/股</div>
          )}
          {state.completedDeals >= 9 && tile?.endGameFaces && (
            <div className="pile-endgame">
              终局骰面: {tile.endGameFaces.join(',')} · 概率 {endProb}%
            </div>
          )}
          {state.dieResult != null && (
            <div className="die-display">🎲 {state.dieResult}</div>
          )}
        </div>
        <PublicMarket state={state} />
      </div>

      <div className="ring-grid">
        {state.board.map(space => {
          const pos = RING_POSITIONS[space.id]
          const isCurrent = space.id === state.dollarMarkerPos
          const clickable = canHumanChoose && !space.isClosed
          const reqNames = space.requiredFamilies.map(f => `${f}·${FAMILIES_NAME(f)}`).join('、')
          const optNames = space.optionalFamilies.map(f => `${f}·${FAMILIES_NAME(f)}`).join('、')
          const tooltip = clickable
            ? '点击选择起始位置'
            : `#${space.id}｜必需：${reqNames || '无'}${space.optionalNeed > 0 ? `｜可选（${space.optionalFamilies.length}选${space.optionalNeed}）：${optNames}` : ''}｜${space.dividends}份分红`
          return (
            <div
              key={space.id}
              className={`ring-cell${isCurrent ? ' current' : ''}${space.isClosed ? ' closed' : ''}${clickable ? ' selectable' : ''}`}
              style={{ gridRow: pos.row + 1, gridColumn: pos.col + 1 }}
              onClick={() => clickable && onChooseMarker?.(space.id)}
              title={tooltip}
            >
              {isCurrent && <span className="marker-icon">💰</span>}
              <div className="cell-top">
                <span className="cell-id">#{space.id}</span>
                <span className="cell-div">{space.dividends}份</span>
                {isCurrent && !space.isClosed && <span className="cell-total">${gross}M</span>}
              </div>
              {space.isClosed ? (
                <span className="cell-closed">✔ 已成交</span>
              ) : (
                <>
                  <div className="cell-req">
                    <span className="cell-req-label req" title="必需家族：全部要有代表">必</span>
                    {space.requiredFamilies.map(f => (
                      <FamilyChip key={`r-${f}`} familyId={f} size="sm" kind="required" />
                    ))}
                  </div>
                  {space.optionalNeed > 0 && (
                    <div className="cell-req">
                      <span className="cell-req-label opt" title={`可选家族：${space.optionalFamilies.length}个中凑${space.optionalNeed}个`}>
                        选{space.optionalNeed}
                      </span>
                      {space.optionalFamilies.map(f => (
                        <FamilyChip key={`o-${f}`} familyId={f} size="sm" kind="optional" />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>

      {renderSeats('right')}
      {renderSeats('bottom')}
    </div>
  )
}
