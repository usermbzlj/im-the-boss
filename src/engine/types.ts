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

/**
 * 影响牌种类。前五种是官方牌；BOOM / BUST / EXCLUSIVE 是扩展稀有牌（经典变体不含）：
 *   · BOOM 利好：Boss 打出，本笔股价 +$2M/份（方案分成不变，多出的全归 Boss）
 *   · BUST 利空：非 Boss 打出，本笔股价 −$1M/份（最低 $1M/份；砍的是 Boss 的净得）
 *   · EXCLUSIVE 独家协议：Boss 打出，本笔交易锁定——老板牌 / 旅行牌 / 利空牌不再能打（招募仍可）
 * SICK 病假牌随桌规（houseRules）入堆：指定一名玩家，本回合内他不能主动出牌（仍可打阻止牌自保）。
 */
export type CardType = 'CLAN' | 'TRAVEL' | 'RECRUITMENT' | 'BOSS' | 'STOP' | 'BOOM' | 'BUST' | 'EXCLUSIVE' | 'SICK'

export interface InfluenceCard {
  id: number
  type: CardType
  /** CLAN / 定向 TRAVEL 才有；万能旅行牌没有 familyId */
  familyId?: FamilyId
}

/** 对局变体：按景气牌张数（成交笔数上限）命名 */
export type GameVariantId = 'classic' | 'full' | 'expansion' | 'marathon'

/**
 * 交易格种类（经典版图全部为 STANDARD；扩展版图混入特殊格）：
 *   · LANDMARK 地标：成交后归 Boss 所有，此后每笔成交其主人从银行收 $1M 租金
 *   · PREMIUM 抢手：本格股价 +$1M/份
 *   · BLACK_MARKET 黑市：本格交易中打出的牌不经反应窗口，阻止牌无用
 *   · HEADHUNT 猎头：本格交易进行中招募只需 2 张
 */
export type SpaceKind = 'STANDARD' | 'LANDMARK' | 'PREMIUM' | 'BLACK_MARKET' | 'HEADHUNT'

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
  kind: SpaceKind
  /** 成交后盖在格子上的景气牌 id，null 表示未关闭 */
  closedByTileId: number | null
  /** 地标格成交后的主人（收租人）；其他格恒为 null */
  landlordId: number | null
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
  /**
   * 夺回权：最后一位常驻投资者被招募夺走时获得，只需 1 张招募牌即可把该家族的投资者抢回
   * （无论现在在谁手里）。重新拥有任何投资者后失效。
   */
  reclaim?: FamilyId | null
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

/**
 * 玩家在一次动作里给出的一条报价（每个代表的价）。
 * familyId 省略 = 通用价：补到本次作用域内其余未单独报价的家族；作用域为空（没有相关代表）时是封口费。
 */
export interface Quote {
  familyId?: FamilyId
  amount: number
}

/** 报价落成后的形态：familyIds 为空 = 封口费 */
export interface ResolvedQuote {
  familyIds: FamilyId[]
  amount: number
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
  /** 全员连续跳过的完整轮数，达到上限判僵局流局；任何非跳过的实质行动（喊话 / 出牌 / 提案 / 应答 / 宣布成交）都清零，所以是真正"连续" */
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
  /** 打出过干扰牌（旅行/招募/老板/利空，含被阻止的）的非 Boss 玩家 */
  disruptors: number[]
  /** 利好 / 利空牌累计的每份股价增减（本笔有效） */
  priceDelta: number
  /** 独家协议生效：本笔不再能打老板牌 / 旅行牌 / 利空牌 */
  exclusive: boolean
}

export type ReactionKind = 'TRAVEL' | 'BOSS' | 'RECRUITMENT' | 'BOOM' | 'BUST' | 'EXCLUSIVE' | 'SICK'

export interface PendingReaction {
  actorId: number
  kind: ReactionKind
  /** 已从手牌移出的牌（旅行/老板/利好/利空/独家/病假 1 张，招募 1~3 张） */
  cards: InfluenceCard[]
  /** 旅行牌目标代表 */
  targetRepKey?: string
  /** 招募目标投资者 */
  targetFamilyId?: FamilyId
  /** 病假牌目标玩家 */
  targetPlayerId?: number
  /** 当前被询问是否打阻止牌的玩家 */
  reactorId: number
  askedIds: number[]
  /** 反应结束后回到哪个阶段（TURN / AFTER_MOVE：开单前打出的病假牌，窗口结束后行动者继续自己的回合） */
  returnPhase: 'NEGOTIATION' | 'CLOSING' | 'HAND_LIMIT' | 'TURN' | 'AFTER_MOVE'
}

/** 流局原因：Boss 放弃 / 连续多轮全员跳过 / 桌上凑不齐代表且全员跳过一轮（不必再多等） */
export type FailReason = 'ABANDONED' | 'STALEMATE' | 'INCOMPLETE'

/**
 * 本回合的一次性标记，endTurn 时清空。桌规里的"每回合限一次"与病假都记在这里：
 *   swapped / bought / traded：本回合已做过互换 / 买牌 / 兑换的玩家
 *   sick：病假中的玩家（本回合不能主动出牌，只能被动打阻止牌）
 */
export interface TurnFlags {
  swapped: number[]
  bought: number[]
  traded: number[]
  sick: number[]
}

export interface DealRecord {
  id: number
  dealNumber: number
  spaceId: number
  bossId: number
  openerId: number
  success: boolean
  grossValue: number
  payouts: Payout[]
  /** 本笔成交时银行付给各地标主人的租金（现金守恒：总现金 = Σ成交总额 + Σ租金） */
  rents: Payout[]
  disruptors: number[]
  failReason?: FailReason
}

// ---------- 事件 ----------

/** PASSED 事件发生的阶段：谈判叫价轮 / 成交倒计时 / 反应窗口（放行，不打阻止牌） */
export type PassPhase = 'NEGOTIATION' | 'CLOSING' | 'REACTION'

/** 一个家族的承诺价变动：from 为 null = 此前没报过价 */
export interface CommitmentChange {
  familyId: FamilyId
  from: number | null
  to: number
}

export type GameEvent =
  | { kind: 'GAME_STARTED'; playerCount: number; startPlayerId: number; markerChooserId: number; variantId: GameVariantId; deals: number }
  | { kind: 'MARKER_PLACED'; playerId: number; spaceId: number; nextPlayerId: number }
  | { kind: 'DEAL_OPENED'; playerId: number; spaceId: number; gross: number }
  | { kind: 'MARKER_MOVED'; playerId: number; die: number; spaceId: number; gross: number }
  | { kind: 'CARDS_DRAWN'; playerId: number; count: number; handSize: number }
  | { kind: 'DECK_RESHUFFLED'; size: number }
  | { kind: 'HAND_LIMIT'; playerId: number; handSize: number }
  | { kind: 'CARDS_DISCARDED'; playerId: number; count: number }
  /** 桌规：花钱补牌（cost 付给银行） */
  | { kind: 'CARDS_BOUGHT'; playerId: number; count: number; cost: number; handSize: number }
  /** 桌规：家族成员牌 ↔ 同家族旅行牌互换（to 为换到的牌种） */
  | { kind: 'CARD_SWAPPED'; playerId: number; familyId: FamilyId; to: 'CLAN' | 'TRAVEL' }
  /** 桌规：交出两张不同种类的牌 + 一份股价，换 2 张招募牌 */
  | { kind: 'CARDS_TRADED'; playerId: number; given: CardType[]; cost: number; recruitCount: number }
  | { kind: 'CLAN_PLAYED'; playerId: number; familyId: FamilyId }
  | { kind: 'TRAVEL_PLAYED'; playerId: number; wildcard: boolean; target: RepRef }
  | { kind: 'SICK_PLAYED'; playerId: number; targetId: number }
  /** 病假生效：目标本回合不能主动出牌 */
  | { kind: 'SICK_RESOLVED'; playerId: number; targetId: number }
  /** cost：本次消耗的招募牌张数（3 常规 / 2 猎头格 / 1 夺回权） */
  | { kind: 'RECRUITMENT_PLAYED'; playerId: number; familyId: FamilyId; fromId: number | null; cost: number }
  | { kind: 'BOSS_PLAYED'; playerId: number; bossId: number }
  | { kind: 'BOOM_PLAYED'; playerId: number }
  | { kind: 'BUST_PLAYED'; playerId: number }
  | { kind: 'EXCLUSIVE_PLAYED'; playerId: number }
  /** cancelled：被取消的牌的种类；target*：那张牌当时的目标（旅行 = 代表快照 / 招募 = 家族 / 病假 = 玩家） */
  | { kind: 'STOP_PLAYED'; playerId: number; actorId: number; cancelled: ReactionKind; targetRep?: RepRef; targetFamilyId?: FamilyId; targetPlayerId?: number }
  /** 次要事件：某人在谈判 / 成交倒计时 / 反应窗口里选择跳过或放行（narrate 标 minor，UI 可折叠） */
  | { kind: 'PASSED'; playerId: number; phase: PassPhase }
  /** 同意方案后承诺价被改写：changes 是各家族的新价（from = null 表示此前没报过价） */
  | { kind: 'COMMITMENT_UPDATED'; playerId: number; changes: CommitmentChange[] }
  /** 黑市格：打出的牌不经反应窗口直接生效 */
  | { kind: 'BLACK_MARKET'; actorId: number; card: ReactionKind }
  | { kind: 'TRAVEL_RESOLVED'; target: RepRef }
  | { kind: 'RECRUITMENT_RESOLVED'; playerId: number; familyId: FamilyId; fromId: number | null }
  /** 夺回权：最后一位常驻投资者被夺走，1 张招募牌即可抢回该家族 */
  | { kind: 'RECLAIM_GRANTED'; playerId: number; familyId: FamilyId }
  | { kind: 'BOSS_RESOLVED'; playerId: number; previousBossId: number }
  /** 股价变动：delta 为本次每份增减，gross 为变动后的交易总额 */
  | { kind: 'PRICE_CHANGED'; playerId: number; delta: number; gross: number }
  | { kind: 'EXCLUSIVE_RESOLVED'; playerId: number }
  | { kind: 'OFFER_VOIDED'; reason: 'TRAVELLED' | 'RECRUITED' }
  | { kind: 'SPEECH'; playerId: number; text: string }
  /** 一次报价落成的结果：每条 familyIds 为空 = 封口费；否则是这些家族代表各自的出借价（每个代表） */
  | { kind: 'DEMAND'; playerId: number; quotes: ResolvedQuote[] }
  | { kind: 'STALEMATE_ROUND'; rounds: number; max: number }
  | { kind: 'OFFER_PROPOSED'; bossId: number; offerNo: number; reps: RepRef[]; payouts: Payout[]; bossKeep: number; waitingFor: number[]; autoAccepted: number[] }
  /** auto：方案付到了其承诺价，按约视为同意 */
  | { kind: 'OFFER_ACCEPTED'; playerId: number; auto?: boolean }
  /** counters：反报价（每个代表），已落成到方案所用的家族 */
  | { kind: 'OFFER_DECLINED'; playerId: number; counters: ResolvedQuote[] }
  | { kind: 'OFFER_RESOLVED'; agreed: boolean; declinerIds: number[] }
  | { kind: 'CLOSING_STARTED'; bossId: number }
  /** by / actorId：打断倒计时的牌与出牌者；target*：那张牌的目标（旅行 = 代表快照 / 招募 = 家族） */
  | { kind: 'CLOSING_INTERRUPTED'; by: ReactionKind; actorId: number; targetRep?: RepRef; targetFamilyId?: FamilyId }
  /** reps：本笔所用的代表（快照）；dealNumber 是第几笔成交（流局不占号） */
  | { kind: 'DEAL_CLOSED'; dealNumber: number; spaceId: number; tileId: number; bossId: number; gross: number; payouts: Payout[]; bossKeep: number; reps: RepRef[] }
  /** 地标：成交后归 Boss 所有 */
  | { kind: 'LANDMARK_CLAIMED'; playerId: number; spaceId: number }
  /** 银行付给地标主人的租金 */
  | { kind: 'RENT_PAID'; payments: Payout[] }
  /** missing：reason 为 INCOMPLETE 时，桌上还缺哪些家族的代表 */
  | { kind: 'DEAL_FAILED'; spaceId: number; bossId: number; reason: FailReason; missing?: FamilyId[] }
  | { kind: 'END_ROLL_DUE'; playerId: number; faces: number[] }
  | { kind: 'END_ROLL'; playerId: number; die: number; hit: boolean }
  | { kind: 'GAME_OVER'; winnerIds: number[]; cash: number }

export type GameEventKind = GameEvent['kind']
/**
 * dealNo：事件所属的交易编号 = 第几次开单（成交与流局都占号，从 1 起；与 DealRecord 在 dealHistory 里的下标 + 1 一致）。
 * 开单（DEAL_OPENED）到成交 / 流局（DEAL_CLOSED / DEAL_FAILED）之间的事件都带；谈判之外的事件（掷骰、抽牌、手牌上限…）没有。
 */
export type LoggedEvent = GameEvent & { id: number; dealNo?: number }

// ---------- 状态 ----------

export interface GameState {
  saveVersion: number
  /** 对局变体（版图 / 景气牌 / 牌堆由它决定，开局时已落成到下面的字段里） */
  variantId: GameVariantId
  /**
   * 桌规（可选规则包，开局选择；扩展变体默认开、经典默认关）：
   * 家族成员牌 ↔ 旅行牌互换、花钱补牌、两张异类牌 + 一份股价换 2 张招募牌、病假牌入堆
   */
  houseRules: boolean
  /** 本回合的一次性标记（互换 / 买牌 / 兑换各限一次；病假名单），endTurn 清空 */
  turn: TurnFlags
  /** 银行从买牌 / 兑换收走的钱（现金守恒：Σ现金 = Σ成交总额 + Σ租金 − bank） */
  bank: number
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
  /** cardIds 张数必须等于 recruitCost（3 常规 / 2 猎头格 / 1 夺回权） */
  | (ActionBase & { type: 'PLAY_RECRUITMENT'; cardIds: number[]; targetFamilyId: FamilyId })
  | (ActionBase & { type: 'PLAY_BOSS'; cardId: number })
  | (ActionBase & { type: 'PLAY_BOOM'; cardId: number })
  | (ActionBase & { type: 'PLAY_BUST'; cardId: number })
  | (ActionBase & { type: 'PLAY_EXCLUSIVE'; cardId: number })
  /** 病假牌：目标玩家本回合不能主动出牌（进反应窗口，目标可打阻止牌） */
  | (ActionBase & { type: 'PLAY_SICK'; cardId: number; targetPlayerId: number })
  /** 桌规：手中的家族成员牌换成同家族旅行牌，或反之（须持有该家族投资者；每回合一次） */
  | (ActionBase & { type: 'SWAP_CARD'; cardId: number })
  /** 桌规：付 1 / 3 / 6 份股价，抽 1 / 2 / 3 张牌（自己回合内、开单前；每回合一次；不得超出手牌上限） */
  | (ActionBase & { type: 'BUY_CARDS'; count: 1 | 2 | 3 })
  /** 桌规：交出两张不同种类的牌 + 一份股价，换 2 张招募牌（每回合一次，不可逆） */
  | (ActionBase & { type: 'TRADE_CARDS'; cardIds: number[] })
  | (ActionBase & { type: 'PLAY_STOP' })
  | (ActionBase & { type: 'PASS_REACTION' })
  /**
   * 喊话：say 必填；可附带公开报价 quotes——一次说完每个代表各自的出借价。
   * 有 familyId 的条目只对该家族报价（必须是我在本格的相关家族）；没有 familyId 的通用价
   * 补到其余未单独报价的相关家族；没有相关家族时通用价就是封口费。
   */
  | (ActionBase & { type: 'SPEAK'; quotes?: Quote[] })
  | (ActionBase & { type: 'PASS' })
  | (ActionBase & { type: 'PROPOSE_OFFER'; repKeys: string[]; payouts: Payout[] })
  | (ActionBase & { type: 'ACCEPT_OFFER' })
  /** 拒绝：可附反报价 quotes（每个代表），作用域是方案里用到的我的代表所属家族；通用价补到其余家族 */
  | (ActionBase & { type: 'DECLINE_OFFER'; quotes?: Quote[] })
  | (ActionBase & { type: 'CLOSE_DEAL' })
  | (ActionBase & { type: 'ABANDON_DEAL' })
  | (ActionBase & { type: 'PASS_CLOSING' })
  | (ActionBase & { type: 'ROLL_END' })

export type PlayerActionType = PlayerAction['type']

export type GameAction =
  | { type: 'START_GAME'; playerCount: number; humanName: string; seed?: number; variantId?: GameVariantId; houseRules?: boolean }
  | { type: 'LOAD_GAME'; state: GameState }
  | PlayerAction
