// ============================================================
// DealResultCard — 交易结算卡：每笔交易结束（成交 / 流局）后在牌桌中央停留数秒
//   成交：Boss、所用代表、每人分到多少、你的收益；流局：原因（放弃 / 僵局 / 缺哪些家族的代表）
//   点击"收起"关闭；"查看详情"跳到交易历史；到时自动消失。载入存档不会弹出旧结算。
// ============================================================

import { useEffect, useRef, useState } from 'react'
import type { GameState } from '../engine/types'
import { FAMILIES } from '../engine/config'
import { latestDealSummary, type DealSummary } from '../ui/dealSummary'
import { useViewerId } from './ViewerContext'

/** 结算卡停留时间（毫秒） */
export const DEAL_RESULT_MS = 7000

interface DealResultCardProps {
  state: GameState
  /** "查看详情"：跳到交易历史 */
  onDetails?: () => void
  /** 停留时间，测试可缩短 */
  duration?: number
}

export default function DealResultCard({ state, onDetails, duration = DEAL_RESULT_MS }: DealResultCardProps) {
  const viewerId = useViewerId()
  const [summary, setSummary] = useState<DealSummary | null>(null)
  const seen = useRef(state.dealHistory.length)

  useEffect(() => {
    const n = state.dealHistory.length
    if (n === seen.current) return
    const shrunk = n < seen.current // 换了一局
    seen.current = n
    if (shrunk || state.phase === 'GAME_OVER') { setSummary(null); return } // 终局有自己的结果卡
    setSummary(latestDealSummary(state, viewerId))
  }, [state, viewerId])

  useEffect(() => {
    if (!summary) return
    const t = setTimeout(() => setSummary(null), duration)
    return () => clearTimeout(t)
  }, [summary, duration])

  if (!summary) return null
  const close = () => setSummary(null)

  if (summary.outcome === 'failed') {
    return (
      <div className="deal-result fail" role="status" aria-label="交易结算">
        <div className="deal-result-title">交易流局 · #{summary.spaceId}</div>
        <p className="deal-result-line">
          Boss：{summary.bossName}{summary.viewerIsBoss ? '（你）' : ''}
        </p>
        <p className="deal-result-reason">{summary.reasonText}</p>
        <p className="muted deal-result-note">未被打飞的家族卡收回，金钱标记留在原地。</p>
        <div className="deal-result-actions">
          {onDetails && <button type="button" className="btn btn-sm" onClick={() => { onDetails(); close() }}>查看详情</button>}
          <button type="button" className="btn btn-sm" onClick={close}>收起</button>
        </div>
      </div>
    )
  }

  const gain = summary.viewerGain
  return (
    <div className="deal-result ok" role="status" aria-label="交易结算">
      <div className="deal-result-title">成交！第 {summary.dealNumber} 笔 · #{summary.spaceId} · ${summary.gross}M</div>
      <p className="deal-result-line">Boss：{summary.bossName}{summary.viewerIsBoss ? '（你）' : ''}</p>
      {summary.repOwners.length > 0 && (
        <p className="deal-result-line muted">
          所用代表：{summary.repOwners.map(o => `${o.name}（${o.families.map(f => FAMILIES[f].name).join('、')}）`).join('；')}
        </p>
      )}
      <ul className="deal-result-rows">
        {summary.rows.map((r, i) => (
          <li key={`${r.kind}-${r.playerId}-${i}`} className={r.mine ? 'mine' : ''}>
            <span>{r.name}{r.mine ? '（你）' : ''}<em>{r.kind === 'boss' ? 'Boss 净得' : r.kind === 'rent' ? '地标租金' : '分成'}</em></span>
            <b className="gold">+${r.amount}M</b>
          </li>
        ))}
      </ul>
      <div className={`deal-result-you${gain > 0 ? ' gain' : ''}`}>你的收益：{gain > 0 ? `+$${gain}M` : '$0'}</div>
      <div className="deal-result-actions">
        {onDetails && <button type="button" className="btn btn-sm" onClick={() => { onDetails(); close() }}>查看详情</button>}
        <button type="button" className="btn btn-sm" onClick={close}>收起</button>
      </div>
    </div>
  )
}
