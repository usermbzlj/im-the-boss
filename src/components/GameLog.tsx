// ============================================================
// GameLog — 事件日志面板（事件 → 文案由 text/narrate 统一渲染）
// ============================================================

import { useEffect, useRef, useState } from 'react'
import type { GameState } from '../engine/types'
import { narrate } from '../text/narrate'

export default function GameLog({ state }: { state: GameState }) {
  const listRef = useRef<HTMLDivElement>(null)
  const [showMinor, setShowMinor] = useState(false)
  const last = state.events[state.events.length - 1]?.id
  const entries = state.events
    .map(e => ({ id: e.id, ...narrate(state, e) }))
    .filter(e => showMinor || !e.minor)

  // 自动滚动到最新
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [last, showMinor])

  return (
    <div className="log-panel">
      <label className="log-filter muted">
        <input type="checkbox" checked={showMinor} onChange={e => setShowMinor(e.target.checked)} /> 显示跳过 / 放行
      </label>
      <div className="log-list" ref={listRef}>
        {entries.map(e => <div key={e.id} className={`log-entry tone-${e.tone}`}>{e.text}</div>)}
      </div>
    </div>
  )
}
