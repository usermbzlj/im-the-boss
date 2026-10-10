// ============================================================
// DealHistoryPanel — 交易历史：每笔分成明细 + 各家累计（AI"记仇"依据的可视化）
//   终局后（reviewable）：每笔可点"在复盘中查看"，并显示精彩标签（点标签直接跳到那一步）
// ============================================================

import type { GameState, DealRecord } from '../engine/types'
import { HIGHLIGHT_META, type Highlight } from '../ui/highlights'
import { highlightsOfDeal } from '../ui/review'

/** 各玩家的累计收入：成交时 Boss 净得 + 他人分成 + 地标租金（流局不计） */
export function dealTotals(history: DealRecord[]): Map<number, number> {
  const totals = new Map<number, number>()
  const add = (id: number, amount: number) => totals.set(id, (totals.get(id) ?? 0) + amount)
  for (const rec of history) {
    if (!rec.success) continue
    add(rec.bossId, rec.grossValue - rec.payouts.reduce((s, p) => s + p.amount, 0))
    for (const p of rec.payouts) add(p.playerId, p.amount)
    for (const r of rec.rents ?? []) add(r.playerId, r.amount)
  }
  return totals
}

interface DealHistoryPanelProps {
  state: GameState
  /** 终局后的精彩时刻：每笔交易上显示标签 */
  highlights?: readonly Highlight[]
  /** 可以进复盘（终局、且有可回放的录像）；为假时不显示"在复盘中查看" */
  reviewable?: boolean
  /** 在复盘中查看第 dealNo 次交易 */
  onReviewDeal?: (dealNo: number) => void
  /** 点某个精彩标签：跳到那一步 */
  onReviewHighlight?: (h: Highlight) => void
}

export default function DealHistoryPanel({ state, highlights = [], reviewable = false, onReviewDeal, onReviewHighlight }: DealHistoryPanelProps) {
  const { dealHistory, players } = state
  const name = (id: number) => players[id]?.name ?? `#${id}`

  // 累计收入 = 成交分成（Boss 净得 + 他人分成）+ 地标租金。起始现金为 0，所以
  // 现金 = 累计收入 − 买牌 / 兑换付给银行的支出（关桌规时两者完全相等）。口径写在面板上，并把当前现金并排列出便于核对。
  const totals = dealTotals(dealHistory)
  // 交易编号 = 在 dealHistory 里的下标 + 1（成交与流局都占号），和事件的 dealNo、复盘的交易序号一致
  const rows = dealHistory.map((rec, i) => ({ rec, dealNo: i + 1 })).reverse()

  return (
    <div className="log-panel">
      <div className="log-list">
        {dealHistory.length === 0 && <p className="muted pad">暂无交易记录</p>}
        {totals.size > 0 && (
          <>
            <div className="muted deal-history-caption" data-testid="totals-caption" title="起始现金为 0：现金 = 累计收入 − 买牌 / 兑换支出（关桌规时两者相等）">
              累计收入 = 成交分成 + 地标租金（不含买牌 / 兑换支出），括号内为当前现金
            </div>
            <div className="deal-history-totals">
              {[...totals.entries()].sort((a, b) => b[1] - a[1]).map(([pid, amt]) => (
                <span key={pid} className="totals-chip">{name(pid)} <b>${amt}M</b> <span className="muted">（现金 ${players[pid]?.cash ?? 0}M）</span></span>
              ))}
            </div>
          </>
        )}
        {rows.map(({ rec, dealNo }) => {
          const tags = highlightsOfDeal(highlights, dealNo)
          return (
            <div key={rec.id} className={`deal-record${rec.success ? '' : ' deal-record-fail'}`} data-deal-no={dealNo}>
              <div className="deal-record-header">
                <span>第 {rec.dealNumber} 笔 · #{rec.spaceId}</span>
                <span>{rec.success ? `✓ 成交 $${rec.grossValue}M` : '✗ 流局'}</span>
              </div>
              <div className="deal-record-boss">
                Boss：{name(rec.bossId)}{rec.openerId !== rec.bossId ? `（发起者 ${name(rec.openerId)}）` : ''}
              </div>
              {rec.success ? (
                rec.payouts.length > 0 ? (
                  <div className="deal-record-payout">
                    {rec.payouts.map(p => <span key={p.playerId}>{name(p.playerId)} +${p.amount}M</span>)}
                    <span className="muted">Boss 净得 ${rec.grossValue - rec.payouts.reduce((s, p) => s + p.amount, 0)}M</span>
                  </div>
                ) : (
                  <div className="deal-record-payout muted">独吞 ${rec.grossValue}M</div>
                )
              ) : (
                <div className="deal-record-payout muted">{rec.failReason === 'ABANDONED' ? `${name(rec.bossId)} 主动放弃` : rec.failReason === 'STALEMATE' ? '谈判僵局，连续多轮无人行动' : rec.failReason === 'INCOMPLETE' ? '桌上凑不齐代表，全员跳过一轮' : '未知原因'}</div>
              )}
              {rec.disruptors.length > 0 && (
                <div className="deal-record-disruptors">搅局：{rec.disruptors.map(name).join('、')}</div>
              )}
              {(tags.length > 0 || (reviewable && onReviewDeal)) && (
                <div className="deal-record-review">
                  {tags.map(h => {
                    const jump = reviewable && onReviewHighlight && h.actionIndex != null
                    const label = `${HIGHLIGHT_META[h.kind].icon} ${h.title}`
                    return jump
                      ? <button key={h.id} type="button" className="hl-tag" title={h.text} onClick={() => onReviewHighlight!(h)}>{label}</button>
                      : <span key={h.id} className="hl-tag static" title={h.text}>{label}</span>
                  })}
                  {reviewable && onReviewDeal && (
                    <button type="button" className="btn btn-sm deal-review-btn" onClick={() => onReviewDeal(dealNo)}>在复盘中查看</button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
