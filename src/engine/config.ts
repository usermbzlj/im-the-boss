// ============================================================
// I'm the Boss! — 游戏数据配置
// 基于规则文档 §14 复刻版参数表
// ============================================================

import type { Family, FamilyId, BoardSpace, DealTile, InfluenceCard } from './types'

// --- 6个家族 ---
export const FAMILIES: Record<FamilyId, Family> = {
  A: { id: 'A', name: '星桥资本', color: '#e74c3c', textColor: '#fff' },
  B: { id: 'B', name: '赤岩集团', color: '#e67e22', textColor: '#fff' },
  C: { id: 'C', name: '银湾基金', color: '#95a5a6', textColor: '#fff' },
  D: { id: 'D', name: '蓝鲸实业', color: '#3498db', textColor: '#fff' },
  E: { id: 'E', name: '绿洲商会', color: '#27ae60', textColor: '#fff' },
  F: { id: 'F', name: '黑松控股', color: '#9b59b6', textColor: '#fff' },
}

export const FAMILY_IDS: FamilyId[] = ['A', 'B', 'C', 'D', 'E', 'F']

// --- 16个交易格（§14.3） ---
export const BOARD_SPACES: Omit<BoardSpace, 'isClosed' | 'placedDealTileId'>[] = [
  { id: 1,  requiredFamilies: ['A','B'],       optionalFamilies: [],             optionalNeed: 0, dividends: 2 },
  { id: 2,  requiredFamilies: ['C'],           optionalFamilies: [],             optionalNeed: 0, dividends: 3 },
  { id: 3,  requiredFamilies: ['A','D','E'],   optionalFamilies: [],             optionalNeed: 0, dividends: 1 },
  { id: 4,  requiredFamilies: ['D','E'],       optionalFamilies: [],             optionalNeed: 0, dividends: 2 },
  { id: 5,  requiredFamilies: ['F'],           optionalFamilies: ['B','C','D','E'], optionalNeed: 2, dividends: 4 },
  { id: 6,  requiredFamilies: ['A','C'],       optionalFamilies: ['E','F'],      optionalNeed: 1, dividends: 4 },
  { id: 7,  requiredFamilies: ['B'],           optionalFamilies: ['C','D','F'],  optionalNeed: 1, dividends: 3 },
  { id: 8,  requiredFamilies: ['E'],           optionalFamilies: ['A','B','C','F'], optionalNeed: 2, dividends: 5 },
  { id: 9,  requiredFamilies: ['D','F'],       optionalFamilies: ['A','E'],      optionalNeed: 1, dividends: 4 },
  { id: 10, requiredFamilies: ['A'],           optionalFamilies: ['B','C','D','E','F'], optionalNeed: 2, dividends: 6 },
  { id: 11, requiredFamilies: ['B','E'],       optionalFamilies: [],             optionalNeed: 0, dividends: 3 },
  { id: 12, requiredFamilies: ['C','F'],       optionalFamilies: ['A','D'],      optionalNeed: 1, dividends: 5 },
  { id: 13, requiredFamilies: ['A','D'],       optionalFamilies: ['B','E','F'],  optionalNeed: 1, dividends: 5 },
  { id: 14, requiredFamilies: ['B','C'],       optionalFamilies: ['A','D','E','F'], optionalNeed: 2, dividends: 6 },
  { id: 15, requiredFamilies: ['E','F'],       optionalFamilies: ['A','B','D'],  optionalNeed: 1, dividends: 5 },
  { id: 16, requiredFamilies: ['A','F'],       optionalFamilies: ['B','C','E'],  optionalNeed: 2, dividends: 7 },
]

// --- 15张景气卡（§14.2） ---
export const DEAL_TILES: DealTile[] = [
  { id: 1,  shareValue: 1,  endGameFaces: undefined },
  { id: 2,  shareValue: 2,  endGameFaces: undefined },
  { id: 3,  shareValue: 2,  endGameFaces: undefined },
  { id: 4,  shareValue: 3,  endGameFaces: undefined },
  { id: 5,  shareValue: 3,  endGameFaces: undefined },
  { id: 6,  shareValue: 4,  endGameFaces: undefined },
  { id: 7,  shareValue: 4,  endGameFaces: undefined },
  { id: 8,  shareValue: 5,  endGameFaces: undefined },
  { id: 9,  shareValue: 5,  endGameFaces: undefined },
  { id: 10, shareValue: 6,  endGameFaces: [6] },
  { id: 11, shareValue: 7,  endGameFaces: [5, 6] },
  { id: 12, shareValue: 8,  endGameFaces: [4, 5, 6] },
  { id: 13, shareValue: 9,  endGameFaces: [3, 4, 5, 6] },
  { id: 14, shareValue: 10, endGameFaces: [2, 3, 4, 5, 6] },
  { id: 15, shareValue: 12, endGameFaces: [1, 2, 3, 4, 5, 6] }, // 自动结束
]

// --- 生成98张影响牌 ---
export function createInfluenceDeck(): InfluenceCard[] {
  const cards: InfluenceCard[] = []
  let id = 1

  // Clan: 每家族4张 × 6 = 24张
  for (const fid of FAMILY_IDS) {
    for (let i = 0; i < 4; i++) {
      cards.push({ id: id++, type: 'CLAN', familyId: fid })
    }
  }

  // Travel: 每家族3张定向 × 6 = 18张 + 3张万能 = 21张
  for (const fid of FAMILY_IDS) {
    for (let i = 0; i < 3; i++) {
      cards.push({ id: id++, type: 'TRAVEL', familyId: fid })
    }
  }
  for (let i = 0; i < 3; i++) {
    cards.push({ id: id++, type: 'TRAVEL' }) // 万能旅行牌，无familyId
  }

  // Recruitment: 33张
  for (let i = 0; i < 33; i++) {
    cards.push({ id: id++, type: 'RECRUITMENT' })
  }

  // Boss: 10张
  for (let i = 0; i < 10; i++) {
    cards.push({ id: id++, type: 'BOSS' })
  }

  // Stop: 10张
  for (let i = 0; i < 10; i++) {
    cards.push({ id: id++, type: 'STOP' })
  }

  return cards // 24+21+33+10+10 = 98
}

// --- AI 玩家名字与人格绑定表 ---
// 之前的设计是把名字列表（AI_NAMES）和人格ID列表（personaIds）分别独立
// shuffle/分配给座位，两者是两个互不相关的随机排列——结果是显示名"稳如山"
// 的玩家，人格系统提示词却自称"钱多多"（PERSONA_PROMPTS.greedy 里硬编码的
// flavor 名字），台词与人设完全对不上。这里把名字与人格绑定为不可分割的
// 整体，分配座位时整体 shuffle，保证"UI 显示名"与"AI 自称的名字"永远一致。
export interface AIRosterEntry {
  name: string
  personaId: 'greedy' | 'grudge' | 'steady' | 'smile' | 'stingy'
}

export const AI_ROSTER: AIRosterEntry[] = [
  { name: '妙算子', personaId: 'smile' },
  { name: '钱多多', personaId: 'greedy' },
  { name: '稳如山', personaId: 'steady' },
  { name: '笑面虎', personaId: 'grudge' },
  { name: '铁公鸡', personaId: 'stingy' },
]

/** 兼容旧引用：仅取名字列表 */
export const AI_NAMES = AI_ROSTER.map(r => r.name)

// --- 工具函数 ---
export function shuffle<T>(arr: T[]): T[] {
  const result = [...arr]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

export function rollDie(): number {
  return Math.floor(Math.random() * 6) + 1
}

export function nextClockwise(position: number, maxSpaces: number): number {
  return position % maxSpaces + 1
}
