// ============================================================
// I'm the Boss! — 核心类型
//
// 引擎层只有数据与规则，没有任何展示文案：
//   · 发生的事情以 GameEvent 记录（UI / LLM 提示词各自渲染成文字）
//   · 玩家的输入是 PlayerAction（人类点击、AI 决策走同一条通道）
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
  /** CLAN / 定向 TRAVEL 才有；万能旅行牌没有 familyId */
  familyId?: FamilyId
}

/**
 * 交易格的一组需求：从 families 中凑够 need 个不同家族。
 * need === families.length 表示"全部必需"；need < length 表示"N 选 M"的可选池。
 * 同一格内各组的家族互不重叠。
 */
export interface DealGroup {
  families: FamilyId[]
  need: number
}

export interface BoardSpace {
  id: number
  groups: DealGroup[]
  /** 分红份数 = 所需投资者总数 + 1 */
  dividends: number
  /** 成交后盖在格子上的景气牌 id，null 表示未关闭 */
  closedByTileId: number | null
}

export interface DealTile {
  id: number
  shareValue: number
  /** 终局判定骰面；空数组表示成交后不掷骰 */
  endFaces: number[]
}

export interface InvestorPlacard {
  familyId: FamilyId
  /** null = 公共区（4/5 人局多出来的投资者牌） */
  ownerId: number | null
}

export interface Player {
  id: number
  name: string
  isAI: boolean
  cash: number
  hand: InfluenceCard[]
  personaId?: string
  /** 最近一句台词（座位气泡），谈判开始/结束时清空 */
  lastSpeech?: string
  /**
   * 私人笔记：电脑玩家自己写给自己的备忘（谁坑过我、谁欠我、下一步打算），
   * 只回灌到它自己的提示词里，界面与其他玩家都看不到。保留最近若干条。
   */
  notes: string[]
}

export type RepSource = 'INVESTOR' | 'CLAN'

/**
 * 谈判桌上的一个"代表"：投资者牌（长期）或家族成员卡（本局临时）。
 * key 唯一标识：投资者 `INV:A`（易主后 key 不变、ownerId 变），家族卡 `CLAN:<cardId>`。
 */
export interface Representative {
  key: string
  familyId: FamilyId
  source: RepSource
  ownerId: number
  cardId?: number
  /** 被旅行牌命中：本笔交易中失效（投资者本局结束恢复；家族卡已弃置） */
  travelled: boolean
}

/** 事件里引用代表时用的快照（代表可能随后失效/易主） */
export interface RepRef {
  familyId: FamilyId
  ownerId: number
  source: RepSource
}

export interface Payout {
  playerId: number
  amount: number
}

/** Boss 提出的成交方案 */
export interface Offer {
  id: number
  bossId: number
  repKeys: string[]
  payouts: Payout[]
  /** 非 Boss 代表持有者的应答（只记录已表态的） */
  responses: Record<number, 'ACCEPTED' | 'DECLINED'>
}

export interface Speech {
  id: number
  playerId: number
  text: string
}

/**
 * 玩家公开报价（承诺价）：有代表的是"出借价"，没代表的是"不搅局的封口费"。
 * 报价即承诺：Boss 的方案付到这个价，代表持有者视为自动同意，不再另行应答。
 */
export interface Demand {
  playerId: number
  amount: number
  /**
   * 报价针对的家族：同一玩家可对不同家族的代表报不同价（"我的赤岩集团 $3M、黑松控股卡 $1M"）。
   * 省略 = 通用价：没有相关代表时是封口费；有代表但某家族没单独报价时作为该家族的兜底价。
   */
  familyId?: FamilyId
}

export type GamePhase =
  | 'PLACE_MARKER'
  | 'TURN'
  | 'AFTER_MOVE'
  | 'HAND_LIMIT'
  | 'NEGOTIATION'
  | 'OFFER_RESPONSE'
  | 'REACTION'
  | 'CLOSING'
  | 'END_ROLL'
  | 'GAME_OVER'

export interface Negotiation {
  spaceId: number
  bossId: number
  /** 发起交易的原始 Boss（用于历史记录） */
  openerId: number
  reps: Representative[]
  /** 本局被旅行牌盖住的投资者（本局结束恢复） */
  travelledInvestors: FamilyId[]
  offer: Offer | null
  /** 当前 Boss 已提出的方案数（换 Boss 后清零） */
  offersMade: number
  /** NEGOTIATION 阶段轮到谁行动。开局从 Boss 左手边起叫价，Boss 在第一轮末位行动 */
  turnId: number
  /** 连续跳过计数（任何实质行动清零） */
  passStreak: number
  /** 全员连续跳过的完整轮数，达到上限判僵局流局 */
  stalemateRounds: number
  speeches: Speech[]
  demands: Demand[]
  speakCounts: Record<number, number>
  /** OFFER_RESPONSE 阶段：待应答队列 */
  responseQueue: number[]
  responseIndex: number
  /** CLOSING 阶段：最后出牌窗口的询问顺序 */
  closingOrder: number[]
  closingIndex: number
  /** 打出过干扰牌（旅行/招募/老板，含被阻止的）的非 Boss 玩家 */
  disruptors: number[]
}

export type ReactionKind = 'TRAVEL' | 'BOSS' | 'RECRUITMENT'

export interface PendingReaction {
  actorId: number
  kind: ReactionKind
  /** 已从手牌移出的牌（旅行/老板 1 张，招募 3 张） */
  cards: InfluenceCard[]
  /** 旅行牌目标代表 */
  targetRepKey?: string
  /** 招募目标投资者 */
  targetFamilyId?: FamilyId
  /** 当前被询问是否打阻止牌的玩家 */
  reactorId: number
  askedIds: number[]
  /** 反应结束后回到哪个阶段 */
  returnPhase: 'NEGOTIATION' | 'CLOSING' | 'HAND_LIMIT'
}

export type FailReason = 'ABANDONED' | 'STALEMATE'

export interface DealRecord {
  id: number
  dealNumber: number
  spaceId: number
  bossId: number
  openerId: number
  success: boolean
  grossValue: number
  payouts: Payout[]
  disruptors: number[]
  failReason?: FailReason
}

// ---------- 事件 ----------

export type GameEvent =
  | { kind: 'GAME_STARTED'; playerCount: number; startPlayerId: number; markerChooserId: number }
  | { kind: 'MARKER_PLACED'; playerId: number; spaceId: number; nextPlayerId: number }
  | { kind: 'DEAL_OPENED'; playerId: number; spaceId: number; gross: number }
  | { kind: 'MARKER_MOVED'; playerId: number; die: number; spaceId: number; gross: number }
  | { kind: 'CARDS_DRAWN'; playerId: number; count: number; handSize: number }
  | { kind: 'DECK_RESHUFFLED'; size: number }
  | { kind: 'HAND_LIMIT'; playerId: number; handSize: number }
  | { kind: 'CARDS_DISCARDED'; playerId: number; count: number }
  | { kind: 'CLAN_PLAYED'; playerId: number; familyId: FamilyId }
  | { kind: 'TRAVEL_PLAYED'; playerId: number; wildcard: boolean; target: RepRef }
  | { kind: 'RECRUITMENT_PLAYED'; playerId: number; familyId: FamilyId; fromId: number | null }
  | { kind: 'BOSS_PLAYED'; playerId: number; bossId: number }
  | { kind: 'STOP_PLAYED'; playerId: number; actorId: number; cancelled: ReactionKind }
  | { kind: 'TRAVEL_RESOLVED'; target: RepRef }
  | { kind: 'RECRUITMENT_RESOLVED'; playerId: number; familyId: FamilyId; fromId: number | null }
  | { kind: 'BOSS_RESOLVED'; playerId: number; previousBossId: number }
  | { kind: 'OFFER_VOIDED'; reason: 'TRAVELLED' | 'RECRUITED' }
  | { kind: 'SPEECH'; playerId: number; text: string }
  /** familyIds 为空 = 封口费；否则是这些家族代表各自的出借价（每个代表） */
  | { kind: 'DEMAND'; playerId: number; amount: number; familyIds: FamilyId[] }
  | { kind: 'STALEMATE_ROUND'; rounds: number; max: number }
  | { kind: 'OFFER_PROPOSED'; bossId: number; offerNo: number; reps: RepRef[]; payouts: Payout[]; bossKeep: number; waitingFor: number[]; autoAccepted: number[] }
  /** auto：方案付到了其承诺价，按约视为同意 */
  | { kind: 'OFFER_ACCEPTED'; playerId: number; auto?: boolean }
  | { kind: 'OFFER_DECLINED'; playerId: number; counter?: number }
  | { kind: 'OFFER_RESOLVED'; agreed: boolean; declinerIds: number[] }
  | { kind: 'CLOSING_STARTED'; bossId: number }
  | { kind: 'CLOSING_INTERRUPTED' }
  | { kind: 'DEAL_CLOSED'; dealNumber: number; spaceId: number; tileId: number; bossId: number; gross: number; payouts: Payout[]; bossKeep: number }
  | { kind: 'DEAL_FAILED'; spaceId: number; bossId: number; reason: FailReason }
  | { kind: 'END_ROLL_DUE'; playerId: number; faces: number[] }
  | { kind: 'END_ROLL'; playerId: number; die: number; hit: boolean }
  | { kind: 'GAME_OVER'; winnerIds: number[]; cash: number }

export type GameEventKind = GameEvent['kind']
export type LoggedEvent = GameEvent & { id: number }

// ---------- 状态 ----------

export interface GameState {
  saveVersion: number
  phase: GamePhase
  players: Player[]
  investors: InvestorPlacard[]
  board: BoardSpace[]
  dealTiles: DealTile[]
  /** 当前生效景气牌下标 */
  dealTileIndex: number
  drawPile: InfluenceCard[]
  discardPile: InfluenceCard[]
  markerPos: number
  /** TURN / AFTER_MOVE / HAND_LIMIT / END_ROLL 的行动者 */
  currentId: number
  /** PLACE_MARKER 阶段的放置者 */
  markerChooserId: number | null
  completedDeals: number
  negotiation: Negotiation | null
  pendingReaction: PendingReaction | null
  dealHistory: DealRecord[]
  /** 事件流（保留最近若干条），UI 与 AI 提示词据此渲染文字 */
  events: LoggedEvent[]
  lastDie: number | null
  winnerIds: number[]
  /** 每次被接受的动作 +1，运行时以此判断状态是否推进 */
  stateVersion: number
  /** 确定性随机数状态（可复现对局） */
  rng: number
  nextId: number
}

// ---------- 动作 ----------

interface ActionBase {
  playerId: number
  /** 随动作说的一句台词（AI 角色扮演 / 人类喊话），任何动作都可附带 */
  say?: string
  /** 电脑玩家随动作写下的私人笔记（不公开），见 Player.notes */
  note?: string
}

export type PlayerAction =
  | (ActionBase & { type: 'PLACE_MARKER'; spaceId: number })
  | (ActionBase & { type: 'OPEN_DEAL' })
  | (ActionBase & { type: 'ROLL_MOVE' })
  | (ActionBase & { type: 'DRAW_CARDS' })
  | (ActionBase & { type: 'DISCARD'; cardIds: number[] })
  | (ActionBase & { type: 'PLAY_CLAN'; cardId: number; demand?: number })
  | (ActionBase & { type: 'PLAY_TRAVEL'; cardId: number; targetRepKey: string })
  | (ActionBase & { type: 'PLAY_RECRUITMENT'; cardIds: number[]; targetFamilyId: FamilyId })
  | (ActionBase & { type: 'PLAY_BOSS'; cardId: number })
  | (ActionBase & { type: 'PLAY_STOP' })
  | (ActionBase & { type: 'PASS_REACTION' })
  /**
   * 喊话：say 必填；可附带公开报价 demand（每个代表的出借价）。
   * demandFamily 省略 = 对我在本格所有相关代表报同一价（没有相关代表则为封口费）；指定 = 只对该家族报价。
   */
  | (ActionBase & { type: 'SPEAK'; demand?: number; demandFamily?: FamilyId })
  | (ActionBase & { type: 'PASS' })
  | (ActionBase & { type: 'PROPOSE_OFFER'; repKeys: string[]; payouts: Payout[] })
  | (ActionBase & { type: 'ACCEPT_OFFER' })
  | (ActionBase & { type: 'DECLINE_OFFER'; counter?: number })
  | (ActionBase & { type: 'CLOSE_DEAL' })
  | (ActionBase & { type: 'ABANDON_DEAL' })
  | (ActionBase & { type: 'PASS_CLOSING' })
  | (ActionBase & { type: 'ROLL_END' })

export type PlayerActionType = PlayerAction['type']

export type GameAction =
  | { type: 'START_GAME'; playerCount: number; humanName: string; seed?: number }
  | { type: 'LOAD_GAME'; state: GameState }
  | PlayerAction
