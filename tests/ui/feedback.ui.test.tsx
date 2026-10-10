// @vitest-environment jsdom
// 即时反馈：谈判事件流 / "刚刚发生"简报 / 行动提示 / 结算卡

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { cleanup, act, fireEvent } from '@testing-library/react'
import NegotiationPanel from '../../src/components/NegotiationPanel'
import RecentStrip from '../../src/components/RecentStrip'
import ToastLayer from '../../src/components/ToastLayer'
import DealResultCard from '../../src/components/DealResultCard'
import { getActingPlayerId } from '../../src/engine/validator'
import type { GameState } from '../../src/engine/types'
import {
  abandonedDealState, biddingState, closingState, closedDealState, giveCards, clearHand, placeMarkerState, renderAs, step,
} from './fixtures'
import { toBoss, openDealAt } from '../helpers'

afterEach(() => { cleanup(); vi.useRealTimers() })

/** 0 号是 Boss；1 号喊话，2、3 号先后跳过 */
function chattyDeal(): GameState {
  let s = biddingState(0)
  s = step(s, { type: 'SPEAK', playerId: 1, say: '黑松不便宜，$3M 起' })
  s = step(s, { type: 'PASS', playerId: 2 })
  return step(s, { type: 'PASS', playerId: 3 })
}

describe('谈判桌里的本笔交易事件流', () => {
  it('喊话是人物气泡，连续跳过折叠成一行', () => {
    const { container } = renderAs(<NegotiationPanel state={chattyDeal()} />)
    const feed = container.querySelector('.neg-feed')!
    expect(feed.querySelectorAll('.feed-speech')).toHaveLength(1)
    expect(feed.querySelector('.feed-speech .feed-bubble')!.textContent).toContain('$3M 起')
    const minors = feed.querySelectorAll('.feed-minor')
    expect(minors).toHaveLength(1)
    expect(minors[0].textContent).toMatch(/跳过/)
    expect(feed.querySelector('.feed-event:not(.feed-minor)')).not.toBeNull() // 开单事件
  })

  it('气泡带人物主题色变量；视角玩家自己的话靠右（mine）', () => {
    const s = step(biddingState(1, 0), { type: 'SPEAK', playerId: 0, say: '我先报个价' })
    const { container } = renderAs(<NegotiationPanel state={s} />, 0)
    const line = container.querySelector('.feed-speech.mine') as HTMLElement
    expect(line).not.toBeNull()
    expect(line.style.getPropertyValue('--seat-accent')).not.toBe('')
  })

  it('新到的条目带入场高亮，挂载时已有的不带', () => {
    const before = biddingState(0)
    const { container, rerender } = renderAs(<NegotiationPanel state={before} />)
    expect(container.querySelectorAll('.neg-feed .feed-new')).toHaveLength(0)
    const after = step(before, { type: 'SPEAK', playerId: 1, say: '来了' })
    rerender(<NegotiationPanel state={after} />)
    const fresh = container.querySelectorAll('.neg-feed .feed-new')
    expect(fresh).toHaveLength(1)
    expect(fresh[0].textContent).toContain('来了')
  })

})

/** 0 号是 Boss；1 号打出 A 家族卡入场（电脑玩家的出牌） */
function withClan(): { before: GameState; after: GameState } {
  const before = biddingState(0)
  clearHand(before, 1)
  const [card] = giveCards(before, 1, [{ type: 'CLAN', familyId: 'A' }])
  const after = step(before, { type: 'PLAY_CLAN', playerId: 1, cardId: card.id })
  return { before, after }
}

describe('RecentStrip：刚刚发生', () => {
  it('刚开局：占位提示；成交后显示最近至多 3 条', () => {
    const empty = renderAs(<RecentStrip state={placeMarkerState()} />)
    expect(empty.container.querySelector('.recent-empty')).not.toBeNull()
    cleanup()
    const { container } = renderAs(<RecentStrip state={closedDealState()} />)
    const items = container.querySelectorAll('.recent-item')
    expect(items.length).toBeGreaterThan(0)
    expect(items.length).toBeLessThanOrEqual(3)
    expect(items[items.length - 1].textContent).toContain('成交')
  })

  it('新事件到来时新条目入场高亮', () => {
    const { before, after } = withClan()
    const { container, rerender } = renderAs(<RecentStrip state={before} />)
    expect(container.querySelectorAll('.recent-item.feed-new')).toHaveLength(0)
    rerender(<RecentStrip state={after} />)
    expect(container.querySelectorAll('.recent-item.feed-new').length).toBeGreaterThan(0)
  })
})

describe('ToastLayer：行动提示', () => {
  beforeEach(() => { vi.useFakeTimers() })

  it('电脑玩家的出牌弹出提示，到时间自动消失', () => {
    const { before, after } = withClan()
    const { container, rerender } = renderAs(<ToastLayer state={before} />)
    expect(container.querySelectorAll('.toast')).toHaveLength(0)
    rerender(<ToastLayer state={after} />)
    expect(container.querySelectorAll('.toast')).toHaveLength(1)
    act(() => { vi.advanceTimersByTime(1500) })
    expect(container.querySelectorAll('.toast')).toHaveLength(1)
    act(() => { vi.advanceTimersByTime(3000) })
    expect(container.querySelectorAll('.toast')).toHaveLength(0)
  })

  it('点击关闭', () => {
    const { before, after } = withClan()
    const { container, rerender } = renderAs(<ToastLayer state={before} />)
    rerender(<ToastLayer state={after} />)
    fireEvent.click(container.querySelector('.toast')!)
    expect(container.querySelectorAll('.toast')).toHaveLength(0)
  })

  it('挂载时已有的事件不会补弹（载入存档 / 切换界面）', () => {
    const { container } = renderAs(<ToastLayer state={closedDealState()} />)
    expect(container.querySelectorAll('.toast')).toHaveLength(0)
  })

  it('你自己的出牌不回声；打向你的牌是醒目提示', () => {
    // 视角 0：自己出家族卡 → 无提示
    const own = biddingState(1, 0)
    clearHand(own, 0)
    const [mine] = giveCards(own, 0, [{ type: 'CLAN', familyId: 'B' }])
    const ownAfter = step(own, { type: 'PLAY_CLAN', playerId: 0, cardId: mine.id })
    const a = renderAs(<ToastLayer state={own} />, 0)
    a.rerender(<ToastLayer state={ownAfter} />)
    expect(a.container.querySelectorAll('.toast')).toHaveLength(0)
    cleanup()

    // 1 号对 0 号的 A 代表打旅行牌 → 0 号看到醒目（mine）提示
    const base = biddingState(2, 1)
    clearHand(base, 1)
    const [travel] = giveCards(base, 1, [{ type: 'TRAVEL', familyId: 'A' }])
    const target = base.negotiation!.reps.find(r => r.ownerId === 0)!
    const hit = step(base, { type: 'PLAY_TRAVEL', playerId: 1, cardId: travel.id, targetRepKey: target.key })
    const b = renderAs(<ToastLayer state={base} />, 0)
    b.rerender(<ToastLayer state={hit} />)
    const toast = b.container.querySelector('.toast')!
    expect(toast.classList.contains('mine')).toBe(true)
    expect(toast.classList.contains('tone-bad')).toBe(true)
  })

  it('反应窗口里不提示"谁在考虑"：只有跳过 / 放行时不出任何提示', () => {
    let s = biddingState(1, 0)
    clearHand(s, 0)
    giveCards(s, 0, [{ type: 'TRAVEL' }])
    const card = s.players[0].hand[0]
    const target = s.negotiation!.reps.find(r => r.ownerId === 1)!
    s = step(s, { type: 'PLAY_TRAVEL', playerId: 0, cardId: card.id, targetRepKey: target.key })
    const { container, rerender } = renderAs(<ToastLayer state={s} />, 0)
    // 其他人依次放行（已 clearHand，保证没有阻止牌的人放行；有阻止牌的人也只是放行）
    let guard = 0
    while (s.phase === 'REACTION' && guard++ < 6) {
      const reactor = getActingPlayerId(s)
      s = step(s, { type: 'PASS_REACTION', playerId: reactor })
      rerender(<ToastLayer state={s} />)
      if (s.phase === 'REACTION') expect(container.querySelectorAll('.toast')).toHaveLength(0)
    }
  })

  it('换了一局（事件 id 倒退）：清掉旧提示', () => {
    const { before, after } = withClan()
    const { container, rerender } = renderAs(<ToastLayer state={before} />)
    rerender(<ToastLayer state={after} />)
    expect(container.querySelectorAll('.toast')).toHaveLength(1)
    rerender(<ToastLayer state={placeMarkerState()} />)
    expect(container.querySelectorAll('.toast')).toHaveLength(0)
  })
})

describe('DealResultCard：交易结算卡', () => {
  /** 成交最后一步之前 / 之后的两个状态 */
  function closing(): { before: GameState; after: GameState } {
    let s = closingState()
    let prev = s
    while (s.phase === 'CLOSING') { prev = s; s = step(s, { type: 'PASS_CLOSING', playerId: getActingPlayerId(s) }) }
    return { before: prev, after: s }
  }

  it('成交：显示 Boss、每人所得与你的收益；挂载时已有的历史不弹', () => {
    const { before, after } = closing()
    const loaded = renderAs(<DealResultCard state={after} />)
    expect(loaded.container.querySelector('.deal-result')).toBeNull()
    cleanup()

    const { container, rerender } = renderAs(<DealResultCard state={before} />)
    expect(container.querySelector('.deal-result')).toBeNull()
    rerender(<DealResultCard state={after} />)
    const card = container.querySelector('.deal-result.ok')!
    expect(card).not.toBeNull()
    expect(card.querySelectorAll('.deal-result-rows li').length).toBeGreaterThanOrEqual(1)
    expect(card.querySelector('.deal-result-rows li.mine')).not.toBeNull() // 0 号是 Boss
    expect(card.querySelector('.deal-result-you.gain')).not.toBeNull()
  })

  it('流局：显示原因；可点"查看详情"并收起', () => {
    const before = toBoss(openDealAt(placeMarkerState(), 1, 0))
    const after = abandonedDealState()
    const onDetails = vi.fn()
    const { container, rerender, getByRole } = renderAs(<DealResultCard state={before} onDetails={onDetails} />)
    rerender(<DealResultCard state={after} onDetails={onDetails} />)
    expect(container.querySelector('.deal-result.fail')).not.toBeNull()
    expect(container.querySelector('.deal-result-reason')!.textContent).toBeTruthy()
    fireEvent.click(getByRole('button', { name: '查看详情' }))
    expect(onDetails).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.deal-result')).toBeNull()
  })

  it('点"收起"关闭；到时间自动消失', () => {
    vi.useFakeTimers()
    const { before, after } = closing()
    const { container, rerender, getByRole } = renderAs(<DealResultCard state={before} duration={3000} />)
    rerender(<DealResultCard state={after} duration={3000} />)
    expect(container.querySelector('.deal-result')).not.toBeNull()
    act(() => { vi.advanceTimersByTime(3100) })
    expect(container.querySelector('.deal-result')).toBeNull()

    rerender(<DealResultCard state={before} duration={3000} />) // 历史回退视为换局
    rerender(<DealResultCard state={after} duration={3000} />)
    fireEvent.click(getByRole('button', { name: '收起' }))
    expect(container.querySelector('.deal-result')).toBeNull()
  })

  it('终局那一笔不弹（终局有自己的结果卡）', () => {
    const { before, after } = closing()
    const over: GameState = { ...after, phase: 'GAME_OVER' }
    const { container, rerender } = renderAs(<DealResultCard state={before} />)
    rerender(<DealResultCard state={over} />)
    expect(container.querySelector('.deal-result')).toBeNull()
  })
})
