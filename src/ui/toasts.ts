// ============================================================
// 行动提示（Toast）的纯逻辑：
//   briefOf        一条事件 → 面向视角玩家的短句（含"与你有关"的判定、合并分组）
//   toastDraftsFor 一批新事件 → 要弹的提示草稿（过滤掉自己刚做的动作与低价值事件）
//   mergeToasts    把草稿并入当前可见的提示：连续同类合并计数、最多 max 条
// 信息隐藏：只根据"已经落地的事件"生成提示，从不提示"谁正在考虑 / 谁在被询问"。
// "刚刚发生"简报（eventFeed.recentDigest）复用同一份短句。
// ============================================================

import type { GameState, LoggedEvent } from '../engine/types'
import { playerHasRelevantRep } from '../engine/rules'
import { describeQuotes, describeRepRef, failReasonName, famName, playerName, reactionKindName } from '../text/narrate'

export type ToastTone = 'info' | 'good' | 'bad' | 'deal' | 'fail'

export interface EventBrief {
  text: string
  tone: ToastTone
  /** 与视角玩家有关（醒目配色） */
  mine: boolean
  /** 合并分组：连续、同组的提示合并成一条并计数 */
  group: string
  /** 是否值得弹提示（false：只进"刚刚发生"简报，如掷骰移动） */
  toast: boolean
  /** 这是视角玩家自己刚做的动作的回声（他自己点的，不必再弹） */
  selfEcho: boolean
}

export interface ToastDraft {
  group: string
  text: string
  tone: ToastTone
  mine: boolean
  /** 显示时长（毫秒） */
  ttl: number
}

export interface Toast extends ToastDraft {
  key: number
  /** 合并了多少条 */
  count: number
  /** 每次合并 +1：界面据此重置消失计时 */
  version: number
}

export const MAX_TOASTS = 3

/** 提示的显示时长：与你有关的更久，普通的短 */
export function ttlFor(tone: ToastTone, mine: boolean): number {
  if (mine || tone === 'bad') return 4000
  if (tone === 'deal' || tone === 'fail' || tone === 'good') return 3400
  return 2600
}

/**
 * 一条事件的短句。返回 null = 这类事件不进提示 / 简报（喊话、跳过、抽牌……）。
 * 与视角玩家有关的事件（被打飞 / 被挖走 / 被夺权 / 被排除出方案 / 收到方案……）带 mine，tone 为 bad / good。
 */
export function briefOf(state: GameState, e: LoggedEvent, viewerId: number): EventBrief | null {
  const n = (id: number | null | undefined) => (id === viewerId ? '你' : playerName(state, id))
  const of = (id: number) => (id === viewerId ? '你的' : `${playerName(state, id)}的`)
  const neg = state.negotiation
  const iAmBoss = neg?.bossId === viewerId
  const brief = (text: string, tone: ToastTone, opts: { mine?: boolean; group?: string; toast?: boolean; self?: boolean } = {}): EventBrief => ({
    text, tone, mine: opts.mine ?? false, group: opts.group ?? `${e.kind}`, toast: opts.toast ?? true, selfEcho: opts.self ?? false,
  })
  /** 与你有关的"坏消息"不合并（每条都要看清） */
  const bad = (text: string, self = false): EventBrief => brief(text, 'bad', { mine: true, group: `bad:${e.id}`, self })
  const good = (text: string): EventBrief => brief(text, 'good', { mine: true, group: `good:${e.id}` })

  switch (e.kind) {
    case 'DEAL_OPENED':
      return brief(`${n(e.playerId)}发起 #${e.spaceId} 的交易（$${e.gross}M），成为 Boss`, 'info', { group: 'open', self: e.playerId === viewerId })
    case 'MARKER_MOVED':
      return brief(`${n(e.playerId)}掷出 ${e.die}，标记移到 #${e.spaceId}（$${e.gross}M）`, 'info', { toast: false })
    case 'MARKER_PLACED':
      return brief(`${n(e.playerId)}把金钱标记放在 #${e.spaceId}`, 'info', { toast: false })

    case 'CLAN_PLAYED':
      return brief(`${n(e.playerId)}打出 ${famName(e.familyId)} 家族卡入场`, 'info', { group: `card:${e.playerId}`, self: e.playerId === viewerId })
    case 'TRAVEL_PLAYED':
      if (e.target.ownerId === viewerId && e.playerId !== viewerId) return bad(`${n(e.playerId)}对你的 ${famName(e.target.familyId)} 代表打出了${e.wildcard ? '万能' : ''}旅行牌！`)
      return brief(`${n(e.playerId)}打出${e.wildcard ? '万能' : ''}旅行牌 → ${describeRepRef(state, e.target)}`, 'info', { group: `card:${e.playerId}`, self: e.playerId === viewerId })
    case 'TRAVEL_RESOLVED':
      if (e.target.ownerId === viewerId) return bad(`你的 ${famName(e.target.familyId)} 代表被旅行牌打飞了`)
      return brief(`${of(e.target.ownerId)} ${famName(e.target.familyId)} 代表被旅行牌打飞`, 'info', { group: 'resolve' })
    case 'RECRUITMENT_PLAYED':
      if (e.fromId === viewerId && e.playerId !== viewerId) return bad(`${n(e.playerId)}要招募你的 ${famName(e.familyId)} 投资者！`)
      return brief(`${n(e.playerId)}打出招募牌 → ${famName(e.familyId)} 投资者`, 'info', { group: `card:${e.playerId}`, self: e.playerId === viewerId })
    case 'RECRUITMENT_RESOLVED':
      if (e.fromId === viewerId) return bad(`你的 ${famName(e.familyId)} 投资者被 ${n(e.playerId)} 挖走了`)
      if (e.playerId === viewerId) return good(`招募成功：${famName(e.familyId)} 投资者归你了`)
      return brief(`${n(e.playerId)}招募成功，拿下 ${famName(e.familyId)} 投资者`, 'info', { group: 'resolve' })
    case 'BOSS_PLAYED':
      if (e.bossId === viewerId && e.playerId !== viewerId) return bad(`${n(e.playerId)}打出老板牌，想夺走你的 Boss 位置！`)
      return brief(`${n(e.playerId)}打出老板牌，要夺 ${n(e.bossId)} 的 Boss`, 'info', { group: `card:${e.playerId}`, self: e.playerId === viewerId })
    case 'BOSS_RESOLVED':
      if (e.previousBossId === viewerId) return bad(`${n(e.playerId)}夺权成功，你不再是 Boss 了`)
      if (e.playerId === viewerId) return good('夺权成功：你成为新的 Boss')
      return brief(`${n(e.playerId)}夺权成功，成为新的 Boss`, 'info', { group: 'resolve' })
    case 'BOOM_PLAYED':
      return brief(`${n(e.playerId)}打出利好牌：股价 +$2M/份`, 'info', { group: `card:${e.playerId}`, self: e.playerId === viewerId })
    case 'BUST_PLAYED':
      if (iAmBoss && e.playerId !== viewerId) return bad(`${n(e.playerId)}打出利空牌：你的成交总额要缩水了`)
      return brief(`${n(e.playerId)}打出利空牌：股价 −$1M/份`, 'info', { group: `card:${e.playerId}`, self: e.playerId === viewerId })
    case 'EXCLUSIVE_PLAYED':
      return brief(`${n(e.playerId)}打出独家协议，想锁定本笔交易`, 'info', { group: `card:${e.playerId}`, self: e.playerId === viewerId })
    case 'PRICE_CHANGED':
      if (e.delta === 0) return null
      return brief(`股价${e.delta > 0 ? '上涨' : '下跌'}：本笔总额变为 $${e.gross}M`, 'info', { group: 'resolve' })
    case 'EXCLUSIVE_RESOLVED':
      return brief('独家协议生效：老板 / 旅行 / 利空牌被锁定', 'info', { group: 'resolve' })
    case 'SICK_PLAYED':
      if (e.targetId === viewerId && e.playerId !== viewerId) return bad(`${n(e.playerId)}对你打出了病假牌！`)
      return brief(`${n(e.playerId)}对 ${n(e.targetId)} 打出病假牌`, 'info', { group: `card:${e.playerId}`, self: e.playerId === viewerId })
    case 'SICK_RESOLVED':
      if (e.targetId === viewerId) return bad('你病倒了：本回合不能主动出牌（阻止牌仍可打）')
      return brief(`${n(e.targetId)}病倒了，本回合不能主动出牌`, 'info', { group: 'resolve' })
    case 'STOP_PLAYED': {
      const what = reactionKindName(e.cancelled)
      if (e.actorId === viewerId && e.playerId !== viewerId) return bad(`${n(e.playerId)}用阻止牌取消了你的${what}`)
      if (e.playerId === viewerId) return good(`你的阻止牌生效：${n(e.actorId)}的${what}被取消`)
      return brief(`${n(e.playerId)}打出阻止牌，取消了 ${n(e.actorId)} 的${what}`, 'info', { group: 'resolve' })
    }
    case 'DEMAND':
      // 只有你是 Boss 时，别人的报价才直接关系到你的方案
      if (!iAmBoss || e.playerId === viewerId) return null
      return brief(`${n(e.playerId)}报价：${describeQuotes(e.quotes)}`, 'info', { mine: true, group: 'quote' })
    case 'COMMITMENT_UPDATED': {
      const text = e.changes.map(c => `${famName(c.familyId)} $${c.to}M`).join('、')
      if (e.playerId === viewerId) return brief(`你的承诺价改为：${text}`, 'good', { mine: true, group: `commit:${e.playerId}` })
      return brief(`${n(e.playerId)}的承诺价改为：${text}`, 'info', { mine: iAmBoss, group: 'quote' })
    }
    case 'OFFER_PROPOSED': {
      if (e.bossId === viewerId) return brief(`你提出了方案 #${e.offerNo}`, 'info', { group: 'offer', self: true })
      const usesMe = e.reps.some(r => r.ownerId === viewerId)
      const myShare = e.payouts.find(p => p.playerId === viewerId)?.amount ?? 0
      const boss = n(e.bossId)
      if (usesMe && e.waitingFor.includes(viewerId)) return brief(`${boss}的方案要用你的代表，分你 $${myShare}M——等你表态`, 'info', { mine: true, group: `offer:${e.id}` })
      if (usesMe) return good(`${boss}的方案付到了你的承诺价，按约视为同意（分你 $${myShare}M）`)
      if (playerHasRelevantRep(state, viewerId)) return bad(`你被排除出方案：${boss}的方案没有用你的代表`)
      if (myShare > 0) return brief(`${boss}的方案分你 $${myShare}M（没用你的代表）`, 'info', { mine: true, group: `offer:${e.id}` })
      return brief(`${boss}提出方案 #${e.offerNo}，自己净得 $${e.bossKeep}M`, 'info', { group: 'offer' })
    }
    case 'OFFER_ACCEPTED':
      if (e.auto || !iAmBoss || e.playerId === viewerId) return null
      return brief(`${n(e.playerId)}同意出借代表`, 'good', { mine: true, group: 'accept' })
    case 'OFFER_DECLINED':
      if (e.playerId === viewerId) return null
      if (iAmBoss) return bad(`${n(e.playerId)}拒绝了你的方案${e.counters.length ? `，反报价：${describeQuotes(e.counters)}` : ''}`)
      return brief(`${n(e.playerId)}拒绝出借代表`, 'info', { group: 'offer' })
    case 'OFFER_RESOLVED':
      if (!e.agreed) return null
      return iAmBoss ? good('方案全员同意：可以宣布成交了') : brief('方案获全员同意，Boss 即将宣布成交', 'info', { group: 'offer' })
    case 'OFFER_VOIDED':
      return iAmBoss ? bad('方案中的代表失效，方案作废，需要重新提案') : brief('方案作废：代表被打飞或易主', 'info', { group: 'resolve' })
    case 'CLOSING_STARTED':
      return brief(`${n(e.bossId)}宣布成交，进入最后出牌倒计时`, 'info', { group: 'closing', self: e.bossId === viewerId })
    case 'CLOSING_INTERRUPTED':
      return brief(`${n(e.actorId)}的${reactionKindName(e.by)}生效，成交倒计时被打断`, 'info', { group: 'resolve', self: e.actorId === viewerId })

    case 'DEAL_CLOSED': {
      const iGet = e.bossId === viewerId ? e.bossKeep : (e.payouts.find(p => p.playerId === viewerId)?.amount ?? 0)
      const text = e.bossId === viewerId
        ? `成交！第 ${e.dealNumber} 笔 $${e.gross}M：你净得 $${e.bossKeep}M`
        : `成交！第 ${e.dealNumber} 笔 $${e.gross}M：${n(e.bossId)}净得 $${e.bossKeep}M${iGet > 0 ? `，你分得 $${iGet}M` : ''}`
      return brief(text, iGet > 0 ? 'good' : 'deal', { mine: iGet > 0, group: `result:${e.id}` })
    }
    case 'DEAL_FAILED': {
      const text = `#${e.spaceId} 的交易流局（${failReasonName(e.reason)}${e.missing?.length ? `，缺 ${e.missing.map(famName).join('、')}` : ''}）`
      return e.bossId === viewerId ? bad(`你的${text}`) : brief(text, 'fail', { group: `result:${e.id}` })
    }
    case 'LANDMARK_CLAIMED':
      return e.playerId === viewerId ? good(`地标 #${e.spaceId} 归你了：以后每笔成交都收租`) : brief(`${n(e.playerId)}成为地标 #${e.spaceId} 的主人`, 'info', { group: 'rent' })
    case 'RENT_PAID': {
      const mine = e.payments.find(p => p.playerId === viewerId)
      if (mine) return good(`地标租金：你收到 $${mine.amount}M`)
      return brief(`地标收租：${e.payments.map(p => `${n(p.playerId)} +$${p.amount}M`).join('、')}`, 'info', { group: 'rent' })
    }
    case 'RECLAIM_GRANTED':
      if (e.playerId !== viewerId) return null
      return brief(`你失去了最后一位投资者，获得夺回权：1 张招募牌就能抢回 ${famName(e.familyId)}`, 'info', { mine: true, group: `reclaim:${e.id}` })
    case 'END_ROLL':
      return brief(`终局骰：${e.die}，${e.hit ? '命中，游戏结束' : '未命中，游戏继续'}`, e.hit ? 'fail' : 'info', { group: 'end' })
    default:
      return null
  }
}

/** 一批新事件 → 要弹的提示草稿（时间正序）。自己刚点的动作、低价值事件不弹 */
export function toastDraftsFor(state: GameState, events: readonly LoggedEvent[], viewerId: number): ToastDraft[] {
  const out: ToastDraft[] = []
  for (const e of events) {
    const b = briefOf(state, e, viewerId)
    if (!b || !b.toast || b.selfEcho) continue
    out.push({ group: b.group, text: b.text, tone: b.tone, mine: b.mine, ttl: ttlFor(b.tone, b.mine) })
  }
  return out
}

/**
 * 把新草稿并入当前提示：
 *   · 与"最新一条"同组 → 合并（计数 +1、文案换成最新一条、版本 +1 重置计时）
 *   · 否则追加；超过 max 条时挤掉最旧的（优先挤掉与你无关的）
 */
export function mergeToasts(current: readonly Toast[], drafts: readonly ToastDraft[], nextKey: () => number, max = MAX_TOASTS): Toast[] {
  let list = current.map(t => ({ ...t }))
  for (const d of drafts) {
    const last = list[list.length - 1]
    if (last && last.group === d.group) {
      list[list.length - 1] = { ...last, ...d, key: last.key, count: last.count + 1, version: last.version + 1 }
      continue
    }
    list.push({ ...d, key: nextKey(), count: 1, version: 0 })
    while (list.length > max) {
      const idx = list.findIndex(t => !t.mine)
      list = list.filter((_, i) => i !== (idx >= 0 ? idx : 0))
    }
  }
  return list
}
