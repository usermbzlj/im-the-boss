// ============================================================
// useUnread — 侧栏抽屉收起时的未读动态计数（规则见 ui/unread）
//   · visible = 侧栏此刻正被看着（抽屉打开 / 桌面常驻）：此时一律视为已读
//   · 载入存档 / 开新局（事件 id 倒退或第一次出现状态）时以当前最后一条事件为基线，不把旧事件算未读
// ============================================================

import { useEffect, useRef, useState } from 'react'
import type { GameState } from '../engine/types'
import { lastEventId, unreadCount } from '../ui/unread'

export function useUnread(state: GameState | null, viewerId: number, visible: boolean): number {
  const [seen, setSeen] = useState(() => (state ? lastEventId(state) : 0))
  const had = useRef(!!state)
  const last = state ? lastEventId(state) : 0

  useEffect(() => {
    if (!state) { had.current = false; return }
    if (!had.current) { had.current = true; setSeen(last); return } // 刚进入对局：以当前为基线
    if (last < seen) { setSeen(last); return } // 换了一局：事件 id 倒退
    if (visible && seen !== last) setSeen(last)
  }, [state, last, seen, visible])

  if (!state || visible) return 0
  return unreadCount(state, seen, viewerId)
}
