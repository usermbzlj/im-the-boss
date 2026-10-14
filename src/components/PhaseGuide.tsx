// ============================================================
// PhaseGuide — 阶段引导条：现在是什么阶段、轮到谁、该做什么
// ============================================================

import type { GameState } from '../engine/types'
import { getActingPlayerId } from '../engine/validator'
import { getGrossValue, offerShareOf, hasStop, isSick, tableCanComplete } from '../engine/rules'
import { HAND_LIMIT, MAX_OFFERS_PER_BOSS } from '../engine/config'
import { reactionKindName } from '../text/narrate'
import { useViewerId } from './ViewerContext'

export default function PhaseGuide({ state }: { state: GameState }) {
  const viewerId = useViewerId()
  const actingId = getActingPlayerId(state)
  const acting = state.players[actingId]
  /** 轮到视角玩家自己 */
  const human = !!acting && actingId === viewerId
  const neg = state.negotiation
  const gross = getGrossValue(state)
  const house = state.houseRules ? '；桌规：可先买牌 / 兑换招募牌' : ''

  let text = ''
  switch (state.phase) {
    case 'PLACE_MARKER':
      text = human ? '请点击版图上的任意格子放置金钱标记（起始玩家将先决定是否交易那一格）' : `${acting?.name} 正在放置金钱标记`
      break
    case 'TURN':
      text = human ? `你的回合：发起当前格 #${state.markerPos} 的交易（$${gross}M），或掷骰移动${house}` : `${acting?.name} 的回合`
      break
    case 'AFTER_MOVE':
      text = human ? `标记移到 #${state.markerPos}（$${gross}M）：发起交易，或抽 3 张牌结束回合${house}` : `${acting?.name} 移动后抉择中`
      break
    case 'HAND_LIMIT':
      text = human ? `手牌超过 ${HAND_LIMIT} 张：点选要弃的牌，或打出招募牌夺取投资者` : `${acting?.name} 手牌超限，处理中`
      break
    case 'NEGOTIATION': {
      const boss = state.players[neg!.bossId]
      const role = neg!.bossId === actingId ? 'Boss' : ''
      text = human
        ? (neg!.bossId === viewerId
          ? (neg!.offer ? '你是 Boss：方案全员同意后可宣布成交；也可修改方案、再听一轮或放弃' : '你是 Boss：听完叫价，用自己的家族卡省钱，再提出方案')
          : (neg!.offer ? '轮到你：方案已在桌上——压价抢单、打干扰牌，或跳过' : '叫价轮：报出你的出借价（承诺价）、打家族卡入场、出牌，或跳过'))
        : `谈判中（Boss：${boss?.name}）— ${acting?.name}${role ? '（Boss）' : ''} 行动中`
      if (human && isSick(state, viewerId)) text += '（你病假中：不能主动出牌）'
      break
    }
    case 'OFFER_RESPONSE':
      text = human ? `Boss 的方案要用你的代表，分给你 $${offerShareOf(neg?.offer, viewerId)}M：同意或拒绝` : `等待 ${acting?.name} 应答方案`
      break
    case 'REACTION': {
      const pr = state.pendingReaction!
      const what = `${state.players[pr.actorId]?.name} 打出了${reactionKindName(pr.kind)}${pr.kind === 'SICK' && pr.targetPlayerId === viewerId ? '，目标是你' : ''}`
      text = human
        ? (hasStop(acting) ? `${what}：是否用阻止牌取消？` : `${what}，你没有阻止牌`)
        : '反应窗口：依次询问其他玩家是否阻止…'
      break
    }
    case 'CLOSING':
      text = human
        ? (isSick(state, viewerId) ? 'Boss 已宣布成交；你病假中不能打干扰牌，只能放行' : 'Boss 已宣布成交，这是你最后的出牌机会：放行或打出干扰牌（没有干扰牌会自动放行）')
        : '成交倒计时：依次询问其他玩家放行或出牌…' // 不点名当前被询问者，否则会暴露谁手里有干扰牌
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
          交易 #{neg.spaceId} · ${gross}M · 方案 {neg.offersMade}/{MAX_OFFERS_PER_BOSS}
          {neg.stalemateRounds > 0 && <b className="red"> · 再一轮无实质进展将流局</b>}
          {neg.stalemateRounds === 0 && state.phase === 'NEGOTIATION' && !tableCanComplete(state) && <b className="muted"> · 缺代表：全员一轮无实质进展即流局</b>}
        </span>
      )}
    </div>
  )
}
