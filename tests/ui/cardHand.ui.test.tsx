// @vitest-environment jsdom
// CardHand：显示视角玩家的手牌；可打的牌由合法动作驱动；点牌弹层里发出正确动作

import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CardHand from '../../src/components/CardHand'
import type { GameState } from '../../src/engine/types'
import { biddingState, clearHand, giveCards, legalFor, renderAs, actSpy } from './fixtures'

afterEach(cleanup)

/** 叫价轮，轮到 0 号；0 号手里 家族B + 阻止，1 号手里 两张万能旅行 + 老板 */
function handsState(): GameState {
  const s = biddingState(1, 0)
  clearHand(s, 0)
  clearHand(s, 1)
  giveCards(s, 0, [{ type: 'CLAN', familyId: 'B' }, { type: 'STOP' }])
  giveCards(s, 1, [{ type: 'TRAVEL' }, { type: 'TRAVEL' }, { type: 'BOSS' }])
  return s
}

function hand(s: GameState, viewerId = 0, extra: Partial<Parameters<typeof CardHand>[0]> = {}) {
  const { act, last } = actSpy()
  const view = renderAs(
    <CardHand
      state={s} legal={legalFor(s, viewerId)} act={act}
      selectMode={null} selection={new Set<number>()} onToggleSelect={() => {}}
      {...extra}
    />,
    viewerId,
  )
  return { ...view, act, last }
}

const cardsOf = (c: HTMLElement) => [...c.querySelectorAll('.hand-cards .card')]

describe('CardHand', () => {
  it('冒烟：渲染视角玩家的每张手牌', () => {
    const s = handsState()
    const { container } = hand(s, 0)
    expect(cardsOf(container)).toHaveLength(s.players[0].hand.length)
  })

  it('viewerId 改成 1：显示 1 号玩家的牌，而不是 0 号的', () => {
    const s = handsState()
    const { container } = hand(s, 1)
    const cards = cardsOf(container)
    expect(cards).toHaveLength(3)
    expect(cards.map(c => c.classList.contains('type-travel'))).toEqual([true, true, false])
    expect(container.querySelector('.type-clan')).toBeNull()
  })

  it('可打的家族卡：点牌 → 弹层 → 打出，动作带该牌 id 与视角玩家', async () => {
    const user = userEvent.setup()
    const s = handsState()
    const clan = s.players[0].hand.find(c => c.type === 'CLAN')!
    const { container, last } = hand(s, 0)
    const el = cardsOf(container).find(c => c.classList.contains('type-clan'))!
    expect(el.classList.contains('playable')).toBe(true)
    await user.click(el)
    const pop = container.querySelector('.card-popover') as HTMLElement
    expect(pop).not.toBeNull()
    await user.type(within(pop).getAllByRole('spinbutton')[0], '4')
    await user.click(within(pop).getByRole('button', { name: '打出' }))
    expect(last()).toMatchObject({ type: 'PLAY_CLAN', playerId: 0, cardId: clan.id, demand: 4 })
  })

  it('当前不能打的牌点了没有弹层', async () => {
    const user = userEvent.setup()
    const s = handsState()
    const { container, act } = hand(s, 0)
    const stop = cardsOf(container).find(c => c.classList.contains('type-stop'))!
    expect(stop.classList.contains('playable')).toBe(false)
    await user.click(stop)
    expect(container.querySelector('.card-popover')).toBeNull()
    expect(act).not.toHaveBeenCalled()
  })

  it('选牌模式：点牌调用 onToggleSelect，而不是弹层', async () => {
    const user = userEvent.setup()
    const s = handsState()
    const onToggle = vi.fn()
    const { container } = hand(s, 0, { selectMode: 'discard', onToggleSelect: onToggle })
    await user.click(cardsOf(container)[0])
    expect(onToggle).toHaveBeenCalledWith(s.players[0].hand[0].id)
    expect(container.querySelector('.card-popover')).toBeNull()
  })

  it('没有该视角玩家时不渲染', () => {
    const s = handsState()
    const { container } = hand(s, 9)
    expect(container.innerHTML).toBe('')
    expect(screen.queryByRole('button')).toBeNull()
  })
})
