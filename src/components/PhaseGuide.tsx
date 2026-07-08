// ============================================================
// PhaseGuide — 阶段引导条
// ============================================================

import type { GameState } from '../engine/types'
import { getActingPlayerId } from '../engine/validator'

const PHASE_HINTS: Record<string, string> = {
  CHOOSE_MARKER_POSITION: '请选择金钱标记的起始格子（点击版图上的格子）',
  TURN_START: '你的回合：可以发起当前格交易，或掷骰移动金钱标记',
  POST_MOVE_CHOICE: '移动完成：尝试新位置交易，或抽3张牌结束回合',
  HAND_LIMIT_CHECK: '手牌超过12张！请弃牌或打出招募三连',
  NEGOTIATION: '谈判中：可出牌、喊话要价、Boss可提案成交',
  REACTION_WINDOW: '反应窗口：可打出阻止牌反制，或选择不干预',
  CONSENT_CHECK: '出借确认：被使用代表的玩家须同意或拒绝',
  END_GAME_ROLL: '终局阶段：掷骰判定游戏是否结束',
  GAME_OVER: '游戏结束',
}

export default function PhaseGuide({ state }: { state: GameState }) {
  const acting = state.players.find(p => p.id === getActingPlayerId(state))
  const hint = PHASE_HINTS[state.phase] ?? ''
  const isHumanTurn = acting && !acting.isAI
  // 反应窗口的当前反应者是由 gameEngine 的 nextReactorWithStop 从"持有阻止牌
  // 的玩家"里挑出来的（没有阻止牌的人会被跳过），因此点名"当前是谁在反应"
  // 等于直接告诉所有人这个人手里有阻止牌。这里对该阶段做统一脱敏。
  const revealActorName = isHumanTurn || state.phase !== 'REACTION_WINDOW'

  return (
    <div className={`phase-guide${isHumanTurn ? ' human-turn' : ''}`}>
      <span className="guide-icon">{isHumanTurn ? '👉' : '⏳'}</span>
      <span className="guide-text">
        {isHumanTurn
          ? `轮到你了！${hint}`
          : `${revealActorName ? (acting?.name ?? '…') : '其他玩家'} 行动中 — ${hint}`}
      </span>
    </div>
  )
}
