// ============================================================
// 合法动作枚举器 — 供 LLM 与 UI 使用
// ============================================================

import type { GameState, GameAction, FamilyId } from './types'
import { FAMILIES, FAMILY_IDS } from './config'
import {
  getGrossDealValue, getCurrentBoardSpace, buildSelectedRepresentatives,
  isDealRequirementMet, validateContractShape, canPlayerDemand, MAX_PROPOSALS_PER_BOSS,
} from './gameEngine'
import { buildContractCandidates } from './contractBuilder'

export interface LegalActionOption {
  action: GameAction
  label: string
}

function playerHasStop(state: GameState, playerId: number): boolean {
  return state.players.find(p => p.id === playerId)?.hand.some(c => c.type === 'STOP') ?? false
}

export function getActingPlayerId(state: GameState): number {
  if (state.phase === 'REACTION_WINDOW' && state.pendingReactionWindow) {
    return state.pendingReactionWindow.reactorId
  }
  if (state.phase === 'CONSENT_CHECK' && state.negotiation) {
    return state.negotiation.consentQueue[state.negotiation.consentIndex] ?? -1
  }
  if (state.phase === 'NEGOTIATION' && state.negotiation) {
    return state.negotiation.turnPlayerId
  }
  if (state.phase === 'CHOOSE_MARKER_POSITION' && state.markerChooserId != null) {
    return state.markerChooserId
  }
  return state.currentPlayerId
}

export function getLegalActions(state: GameState, playerId: number): LegalActionOption[] {
  const options: LegalActionOption[] = []
  const player = state.players.find(p => p.id === playerId)
  if (!player) return options

  switch (state.phase) {
    case 'CHOOSE_MARKER_POSITION': {
      if (playerId !== state.markerChooserId) break
      for (const space of state.board.filter(bs => !bs.isClosed)) {
        options.push({
          action: { type: 'CHOOSE_MARKER_POSITION', spaceId: space.id },
          label: `放置金钱标记到格子#${space.id}`,
        })
      }
      break
    }

    case 'TURN_START': {
      if (playerId !== state.currentPlayerId) break
      const space = getCurrentBoardSpace(state)
      const gross = getGrossDealValue(state)
      if (space && !space.isClosed) {
        options.push({ action: { type: 'CHOOSE_DEAL' }, label: `发起交易 $${gross}M` })
      }
      options.push({ action: { type: 'CHOOSE_ROLL' }, label: '掷骰移动' })
      break
    }

    case 'POST_MOVE_CHOICE': {
      if (playerId !== state.currentPlayerId) break
      const space = getCurrentBoardSpace(state)
      const gross = getGrossDealValue(state)
      if (space && !space.isClosed) {
        options.push({ action: { type: 'CHOOSE_DEAL' }, label: `发起交易 $${gross}M` })
      }
      options.push({ action: { type: 'CHOOSE_DRAW' }, label: '抽3张牌' })
      break
    }

    case 'HAND_LIMIT_CHECK': {
      if (playerId !== state.currentPlayerId) break
      const recruitment = player.hand.filter(c => c.type === 'RECRUITMENT')
      if (recruitment.length >= 3) {
        const hasNeutral = state.investors.some(inv => inv.ownerPlayerId === null)
        const targets = hasNeutral
          ? state.investors.filter(inv => inv.ownerPlayerId === null)
          : state.investors.filter(inv => inv.ownerPlayerId !== null && inv.ownerPlayerId !== playerId)
        for (const inv of targets) {
          options.push({
            action: {
              type: 'PLAY_RECRUITMENT',
              playerId,
              cardIds: recruitment.slice(0, 3).map(c => c.id),
              targetFamilyId: inv.familyId,
            },
            label: `招募${FAMILIES[inv.familyId].name}`,
          })
        }
      }
      // 弃牌永远是合法出路：即便手牌里凑得出招募三连，玩家/AI 也可能选择直接弃牌。
      // 之前这里完全没有枚举 DISCARD_CARDS，导致 LLM 在无法招募时拿到空列表，
      // 两次请求必然校验失败才会走到 fallback，白白多等一轮超时。
      if (player.hand.length > 12) {
        const over = player.hand.length - 12
        const sorted = [...player.hand].sort((a, b) => {
          const priority: Record<string, number> = { RECRUITMENT: 0, CLAN: 1, STOP: 2, TRAVEL: 3, BOSS: 4 }
          return (priority[a.type] ?? 5) - (priority[b.type] ?? 5)
        })
        options.push({
          action: { type: 'DISCARD_CARDS', cardIds: sorted.slice(0, over).map(c => c.id) },
          label: `弃掉${over}张牌（推荐：优先弃招募/家族牌，保留阻止/老板/旅行牌）`,
        })
      }
      break
    }

    case 'NEGOTIATION': {
      if (!state.negotiation || state.negotiation.turnPlayerId !== playerId) break
      const neg = state.negotiation
      const isBoss = neg.bossPlayerId === playerId
      const speakCount = neg.speakCounts[playerId] ?? 0

      if (speakCount < 3) {
        // 标签明确标出本次喊话能否附带要价：要价资格取决于"是否有未被
        // 打飞、且属于本格需求家族的在场代表"（见 canPlayerDemand）。
        options.push({
          action: { type: 'SPEAK', playerId, text: '…' },
          label: canPlayerDemand(state, playerId)
            ? '喊话/要价（需填台词，可附最低分成要价）'
            : '喊话（需填台词；你没有相关代表在场，要价无效）',
        })
      }

      for (const card of player.hand) {
        if (card.type === 'CLAN' && card.familyId) {
          options.push({
            action: { type: 'PLAY_CLAN', playerId, cardId: card.id, familyId: card.familyId },
            label: `打出家族成员 ${FAMILIES[card.familyId].name}`,
          })
        }
        if (card.type === 'TRAVEL') {
          const reps = neg.representatives.filter(
            r => !r.isTravelled && (!card.familyId || r.familyId === card.familyId),
          )
          for (const rep of reps) {
            options.push({
              action: {
                type: 'PLAY_TRAVEL', playerId, cardId: card.id,
                targetFamilyId: rep.familyId,
                targetCardId: rep.sourceType === 'CLAN' ? rep.cardId : undefined,
              },
              label: `旅行牌打飞 ${FAMILIES[rep.familyId].name}`,
            })
          }
        }
        if (card.type === 'BOSS' && !isBoss) {
          options.push({ action: { type: 'PLAY_BOSS', playerId }, label: '夺权（老板牌）' })
        }
      }

      const recruitment = player.hand.filter(c => c.type === 'RECRUITMENT')
      if (recruitment.length >= 3) {
        const hasNeutral = state.investors.some(inv => inv.ownerPlayerId === null)
        const targets = hasNeutral
          ? state.investors.filter(inv => inv.ownerPlayerId === null)
          : state.investors.filter(inv => inv.ownerPlayerId !== null && inv.ownerPlayerId !== playerId)
        for (const inv of targets) {
          options.push({
            action: {
              type: 'PLAY_RECRUITMENT', playerId,
              cardIds: recruitment.slice(0, 3).map(c => c.id),
              targetFamilyId: inv.familyId,
            },
            label: `招募三连 ${FAMILIES[inv.familyId].name}`,
          })
        }
      }

      if (isBoss && isDealRequirementMet(state) && neg.proposalCount < MAX_PROPOSALS_PER_BOSS) {
        // 合约候选由代码预先算好三档完整方案（独吞/均分/满足要价），LLM 或
        // 启发式 AI 只需要选择其中之一，不再需要"凭空构造" selectedRepresentatives
        // 这种深嵌套结构——这是 PROPOSE_CONTRACT 曾经完全不做校验、也最容易出错
        // 的根源（详见 contractBuilder.ts 顶部说明）。
        for (const candidate of buildContractCandidates(state, playerId)) {
          options.push({
            action: { type: 'PROPOSE_CONTRACT', contract: candidate.contract },
            label: `提出成交方案（剩${MAX_PROPOSALS_PER_BOSS - neg.proposalCount}次机会）：${candidate.label}`,
          })
        }
      }

      if (isBoss) {
        // CLOSE_DEAL 在需求未满足时会被 reducer 拒绝（见 gameEngine.ts CLOSE_DEAL 分支），
        // 之前这里无条件把它列为"合法"动作，LLM 选中后 dispatch 被 reducer 静默拒绝、
        // stateVersion 不变，AI 管线永远等不到下一次触发，游戏直接冻结。
        // 这里与 UI 侧 canClose 的门控口径保持一致，从源头杜绝该分支被选中。
        if (isDealRequirementMet(state)) {
          options.push({
            action: { type: 'CLOSE_DEAL' },
            label: state.negotiation?.proposedContract
              ? '宣布准备成交（按当前方案进入最后反应与出借确认）'
              : '宣布准备成交（未提方案，将按"无分成"默认方案执行，代表持有者很可能拒绝）',
          })
        }
        options.push({ action: { type: 'FAIL_DEAL' }, label: '放弃交易' })
      }
      options.push({ action: { type: 'PASS_NEGOTIATION', playerId }, label: '跳过' })
      break
    }

    case 'REACTION_WINDOW': {
      const pw = state.pendingReactionWindow
      if (!pw || pw.reactorId !== playerId) break
      if (playerHasStop(state, playerId)) {
        options.push({ action: { type: 'PLAY_STOP', playerId }, label: '打出阻止牌' })
      }
      options.push({ action: { type: 'PASS_REACTION', playerId }, label: '不干预' })
      break
    }

    case 'CONSENT_CHECK': {
      if (!state.negotiation) break
      const current = state.negotiation.consentQueue[state.negotiation.consentIndex]
      if (current !== playerId) break
      options.push({ action: { type: 'CONSENT_AGREE', playerId }, label: '同意出借' })
      options.push({ action: { type: 'CONSENT_REFUSE', playerId }, label: '拒绝出借' })
      break
    }

    case 'END_GAME_ROLL': {
      if (playerId === state.currentPlayerId) {
        options.push({ action: { type: 'ROLL_DIE' }, label: '掷骰判定终局' })
      }
      break
    }
  }

  return options
}

export function validateAction(state: GameState, action: GameAction): boolean {
  if (action.type === 'SPEAK') {
    const pid = action.playerId
    if (state.phase !== 'NEGOTIATION' || !state.negotiation) return false
    if (state.negotiation.turnPlayerId !== pid) return false
    if ((state.negotiation.speakCounts[pid] ?? 0) >= 3) return false
    return action.text.trim().length > 0
  }
  if (action.type === 'CHOOSE_MARKER_POSITION') {
    const chooser = state.markerChooserId
    if (chooser == null) return false
    return getLegalActions(state, chooser).some(
      o => o.action.type === 'CHOOSE_MARKER_POSITION' && o.action.spaceId === action.spaceId,
    )
  }
  if (action.type === 'CHOOSE_DEAL' || action.type === 'CHOOSE_ROLL' || action.type === 'CHOOSE_DRAW') {
    return getLegalActions(state, state.currentPlayerId).some(o => o.action.type === action.type)
  }
  if (action.type === 'CLOSE_DEAL' || action.type === 'FAIL_DEAL') {
    return getLegalActions(state, state.negotiation?.bossPlayerId ?? -1).some(o => o.action.type === action.type)
  }
  if (action.type === 'PROPOSE_CONTRACT') {
    // 之前这里直接 return true，把校验责任推给 reducer；但 reducer 校验通过后
    // 一份结构错误的合约（比如 ownerPlayerId 指向不存在的代表）会被塞进
    // consentQueue，导致 getActingPlayerId 返回 -1、无人能行动的隐性死锁。
    // 现在提前用与 reducer 完全一致的 validateContractShape 做深度校验。
    // proposalCount 上限同样要在这里查，与 getLegalActions 的门控口径保持一致，
    // 否则未来任何绕过 legal[] 直接调用 validateAction 的调用方（例如未来的
    // "直接提交合约表单"功能）都会误判一份本应被拒绝的第N+1次提案为合法。
    if (state.phase !== 'NEGOTIATION' || !state.negotiation) return false
    if (state.negotiation.turnPlayerId !== state.negotiation.bossPlayerId) return false
    if (state.negotiation.proposalCount >= MAX_PROPOSALS_PER_BOSS) return false
    return validateContractShape(state, action.contract)
  }
  if (action.type === 'ROLL_DIE') {
    // 原先写的是 state.currentPlayerId === state.currentPlayerId，恒真式，
    // 完全没有校验发起者身份。这里改为真正校验：只有阶段正确即可（行动者身份
    // 由 getActingPlayerId 在 reducer 之外保证，reducer 内 ROLL_DIE 分支本身
    // 不区分 playerId，全员只有 currentPlayerId 有权限触发）。
    return state.phase === 'END_GAME_ROLL'
  }
  const pid = 'playerId' in action && action.playerId != null ? action.playerId : state.currentPlayerId
  return getLegalActions(state, pid).some(o => actionsMatch(o.action, action))
}

function actionsMatch(a: GameAction, b: GameAction): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'PLAY_CLAN' && b.type === 'PLAY_CLAN') return a.cardId === b.cardId
  if (a.type === 'PLAY_TRAVEL' && b.type === 'PLAY_TRAVEL') {
    return a.cardId === b.cardId && a.targetFamilyId === b.targetFamilyId && a.targetCardId === b.targetCardId
  }
  if (a.type === 'PLAY_RECRUITMENT' && b.type === 'PLAY_RECRUITMENT') {
    return a.targetFamilyId === b.targetFamilyId
  }
  if (a.type === 'CHOOSE_MARKER_POSITION' && b.type === 'CHOOSE_MARKER_POSITION') {
    return a.spaceId === b.spaceId
  }
  return true
}

/**
 * 供 LLM 使用的合法动作清单：只暴露编号 + 人类可读标签，不再暴露原始 action
 * JSON。旧协议要求模型把完整 JSON 抄一遍再自由发挥字段，任何一处笔误都会
 * 校验失败；新协议下模型只需回复编号，动作本体完全由引擎侧的 legal[]反查
 * 得到，从根源上消灭了"抄错/编造非法结构"这一类失败源。
 */
export function formatLegalActionsForLLM(legal: LegalActionOption[]): string {
  return legal.map((a, i) => `${i + 1}. ${a.label}`).join('\n')
}
