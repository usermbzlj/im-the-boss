// ============================================================
// 事件 → 文案（中文）。引擎只记录 GameEvent，这里负责把它讲成人话。
// UI 日志、座位气泡、LLM 提示词里的"最近发生了什么"都走这一份实现。
// ============================================================

import type { GameEvent, GameState, FamilyId, Payout, RepRef, ReactionKind } from '../engine/types'
import { FAMILIES, HAND_LIMIT, MAX_OFFERS_PER_BOSS } from '../engine/config'

export type EventTone = 'system' | 'action' | 'card' | 'deal' | 'fail' | 'end' | 'speech'

export interface Narration {
  text: string
  tone: EventTone
}

export const famName = (f: FamilyId) => FAMILIES[f].name
export const famLabel = (f: FamilyId) => `${f}·${FAMILIES[f].name}`

export function playerName(state: GameState, id: number | null | undefined): string {
  if (id == null) return '?'
  return state.players[id]?.name ?? `#${id}`
}

export const reactionKindName = (kind: ReactionKind) =>
  kind === 'TRAVEL' ? '旅行牌' : kind === 'BOSS' ? '老板牌' : '招募三连'

const repSourceName = (r: RepRef) => (r.source === 'INVESTOR' ? '投资者' : '家族成员')

export function describeRepRef(state: GameState, r: RepRef): string {
  return `${playerName(state, r.ownerId)} 的 ${famName(r.familyId)}${repSourceName(r)}`
}

export function describePayouts(state: GameState, payouts: Payout[]): string {
  const parts = payouts.filter(p => p.amount > 0).map(p => `${playerName(state, p.playerId)} $${p.amount}M`)
  return parts.length ? parts.join('、') : '无人分成'
}

export function narrate(state: GameState, e: GameEvent): Narration {
  const n = (id: number | null | undefined) => playerName(state, id)
  switch (e.kind) {
    case 'GAME_STARTED':
      return { tone: 'system', text: `游戏开始！${e.playerCount} 人局。${n(e.startPlayerId)} 持有字母序最前的投资者，成为起始玩家；由右手边的 ${n(e.markerChooserId)} 放置金钱标记` }
    case 'MARKER_PLACED':
      return { tone: 'action', text: `${n(e.playerId)} 把金钱标记放在 #${e.spaceId}。轮到 ${n(e.nextPlayerId)} 行动` }
    case 'DEAL_OPENED':
      return { tone: 'deal', text: `${n(e.playerId)} 宣布："Let's make a deal!" 发起 #${e.spaceId} 的交易（总额 $${e.gross}M），成为 Boss` }
    case 'MARKER_MOVED':
      return { tone: 'action', text: `${n(e.playerId)} 掷出 ${e.die}，金钱标记移到 #${e.spaceId}（总额 $${e.gross}M）` }
    case 'CARDS_DRAWN':
      return { tone: 'action', text: `${n(e.playerId)} 抽了 ${e.count} 张牌（手牌 ${e.handSize} 张）` }
    case 'DECK_RESHUFFLED':
      return { tone: 'system', text: `抽牌堆耗尽，弃牌堆洗成新牌堆（${e.size} 张）` }
    case 'HAND_LIMIT':
      return { tone: 'system', text: `${n(e.playerId)} 手牌 ${e.handSize} 张，超过 ${HAND_LIMIT} 张上限，须弃牌或打出招募三连` }
    case 'CARDS_DISCARDED':
      return { tone: 'action', text: `${n(e.playerId)} 弃了 ${e.count} 张牌` }
    case 'CLAN_PLAYED':
      return { tone: 'card', text: `${n(e.playerId)} 打出家族成员卡：${famName(e.familyId)}（本笔交易中可代替该投资者）` }
    case 'TRAVEL_PLAYED':
      return { tone: 'card', text: `${n(e.playerId)} 打出${e.wildcard ? '万能' : ''}旅行牌 → ${describeRepRef(state, e.target)}` }
    case 'RECRUITMENT_PLAYED':
      return { tone: 'card', text: `${n(e.playerId)} 打出招募三连 → ${famName(e.familyId)} 投资者（${e.fromId == null ? '公共区' : n(e.fromId)}）` }
    case 'BOSS_PLAYED':
      return { tone: 'card', text: `${n(e.playerId)} 打出老板牌，试图从 ${n(e.bossId)} 手中夺取 Boss 身份` }
    case 'STOP_PLAYED':
      return { tone: 'card', text: `${n(e.playerId)} 打出阻止牌！${n(e.actorId)} 的${reactionKindName(e.cancelled)}被取消` }
    case 'TRAVEL_RESOLVED':
      return e.target.source === 'CLAN'
        ? { tone: 'card', text: `${n(e.target.ownerId)} 的 ${famName(e.target.familyId)} 家族成员被旅行牌打飞，连同旅行牌一起弃置` }
        : { tone: 'card', text: `${n(e.target.ownerId)} 的 ${famName(e.target.familyId)} 投资者被旅行牌送去出差，本笔交易中失效` }
    case 'RECRUITMENT_RESOLVED':
      return { tone: 'card', text: `${n(e.playerId)} 招募成功，${famName(e.familyId)} 投资者${e.fromId == null ? '从公共区' : `从 ${n(e.fromId)} 手中`}归其所有` }
    case 'BOSS_RESOLVED':
      return { tone: 'card', text: `${n(e.playerId)}："I'm the Boss!" 夺权成功，从 ${n(e.previousBossId)} 手中接管本笔交易（原方案作废）` }
    case 'OFFER_VOIDED':
      return { tone: 'system', text: `方案中的代表${e.reason === 'TRAVELLED' ? '被打飞' : '已易主'}，方案作废，Boss 需重新提案` }
    case 'SPEECH':
      return { tone: 'speech', text: `${n(e.playerId)}：「${e.text}」` }
    case 'DEMAND':
      return { tone: 'action', text: `${n(e.playerId)} 报价：$${e.amount}M${e.familyId ? `（${famName(e.familyId)} 代表出借价）` : '（封口费）'}` }
    case 'STALEMATE_ROUND':
      return { tone: 'system', text: `全员跳过一轮，谈判停滞（${e.rounds}/${e.max}，再一轮无人行动将流局）` }
    case 'OFFER_PROPOSED': {
      const reps = e.reps.map(r => `${famName(r.familyId)}←${n(r.ownerId)}${r.source === 'CLAN' ? '(卡)' : ''}`).join('、')
      const wait = e.waitingFor.length ? `；等待 ${e.waitingFor.map(n).join('、')} 应答` : '；只用 Boss 自己的代表，无需他人同意'
      return { tone: 'action', text: `${n(e.bossId)} 提出方案 #${e.offerNo}/${MAX_OFFERS_PER_BOSS}：代表 ${reps}；分成 ${describePayouts(state, e.payouts)}；Boss 净得 $${e.bossKeep}M${wait}` }
    }
    case 'OFFER_ACCEPTED':
      return { tone: 'action', text: `${n(e.playerId)} 同意出借代表` }
    case 'OFFER_DECLINED':
      return { tone: 'fail', text: `${n(e.playerId)} 拒绝出借代表${e.counter != null ? `，反报价 $${e.counter}M` : ''}` }
    case 'OFFER_RESOLVED':
      return e.agreed
        ? { tone: 'system', text: '方案获得全部代表持有者同意，Boss 可宣布成交' }
        : { tone: 'fail', text: `${e.declinerIds.map(n).join('、')} 拒绝了方案，Boss 可加价、换人或放弃` }
    case 'CLOSING_STARTED':
      return { tone: 'deal', text: `${n(e.bossId)}："Going once, going twice…" 宣布成交，其他玩家最后一次出牌机会` }
    case 'CLOSING_INTERRUPTED':
      return { tone: 'system', text: '成交倒计时被打断，回到谈判' }
    case 'DEAL_CLOSED': {
      const pays = e.payouts.length ? `，其中 ${e.payouts.map(p => `${n(p.playerId)} 分得 $${p.amount}M`).join('、')}` : ''
      return { tone: 'deal', text: `成交！第 ${e.dealNumber} 笔：银行付给 ${n(e.bossId)} $${e.gross}M${pays}，${n(e.bossId)} 净得 $${e.bossKeep}M；景气牌 #${e.tileId} 盖在 #${e.spaceId} 上` }
    }
    case 'DEAL_FAILED':
      return { tone: 'fail', text: `#${e.spaceId} 的交易流局（${e.reason === 'ABANDONED' ? `${n(e.bossId)} 主动放弃` : '谈判陷入僵局，连续多轮无人行动'}）。家族卡收回，金钱标记留在原地` }
    case 'END_ROLL_DUE':
      return { tone: 'end', text: `已进入终局阶段：${n(e.playerId)} 掷骰，掷出 ${e.faces.join('/')} 则游戏结束` }
    case 'END_ROLL':
      return { tone: 'end', text: `终局掷骰：${e.die}，${e.hit ? '命中！' : '未命中，游戏继续'}` }
    case 'GAME_OVER':
      return { tone: 'end', text: `游戏结束！${e.winnerIds.map(n).join('、')} 以 $${e.cash}M ${e.winnerIds.length > 1 ? '并列' : ''}获胜` }
  }
}
