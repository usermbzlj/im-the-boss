// ============================================================
// 交易结算卡的数据（纯函数）：把一笔交易的 DealRecord + 事件整理成"卡片上要显示的东西"
//   成交：谁是 Boss、用了谁的哪些代表、每人分到多少（含地标租金）、视角玩家的收益
//   流局：原因（放弃 / 僵局 / 缺代表时缺哪些家族）
// 事件只保留最近 300 条，找不到时退回 DealRecord 里的数据（没有"所用代表"与"缺哪些家族"）。
// ============================================================

import type { DealRecord, FailReason, FamilyId, GameState } from '../engine/types'
import { failReasonName, famName, playerName } from '../text/narrate'

export interface DealRow {
  playerId: number
  name: string
  amount: number
  kind: 'boss' | 'payout' | 'rent'
  /** 是视角玩家 */
  mine: boolean
}

export interface RepOwner {
  playerId: number
  name: string
  families: FamilyId[]
}

export interface ClosedSummary {
  outcome: 'closed'
  dealNo: number
  dealNumber: number
  spaceId: number
  gross: number
  bossId: number
  bossName: string
  bossKeep: number
  /** 所用代表按持有者归并（Boss 自己的也在内） */
  repOwners: RepOwner[]
  rows: DealRow[]
  /** 视角玩家本笔的收益（Boss 净得 / 分成 / 地标租金之和） */
  viewerGain: number
  viewerIsBoss: boolean
}

export interface FailedSummary {
  outcome: 'failed'
  dealNo: number
  spaceId: number
  bossId: number
  bossName: string
  reason: FailReason
  /** 原因的一句话：放弃 / 僵局 / 缺代表（含缺哪些家族） */
  reasonText: string
  missing: FamilyId[]
  viewerIsBoss: boolean
}

export type DealSummary = ClosedSummary | FailedSummary

/** 某条交易记录的摘要。dealNo = 记录在 dealHistory 里的下标 + 1 */
export function summarizeDeal(state: GameState, record: DealRecord, viewerId: number): DealSummary {
  const dealNo = state.dealHistory.indexOf(record) + 1
  const events = state.events.filter(e => e.dealNo === dealNo)
  const bossName = playerName(state, record.bossId)
  const viewerIsBoss = record.bossId === viewerId

  if (!record.success) {
    const failed = events.find(e => e.kind === 'DEAL_FAILED')
    const missing = failed && failed.kind === 'DEAL_FAILED' ? failed.missing ?? [] : []
    const reason = record.failReason ?? 'STALEMATE'
    const lack = missing.length ? `：缺 ${missing.map(famName).join('、')} 的代表` : ''
    return {
      outcome: 'failed', dealNo, spaceId: record.spaceId, bossId: record.bossId, bossName, reason,
      reasonText: `${failReasonName(reason)}${lack}`, missing, viewerIsBoss,
    }
  }

  const closed = events.find(e => e.kind === 'DEAL_CLOSED')
  const paid = record.payouts.reduce((s, p) => s + p.amount, 0)
  const bossKeep = closed && closed.kind === 'DEAL_CLOSED' ? closed.bossKeep : record.grossValue - paid
  const dealNumber = closed && closed.kind === 'DEAL_CLOSED' ? closed.dealNumber : record.dealNumber

  const owners = new Map<number, RepOwner>()
  if (closed && closed.kind === 'DEAL_CLOSED') {
    for (const r of closed.reps ?? []) {
      const o = owners.get(r.ownerId) ?? { playerId: r.ownerId, name: playerName(state, r.ownerId), families: [] }
      if (!o.families.includes(r.familyId)) o.families.push(r.familyId)
      owners.set(r.ownerId, o)
    }
  }

  const rows: DealRow[] = [{ playerId: record.bossId, name: bossName, amount: bossKeep, kind: 'boss', mine: viewerIsBoss }]
  for (const p of record.payouts) {
    if (p.amount > 0) rows.push({ playerId: p.playerId, name: playerName(state, p.playerId), amount: p.amount, kind: 'payout', mine: p.playerId === viewerId })
  }
  for (const r of record.rents) {
    if (r.amount > 0) rows.push({ playerId: r.playerId, name: playerName(state, r.playerId), amount: r.amount, kind: 'rent', mine: r.playerId === viewerId })
  }
  const viewerGain = rows.filter(r => r.mine).reduce((s, r) => s + r.amount, 0)

  return {
    outcome: 'closed', dealNo, dealNumber, spaceId: record.spaceId, gross: record.grossValue, bossId: record.bossId, bossName,
    bossKeep, repOwners: [...owners.values()], rows, viewerGain, viewerIsBoss,
  }
}

/** 最近一笔交易的摘要；还没有交易返回 null */
export function latestDealSummary(state: GameState, viewerId: number): DealSummary | null {
  const record = state.dealHistory[state.dealHistory.length - 1]
  return record ? summarizeDeal(state, record, viewerId) : null
}
