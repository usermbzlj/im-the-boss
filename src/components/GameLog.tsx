// ============================================================
// GameLog — 游戏日志面板
// ============================================================

import { useEffect, useRef } from 'react'
import type { LogEntry } from '../engine/types'

interface GameLogProps {
  log: LogEntry[]
}

export default function GameLog(props: GameLogProps) {
  const { log } = props
  const listRef = useRef<HTMLDivElement>(null)

  // 自动滚动到最新日志
  useEffect(() => {
    const el = listRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [log])

  return (
    <div className="log-panel">
      <div className="log-list" ref={listRef}>
        {log.map((entry) => (
          <div key={entry.id} className={`log-entry ${entry.type}`}>
            {entry.text}
          </div>
        ))}
      </div>
    </div>
  )
}
