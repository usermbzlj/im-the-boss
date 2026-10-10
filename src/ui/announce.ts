// ============================================================
// announce — 读屏播报文案（aria-live）
//   只播"轮到你了"这一件事：它是整局最需要被听到的；其他重要事件已经由提示框（ToastLayer，aria-live）按同一套筛选播报，
//   这里不重复，免得刷屏。文案只依赖公开信息，不泄露电脑玩家的手牌 / 思考。
// ============================================================

import type { GameState } from '../engine/types'
import { getGrossValue } from '../engine/rules'

/** 轮到视角玩家做决定时的一句话播报；其他阶段返回空串 */
export function turnAnnouncement(state: GameState, viewerId: number): string {
  const neg = state.negotiation
  switch (state.phase) {
    case 'PLACE_MARKER': return '轮到你了：请选择一个未成交的格子放置金钱标记'
    case 'TURN': return `轮到你了：发起 #${state.markerPos} 的交易，或掷骰移动`
    case 'AFTER_MOVE': return `轮到你了：标记在 #${state.markerPos}，发起交易或抽牌结束回合`
    case 'HAND_LIMIT': return '轮到你了：手牌超过上限，请选择要弃的牌'
    case 'NEGOTIATION':
      return neg?.bossId === viewerId
        ? '轮到你了：你是 Boss，可提出方案、宣布成交、再听一轮或放弃'
        : `轮到你了：谈判中，${neg?.offer ? '方案已在桌上' : '可报价、出牌或跳过'}`
    case 'OFFER_RESPONSE': return `轮到你了：Boss 的方案用到你的代表，请同意或拒绝（总额 $${getGrossValue(state)}M）`
    case 'REACTION': return '轮到你了：是否用阻止牌取消刚打出的牌'
    case 'CLOSING': return '轮到你了：Boss 已宣布成交，放行或打出干扰牌'
    case 'END_ROLL': return '轮到你了：掷骰判定是否终局'
    default: return ''
  }
}
