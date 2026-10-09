// ============================================================
// ToastLayer — 牌桌上方的行动提示：电脑玩家的重要动作（出牌 / 夺权 / 提案 / 成交 / 流局 / 承诺价变更 …）
//   · 非阻塞，约 2.5–4 秒自动消失，最多同时 3 条，连续同类合并计数，点击立即关闭
//   · 与你有关的事件（你的代表被打飞 / 被挖走 / 被排除出方案 …）用醒目配色并停留更久
//   · 只提示"已落地的事件"，不提示谁在考虑 / 被询问（信息隐藏，见 architecture §7.1）
//   · 尊重 prefers-reduced-motion（见 game.css）
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import type { GameState } from '../engine/types'
import { mergeToasts, toastDraftsFor, type Toast } from '../ui/toasts'
import { useViewerId } from './ViewerContext'

const maxEventId = (state: GameState) => state.events[state.events.length - 1]?.id ?? 0

export default function ToastLayer({ state }: { state: GameState }) {
  const viewerId = useViewerId()
  const [toasts, setToasts] = useState<Toast[]>([])
  /** 已处理到的最后一个事件 id：挂载时取当前值，所以载入存档 / 切换界面不会把旧事件补弹一遍 */
  const lastSeen = useRef(maxEventId(state))
  const keySeq = useRef(0)
  const timers = useRef(new Map<number, { version: number; id: ReturnType<typeof setTimeout> }>())

  const dismiss = useCallback((key: number) => {
    setToasts(cur => cur.filter(t => t.key !== key))
  }, [])

  // 新事件 → 提示
  useEffect(() => {
    const max = maxEventId(state)
    if (max < lastSeen.current) { // 换了一局（事件 id 倒退）
      lastSeen.current = max
      setToasts([])
      return
    }
    if (max === lastSeen.current) return
    const fresh = state.events.filter(e => e.id > lastSeen.current)
    lastSeen.current = max
    const drafts = toastDraftsFor(state, fresh, viewerId)
    if (drafts.length) setToasts(cur => mergeToasts(cur, drafts, () => ++keySeq.current))
  }, [state, viewerId])

  // 每条提示一个消失计时；合并（version 变化）时重新计时
  useEffect(() => {
    const live = new Set(toasts.map(t => t.key))
    for (const [key, t] of timers.current) {
      if (!live.has(key)) { clearTimeout(t.id); timers.current.delete(key) }
    }
    for (const t of toasts) {
      const cur = timers.current.get(t.key)
      if (cur && cur.version === t.version) continue
      if (cur) clearTimeout(cur.id)
      timers.current.set(t.key, { version: t.version, id: setTimeout(() => dismiss(t.key), t.ttl) })
    }
  }, [toasts, dismiss])

  useEffect(() => () => {
    timers.current.forEach(t => clearTimeout(t.id))
    timers.current.clear()
  }, [])

  if (toasts.length === 0) return <div className="toast-layer" aria-live="polite" />

  return (
    <div className="toast-layer" aria-live="polite">
      {toasts.map(t => (
        <button
          key={t.key}
          type="button"
          className={`toast tone-${t.tone}${t.mine ? ' mine' : ''}`}
          title="点击关闭"
          onClick={() => dismiss(t.key)}
        >
          <span className="toast-text">{t.text}</span>
          {t.count > 1 && <span className="toast-count">×{t.count}</span>}
        </button>
      ))}
    </div>
  )
}
