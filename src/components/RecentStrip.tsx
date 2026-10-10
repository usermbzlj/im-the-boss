// ============================================================
// RecentStrip — "刚刚发生"简报：PhaseGuide 下方一行，最近 1–3 条重要事件的短句。
// 固定高度（有没有事件都占位），避免出现 / 消失时牵动版图重新缩放。
// ============================================================

import { useMemo, useRef } from 'react'
import type { GameState } from '../engine/types'
import { recentDigest } from '../ui/eventFeed'
import { useViewerId } from './ViewerContext'

export default function RecentStrip({ state, limit = 3 }: { state: GameState; limit?: number }) {
  const viewerId = useViewerId()
  const items = useMemo(() => recentDigest(state, viewerId, limit), [state, viewerId, limit])
  /** 挂载时已有的最后一条事件：之后新到的条目入场高亮（插入时播放一次） */
  const baseline = useRef(state.events[state.events.length - 1]?.id ?? 0)

  return (
    <div className="recent-strip" aria-label="刚刚发生">
      <span className="recent-label">刚刚</span>
      {items.length === 0 && <span className="recent-empty">牌局刚开始</span>}
      {items.map(it => (
        <span key={it.id} className={`recent-item tone-${it.tone}${it.mine ? ' mine' : ''}${it.id > baseline.current ? ' feed-new' : ''}`} title={it.text}>
          {it.text}
        </span>
      ))}
    </div>
  )
}
