// ============================================================
// I'm the Boss! — 游戏静态数据
// 经典版依据官方规则（Face2Face 英文版 & 德版原规则）：
//   · 16 个交易格，每格需要 2~5 位投资者，分红份数 = 投资者数 + 1
//   · 15 张景气牌：$2M/股 起步，第 13 张起 $5M/股
//   · 第 10~14 张景气牌背面终局骰面为 1 / 1-2 / 1-3 / 1-4 / 1-5，第 15 张必定结束
//   · 98 张影响牌：家族成员 24、旅行 21（18 定向 + 3 万能）、招募 33、老板 10、阻止 10
// 扩展变体（本实现自行设计，见 docs/rules.md §10）：
//   · 完整 16 笔：经典版图打满 16 张景气牌，牌堆加入 7 张稀有牌
//   · 扩张 22 笔：24 格版图（经典 16 格 + 8 个含特殊格的新格），股价升到 $6M，牌堆加一个补充包
//   · 马拉松 30 笔：32 格版图（+16 新格），股价升到 $7M，牌堆加两个补充包
// ============================================================

import type { Family, FamilyId, BoardSpace, DealGroup, DealTile, InfluenceCard, GameVariantId, SpaceKind } from './types'

export const FAMILIES: Record<FamilyId, Family> = {
  A: { id: 'A', name: '星桥资本', color: '#e74c3c', textColor: '#fff' },
  B: { id: 'B', name: '赤岩集团', color: '#e67e22', textColor: '#fff' },
  C: { id: 'C', name: '银湾基金', color: '#b8a13a', textColor: '#fff' },
  D: { id: 'D', name: '蓝鲸实业', color: '#3498db', textColor: '#fff' },
  E: { id: 'E', name: '绿洲商会', color: '#27ae60', textColor: '#fff' },
  F: { id: 'F', name: '黑松控股', color: '#9b59b6', textColor: '#fff' },
}

export const FAMILY_IDS: FamilyId[] = ['A', 'B', 'C', 'D', 'E', 'F']

/** 全部必需 */
const R = (...families: FamilyId[]): DealGroup => ({ families, need: families.length })
/** N 选 M */
const P = (need: number, ...families: FamilyId[]): DealGroup => ({ families, need })

/** 版图格子的静态定义（id 在组装版图时按顺时针顺序重新编号） */
export type SpaceSpec = Pick<BoardSpace, 'groups' | 'dividends'> & { kind?: SpaceKind }

const S = (groups: DealGroup[], dividends: number, kind: SpaceKind = 'STANDARD'): SpaceSpec => ({ groups, dividends, kind })

/** 官方 16 格（顺时针） */
export const CLASSIC_SPACES: SpaceSpec[] = [
  S([R('A', 'B')], 3),
  S([P(2, 'C', 'D', 'E')], 3),
  S([R('C', 'F'), P(1, 'A', 'B')], 4),
  S([R('A', 'D'), P(2, 'B', 'C', 'E', 'F')], 5),
  S([R('E', 'F')], 3),
  S([R('B'), P(2, 'A', 'C', 'D')], 4),
  S([R('A', 'B', 'C'), P(2, 'D', 'E', 'F')], 6),
  S([R('D', 'E', 'F')], 4),
  S([P(2, 'A', 'B', 'F')], 3),
  S([P(2, 'A', 'B', 'C'), P(2, 'D', 'E', 'F')], 5),
  S([R('A', 'E'), P(1, 'B', 'C', 'D', 'F')], 4),
  S([R('C', 'D', 'E'), P(1, 'A', 'B', 'F')], 5),
  S([R('B', 'D')], 3),
  S([P(5, 'A', 'B', 'C', 'D', 'E', 'F')], 6),
  S([R('F'), P(2, 'A', 'B', 'C', 'D', 'E')], 4),
  S([R('B', 'F'), P(2, 'A', 'C', 'D', 'E')], 5),
]

/** 扩张版新增的 8 格（含特殊格），家族出现频次与经典格持平 */
export const EXPANSION_SPACES: SpaceSpec[] = [
  S([R('C', 'E')], 3, 'LANDMARK'),
  S([P(2, 'A', 'D', 'F')], 3, 'HEADHUNT'),
  S([R('A', 'F'), P(1, 'B', 'D')], 4, 'PREMIUM'),
  S([R('B', 'C', 'D')], 4, 'BLACK_MARKET'),
  S([P(3, 'A', 'B', 'C', 'D', 'E', 'F')], 4),
  S([R('D', 'E'), P(2, 'A', 'B', 'F')], 5, 'LANDMARK'),
  S([R('A', 'C'), P(1, 'B', 'E', 'F')], 4, 'PREMIUM'),
  S([R('B', 'E', 'F'), P(1, 'A', 'C', 'D')], 5, 'BLACK_MARKET'),
]

/** 马拉松版在扩张版基础上再加的 8 格 */
export const MARATHON_SPACES: SpaceSpec[] = [
  S([R('A', 'B'), P(1, 'D', 'E')], 4),
  S([P(2, 'C', 'E', 'F')], 3, 'LANDMARK'),
  S([R('D'), P(2, 'A', 'B', 'C', 'E', 'F')], 4, 'PREMIUM'),
  S([R('C', 'F'), P(2, 'A', 'B', 'D', 'E')], 5),
  S([R('A', 'E', 'F')], 4, 'HEADHUNT'),
  S([P(2, 'A', 'B', 'C'), P(1, 'D', 'E', 'F')], 4, 'BLACK_MARKET'),
  S([R('B', 'D', 'E'), P(2, 'A', 'C', 'F')], 6, 'LANDMARK'),
  S([R('C', 'D')], 3),
]

/** 把经典格与新格交错排成一圈（新格均匀散布，而不是堆在版图末尾），并按顺时针重新编号 */
function interleave(base: SpaceSpec[], extra: SpaceSpec[]): SpaceSpec[] {
  const out: SpaceSpec[] = []
  const period = extra.length ? Math.floor((base.length + extra.length) / extra.length) : Infinity
  let b = 0, e = 0
  for (let i = 0; out.length < base.length + extra.length; i++) {
    if (e < extra.length && (i + 1) % period === 0) out.push(extra[e++])
    else if (b < base.length) out.push(base[b++])
    else out.push(extra[e++])
  }
  return out
}

export function buildBoard(specs: SpaceSpec[]): BoardSpace[] {
  return specs.map((spec, i) => ({
    id: i + 1,
    groups: spec.groups.map(g => ({ ...g, families: [...g.families] })),
    dividends: spec.dividends,
    kind: spec.kind ?? 'STANDARD',
    closedByTileId: null,
    landlordId: null,
  }))
}

/** 兼容旧引用：经典版图（16 格，全部 STANDARD） */
export const BOARD_SPACES: BoardSpace[] = buildBoard(CLASSIC_SPACES)

/**
 * 景气牌生成：股价从 $2M 均匀升到 maxShare（余数分给靠前的档位），
 * 最后 6 张背面终局骰面为 1 / 1-2 / … / 1-6。makeDealTiles(15, 5) 与官方 15 张完全一致。
 */
export function makeDealTiles(count: number, maxShare: number): DealTile[] {
  const blocks = Math.max(1, maxShare - 1)
  const base = Math.floor(count / blocks)
  const extra = count % blocks
  const tiles: DealTile[] = []
  for (let b = 0; b < blocks; b++) {
    const n = base + (b < extra ? 1 : 0)
    for (let i = 0; i < n; i++) tiles.push({ id: tiles.length + 1, shareValue: 2 + b, endFaces: [] })
  }
  for (let k = 0; k < Math.min(6, count); k++) {
    const t = tiles[count - 6 + k] ?? tiles[k]
    t.endFaces = Array.from({ length: k + 1 }, (_, f) => f + 1)
  }
  return tiles
}

/** 兼容旧引用：官方 15 张景气牌 */
export const DEAL_TILES: DealTile[] = makeDealTiles(15, 5)

export const HAND_LIMIT = 12
export const CARDS_PER_DRAW = 3
export const STARTING_HAND = 5
export const MAX_SPEECHES_PER_PLAYER = 4
export const MAX_OFFERS_PER_BOSS = 5
export const MAX_STALEMATE_ROUNDS = 2
/** 状态中保留的事件条数上限（UI 日志 / AI 提示词只需要最近一段） */
export const MAX_EVENTS = 300

// ---------- 扩展规则常量 ----------

/** 招募常规消耗 / 猎头格消耗 / 夺回权消耗（张） */
export const RECRUIT_COST = 3
export const HEADHUNT_RECRUIT_COST = 2
export const RECLAIM_RECRUIT_COST = 1
/** 地标每笔成交付给主人的租金（$M） */
export const LANDMARK_RENT = 1
/** 抢手格股价加成（$M/份） */
export const PREMIUM_BONUS = 1
/** 利好牌 / 利空牌的每份股价变动（$M/份）；股价下限 */
export const BOOM_BONUS = 2
export const BUST_PENALTY = 1
export const MIN_SHARE_VALUE = 1

// ---------- 桌规常量（houseRules） ----------

/** 花钱补牌：抽 n 张要付几份当前股价（1 张 1 份、2 张 3 份、3 张 6 份） */
export const BUY_CARDS_COST_SHARES = [1, 3, 6] as const
export const MAX_BUY_CARDS = BUY_CARDS_COST_SHARES.length
/** 兑换招募牌：交出的牌数（须两种不同种类）、附带的股价份数、换到的招募牌数 */
export const TRADE_GIVE_COUNT = 2
export const TRADE_COST_SHARES = 1
export const TRADE_RECRUIT_COUNT = 2
/** 病假牌张数：基础 3 张，每个补充包再加 1 张（长局稍多） */
export const SICK_CARDS_BASE = 3

/** 桌规牌堆里病假牌的张数 */
export function sickCardCount(variant: Pick<GameVariant, 'supplementPacks'>): number {
  return SICK_CARDS_BASE + variant.supplementPacks
}

// ---------- 牌堆 ----------

/** 官方 98 张 */
export function createInfluenceDeck(): InfluenceCard[] {
  const cards: InfluenceCard[] = []
  let id = 1
  for (const fid of FAMILY_IDS) for (let i = 0; i < 4; i++) cards.push({ id: id++, type: 'CLAN', familyId: fid })
  for (const fid of FAMILY_IDS) for (let i = 0; i < 3; i++) cards.push({ id: id++, type: 'TRAVEL', familyId: fid })
  for (let i = 0; i < 3; i++) cards.push({ id: id++, type: 'TRAVEL' })
  for (let i = 0; i < 33; i++) cards.push({ id: id++, type: 'RECRUITMENT' })
  for (let i = 0; i < 10; i++) cards.push({ id: id++, type: 'BOSS' })
  for (let i = 0; i < 10; i++) cards.push({ id: id++, type: 'STOP' })
  return cards // 98
}

/** 稀有牌 7 张：利好 3、利空 2、独家协议 2 */
export const RARE_CARDS: Array<{ type: InfluenceCard['type']; count: number }> = [
  { type: 'BOOM', count: 3 },
  { type: 'BUST', count: 2 },
  { type: 'EXCLUSIVE', count: 2 },
]

/** 补充包 12 张（长局补充牌量，比例与官方牌堆接近）：家族成员 6（每家 1）、招募 3、万能旅行 1、老板 1、阻止 1 */
function supplementPack(): Array<Pick<InfluenceCard, 'type' | 'familyId'>> {
  const out: Array<Pick<InfluenceCard, 'type' | 'familyId'>> = []
  for (const fid of FAMILY_IDS) out.push({ type: 'CLAN', familyId: fid })
  for (let i = 0; i < 3; i++) out.push({ type: 'RECRUITMENT' })
  out.push({ type: 'TRAVEL' }, { type: 'BOSS' }, { type: 'STOP' })
  return out
}

/**
 * 按变体组牌：官方 98 张 +（扩展变体）7 张稀有牌 + N 个补充包 +（桌规开启时）病假牌。
 * houseRules 省略则按该变体的默认值。
 */
export function createDeckFor(variant: GameVariant, houseRules: boolean = variant.houseRules): InfluenceCard[] {
  const cards = createInfluenceDeck()
  let id = cards.length + 1
  if (variant.rareCards) for (const { type, count } of RARE_CARDS) for (let i = 0; i < count; i++) cards.push({ id: id++, type })
  for (let p = 0; p < variant.supplementPacks; p++) for (const c of supplementPack()) cards.push({ id: id++, ...c })
  if (houseRules) for (let i = 0; i < sickCardCount(variant); i++) cards.push({ id: id++, type: 'SICK' })
  return cards
}

// ---------- 变体 ----------

export interface GameVariant {
  id: GameVariantId
  name: string
  /** 成交笔数上限 = 景气牌张数 */
  deals: number
  /** 末张景气牌股价（$M/份） */
  maxShare: number
  spaces: SpaceSpec[]
  rareCards: boolean
  supplementPacks: number
  /** 桌规默认开关（开局可改）：互换 / 买牌 / 兑换招募 / 病假牌 */
  houseRules: boolean
  blurb: string
}

export const VARIANTS: Record<GameVariantId, GameVariant> = {
  classic: {
    id: 'classic', name: '经典 · 15 笔', deals: 15, maxShare: 5, spaces: CLASSIC_SPACES, rareCards: false, supplementPacks: 0, houseRules: false,
    blurb: '官方规则原味：16 格版图、15 张景气牌、98 张影响牌，第 10 笔起可能终局。',
  },
  full: {
    id: 'full', name: '完整 · 16 笔', deals: 16, maxShare: 5, spaces: CLASSIC_SPACES, rareCards: true, supplementPacks: 0, houseRules: true,
    blurb: '经典版图打到最后一格，第 11 笔起可能终局；牌堆加入 7 张稀有牌（利好 / 利空 / 独家协议）与桌规。',
  },
  expansion: {
    id: 'expansion', name: '扩张 · 22 笔', deals: 22, maxShare: 6, spaces: interleave(CLASSIC_SPACES, EXPANSION_SPACES), rareCards: true, supplementPacks: 1, houseRules: true,
    blurb: '24 格版图混入地标 / 抢手 / 黑市 / 猎头格，股价升到 $6M，第 17 笔起可能终局；含稀有牌与桌规。',
  },
  marathon: {
    id: 'marathon', name: '马拉松 · 30 笔', deals: 30, maxShare: 7, spaces: interleave(CLASSIC_SPACES, [...EXPANSION_SPACES, ...MARATHON_SPACES]), rareCards: true, supplementPacks: 2, houseRules: true,
    blurb: '32 格版图、4 座地标，股价升到 $7M，第 25 笔起可能终局；含稀有牌与桌规，是一场长跑。',
  },
}

export const VARIANT_IDS: GameVariantId[] = ['classic', 'full', 'expansion', 'marathon']

export function getVariant(id: GameVariantId | undefined): GameVariant {
  return VARIANTS[id ?? 'classic'] ?? VARIANTS.classic
}

/** 供开局界面 / 文档使用的变体概览（含派生数据） */
export interface VariantSummary extends GameVariant {
  boardSize: number
  /** 不含桌规病假牌的牌堆张数（经典 98、完整 105、扩张 117、马拉松 129） */
  deckSize: number
  /** 桌规开启时的病假牌张数 */
  sickCards: number
  specialSpaces: boolean
  /** 第几笔起可能终局（最后 6 张景气牌带终局骰面） */
  firstEndDeal: number
}

export const VARIANT_LIST: VariantSummary[] = VARIANT_IDS.map(id => {
  const v = VARIANTS[id]
  return {
    ...v,
    boardSize: v.spaces.length,
    deckSize: createDeckFor(v, false).length,
    sickCards: sickCardCount(v),
    specialSpaces: v.spaces.some(s => (s.kind ?? 'STANDARD') !== 'STANDARD'),
    firstEndDeal: Math.max(1, v.deals - 5),
  }
})

/** 外圈最少 4 行：中间要留 ≥ 2 行放景气牌与公共区 */
export const RING_MIN_ROWS = 4

/**
 * n 格外圈可选的行数（从"最扁"到"最方"）：每种行数对应 cols = n/2 − rows + 2 列，
 * 要求 cols > rows（横向为主，座位栏在上方）且 rows ≥ 4。
 * 16 → [4]；24 → [4, 5, 6]；32 → [4, 5, 6, 7, 8]。版图区域越扁（宽屏 / 矮窗口）越该选少的行数。
 */
export function ringRowOptions(n: number): number[] {
  const out: number[] = []
  for (let rows = RING_MIN_ROWS; ; rows++) {
    const cols = Math.round((n - 2 * (rows - 2)) / 2)
    if (cols <= rows) break
    out.push(rows)
  }
  return out.length ? out : [Math.max(2, Math.round(n / 4))]
}

/**
 * 环形版图布局：n 格排成 cols × rows 的外圈（n = 2·cols + 2·(rows−2)）。
 * 默认取最"方"的一种（16 → 6×4、24 → 8×6、32 → 10×8）；可指定行数换成更扁的外圈（如 32 → 13×5）。
 * 返回每格（1 起）的网格行列，顺时针：上排 → 右列 → 下排 → 左列。
 */
export function ringLayout(n: number, rowsWanted?: number): { cols: number; rows: number; cells: Array<{ row: number; col: number }> } {
  const options = ringRowOptions(n)
  const rows = rowsWanted != null && options.includes(rowsWanted) ? rowsWanted : options[options.length - 1]
  const cols = Math.max(2, Math.round((n - 2 * (rows - 2)) / 2))
  const cells: Array<{ row: number; col: number }> = []
  for (let c = 1; c <= cols; c++) cells.push({ row: 1, col: c })
  for (let r = 2; r <= rows - 1; r++) cells.push({ row: r, col: cols })
  for (let c = cols; c >= 1; c--) cells.push({ row: rows, col: c })
  for (let r = rows - 1; r >= 2; r--) cells.push({ row: r, col: 1 })
  return { cols, rows, cells: cells.slice(0, n) }
}

export interface AIRosterEntry {
  name: string
  /** 人物 id，设定见 ai/personas.ts */
  personaId: string
}

/**
 * 牌桌上的常客：名字与人物绑定（人物的角色卡与行为参数在 ai/personas.ts），
 * 开局整体打乱后按座位分配，一局最多 5 位电脑玩家，因此每局的对手组合都不同。
 */
export const AI_ROSTER: AIRosterEntry[] = [
  { name: '沈砚青', personaId: 'shen' },
  { name: '陆峥', personaId: 'lu' },
  { name: '顾曼宁', personaId: 'gu' },
  { name: '何烬', personaId: 'he' },
  { name: '周慕言', personaId: 'zhou' },
  { name: '苏澜', personaId: 'su' },
  { name: '程亦舟', personaId: 'cheng' },
  { name: '白珩', personaId: 'bai' },
]

// ---------- 确定性随机数（mulberry32） ----------

export function randomSeed(): number {
  return (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1
}

/** 推进 rng 状态并返回 [0,1) 的随机数 */
export function nextRandom(holder: { rng: number }): number {
  holder.rng = (holder.rng + 0x6d2b79f5) | 0
  let t = holder.rng
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export function shuffleWith<T>(holder: { rng: number }, arr: T[]): T[] {
  const result = [...arr]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(nextRandom(holder) * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

export function rollDieWith(holder: { rng: number }): number {
  return Math.floor(nextRandom(holder) * 6) + 1
}
