// ============================================================
// PhaseGuide — 阶段引导条：现在是什么阶段、轮到谁、该做什么
// ============================================================

import type { GameState } from '../engine/types'
import { getActingPlayerId } from '../engine/validator'
import { getGrossValue, offerShareOf, hasStop } from '../engine/rules'
import { HAND_LIMIT } from '../engine/config'

export default function PhaseGuide({ state }: { state: GameState }) {
  const actingId = getActingPlayerId(state)
  const acting = state.players[actingId]
  const human = !!acting && !acting.isAI
  const neg = state.negotiation
  const gross = getGrossValue(state)

  let text = ''
  switch (state.phase) {
    case 'PLACE_MARKER':
      text = human ? '请点击版图上的任意格子放置金钱标记（起始玩家将先决定是否交易那一格）' : `${acting?.name} 正在放置金钱标记`
      break
    case 'TURN':
      text = human ? `你的回合：发起当前格 #${state.markerPos} 的交易（$${gross}M），或掷骰移动` : `${acting?.name} 的回合`
      break
    case 'AFTER_MOVE':
      text = human ? `标记移到 #${state.markerPos}（$${gross}M）：发起交易，或抽 3 张牌结束回合` : `${acting?.name} 移动后抉择中`
      break
    case 'HAND_LIMIT':
      text = human ? `手牌超过 ${HAND_LIMIT} 张：点选要弃的牌，或打出招募三连` : `${acting?.name} 手牌超限，处理中`
      break
    case 'NEGOTIATION': {
      const boss = state.players[neg!.bossId]
      const role = neg!.bossId === actingId ? 'Boss' : ''
      text = human
        ? (neg!.bossId === 0 ? '你是 Boss：出牌、喊话、提出方案；方案全员同意后可宣布成交' : '轮到你：出牌、喊话报价，或跳过')
        : `谈判中（Boss：${boss?.name}）— ${acting?.name}${role ? '（Boss）' : ''} 行动中`
      break
    }
    case 'OFFER_RESPONSE':
      text = human ? `Boss 的方案要用你的代表，分给你 $${offerShareOf(neg?.offer, 0)}M：同意或拒绝` : `等待 ${acting?.name} 应答方案`
      break
    case 'REACTION':
      text = human
        ? (hasStop(acting) ? `${state.players[state.pendingReaction!.actorId]?.name} 打出了牌：是否用阻止牌取消？` : `${state.players[state.pendingReaction!.actorId]?.name} 打出了牌，你没有阻止牌`)
        : '反应窗口：依次询问其他玩家是否阻止…'
      break
    case 'CLOSING':
      text = human ? 'Boss 已宣布成交，这是你最后的出牌机会：放行或打出干扰牌' : `成交倒计时：等待 ${acting?.name} 放行或出牌`
      break
    case 'END_ROLL':
      text = human ? '终局判定：掷骰！' : `${acting?.name} 掷终局骰`
      break
    case 'GAME_OVER':
      text = '游戏结束'
      break
  }

  return (
    <div className={`phase-guide${human ? ' human-turn' : ''}`}>
      <span className="guide-icon">{human ? '👉' : '⏳'}</span>
      <span className="guide-text">{human ? `轮到你了！${text}` : text}</span>
      {neg && (
        <span className="guide-right">
          交易 #{neg.spaceId} · ${gross}M · 方案 {neg.offersMade}/5
          {neg.stalemateRounds > 0 && <b className="red"> · 再一轮无人行动将流局</b>}
        </span>
      )}
    </div>
  )
}
