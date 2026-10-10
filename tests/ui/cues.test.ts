// 演出调度纯逻辑：事件 → 演出、合并、错开、跳过策略、音效挑选、活动演出合并

import { describe, it, expect } from 'vitest'
import type { GameEvent, LoggedEvent } from '../../src/engine/types'
import {
  CUE_MS, SHOT_MAX_MS, MERGE_WINDOW_MS, MAX_ACTIVE_CUES, STAGGER_MAX_MS, cueLifetime, mergeActive, mergeCues, motionFilter, pickSounds, planCues, scaleCues, staggerCues,
  type ActiveCue, type Cue,
} from '../../src/ui/cues'
import {
  ANIM_SCALE, FULL_MOTION, loadAnimSpeed, markFastForward, motionBlocked, readMotionEnv, resetFastForward, rollValue, isFastForward, scaleMs,
} from '../../src/ui/motion'
import { closedDealState, placeMarkerState } from './fixtures'

let seq = 500
const ev = (e: GameEvent): LoggedEvent => ({ id: ++seq, ...e }) as LoggedEvent
const state = placeMarkerState() // 4 人局，0 号是视角玩家
const V = 0
const plan = (events: GameEvent[], ctx = {}) => planCues(state, events.map(ev), V, ctx)
const kinds = (cues: Cue[]) => cues.map(c => c.kind)

describe('事件 → 演出', () => {
  it('成交：版图格关闭 + 每位收款人的金额飘字（Boss 净得与分成合并到各自座位）', () => {
    const cues = plan([{ kind: 'DEAL_CLOSED', dealNumber: 1, spaceId: 3, tileId: 1, bossId: 0, gross: 12, payouts: [{ playerId: 1, amount: 4 }, { playerId: 2, amount: 3 }], bossKeep: 5, reps: [] }])
    const close = cues.find(c => c.kind === 'close')!
    expect(close.target).toEqual({ type: 'cell', spaceId: 3 })
    expect(close.sfx).toBe('deal')
    const money = cues.filter(c => c.kind === 'money')
    expect(money.map(c => [(c.target as { playerId: number }).playerId, c.amount])).toEqual([[0, 5], [1, 4], [2, 3]])
    expect(money.find(c => c.amount === 5)!.mine).toBe(true)
    expect(money.every(c => c.tone === 'good' && /^\+\$/.test(c.text!))).toBe(true)
  })

  it('同一座位既是 Boss 又收到分成 / 租金：同批合并成一条累加的飘字', () => {
    const cues = plan([
      { kind: 'DEAL_CLOSED', dealNumber: 1, spaceId: 3, tileId: 1, bossId: 0, gross: 10, payouts: [{ playerId: 0, amount: 1 }], bossKeep: 5, reps: [] },
      { kind: 'RENT_PAID', payments: [{ playerId: 0, amount: 1 }] },
    ])
    const mine = cues.filter(c => c.kind === 'money' && (c.target as { playerId: number }).playerId === 0)
    expect(mine).toHaveLength(1)
    expect(mine[0].amount).toBe(7)
    expect(mine[0].count).toBe(2) // Boss 净得与分成先在同一事件内并成一笔，再与租金合并
  })

  it('买牌 / 兑换：座位上飘 −$N（红）；买牌另有抽牌演出', () => {
    const cues = plan([
      { kind: 'CARDS_BOUGHT', playerId: 2, count: 2, cost: 6, handSize: 9 },
      { kind: 'CARDS_TRADED', playerId: 3, given: ['STOP', 'BOSS'], cost: 2, recruitCount: 2 },
    ])
    const spent = cues.filter(c => c.kind === 'money')
    expect(spent.map(c => c.amount)).toEqual([-6, -2])
    expect(spent.every(c => c.tone === 'bad' && c.text!.startsWith('−'))).toBe(true)
    expect(kinds(cues)).toContain('draw')
  })

  it('金额合计为 0 的飘字被丢弃（买牌付 3 又收租 3）', () => {
    const cues = plan([
      { kind: 'CARDS_BOUGHT', playerId: 2, count: 1, cost: 1, handSize: 6 },
      { kind: 'RENT_PAID', payments: [{ playerId: 2, amount: 1 }] },
    ])
    expect(cues.filter(c => c.kind === 'money')).toHaveLength(0)
  })

  it('关键牌镜头：夺权 / 旅行 / 招募 / 阻止 / 股价，各自有目标、说明、音效，时长 ≤ 0.8 秒', () => {
    const cues = plan([
      { kind: 'BOSS_RESOLVED', playerId: 2, previousBossId: 0 },
      { kind: 'TRAVEL_RESOLVED', target: { familyId: 'B', ownerId: 1, source: 'INVESTOR' } },
      { kind: 'RECRUITMENT_RESOLVED', playerId: 3, familyId: 'C', fromId: 2 },
      { kind: 'STOP_PLAYED', playerId: 1, actorId: 2, cancelled: 'TRAVEL' },
      { kind: 'PRICE_CHANGED', playerId: 2, delta: 2, gross: 12 },
    ])
    expect(kinds(cues)).toEqual(['boss', 'travel', 'recruit', 'stop', 'price'])
    const [boss, travel, recruit, stop, price] = cues
    expect(boss.from).toEqual({ type: 'seat', playerId: 0 })
    expect(boss.target).toEqual({ type: 'seat', playerId: 2 })
    expect(boss.tone).toBe('bad') // 你被夺权
    expect(travel.target).toEqual({ type: 'rep', playerId: 1, familyId: 'B' })
    expect(recruit.from).toEqual({ type: 'rep', playerId: 2, familyId: 'C' })
    expect(recruit.target).toEqual({ type: 'rep', playerId: 3, familyId: 'C' })
    expect(stop.target).toEqual({ type: 'seat', playerId: 2 })
    expect(price.tone).toBe('good')
    expect(price.sfx).toBe('up')
    for (const c of cues) {
      expect(c.drama).toBe(true)
      expect(c.ms).toBeLessThanOrEqual(SHOT_MAX_MS)
      expect(c.caption).toBeTruthy()
      expect(c.sfx).toBeTruthy()
    }
  })

  it('公共区招募：起点是公共区的代表（playerId: null）', () => {
    const [c] = plan([{ kind: 'RECRUITMENT_RESOLVED', playerId: 3, familyId: 'E', fromId: null }])
    expect(c.from).toEqual({ type: 'rep', playerId: null, familyId: 'E' })
  })

  it('利空：股价下跌演出（红）；delta 为 0（已到下限）不演', () => {
    const [down] = plan([{ kind: 'PRICE_CHANGED', playerId: 2, delta: -1, gross: 5 }])
    expect(down).toMatchObject({ kind: 'price', tone: 'bad', sfx: 'down' })
    expect(plan([{ kind: 'PRICE_CHANGED', playerId: 2, delta: 0, gross: 5 }])).toHaveLength(0)
  })

  it('出牌：座位上的小提示（带牌种图标），同一人连续出牌合并', () => {
    const cues = plan([
      { kind: 'CLAN_PLAYED', playerId: 1, familyId: 'A' },
      { kind: 'BOOM_PLAYED', playerId: 1 },
    ])
    expect(cues).toHaveLength(1)
    expect(cues[0]).toMatchObject({ kind: 'play', target: { type: 'seat', playerId: 1 }, count: 2, sfx: 'play' })
  })

  it('掷骰 + 标记移动：骰子演出 + 从旧格飞到新格的标记；放置标记没有起点', () => {
    const moved = plan([{ kind: 'MARKER_MOVED', playerId: 1, die: 4, spaceId: 9, gross: 8 }], { prevMarkerPos: 5 })
    expect(kinds(moved)).toEqual(['dice', 'marker'])
    expect(moved[0].die).toBe(4)
    expect(moved[1].from).toEqual({ type: 'cell', spaceId: 5 })
    expect(moved[1].target).toEqual({ type: 'cell', spaceId: 9 })
    expect(moved[1].delay).toBeGreaterThan(0) // 骰子落定后才飞
    const placed = plan([{ kind: 'MARKER_PLACED', playerId: 1, spaceId: 7, nextPlayerId: 2 }])
    expect(placed[0]).toMatchObject({ kind: 'marker', target: { type: 'cell', spaceId: 7 } })
    expect(placed[0].from).toBeUndefined()
  })

  it('流局：版图格上的灰色一闪；终局骰也有骰子演出', () => {
    const [fail] = plan([{ kind: 'DEAL_FAILED', spaceId: 4, bossId: 0, reason: 'ABANDONED' }])
    expect(fail).toMatchObject({ kind: 'fail', target: { type: 'cell', spaceId: 4 }, sfx: 'fail' })
    const [dice] = plan([{ kind: 'END_ROLL', playerId: 0, die: 1, hit: true }])
    expect(dice).toMatchObject({ kind: 'dice', die: 1 })
  })

  it('终局：胜者庆祝；视角玩家赢是 win 音效，别人赢是 end', () => {
    const won = plan([{ kind: 'GAME_OVER', winnerIds: [0], cash: 30 }])[0]
    const lost = plan([{ kind: 'GAME_OVER', winnerIds: [2], cash: 30 }])[0]
    expect(won).toMatchObject({ kind: 'win', tone: 'good', sfx: 'win' })
    expect(lost).toMatchObject({ kind: 'win', tone: 'neutral', sfx: 'end' })
  })

  it('真实对局：一笔成交产生的事件能换成成交 + 飘字', () => {
    const s = closedDealState()
    const closed = s.events.filter(e => e.kind === 'DEAL_CLOSED' || e.kind === 'RENT_PAID' || e.kind === 'LANDMARK_CLAIMED')
    const cues = planCues(s, closed, V)
    expect(kinds(cues)).toContain('close')
    expect(cues.some(c => c.kind === 'money' && (c.amount ?? 0) > 0)).toBe(true)
  })
})

describe('信息隐藏（§7.1）', () => {
  it('他人抽牌只给张数（飘在座位上），自己抽牌才有飞入手牌的演出', () => {
    const others = plan([{ kind: 'CARDS_DRAWN', playerId: 2, count: 3, handSize: 8 }])[0]
    expect(others.target).toEqual({ type: 'seat', playerId: 2 })
    expect(others.text).toBe('+3 张')
    expect(others.sfx).toBeUndefined()
    const mine = plan([{ kind: 'CARDS_DRAWN', playerId: V, count: 3, handSize: 8 }])[0]
    expect(mine).toMatchObject({ kind: 'draw', target: { type: 'hand' }, from: { type: 'pile' }, amount: 3, sfx: 'draw' })
  })

  it('跳过 / 放行 / 喊话 / 报价 / 提案应答不产生任何演出：看不出谁在考虑、谁持有阻止牌', () => {
    const cues = plan([
      { kind: 'PASSED', playerId: 1, phase: 'REACTION' },
      { kind: 'PASSED', playerId: 2, phase: 'CLOSING' },
      { kind: 'SPEECH', playerId: 3, text: '嗯' },
      { kind: 'DEMAND', playerId: 3, quotes: [] },
      { kind: 'OFFER_ACCEPTED', playerId: 2 },
      { kind: 'CLOSING_STARTED', bossId: 0 },
    ])
    expect(cues).toEqual([])
  })

  it('演出只含已落地事件里的玩家：不含任何手牌内容（他人手牌类型不出现在 cue 里）', () => {
    const cues = plan([{ kind: 'CARDS_BOUGHT', playerId: 2, count: 3, cost: 6, handSize: 9 }])
    const json = JSON.stringify(cues)
    expect(json).not.toMatch(/STOP|BOSS|TRAVEL/)
  })
})

describe('合并与错开', () => {
  it('同批多个关键镜头依次错开，最多 0.9 秒；普通演出不受影响', () => {
    const cues = plan([
      { kind: 'STOP_PLAYED', playerId: 1, actorId: 2, cancelled: 'BOSS' },
      { kind: 'PRICE_CHANGED', playerId: 3, delta: 2, gross: 12 },
      { kind: 'TRAVEL_RESOLVED', target: { familyId: 'A', ownerId: 3, source: 'CLAN' } },
      { kind: 'BOSS_RESOLVED', playerId: 2, previousBossId: 1 },
    ])
    const delays = cues.map(c => c.delay)
    expect(delays[0]).toBe(0)
    expect(delays[1]).toBeGreaterThan(delays[0])
    expect(Math.max(...delays)).toBeLessThanOrEqual(STAGGER_MAX_MS)
    const money = staggerCues([{ ...cues[0], drama: false, delay: 5 }])
    expect(money[0].delay).toBe(5)
  })

  it('mergeCues 保持首次出现的顺序', () => {
    const a = plan([{ kind: 'CARDS_DRAWN', playerId: 1, count: 1, handSize: 5 }, { kind: 'CARDS_DRAWN', playerId: 2, count: 2, handSize: 5 }, { kind: 'CARDS_DRAWN', playerId: 1, count: 2, handSize: 7 }])
    expect(a.map(c => (c.target as { playerId: number }).playerId)).toEqual([1, 2])
    expect(a[0].amount).toBe(3)
    expect(a[0].text).toBe('+3 张')
    expect(mergeCues([])).toEqual([])
  })
})

describe('跳过策略与动效环境', () => {
  const cues = plan([{ kind: 'DEAL_CLOSED', dealNumber: 1, spaceId: 3, tileId: 1, bossId: 1, gross: 6, payouts: [], bossKeep: 6, reps: [] }])

  it('快进 / 页面后台 / 减少动画 / 不支持动画的环境：全部跳过视觉演出；正常环境全留', () => {
    expect(motionFilter(cues, FULL_MOTION)).toHaveLength(cues.length)
    for (const patch of [{ fastForward: true }, { hidden: true }, { reducedMotion: true }, { supported: false }]) {
      expect(motionFilter(cues, { ...FULL_MOTION, ...patch })).toEqual([])
      expect(motionBlocked({ ...FULL_MOTION, ...patch })).toBe(true)
    }
    expect(motionBlocked(FULL_MOTION)).toBe(false)
  })

  it('动画速度：关闭档挡住视觉演出；倍率缩放时长与延迟；存储里的非法值回退标准', () => {
    expect(motionBlocked({ ...FULL_MOTION, animOff: true })).toBe(true)
    const scaled = scaleCues(cues, ANIM_SCALE.slow)
    scaled.forEach((c, i) => {
      expect(c.ms).toBe(Math.round(cues[i].ms * ANIM_SCALE.slow))
      expect(c.delay).toBe(Math.round(cues[i].delay * ANIM_SCALE.slow))
    })
    expect(scaleCues(cues, 1)).toEqual(cues)
    expect(scaleMs(1000, 'fast')).toBe(600)
    expect(scaleMs(1000, 'off')).toBe(1000)
    const mem = (v: string | null) => ({ getItem: () => v, setItem: () => {} })
    expect(loadAnimSpeed(mem('slow'))).toBe('slow')
    expect(loadAnimSpeed(mem('warp'))).toBe('normal')
    expect(loadAnimSpeed(null)).toBe('normal')
  })

  it('快进标记：按下后一小段时间内为真，之后恢复', () => {
    resetFastForward()
    expect(isFastForward(1000)).toBe(false)
    markFastForward(1000, 500)
    expect(isFastForward(1200)).toBe(true)
    expect(isFastForward(1600)).toBe(false)
    resetFastForward()
  })

  it('readMotionEnv 在没有 matchMedia 的环境里标记为不支持（不抛错）', () => {
    const env = readMotionEnv()
    expect(typeof env.supported).toBe('boolean')
    expect(env.reducedMotion).toBe(false)
  })

  it('数字滚动插值：缓出、取整、端点精确', () => {
    expect(rollValue(10, 30, 0)).toBe(10)
    expect(rollValue(10, 30, 1)).toBe(30)
    expect(rollValue(10, 30, 2)).toBe(30)
    const mid = rollValue(10, 30, 0.5)
    expect(mid).toBeGreaterThan(20) // 缓出：过半时已超过一半
    expect(Number.isInteger(mid)).toBe(true)
    expect(rollValue(30, 10, 0.5)).toBeLessThan(20)
    expect(rollValue(5, 5, 0.3)).toBe(5)
  })
})

describe('音效挑选', () => {
  const sfxOf = (events: GameEvent[]) => planCues(state, events.map(ev), V)
  const deal: GameEvent = { kind: 'DEAL_CLOSED', dealNumber: 1, spaceId: 3, tileId: 1, bossId: 1, gross: 6, payouts: [{ playerId: 2, amount: 2 }], bossKeep: 4, reps: [] }

  it('成交压过入账：只播成交和弦，不叠硬币声', () => {
    const plan = pickSounds(sfxOf([deal, { kind: 'RENT_PAID', payments: [{ playerId: 2, amount: 1 }] }]), FULL_MOTION)
    expect(plan.map(p => p.id)).toEqual(['deal'])
  })

  it('一批里至多两个音效，按优先级排序，第二个延后', () => {
    const cues = sfxOf([
      { kind: 'STOP_PLAYED', playerId: 1, actorId: 2, cancelled: 'BOSS' },
      { kind: 'BOSS_RESOLVED', playerId: 2, previousBossId: 1 },
      { kind: 'PRICE_CHANGED', playerId: 2, delta: 2, gross: 8 },
    ])
    const picked = pickSounds(cues, FULL_MOTION)
    expect(picked).toHaveLength(2)
    expect(picked[0].id).toBe('boss')
    expect(picked[0].delayMs).toBe(0)
    expect(picked[1].delayMs).toBeGreaterThan(0)
  })

  it('终局压过一切；页面在后台不出声；快进只保留成交 / 流局 / 终局', () => {
    const over = sfxOf([deal, { kind: 'GAME_OVER', winnerIds: [1], cash: 4 }])
    expect(pickSounds(over, FULL_MOTION).map(p => p.id)).toEqual(['end'])
    expect(pickSounds(over, { hidden: true, fastForward: false })).toEqual([])
    const noisy = sfxOf([{ kind: 'CLAN_PLAYED', playerId: 1, familyId: 'A' }, { kind: 'RENT_PAID', payments: [{ playerId: 2, amount: 1 }] }])
    expect(pickSounds(noisy, { hidden: false, fastForward: true })).toEqual([])
    expect(pickSounds(sfxOf([deal]), { hidden: false, fastForward: true }).map(p => p.id)).toEqual(['deal'])
  })

  it('没有音效的演出（他人抽牌）不出声', () => {
    expect(pickSounds(sfxOf([{ kind: 'CARDS_DRAWN', playerId: 2, count: 3, handSize: 7 }]), FULL_MOTION)).toEqual([])
  })
})

describe('mergeActive：正在播放的演出', () => {
  let n = 0
  const nextId = () => ++n
  const money = (amount: number): Cue => plan([{ kind: 'RENT_PAID', payments: [{ playerId: 2, amount }] }])[0]

  it('短时间内同座位的飘字合并成一条（金额累加、版本 +1、重新计时）', () => {
    let list = mergeActive([], [money(1)], 1000, nextId)
    list = mergeActive(list, [money(2)], 1000 + MERGE_WINDOW_MS - 50, nextId)
    expect(list).toHaveLength(1)
    expect(list[0].amount).toBe(3)
    expect(list[0].version).toBe(1)
    expect(list[0].startedAt).toBe(1000 + MERGE_WINDOW_MS - 50)
    expect(list[0].text).toBe('+$3M')
  })

  it('超过合并窗口就另起一条', () => {
    let list = mergeActive([], [money(1)], 1000, nextId)
    list = mergeActive(list, [money(2)], 1000 + 5000, nextId)
    expect(list).toHaveLength(2)
  })

  it('关键镜头不累加：同 key 的重复直接丢弃', () => {
    const boss = plan([{ kind: 'BOSS_RESOLVED', playerId: 2, previousBossId: 1 }])
    let list = mergeActive([], boss, 0, nextId)
    list = mergeActive(list, boss, 10, nextId)
    expect(list).toHaveLength(1)
  })

  it('同时在播的演出有上限，先挤掉非关键的', () => {
    const many: Cue[] = Array.from({ length: MAX_ACTIVE_CUES + 3 }, (_, i) => ({ ...money(1), key: `money:${100 + i}` }))
    const drama = plan([{ kind: 'BOSS_RESOLVED', playerId: 2, previousBossId: 1 }])
    let list = mergeActive([], drama, 0, nextId)
    list = mergeActive(list, many, 5000, nextId)
    expect(list).toHaveLength(MAX_ACTIVE_CUES)
    expect(list.some(c => c.kind === 'boss')).toBe(true)
  })

  it('到期时间 = 延迟 + 时长 + 余量', () => {
    expect(cueLifetime({ ms: 800, delay: 450 })).toBeGreaterThan(1250)
    const c: ActiveCue = { ...money(1), id: 1, startedAt: 0, version: 0 }
    expect(cueLifetime(c)).toBeGreaterThanOrEqual(CUE_MS.money)
  })
})
