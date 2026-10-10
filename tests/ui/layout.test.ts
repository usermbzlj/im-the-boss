// 布局纯函数：断点判定 / 与 CSS 断点同步 / 环形版图的挑行与缩放 / 抽屉未读计数 / 读屏播报文案

import { describe, it, expect } from 'vitest'
import { readStyle } from './readStyle'
import { BREAKPOINTS, MEDIA, DESKTOP_LAYOUT, layoutFor } from '../../src/ui/layout'
import { MIN_COMPACT_SCALE, RING_METRICS, fitScale, pickRingRows, ringCols, ringNeed } from '../../src/ui/ringFit'
import { isUnreadWorthy, lastEventId, unreadCount, unreadLabel } from '../../src/ui/unread'
import { turnAnnouncement } from '../../src/ui/announce'
import { ringRowOptions } from '../../src/engine/config'
import { step } from '../helpers'
import {
  biddingState, bossPlanningState, closingState, gameOverState, offerResponseState, placeMarkerState, turnState,
} from './fixtures'

describe('layoutFor：按视口宽高判定档位', () => {
  it('四档宽度，边界值归属正确', () => {
    expect(layoutFor(1280, 900).tier).toBe('desktop')
    expect(layoutFor(1279, 900).tier).toBe('narrow')
    expect(layoutFor(1024, 900).tier).toBe('narrow')
    expect(layoutFor(1023, 900).tier).toBe('tablet')
    expect(layoutFor(768, 900).tier).toBe('tablet')
    expect(layoutFor(767, 900).tier).toBe('phone')
    expect(layoutFor(360, 740).tier).toBe('phone')
  })

  it('各档位的派生开关：抽屉 / 紧凑版图 / 座位横滚', () => {
    const desktop = layoutFor(1440, 900)
    expect(desktop).toMatchObject({ drawer: false, compactBoard: false, scrollSeats: false, short: false })
    const narrow = layoutFor(1100, 800)
    expect(narrow).toMatchObject({ drawer: false, compactBoard: false, scrollSeats: true })
    const tablet = layoutFor(820, 1180)
    expect(tablet).toMatchObject({ drawer: true, compactBoard: false, scrollSeats: true })
    const phone = layoutFor(390, 844)
    expect(phone).toMatchObject({ drawer: true, compactBoard: true, scrollSeats: true, short: false })
  })

  it('矮屏（横屏手机）与宽度档正交：高 ≤ 500 一律用紧凑版图', () => {
    const land = layoutFor(844, 390)
    expect(land).toMatchObject({ tier: 'tablet', short: true, drawer: true, compactBoard: true })
    expect(layoutFor(1280, 500)).toMatchObject({ tier: 'desktop', short: true, compactBoard: true })
    expect(layoutFor(1280, 501).short).toBe(false)
  })

  it('非法 / 缺失的尺寸按宽屏桌面处理（SSR / jsdom 缺省）', () => {
    expect(layoutFor(0, 0)).toEqual(DESKTOP_LAYOUT)
    expect(layoutFor(NaN, NaN)).toEqual(DESKTOP_LAYOUT)
    expect(layoutFor(-5, Infinity)).toEqual(DESKTOP_LAYOUT)
    expect(DESKTOP_LAYOUT.tier).toBe('desktop')
  })

  it('MEDIA 文本与 BREAKPOINTS 一致', () => {
    expect(MEDIA.phone).toBe(`(max-width: ${BREAKPOINTS.phoneMax}px)`)
    expect(MEDIA.drawer).toBe(`(max-width: ${BREAKPOINTS.drawerMax}px)`)
    expect(MEDIA.short).toBe(`(max-height: ${BREAKPOINTS.shortMaxHeight}px)`)
  })
})

describe('断点与样式表同步：game.css 里确有对应的 @media', () => {
  const css = readStyle('game.css')
  const has = (q: string) => css.includes(`@media ${q}`)
  it('手机 / 抽屉 / 窄桌面 / 矮屏的媒体查询都在', () => {
    expect(has(`(max-width: ${BREAKPOINTS.phoneMax}px)`)).toBe(true)
    expect(has(`(max-width: ${BREAKPOINTS.drawerMax}px)`)).toBe(true)
    expect(has(`(max-width: ${BREAKPOINTS.narrowMax}px)`)).toBe(true)
    expect(has(`(max-height: ${BREAKPOINTS.shortMaxHeight}px)`)).toBe(true)
  })
  it('触控 / 无悬停 / 减少动态三个特性查询都在', () => {
    expect(has('(pointer: coarse)')).toBe(true)
    expect(has('(hover: none)')).toBe(true)
    expect(has('(prefers-reduced-motion: reduce)')).toBe(true)
  })
  it('正文字号下限 12px：样式表里没有小于 12px 的 font-size 声明', () => {
    const small = [...css.matchAll(/font-size:\s*([\d.]+)px/g)].filter(m => parseFloat(m[1]) < 12)
    expect(small.map(m => m[0])).toEqual([])
  })
})

describe('ringFit：环形版图的列数 / 自然尺寸 / 挑行 / 缩放', () => {
  it('16 / 24 / 32 格的外圈列数', () => {
    expect(ringCols(16, 4)).toBe(6)
    expect(ringCols(24, 4)).toBe(10)
    expect(ringCols(24, 6)).toBe(8)
    expect(ringCols(32, 8)).toBe(10)
  })

  it('ringNeed：宽 = 列 × 格宽 + 间距，高 = 行 × 格高 + 间距', () => {
    const m = RING_METRICS[' ring-compact']
    const need = ringNeed(16, 4, m)
    expect(need.w).toBe(6 * m.w + 5 * m.gap)
    expect(need.h).toBe(4 * m.h + 3 * m.gap)
  })

  it('pickRingRows：只会返回该格数合法的行数；区域越扁行数越少', () => {
    for (const n of [16, 24, 32]) {
      const opts = ringRowOptions(n)
      for (const [w, h] of [[400, 700], [900, 300], [1400, 500], [300, 300]]) {
        expect(opts).toContain(pickRingRows(n, w, h, RING_METRICS[''] ))
      }
    }
    const wide = pickRingRows(32, 1500, 360, RING_METRICS[' ring-xl'])
    const tall = pickRingRows(32, 600, 900, RING_METRICS[' ring-xl'])
    expect(wide).toBeLessThanOrEqual(tall)
  })

  it('fitScale：放得下 = 1；放不下按较紧的一边等比缩；min 给出下限（手机）', () => {
    expect(fitScale(300, 200, 400, 400)).toBe(1)
    expect(fitScale(400, 200, 200, 400)).toBeCloseTo(0.5)
    expect(fitScale(200, 400, 400, 100)).toBeCloseTo(0.25)
    expect(fitScale(400, 400, 100, 100, MIN_COMPACT_SCALE)).toBe(MIN_COMPACT_SCALE)
    expect(fitScale(400, 400, 360, 360, MIN_COMPACT_SCALE)).toBeCloseTo(0.9)
    // 下限不会把"放得下"的版图放大
    expect(fitScale(100, 100, 400, 400, MIN_COMPACT_SCALE)).toBe(1)
    // 退化输入不抛错
    expect(fitScale(0, 0, 100, 100)).toBe(1)
  })

  it('MIN_COMPACT_SCALE 保证紧凑格子缩放后字号仍 ≥ 约 9.6px（12px × 0.8）', () => {
    expect(MIN_COMPACT_SCALE).toBeGreaterThanOrEqual(0.8)
  })
})

describe('unread：抽屉收起时的未读计数', () => {
  const VIEWER = 0
  it('别人的喊话算未读，自己的不算；lastSeen 之前的不算', () => {
    const before = biddingState(2, 1) // 2 号开单，轮到 1 号
    const seen = lastEventId(before)
    const after = step(before, { type: 'SPEAK', playerId: 1, say: '我要三百万', quotes: [] })
    expect(unreadCount(after, seen, VIEWER)).toBeGreaterThanOrEqual(1)
    expect(unreadCount(after, seen, 1)).toBe(0) // 1 号自己说的
    expect(unreadCount(after, lastEventId(after), VIEWER)).toBe(0)
    const speech = after.events.find(e => e.kind === 'SPEECH' && e.id > seen)!
    expect(isUnreadWorthy(after, speech, VIEWER)).toBe(true)
    expect(isUnreadWorthy(after, speech, 1)).toBe(false)
  })

  it('没有事件时 lastEventId = 0、计数 = 0', () => {
    const s = placeMarkerState()
    expect(lastEventId({ ...s, events: [] })).toBe(0)
    expect(unreadCount({ ...s, events: [] }, 0, VIEWER)).toBe(0)
  })

  it('unreadLabel：超过 9 显示 9+', () => {
    expect(unreadLabel(1)).toBe('1')
    expect(unreadLabel(9)).toBe('9')
    expect(unreadLabel(10)).toBe('9+')
    expect(unreadLabel(120)).toBe('9+')
  })
})

describe('turnAnnouncement：只在轮到你时给一句话，其余阶段为空', () => {
  it('各阶段的播报文案', () => {
    expect(turnAnnouncement(placeMarkerState(), 0)).toContain('金钱标记')
    expect(turnAnnouncement(turnState(0), 0)).toContain('#1')
    expect(turnAnnouncement(biddingState(1, 0), 0)).toContain('报价')
    expect(turnAnnouncement(bossPlanningState(0), 0)).toContain('Boss')
    expect(turnAnnouncement(offerResponseState(), 1)).toContain('同意')
    expect(turnAnnouncement(closingState(), 1)).toContain('放行')
  })
  it('所有播报都以"轮到你了"开头；终局为空串', () => {
    for (const s of [placeMarkerState(), turnState(0), biddingState(1, 0), bossPlanningState(0), offerResponseState(), closingState()]) {
      expect(turnAnnouncement(s, 0)).toMatch(/^轮到你了/)
    }
    expect(turnAnnouncement(gameOverState([10, 20, 30, 40]), 0)).toBe('')
  })
  it('不泄露他人信息：文案里没有任何电脑玩家手牌 / 思考相关字样', () => {
    const text = [biddingState(1, 0), bossPlanningState(0), closingState()].map(s => turnAnnouncement(s, 0)).join('')
    expect(text).not.toMatch(/思考|笔记|手牌/)
  })
})
