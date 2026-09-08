// ============================================================
// 动作 / 结构 → 文案（中文）。合法动作本体不含文字，这里为 UI 与 LLM 编号列表
// 生成一致的标签；方案校验错误、反应窗口目标、卡牌与需求组的描述也在此。
// ============================================================

import type { GameState, PlayerAction, BoardSpace, InfluenceCard, PendingReaction, Payout } from '../engine/types'
import { HAND_LIMIT, MAX_OFFERS_PER_BOSS } from '../engine/config'
import {
  getPlayer, getCurrentSpace, getGrossValue, isRequiredGroup, findRep, offerOwners,
  playerActiveFamilies, type OfferError,
} from '../engine/rules'
import type { OfferCandidate } from '../engine/validator'
import { famLabel, famName, playerName, describeRepRef, describePayouts } from './narrate'

export function describeCard(c: InfluenceCard): string {
  switch (c.type) {
    case 'CLAN': return `家族成员-${famLabel(c.familyId!)}`
    case 'TRAVEL': return c.familyId ? `旅行-${famLabel(c.familyId)}` : '万能旅行'
    case 'RECRUITMENT': return '招募'
    case 'BOSS': return '老板'
    case 'STOP': return '阻止'
  }
}

export function describeGroups(space: BoardSpace): string {
  return space.groups.map(g => isRequiredGroup(g)
    ? `必需[${g.families.join('+')}]`
    : `${g.families.join('/')}中选${g.need}`).join(' 且 ')
}

export function describeReactionTarget(state: GameState, pr: PendingReaction): string {
  const neg = state.negotiation
  switch (pr.kind) {
    case 'TRAVEL': {
      const rep = neg ? findRep(neg, pr.targetRepKey ?? '') : undefined
      return rep ? describeRepRef(state, rep) : '（目标已不存在）'
    }
    case 'RECRUITMENT': {
      const owner = state.investors.find(i => i.familyId === pr.targetFamilyId)?.ownerId
      return `${famName(pr.targetFamilyId!)} 投资者（${owner == null ? '公共区' : playerName(state, owner)}）`
    }
    case 'BOSS':
      return `${playerName(state, neg?.bossId)} 的 Boss 身份`
  }
}

export function describeOfferError(err: OfferError): string {
  switch (err.code) {
    case 'NO_NEGOTIATION': return '当前没有进行中的谈判'
    case 'BAD_SHAPE': return '方案格式错误'
    case 'UNKNOWN_REP': return '方案引用了不存在的代表'
    case 'REP_TRAVELLED': return `${famName(err.familyId)} 家族的代表已被旅行牌打飞`
    case 'DUPLICATE_FAMILY': return `${famName(err.familyId)} 家族重复选择了代表`
    case 'IRRELEVANT_FAMILY': return `${famName(err.familyId)} 与本格需求无关`
    case 'GROUP_SHORT': return `需求组 [${err.group.families.join('/')}] 需 ${err.group.need} 个，仅有 ${err.have} 个`
    case 'GROUP_OVER': return `需求组 [${err.group.families.join('/')}] 只需 ${err.group.need} 个，多选了代表`
    case 'UNKNOWN_PAYEE': return '分成对象不存在'
    case 'PAY_TO_BOSS': return 'Boss 不能给自己分成'
    case 'DUPLICATE_PAYEE': return '同一玩家出现了两次分成'
    case 'BAD_AMOUNT': return '分成金额必须是非负整数'
    case 'OVER_GROSS': return `分成总额 $${err.total}M 超过交易总额 $${err.gross}M`
  }
}

export function candidateTitle(c: OfferCandidate): string {
  switch (c.key) {
    case 'stingy': return '独吞'
    case 'fair': return '公平分成'
    case 'meet': return '满足报价'
    case 'switch': return '换人绕开拒绝者'
  }
}

export function describeCandidate(c: OfferCandidate): string {
  const keep = `（Boss 净得 $${c.bossKeep}M）`
  switch (c.key) {
    case 'stingy': return c.needsConsent ? '独吞：不给任何人分成（代表持有者大概率拒绝）' : '独吞：全部代表都是自己的，独得全款'
    case 'fair': return `公平分成：每位代表持有者约一份分红${keep}`
    case 'meet': return `满足报价：按各方公开要价支付${keep}`
    case 'switch': return `换人：绕开拒绝者，改用其他代表${keep}`
  }
}

function describeOfferBody(state: GameState, repKeys: string[], payouts: Payout[]): string {
  const neg = state.negotiation!
  const reps = repKeys.map(k => findRep(neg, k)).filter(r => !!r)
    .map(r => `${famName(r!.familyId)}←${playerName(state, r!.ownerId)}${r!.source === 'CLAN' ? '(卡)' : ''}`).join('、')
  const owners = offerOwners(neg, { repKeys })
  const keep = getGrossValue(state) - payouts.reduce((s, p) => s + p.amount, 0)
  return `代表 ${reps}；分成 ${describePayouts(state, payouts)}；Boss 净得 $${keep}M${owners.length ? '' : '（无需他人同意）'}`
}

/** 给人 / LLM 看的动作标签，与 validator 产出的动作一一对应 */
export function describeAction(state: GameState, a: PlayerAction): string {
  const neg = state.negotiation
  const player = getPlayer(state, a.playerId)
  switch (a.type) {
    case 'PLACE_MARKER': {
      const space = state.board.find(s => s.id === a.spaceId)
      return `把金钱标记放在 #${a.spaceId}（${space ? `${describeGroups(space)}，${space.dividends} 份分红` : ''}）`
    }
    case 'OPEN_DEAL': return `发起当前格 #${state.markerPos} 的交易（总额 $${getGrossValue(state)}M），成为 Boss`
    case 'ROLL_MOVE': return '掷骰移动金钱标记'
    case 'DRAW_CARDS': return '抽 3 张影响牌并结束回合'
    case 'DISCARD': return `弃掉 ${a.cardIds.length} 张牌（默认弃价值最低的牌；可用 cardIds 自选）`
    case 'PLAY_CLAN': {
      const card = player?.hand.find(c => c.id === a.cardId)
      return `打出家族成员卡 ${card?.familyId ? famLabel(card.familyId) : ''} 入场（可附带报价 demand）`
    }
    case 'PLAY_TRAVEL': {
      const card = player?.hand.find(c => c.id === a.cardId)
      const rep = neg ? findRep(neg, a.targetRepKey) : undefined
      return `${card?.familyId ? '旅行牌' : '万能旅行牌'}打飞 ${rep ? describeRepRef(state, rep) : a.targetRepKey}`
    }
    case 'PLAY_RECRUITMENT': {
      const owner = state.investors.find(i => i.familyId === a.targetFamilyId)?.ownerId
      const suffix = state.phase === 'HAND_LIMIT' ? '（顺便减少 3 张手牌）' : ''
      return `招募三连夺取 ${famLabel(a.targetFamilyId)} 投资者（${owner == null ? '公共区' : `来自 ${playerName(state, owner)}`}）${suffix}`
    }
    case 'PLAY_BOSS': return '打出老板牌夺权，接管本笔交易'
    case 'PLAY_STOP': return '打出阻止牌，取消这张牌的效果'
    case 'PASS_REACTION': return '不阻止'
    case 'SPEAK': {
      const hasRep = !!neg && playerActiveFamilies(neg, a.playerId).size > 0
      return hasRep ? '喊话并报价：说明你的代表出借价（填 demand）' : '喊话：施压 / 表态 / 索要封口费（可填 demand）'
    }
    case 'PASS': return neg?.bossId === a.playerId ? '暂不行动，让其他人先说' : '跳过'
    case 'PROPOSE_OFFER': {
      const left = neg ? MAX_OFFERS_PER_BOSS - neg.offersMade : 0
      return `提出方案（剩 ${left} 次）— ${describeOfferBody(state, a.repKeys, a.payouts)}`
    }
    case 'ACCEPT_OFFER': return '同意出借代表（按方案拿钱）'
    case 'DECLINE_OFFER': return '拒绝出借（可填 demand 反报价）'
    case 'CLOSE_DEAL': return '宣布成交（进入"最后出牌"倒计时，无人干扰即结算）'
    case 'ABANDON_DEAL': return '放弃本笔交易（流局，无人拿钱）'
    case 'PASS_CLOSING': return '不干预，让交易成交'
    case 'ROLL_END': return '掷骰判定游戏是否结束'
  }
}

/** 手牌上限提示 */
export function handLimitHint(handSize: number): string {
  return `手牌 ${handSize} 张，需弃到 ${HAND_LIMIT} 张（弃 ${handSize - HAND_LIMIT} 张）`
}

/** 当前格的简述："#12：必需[A+B] 且 C/D中选1 | 股价 $3M × 4 份 = $12M" */
export function describeCurrentDeal(state: GameState): string {
  const space = getCurrentSpace(state)
  if (!space) return ''
  const tile = state.dealTiles[state.dealTileIndex]
  return `#${space.id}：${describeGroups(space)} | 股价 $${tile?.shareValue ?? 0}M × ${space.dividends} 份 = $${getGrossValue(state)}M`
}
