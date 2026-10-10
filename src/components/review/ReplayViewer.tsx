// ============================================================
// ReplayViewer — 逐步复盘（终局后，全屏只读）
//   用录像（开局参数 + 动作日志的重放）浏览整局：上一步 / 下一步、按交易跳转、拖动进度条、
//   自动播放（可调速、可跳过放行）、跳到精彩时刻；中间复用 TableBoard 渲染历史状态，
//   侧边是这一步的动作、台词与思考，以及本笔交易的事件流。
//   纯只读：不会发任何动作。"揭晓幕后"开关控制所有人手牌与电脑玩家的思考 / 笔记（默认显示）。
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { GameState, InfluenceCard, PlayerAction } from '../../engine/types'
import { describeAction } from '../../text/labels'
import { cardTypeName, isMinorEvent, narrate } from '../../text/narrate'
import { HIGHLIGHT_META, highlightPosition, type Highlight } from '../../ui/highlights'
import { monogram, seatColor } from '../../ui/personaColor'
import type { Recording } from '../../ui/recording'
import {
  nextDealPosition, nextHighlightPosition, nextPosition, prevDealPosition, prevHighlightPosition, prevPosition, stepDelayMs,
} from '../../ui/replayNav'
import { computeStats } from '../../ui/stats'
import CashChart from './CashChart'
import HighlightList from './HighlightList'
import EventFeed from '../EventFeed'
import FamilyChip from '../FamilyChip'
import NegotiationPanel from '../NegotiationPanel'
import TableBoard from '../TableBoard'
import { useViewerId } from '../ViewerContext'
import '../../styles/review.css'

interface ReplayViewerProps {
  /** 终局状态（名字 / 胜者 / 统计的来源；回放的各步状态来自 recording） */
  state: GameState
  recording: Recording
  highlights: readonly Highlight[]
  /** 打开时所在位置（精彩时刻 / 某笔交易）；默认从头 */
  initialPosition?: number
  onClose: () => void
}

type SideTab = 'feed' | 'highlights' | 'cash'

const SPEEDS = [0.5, 1, 2, 4, 8] as const

/** 手牌排序：先按种类，再按家族 */
const TYPE_ORDER: Record<string, number> = { CLAN: 0, TRAVEL: 1, RECRUITMENT: 2, BOSS: 3, STOP: 4, BOOM: 5, BUST: 6, EXCLUSIVE: 7, SICK: 8 }

function groupHand(hand: readonly InfluenceCard[]): Array<{ card: InfluenceCard; count: number }> {
  const map = new Map<string, { card: InfluenceCard; count: number }>()
  for (const c of hand) {
    const key = `${c.type}:${c.familyId ?? ''}`
    const g = map.get(key)
    if (g) g.count++
    else map.set(key, { card: c, count: 1 })
  }
  return [...map.values()].sort((a, b) =>
    (TYPE_ORDER[a.card.type] - TYPE_ORDER[b.card.type]) || (a.card.familyId ?? '').localeCompare(b.card.familyId ?? ''))
}

function CardPill({ card, count }: { card: InfluenceCard; count: number }) {
  const name = card.type === 'TRAVEL' && !card.familyId ? '万能旅行' : cardTypeName(card.type)
  return (
    <span className={`rv-card type-${card.type.toLowerCase()}`} title={`${name}${card.familyId ? ` · ${card.familyId}` : ''}`}>
      {card.familyId && <FamilyChip familyId={card.familyId} size="sm" />}
      <span>{card.familyId ? (card.type === 'CLAN' ? '成员' : '旅行') : name}</span>
      {count > 1 && <b>×{count}</b>}
    </span>
  )
}

/** 动作的人话描述：用动作之前的状态渲染（手牌 / 目标都还在），出错就退回动作类型 */
function safeDescribe(before: GameState, action: PlayerAction): string {
  try {
    return describeAction(before, action)
  } catch {
    return action.type
  }
}

const SOURCE_LABEL = { human: '玩家操作', ai: '电脑决策', auto: '自动放行' } as const

export default function ReplayViewer({ state, recording, highlights, initialPosition = 0, onClose }: ReplayViewerProps) {
  const viewerId = useViewerId()
  const total = recording.length
  const clamp = useCallback((p: number) => Math.min(total, Math.max(0, Math.trunc(p))), [total])
  const [position, setPosition] = useState(() => clamp(initialPosition))
  const [playing, setPlaying] = useState(false)
  const [speedIdx, setSpeedIdx] = useState(1)
  const [skipMinor, setSkipMinor] = useState(true)
  const [reveal, setReveal] = useState(true)
  const [tab, setTab] = useState<SideTab>('feed')
  const rootRef = useRef<HTMLDivElement>(null)

  const after = useMemo(() => recording.stateAt(position), [recording, position])
  const before = useMemo(() => (position > 0 ? recording.stateAt(position - 1) : null), [recording, position])
  const step = recording.stepInto(position)
  const stats = useMemo(() => computeStats(state, recording), [state, recording])
  const dealNo = recording.dealAtPosition(position)
  const hlPositions = useMemo(() => new Map(highlights.filter(h => h.actionIndex != null).map(h => [highlightPosition(h)!, h])), [highlights])
  const activeHighlight = hlPositions.get(position) ?? null

  const goto = useCallback((p: number | null) => { if (p != null) setPosition(clamp(p)) }, [clamp])

  // ---- 自动播放 ----
  useEffect(() => {
    if (!playing) return
    if (position >= total) { setPlaying(false); return }
    const t = setTimeout(() => setPosition(p => nextPosition(recording, p, skipMinor)), stepDelayMs(recording.stepInto(position + 1), SPEEDS[speedIdx]))
    return () => clearTimeout(t)
  }, [playing, position, total, speedIdx, skipMinor, recording])

  // ---- 键盘：← → 单步，Shift + ← → 按交易，空格播放 / 暂停，Home / End，Esc 关闭 ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
      const el = e.target as HTMLElement | null
      const isRange = el?.tagName === 'INPUT' && (el as HTMLInputElement).type === 'range'
      // 进度条自己处理方向键 / Home / End（原生行为 + onChange）；其他输入控件不抢键
      if (el && ((el.tagName === 'INPUT' && !isRange) || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return
      if (isRange && e.key !== ' ') return
      switch (e.key) {
        case 'ArrowRight': e.preventDefault(); setPlaying(false); setPosition(p => e.shiftKey ? nextDealPosition(recording, p) ?? p : Math.min(total, p + 1)); break
        case 'ArrowLeft': e.preventDefault(); setPlaying(false); setPosition(p => e.shiftKey ? prevDealPosition(recording, p) ?? 0 : prevPosition(p)); break
        case ' ': if (el?.tagName === 'BUTTON') return; e.preventDefault(); setPlaying(v => !v); break
        case 'Home': e.preventDefault(); setPlaying(false); setPosition(0); break
        case 'End': e.preventDefault(); setPlaying(false); setPosition(total); break
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [recording, total, onClose])

  useEffect(() => { rootRef.current?.focus() }, [])

  // ---- 这一步的内容 ----
  const actor = step ? after.players[step.action.playerId] : null
  const actorColor = actor ? seatColor(actor, viewerId) : null
  const thought = step ? (step.action as { thought?: string }).thought : undefined
  const note = step?.action.note
  const say = step?.action.say
  const feedDealNo = after.negotiation ? after.dealHistory.length + 1 : after.dealHistory.length
  const dealSpan = dealNo > 0 ? recording.dealSpan(dealNo) : null

  const setSpeed = (delta: number) => setSpeedIdx(i => Math.min(SPEEDS.length - 1, Math.max(0, i + delta)))
  const stepBy = (delta: number) => { setPlaying(false); setPosition(p => clamp(p + delta)) }

  return (
    <div className="rv-root" role="dialog" aria-label="逐步复盘" aria-modal="true" ref={rootRef} tabIndex={-1}>
      <header className="rv-head">
        <div className="rv-title">
          <b>逐步复盘</b>
          <span className="muted">
            {position === 0 ? '开局' : `第 ${position} / ${total} 步`}
            {dealSpan && <> · {dealSpan.success ? `第 ${dealSpan.dealNumber} 笔成交` : '流局'}（#{dealSpan.spaceId}）</>}
          </span>
        </div>
        <label className="rv-toggle" title="揭晓所有人的手牌，以及电脑玩家随动作写下的思考与笔记">
          <input type="checkbox" checked={reveal} onChange={e => setReveal(e.target.checked)} />
          揭晓幕后（手牌 · 思考）
        </label>
        <span className="rv-readonly muted">只读回放，不会影响对局</span>
        <button className="btn" onClick={onClose}>返回终局</button>
      </header>

      <div className="rv-body">
        <div className="rv-main">
          <div className="rv-board">
            <TableBoard state={after} thinkingId={null} readOnly />
          </div>
          <section className="rv-hands" aria-label="各家手牌">
            {after.players.map(p => {
              const color = seatColor(p, viewerId)
              const style = { '--seat-accent': color.accent, '--seat-soft': color.soft } as CSSProperties
              return (
                <div key={p.id} className={`rv-hand${step?.action.playerId === p.id ? ' acting' : ''}`} style={style} data-player={p.id}>
                  <div className="rv-hand-head">
                    <span className="rv-avatar" aria-hidden="true">{monogram(p.name)}</span>
                    <span className="rv-hand-name">{p.name}{p.id === viewerId ? '（你）' : ''}</span>
                    <span className="rv-hand-cash">${p.cash}M</span>
                  </div>
                  <div className="rv-hand-cards">
                    {reveal
                      ? (p.hand.length === 0 ? <span className="muted">无手牌</span> : groupHand(p.hand).map(g => <CardPill key={`${g.card.type}:${g.card.familyId ?? ''}`} card={g.card} count={g.count} />))
                      : <span className="muted">手牌 {p.hand.length} 张（已隐藏）</span>}
                  </div>
                </div>
              )
            })}
          </section>
        </div>

        <aside className="rv-side">
          <section className="rv-step" aria-label="这一步" data-position={position}>
            {position === 0 || !step ? (
              <>
                <div className="rv-step-top"><span className="rv-step-no">开局</span></div>
                <p className="rv-action">{narrate(after, after.events[0] ?? { kind: 'GAME_STARTED', playerCount: after.players.length, startPlayerId: 0, markerChooserId: 0, variantId: after.variantId, deals: after.dealTiles.length }).text}</p>
                <p className="muted rv-hint">点“下一步”或按空格开始回放；拖动下方进度条可以跳到任意一步。</p>
              </>
            ) : (
              <>
                <div className="rv-step-top" style={actorColor ? ({ '--seat-accent': actorColor.accent, '--seat-soft': actorColor.soft } as CSSProperties) : undefined}>
                  <span className="rv-avatar" aria-hidden="true">{actor ? monogram(actor.name) : '?'}</span>
                  <b className="rv-actor">{actor?.name ?? '?'}{actor?.id === viewerId ? '（你）' : ''}</b>
                  <span className="rv-source muted">{SOURCE_LABEL[step.entry.source]}</span>
                  <span className="rv-step-no">第 {position} 步</span>
                </div>
                <p className="rv-action">{before ? safeDescribe(before, step.action) : step.action.type}</p>
                {say && <blockquote className="rv-say">「{say}」</blockquote>}
                {reveal && thought && <div className="rv-thought" aria-label="思考"><span aria-hidden="true">💭</span> {thought}</div>}
                {reveal && note && <div className="rv-note" aria-label="私人笔记"><span aria-hidden="true">📝</span> {note}</div>}
                {step.events.length > 0 && (
                  <ul className="rv-events" aria-label="这一步发生的事">
                    {step.events.map(e => {
                      const n = narrate(after, e)
                      return <li key={e.id} className={`tone-${n.tone}${isMinorEvent(e) ? ' minor' : ''}`}>{n.text}</li>
                    })}
                  </ul>
                )}
                {activeHighlight && (
                  <div className="rv-hl-flag">{HIGHLIGHT_META[activeHighlight.kind].icon} {activeHighlight.title}：{activeHighlight.text}</div>
                )}
              </>
            )}
          </section>

          <div className="rv-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'feed'} className={`side-tab${tab === 'feed' ? ' active' : ''}`} onClick={() => setTab('feed')}>牌桌动态</button>
            <button role="tab" aria-selected={tab === 'highlights'} className={`side-tab${tab === 'highlights' ? ' active' : ''}`} onClick={() => setTab('highlights')}>
              精彩时刻{highlights.length > 0 && ` (${highlights.length})`}
            </button>
            <button role="tab" aria-selected={tab === 'cash'} className={`side-tab${tab === 'cash' ? ' active' : ''}`} onClick={() => setTab('cash')}>现金走势</button>
          </div>
          <div className="rv-tabbody">
            {tab === 'feed' && (
              after.negotiation
                ? <NegotiationPanel state={after} />
                : feedDealNo > 0
                  ? <div className="rv-feed-wrap"><div className="neg-block-title pad">刚结束的交易 <span className="muted">喊话 · 出牌 · 提案 · 结果</span></div><EventFeed key={feedDealNo} state={after} dealNo={feedDealNo} /></div>
                  : <p className="muted pad">还没有人开单</p>
            )}
            {tab === 'highlights' && (
              <div className="rv-scroll">
                <HighlightList highlights={highlights} players={state.players} compact activeId={activeHighlight?.id ?? null}
                  onPick={h => { setPlaying(false); goto(highlightPosition(h)) }} />
              </div>
            )}
            {tab === 'cash' && (
              <div className="rv-scroll">
                <CashChart series={stats.cashSeries} players={state.players} winnerIds={state.winnerIds}
                  cursorDeal={dealNo} markers={highlights.map(h => h.dealNo)}
                  onPickDeal={n => { setPlaying(false); goto(recording.positionOpened(n)) }} />
              </div>
            )}
          </div>
        </aside>
      </div>

      <footer className="rv-controls">
        <div className="rv-deals" role="group" aria-label="按交易跳转">
          {recording.deals.map(d => (
            <button
              key={d.dealNo}
              type="button"
              className={`rv-deal-chip${d.dealNo === dealNo ? ' active' : ''}${d.success ? '' : ' fail'}${highlights.some(h => h.dealNo === d.dealNo) ? ' has-hl' : ''}`}
              title={`第 ${d.dealNo} 次交易 · #${d.spaceId} · ${d.success ? `第 ${d.dealNumber} 笔成交` : '流局'} · Boss ${state.players[d.bossId]?.name}`}
              onClick={() => { setPlaying(false); goto(recording.positionOpened(d.dealNo)) }}
            >
              {d.success ? `第${d.dealNumber}笔` : `#${d.spaceId}✗`}
            </button>
          ))}
        </div>

        <div className="rv-timeline">
          <div className="rv-track" aria-hidden="true">
            {recording.deals.map(d => {
              const start = d.openStep + 1, end = d.endStep + 1
              return (
                <i key={d.dealNo} className={`rv-seg${d.success ? '' : ' fail'}${d.dealNo === dealNo ? ' active' : ''}`}
                  style={{ left: `${(start / total) * 100}%`, width: `${Math.max(0.4, ((end - start) / total) * 100)}%` }} />
              )
            })}
            {[...hlPositions.keys()].map(p => (
              <b key={p} className="rv-star" style={{ left: `${(p / total) * 100}%` }}>◆</b>
            ))}
          </div>
          <input
            type="range" min={0} max={total} value={position} className="rv-slider" aria-label="进度"
            onChange={e => { setPlaying(false); setPosition(clamp(Number(e.target.value))) }}
          />
        </div>

        <div className="rv-buttons">
          <button className="btn btn-sm" onClick={() => goto(prevHighlightPosition(highlights, position))} disabled={prevHighlightPosition(highlights, position) == null} title="上一个精彩时刻">◆◀</button>
          <button className="btn btn-sm" onClick={() => { setPlaying(false); goto(prevDealPosition(recording, position) ?? 0) }} disabled={position === 0} title="上一笔交易（Shift + ←）">⏮ 上一笔</button>
          <button className="btn btn-sm" onClick={() => stepBy(-1)} disabled={position === 0} title="上一步（←）">◀ 上一步</button>
          <button className="btn-primary rv-play" onClick={() => { if (position >= total) setPosition(0); setPlaying(v => !v) }} title="播放 / 暂停（空格）">
            {playing ? '⏸ 暂停' : position >= total ? '↺ 重播' : '▶ 播放'}
          </button>
          <button className="btn btn-sm" onClick={() => stepBy(1)} disabled={position >= total} title="下一步（→）">下一步 ▶</button>
          <button className="btn btn-sm" onClick={() => { setPlaying(false); goto(nextDealPosition(recording, position)) }} disabled={nextDealPosition(recording, position) == null} title="下一笔交易（Shift + →）">下一笔 ⏭</button>
          <button className="btn btn-sm" onClick={() => goto(nextHighlightPosition(highlights, position))} disabled={nextHighlightPosition(highlights, position) == null} title="下一个精彩时刻">▶◆</button>
          <span className="rv-speed" role="group" aria-label="播放速度">
            <button className="btn btn-sm" onClick={() => setSpeed(-1)} disabled={speedIdx === 0} aria-label="减速">−</button>
            <span className="rv-speed-label" aria-live="polite">{SPEEDS[speedIdx]}×</span>
            <button className="btn btn-sm" onClick={() => setSpeed(1)} disabled={speedIdx === SPEEDS.length - 1} aria-label="加速">+</button>
          </span>
          <label className="rv-toggle small" title="自动播放时略过只有放行 / 跳过的步骤（手动单步不受影响）">
            <input type="checkbox" checked={skipMinor} onChange={e => setSkipMinor(e.target.checked)} /> 播放时跳过放行
          </label>
        </div>
      </footer>
    </div>
  )
}
