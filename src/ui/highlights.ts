// ============================================================
// 精彩时刻（纯函数）：从交易历史 / 完整事件里挑出最多 8 条值得回看的瞬间，按"精彩度"排序
//
// 规则（每条都带标题、一句描述、关联的交易编号与动作序号；actionIndex 为 null = 没有录像，只能定位到交易）：
//   夺权翻盘  成交的 Boss 不是发起者——打出老板牌夺权并最终成交（连环夺权、落后时夺权加分）          [交易历史即可]
//   截胡      旅行 / 招募让 Boss 已提出的方案作废；成交倒计时里的截胡最精彩                         [需要完整事件]
//   一锤定音  决定胜负的那笔：胜者此后再没让出榜首的那笔交易；若一路领先则取拉开差距最多的那笔        [交易历史即可]
//   独吞      Boss 靠自己的代表凑齐需求，一分没分给别人（取总额最大的一笔）                         [交易历史即可]
//   最大单笔  全场最大的一次进账                                                              [交易历史即可]
//   报复      被 Boss 排除在方案之外的玩家，在之后几笔交易里出牌回敬或反手排除对方                   [需要录像]
//   压价成交  代表持有者公开开价，最终被 Boss 压低后仍成交                                        [需要完整事件]
//   阻止牌救场 阻止牌取消了旅行 / 招募 / 老板 / 利空牌；成交倒计时里的最精彩                        [需要完整事件]
// 同一笔交易最多 2 条，同类有上限，保证多样性。
// ============================================================

import type { GameState, LoggedEvent } from '../engine/types'
import { playerName, reactionKindName, famName } from '../text/narrate'
import { DISRUPT_KINDS, completeEvents, computeExclusions, type GameStats } from './stats'
import type { Recording } from './recording'

export type HighlightKind = 'COMEBACK' | 'INTERCEPT' | 'DECIDER' | 'SOLO' | 'BIGGEST' | 'REVENGE' | 'LOWBALL' | 'STOPSAVE'

export interface Highlight {
  id: string
  kind: HighlightKind
  title: string
  /** 一句话描述 */
  text: string
  /** 第几次开单（与 dealHistory 下标 + 1 一致） */
  dealNo: number
  /** 发生在第几个动作（日志下标）；没有录像时为 null */
  actionIndex: number | null
  /** 主角（用于配色 / 筛选） */
  playerIds: number[]
  /** 精彩度（0–100，仅用于排序） */
  score: number
}

export const HIGHLIGHT_META: Record<HighlightKind, { icon: string; label: string }> = {
  COMEBACK: { icon: '👑', label: '夺权翻盘' },
  INTERCEPT: { icon: '✂️', label: '截胡' },
  DECIDER: { icon: '🔨', label: '一锤定音' },
  SOLO: { icon: '💰', label: '独吞' },
  BIGGEST: { icon: '💎', label: '最大单笔' },
  REVENGE: { icon: '🔥', label: '报复' },
  LOWBALL: { icon: '🪙', label: '压价成交' },
  STOPSAVE: { icon: '🛡️', label: '阻止牌救场' },
}

/** 每类最多入选几条 */
const KIND_CAP: Record<HighlightKind, number> = { COMEBACK: 2, INTERCEPT: 2, DECIDER: 1, SOLO: 1, BIGGEST: 1, REVENGE: 2, LOWBALL: 2, STOPSAVE: 2 }
const MAX_PER_DEAL = 2
export const MAX_HIGHLIGHTS = 8

/** 复盘位置：这个精彩时刻对应的动作应用之后（没有录像返回 null） */
export function highlightPosition(h: Pick<Highlight, 'actionIndex'>): number | null {
  return h.actionIndex == null ? null : h.actionIndex + 1
}

type Cand = Omit<Highlight, 'id'>

/** 某个事件下标处的 Boss：开单者，之后每次夺权易主 */
function bossAt(events: readonly LoggedEvent[], idx: number): number | null {
  let boss: number | null = null
  for (let i = 0; i <= idx && i < events.length; i++) {
    const e = events[i]
    if (e.kind === 'DEAL_OPENED') boss = e.playerId
    else if (e.kind === 'BOSS_RESOLVED') boss = e.playerId
  }
  return boss
}

export function computeHighlights(state: GameState, stats: GameStats, recording?: Recording | null, limit = MAX_HIGHLIGHTS): Highlight[] {
  const hist = state.dealHistory
  if (hist.length === 0) return []
  const name = (id: number) => playerName(state, id)
  const series = stats.cashSeries.points
  const stepOf = (e: LoggedEvent): number | null => recording?.stepOfEvent(e.id) ?? null
  const endStepOf = (dealNo: number): number | null => recording?.dealSpan(dealNo)?.endStep ?? null
  const label = (dealNo: number): string => {
    const rec = hist[dealNo - 1]
    return rec.success ? `第 ${rec.dealNumber} 笔成交（#${rec.spaceId}）` : `#${rec.spaceId} 那笔流局的交易`
  }

  // 事件按交易分组（只取从开单起完整出现的交易；没有录像时事件可能被截断）
  const events = completeEvents(state, recording) ?? state.events
  const byDeal = new Map<number, LoggedEvent[]>()
  for (const e of events) {
    if (e.dealNo == null) continue
    const list = byDeal.get(e.dealNo)
    if (list) list.push(e)
    else byDeal.set(e.dealNo, [e])
  }
  const usable = [...byDeal.entries()].filter(([, list]) => list.some(e => e.kind === 'DEAL_OPENED'))

  const cands: Cand[] = []

  // ---------- 夺权翻盘 ----------
  hist.forEach((rec, i) => {
    if (!rec.success || rec.bossId === rec.openerId) return
    const dealNo = i + 1
    const evs = byDeal.get(dealNo) ?? []
    const takeovers = evs.filter(e => e.kind === 'BOSS_RESOLVED')
    const last = [...takeovers].reverse().find(e => e.kind === 'BOSS_RESOLVED' && e.playerId === rec.bossId)
    const previous = last && last.kind === 'BOSS_RESOLVED' ? last.previousBossId : rec.openerId
    const keep = rec.grossValue - rec.payouts.reduce((s, p) => s + p.amount, 0)
    const before = series[i]?.cash ?? []
    const trailing = before.length > 0 && before[rec.bossId] < Math.max(...before)
    const chain = takeovers.length > 1
    cands.push({
      kind: 'COMEBACK', title: '夺权翻盘', dealNo,
      text: `${name(rec.bossId)} 打出老板牌，从 ${name(previous)} 手里夺下 Boss 的位子${chain ? '（这笔交易 Boss 轮番易主）' : ''}，在${label(dealNo)}里净得 $${keep}M`,
      actionIndex: last ? stepOf(last) : endStepOf(dealNo),
      playerIds: [rec.bossId, previous], score: 62 + Math.min(25, keep * 2) + (chain ? 8 : 0) + (trailing ? 6 : 0),
    })
  })

  // ---------- 截胡 / 阻止牌救场 / 压价成交（需要事件） ----------
  for (const [dealNo, evs] of usable) {
    const rec = hist[dealNo - 1]
    if (!rec) continue

    let bestIntercept: Cand | null = null
    evs.forEach((e, j) => {
      if (e.kind !== 'OFFER_VOIDED') return
      const wantPlay = e.reason === 'TRAVELLED' ? 'TRAVEL_PLAYED' : 'RECRUITMENT_PLAYED'
      let actor: LoggedEvent | undefined
      for (let k = j - 1; k >= 0; k--) { if (evs[k].kind === wantPlay) { actor = evs[k]; break } }
      if (!actor || (actor.kind !== 'TRAVEL_PLAYED' && actor.kind !== 'RECRUITMENT_PLAYED')) return
      const victim = bossAt(evs, j)
      if (victim == null || victim === actor.playerId) return
      const inClosing = evs.slice(j + 1, j + 4).some(x => x.kind === 'CLOSING_INTERRUPTED')
      let stake = 0
      for (let k = j - 1; k >= 0; k--) {
        const x = evs[k]
        if (x.kind === 'OFFER_PROPOSED') { stake = x.bossKeep; break }
      }
      const how = actor.kind === 'TRAVEL_PLAYED'
        ? `旅行牌打飞了 ${name(actor.target.ownerId)} 的${famName(actor.target.familyId)}代表`
        : `招募牌抢走了 ${famName(actor.familyId)} 投资者`
      const text = inClosing
        ? `${name(victim)} 刚宣布成交，${name(actor.playerId)} 就在最后一刻用${how}，价值 $${stake}M 的方案当场落空`
        : `${name(actor.playerId)} 用${how}，${name(victim)} 为 $${stake}M 拼出的方案作废`
      const cand: Cand = {
        kind: 'INTERCEPT', title: inClosing ? '截胡·最后一刻' : '截胡', dealNo, text,
        actionIndex: stepOf(e), playerIds: [actor.playerId, victim], score: 55 + (inClosing ? 28 : 0) + Math.min(15, stake),
      }
      if (!bestIntercept || cand.score > bestIntercept.score) bestIntercept = cand
    })
    if (bestIntercept) cands.push(bestIntercept)

    // 阻止牌救场
    let closingOpen = false
    let bestStop: Cand | null = null
    evs.forEach((e, j) => {
      if (e.kind === 'CLOSING_STARTED') closingOpen = true
      else if (e.kind === 'CLOSING_INTERRUPTED' || e.kind === 'OFFER_VOIDED' || e.kind === 'DEAL_CLOSED') closingOpen = false
      if (e.kind !== 'STOP_PLAYED') return
      if (e.cancelled !== 'TRAVEL' && e.cancelled !== 'RECRUITMENT' && e.cancelled !== 'BOSS' && e.cancelled !== 'BUST') return
      const boss = bossAt(evs, j) ?? rec.bossId
      const text = closingOpen
        ? `${name(e.playerId)} 在成交倒计时亮出阻止牌，取消了 ${name(e.actorId)} 的${reactionKindName(e.cancelled)}，${name(boss)} 的交易${rec.success ? '得以成交' : '保住了倒计时'}`
        : `${name(e.playerId)} 的阻止牌挡下了 ${name(e.actorId)} 的${reactionKindName(e.cancelled)}${e.cancelled === 'BOSS' ? '，Boss 的位子没丢' : ''}`
      const cand: Cand = {
        kind: 'STOPSAVE', title: closingOpen ? '阻止牌救场·倒计时' : '阻止牌救场', dealNo, text,
        actionIndex: stepOf(e), playerIds: [e.playerId, e.actorId],
        score: 48 + (closingOpen ? 28 : 0) + (closingOpen && rec.success ? 10 : 0) + (e.cancelled === 'BOSS' ? 6 : 0),
      }
      if (!bestStop || cand.score > bestStop.score) bestStop = cand
    })
    if (bestStop) cands.push(bestStop)

    // 压价成交：代表持有者最初的开价 vs 最终分成
    if (rec.success) {
      const asked = new Map<string, number>() // `${playerId}:${family}` → 首次开价
      for (const e of evs) {
        if (e.kind !== 'DEMAND') continue
        for (const q of e.quotes) for (const f of q.familyIds) { const k = `${e.playerId}:${f}`; if (!asked.has(k)) asked.set(k, q.amount) }
      }
      const closed = evs.find(e => e.kind === 'DEAL_CLOSED')
      if (closed && closed.kind === 'DEAL_CLOSED') {
        const owners = new Set(closed.reps.filter(r => r.ownerId !== closed.bossId).map(r => r.ownerId))
        let best: { q: number; ask: number; paid: number } | null = null
        for (const q of owners) {
          const reps = closed.reps.filter(r => r.ownerId === q)
          const prices = reps.map(r => asked.get(`${q}:${r.familyId}`))
          if (prices.some(p => p == null)) continue
          const ask = prices.reduce((s: number, p) => s + (p ?? 0), 0)
          const paid = closed.payouts.find(p => p.playerId === q)?.amount ?? 0
          if (ask - paid >= 2 && (!best || ask - paid > best.ask - best.paid)) best = { q, ask, paid }
        }
        if (best) {
          cands.push({
            kind: 'LOWBALL', title: '压价成交', dealNo,
            text: `${name(best.q)} 开价 $${best.ask}M，${name(closed.bossId)} 一路压到 $${best.paid}M，${best.paid > 0 ? '他最终还是点了头' : '一分没给，交易照样成了'}`,
            actionIndex: stepOf(closed), playerIds: [closed.bossId, best.q], score: 50 + Math.min(25, (best.ask - best.paid) * 4),
          })
        }
      }
    }
  }

  // ---------- 报复（需要录像：谁被排除要靠成交前的桌面还原） ----------
  if (recording) {
    const exclusions = computeExclusions(state, recording)
    const bestByVictim = new Map<number, Cand>()
    for (const ex of exclusions.values()) {
      for (const p of ex.out) {
        found: for (let d2 = ex.dealNo + 1; d2 <= Math.min(hist.length, ex.dealNo + 8); d2++) {
          const evs = byDeal.get(d2) ?? []
          // 出牌回敬：在对方当 Boss 的交易里打出干扰牌
          for (let j = 0; j < evs.length; j++) {
            const e = evs[j]
            let kind: string | null = null
            if (e.kind === 'TRAVEL_PLAYED' && e.playerId === p) kind = 'TRAVEL'
            else if (e.kind === 'RECRUITMENT_PLAYED' && e.playerId === p) kind = 'RECRUITMENT'
            else if (e.kind === 'BOSS_PLAYED' && e.playerId === p) kind = 'BOSS'
            else if (e.kind === 'BUST_PLAYED' && e.playerId === p) kind = 'BUST'
            if (!kind || !DISRUPT_KINDS.has(kind as never) || bossAt(evs, j) !== ex.bossId) continue
            const cardName = kind === 'TRAVEL' ? '旅行牌' : kind === 'RECRUITMENT' ? '招募牌' : kind === 'BOSS' ? '老板牌' : '利空牌'
            const cand: Cand = {
              kind: 'REVENGE', title: '被排除后报复', dealNo: d2,
              text: `${name(p)} 在${label(ex.dealNo)}里被 ${name(ex.bossId)} 挡在方案之外，到${label(d2)}就用${cardName}回敬`,
              actionIndex: stepOf(e), playerIds: [p, ex.bossId], score: 70 + (d2 - ex.dealNo <= 2 ? 8 : 0),
            }
            const cur = bestByVictim.get(p)
            if (!cur || cand.score > cur.score) bestByVictim.set(p, cand)
            break found
          }
          // 反手排除：轮到他当 Boss，把对方挡在方案外
          const rec2 = hist[d2 - 1]
          const ex2 = exclusions.get(d2)
          if (rec2?.success && rec2.bossId === p && ex2?.out.has(ex.bossId)) {
            const cand: Cand = {
              kind: 'REVENGE', title: '被排除后报复', dealNo: d2,
              text: `${name(p)} 在${label(ex.dealNo)}里被 ${name(ex.bossId)} 排除；${label(d2)}轮到他当 Boss，立刻把 ${name(ex.bossId)} 也挡在了方案之外`,
              actionIndex: endStepOf(d2), playerIds: [p, ex.bossId], score: 62 + (d2 - ex.dealNo <= 2 ? 8 : 0),
            }
            const cur = bestByVictim.get(p)
            if (!cur || cand.score > cur.score) bestByVictim.set(p, cand)
            break found
          }
        }
      }
    }
    cands.push(...bestByVictim.values())
  }

  // ---------- 一锤定音 ----------
  const winners = new Set(state.winnerIds)
  const holds = (k: number) => {
    const cash = series[k].cash
    const top = Math.max(...cash)
    return cash.every((c, id) => c !== top || winners.has(id))
  }
  const total = hist.length
  if (series.length > 1 && winners.size > 0 && holds(total)) {
    let k = total
    while (k > 1 && holds(k - 1)) k--
    const w = [...winners]
    const wNames = w.map(name).join('、')
    const finalCash = series[total].cash
    const winnerCash = Math.max(...finalCash)
    const runnerUp = Math.max(0, ...finalCash.filter((_, id) => !winners.has(id)))
    if (k > 1) {
      const rec = hist[k - 1]
      const last = k === total
      cands.push({
        kind: 'DECIDER', title: last ? '一锤定音·最后一笔逆转' : '一锤定音', dealNo: k,
        text: last
          ? `${label(k)}成了胜负手：${wNames} 在最后一笔交易里登上榜首，以 $${winnerCash}M 对 $${runnerUp}M ${w.length > 1 ? '并列获胜' : '险胜'}`
          : `${label(k)}之后 ${wNames} 登上榜首，此后再没让出${rec.success ? '' : '（那笔交易本身流局，是买牌支出换了位置）'}`,
        actionIndex: endStepOf(k), playerIds: w, score: 75 + (last ? 15 : 0) + (winnerCash - runnerUp <= 3 ? 8 : 0),
      })
    } else {
      // 一路领先：取拉开差距最多的那笔
      const lead = (idx: number) => {
        const c = series[idx].cash
        return Math.max(...w.map(id => c[id])) - Math.max(0, ...c.filter((_, id) => !winners.has(id)))
      }
      let bestK = 1, bestJump = -Infinity
      for (let j = 1; j <= total; j++) {
        const jump = lead(j) - lead(j - 1)
        if (jump > bestJump) { bestJump = jump; bestK = j }
      }
      if (bestJump > 0) {
        cands.push({
          kind: 'DECIDER', title: '一锤定音·拉开差距', dealNo: bestK,
          text: `${wNames} 一路领先，真正拉开差距的是${label(bestK)}：一笔之间多出 $${bestJump}M 的领先`,
          actionIndex: endStepOf(bestK), playerIds: w, score: 55 + Math.min(15, bestJump),
        })
      }
    }
  }

  // ---------- 独吞 / 最大单笔 ----------
  let solo: { dealNo: number; gross: number; boss: number } | null = null
  hist.forEach((rec, i) => {
    if (rec.success && rec.payouts.length === 0 && (!solo || rec.grossValue > solo.gross)) solo = { dealNo: i + 1, gross: rec.grossValue, boss: rec.bossId }
  })
  const soloPick = solo as { dealNo: number; gross: number; boss: number } | null
  const big = stats.biggest
  if (big) {
    const rec = hist[big.dealNo - 1]
    const asBoss = rec.bossId === big.playerId
    const alone = asBoss && rec.payouts.length === 0
    cands.push({
      kind: 'BIGGEST', title: '最大单笔', dealNo: big.dealNo,
      text: `${name(big.playerId)} 在${label(big.dealNo)}一次入账 $${big.amount}M，是全场最大的单笔收益${alone ? '，而且一分没分给别人' : asBoss ? '' : '（作为代表拿到分成 / 租金）'}`,
      actionIndex: endStepOf(big.dealNo), playerIds: [big.playerId], score: 58 + Math.min(30, big.amount),
    })
  }
  if (soloPick && !(big && big.dealNo === soloPick.dealNo)) {
    cands.push({
      kind: 'SOLO', title: '独吞', dealNo: soloPick.dealNo,
      text: `${name(soloPick.boss)} 凭自己的代表凑齐了需求，${label(soloPick.dealNo)}的 $${soloPick.gross}M 一分没分给别人`,
      actionIndex: endStepOf(soloPick.dealNo), playerIds: [soloPick.boss], score: 40 + Math.min(30, soloPick.gross),
    })
  }

  // ---------- 挑选：按精彩度，同类 / 同一笔交易设上限 ----------
  cands.sort((a, b) => b.score - a.score || a.dealNo - b.dealNo)
  const perKind = new Map<HighlightKind, number>()
  const perDeal = new Map<number, number>()
  const picked: Highlight[] = []
  for (const c of cands) {
    if (picked.length >= limit) break
    if ((perKind.get(c.kind) ?? 0) >= KIND_CAP[c.kind]) continue
    if ((perDeal.get(c.dealNo) ?? 0) >= MAX_PER_DEAL) continue
    perKind.set(c.kind, (perKind.get(c.kind) ?? 0) + 1)
    perDeal.set(c.dealNo, (perDeal.get(c.dealNo) ?? 0) + 1)
    picked.push({ ...c, id: `${c.kind}:${c.dealNo}:${picked.length}` })
  }
  return picked
}
