// ============================================================
// GameLog — 事件日志面板（事件 → 文案由 text/narrate 统一渲染）
// ============================================================

import { useEffect, useRef } from 'react'
import type { GameState } from '../engine/types'
import { narrate } from '../text/narrate'

export default function GameLog({ state }: { state: GameState }) {
  const listRef = useRef<HTMLDivElement>(null)
  const last = state.events[state.events.length - 1]?.id

  // 自动滚动到最新
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [last])

  return (
    <div className="log-panel">
      <div className="log-list" ref={listRef}>
        {state.events.map(e => {
          const { text, tone } = narrate(state, e)
          return <div key={e.id} className={`log-entry tone-${tone}`}>{text}</div>
        })}
      </div>
    </div>
  )
}
