// ============================================================
// I'm the Boss! — 游戏静态数据
// 版图/景气牌/牌堆构成依据官方规则（Face2Face 英文版 & 德版原规则）：
//   · 16 个交易格，每格需要 2~5 位投资者，分红份数 = 投资者数 + 1
//   · 15 张景气牌：$2M/股 起步，第 13 张起 $5M/股
//   · 第 10~14 张景气牌背面终局骰面为 1 / 1-2 / 1-3 / 1-4 / 1-5，第 15 张必定结束
//   · 98 张影响牌：家族成员 24、旅行 21（18 定向 + 3 万能）、招募 33、老板 10、阻止 10
// ============================================================

import type { Family, FamilyId, BoardSpace, DealGroup, DealTile, InfluenceCard } from './types'

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

export const BOARD_SPACES: Array<Omit<BoardSpace, 'closedByTileId'>> = [
  { id: 1, groups: [R('A', 'B')], dividends: 3 },
  { id: 2, groups: [P(2, 'C', 'D', 'E')], dividends: 3 },
  { id: 3, groups: [R('C', 'F'), P(1, 'A', 'B')], dividends: 4 },
  { id: 4, groups: [R('A', 'D'), P(2, 'B', 'C', 'E', 'F')], dividends: 5 },
  { id: 5, groups: [R('E', 'F')], dividends: 3 },
  { id: 6, groups: [R('B'), P(2, 'A', 'C', 'D')], dividends: 4 },
  { id: 7, groups: [R('A', 'B', 'C'), P(2, 'D', 'E', 'F')], dividends: 6 },
  { id: 8, groups: [R('D', 'E', 'F')], dividends: 4 },
  { id: 9, groups: [P(2, 'A', 'B', 'F')], dividends: 3 },
  { id: 10, groups: [P(2, 'A', 'B', 'C'), P(2, 'D', 'E', 'F')], dividends: 5 },
  { id: 11, groups: [R('A', 'E'), P(1, 'B', 'C', 'D', 'F')], dividends: 4 },
  { id: 12, groups: [R('C', 'D', 'E'), P(1, 'A', 'B', 'F')], dividends: 5 },
  { id: 13, groups: [R('B', 'D')], dividends: 3 },
  { id: 14, groups: [P(5, 'A', 'B', 'C', 'D', 'E', 'F')], dividends: 6 },
  { id: 15, groups: [R('F'), P(2, 'A', 'B', 'C', 'D', 'E')], dividends: 4 },
  { id: 16, groups: [R('B', 'F'), P(2, 'A', 'C', 'D', 'E')], dividends: 5 },
]

export const DEAL_TILES: DealTile[] = [
  { id: 1, shareValue: 2, endFaces: [] },
  { id: 2, shareValue: 2, endFaces: [] },
  { id: 3, shareValue: 2, endFaces: [] },
  { id: 4, shareValue: 2, endFaces: [] },
  { id: 5, shareValue: 3, endFaces: [] },
  { id: 6, shareValue: 3, endFaces: [] },
  { id: 7, shareValue: 3, endFaces: [] },
  { id: 8, shareValue: 3, endFaces: [] },
  { id: 9, shareValue: 4, endFaces: [] },
  { id: 10, shareValue: 4, endFaces: [1] },
  { id: 11, shareValue: 4, endFaces: [1, 2] },
  { id: 12, shareValue: 4, endFaces: [1, 2, 3] },
  { id: 13, shareValue: 5, endFaces: [1, 2, 3, 4] },
  { id: 14, shareValue: 5, endFaces: [1, 2, 3, 4, 5] },
  { id: 15, shareValue: 5, endFaces: [1, 2, 3, 4, 5, 6] },
]

export const HAND_LIMIT = 12
export const CARDS_PER_DRAW = 3
export const STARTING_HAND = 5
export const TOTAL_DEALS = 15
export const MAX_SPEECHES_PER_PLAYER = 4
export const MAX_OFFERS_PER_BOSS = 5
export const MAX_STALEMATE_ROUNDS = 2
/** 状态中保留的事件条数上限（UI 日志 / AI 提示词只需要最近一段） */
export const MAX_EVENTS = 300

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
