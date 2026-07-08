// ============================================================
// I'm the Boss! — 核心类型定义
// ============================================================

export type FamilyId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F'

export interface Family {
  id: FamilyId
  name: string
  color: string
  textColor: string
}

export type CardType = 'CLAN' | 'TRAVEL' | 'RECRUITMENT' | 'BOSS' | 'STOP'

export interface InfluenceCard {
  id: number
  type: CardType
  familyId?: FamilyId
}

export interface InvestorPlacard {
  familyId: FamilyId
  ownerPlayerId: number | null
  isTravelled: boolean
}

export interface DealTile {
  id: number
  shareValue: number
  endGameFaces?: number[]
}

export interface BoardSpace {
  id: number
  requiredFamilies: FamilyId[]
  optionalFamilies: FamilyId[]
  optionalNeed: number
  dividends: number
  isClosed: boolean
  placedDealTileId: number | null
}

export interface Player {
  id: number
  name: string
  isAI: boolean
  seatIndex: number
  cash: number
  hand: InfluenceCard[]
  isCurrentBoss: boolean
  personaId?: string
}

export interface Representative {
  familyId: FamilyId
  sourceType: 'INVESTOR' | 'CLAN'
  ownerPlayerId: number
  cardId?: number
  isTravelled: boolean
  consented?: boolean
}

export interface DealContract {
  bossPlayerId: number
  selectedRepresentatives: Representative[]
  payout: Array<{ playerId: number; amount: number }>
}

export interface NegotiationSpeech {
  id: number
  playerId: number
  text: string
  timestamp: number
}

export interface PriceDemand {
  playerId: number
  amount: number
  familyId?: FamilyId
  note?: string
}

export type GamePhase =
  | 'SETUP'
  | 'CHOOSE_MARKER_POSITION'
  | 'TURN_START'
  | 'POST_MOVE_CHOICE'
  | 'HAND_LIMIT_CHECK'
  | 'NEGOTIATION'
  | 'REACTION_WINDOW'
  | 'CONSENT_CHECK'
  | 'END_GAME_ROLL'
  | 'GAME_OVER'

export interface NegotiationState {
  boardSpaceId: number
  bossPlayerId: number
  representatives: Representative[]
  playedCards: Array<{
    card: InfluenceCard
    playerId: number
    target?: string
    isCancelled: boolean
  }>
  proposedContract: DealContract | null
  /** 当前 Boss 已提出方案的次数，达到上限后不能再修改方案，防止（尤其是LLM）无限重提拖慢节奏 */
  proposalCount: number
  turnPlayerId: number
  passCount: number
  bossReadyToClose: boolean
  speeches: NegotiationSpeech[]
  demands: PriceDemand[]
  speakCounts: Record<number, number>
  consentQueue: number[]
  consentIndex: number
  refusedOwners: number[]
}

export interface GameState {
  phase: GamePhase
  players: Player[]
  investors: InvestorPlacard[]
  board: BoardSpace[]
  dealTiles: DealTile[]
  dealTileIndex: number
  drawPile: InfluenceCard[]
  discardPile: InfluenceCard[]
  dollarMarkerPos: number
  currentPlayerId: number
  markerChooserId: number | null
  completedDeals: number
  negotiation: NegotiationState | null
  dealHistory: DealRecord[]
  log: LogEntry[]
  dieResult: number | null
  endGameTriggered: boolean
  winnerId: number | null
  winnerIds: number[]
  pendingReactionWindow: {
    card: InfluenceCard
    playerId: number
    target?: string
    targetFamilyId?: FamilyId
    targetInvestorFamily?: FamilyId
    targetCardId?: number
    cardIds?: number[]
    reactorId: number
    /** 本轮反应窗口中已经问过（无论有没有STOP牌）的玩家id，防止在多个
     * STOP持有者之间无限传递询问资格而导致死循环。 */
    askedPlayerIds: number[]
  } | null
  thinkingPlayerId: number | null
  stateVersion: number
  playerCount: number
}

export interface LogEntry {
  id: number
  text: string
  type: 'action' | 'card' | 'deal' | 'fail' | 'end' | 'system' | 'speech'
  timestamp: number
}

/**
 * 一笔交易（无论成交或流局）的结算摘要，用于跨局记忆：
 * - 交易历史面板给人类玩家复盘
 * - AI Prompt 注入"最近几笔交易"，让"记仇"等人格有据可依，
 *   而不是像之前那样每次决策都是失忆状态，只能看到当前这一笔谈判的最近几句喊话
 */
export interface DealRecord {
  id: number
  dealNumber: number
  boardSpaceId: number
  bossPlayerId: number
  success: boolean
  grossValue: number
  payout: Array<{ playerId: number; amount: number }>
  /** 本笔交易中打出旅行/招募三连/老板牌试图搅局或夺权的玩家（去重，不含Boss自己） */
  disruptors: number[]
  failReason?: string
  timestamp: number
}

export type GameAction =
  | { type: 'START_GAME'; playerCount: number; humanPlayerName: string }
  | { type: 'LOAD_GAME'; state: GameState }
  | { type: 'CHOOSE_MARKER_POSITION'; spaceId: number }
  | { type: 'CHOOSE_DEAL' }
  | { type: 'CHOOSE_ROLL' }
  | { type: 'CHOOSE_DRAW' }
  | { type: 'PLAY_CLAN'; playerId: number; cardId: number; familyId: FamilyId }
  | { type: 'PLAY_TRAVEL'; playerId: number; cardId: number; targetFamilyId: FamilyId; targetCardId?: number }
  | { type: 'PLAY_RECRUITMENT'; playerId: number; cardIds: number[]; targetFamilyId: FamilyId }
  | { type: 'PLAY_BOSS'; playerId: number }
  | { type: 'PLAY_STOP'; playerId: number }
  | { type: 'PROPOSE_CONTRACT'; contract: DealContract }
  | { type: 'CLOSE_DEAL' }
  | { type: 'FAIL_DEAL' }
  | { type: 'PASS_NEGOTIATION'; playerId: number }
  | { type: 'SPEAK'; playerId: number; text: string; demand?: PriceDemand }
  | { type: 'CONSENT_AGREE'; playerId: number }
  | { type: 'CONSENT_REFUSE'; playerId: number }
  | { type: 'ROLL_DIE' }
  | { type: 'DISCARD_CARDS'; cardIds: number[] }
  | { type: 'PASS_REACTION'; playerId: number }
  | { type: 'SET_AI_THINKING'; playerId: number | null }
  | { type: 'ADD_SPEECH_BUBBLE'; playerId: number; text: string }
