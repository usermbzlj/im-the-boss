// ============================================================
// DealHistoryPanel — 交易历史：每笔分成明细 + 各家累计（AI"记仇"依据的可视化）
// ============================================================

import type { GameState } from '../engine/types'

export default function DealHistoryPanel({ state }: { state: GameState }) {
  const { dealHistory, players } = state
  const name = (id: number) => players[id]?.name ?? `#${id}`

  const totals = new Map<number, number>()
  for (const rec of dealHistory) {
    if (!rec.success) continue
    const bossGain = rec.grossValue - rec.payouts.reduce((s, p) => s + p.amount, 0)
    totals.set(rec.bossId, (totals.get(rec.bossId) ?? 0) + bossGain)
    for (const p of rec.payouts) totals.set(p.playerId, (totals.get(p.playerId) ?? 0) + p.amount)
  }

  return (
    <div className="log-panel">
      <div className="log-list">
        {dealHistory.length === 0 && <p className="muted pad">暂无交易记录</p>}
        {totals.size > 0 && (
          <div className="deal-history-totals">
            {[...totals.entries()].sort((a, b) => b[1] - a[1]).map(([pid, amt]) => (
              <span key={pid} className="totals-chip">{name(pid)} <b>${amt}M</b></span>
            ))}
          </div>
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
