// ============================================================
// 终局统计（纯函数）：输入最终状态 + 可选的录像（动作日志重放出来的完整事件流）
//
// 数据口径（与引擎对账）：
//   · 收入 —— 全部来自 dealHistory（完整，不受事件 300 条上限影响）：
//       Boss 所得 = 成交总额 − 分给别人的钱；代表分成 = 作为代表被分到的钱；地标租金 = 银行付的租金
//   · 支出 —— 买牌 / 兑换付给银行的钱。有完整事件（录像，或短局里状态的事件还没被截断）时逐笔精确核算；
//       否则只能由 "收入 − 现金" 推算，且不区分买牌与兑换（spend.source = 'derived'）
//   · 对账 —— 起始现金为 0，所以 最终现金 = 收入合计 − 支出合计；全体支出之和 = state.bank。
//       reconciliation 记录是否对得上以及口径说明；对不上时 ok = false 并写明哪一位差多少
//   · 现金走势 —— 每笔交易（成交 / 流局）之后的现金；有完整事件时扣除了此前的买牌 / 兑换支出（exact = true），
//       否则只是累计收入（exact = false，界面应注明"未含买牌 / 兑换支出"）
//   · 被排除次数 —— 需要知道成交前桌上都有谁的代表，只有录像能还原；没有录像为 null
// ============================================================

import type { CardType, GameEvent, GameState, LoggedEvent } from '../engine/types'
import { playerName } from '../text/narrate'
import type { Recording } from './recording'
import { rankStandings } from './standings'

export interface Gain {
  /** 第几次开单（与 dealHistory 下标 + 1 一致） */
  dealNo: number
  amount: number
}

export interface PlayerStats {
  playerId: number
  name: string
  cash: number
  rank: number
  tied: boolean
  isWinner: boolean
  /** 收入构成（全部来自 dealHistory） */
  income: { boss: number; share: number; rent: number; total: number }
  /** 支出：买牌 / 兑换付给银行的钱；derived 时 buy / trade 未知 */
  spend: { buy: number | null; trade: number | null; total: number; source: 'events' | 'derived' }
  /** 收入合计 − 支出合计 === 最终现金 */
  reconciles: boolean
  /** 当 Boss 的次数（含流局；夺权后成为 Boss 的也算） */
  bossDeals: number
  bossClosed: number
  bossFailed: number
  /** 通过老板牌夺权、最终以 Boss 身份收场的次数 */
  takeovers: number
  /** 作为代表拿到分成的成交笔数 */
  shareDeals: number
  /** 独吞：自己当 Boss、没分给任何人的成交笔数 */
  soloDeals: number
  /** 打出的影响牌张数（含阻止牌）；没有完整事件时为 null */
  cardsPlayed: number | null
  cardsByType: Partial<Record<CardType, number>> | null
  /** 搅局：在别人的交易里打出旅行 / 招募 / 老板 / 利空牌（含被阻止的）或夺权的笔数 */
  disrupts: number
  /** 被搅局：自己是 Boss（或夺权前的发起者）的交易里有人搅局的笔数 */
  disrupted: number
  /** 被排除：成交时桌上有自己可用的代表却没被选用、也没分到钱的笔数；没有录像为 null */
  excluded: number | null
  /** 单笔交易的最大收益（Boss 所得 + 分成 + 租金） */
  bestDeal: Gain | null
}

export interface CashPoint {
  /** 0 = 开局 */
  dealNo: number
  cash: number[]
}

export interface CashSeries {
  points: CashPoint[]
  /** true：已扣除买牌 / 兑换支出，末点等于最终现金；false：只是累计收入 */
  exact: boolean
}

export interface Reconciliation {
  ok: boolean
  /** 引擎记录的银行收入（买牌 / 兑换） */
  bank: number
  /** 每位玩家的对账差额（收入 − 支出 − 现金），应全为 0 */
  diffs: number[]
  /** 给界面显示的口径说明 */
  notes: string[]
}

export interface GameStats {
  players: PlayerStats[]
  deals: { total: number; closed: number; failed: number }
  cashSeries: CashSeries
  reconciliation: Reconciliation
  /** 全场最大单笔收益 */
  biggest: (Gain & { playerId: number }) | null
  /** 支出 / 出牌数据是否基于完整事件 */
  eventsComplete: boolean
}

/** 影响牌的事件 → 牌种（阻止牌也算） */
const PLAY_KIND: Partial<Record<GameEvent['kind'], CardType>> = {
  CLAN_PLAYED: 'CLAN', TRAVEL_PLAYED: 'TRAVEL', RECRUITMENT_PLAYED: 'RECRUITMENT', BOSS_PLAYED: 'BOSS',
  BOOM_PLAYED: 'BOOM', BUST_PLAYED: 'BUST', EXCLUSIVE_PLAYED: 'EXCLUSIVE', SICK_PLAYED: 'SICK', STOP_PLAYED: 'STOP',
}

/** 参与"搅局"统计的牌种（打在别人交易上的干扰牌） */
export const DISRUPT_KINDS: ReadonlySet<CardType> = new Set<CardType>(['TRAVEL', 'RECRUITMENT', 'BOSS', 'BUST'])

/** 每笔交易（dealHistory 下标）里每位玩家的进账：[dealIdx][playerId]；流局全 0 */
export function perDealGains(state: GameState): number[][] {
  return state.dealHistory.map(rec => {
    const gains = state.players.map(() => 0)
    if (!rec.success) return gains
    const paid = rec.payouts.reduce((s, p) => s + p.amount, 0)
    gains[rec.bossId] += rec.grossValue - paid
    for (const p of rec.payouts) gains[p.playerId] += p.amount
    for (const r of rec.rents ?? []) gains[r.playerId] += r.amount
    return gains
  })
}

/**
 * 可用于精确核算的完整事件：有录像用录像的；否则状态里的事件流还从 GAME_STARTED 开始（没被 300 条上限截断）才算完整。
 */
export function completeEvents(state: GameState, recording?: Recording | null): readonly LoggedEvent[] | null {
  if (recording) return recording.events
  return state.events[0]?.kind === 'GAME_STARTED' ? state.events : null
}

export interface Exclusion {
  dealNo: number
  bossId: number
  /** 被排除者：本格需求里有他可用的代表，成交却没选用，也没分到钱 */
  out: Set<number>
  /** 成交那一步（日志下标） */
  step: number
}

/**
 * 每笔成交里谁被排除了。成交前的桌面只有录像能还原（事件只记了"被选用的代表"）。
 * 只算本格需求涉及的家族：与这格无关的投资者持有者不算被排除；Boss 自己、方案用了他的代表、或拿到分成的人也不算。
 */
export function computeExclusions(state: GameState, recording: Recording): Map<number, Exclusion> {
  const out = new Map<number, Exclusion>()
  for (const st of recording.steps) {
    const c = st.closing
    if (!c) continue
    const rec = state.dealHistory[c.dealNo - 1]
    const space = state.board.find(b => b.id === rec?.spaceId)
    const relevant = new Set(space?.groups.flatMap(g => g.families) ?? [])
    const used = new Set(c.usedKeys)
    const usedOwners = new Set(c.table.filter(r => used.has(r.key)).map(r => r.ownerId))
    const paid = new Set((rec?.payouts ?? []).filter(p => p.amount > 0).map(p => p.playerId))
    const ids = new Set(c.table.filter(r => !r.travelled && !used.has(r.key) && relevant.has(r.familyId)).map(r => r.ownerId))
    for (const id of [...ids]) if (id === c.bossId || usedOwners.has(id) || paid.has(id)) ids.delete(id)
    out.set(c.dealNo, { dealNo: c.dealNo, bossId: c.bossId, out: ids, step: st.index })
  }
  return out
}
export function computeStats(state: GameState, recording?: Recording | null): GameStats {
  const n = state.players.length
  const events = completeEvents(state, recording)
  const gains = perDealGains(state)
  const standings = rankStandings(state.players)

  // ---- 收入（dealHistory） ----
  const income = state.players.map(() => ({ boss: 0, share: 0, rent: 0, total: 0 }))
  const bossDeals = new Array(n).fill(0), bossClosed = new Array(n).fill(0), bossFailed = new Array(n).fill(0)
  const takeovers = new Array(n).fill(0), shareDeals = new Array(n).fill(0), soloDeals = new Array(n).fill(0)
  const disrupts = new Array(n).fill(0), disrupted = new Array(n).fill(0)
  const best: Array<Gain | null> = new Array(n).fill(null)
  let closed = 0

  state.dealHistory.forEach((rec, i) => {
    const dealNo = i + 1
    bossDeals[rec.bossId]++
    const tookOver = rec.bossId !== rec.openerId
    if (tookOver) takeovers[rec.bossId]++
    const disruptors = new Set(rec.disruptors)
    if (tookOver) disruptors.add(rec.bossId)
    for (const d of disruptors) disrupts[d]++
    // 被搅局：Boss（以及被夺权的发起者）面对至少一个别人的搅局
    for (const victim of new Set([rec.bossId, rec.openerId])) {
      if ([...disruptors].some(d => d !== victim) || (victim === rec.openerId && tookOver)) disrupted[victim]++
    }
    if (!rec.success) { bossFailed[rec.bossId]++; return }
    closed++
    bossClosed[rec.bossId]++
    const paid = rec.payouts.reduce((s, p) => s + p.amount, 0)
    income[rec.bossId].boss += rec.grossValue - paid
    if (paid === 0) soloDeals[rec.bossId]++
    for (const p of rec.payouts) { income[p.playerId].share += p.amount; if (p.amount > 0) shareDeals[p.playerId]++ }
    for (const r of rec.rents ?? []) income[r.playerId].rent += r.amount
    for (let p = 0; p < n; p++) {
      if (gains[i][p] > 0 && (!best[p] || gains[i][p] > best[p]!.amount)) best[p] = { dealNo, amount: gains[i][p] }
    }
  })
  for (const inc of income) inc.total = inc.boss + inc.share + inc.rent

  // ---- 支出 / 出牌（事件） ----
  const buy = new Array(n).fill(0), trade = new Array(n).fill(0)
  let cardsByType: Array<Partial<Record<CardType, number>>> | null = null
  if (events) {
    cardsByType = state.players.map(() => ({}))
    for (const e of events) {
      if (e.kind === 'CARDS_BOUGHT') buy[e.playerId] += e.cost
      else if (e.kind === 'CARDS_TRADED') trade[e.playerId] += e.cost
      const t = PLAY_KIND[e.kind]
      if (t && 'playerId' in e) cardsByType[e.playerId][t] = (cardsByType[e.playerId][t] ?? 0) + 1
    }
  }

  // ---- 被排除（录像） ----
  const excluded: Array<number | null> = new Array(n).fill(recording ? 0 : null)
  if (recording) {
    for (const ex of computeExclusions(state, recording).values()) {
      for (const id of ex.out) excluded[id] = (excluded[id] ?? 0) + 1
    }
  }
  // ---- 对账 ----
  const players: PlayerStats[] = state.players.map(p => {
    const inc = income[p.id]
    const exactSpend = events != null
    const spendTotal = exactSpend ? buy[p.id] + trade[p.id] : Math.max(0, inc.total - p.cash)
    const types = cardsByType ? cardsByType[p.id] : null
    const st = standings.find(s => s.player.id === p.id)!
    return {
      playerId: p.id, name: p.name, cash: p.cash, rank: st.rank, tied: st.tied, isWinner: state.winnerIds.includes(p.id),
      income: inc,
      spend: { buy: exactSpend ? buy[p.id] : null, trade: exactSpend ? trade[p.id] : null, total: spendTotal, source: exactSpend ? 'events' : 'derived' },
      reconciles: inc.total - spendTotal === p.cash,
      bossDeals: bossDeals[p.id], bossClosed: bossClosed[p.id], bossFailed: bossFailed[p.id],
      takeovers: takeovers[p.id], shareDeals: shareDeals[p.id], soloDeals: soloDeals[p.id],
      cardsPlayed: types ? Object.values(types).reduce((s, v) => s + (v ?? 0), 0) : null,
      cardsByType: types,
      disrupts: disrupts[p.id], disrupted: disrupted[p.id], excluded: excluded[p.id],
      bestDeal: best[p.id],
    }
  })

  const diffs = players.map(p => p.income.total - p.spend.total - p.cash)
  const spendSum = players.reduce((s, p) => s + p.spend.total, 0)
  const notes: string[] = []
  notes.push('起始现金为 0：最终现金 = Boss 所得 + 代表分成 + 地标租金 − 买牌 / 兑换支出')
  if (events) notes.push(state.bank > 0 || spendSum > 0 ? '买牌 / 兑换支出按事件逐笔核算，全员支出之和等于银行收入' : '本局没有买牌 / 兑换支出，现金就等于累计收入')
  else notes.push(spendSum > 0 ? '事件流已被截断，买牌 / 兑换支出由「收入 − 现金」推算（不区分买牌与兑换）' : '本局没有买牌 / 兑换支出，现金就等于累计收入')
  const diffNote = diffs.map((d, i) => d !== 0 ? `${state.players[i].name} 差 $${d}M` : null).filter(Boolean)
  if (diffNote.length) notes.push(`对不上：${diffNote.join('、')}`)
  if (spendSum !== state.bank) notes.push(`支出合计 $${spendSum}M 与银行收入 $${state.bank}M 不一致`)
  const reconciliation: Reconciliation = { ok: diffs.every(d => d === 0) && spendSum === state.bank, bank: state.bank, diffs, notes }

  // ---- 现金走势 ----
  const cashSeries = buildCashSeries(state, gains, events)

  let biggest: GameStats['biggest'] = null
  for (const p of players) {
    if (p.bestDeal && (!biggest || p.bestDeal.amount > biggest.amount)) biggest = { ...p.bestDeal, playerId: p.playerId }
  }

  return {
    players,
    deals: { total: state.dealHistory.length, closed, failed: state.dealHistory.length - closed },
    cashSeries, reconciliation, biggest, eventsComplete: events != null,
  }
}

function buildCashSeries(state: GameState, gains: number[][], events: readonly LoggedEvent[] | null): CashSeries {
  const n = state.players.length
  const points: CashPoint[] = [{ dealNo: 0, cash: new Array(n).fill(0) }]
  // 每笔交易结束事件的 id，用来把"此前的买牌 / 兑换支出"切到对应的交易之前
  const endId = new Map<number, number>()
  const spendEvents: Array<{ id: number; playerId: number; cost: number }> = []
  if (events) {
    for (const e of events) {
      if ((e.kind === 'DEAL_CLOSED' || e.kind === 'DEAL_FAILED') && e.dealNo != null) endId.set(e.dealNo, e.id)
      if (e.kind === 'CARDS_BOUGHT' || e.kind === 'CARDS_TRADED') spendEvents.push({ id: e.id, playerId: e.playerId, cost: e.cost })
    }
  }
  const running = new Array(n).fill(0)
  let si = 0
  gains.forEach((g, i) => {
    for (let p = 0; p < n; p++) running[p] += g[p]
    const cut = endId.get(i + 1)
    // 交易结算事件之前的支出已经发生（成交时点之后的支出留给下一笔）
    const spent = new Array(n).fill(0)
    if (events && cut != null) {
      while (si < spendEvents.length && spendEvents[si].id < cut) { spent[spendEvents[si].playerId] += spendEvents[si].cost; si++ }
    }
    const prev = points[points.length - 1].cash
    const carried = events ? prev.map((c, p) => c + g[p] - spent[p]) : running.slice()
    points.push({ dealNo: i + 1, cash: carried })
  })
  // 末笔交易之后、终局之前的支出（极少见）并入末点，使末点等于最终现金
  if (events && points.length > 1) {
    const last = points[points.length - 1]
    while (si < spendEvents.length) { last.cash[spendEvents[si].playerId] -= spendEvents[si].cost; si++ }
  }
  return { points, exact: events != null }
}

/** 一位玩家的收入构成简述（给提示 / 测试用）："Boss $12M + 分成 $3M + 租金 $2M − 支出 $1M = $16M" */
export function describeCashFlow(state: GameState, s: PlayerStats): string {
  const parts = [`Boss 所得 $${s.income.boss}M`, `分成 $${s.income.share}M`]
  if (s.income.rent > 0) parts.push(`租金 $${s.income.rent}M`)
  const spend = s.spend.total > 0 ? ` − 买牌 / 兑换 $${s.spend.total}M` : ''
  return `${playerName(state, s.playerId)}：${parts.join(' + ')}${spend} = $${s.cash}M`
}
