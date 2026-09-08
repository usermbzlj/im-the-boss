// 静态数据与开局设置是否符合官方规则书

import { describe, it, expect } from 'vitest'
import { BOARD_SPACES, DEAL_TILES, FAMILY_IDS, createInfluenceDeck, STARTING_HAND } from '../src/engine/config'
import { createInitialState } from '../src/engine/gameEngine'
import { spaceInvestorCount, prevPlayerId } from '../src/engine/rules'

describe('版图数据', () => {
  it('16 格，每格分红份数 = 所需投资者数 + 1', () => {
    expect(BOARD_SPACES).toHaveLength(16)
    for (const space of BOARD_SPACES) {
      expect(space.dividends, `#${space.id}`).toBe(spaceInvestorCount(space) + 1)
      expect(spaceInvestorCount(space)).toBeGreaterThanOrEqual(2)
      expect(spaceInvestorCount(space)).toBeLessThanOrEqual(5)
    }
  })

  it('同一格内各需求组的家族互不重叠，need 不超过池子大小', () => {
    for (const space of BOARD_SPACES) {
      const seen = new Set<string>()
      for (const g of space.groups) {
        expect(g.need).toBeGreaterThan(0)
        expect(g.need).toBeLessThanOrEqual(g.families.length)
        for (const f of g.families) {
          expect(seen.has(f), `#${space.id} 家族 ${f} 重复`).toBe(false)
          seen.add(f)
        }
      }
    }
  })

  it('规则书示例：某格需 A+B+C 全部 加 D/E/F 中 2 个，共 5 位投资者、6 份分红', () => {
    const example = BOARD_SPACES.find(s => s.id === 7)!
    expect(example.groups).toEqual([{ families: ['A', 'B', 'C'], need: 3 }, { families: ['D', 'E', 'F'], need: 2 }])
    expect(example.dividends).toBe(6)
  })
})

describe('景气牌', () => {
  it('15 张，股价单调不减，第 10 张起有终局骰面，第 15 张必定结束', () => {
    expect(DEAL_TILES).toHaveLength(15)
    for (let i = 1; i < DEAL_TILES.length; i++) expect(DEAL_TILES[i].shareValue).toBeGreaterThanOrEqual(DEAL_TILES[i - 1].shareValue)
    for (const t of DEAL_TILES) {
      if (t.id < 10) expect(t.endFaces).toEqual([])
      else expect(t.endFaces).toEqual(Array.from({ length: t.id - 9 }, (_, k) => k + 1))
    }
    expect(DEAL_TILES[14].endFaces).toHaveLength(6)
  })
})

describe('影响牌堆', () => {
  it('98 张：家族成员 24、旅行 18 定向 + 3 万能、招募 33、老板 10、阻止 10，id 唯一', () => {
    const deck = createInfluenceDeck()
    expect(deck).toHaveLength(98)
    const count = (pred: (c: (typeof deck)[number]) => boolean) => deck.filter(pred).length
    expect(count(c => c.type === 'CLAN')).toBe(24)
    for (const f of FAMILY_IDS) expect(count(c => c.type === 'CLAN' && c.familyId === f)).toBe(4)
    expect(count(c => c.type === 'TRAVEL' && c.familyId !== undefined)).toBe(18)
    expect(count(c => c.type === 'TRAVEL' && c.familyId === undefined)).toBe(3)
    expect(count(c => c.type === 'RECRUITMENT')).toBe(33)
    expect(count(c => c.type === 'BOSS')).toBe(10)
    expect(count(c => c.type === 'STOP')).toBe(10)
    expect(new Set(deck.map(c => c.id)).size).toBe(98)
  })
})

describe('开局设置', () => {
  it.each([3, 4, 5, 6])('%i 人局：投资者分配与公共区数量正确，每人 5 张手牌', count => {
    const s = createInitialState(count, '我', 42)
    expect(s.players).toHaveLength(count)
    const perPlayer = s.players.map(p => s.investors.filter(i => i.ownerId === p.id).length)
    const neutral = s.investors.filter(i => i.ownerId === null).length
    if (count === 3) { expect(perPlayer).toEqual([2, 2, 2]); expect(neutral).toBe(0) }
    else { expect(perPlayer.every(n => n === 1)).toBe(true); expect(neutral).toBe(6 - count) }
    for (const p of s.players) expect(p.hand).toHaveLength(STARTING_HAND)
    expect(s.drawPile).toHaveLength(98 - STARTING_HAND * count)
    expect(s.players.every(p => p.cash === 0)).toBe(true)
  })

  it('起始玩家持有字母序最前的投资者；其右手边玩家放置金钱标记', () => {
    const s = createInitialState(5, '我', 7)
    const first = FAMILY_IDS.find(f => s.investors.some(i => i.familyId === f && i.ownerId !== null))!
    const holder = s.investors.find(i => i.familyId === first)!.ownerId!
    expect(s.currentId).toBe(holder)
    expect(s.markerChooserId).toBe(prevPlayerId(s, holder))
    expect(s.phase).toBe('PLACE_MARKER')
  })

  it('人数限制在 3~6', () => {
    expect(createInitialState(2, '我', 1).players).toHaveLength(3)
    expect(createInitialState(9, '我', 1).players).toHaveLength(6)
  })

  it('同一种子开局完全一致，不同种子不同', () => {
    const a = createInitialState(4, '我', 99)
    const b = createInitialState(4, '我', 99)
    const c = createInitialState(4, '我', 100)
    expect(a).toEqual(b)
    expect(a.drawPile.map(x => x.id)).not.toEqual(c.drawPile.map(x => x.id))
  })
})
