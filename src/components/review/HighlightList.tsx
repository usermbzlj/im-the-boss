// ============================================================
// HighlightList — 精彩时刻列表（终局卡与复盘侧栏共用）
//   有录像时每条可点"回放"跳到对应动作；没有录像只显示发生在第几笔交易
// ============================================================

import type { CSSProperties } from 'react'
import type { Player } from '../../engine/types'
import { HIGHLIGHT_META, type Highlight } from '../../ui/highlights'
import { seatColor } from '../../ui/personaColor'
import { useViewerId } from '../ViewerContext'
import '../../styles/review.css'

interface HighlightListProps {
  highlights: readonly Highlight[]
  players: readonly Player[]
  /** 可跳转时传入；省略则只展示 */
  onPick?: (h: Highlight) => void
  activeId?: string | null
  /** 每条一行（复盘侧栏） */
  compact?: boolean
}

export default function HighlightList({ highlights, players, onPick, activeId, compact }: HighlightListProps) {
  const viewerId = useViewerId()
  if (highlights.length === 0) return <p className="muted rv-empty">这局比较平淡，没有特别突出的瞬间</p>
  return (
    <ol className={`hl-list${compact ? ' compact' : ''}`} aria-label="精彩时刻">
      {highlights.map(h => {
        const lead = players[h.playerIds[0]]
        const color = lead ? seatColor(lead, viewerId) : null
        const style = color ? ({ '--hl-accent': color.accent } as CSSProperties) : undefined
        const jump = onPick && h.actionIndex != null
        return (
          <li key={h.id} className={`hl-item kind-${h.kind.toLowerCase()}${activeId === h.id ? ' active' : ''}`} style={style} data-kind={h.kind} data-deal={h.dealNo}>
            <span className="hl-icon" aria-hidden="true">{HIGHLIGHT_META[h.kind].icon}</span>
            <div className="hl-body">
              <div className="hl-title">{h.title}</div>
              <div className="hl-text">{h.text}</div>
            </div>
            {jump
              ? <button type="button" className="btn btn-sm hl-go" onClick={() => onPick!(h)} aria-label={`回放：第 ${h.dealNo} 次交易 · ${h.title}`}>回放</button>
              : <span className="hl-deal muted">第 {h.dealNo} 次交易</span>}
          </li>
        )
      })}
    </ol>
  )
}
