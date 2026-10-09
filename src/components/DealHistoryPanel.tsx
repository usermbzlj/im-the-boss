// ============================================================
// DealHistoryPanel — 交易历史：每笔分成明细 + 各家累计（AI"记仇"依据的可视化）
// ============================================================

import type { GameState, DealRecord } from '../engine/types'

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

export default function DealHistoryPanel({ state }: { state: GameState }) {
  const { dealHistory, players } = state
  const name = (id: number) => players[id]?.name ?? `#${id}`

  // 累计收入 = 成交分成（Boss 净得 + 他人分成）+ 地标租金。起始现金为 0，所以
  // 现金 = 累计收入 − 买牌 / 兑换付给银行的支出（关桌规时两者完全相等）。口径写在面板上，并把当前现金并排列出便于核对。
  const totals = dealTotals(dealHistory)

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
        {[...dealHistory].reverse().map(rec => (
          <div key={rec.id} className={`deal-record${rec.success ? '' : ' deal-record-fail'}`}>
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
              <div className="deal-record-payout muted">{rec.failReason === 'ABANDONED' ? `${name(rec.bossId)} 主动放弃` : rec.failReason === 'STALEMATE' ? '谈判僵局，连续多轮无人行动' : '未知原因'}</div>
            )}
            {rec.disruptors.length > 0 && (
              <div className="deal-record-disruptors">搅局：{rec.disruptors.map(name).join('、')}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
