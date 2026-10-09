// 事件流整理：跳过折叠、喊话成气泡、按 dealNo 取本笔事件、"刚刚发生"简报

import { describe, it, expect } from 'vitest'
import { summarizePasses, buildFeed, dealFeed, currentDealNo, recentDigest } from '../../src/ui/eventFeed'
import { biddingState, closedDealState, placeMarkerState, step } from './fixtures'

describe('summarizePasses', () => {
  const s = placeMarkerState()
  it('1 / 2 人列名字，3 人起"某某等 N 人"；非谈判阶段叫放行', () => {
    expect(summarizePasses(s, [1], 'NEGOTIATION')).toBe(`${s.players[1].name} 跳过`)
    expect(summarizePasses(s, [1, 2], 'NEGOTIATION')).toBe(`${s.players[1].name}、${s.players[2].name} 跳过`)
    expect(summarizePasses(s, [1, 2, 3], 'NEGOTIATION')).toBe(`${s.players[1].name} 等 3 人跳过`)
    expect(summarizePasses(s, [1, 2, 3], 'CLOSING')).toContain('放行')
  })
  it('同一个人重复只算一次', () => {
    expect(summarizePasses(s, [1, 1], 'NEGOTIATION')).toBe(`${s.players[1].name} 跳过`)
  })
})

describe('buildFeed / dealFeed', () => {
  it('一笔交易里：开单事件 → 喊话成气泡 → 连续跳过折叠成一行', () => {
    let s = biddingState(0) // 0 号 Boss，叫价轮从 1 号开始
    s = step(s, { type: 'SPEAK', playerId: 1, say: '黑松不便宜' })
    s = step(s, { type: 'PASS', playerId: 2 })
    s = step(s, { type: 'PASS', playerId: 3 })
    const feed = dealFeed(s, currentDealNo(s)!)
    expect(feed.map(i => i.type)).toEqual(['event', 'speech', 'passes'])
    const passes = feed[2]
    expect(passes.type === 'passes' && passes.playerIds).toEqual([2, 3])
    expect(feed[1]).toMatchObject({ type: 'speech', playerId: 1, text: '黑松不便宜' })
  })

  it('被其他事件隔开的跳过不合并；不同阶段的放行 / 跳过不合并', () => {
    let s = biddingState(0)
    s = step(s, { type: 'PASS', playerId: 1 })
    s = step(s, { type: 'SPEAK', playerId: 2, say: '等等' })
    s = step(s, { type: 'PASS', playerId: 3 })
    const feed = dealFeed(s, currentDealNo(s)!)
    expect(feed.filter(i => i.type === 'passes')).toHaveLength(2)
  })

  it('只取本笔交易的事件：上一笔的事件不混进来', () => {
    const s = closedDealState()
    expect(currentDealNo(s)).toBeNull() // 已无进行中的交易
    const first = dealFeed(s, 1)
    expect(first.length).toBeGreaterThan(0)
    expect(dealFeed(s, 2)).toEqual([])
  })

  it('buildFeed 不改变事件顺序，id 单调', () => {
    let s = biddingState(0)
    s = step(s, { type: 'SPEAK', playerId: 1, say: 'a' })
    s = step(s, { type: 'PASS', playerId: 2 })
    const ids = buildFeed(s, s.events).map(i => i.id)
    expect([...ids].sort((a, b) => a - b)).toEqual(ids)
  })
})

describe('recentDigest', () => {
  it('最多 limit 条、时间正序，只含值得一看的事件', () => {
    const s = closedDealState()
    const d = recentDigest(s, 0, 3)
    expect(d.length).toBeLessThanOrEqual(3)
    expect(d.length).toBeGreaterThan(0)
    expect([...d.map(x => x.id)].sort((a, b) => a - b)).toEqual(d.map(x => x.id))
    // 最后一条就是成交
    expect(d[d.length - 1].text).toContain('成交')
  })

  it('刚开局没有重要事件：空', () => {
    expect(recentDigest(placeMarkerState(), 0)).toEqual([])
  })

  it('文案按视角：自己的动作叫"你"', () => {
    const s = closedDealState() // 0 号是 Boss
    const last = recentDigest(s, 0, 1)[0]
    expect(last.text).toContain('你')
    const asOther = recentDigest(s, 2, 1)[0]
    expect(asOther.text).toContain(s.players[0].name)
  })
})
