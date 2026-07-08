// ============================================================
// I'm the Boss! — 游戏引擎核心
// ============================================================

import type {
  GameState, GameAction, Player, FamilyId,
  BoardSpace, DealTile, Representative, DealContract,
  LogEntry,
} from './types'
import {
  FAMILIES, FAMILY_IDS, BOARD_SPACES, DEAL_TILES,
  createInfluenceDeck, shuffle, rollDie, AI_ROSTER,
} from './config'

let logCounter = 1000
let speechCounter = 1
let dealRecordCounter = 1

/** 每任 Boss 最多可提出/修改成交方案的次数，超过则只能宣布成交或放弃 */
export const MAX_PROPOSALS_PER_BOSS = 3

function bumpVersion(s: GameState) {
  s.stateVersion++
}

function addLog(state: GameState, text: string, type: LogEntry['type'] = 'action') {
  state.log.push({ id: logCounter++, text, type, timestamp: Date.now() })
  if (state.log.length > 200) state.log = state.log.slice(-200)
}

export function getCurrentDealTile(state: GameState): DealTile | null {
  return state.dealTiles[state.dealTileIndex] || null
}

export function getCurrentBoardSpace(state: GameState): BoardSpace | null {
  return state.board.find(bs => bs.id === state.dollarMarkerPos) || null
}

export function getGrossDealValue(state: GameState): number {
  const tile = getCurrentDealTile(state)
  const space = getCurrentBoardSpace(state)
  if (!tile || !space) return 0
  return tile.shareValue * space.dividends
}

export function getEndGameProbability(tile: DealTile | null): number {
  if (!tile?.endGameFaces?.length) return 0
  if (tile.endGameFaces.length >= 6) return 100
  return Math.round((tile.endGameFaces.length / 6) * 100)
}

function getPlayer(state: GameState, playerId: number): Player | undefined {
  return state.players.find(p => p.id === playerId)
}

function nextPlayerId(state: GameState, fromId: number): number {
  return (fromId + 1) % state.players.length
}

// 找下一个"手里有STOP牌、且本轮反应窗口还没被问过"的玩家。exclude 必须
// 包含 actorId 本人以及所有已经问过（无论有没有STOP牌）的玩家id——否则
// 当场上同时有≥2名STOP持有者时，资格会在他们之间无限传递（A pass→B，
// B pass→因为A手里的STOP牌还在，又传回A），永远无法收敛。
function nextReactorWithStop(state: GameState, fromId: number, exclude: ReadonlySet<number>): number | null {
  const n = state.players.length
  for (let i = 1; i <= n; i++) {
    const pid = (fromId + i) % n
    if (exclude.has(pid)) continue
    const p = getPlayer(state, pid)
    if (p?.hand.some(c => c.type === 'STOP')) return pid
  }
  return null
}

function drawCards(state: GameState, playerId: number, count: number) {
  const player = getPlayer(state, playerId)
  if (!player) return
  for (let i = 0; i < count; i++) {
    if (state.drawPile.length === 0) {
      state.drawPile = shuffle(state.discardPile)
      state.discardPile = []
      addLog(state, '抽牌堆耗尽，弃牌堆洗为新牌堆', 'system')
    }
    const card = state.drawPile.pop()
    if (card) player.hand.push(card)
  }
}

function discardCards(state: GameState, playerId: number, cardIds: number[]) {
  const player = getPlayer(state, playerId)
  if (!player) return
  for (const cid of cardIds) {
    const idx = player.hand.findIndex(c => c.id === cid)
    if (idx >= 0) state.discardPile.push(player.hand.splice(idx, 1)[0])
  }
}

function checkHandLimitAfterReturn(s: GameState, playerId: number) {
  const player = getPlayer(s, playerId)
  if (player && player.hand.length > 12) {
    s.currentPlayerId = playerId
    s.phase = 'HAND_LIMIT_CHECK'
    addLog(s, `${player.name} 手牌超限（${player.hand.length}张），需弃牌或打出招募三连`, 'system')
    return true
  }
  return false
}

function getAvailableRepresentatives(state: GameState): Representative[] {
  if (!state.negotiation) return []
  return state.negotiation.representatives.filter(r => !r.isTravelled)
}

function getNegotiationSpace(state: GameState): BoardSpace | null {
  if (state.negotiation) {
    return state.board.find(bs => bs.id === state.negotiation!.boardSpaceId) ?? null
  }
  return getCurrentBoardSpace(state)
}

/**
 * 玩家是否有"正式要价"的资格：必须有一个未被旅行牌打飞、且家族属于本格
 * 需求（必需或可选池）的在场代表。代表被打飞的玩家失去谈判筹码（除非再
 * 打出家族成员卡重新入场）；从未入场的玩家可以喊话，但要价不生效。
 */
export function canPlayerDemand(state: GameState, playerId: number): boolean {
  const neg = state.negotiation
  if (!neg) return false
  const space = getNegotiationSpace(state)
  if (!space) return false
  const relevant = new Set<FamilyId>([...space.requiredFamilies, ...space.optionalFamilies])
  return neg.representatives.some(
    r => r.ownerPlayerId === playerId && !r.isTravelled && relevant.has(r.familyId),
  )
}

/**
 * 一个代表的"使用成本"，是同家族多代表竞价的核心排序依据：
 * - Boss 自己的代表免费（成本0）；
 * - 其他玩家取其当前要价（对该家族的定向要价优先于通用要价）；
 * - 没喊过价的按交易总额的15%估一个默认心理价——这样"明确开低价的人"
 *   能抢过"闷不吭声的人"，喊高价的会被冷落，竞价才有意义；
 * - 拒绝过出借的玩家加重罚分排到最后（除非没有别的选择）。
 */
export function getRepCost(state: GameState, rep: Representative): number {
  const neg = state.negotiation
  if (!neg) return 0
  if (rep.ownerPlayerId === neg.bossPlayerId) return 0
  const specific = neg.demands.find(d => d.playerId === rep.ownerPlayerId && d.familyId === rep.familyId)
  const general = neg.demands.find(d => d.playerId === rep.ownerPlayerId && d.familyId == null)
  const gross = getGrossDealValue(state)
  let cost = (specific ?? general)?.amount ?? Math.max(1, Math.floor(gross * 0.15))
  if (neg.refusedOwners.includes(rep.ownerPlayerId)) cost += 1000
  return cost
}

export function buildSelectedRepresentatives(
  state: GameState,
  reps?: Representative[],
): Representative[] {
  const space = getNegotiationSpace(state)
  if (!space) return []
  const available = (reps ?? getAvailableRepresentatives(state)).map(r => ({ ...r }))

  // 同家族多代表 → 竞价：成本低者优先；成本相同优先投资者牌
  //（家族成员卡被选用后要弃掉，是消耗品，同价时保牌）。
  const byCost = (a: Representative, b: Representative) =>
    getRepCost(state, a) - getRepCost(state, b) ||
    (a.sourceType === b.sourceType ? 0 : a.sourceType === 'INVESTOR' ? -1 : 1)

  const cheapest = (f: FamilyId): Representative | undefined =>
    available.filter(r => r.familyId === f).sort(byCost)[0]

  const selected: Representative[] = []
  const used = new Set<FamilyId>()

  for (const f of space.requiredFamilies) {
    if (used.has(f)) continue
    const rep = cheapest(f)
    if (rep) {
      selected.push({ ...rep })
      used.add(f)
    }
  }

  // 可选池同样按成本从低到高挑满 optionalNeed 个家族
  const optionalRanked = space.optionalFamilies
    .filter(f => !used.has(f))
    .map(f => ({ f, rep: cheapest(f) }))
    .filter((x): x is { f: FamilyId; rep: Representative } => !!x.rep)
    .sort((a, b) => getRepCost(state, a.rep) - getRepCost(state, b.rep))
  for (const { f, rep } of optionalRanked.slice(0, space.optionalNeed)) {
    selected.push({ ...rep })
    used.add(f)
  }
  return selected
}

export function isDealRequirementMet(state: GameState, reps?: Representative[]): boolean {
  if (!state.negotiation) return false
  const space = state.board.find(bs => bs.id === state.negotiation!.boardSpaceId)
  if (!space) return false
  const selected = buildSelectedRepresentatives(state, reps)
  const families = new Set(selected.map(r => r.familyId))
  for (const f of space.requiredFamilies) {
    if (!families.has(f)) return false
  }
  const optCount = space.optionalFamilies.filter(f => families.has(f)).length
  return optCount >= space.optionalNeed
}

function representativeIsAuthentic(state: GameState, rep: Representative): boolean {
  return getAvailableRepresentatives(state).some(a =>
    a.familyId === rep.familyId &&
    a.sourceType === rep.sourceType &&
    a.ownerPlayerId === rep.ownerPlayerId &&
    (a.sourceType !== 'CLAN' || a.cardId === rep.cardId),
  )
}

/**
 * 深度校验一份成交方案（供 LLM / 外部客户端提交的 PROPOSE_CONTRACT 使用）。
 * 必须满足：代表均为当前谈判中真实在场且未出差的代表；家族需求被覆盖；
 * 分成对象合法、金额为非负整数且不重复；分成总额不超过交易总金额。
 * 这是防止无效合约进入 consentQueue 导致游戏死锁的关键防线。
 */
export function validateContractShape(state: GameState, contract: DealContract): boolean {
  if (!state.negotiation) return false
  if (contract.bossPlayerId !== state.negotiation.bossPlayerId) return false
  if (!Array.isArray(contract.selectedRepresentatives) || !Array.isArray(contract.payout)) return false
  if (!contract.selectedRepresentatives.every(rep => representativeIsAuthentic(state, rep))) return false
  if (!isDealRequirementMet(state, contract.selectedRepresentatives)) return false

  const validPlayerIds = new Set(state.players.map(p => p.id))
  const seenPayees = new Set<number>()
  let total = 0
  for (const p of contract.payout) {
    if (!validPlayerIds.has(p.playerId)) return false
    if (seenPayees.has(p.playerId)) return false
    seenPayees.add(p.playerId)
    if (!Number.isInteger(p.amount) || p.amount < 0) return false
    total += p.amount
  }
  return total <= getGrossDealValue(state)
}

function addAllOwnedInvestorReps(state: GameState) {
  if (!state.negotiation) return
  for (const inv of state.investors) {
    if (inv.ownerPlayerId === null || inv.isTravelled) continue
    const exists = state.negotiation.representatives.some(
      r => r.familyId === inv.familyId && r.sourceType === 'INVESTOR',
    )
    if (!exists) {
      state.negotiation.representatives.push({
        familyId: inv.familyId,
        sourceType: 'INVESTOR',
        ownerPlayerId: inv.ownerPlayerId,
        isTravelled: false,
      })
    }
  }
}

function keepPriority(state: GameState) {
  if (!state.negotiation) return
  state.negotiation.passCount = 0
  state.negotiation.bossReadyToClose = false
}

/**
 * 代表阵容变动（旅行打飞/招募易主）后，作废引用了失效代表的成交方案。
 * 没有这道钩子时，谈判中打出的旅行/招募只改 neg.representatives，而
 * proposedContract 里存的是提案时刻的代表快照——结算会带着已失效的代表
 * 走完出借确认和付款，等于旅行牌对已提案的交易完全无效。
 */
function voidContractIfStale(s: GameState) {
  const neg = s.negotiation
  if (!neg?.proposedContract) return
  const c = neg.proposedContract
  const stillValid =
    c.selectedRepresentatives.every(rep => representativeIsAuthentic(s, rep)) &&
    isDealRequirementMet(s, c.selectedRepresentatives)
  if (!stillValid) {
    neg.proposedContract = null
    neg.bossReadyToClose = false
    addLog(s, '成交方案因代表变动而作废，Boss需重新提案', 'system')
  }
}

/** 代表离场（被打飞/易主）后，清掉已丧失要价资格玩家的要价 */
function pruneIneligibleDemands(s: GameState) {
  const neg = s.negotiation
  if (!neg || neg.demands.length === 0) return
  const dropped = neg.demands.filter(d => !canPlayerDemand(s, d.playerId))
  if (dropped.length > 0) {
    neg.demands = neg.demands.filter(d => canPlayerDemand(s, d.playerId))
    const names = dropped.map(d => getPlayer(s, d.playerId)?.name).join('、')
    addLog(s, `${names} 的代表已离场，其要价随之失效`, 'system')
  }
}

function logContractDetails(s: GameState, contract: DealContract) {
  const boss = getPlayer(s, contract.bossPlayerId)
  const repsStr = contract.selectedRepresentatives
    .map(r => `${FAMILIES[r.familyId].name}←${getPlayer(s, r.ownerPlayerId)?.name}`)
    .join('、')
  const parts = contract.payout
    .filter(p => p.amount > 0)
    .map(p => `${getPlayer(s, p.playerId)?.name} $${p.amount}M`)
  addLog(s, `${boss?.name} 提案 · 选用代表：${repsStr || '无'}`, 'action')
  addLog(
    s,
    `分成：${parts.length ? parts.join('、') : '无分成'}（Boss净得约$${getGrossDealValue(s) - contract.payout.reduce((a, p) => a + p.amount, 0)}M）`,
    'action',
  )
}

function startConsentCheck(s: GameState) {
  const neg = s.negotiation
  if (!neg?.proposedContract) return

  const bossId = neg.bossPlayerId
  const owners = new Set<number>()
  for (const rep of neg.proposedContract.selectedRepresentatives) {
    if (rep.ownerPlayerId !== bossId) owners.add(rep.ownerPlayerId)
  }
  neg.consentQueue = [...owners]
  neg.consentIndex = 0
  // 注意：refusedOwners 不在这里清空——它记录整场谈判中拒绝过出借的人，
  // 供竞价排序降权与 AI 决策参考；仅在 Boss 易主时重置。

  if (neg.consentQueue.length === 0) {
    closeDeal(s)
    return
  }

  s.phase = 'CONSENT_CHECK'
  const first = getPlayer(s, neg.consentQueue[0])
  addLog(s, `进入出借确认：等待 ${first?.name} 等 ${neg.consentQueue.length} 人确认`, 'system')
}

function settleNegotiation(state: GameState) {
  const neg = state.negotiation
  if (!neg) return
  if (!neg.bossReadyToClose || !isDealRequirementMet(state)) {
    failDeal(state, '谈判陷入僵局')
    return
  }
  // 结算瞬间的最后防线：方案里的代表若在倒计时期间失效（正常情况下
  // voidContractIfStale 已作废方案，此处兜底），用当前在场代表自动修正，
  // 保证进入出借确认/付款的方案永远引用真实有效的代表。
  if (neg.proposedContract && !validateContractShape(state, neg.proposedContract)) {
    neg.proposedContract = {
      bossPlayerId: neg.bossPlayerId,
      selectedRepresentatives: buildSelectedRepresentatives(state),
      payout: neg.proposedContract.payout,
    }
    addLog(state, '方案中的代表已变动，按当前在场代表自动修正', 'system')
  }
  startConsentCheck(state)
}

function beginReactionWindow(
  s: GameState,
  card: import('./types').InfluenceCard,
  playerId: number,
  target: string,
  extra: Partial<NonNullable<GameState['pendingReactionWindow']>> = {},
) {
  s.phase = 'REACTION_WINDOW'
  const firstReactor = nextReactorWithStop(s, playerId, new Set([playerId]))
  if (firstReactor === null) {
    s.pendingReactionWindow = {
      card, playerId, target, reactorId: -1, askedPlayerIds: [playerId],
      ...extra,
    }
    resolveReaction(s)
    return
  }
  s.pendingReactionWindow = {
    card, playerId, target, reactorId: firstReactor, askedPlayerIds: [playerId],
    ...extra,
  }
}

export function createInitialState(playerCount: number, humanName: string): GameState {
  const players: Player[] = []
  const roster = shuffle([...AI_ROSTER])

  players.push({
    id: 0, name: humanName || '你', isAI: false, seatIndex: 0,
    cash: 0, hand: [], isCurrentBoss: false,
  })
  for (let i = 1; i < playerCount; i++) {
    const entry = roster[(i - 1) % roster.length]
    players.push({
      id: i, name: entry.name, isAI: true, seatIndex: i,
      cash: 0, hand: [], isCurrentBoss: false,
      personaId: entry.personaId,
    })
  }

  const allInvestors = shuffle(FAMILY_IDS.map(fid => ({ familyId: fid, ownerPlayerId: null as number | null })))
  if (playerCount === 3) {
    allInvestors[0].ownerPlayerId = 0; allInvestors[1].ownerPlayerId = 0
    allInvestors[2].ownerPlayerId = 1; allInvestors[3].ownerPlayerId = 1
    allInvestors[4].ownerPlayerId = 2; allInvestors[5].ownerPlayerId = 2
  } else if (playerCount === 4 || playerCount === 5) {
    for (let i = 0; i < playerCount; i++) allInvestors[i].ownerPlayerId = i
  } else {
    for (let i = 0; i < 6; i++) allInvestors[i].ownerPlayerId = i
  }

  const investors = allInvestors.map(inv => ({
    familyId: inv.familyId,
    ownerPlayerId: inv.ownerPlayerId,
    isTravelled: false,
  }))

  const board: BoardSpace[] = BOARD_SPACES.map(bs => ({ ...bs, isClosed: false, placedDealTileId: null }))
  const dealTiles: DealTile[] = DEAL_TILES.map(dt => ({ ...dt }))
  const drawPile = shuffle(createInfluenceDeck())

  for (let i = 0; i < playerCount; i++) {
    for (let j = 0; j < 5; j++) {
      const card = drawPile.pop()
      if (card) players[i].hand.push(card)
    }
  }

  let startPlayerId = 0
  for (const fid of FAMILY_IDS) {
    const inv = investors.find(i => i.familyId === fid && i.ownerPlayerId !== null)
    if (inv?.ownerPlayerId != null) { startPlayerId = inv.ownerPlayerId; break }
  }

  const markerChooserId = nextPlayerId({ players } as GameState, startPlayerId)

  const state: GameState = {
    phase: 'CHOOSE_MARKER_POSITION',
    players,
    investors,
    board,
    dealTiles,
    dealTileIndex: 0,
    drawPile,
    discardPile: [],
    dollarMarkerPos: 1,
    currentPlayerId: startPlayerId,
    markerChooserId,
    completedDeals: 0,
    negotiation: null,
    dealHistory: [],
    log: [{
      id: 0,
      text: `游戏开始！${playerCount}人局。${players[markerChooserId].name} 请选择金钱标记起始位置`,
      type: 'system',
      timestamp: Date.now(),
    }],
    dieResult: null,
    endGameTriggered: false,
    winnerId: null,
    winnerIds: [],
    pendingReactionWindow: null,
    thinkingPlayerId: null,
    stateVersion: 1,
    playerCount,
  }
  return state
}

/** 兼容旧存档 / 缺字段的存档 */
export function normalizeGameState(raw: GameState): GameState {
  const s = structuredClone(raw)
  s.stateVersion = (s.stateVersion ?? 0) + 1
  s.winnerIds = s.winnerIds ?? (s.winnerId != null ? [s.winnerId] : [])
  s.thinkingPlayerId = null
  s.playerCount = s.playerCount ?? s.players.length
  s.dealHistory = s.dealHistory ?? []
  if (s.pendingReactionWindow && !Array.isArray((s.pendingReactionWindow as unknown as Record<string, unknown>).askedPlayerIds)) {
    // 旧档字段名是 reactionPasses/reactorsWithoutStop（从未真正生效的半成品），
    // 迁移时只需保证发起者不会被问到，当前reactor仍会在其pass时正常入队。
    s.pendingReactionWindow.askedPlayerIds = [s.pendingReactionWindow.playerId]
  }
  if (s.negotiation) {
    s.negotiation.speeches = s.negotiation.speeches ?? []
    s.negotiation.demands = s.negotiation.demands ?? []
    s.negotiation.speakCounts = s.negotiation.speakCounts ?? {}
    s.negotiation.consentQueue = s.negotiation.consentQueue ?? []
    s.negotiation.consentIndex = s.negotiation.consentIndex ?? 0
    s.negotiation.refusedOwners = s.negotiation.refusedOwners ?? []
    s.negotiation.proposalCount = s.negotiation.proposalCount ?? (s.negotiation.proposedContract ? 1 : 0)
  }
  for (const p of s.players) {
    if (p.isAI && !p.personaId) {
      // 优先按名字反查绑定表（见 config.ts AI_ROSTER），保证旧存档补全的
      // 人格与显示名一致；查不到（自定义名字等极端情况）才退回按座位号取模。
      const matched = AI_ROSTER.find(r => r.name === p.name)
      p.personaId = matched?.personaId ?? AI_ROSTER[p.id % AI_ROSTER.length].personaId
    }
  }
  return s
}

export function gameReducer(state: GameState | null, action: GameAction): GameState | null {
  if (action.type === 'START_GAME') {
    return createInitialState(action.playerCount, action.humanPlayerName)
  }

  if (action.type === 'LOAD_GAME') {
    return normalizeGameState(action.state)
  }

  if (!state) return state

  if (action.type === 'SET_AI_THINKING') {
    if (state.thinkingPlayerId === action.playerId) return state
    const s = structuredClone(state)
    s.thinkingPlayerId = action.playerId
    return s
  }

  if (action.type === 'ADD_SPEECH_BUBBLE') {
    const s = structuredClone(state)
    const text = action.text.trim().slice(0, 120)
    if (!text) return state
    const player = getPlayer(s, action.playerId)
    if (s.negotiation) {
      s.negotiation.speeches.push({
        id: speechCounter++,
        playerId: action.playerId,
        text,
        timestamp: Date.now(),
      })
    }
    addLog(s, `${player?.name}：「${text}」`, 'speech')
    bumpVersion(s)
    return s
  }

  const s: GameState = structuredClone(state)
  bumpVersion(s)

  switch (action.type) {
    case 'CHOOSE_MARKER_POSITION': {
      if (s.phase !== 'CHOOSE_MARKER_POSITION') return state
      const space = s.board.find(bs => bs.id === action.spaceId)
      if (!space || space.isClosed) return state
      s.dollarMarkerPos = action.spaceId
      const chooser = s.markerChooserId != null ? getPlayer(s, s.markerChooserId) : null
      addLog(s, `${chooser?.name ?? '玩家'} 将金钱标记放在格子 #${action.spaceId}`, 'action')
      s.currentPlayerId = s.currentPlayerId
      s.markerChooserId = null
      s.phase = 'TURN_START'
      return s
    }

    case 'CHOOSE_DEAL': {
      if (s.phase !== 'TURN_START' && s.phase !== 'POST_MOVE_CHOICE') return state
      const player = getPlayer(s, s.currentPlayerId)
      const space = getCurrentBoardSpace(s)
      if (!player || !space || space.isClosed) return state

      s.phase = 'NEGOTIATION'
      s.negotiation = {
        boardSpaceId: space.id,
        bossPlayerId: s.currentPlayerId,
        representatives: [],
        playedCards: [],
        proposedContract: null,
        proposalCount: 0,
        turnPlayerId: s.currentPlayerId,
        passCount: 0,
        bossReadyToClose: false,
        speeches: [],
        demands: [],
        speakCounts: {},
        consentQueue: [],
        consentIndex: 0,
        refusedOwners: [],
      }
      for (const p of s.players) p.isCurrentBoss = false
      player.isCurrentBoss = true
      addAllOwnedInvestorReps(s)
      addLog(s, `${player.name} 在格子#${space.id}发起交易（$${getGrossDealValue(s)}M），成为Boss`, 'action')
      return s
    }

    case 'CHOOSE_ROLL': {
      if (s.phase !== 'TURN_START') return state
      const player = getPlayer(s, s.currentPlayerId)
      if (!player) return state
      const die = rollDie()
      s.dieResult = die
      addLog(s, `${player.name} 掷骰：${die}点`, 'action')
      let moved = 0
      let pos = s.dollarMarkerPos
      let guard = 0
      while (moved < die && guard < 200) {
        pos = pos % 16 + 1
        const sp = s.board.find(bs => bs.id === pos)
        if (sp && !sp.isClosed) moved++
        guard++
        if (s.board.every(bs => bs.isClosed)) break
      }
      s.dollarMarkerPos = pos
      s.phase = 'POST_MOVE_CHOICE'
      return s
    }

    case 'CHOOSE_DRAW': {
      if (s.phase !== 'POST_MOVE_CHOICE') return state
      const player = getPlayer(s, s.currentPlayerId)
      if (!player) return state
      drawCards(s, s.currentPlayerId, 3)
      addLog(s, `${player.name} 抽了3张牌`, 'action')
      s.dieResult = null
      if (player.hand.length > 12) {
        s.phase = 'HAND_LIMIT_CHECK'
        addLog(s, `${player.name} 手牌超限，需弃牌或打出招募三连`, 'system')
      } else {
        s.currentPlayerId = nextPlayerId(s, s.currentPlayerId)
        s.phase = 'TURN_START'
      }
      return s
    }

    case 'DISCARD_CARDS': {
      if (s.phase !== 'HAND_LIMIT_CHECK') return state
      const player = getPlayer(s, s.currentPlayerId)
      if (!player) return state
      discardCards(s, s.currentPlayerId, action.cardIds)
      addLog(s, `${player.name} 弃了${action.cardIds.length}张牌`, 'action')
      if (player.hand.length > 12) return state
      s.currentPlayerId = nextPlayerId(s, s.currentPlayerId)
      s.phase = 'TURN_START'
      return s
    }

    case 'PLAY_CLAN': {
      if (s.phase !== 'NEGOTIATION' || !s.negotiation) return state
      if (action.playerId !== s.negotiation.turnPlayerId) return state
      const player = getPlayer(s, action.playerId)
      if (!player) return state
      const cardIdx = player.hand.findIndex(c => c.id === action.cardId)
      if (cardIdx < 0) return state
      const card = player.hand[cardIdx]
      if (card.type !== 'CLAN' || card.familyId !== action.familyId) return state
      player.hand.splice(cardIdx, 1)
      s.negotiation.representatives.push({
        familyId: action.familyId,
        sourceType: 'CLAN',
        ownerPlayerId: action.playerId,
        cardId: card.id,
        isTravelled: false,
      })
      s.negotiation.playedCards.push({ card, playerId: action.playerId, isCancelled: false })
      keepPriority(s)
      addLog(s, `${player.name} 打出家族成员：${FAMILIES[action.familyId].name}`, 'card')
      return s
    }

    case 'PLAY_TRAVEL': {
      if (s.phase !== 'NEGOTIATION' || !s.negotiation) return state
      if (action.playerId !== s.negotiation.turnPlayerId) return state
      const player = getPlayer(s, action.playerId)
      if (!player) return state
      const cardIdx = player.hand.findIndex(c => c.id === action.cardId)
      if (cardIdx < 0) return state
      const card = player.hand[cardIdx]
      if (card.type !== 'TRAVEL') return state
      if (card.familyId && card.familyId !== action.targetFamilyId) return state
      beginReactionWindow(s, card, action.playerId,
        `${FAMILIES[action.targetFamilyId].name}的${action.targetCardId ? '家族成员' : '投资者'}`,
        { targetFamilyId: action.targetFamilyId, targetCardId: action.targetCardId },
      )
      addLog(s, `${player.name} 打出旅行牌 → ${FAMILIES[action.targetFamilyId].name}`, 'card')
      return s
    }

    case 'PLAY_RECRUITMENT': {
      if (s.phase !== 'NEGOTIATION' && s.phase !== 'HAND_LIMIT_CHECK') return state
      const player = getPlayer(s, action.playerId)
      if (!player) return state
      if (s.phase === 'NEGOTIATION' && (!s.negotiation || action.playerId !== s.negotiation.turnPlayerId)) return state
      const cards = action.cardIds.map(cid => player.hand.find(c => c.id === cid))
      if (cards.length !== 3 || cards.some(c => !c || c.type !== 'RECRUITMENT')) return state
      const targetInv = s.investors.find(inv => inv.familyId === action.targetFamilyId)
      if (!targetInv) return state
      const hasNeutralPool = s.investors.some(inv => inv.ownerPlayerId === null)
      if (hasNeutralPool && targetInv.ownerPlayerId !== null) {
        addLog(s, '必须先招募公共区的投资者', 'system')
        return state
      }
      if (targetInv.ownerPlayerId === action.playerId) return state

      beginReactionWindow(s, cards[0]!, action.playerId,
        `投资者${FAMILIES[action.targetFamilyId].name}`,
        { targetInvestorFamily: action.targetFamilyId, cardIds: action.cardIds },
      )
      addLog(s, `${player.name} 打出招募三连 → ${FAMILIES[action.targetFamilyId].name}`, 'card')
      return s
    }

    case 'PLAY_BOSS': {
      if (s.phase !== 'NEGOTIATION' || !s.negotiation) return state
      if (action.playerId !== s.negotiation.turnPlayerId) return state
      const player = getPlayer(s, action.playerId)
      if (!player || action.playerId === s.negotiation.bossPlayerId) return state
      const bossCard = player.hand.find(c => c.type === 'BOSS')
      if (!bossCard) return state
      beginReactionWindow(s, bossCard, action.playerId, 'Boss身份')
      addLog(s, `${player.name} 打出老板牌夺权！`, 'card')
      return s
    }

    case 'PLAY_STOP': {
      if (s.phase !== 'REACTION_WINDOW' || !s.pendingReactionWindow) return state
      const pw = s.pendingReactionWindow
      if (action.playerId !== pw.reactorId) return state
      if (action.playerId === pw.playerId) return state
      const player = getPlayer(s, action.playerId)
      if (!player) return state
      const stopIdx = player.hand.findIndex(c => c.type === 'STOP')
      if (stopIdx < 0) return state
      const stopCard = player.hand.splice(stopIdx, 1)[0]
      s.discardPile.push(stopCard)
      addLog(s, `${player.name} 阻止了${pw.target}`, 'card')
      const actor = getPlayer(s, pw.playerId)
      if (actor) {
        const idx = actor.hand.findIndex(c => c.id === pw.card.id)
        if (idx >= 0) s.discardPile.push(actor.hand.splice(idx, 1)[0])
        if (pw.cardIds) {
          for (const cid of pw.cardIds) {
            if (cid === pw.card.id) continue
            const cidx = actor.hand.findIndex(c => c.id === cid)
            if (cidx >= 0) s.discardPile.push(actor.hand.splice(cidx, 1)[0])
          }
        }
      }
      s.negotiation?.playedCards.push({ card: pw.card, playerId: pw.playerId, isCancelled: true })
      s.pendingReactionWindow = null
      if (s.negotiation) {
        s.phase = 'NEGOTIATION'
        s.negotiation.turnPlayerId = pw.playerId
        keepPriority(s)
      } else {
        // 之前这里无条件写 `s.phase = 'HAND_LIMIT_CHECK'`：当招募三连是从
        // HAND_LIMIT_CHECK 阶段发起、又被这张阻止牌取消时，上面已经把
        // actor手里那3张招募牌弃掉了（pw.cardIds），手牌数很可能已经回落到
        // 12张以内——但代码仍然无条件把玩家钉在 HAND_LIMIT_CHECK，导致该
        // 阶段没有任何合法动作（不超限不能弃牌，也没有牌可以再打招募三连），
        // getLegalActions 返回空列表，AI 管线永久卡死。这里改为与
        // resolveReaction 末尾一致的判断：按弃牌后的真实手牌数决定去向。
        if (actor && actor.hand.length > 12) {
          s.currentPlayerId = pw.playerId
          s.phase = 'HAND_LIMIT_CHECK'
        } else {
          s.currentPlayerId = nextPlayerId(s, pw.playerId)
          s.phase = 'TURN_START'
        }
      }
      return s
    }

    case 'PASS_REACTION': {
      if (s.phase !== 'REACTION_WINDOW' || !s.pendingReactionWindow) return state
      const pw = s.pendingReactionWindow
      if (action.playerId !== pw.reactorId) return state
      pw.askedPlayerIds.push(action.playerId)
      const next = nextReactorWithStop(s, pw.reactorId, new Set(pw.askedPlayerIds))
      if (next === null) {
        resolveReaction(s)
      } else {
        pw.reactorId = next
      }
      return s
    }

    case 'SPEAK': {
      if (s.phase !== 'NEGOTIATION' || !s.negotiation) return state
      if (action.playerId !== s.negotiation.turnPlayerId) return state
      const count = s.negotiation.speakCounts[action.playerId] ?? 0
      if (count >= 3) return state
      const player = getPlayer(s, action.playerId)
      if (!player) return state
      // 统一发言长度上限为 120（与 llmAgent.ts 的 SPEECH_MAX_LEN 对齐），
      // 避免引擎和 AI 侧各用一套长度限制、UI 气泡显示不一致。
      const text = action.text.trim().slice(0, 120)
      if (!text) return state
      s.negotiation.speeches.push({
        id: speechCounter++,
        playerId: action.playerId,
        text,
        timestamp: Date.now(),
      })
      s.negotiation.speakCounts[action.playerId] = count + 1
      if (action.demand) {
        // 要价资格门槛：没有相关家族的有效代表在场（从未入场，或代表已被
        // 旅行牌打飞）的玩家，要价不生效——只有台词，没有谈判筹码。
        if (canPlayerDemand(s, action.playerId)) {
          s.negotiation.demands = s.negotiation.demands.filter(d => d.playerId !== action.playerId)
          s.negotiation.demands.push({ ...action.demand, playerId: action.playerId })
        } else {
          addLog(s, `${player.name} 没有有效代表在场，要价无效（喊话仍展示）`, 'system')
        }
      }
      addLog(s, `${player.name}：「${text}」`, 'speech')
      keepPriority(s)
      return s
    }

    case 'PROPOSE_CONTRACT': {
      if (s.phase !== 'NEGOTIATION' || !s.negotiation) return state
      if (s.negotiation.turnPlayerId !== s.negotiation.bossPlayerId) return state
      // 每任 Boss 最多提出/修改 MAX_PROPOSALS_PER_BOSS 次方案。没有这个上限时，
      // LLM Boss 有时会反复微调方案（每次几块钱的差异）拖慢整个谈判节奏，
      // 人类玩家也可能被恶意/失误的无限重提卡住。达到上限后只能 CLOSE_DEAL
      // 或 FAIL_DEAL，不能再修改。
      if (s.negotiation.proposalCount >= MAX_PROPOSALS_PER_BOSS) {
        addLog(s, `已达到本任Boss最多${MAX_PROPOSALS_PER_BOSS}次提案上限，不能再修改方案`, 'system')
        return state
      }
      if (!validateContractShape(state, action.contract)) return state
      s.negotiation.proposedContract = action.contract
      s.negotiation.proposalCount++
      keepPriority(s)
      logContractDetails(s, action.contract)
      return s
    }

    case 'CLOSE_DEAL': {
      if (s.phase !== 'NEGOTIATION' || !s.negotiation) return state
      const neg = s.negotiation
      if (neg.turnPlayerId !== neg.bossPlayerId) return state
      if (!isDealRequirementMet(s)) {
        addLog(s, '交易条件不满足', 'system')
        return state
      }
      if (!neg.proposedContract) {
        neg.proposedContract = {
          bossPlayerId: neg.bossPlayerId,
          selectedRepresentatives: buildSelectedRepresentatives(s),
          payout: [],
        }
        // 自动生成的"无分成"方案也计入提案次数。否则 Boss 可以绕过提案
        // 上限无限循环"宣布成交→被拒绝→再宣布成交"，谈判永远不收敛。
        // 钳制在上限：达到上限后的自动方案是"最后通牒"，被拒即流局
        //（见 CONSENT_REFUSE 的耗尽判定），计数无需继续增长。
        neg.proposalCount = Math.min(neg.proposalCount + 1, MAX_PROPOSALS_PER_BOSS)
        addLog(s, `${getPlayer(s, neg.bossPlayerId)?.name} 未提分成方案，按默认方案（无分成）宣布成交`, 'system')
      }
      neg.bossReadyToClose = true
      neg.passCount = 1
      if (neg.passCount >= s.players.length) {
        settleNegotiation(s)
      } else {
        neg.turnPlayerId = nextPlayerId(s, neg.bossPlayerId)
        addLog(s, `${getPlayer(s, neg.bossPlayerId)?.name} 宣布准备成交，其他玩家可最后出牌或跳过`, 'action')
      }
      return s
    }

    case 'CONSENT_AGREE':
    case 'CONSENT_REFUSE': {
      if (s.phase !== 'CONSENT_CHECK' || !s.negotiation) return state
      const neg = s.negotiation
      const currentOwner = neg.consentQueue[neg.consentIndex]
      if (action.playerId !== currentOwner) return state
      const player = getPlayer(s, action.playerId)
      if (!player) return state

      if (action.type === 'CONSENT_REFUSE') {
        // 拒绝出借 = 否决当前方案，逼 Boss 加价或改选竞价对手的代表。
        // 代表本身留在谈判桌上（规则§35.7：家族成员牌打出后不可收回；
        // 投资者代表同理不离场），这样"拒绝→重新要价→Boss重新提案"的
        // 博弈闭环才能成立。refusedOwners 会在竞价排序中给该玩家降权。
        if (!neg.refusedOwners.includes(action.playerId)) {
          neg.refusedOwners.push(action.playerId)
        }

        // 提案次数已耗尽时，Boss 没有任何手段再修改方案去满足这次拒绝——
        // 若仍打回 NEGOTIATION，CLOSE_DEAL 只会重新生成同一份（甚至更差的）
        // 空分成合约，被同一个人再次拒绝，形成 NEGOTIATION<->CONSENT_CHECK
        // 之间的永久死循环（仿真发现：5人局20000步不收敛）。这种情况直接判流局。
        if (neg.proposalCount >= MAX_PROPOSALS_PER_BOSS) {
          failDeal(s, `${player.name} 拒绝出借，且Boss已无修改方案的机会`)
          return s
        }

        addLog(s, `${player.name} 拒绝出借代表，方案作废，回到谈判（Boss剩${MAX_PROPOSALS_PER_BOSS - neg.proposalCount}次提案机会）`, 'fail')
        neg.proposedContract = null
        neg.bossReadyToClose = false
        neg.consentQueue = []
        neg.consentIndex = 0
        neg.turnPlayerId = neg.bossPlayerId
        neg.passCount = 0
        s.phase = 'NEGOTIATION'
        return s
      }

      addLog(s, `${player.name} 同意出借`, 'action')
      neg.consentIndex++
      if (neg.consentIndex >= neg.consentQueue.length) {
        closeDeal(s)
      } else {
        const next = getPlayer(s, neg.consentQueue[neg.consentIndex])
        addLog(s, `等待 ${next?.name} 确认出借…`, 'system')
      }
      return s
    }

    case 'FAIL_DEAL': {
      if (s.phase !== 'NEGOTIATION' || !s.negotiation) return state
      failDeal(s, '主动放弃')
      return s
    }

    case 'PASS_NEGOTIATION': {
      if (s.phase !== 'NEGOTIATION' || !s.negotiation) return state
      const neg = s.negotiation
      if (action.playerId !== neg.turnPlayerId) return state
      neg.passCount++
      if (neg.passCount >= s.players.length) {
        settleNegotiation(s)
      } else {
        neg.turnPlayerId = nextPlayerId(s, action.playerId)
      }
      return s
    }

    case 'ROLL_DIE': {
      if (s.phase !== 'END_GAME_ROLL') return state
      const die = rollDie()
      s.dieResult = die
      const usedTile = s.dealTiles[s.dealTileIndex - 1]
      addLog(s, `终局掷骰：${die}点`, 'end')
      if (usedTile?.endGameFaces?.includes(die) || usedTile?.endGameFaces?.length === 6) {
        s.phase = 'GAME_OVER'
        s.endGameTriggered = true
        determineWinner(s)
      } else {
        addLog(s, '未命中终局骰面，游戏继续', 'end')
        s.currentPlayerId = nextPlayerId(s, s.currentPlayerId)
        s.phase = 'TURN_START'
      }
      return s
    }

    default:
      return state
  }
}

function resolveReaction(s: GameState) {
  const pw = s.pendingReactionWindow
  if (!pw) return

  const inNegotiation = !!s.negotiation
  const actor = getPlayer(s, pw.playerId)

  if (!actor) {
    s.pendingReactionWindow = null
    s.phase = inNegotiation ? 'NEGOTIATION' : 'HAND_LIMIT_CHECK'
    return
  }

  if (pw.card.type === 'TRAVEL' && s.negotiation) {
    const cIdx = actor.hand.findIndex(c => c.id === pw.card.id)
    if (cIdx >= 0) actor.hand.splice(cIdx, 1)
    const fid = pw.targetFamilyId
    if (fid) {
      if (pw.targetCardId) {
        const rep = s.negotiation.representatives.find(r => r.cardId === pw.targetCardId)
        if (rep) {
          rep.isTravelled = true
          s.discardPile.push({ id: rep.cardId!, type: 'CLAN', familyId: rep.familyId })
        }
        addLog(s, `${FAMILIES[fid].name}家族成员被旅行牌打飞`, 'card')
      } else {
        const inv = s.investors.find(i => i.familyId === fid)
        if (inv) inv.isTravelled = true
        for (const rep of s.negotiation.representatives) {
          if (rep.familyId === fid && rep.sourceType === 'INVESTOR') rep.isTravelled = true
        }
        addLog(s, `${FAMILIES[fid].name}投资者出差`, 'card')
      }
    }
    s.discardPile.push(pw.card)
    s.negotiation.playedCards.push({ card: pw.card, playerId: pw.playerId, isCancelled: false })
  } else if (pw.card.type === 'BOSS' && s.negotiation) {
    const oldBoss = getPlayer(s, s.negotiation.bossPlayerId)
    if (oldBoss) oldBoss.isCurrentBoss = false
    const cIdx = actor.hand.findIndex(c => c.id === pw.card.id)
    if (cIdx >= 0) s.discardPile.push(actor.hand.splice(cIdx, 1)[0])
    s.negotiation.bossPlayerId = pw.playerId
    actor.isCurrentBoss = true
    s.negotiation.proposedContract = null
    s.negotiation.proposalCount = 0
    // 换了新Boss等于换了谈判对象，旧Boss任内的拒绝记录不再适用
    s.negotiation.refusedOwners = []
    addAllOwnedInvestorReps(s)
    s.negotiation.playedCards.push({ card: pw.card, playerId: pw.playerId, isCancelled: false })
    addLog(s, `${actor.name} 夺权成功！`, 'card')
  } else if (pw.card.type === 'RECRUITMENT') {
    const fid = pw.targetInvestorFamily
    if (fid) {
      const inv = s.investors.find(i => i.familyId === fid)
      if (inv) {
        const oldOwner = inv.ownerPlayerId
        inv.ownerPlayerId = pw.playerId
        addLog(s, `${actor.name} 招募${FAMILIES[fid].name}` +
          (oldOwner != null ? `（从${getPlayer(s, oldOwner)?.name}）` : '（公共区）'), 'card')
        if (s.negotiation) {
          const existing = s.negotiation.representatives.find(r => r.familyId === fid && r.sourceType === 'INVESTOR')
          if (existing) existing.ownerPlayerId = pw.playerId
          else if (!inv.isTravelled) {
            s.negotiation.representatives.push({
              familyId: fid, sourceType: 'INVESTOR', ownerPlayerId: pw.playerId, isTravelled: false,
            })
          }
          s.negotiation.playedCards.push({ card: pw.card, playerId: pw.playerId, isCancelled: false })
        }
      }
      if (pw.cardIds) {
        for (const cid of pw.cardIds) {
          const idx = actor.hand.findIndex(c => c.id === cid)
          if (idx >= 0) s.discardPile.push(actor.hand.splice(idx, 1)[0])
        }
      }
    }
  }

  // 旅行/招募改变了代表阵容：失去谈判资格的要价随之失效，
  // 引用了失效代表的成交方案自动作废。
  if (s.negotiation && (pw.card.type === 'TRAVEL' || pw.card.type === 'RECRUITMENT')) {
    pruneIneligibleDemands(s)
    voidContractIfStale(s)
  }

  s.pendingReactionWindow = null
  if (s.negotiation) {
    s.phase = 'NEGOTIATION'
    s.negotiation.turnPlayerId = pw.playerId
    keepPriority(s)
  } else {
    const player = actor
    if (player.hand.length > 12) s.phase = 'HAND_LIMIT_CHECK'
    else {
      s.currentPlayerId = nextPlayerId(s, s.currentPlayerId)
      s.phase = 'TURN_START'
    }
  }
}

/** 本笔谈判中打出过旅行/招募三连/老板牌的玩家（去重，不含Boss自己），用于跨局记忆 */
function computeDisruptors(neg: NonNullable<GameState['negotiation']>): number[] {
  const disruptive = new Set(['TRAVEL', 'RECRUITMENT', 'BOSS'])
  const ids = new Set<number>()
  for (const pc of neg.playedCards) {
    if (disruptive.has(pc.card.type) && pc.playerId !== neg.bossPlayerId) ids.add(pc.playerId)
  }
  return [...ids]
}

function closeDeal(s: GameState) {
  const neg = s.negotiation
  if (!neg) return
  const contract = neg.proposedContract ?? {
    bossPlayerId: neg.bossPlayerId,
    selectedRepresentatives: buildSelectedRepresentatives(s),
    payout: [],
  }
  const gross = getGrossDealValue(s)
  const boss = getPlayer(s, contract.bossPlayerId)
  if (boss) boss.cash += gross

  let distributed = 0
  const finalPayout: Array<{ playerId: number; amount: number }> = []
  for (const payout of contract.payout) {
    if (payout.playerId === contract.bossPlayerId) continue
    const amount = Math.max(0, Math.min(Math.floor(payout.amount), gross - distributed))
    const recipient = getPlayer(s, payout.playerId)
    if (recipient && boss && amount > 0) {
      boss.cash -= amount
      recipient.cash += amount
      distributed += amount
      finalPayout.push({ playerId: payout.playerId, amount })
      addLog(s, `${boss.name} → ${recipient.name} $${amount}M`, 'deal')
    }
  }
  addLog(s, `成交！银行付$${gross}M，${boss?.name}净得$${gross - distributed}M`, 'deal')

  const space = s.board.find(bs => bs.id === neg.boardSpaceId)
  const usedTile = getCurrentDealTile(s)
  if (space) {
    space.isClosed = true
    space.placedDealTileId = usedTile?.id ?? null
  }
  s.dealTileIndex++
  s.completedDeals++

  s.dealHistory.push({
    id: dealRecordCounter++,
    dealNumber: s.completedDeals,
    boardSpaceId: neg.boardSpaceId,
    bossPlayerId: neg.bossPlayerId,
    success: true,
    grossValue: gross,
    payout: finalPayout,
    disruptors: computeDisruptors(neg),
    timestamp: Date.now(),
  })

  cleanupNegotiation(s, true, contract)
  moveMarkerToNextOpen(s)
  const bossId = neg.bossPlayerId
  s.negotiation = null
  for (const p of s.players) p.isCurrentBoss = false
  addLog(s, `第${s.completedDeals}笔交易完成`, 'deal')

  if (s.completedDeals >= 15) {
    s.phase = 'GAME_OVER'
    s.endGameTriggered = true
    determineWinner(s)
  } else if (s.completedDeals >= 10 && usedTile?.endGameFaces?.length) {
    s.phase = 'END_GAME_ROLL'
    s.dieResult = null
    s.currentPlayerId = bossId
    addLog(s, `${getPlayer(s, bossId)?.name} 掷骰判定终局`, 'end')
  } else {
    s.currentPlayerId = nextPlayerId(s, bossId)
    s.phase = 'TURN_START'
  }
}

function failDeal(s: GameState, reason: string) {
  const neg = s.negotiation
  if (!neg) return
  addLog(s, `${getPlayer(s, neg.bossPlayerId)?.name} 交易失败（${reason}）`, 'fail')

  s.dealHistory.push({
    id: dealRecordCounter++,
    dealNumber: s.completedDeals + 1,
    boardSpaceId: neg.boardSpaceId,
    bossPlayerId: neg.bossPlayerId,
    success: false,
    grossValue: getGrossDealValue(s),
    payout: [],
    disruptors: computeDisruptors(neg),
    failReason: reason,
    timestamp: Date.now(),
  })

  cleanupNegotiation(s, false)
  const bossId = neg.bossPlayerId
  s.negotiation = null
  s.pendingReactionWindow = null
  for (const p of s.players) p.isCurrentBoss = false
  s.currentPlayerId = nextPlayerId(s, bossId)
  s.phase = 'TURN_START'
}

function moveMarkerToNextOpen(s: GameState) {
  if (s.board.every(bs => bs.isClosed)) return
  let nextPos = s.dollarMarkerPos
  for (let i = 0; i < 16; i++) {
    nextPos = nextPos % 16 + 1
    const ns = s.board.find(bs => bs.id === nextPos)
    if (ns && !ns.isClosed) break
  }
  s.dollarMarkerPos = nextPos
}

function cleanupNegotiation(s: GameState, success: boolean, contract?: DealContract) {
  if (!s.negotiation) return
  const selected = contract?.selectedRepresentatives ?? s.negotiation.proposedContract?.selectedRepresentatives ?? []

  for (const rep of s.negotiation.representatives) {
    if (rep.sourceType === 'CLAN' && rep.cardId) {
      if (rep.isTravelled) continue
      const inContract = success && selected.some(r => r.cardId === rep.cardId)
      const owner = getPlayer(s, rep.ownerPlayerId)
      if (!owner) continue
      if (success && inContract) {
        s.discardPile.push({ id: rep.cardId, type: 'CLAN', familyId: rep.familyId })
      } else {
        owner.hand.push({ id: rep.cardId, type: 'CLAN', familyId: rep.familyId })
        checkHandLimitAfterReturn(s, rep.ownerPlayerId)
      }
    }
  }
  for (const inv of s.investors) inv.isTravelled = false
  for (const pc of s.negotiation.playedCards) {
    if (pc.isCancelled || pc.card.type === 'CLAN') continue
    if (!s.discardPile.some(c => c.id === pc.card.id)) s.discardPile.push(pc.card)
  }
}

function determineWinner(s: GameState) {
  const maxCash = Math.max(...s.players.map(p => p.cash))
  const leaders = s.players.filter(p => p.cash === maxCash)
  s.winnerIds = leaders.map(p => p.id)
  s.winnerId = leaders[0]?.id ?? null
  if (leaders.length > 1) {
    addLog(s, `游戏结束！${leaders.map(p => p.name).join('、')} 并列 $${maxCash}M 获胜！`, 'end')
  } else {
    addLog(s, `游戏结束！${leaders[0].name} 以 $${maxCash}M 获胜！`, 'end')
  }
}
