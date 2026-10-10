// ============================================================
// 卡面信息（纯逻辑）：一张影响牌在手牌区的"卡面"该显示什么
//   图标 / 牌种 / 标题 / 一句效果摘要 / 完整说明（悬停或长按放大时看）/ 主题色
// 数值（利好 +$2M、利空 −$1M）取自 engine/config，不在这里硬编码。
// ============================================================

import type { CardType, FamilyId, InfluenceCard } from '../engine/types'
import { BOOM_BONUS, BUST_PENALTY, FAMILIES } from '../engine/config'

export interface CardFace {
  type: CardType
  icon: string
  /** 牌种名（卡面左上角） */
  kind: string
  /** 卡面大标题：家族牌是家族名，其他是牌名 */
  title: string
  /** 一句效果摘要（卡面常驻） */
  summary: string
  /** 完整说明（放大查看） */
  detail: string
  /** 主题色：家族牌用家族色，其余按牌种 */
  accent: string
  familyId?: FamilyId
  /** 稀有牌 / 桌规牌（卡面加一条角标） */
  badge?: string
}

export const CARD_ICONS: Record<CardType, string> = {
  CLAN: '👤', TRAVEL: '✈️', RECRUITMENT: '📋', BOSS: '👑', STOP: '🛑', BOOM: '📈', BUST: '📉', EXCLUSIVE: '🔒', SICK: '🤒',
}

export const CARD_KIND: Record<CardType, string> = {
  CLAN: '家族卡', TRAVEL: '旅行', RECRUITMENT: '招募', BOSS: '老板', STOP: '阻止', BOOM: '利好', BUST: '利空', EXCLUSIVE: '独家协议', SICK: '病假',
}

/** 非家族牌的主题色（与 game.css 里 .card.type-* 的强调色一致） */
export const CARD_ACCENT: Record<Exclude<CardType, 'CLAN'>, string> = {
  TRAVEL: '#39b8c6', RECRUITMENT: '#b78cff', BOSS: '#f85149', STOP: '#58a6ff', BOOM: '#3fb950', BUST: '#f0883e', EXCLUSIVE: '#f0b429', SICK: '#8fd694',
}

export function cardFace(card: InfluenceCard): CardFace {
  const fam = card.familyId ? FAMILIES[card.familyId] : null
  const common = { type: card.type, icon: CARD_ICONS[card.type], kind: CARD_KIND[card.type], familyId: card.familyId }
  switch (card.type) {
    case 'CLAN':
      return {
        ...common, title: fam?.name ?? '家族成员', summary: '临时代表', accent: fam?.color ?? '#8b949e',
        detail: `打出后成为${fam ? ` ${fam.name} ` : '该家族'}的临时代表，参与本笔交易；可附带承诺价，Boss 付到即自动同意。本笔结束后弃置。`,
      }
    case 'TRAVEL':
      return {
        ...common, title: fam ? fam.name : '万能旅行', summary: fam ? '打飞该家族代表' : '打飞任一代表', accent: CARD_ACCENT.TRAVEL,
        detail: fam
          ? `定向旅行牌：只能打飞 ${fam.name} 的代表，让他本笔交易中失效（投资者本局结束后恢复，家族卡直接弃置）。包含该代表的方案会作废。`
          : '万能旅行牌：可以打飞桌上任意一个代表，让他本笔交易中失效（投资者本局结束后恢复，家族卡直接弃置）。包含该代表的方案会作废。',
      }
    case 'RECRUITMENT':
      return {
        ...common, title: '招募', summary: '3 张成组夺投资者', accent: CARD_ACCENT.RECRUITMENT,
        detail: '凑齐 3 张招募牌一起打出（猎头格只要 2 张，被夺走最后一位投资者后抢回只要 1 张），夺走一位投资者，成为他的主人。',
      }
    case 'BOSS':
      return {
        ...common, title: "I'm the Boss!", summary: '夺取 Boss 身份', accent: CARD_ACCENT.BOSS,
        detail: '谈判或成交倒计时中打出：夺走当前 Boss 的位置，原方案作废。独家协议生效后不能再打。',
      }
    case 'STOP':
      return {
        ...common, title: '阻止', summary: '取消对手刚打的牌', accent: CARD_ACCENT.STOP,
        detail: '别人打出旅行 / 招募 / 老板 / 利好 / 利空 / 独家 / 病假牌时，在反应窗口里打出阻止牌，把那张牌取消（黑市格里没有反应窗口，阻止牌无用）。',
      }
    case 'BOOM':
      return {
        ...common, title: '利好', summary: `+$${BOOM_BONUS}M/份`, accent: CARD_ACCENT.BOOM, badge: '稀有',
        detail: `Boss 打出：本笔每份股价 +$${BOOM_BONUS}M，已有方案的分成不变，多出的钱全归 Boss。`,
      }
    case 'BUST':
      return {
        ...common, title: '利空', summary: `−$${BUST_PENALTY}M/份`, accent: CARD_ACCENT.BUST, badge: '稀有',
        detail: `非 Boss 打出：本笔每份股价 −$${BUST_PENALTY}M（最低 $1M/份），砍的是 Boss 的净得，方案里别人的分成不变。`,
      }
    case 'EXCLUSIVE':
      return {
        ...common, title: '独家协议', summary: '锁定本笔交易', accent: CARD_ACCENT.EXCLUSIVE, badge: '稀有',
        detail: 'Boss 打出：本笔交易锁定——之后谁都不能再打老板牌 / 旅行牌 / 利空牌（招募仍可）。',
      }
    case 'SICK':
      return {
        ...common, title: '病假', summary: '禁出牌一回合', accent: CARD_ACCENT.SICK, badge: '桌规',
        detail: '指定一名玩家：本回合内他不能主动出牌 / 换牌，只能喊话、报价、应答、跳过；阻止牌仍可打出自保。',
      }
  }
}
