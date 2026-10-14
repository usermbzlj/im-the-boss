// ============================================================
// CashChart — 现金走势小图（内联 SVG，无依赖）：每笔交易之后每位玩家的现金，按人物主题色
//   终局卡里是静态小图；复盘里可点某一笔跳转，并用竖线标出当前交易
// ============================================================

import type { CSSProperties } from 'react'
import type { Player } from '../../engine/types'
import type { CashSeries } from '../../ui/stats'
import { seatColor } from '../../ui/personaColor'
import { useViewerId } from '../ViewerContext'
import '../../styles/review.css'

interface CashChartProps {
  series: CashSeries
  players: Player[]
  winnerIds: number[]
  /** 当前所在的交易（复盘里的游标竖线） */
  cursorDeal?: number
  /** 精彩时刻所在的交易，在横轴上标小菱形 */
  markers?: number[]
  /** 点某一笔交易（复盘里跳转） */
  onPickDeal?: (dealNo: number) => void
  /** 只高亮某位玩家（其余变淡） */
  focusId?: number | null
}

const W = 560, H = 230
const M = { l: 38, r: 14, t: 14, b: 26 }

/** 纵轴刻度：取整到 5 / 10 / 20 … 的好看数字 */
function niceMax(v: number): number {
  if (v <= 10) return 10
  const unit = v <= 40 ? 10 : v <= 100 ? 20 : v <= 200 ? 50 : 100
  return Math.ceil(v / unit) * unit
}

export default function CashChart({ series, players, winnerIds, cursorDeal, markers, onPickDeal, focusId }: CashChartProps) {
  const viewerId = useViewerId()
  const pts = series.points
  const last = pts.length - 1
  if (last < 1) return <p className="muted rv-empty">还没有产生交易，没有走势可画</p>

  const maxCash = niceMax(Math.max(1, ...pts.flatMap(p => p.cash)))
  const minCash = Math.min(0, ...pts.flatMap(p => p.cash))
  const x = (i: number) => M.l + (i / last) * (W - M.l - M.r)
  const y = (v: number) => M.t + (1 - (v - minCash) / (maxCash - minCash)) * (H - M.t - M.b)
  const ticks = [0, 1, 2, 3, 4].map(k => minCash + ((maxCash - minCash) * k) / 4)
  const xTickEvery = last > 24 ? 5 : last > 12 ? 2 : 1
  // 同一笔交易可以有多个精彩时刻，横轴只标一次，交易编号也是稳定的元素标识。
  const markedDeals = [...new Set(markers ?? [])].filter(dealNo => Number.isInteger(dealNo) && dealNo >= 1 && dealNo <= last)

  return (
    <figure className="cash-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="每笔交易后的现金走势" preserveAspectRatio="xMidYMid meet">
        {ticks.map(t => (
          <g key={t}>
            <line className="cc-grid" x1={M.l} x2={W - M.r} y1={y(t)} y2={y(t)} />
            <text className="cc-axis" x={M.l - 6} y={y(t) + 3} textAnchor="end">${Math.round(t)}</text>
          </g>
        ))}
        {pts.map((_, i) => (i === 0 || i % xTickEvery === 0 || i === last) && (
          <text key={i} className="cc-axis" x={x(i)} y={H - 8} textAnchor="middle">{i === 0 ? '开局' : i}</text>
        ))}
        {cursorDeal != null && cursorDeal >= 0 && cursorDeal <= last && (
          <line className="cc-cursor" x1={x(cursorDeal)} x2={x(cursorDeal)} y1={M.t} y2={H - M.b} />
        )}
        {players.map(p => {
          const color = seatColor(p, viewerId).accent
          const win = winnerIds.includes(p.id)
          const dim = focusId != null && focusId !== p.id
          const d = pts.map((pt, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(pt.cash[p.id]).toFixed(1)}`).join(' ')
          const style = { '--line': color, animationDelay: `${p.id * 80}ms` } as CSSProperties
          return (
            <g key={p.id} className={`cc-series${dim ? ' dim' : ''}${win ? ' winner' : ''}`} data-player={p.id}>
              <path className="cc-line" d={d} pathLength={1} style={style} stroke={color} strokeWidth={win ? 3 : 2} />
              <circle cx={x(last)} cy={y(pts[last].cash[p.id])} r={win ? 4.5 : 3.5} fill={color}>
                <title>{`${p.name}：最终 $${pts[last].cash[p.id]}M`}</title>
              </circle>
            </g>
          )
        })}
        {markedDeals.map(dealNo => (
          <path key={`m${dealNo}`} className="cc-marker" d={`M${x(dealNo)},${H - M.b - 2} l4,-5 l-4,-5 l-4,5 z`}>
            <title>{`第 ${dealNo} 次交易有精彩时刻`}</title>
          </path>
        ))}
        {onPickDeal && pts.slice(1).map((_, k) => {
          const i = k + 1
          const w = (W - M.l - M.r) / last
          return (
            <rect key={i} className="cc-hit" x={x(i) - w / 2} y={M.t} width={w} height={H - M.t - M.b}
              onClick={() => onPickDeal(i)}>
              <title>{`第 ${i} 次交易：${players.map(p => `${p.name} $${pts[i].cash[p.id]}M`).join('　')}`}</title>
            </rect>
          )
        })}
      </svg>
      <figcaption className="cc-caption muted">
        横轴 = 第几次交易（成交与流局都占号）{series.exact ? '，纵轴 = 当时的现金（已扣除买牌 / 兑换支出）' : '，纵轴 = 累计收入（事件流已被截断，未含买牌 / 兑换支出）'}
      </figcaption>
    </figure>
  )
}
