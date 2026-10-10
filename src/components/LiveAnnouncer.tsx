// ============================================================
// LiveAnnouncer — 屏幕阅读器播报区（视觉隐藏的 aria-live）
//   "轮到你了"（needsAttention 由假变真时）播一次，对应阶段的一句话说明；不是你做决定的时候清空。
//   其他重要事件由 ToastLayer 的 aria-live 播（同一套筛选），这里不重复。
// ============================================================

import { useEffect, useState } from 'react'
import type { GameState } from '../engine/types'
import { turnAnnouncement } from '../ui/announce'

interface LiveAnnouncerProps {
  state: GameState
  viewerId: number
  /** 此刻是否轮到你做决定（needsAttention） */
  attention: boolean
}

export default function LiveAnnouncer({ state, viewerId, attention }: LiveAnnouncerProps) {
  const [message, setMessage] = useState('')
  const phase = state.phase

  // 每次"轮到你"（以及同一轮里换了阶段，如方案应答 → 成交倒计时）重新播一次
  useEffect(() => {
    setMessage(attention ? turnAnnouncement(state, viewerId) : '')
    // 只在 attention / phase 变化时重播：同一阶段里的状态变化（别人喊话）不重复播
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attention, phase, viewerId])

  return <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="turn-announcer">{message}</div>
}
