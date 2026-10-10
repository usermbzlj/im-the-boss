// ============================================================
// 关系记忆：每位玩家对其他人的态度（-2 记仇 … +2 交好）
// 纯函数，只由对局状态（交易历史 / 近期事件 / 当前谈判）推导，不入存档，重放天然一致。
// 启发式、LLM 提示词与界面共用同一口径。
//
// 推导依据（fromId 对 toId 的态度）：
//   · 负面：搅过我当 Boss 的交易 / 把我排除在外 / 打飞我的代表 / 挖走我的投资者 / 夺我的 Boss /
//           对我放病假 / 用利空砍我 / 拦下我打出的牌 / 本笔方案绕开我
//   · 正面：付了我钱（分成）/ 替我挡过旅行牌或招募
// 越近的事权重越大（按"几笔之前"衰减）。state.events 只留最近 300 条，更早的事只剩 dealHistory
// 里的搅局者与分成，所以"几笔之前的小事"自然淡忘，这是想要的效果。
// reasons 是面向玩家的中文短句，界面直接展示。
// ============================================================

import type { GameState, LoggedEvent, DealRecord } from '../engine/types'
import { getCurrentSpace, relevantFamilies, playerActiveFamilies, offerShareOf, offerOwners } from '../engine/rules'

export type RelationScore = -2 | -1 | 0 | 1 | 2

export interface Relation {
  score: RelationScore
  /** 形成这个态度的最近几条原因（中文短句，界面与提示词直接使用） */
  reasons: string[]
}

interface Entry {
  /** 对分数的贡献（已含衰减） */
  w: number
  /** 原因文案 */
  text: string
  /** 事件的先后（越大越近），用于挑最近的原因 */
  at: number
  /** 同类原因去重键 */
  key: string
}

const MAX_REASONS = 3

/** 越久远的事越淡：age 是"几笔之前"（当前这笔 = 0，上一笔 = 1） */
function decay(age: number): number {
  if (age <= 1) return 1
  if (age <= 4) return 0.7
  if (age <= 9) return 0.4
  return 0.2
}

function agoText(age: number): string {
  return age <= 0 ? '这一笔' : age === 1 ? '上一笔' : `${age} 笔前`
}

function toScore(sum: number): RelationScore {
  const mag = Math.abs(sum)
  const level = mag < 0.75 ? 0 : mag < 1.75 ? 1 : 2
  return (sum < 0 ? -level : level) as RelationScore
}

/** fromId 对每位其他玩家的态度（键为对方 id） */
export function relationsOf(state: GameState, fromId: number): Record<number, Relation> {
  const entries = new Map<number, Entry[]>()
  for (const p of state.players) if (p.id !== fromId) entries.set(p.id, [])
  if (!state.players.some(p => p.id === fromId)) return {}

  const add = (to: number, e: Entry) => { entries.get(to)?.push(e) }
  const history = state.dealHistory
  const neg = state.negotiation
  /** 当前交易的序号 = 已结算笔数 + 1（与事件的 dealNo 同口径） */
  const currentNo = history.length + (neg ? 1 : 0)
  const ageOfDeal = (dealNo: number | undefined) => (dealNo == null ? 0 : Math.max(0, currentNo - dealNo))
  const bossOfDeal = (dealNo: number | undefined): number | null => {
    if (dealNo == null) return null
    const rec = history[dealNo - 1]
    if (rec) return rec.bossId
    return neg && dealNo === currentNo ? neg.bossId : null
  }

  // ---------- 事件：具体的恩怨 ----------
  const attackedIn = new Map<number, Set<number>>() // 对方 -> 他在哪几笔里对我动过手（避免和 disruptors 重复计）
  const markAttack = (to: number, dealNo: number | undefined) => {
    if (dealNo == null) return
    if (!attackedIn.has(to)) attackedIn.set(to, new Set())
    attackedIn.get(to)!.add(dealNo)
  }
  const stakeIn = new Set<number>() // 我在哪几笔里"明确入过场"（报价 / 打家族卡）
  const dealsWithEvents = new Set<number>()

  state.events.forEach((e: LoggedEvent) => {
    if (e.dealNo != null) dealsWithEvents.add(e.dealNo)
    const w = decay(ageOfDeal(e.dealNo))
    const ago = agoText(ageOfDeal(e.dealNo))
    switch (e.kind) {
      case 'DEMAND':
        if (e.playerId === fromId && e.dealNo != null) stakeIn.add(e.dealNo)
        break
      case 'CLAN_PLAYED':
        if (e.playerId === fromId && e.dealNo != null) stakeIn.add(e.dealNo)
        break
      case 'TRAVEL_PLAYED':
        if (e.target.ownerId === fromId && e.playerId !== fromId) {
          add(e.playerId, { w: -1 * w, text: `${ago}打飞过我的代表`, at: e.id, key: 'travel' })
          markAttack(e.playerId, e.dealNo)
        }
        break
      case 'RECRUITMENT_PLAYED':
        if (e.fromId === fromId && e.playerId !== fromId) {
          add(e.playerId, { w: -2 * w, text: `${ago}挖走了我的投资者`, at: e.id, key: 'recruit' })
          markAttack(e.playerId, e.dealNo)
        }
        break
      case 'BOSS_PLAYED':
        if (e.bossId === fromId && e.playerId !== fromId) {
          add(e.playerId, { w: -1.5 * w, text: `${ago}夺走了我的 Boss`, at: e.id, key: 'boss' })
          markAttack(e.playerId, e.dealNo)
        }
        break
      case 'SICK_PLAYED':
        if (e.targetId === fromId && e.playerId !== fromId) {
          add(e.playerId, { w: -1 * w, text: `${ago}给我放了病假`, at: e.id, key: 'sick' })
        }
        break
      case 'BUST_PLAYED': {
        const boss = bossOfDeal(e.dealNo)
        if (boss === fromId && e.playerId !== fromId) {
          add(e.playerId, { w: -1 * w, text: `${ago}用利空砍过我的单`, at: e.id, key: 'bust' })
          markAttack(e.playerId, e.dealNo)
        }
        break
      }
      case 'STOP_PLAYED': {
        if (e.playerId === fromId) break
        if (e.actorId === fromId) {
          add(e.playerId, { w: -0.6 * w, text: `${ago}拦下过我打的牌`, at: e.id, key: 'stopped-me' })
          break
        }
        // 替我挡牌：旅行牌打向我的代表、招募牌打向我的投资者
        const mine =
          (e.cancelled === 'TRAVEL' && e.targetRep?.ownerId === fromId) ||
          (e.cancelled === 'RECRUITMENT' && e.targetFamilyId != null && state.investors.some(i => i.familyId === e.targetFamilyId && i.ownerId === fromId)) ||
          (e.cancelled === 'SICK' && e.targetPlayerId === fromId)
        if (mine) {
          const what = e.cancelled === 'TRAVEL' ? '旅行牌' : e.cancelled === 'RECRUITMENT' ? '招募' : '病假牌'
          add(e.playerId, { w: 1.5 * w, text: `${ago}帮我挡过一次${what}`, at: e.id, key: 'stop-for-me' })
        }
        break
      }
    }
  })

  // ---------- 交易历史：搅局 / 分成 / 被排除 ----------
  history.forEach((rec: DealRecord, i) => {
    const dealNo = i + 1
    const age = history.length - i
    const w = decay(age)
    const ago = agoText(age)
    if (rec.bossId === fromId) {
      for (const d of rec.disruptors) {
        if (d === fromId || attackedIn.get(d)?.has(dealNo)) continue
        add(d, { w: -(rec.success ? 0.8 : 1.2) * w, text: `${ago}搅了我当 Boss 的单`, at: dealNo * 1000, key: 'disrupt' })
      }
      return
    }
    // 别人当 Boss
    if (rec.success) {
      const got = rec.payouts.find(p => p.playerId === fromId)?.amount ?? 0
      if (got > 0) {
        add(rec.bossId, { w: 0.6 * w, text: `${ago}分了我 $${got}M`, at: dealNo * 1000, key: 'paid' })
      } else if (stakeOf(state, fromId, rec, dealNo, stakeIn, dealsWithEvents)) {
        add(rec.bossId, { w: -1 * w, text: `${ago}把我排除在外`, at: dealNo * 1000, key: 'excluded' })
      }
    }
  })

  // ---------- 当前这笔：方案绕开我 ----------
  if (neg?.offer && neg.bossId !== fromId) {
    const mine = playerActiveFamilies(neg, fromId)
    const used = offerOwners(neg, neg.offer).includes(fromId)
    if (mine.size > 0 && !used && offerShareOf(neg.offer, fromId) === 0) {
      add(neg.bossId, { w: -0.6, text: '这一笔的方案绕开了我', at: state.stateVersion, key: 'bypass' })
    }
  }

  const out: Record<number, Relation> = {}
  for (const [to, list] of entries) {
    // 同类原因最多计两次（连着被排除两次是真的，但不无限叠加）
    const perKey = new Map<string, number>()
    let sum = 0
    const kept: Entry[] = []
    for (const e of [...list].sort((a, b) => b.at - a.at)) {
      const n = perKey.get(e.key) ?? 0
      if (n >= 2) continue
      perKey.set(e.key, n + 1)
      sum += e.w
      kept.push(e)
    }
    const reasons: string[] = []
    for (const e of kept) {
      if (reasons.length >= MAX_REASONS) break
      if (!reasons.includes(e.text)) reasons.push(e.text)
    }
    out[to] = { score: toScore(sum), reasons }
  }
  return out
}

/** 在这笔交易里我是不是"有份"的：明确入过场；窗口里没有这笔的事件时，看我是否持有本格相关家族的投资者 */
function stakeOf(state: GameState, fromId: number, rec: DealRecord, dealNo: number, stakeIn: Set<number>, dealsWithEvents: Set<number>): boolean {
  if (stakeIn.has(dealNo)) return true
  if (dealsWithEvents.has(dealNo)) return false
  const space = state.board.find(b => b.id === rec.spaceId) ?? getCurrentSpace(state)
  if (!space) return false
  const fams = new Set(relevantFamilies(space))
  return state.investors.some(inv => inv.ownerId === fromId && fams.has(inv.familyId))
}

/** 每位其他玩家对 targetId 的态度（键为对方 id）——界面用来显示"谁记你的仇" */
export function relationsToward(state: GameState, targetId: number): Record<number, Relation> {
  const out: Record<number, Relation> = {}
  for (const p of state.players) {
    if (p.id === targetId) continue
    out[p.id] = relationsOf(state, p.id)[targetId] ?? { score: 0, reasons: [] }
  }
  return out
}
