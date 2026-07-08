// ============================================================
// Fallback AI — 启发式决策（无 LLM 时使用）
// ============================================================

import type { GameState, GameAction, FamilyId } from '../engine/types'
import {
  getGrossDealValue, getCurrentBoardSpace, isDealRequirementMet,
  canPlayerDemand, MAX_PROPOSALS_PER_BOSS,
} from '../engine/gameEngine'
import { buildContractCandidates } from '../engine/contractBuilder'
import { getActingPlayerId, getLegalActions, validateAction } from '../engine/validator'

export { getActingPlayerId }

export function getFallbackAction(state: GameState): GameAction | null {
  const actingId = getActingPlayerId(state)
  const player = state.players.find(p => p.id === actingId)
  if (!player?.isAI) return null

  const legal = getLegalActions(state, actingId)
  if (legal.length === 0) return null

  const decided = decideByPhase(state, actingId, legal)

  // 最后一道防线：无论上面的启发式分支写得多细，只要有一处遗漏了某个边界
  // 条件（比如忘记检查 speakCounts 上限），手搓出来的动作就可能不在 legal[]
  // 中、被 validateAction 拒绝。fallback 是"保证游戏不冻结"的最后兜底，
  // 它自己绝不能成为冻结源——如果决策结果不合法，直接退化为 legal[0]
  // （在 getLegalActions 阶段就保证合法的最保守选项）。
  if (decided && validateAction(state, decided)) return decided
  return legal[0]?.action ?? null
}

function decideByPhase(state: GameState, actingId: number, legal: ReturnType<typeof getLegalActions>): GameAction | null {
  switch (state.phase) {
    case 'CHOOSE_MARKER_POSITION':
      return pickMarkerPosition(state, actingId, legal)
    case 'TURN_START':
      return decideTurnStart(state, actingId, legal)
    case 'POST_MOVE_CHOICE':
      return decidePostMove(state, actingId, legal)
    case 'HAND_LIMIT_CHECK':
      return decideHandLimit(state, actingId, legal)
    case 'NEGOTIATION':
      return decideNegotiation(state, actingId, legal)
    case 'REACTION_WINDOW':
      return decideReaction(state, actingId, legal)
    case 'CONSENT_CHECK':
      return decideConsent(state, actingId, legal)
    case 'END_GAME_ROLL':
      return { type: 'ROLL_DIE' }
    default:
      return legal[0]?.action ?? null
  }
}

function pickMarkerPosition(_state: GameState, _id: number, legal: ReturnType<typeof getLegalActions>): GameAction {
  const highValue = legal.find(o => {
    if (o.action.type !== 'CHOOSE_MARKER_POSITION') return false
    const sp = _state.board.find(b => b.id === (o.action as { spaceId: number }).spaceId)
    return sp && sp.dividends >= 4
  })
  return (highValue?.action ?? legal[0].action) as GameAction
}

function dealCompletableAsBoss(state: GameState, bossId: number): boolean {
  const space = getCurrentBoardSpace(state)
  if (!space) return false
  const boss = state.players.find(p => p.id === bossId)
  const bossClans = new Set<import('../engine/types').FamilyId>()
  if (boss) for (const c of boss.hand) if (c.type === 'CLAN' && c.familyId) bossClans.add(c.familyId)
  const owned = (fam: import('../engine/types').FamilyId) =>
    state.investors.some(i => i.familyId === fam && i.ownerPlayerId !== null && !i.isTravelled)
  const ok = (fam: import('../engine/types').FamilyId) => owned(fam) || bossClans.has(fam)
  return space.requiredFamilies.every(ok) &&
    space.optionalFamilies.filter(ok).length >= space.optionalNeed
}

function decideTurnStart(state: GameState, playerId: number, legal: ReturnType<typeof getLegalActions>): GameAction {
  const gross = getGrossDealValue(state)
  if (dealCompletableAsBoss(state, playerId) && gross >= 4) {
    return (legal.find(o => o.action.type === 'CHOOSE_DEAL')?.action ?? { type: 'CHOOSE_ROLL' }) as GameAction
  }
  return (legal.find(o => o.action.type === 'CHOOSE_ROLL')?.action ?? legal[0].action) as GameAction
}

function decidePostMove(state: GameState, playerId: number, legal: ReturnType<typeof getLegalActions>): GameAction {
  const gross = getGrossDealValue(state)
  if (dealCompletableAsBoss(state, playerId) && gross >= 3) {
    return (legal.find(o => o.action.type === 'CHOOSE_DEAL')?.action ?? legal.find(o => o.action.type === 'CHOOSE_DRAW')!.action) as GameAction
  }
  return (legal.find(o => o.action.type === 'CHOOSE_DRAW')?.action ?? legal[0].action) as GameAction
}

function decideHandLimit(state: GameState, playerId: number, legal: ReturnType<typeof getLegalActions>): GameAction {
  const recruit = legal.find(o => o.action.type === 'PLAY_RECRUITMENT')
  if (recruit) return recruit.action
  const player = state.players.find(p => p.id === playerId)!
  const over = player.hand.length - 12
  const sorted = [...player.hand].sort((a, b) => {
    const p: Record<string, number> = { RECRUITMENT: 0, CLAN: 1, STOP: 2, TRAVEL: 3, BOSS: 4 }
    return (p[a.type] ?? 5) - (p[b.type] ?? 5)
  })
  return { type: 'DISCARD_CARDS', cardIds: sorted.slice(0, over).map(c => c.id) }
}

function decideNegotiation(state: GameState, playerId: number, legal: ReturnType<typeof getLegalActions>): GameAction {
  const neg = state.negotiation!
  if (neg.bossPlayerId === playerId) return decideBoss(state, playerId, legal)
  return decideNonBoss(state, playerId, legal)
}

function decideBoss(state: GameState, bossId: number, legal: ReturnType<typeof getLegalActions>): GameAction {
  const neg = state.negotiation!
  const reqMet = isDealRequirementMet(state)

  if (reqMet) {
    // 提案候选是否存在于 legal[] 中，是提案次数上限的唯一权威判断（见
    // validator.ts getLegalActions 里对 proposalCount 的门控）。之前这里
    // 无条件调用 buildContractCandidates 直接构造 PROPOSE_CONTRACT，完全
        // 绕过了 legal 列表——一旦某任 Boss 的方案被 CONSENT_REFUSE 清空
        // （proposedContract 变回 null）但 proposalCount 已达上限，fallback
        // 会不断尝试重新提案、被 reducer 拒绝、watchdog 又触发同一个 fallback，
        // 陷入死循环。改为只在 legal 里确实存在提案选项时才走这条分支。
    if (!neg.proposedContract) {
      const proposeOption = legal.find(o => o.action.type === 'PROPOSE_CONTRACT')
      if (proposeOption) {
        // 与 LLM 走同一套候选生成逻辑（见 contractBuilder.ts），fallback 偏好
        // fair（均分）档位；直接从 legal 里找同 key 的候选，避免重复计算。
        const candidates = buildContractCandidates(state, bossId)
        const fair = candidates.find(c => c.key === 'fair') ?? candidates[0]
        if (fair) return { type: 'PROPOSE_CONTRACT', contract: fair.contract }
        return proposeOption.action
      }
    }
    return (legal.find(o => o.action.type === 'CLOSE_DEAL')?.action ?? legal.find(o => o.action.type === 'PASS_NEGOTIATION')!.action) as GameAction
  }

  const clan = legal.find(o => o.action.type === 'PLAY_CLAN')
  if (clan) return clan.action
  const recruit = legal.find(o => o.action.type === 'PLAY_RECRUITMENT')
  if (recruit) return recruit.action
  return (legal.find(o => o.action.type === 'FAIL_DEAL')?.action ?? legal[0].action) as GameAction
}

/** 挑一张"值得打"的家族成员卡：家族属于本格需求、且自己在该家族还没有有效代表 */
function pickClanEntry(state: GameState, playerId: number, legal: ReturnType<typeof getLegalActions>): GameAction | null {
  const neg = state.negotiation!
  const space = state.board.find(b => b.id === neg.boardSpaceId)
  if (!space) return null
  const relevant = new Set<FamilyId>([...space.requiredFamilies, ...space.optionalFamilies])
  for (const o of legal) {
    if (o.action.type !== 'PLAY_CLAN') continue
    const fid = o.action.familyId
    if (!relevant.has(fid)) continue
    const alreadyMine = neg.representatives.some(
      r => r.ownerPlayerId === playerId && r.familyId === fid && !r.isTravelled,
    )
    if (!alreadyMine) return o.action
  }
  return null
}

/** 旅行牌选靶：绝不打自己的代表；优先打Boss的，其次打任意对手的 */
function pickTravelTarget(state: GameState, playerId: number, legal: ReturnType<typeof getLegalActions>): GameAction | null {
  const neg = state.negotiation!
  const scored: Array<{ action: GameAction; ownerId: number }> = []
  for (const o of legal) {
    if (o.action.type !== 'PLAY_TRAVEL') continue
    const a = o.action
    const rep = neg.representatives.find(r =>
      r.familyId === a.targetFamilyId &&
      !r.isTravelled &&
      (a.targetCardId != null ? r.cardId === a.targetCardId : r.sourceType === 'INVESTOR'),
    )
    if (!rep || rep.ownerPlayerId === playerId) continue
    scored.push({ action: a, ownerId: rep.ownerPlayerId })
  }
  if (scored.length === 0) return null
  return (scored.find(s => s.ownerId === neg.bossPlayerId) ?? scored[0]).action
}

function decideNonBoss(state: GameState, playerId: number, legal: ReturnType<typeof getLegalActions>): GameAction {
  const neg = state.negotiation!
  const gross = getGrossDealValue(state)
  const myShare = neg.proposedContract?.payout.find(p => p.playerId === playerId)?.amount ?? 0
  const persona = state.players.find(p => p.id === playerId)?.personaId
  const pass = () => legal.find(o => o.action.type === 'PASS_NEGOTIATION')?.action ?? legal[0].action

  if (myShare > 0) return pass()

  if (gross >= 8) {
    const boss = legal.find(o => o.action.type === 'PLAY_BOSS')
    if (boss && dealCompletableAsBoss(state, playerId)) return boss.action
  }

  if (gross >= 5 && (persona === 'grudge' || persona === 'stingy' || Math.random() < 0.5)) {
    const travel = pickTravelTarget(state, playerId, legal)
    if (travel) return travel
  }

  // 先入场（打出相关家族成员卡拿到谈判资格），下一轮再要价
  if (gross >= 4) {
    const clanEntry = pickClanEntry(state, playerId, legal)
    if (clanEntry) return clanEntry
  }

  // 已有代表在场但尚未要价 → 正式要价；同家族有竞争对手时主动压价抢单
  const hasDemanded = neg.demands.some(d => d.playerId === playerId)
  const speakOption = legal.find(o => o.action.type === 'SPEAK')
  if (!hasDemanded && speakOption && speakOption.action.type === 'SPEAK' && canPlayerDemand(state, playerId) && gross >= 3) {
    const myFamilies = new Set(
      neg.representatives.filter(r => r.ownerPlayerId === playerId && !r.isTravelled).map(r => r.familyId),
    )
    const hasRival = neg.representatives.some(
      r => r.ownerPlayerId !== playerId && !r.isTravelled && myFamilies.has(r.familyId),
    )
    let ask = Math.max(2, Math.floor(gross / 4))
    if (hasRival) {
      const rivalAsks = neg.demands
        .filter(d => d.playerId !== playerId && (d.familyId == null || myFamilies.has(d.familyId)))
        .map(d => d.amount)
      const rivalMin = rivalAsks.length ? Math.min(...rivalAsks) : ask
      ask = Math.max(1, Math.min(ask, rivalMin - 1))
    }
    return {
      ...speakOption.action,
      text: hasRival
        ? `选我的代表，$${ask}M就行，比别家便宜！`
        : `我的代表参与可以，但至少要分我 $${ask}M！`,
      demand: { playerId, amount: ask },
    }
  }

  return pass()
}

function decideReaction(state: GameState, playerId: number, legal: ReturnType<typeof getLegalActions>): GameAction | null {
  const pw = state.pendingReactionWindow
  if (!pw) return legal[0]?.action ?? null
  const neg = state.negotiation
  const gross = getGrossDealValue(state)
  const myShare = neg?.proposedContract?.payout.find(p => p.playerId === playerId)?.amount ?? 0
  const iAmBoss = neg?.bossPlayerId === playerId

  if (pw.card.type === 'TRAVEL') {
    const targetsMine = state.investors.some(
      inv => inv.familyId === pw.targetFamilyId && inv.ownerPlayerId === playerId,
    )
    if (targetsMine || myShare > 0 || iAmBoss) {
      const stop = legal.find(o => o.action.type === 'PLAY_STOP')
      if (stop) return stop.action
    }
  }
  if (pw.card.type === 'BOSS' && (iAmBoss || myShare > 0)) {
    const stop = legal.find(o => o.action.type === 'PLAY_STOP')
    if (stop) return stop.action
  }
  if (pw.card.type === 'RECRUITMENT') {
    const targetsMine = state.investors.some(
      inv => inv.familyId === pw.targetInvestorFamily && inv.ownerPlayerId === playerId,
    )
    if (targetsMine) {
      const stop = legal.find(o => o.action.type === 'PLAY_STOP')
      if (stop) return stop.action
    }
  }
  if (gross >= 10 && myShare > 0) {
    const stop = legal.find(o => o.action.type === 'PLAY_STOP')
    if (stop && Math.random() < 0.4) return stop.action
  }
  return legal.find(o => o.action.type === 'PASS_REACTION')?.action ?? legal[0].action
}

function decideConsent(state: GameState, playerId: number, legal: ReturnType<typeof getLegalActions>): GameAction {
  const neg = state.negotiation!
  const contract = neg.proposedContract
  const myShare = contract?.payout.find(p => p.playerId === playerId)?.amount ?? 0
  const demand = neg.demands.find(d => d.playerId === playerId)
  const minWant = demand?.amount ?? 1
  const persona = state.players.find(p => p.id === playerId)?.personaId
  const agree = () => legal.find(o => o.action.type === 'CONSENT_AGREE')?.action ?? legal[0].action
  const refuse = () => legal.find(o => o.action.type === 'CONSENT_REFUSE')?.action ?? legal[0].action

  if (myShare >= minWant) return agree()
  // Boss已无提案机会：拒绝=整笔交易流局，自己也一分拿不到。
  // 只要有钱进账就接受（哪怕低于要价），一无所得才破罐破摔。
  if (neg.proposalCount >= MAX_PROPOSALS_PER_BOSS) {
    return myShare > 0 ? agree() : refuse()
  }
  if (persona === 'grudge' || persona === 'stingy') return refuse()
  if (myShare >= 1) return agree()
  return refuse()
}

export function getFallbackSpeech(action: GameAction, state: GameState, playerId: number): string {
  const name = state.players.find(p => p.id === playerId)?.name ?? 'AI'
  switch (action.type) {
    case 'CHOOSE_DEAL': return '这笔生意我接了！'
    case 'CHOOSE_ROLL': return '先走走看。'
    case 'PLAY_CLAN': return '我家的人来搭把手，价钱好商量。'
    case 'PLAY_BOSS': return '我才是大老板！'
    case 'PLAY_TRAVEL': return '不好意思，有人要出差了。'
    case 'PLAY_RECRUITMENT': return '来，把这位投资人挖过来！'
    case 'PLAY_STOP': return '想都别想！'
    case 'CONSENT_REFUSE': return '这价钱我不干！'
    case 'CONSENT_AGREE': return '成交，我同意。'
    case 'CLOSE_DEAL': return '就这么定了！'
    case 'FAIL_DEAL': return '这单不做了。'
    case 'PROPOSE_CONTRACT': return '这是我的方案，都看看。'
    case 'SPEAK': return action.text
    default: return `${name}行动了。`
  }
}
