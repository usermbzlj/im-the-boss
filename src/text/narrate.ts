// ============================================================
// 事件 → 文案（中文）。引擎只记录 GameEvent，这里负责把它讲成人话。
// UI 日志、座位气泡、LLM 提示词里的"最近发生了什么"都走这一份实现。
// ============================================================

import type { GameEvent, GameState, FamilyId, Payout, RepRef, ReactionKind, ResolvedQuote, SpaceKind, CardType, FailReason } from '../engine/types'
import { FAMILIES, HAND_LIMIT, MAX_OFFERS_PER_BOSS, getVariant, LANDMARK_RENT, PREMIUM_BONUS, HEADHUNT_RECRUIT_COST, BOOM_BONUS, BUST_PENALTY } from '../engine/config'

export type EventTone = 'system' | 'action' | 'card' | 'deal' | 'fail' | 'end' | 'speech'

export interface Narration {
  text: string
  tone: EventTone
  /** 次要事件（跳过 / 放行之类）：UI 可折叠、提示词的"最近动态"可略去，不影响叙事完整性 */
  minor?: boolean
}

/** 该事件是否为次要（narrate 会标 minor）；不需要文案时的快速判定 */
export const isMinorEvent = (e: GameEvent): boolean => e.kind === 'PASSED'

const PASS_PHASE_NAME = { NEGOTIATION: '谈判中', CLOSING: '成交倒计时', REACTION: '反应窗口' } as const

export const famName = (f: FamilyId) => FAMILIES[f].name
export const famLabel = (f: FamilyId) => `${f}·${FAMILIES[f].name}`

export function playerName(state: GameState, id: number | null | undefined): string {
  if (id == null) return '?'
  return state.players[id]?.name ?? `#${id}`
}

export const reactionKindName = (kind: ReactionKind) =>
  kind === 'TRAVEL' ? '旅行牌' : kind === 'BOSS' ? '老板牌' : kind === 'RECRUITMENT' ? '招募牌'
    : kind === 'BOOM' ? '利好牌' : kind === 'BUST' ? '利空牌' : kind === 'SICK' ? '病假牌' : '独家协议'

/** 牌种类的中文名 */
export const cardTypeName = (type: CardType) =>
  type === 'CLAN' ? '家族成员' : type === 'TRAVEL' ? '旅行' : type === 'RECRUITMENT' ? '招募' : type === 'BOSS' ? '老板'
    : type === 'STOP' ? '阻止' : type === 'BOOM' ? '利好' : type === 'BUST' ? '利空' : type === 'SICK' ? '病假' : '独家协议'

/** 流局原因的说法 */
export const failReasonName = (reason: FailReason) =>
  reason === 'ABANDONED' ? 'Boss 放弃' : reason === 'INCOMPLETE' ? '缺代表且无实质进展' : '僵局'

/** 特殊格名称与一句话效果（STANDARD 返回空串） */
export const spaceKindName = (kind: SpaceKind) =>
  kind === 'LANDMARK' ? '地标' : kind === 'PREMIUM' ? '抢手' : kind === 'BLACK_MARKET' ? '黑市' : kind === 'HEADHUNT' ? '猎头' : ''

export const spaceKindEffect = (kind: SpaceKind) => {
  switch (kind) {
    case 'LANDMARK': return `成交后归 Boss 所有，此后每笔成交主人从银行收 $${LANDMARK_RENT}M 租金`
    case 'PREMIUM': return `股价 +$${PREMIUM_BONUS}M/份`
    case 'BLACK_MARKET': return '打出的牌不经反应窗口直接生效，阻止牌无用'
    case 'HEADHUNT': return `交易进行中招募只需 ${HEADHUNT_RECRUIT_COST} 张`
    default: return ''
  }
}

/** 招募消耗的说法："招募三连" / "招募两连（猎头价）" / "招募一张（夺回）" */
export const recruitCostName = (cost: number) => cost >= 3 ? '招募三连' : cost === 2 ? '招募两连（猎头价）' : '1 张招募牌（夺回权）'

export const variantName = (state: GameState) => getVariant(state.variantId).name

const repSourceName = (r: RepRef) => (r.source === 'INVESTOR' ? '投资者' : '家族成员')

export function describeRepRef(state: GameState, r: RepRef): string {
  return `${playerName(state, r.ownerId)} 的 ${famName(r.familyId)}${repSourceName(r)}`
}

export function describePayouts(state: GameState, payouts: Payout[]): string {
  const parts = payouts.filter(p => p.amount > 0).map(p => `${playerName(state, p.playerId)} $${p.amount}M`)
  return parts.length ? parts.join('、') : '无人分成'
}

/** 落成后的报价："赤岩集团 $3M、黑松控股 $1M（每个代表，付到即成）" / "$2M（封口费）" */
export function describeQuotes(quotes: ResolvedQuote[]): string {
  const hush = quotes.find(q => q.familyIds.length === 0)
  const reps = quotes.filter(q => q.familyIds.length > 0)
  const parts: string[] = []
  if (reps.length) {
    const body = reps.length === 1 && reps[0].familyIds.length > 1 && reps.every(q => q.familyIds.length > 1)
      ? `$${reps[0].amount}M（${reps[0].familyIds.map(famName).join('/')}，每个代表）`
      : reps.flatMap(q => q.familyIds.map(f => `${famName(f)} $${q.amount}M`)).join('、')
    parts.push(`${body}，付到即成`)
  }
  if (hush) parts.push(`$${hush.amount}M（封口费）`)
  return parts.join('；')
}

export function narrate(state: GameState, e: GameEvent): Narration {
  const n = (id: number | null | undefined) => playerName(state, id)
  switch (e.kind) {
    case 'GAME_STARTED':
      return { tone: 'system', text: `游戏开始！${e.playerCount} 人局 · ${getVariant(e.variantId).name}（最多 ${e.deals} 笔成交）。${n(e.startPlayerId)} 持有字母序最前的投资者，成为起始玩家；由右手边的 ${n(e.markerChooserId)} 放置金钱标记` }
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
      return { tone: 'system', text: `${n(e.playerId)} 手牌 ${e.handSize} 张，超过 ${HAND_LIMIT} 张上限，须弃牌或打出招募牌` }
    case 'CARDS_DISCARDED':
      return { tone: 'action', text: `${n(e.playerId)} 弃了 ${e.count} 张牌` }
    case 'CARDS_BOUGHT':
      return { tone: 'action', text: `${n(e.playerId)} 付给银行 $${e.cost}M，多抽了 ${e.count} 张牌（手牌 ${e.handSize} 张）` }
    case 'CARD_SWAPPED':
      return e.to === 'TRAVEL'
        ? { tone: 'card', text: `${n(e.playerId)} 把手中的 ${famName(e.familyId)} 家族成员牌换成了 ${famName(e.familyId)} 旅行牌（他持有该家族投资者）` }
        : { tone: 'card', text: `${n(e.playerId)} 把手中的 ${famName(e.familyId)} 旅行牌换成了 ${famName(e.familyId)} 家族成员牌（他持有该家族投资者）` }
    case 'CARDS_TRADED':
      return { tone: 'card', text: `${n(e.playerId)} 交出 ${e.given.map(cardTypeName).join(' + ')} 并付给银行 $${e.cost}M，换到 2 张招募牌（现有 ${e.recruitCount} 张）` }
    case 'SICK_PLAYED':
      return { tone: 'card', text: `${n(e.playerId)} 打出病假牌 → ${n(e.targetId)}：本回合内他将不能主动出牌` }
    case 'SICK_RESOLVED':
      return { tone: 'card', text: `${n(e.targetId)} 病倒了：本回合内不能主动出牌（家族 / 旅行 / 招募 / 老板 / 稀有牌与换牌都不行），只能被动打阻止牌` }
    case 'CLAN_PLAYED':
      return { tone: 'card', text: `${n(e.playerId)} 打出家族成员卡：${famName(e.familyId)}（本笔交易中可代替该投资者）` }
    case 'TRAVEL_PLAYED':
      return { tone: 'card', text: `${n(e.playerId)} 打出${e.wildcard ? '万能' : ''}旅行牌 → ${describeRepRef(state, e.target)}` }
    case 'RECRUITMENT_PLAYED':
      return { tone: 'card', text: `${n(e.playerId)} 打出${recruitCostName(e.cost)} → ${famName(e.familyId)} 投资者（${e.fromId == null ? '公共区' : n(e.fromId)}）` }
    case 'BOSS_PLAYED':
      return { tone: 'card', text: `${n(e.playerId)} 打出老板牌，试图从 ${n(e.bossId)} 手中夺取 Boss 身份` }
    case 'BOOM_PLAYED':
      return { tone: 'card', text: `${n(e.playerId)} 打出利好牌：本笔股价将 +$${BOOM_BONUS}M/份` }
    case 'BUST_PLAYED':
      return { tone: 'card', text: `${n(e.playerId)} 打出利空牌：本笔股价将 −$${BUST_PENALTY}M/份` }
    case 'EXCLUSIVE_PLAYED':
      return { tone: 'card', text: `${n(e.playerId)} 打出独家协议：要锁定本笔交易（老板 / 旅行 / 利空牌失效）` }
    case 'STOP_PLAYED': {
      const at = e.targetRep ? `（目标：${describeRepRef(state, e.targetRep)}）`
        : e.targetFamilyId ? `（目标：${famName(e.targetFamilyId)} 投资者）`
          : e.targetPlayerId != null ? `（目标：${n(e.targetPlayerId)}）` : ''
      return { tone: 'card', text: `${n(e.playerId)} 打出阻止牌！${n(e.actorId)} 的${reactionKindName(e.cancelled)}${at}被取消` }
    }
    case 'PASSED':
      return { tone: 'system', minor: true, text: `${n(e.playerId)} ${e.phase === 'NEGOTIATION' ? '跳过' : '放行'}（${PASS_PHASE_NAME[e.phase]}）` }
    case 'COMMITMENT_UPDATED':
      return { tone: 'action', text: `${n(e.playerId)} 的承诺价改为：${e.changes.map(c => `${famName(c.familyId)} $${c.to}M${c.from == null ? '' : `（原 $${c.from}M）`}`).join('、')}，将来付到即成` }
    case 'BLACK_MARKET':
      return { tone: 'system', text: `黑市规矩：${n(e.actorId)} 的${reactionKindName(e.card)}不经反应窗口，直接生效` }
    case 'RECLAIM_GRANTED':
      return { tone: 'system', text: `${n(e.playerId)} 失去了最后一位常驻投资者，获得夺回权：只需 1 张招募牌即可把 ${famName(e.familyId)} 投资者抢回来` }
    case 'PRICE_CHANGED':
      if (e.delta === 0) return { tone: 'card', text: `利空打出，但股价已经在下限，交易总额仍是 $${e.gross}M` }
      return { tone: 'card', text: `${e.delta > 0 ? '利好' : '利空'}生效：本笔股价${e.delta > 0 ? '+' : '−'}$${Math.abs(e.delta)}M/份，交易总额变为 $${e.gross}M（已有方案的分成不变，变的是 Boss 净得）` }
    case 'EXCLUSIVE_RESOLVED':
      return { tone: 'card', text: `${n(e.playerId)} 的独家协议生效：本笔交易中老板牌、旅行牌、利空牌不能再打` }
    case 'LANDMARK_CLAIMED':
      return { tone: 'deal', text: `地标 #${e.spaceId} 归 ${n(e.playerId)} 所有：此后每笔成交从银行收 $${LANDMARK_RENT}M 租金` }
    case 'RENT_PAID':
      return { tone: 'deal', text: `地标租金：${e.payments.map(p => `${n(p.playerId)} +$${p.amount}M`).join('、')}` }
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
      return { tone: 'action', text: `${n(e.playerId)} 报价：${describeQuotes(e.quotes)}` }
    case 'STALEMATE_ROUND':
      return { tone: 'system', text: `全员一轮无实质进展，谈判停滞（${e.rounds}/${e.max}；若接下来${e.max - e.rounds > 1 ? ` ${e.max - e.rounds} 轮` : '再一轮'}仍无改价 / 出牌 / 提案等进展，将流局；重复原价或纯喊话也计入）` }
    case 'OFFER_PROPOSED': {
      const reps = e.reps.map(r => `${famName(r.familyId)}←${n(r.ownerId)}${r.source === 'CLAN' ? '(卡)' : ''}`).join('、')
      const auto = e.autoAccepted ?? []
      const tail = e.waitingFor.length
        ? `；等待 ${e.waitingFor.map(n).join('、')} 应答`
        : auto.length ? '' : '；只用 Boss 自己的代表，无需他人同意'
      return { tone: 'action', text: `${n(e.bossId)} 提出方案 #${e.offerNo}/${MAX_OFFERS_PER_BOSS}：代表 ${reps}；分成 ${describePayouts(state, e.payouts)}；Boss 净得 $${e.bossKeep}M${tail}` }
    }
    case 'OFFER_ACCEPTED':
      return e.auto
        ? { tone: 'action', text: `${n(e.playerId)} 的承诺价已付到，按约视为同意` }
        : { tone: 'action', text: `${n(e.playerId)} 同意出借代表` }
    case 'OFFER_DECLINED':
      return { tone: 'fail', text: `${n(e.playerId)} 拒绝出借代表${e.counters.length ? `，反报价：${describeQuotes(e.counters)}` : ''}` }
    case 'OFFER_RESOLVED':
      return e.agreed
        ? { tone: 'system', text: '方案获得全部代表持有者同意，Boss 可宣布成交' }
        : { tone: 'fail', text: `${e.declinerIds.map(n).join('、')} 拒绝了方案，Boss 可加价、换人或放弃` }
    case 'CLOSING_STARTED':
      return { tone: 'deal', text: `${n(e.bossId)}："Going once, going twice…" 宣布成交，其他玩家最后一次出牌机会` }
    case 'CLOSING_INTERRUPTED': {
      const at = e.targetRep ? `（目标：${describeRepRef(state, e.targetRep)}）`
        : e.targetFamilyId ? `（目标：${famName(e.targetFamilyId)} 投资者）` : ''
      return { tone: 'system', text: `${n(e.actorId)} 的${reactionKindName(e.by)}${at}生效，成交倒计时被打断，回到谈判` }
    }
    case 'DEAL_CLOSED': {
      const pays = e.payouts.length ? `，其中 ${e.payouts.map(p => `${n(p.playerId)} 分得 $${p.amount}M`).join('、')}` : ''
      const used = e.reps?.length ? `；所用代表：${e.reps.map(r => `${famName(r.familyId)}←${n(r.ownerId)}${r.source === 'CLAN' ? '(卡)' : ''}`).join('、')}` : ''
      return { tone: 'deal', text: `成交！第 ${e.dealNumber} 笔：银行付给 ${n(e.bossId)} $${e.gross}M${pays}，${n(e.bossId)} 净得 $${e.bossKeep}M${used}；景气牌 #${e.tileId} 盖在 #${e.spaceId} 上` }
    }
    case 'DEAL_FAILED': {
      const why = e.reason === 'ABANDONED' ? `${n(e.bossId)} 主动放弃`
        : e.reason === 'INCOMPLETE' ? '桌上凑不齐代表，全员一轮无实质进展'
          : '谈判陷入僵局，连续多轮无实质进展'
      const lack = e.missing?.length ? `，缺 ${e.missing.map(famName).join('、')} 的代表` : ''
      return { tone: 'fail', text: `#${e.spaceId} 的交易流局（${why}${lack}）。未被打飞的家族卡收回，金钱标记留在原地` }
    }
    case 'END_ROLL_DUE':
      return { tone: 'end', text: `已进入终局阶段：${n(e.playerId)} 掷骰，掷出 ${e.faces.join('/')} 则游戏结束` }
    case 'END_ROLL':
      return { tone: 'end', text: `终局掷骰：${e.die}，${e.hit ? '命中！' : '未命中，游戏继续'}` }
    case 'GAME_OVER':
      return { tone: 'end', text: `游戏结束！${e.winnerIds.map(n).join('、')} 以 $${e.cash}M ${e.winnerIds.length > 1 ? '并列' : ''}获胜` }
  }
}
