// ============================================================
// EventFeed — 谈判桌里的"本笔交易"事件流
//   事件按时间排列：喊话是人物气泡，出牌 / 提案 / 被打飞 / 夺权等是一行行消息，
//   连续的跳过 / 放行折叠成"某某等 N 人跳过"。挂载之后新到的条目有入场高亮。
// ============================================================

import { useEffect, useMemo, useRef } from 'react'
import type { CSSProperties } from 'react'
import type { GameState } from '../engine/types'
import { dealFeed } from '../ui/eventFeed'
import { monogram, seatColor } from '../ui/personaColor'
import { useViewerId } from './ViewerContext'

export default function EventFeed({ state, dealNo }: { state: GameState; dealNo: number }) {
  const viewerId = useViewerId()
  const items = useMemo(() => dealFeed(state, dealNo), [state, dealNo])
  const listRef = useRef<HTMLDivElement>(null)
  /** 挂载时已有的最后一条事件 id：之后到达的条目才算"新"，只在插入时播放一次入场高亮 */
  const baseline = useRef(state.events[state.events.length - 1]?.id ?? 0)
  const last = items[items.length - 1]
  const lastKey = last ? (last.type === 'passes' ? last.lastId : last.id) : 0

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lastKey])

  const neg = state.negotiation

  return (
    <div className="neg-feed" ref={listRef} role="log" aria-label="本笔交易动态">
      {items.length === 0 && <span className="muted">还没有动静</span>}
      {items.map(item => {
        const fresh = item.id > baseline.current ? ' feed-new' : ''
        if (item.type === 'speech') {
          const p = state.players[item.playerId]
          const color = p ? seatColor(p, viewerId) : null
          const style = color ? ({ '--seat-accent': color.accent, '--seat-soft': color.soft } as CSSProperties) : undefined
          return (
            <div key={item.id} className={`chat-line feed-speech${item.playerId === viewerId ? ' mine' : ''}${item.playerId === neg?.bossId ? ' boss' : ''}${fresh}`} style={style}>
              <span className="feed-avatar" aria-hidden="true">{monogram(p?.name ?? '?')}</span>
              <div className="feed-bubble">
                <b>{p?.name ?? '?'}{item.playerId === viewerId ? '（你）' : ''}</b>
                <span>{item.text}</span>
              </div>
            </div>
          )
        }
        if (item.type === 'passes') {
          return <div key={item.id} className={`feed-event feed-minor${fresh}`}>{item.text}</div>
        }
        return <div key={item.id} className={`feed-event tone-${item.tone}${fresh}`}>{item.text}</div>
      })}
    </div>
  )
}
