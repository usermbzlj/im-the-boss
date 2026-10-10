// ============================================================
// 关键后果前置（纯函数）：把"这一步之后会怎样"算出来给按钮 / 提示使用
// 规则一律调用引擎导出的函数（acceptedCommitments / usedFamiliesOf / offerShareOf …），不在这里重写。
// ============================================================

import type { FamilyId, GameState } from '../engine/types'
import { FAMILIES } from '../engine/config'
import { acceptedCommitments, demandOf, offerShareOf, usedFamiliesOf } from '../engine/rules'

export interface AcceptPrice {
  familyId: FamilyId
  /** 同意后这个家族的承诺价 */
  price: number
  /** 同意前的承诺价；null = 之前没报过价 */
  from: number | null
  changed: boolean
}

export interface AcceptOutcome {
  /** 同意后你从 Boss 拿到的钱 */
  amount: number
  /** 方案里用到的你的各家族代表，同意后的承诺价 */
  prices: AcceptPrice[]
  /** 承诺价是否有变化 */
  changed: boolean
}

/** 视角玩家同意当前方案会怎样：拿多少钱、承诺价变成什么。没有方案 / 方案没用他的代表返回 null */
export function acceptOutcome(state: GameState, viewerId: number): AcceptOutcome | null {
  const neg = state.negotiation
  const offer = neg?.offer
  if (!neg || !offer) return null
  const used = usedFamiliesOf(neg, offer, viewerId)
  if (used.length === 0) return null
  const changes = acceptedCommitments(neg, offer, viewerId)
  const prices: AcceptPrice[] = []
  for (const f of used) {
    const change = changes.find(c => c.familyId === f)
    const before = demandOf(neg, viewerId, f) ?? null
    const price = change ? change.to : before
    if (price == null) continue
    prices.push({ familyId: f, price, from: change ? change.from : before, changed: !!change })
  }
  return { amount: offerShareOf(offer, viewerId), prices, changed: changes.length > 0 }
}

/** "承诺价将变为 赤岩集团 $3M、黑松控股 $2M" / "承诺价不变" */
export function describeAcceptOutcome(o: AcceptOutcome): string {
  if (!o.changed) return o.prices.length ? '承诺价不变' : ''
  const parts = o.prices.filter(p => p.changed).map(p => `${FAMILIES[p.familyId].name} $${p.price}M`)
  return `承诺价将变为 ${parts.join('、')}`
}

/** 花钱买牌这类不可逆操作：花费达到现金的一半就先确认一次（小额不打扰） */
export function isCostly(cost: number, cash: number): boolean {
  return cost > 0 && cost * 2 >= cash
}
