// ============================================================
// 成交方案构建器 — 代码预生成候选合约，供 LLM / 启发式 AI 挑选
// ============================================================
//
// 背景：旧设计要求 LLM 在 PROPOSE_CONTRACT 时"自己构造 contract"——包含完整的
// selectedRepresentatives（familyId/sourceType/ownerPlayerId/cardId 均要对齐）
// 和 payout 数组。这是所有动作类型里结构最复杂的一种，而 validator 当时又
// 恰好对它完全不做校验（`return true // validated in reducer`），出错概率
// 与后果在所有动作里都是最高的。
//
// 现在的设计：代表选择永远由代码决定（凑齐需求的确定解，与
// buildSelectedRepresentatives 完全一致，LLM 不需要也不能修改这部分），
// LLM/启发式 AI 只需要在几套预先算好、结构保证合法的分成方案里挑一个，
// 至多再用一个简单的 payout 数组覆盖具体金额（会被重新校验+取整+钳制）。
// fallbackAI 与合法动作列表（validator）共用同一套候选，避免出现两套互相
//不一致的"合约生成算法"。

import type { GameState, DealContract, PriceDemand } from './types'
import { getGrossDealValue, buildSelectedRepresentatives } from './gameEngine'

export interface ContractCandidate {
  key: 'stingy' | 'fair' | 'generous'
  label: string
  contract: DealContract
}

function nonBossOwners(bossId: number, reps: ReturnType<typeof buildSelectedRepresentatives>): number[] {
  const owners = new Set<number>()
  for (const rep of reps) if (rep.ownerPlayerId !== bossId) owners.add(rep.ownerPlayerId)
  return [...owners]
}

function demandAmount(demands: PriceDemand[], playerId: number): number | undefined {
  return demands.find(d => d.playerId === playerId)?.amount
}

/**
 * 生成 1~3 套结构合法的成交方案候选：
 * - stingy：一分不分（风险是代表持有者可能在出借确认阶段拒绝）
 * - fair：按人均分并尽量覆盖对方最低要价（复刻原 fallbackAI 的均分公式）
 * - generous：尽量按对方开出的要价原样支付（仅在有人明确要价时才生成，
 *   避免与 fair 完全重复时给出无意义的选项）
 */
export function buildContractCandidates(state: GameState, bossId: number): ContractCandidate[] {
  const neg = state.negotiation
  if (!neg || neg.bossPlayerId !== bossId) return []
  const gross = getGrossDealValue(state)
  const selected = buildSelectedRepresentatives(state)
  const owners = nonBossOwners(bossId, selected)

  const candidates: ContractCandidate[] = [{
    key: 'stingy',
    label: '独吞（自己全拿，风险：对方可能拒绝出借代表）',
    contract: { bossPlayerId: bossId, selectedRepresentatives: selected, payout: [] },
  }]

  if (owners.length === 0) return candidates

  const perShare = Math.max(2, Math.floor(gross / (owners.length + 1.5)))
  let distributed = 0
  const fairPayout: DealContract['payout'] = []
  for (const pid of owners) {
    const want = demandAmount(neg.demands, pid)
    const amt = Math.max(0, Math.min(want ?? perShare, gross - distributed - 1))
    if (amt > 0) {
      fairPayout.push({ playerId: pid, amount: Math.floor(amt) })
      distributed += amt
    }
  }
  candidates.push({
    key: 'fair',
    label: `均分（尽量覆盖各方要价，Boss净得约$${gross - distributed}M）`,
    contract: { bossPlayerId: bossId, selectedRepresentatives: selected, payout: fairPayout },
  })

  const hasAnyDemand = owners.some(pid => demandAmount(neg.demands, pid) != null)
  if (hasAnyDemand) {
    let distributed2 = 0
    const generousPayout: DealContract['payout'] = []
    for (const pid of owners) {
      const want = demandAmount(neg.demands, pid) ?? Math.floor(perShare / 2)
      const amt = Math.max(0, Math.min(want, gross - distributed2))
      if (amt > 0) {
        generousPayout.push({ playerId: pid, amount: Math.floor(amt) })
        distributed2 += amt
      }
    }
    candidates.push({
      key: 'generous',
      label: `满足要价（尽量按对方开价支付，Boss净得约$${gross - distributed2}M）`,
      contract: { bossPlayerId: bossId, selectedRepresentatives: selected, payout: generousPayout },
    })
  }

  return candidates
}
