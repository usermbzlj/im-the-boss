// ============================================================
// GameOverCard — 终局画面：胜者 + 排名（并列同名次）+ 现金走势 + 每人关键数据 + 精彩时刻 + 复盘入口
//   统计与精彩时刻来自 ui/review（有录像时更完整；没有录像只用交易历史，复盘入口随之隐藏）
// ============================================================

import { useMemo } from 'react'
import type { CSSProperties } from 'react'
import type { GameState } from '../engine/types'
import { getVariant } from '../engine/config'
import { buildReview, type GameReview } from '../ui/review'
import { describeCashFlow, type PlayerStats } from '../ui/stats'
import type { Recording } from '../ui/recording'
import { highlightPosition, type Highlight } from '../ui/highlights'
import { monogram, seatColor } from '../ui/personaColor'
import { rankStandings } from '../ui/standings'
import CashChart from './review/CashChart'
import HighlightList from './review/HighlightList'
import { useViewerId } from './ViewerContext'
import '../styles/review.css'

// 名次逻辑已挪到 ui/standings，这里原样再导出，旧引用（测试 / 其他组件）不受影响
export { rankStandings } from '../ui/standings'
export type { Standing } from '../ui/standings'

/** 复盘数据的整理进度：building 时入口显示"整理中"，unavailable 表示存档不可回放 */
export type ReplayStatus = 'idle' | 'building' | 'ready' | 'unavailable'

interface GameOverCardProps {
  state: GameState
  onRestart: () => void
  /** 回到牌桌（侧栏看交易历史） */
  onReview: () => void
  /** 动作日志重放出的录像；没有（或不可回放）时不显示逐步复盘入口 */
  recording?: Recording | null
  replayStatus?: ReplayStatus
  /** 已算好的统计与精彩时刻（App 里和交易历史面板共用）；省略则自己算 */
  review?: GameReview
  /** 打开逐步复盘；position = 直接跳到的位置（精彩时刻） */
  onOpenReplay?: (position?: number) => void
}

const MEDALS = ['🥇', '🥈', '🥉']

/** 一位玩家的关键数据（一行小标签） */
function keyFacts(s: PlayerStats): Array<{ text: string; title?: string }> {
  const facts: Array<{ text: string; title?: string }> = []
  facts.push({
    text: `Boss ${s.bossDeals} 次（成交 ${s.bossClosed} · 流局 ${s.bossFailed}）`,
    title: s.takeovers > 0 ? `其中 ${s.takeovers} 次是打出老板牌夺权后收场` : '作为 Boss 收场的交易',
  })
  if (s.shareDeals > 0) facts.push({ text: `分成 ${s.shareDeals} 笔`, title: '作为代表拿到分成的成交笔数' })
  if (s.soloDeals > 0) facts.push({ text: `独吞 ${s.soloDeals} 笔`, title: '自己当 Boss、一分没分给别人' })
  if (s.cardsPlayed != null) facts.push({ text: `出牌 ${s.cardsPlayed} 张`, title: '打出的影响牌（含阻止牌）' })
  if (s.disrupts > 0) facts.push({ text: `搅局 ${s.disrupts}`, title: '在别人的交易里打出旅行 / 招募 / 老板 / 利空牌，或夺权' })
  if (s.disrupted > 0) facts.push({ text: `被搅局 ${s.disrupted}`, title: '自己当 Boss（或夺权前的发起者）时被人搅局的笔数' })
  if (s.excluded != null && s.excluded > 0) facts.push({ text: `被排除 ${s.excluded}`, title: '成交时桌上有自己可用的代表，却没被选用也没分到钱' })
  if (s.bestDeal) facts.push({ text: `最大单笔 $${s.bestDeal.amount}M`, title: `第 ${s.bestDeal.dealNo} 次交易` })
  return facts
}

export default function GameOverCard({ state, onRestart, onReview, recording = null, replayStatus, review, onOpenReplay }: GameOverCardProps) {
  const viewerId = useViewerId()
  const data = useMemo(() => review ?? buildReview(state, recording), [review, state, recording])
  const { stats, highlights } = data
  const standings = rankStandings(state.players)
  const top = standings[0]?.player.cash ?? 0
  const maxIncome = Math.max(1, ...stats.players.map(p => p.income.total))
  const winners = state.winnerIds.map(id => state.players[id]).filter(Boolean)
  const canReplay = !!recording && !!onOpenReplay
  const building = !recording && replayStatus === 'building'
  const variant = getVariant(state.variantId)
  const statOf = (id: number) => stats.players[id]
  const you = state.players[viewerId]

  const pickHighlight = (h: Highlight) => {
    const pos = highlightPosition(h)
    if (pos != null) onOpenReplay?.(pos)
  }

  return (
    <div className="go-overlay">
      <div className="go-card" role="dialog" aria-label="游戏结束">
        <header className="go-head">
          <div className="go-eyebrow">游戏结束</div>
          <div className="go-winners">
            {winners.map(w => {
              const c = seatColor(w, viewerId)
              return (
                <span key={w.id} className="go-crest" style={{ '--seat-accent': c.accent, '--seat-soft': c.soft } as CSSProperties} aria-hidden="true">
                  {monogram(w.name)}
                </span>
              )
            })}
            <div>
              <p className="winner-name">
                {winners.map(w => w.name).join('、')}{winners.length > 1 ? ' 并列' : ''}获胜
              </p>
              <p className="go-sub">
                ${top}M · {variant.name} · 共 {stats.deals.total} 次交易（成交 {stats.deals.closed} · 流局 {stats.deals.failed}）
                {you && !state.winnerIds.includes(viewerId) && <> · 你排第 {standings.find(s => s.player.id === viewerId)?.rank}</>}
                {you && state.winnerIds.includes(viewerId) && <> · 你赢了</>}
              </p>
            </div>
          </div>
        </header>

        <div className="go-grid">
          <section className="go-col" aria-label="最终排名">
            <h3 className="go-h">最终排名</h3>
            <div className="final-standings">
              {standings.map(({ player: p, rank, tied }) => {
                const s = statOf(p.id)
                const c = seatColor(p, viewerId)
                const style = { '--seat-accent': c.accent, '--seat-soft': c.soft } as CSSProperties
                return (
                  <div key={p.id} className={`standing${state.winnerIds.includes(p.id) ? ' winner' : ''}`} data-rank={rank} style={style}>
                    <div className="standing-main">
                      <span className="standing-rank" aria-hidden="true">{rank <= 3 ? MEDALS[rank - 1] : rank}</span>
                      <span className="standing-avatar" aria-hidden="true">{monogram(p.name)}</span>
                      <span className="standing-name">{rank}{tied ? '（并列）' : ''}. {p.name}{p.id === viewerId ? '（你）' : ''}</span>
                      <span className="standing-cash">${p.cash}M</span>
                    </div>
                    {s && (
                      <>
                        <div className="standing-bar" title={describeCashFlow(state, s)} aria-hidden="true">
                          <i className="seg-boss" style={{ width: `${(s.income.boss / maxIncome) * 100}%` }} />
                          <i className="seg-share" style={{ width: `${(s.income.share / maxIncome) * 100}%` }} />
                          <i className="seg-rent" style={{ width: `${(s.income.rent / maxIncome) * 100}%` }} />
                        </div>
                        <div className="standing-flow">
                          Boss 所得 ${s.income.boss}M · 分成 ${s.income.share}M
                          {s.income.rent > 0 && <> · 租金 ${s.income.rent}M</>}
                          {s.spend.total > 0 && <> · <span className="red">买牌 / 兑换 −${s.spend.total}M</span></>}
                          {rank > 1 && <span className="muted"> · 落后 ${top - p.cash}M</span>}
                        </div>
                        <div className="standing-facts">
                          {keyFacts(s).map((f, i) => <span key={i} className="fact" title={f.title}>{f.text}</span>)}
                        </div>
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          </section>

          <section className="go-col" aria-label="现金走势与精彩时刻">
            <h3 className="go-h">现金走势</h3>
            <CashChart series={stats.cashSeries} players={state.players} winnerIds={state.winnerIds} markers={highlights.map(h => h.dealNo)} />
            <ul className="go-legend" aria-label="图例">
              {state.players.map(p => (
                <li key={p.id} style={{ '--seat-accent': seatColor(p, viewerId).accent } as CSSProperties}>
                  <i aria-hidden="true" />{p.name}
                </li>
              ))}
            </ul>

            <h3 className="go-h">精彩时刻</h3>
            <HighlightList highlights={highlights} players={state.players} onPick={canReplay ? pickHighlight : undefined} />
          </section>
        </div>

        <details className="go-basis">
          <summary>
            数据口径 <span className={stats.reconciliation.ok ? 'green' : 'red'}>{stats.reconciliation.ok ? '✓ 已与引擎对账' : '⚠ 口径存在差异'}</span>
          </summary>
          <ul>
            {stats.reconciliation.notes.map((n, i) => <li key={i}>{n}</li>)}
            {stats.players.map(s => <li key={s.playerId}>{describeCashFlow(state, s)}</li>)}
          </ul>
        </details>

        {replayStatus === 'unavailable' && !recording && (
          <p className="muted go-note">这局的存档没有可重放的动作日志，无法逐步复盘；上面的统计来自交易历史。</p>
        )}

        <div className="neg-actions go-actions">
          {canReplay && <button className="btn-primary" onClick={() => onOpenReplay!()}>逐步复盘</button>}
          {building && <button className="btn" disabled>正在整理复盘…</button>}
          <button className={canReplay ? 'btn' : 'btn-primary'} onClick={onRestart}>再来一局</button>
          <button className="btn" onClick={onReview}>回到牌桌</button>
        </div>
      </div>
    </div>
  )
}
