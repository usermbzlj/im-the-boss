// ============================================================
// DealHistoryPanel — 交易历史面板
// ============================================================
//
// 复用 GameState.dealHistory（见 gameEngine.ts closeDeal/failDeal 写入），
// 同时服务两个目的：
// 1. 人类玩家复盘每笔交易的分成明细
// 2. 把"记仇"等人格用作决策依据的同一份数据可视化出来，让玩家理解 AI
//    为什么突然对某人不客气——之前这份记忆只存在于 prompt 里，玩家完全
//    看不到、也就无法理解 AI 行为的"因果"。

import type { GameState } from '../engine/types'

interface DealHistoryPanelProps {
  state: GameState
}

export default function DealHistoryPanel({ state }: DealHistoryPanelProps) {
  const { dealHistory, players } = state
  const name = (id: number) => players[id]?.name ?? `#${id}`

  const totals = new Map<number, number>()
  for (const rec of dealHistory) {
    if (!rec.success) continue
    const bossGain = rec.grossValue - rec.payout.reduce((s, p) => s + p.amount, 0)
    totals.set(rec.bossPlayerId, (totals.get(rec.bossPlayerId) ?? 0) + bossGain)
    for (const p of rec.payout) totals.set(p.playerId, (totals.get(p.playerId) ?? 0) + p.amount)
  }

  return (
    <div className="log-panel">
      <div className="log-list">
        {dealHistory.length === 0 && <p className="muted deal-history-empty">暂无已完成的交易</p>}

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
              <span>第{rec.dealNumber}笔 · 格#{rec.boardSpaceId}</span>
              <span>{rec.success ? `✓ 成交 $${rec.grossValue}M` : '✗ 流局'}</span>
            </div>
            <div className="deal-record-boss">Boss: {name(rec.bossPlayerId)}</div>
            {rec.success ? (
              rec.payout.length > 0 ? (
                <div className="deal-record-payout">
                  {rec.payout.map(p => (
                    <span key={p.playerId}>{name(p.playerId)} +${p.amount}M</span>
                  ))}
                </div>
              ) : (
                <div className="deal-record-payout muted">独吞，未分给任何人</div>
              )
            ) : (
              <div className="deal-record-payout muted">{rec.failReason ?? '未知原因'}</div>
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
