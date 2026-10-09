// @vitest-environment jsdom
// TableBoard：版图 + 座位；信息隐藏（REACTION / CLOSING 不暴露"谁在行动 / 思考"）；放置标记以视角玩家为准

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import TableBoard from '../../src/components/TableBoard'
import type { GameState } from '../../src/engine/types'
import { biddingState, closingState, placeMarkerState, renderAs, step, giveCards, clearHand } from './fixtures'

// jsdom 没有 ResizeObserver，版图的自适应缩放用到它
beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(cleanup)

const seats = (c: HTMLElement) => [...c.querySelectorAll('.player-seat')]
const acting = (c: HTMLElement) => seats(c).map((el, i) => el.classList.contains('acting') ? i : -1).filter(i => i >= 0)
const thinking = (c: HTMLElement) => seats(c).map((el, i) => el.querySelector('.seat-thinking') ? i : -1).filter(i => i >= 0)

/** 0 号打出旅行牌 → REACTION，依次询问其他人 */
function reactionState(): GameState {
  const s = biddingState(1, 0)
  clearHand(s, 0)
  giveCards(s, 0, [{ type: 'TRAVEL' }])
  const card = s.players[0].hand[0]
  const target = s.negotiation!.reps.find(r => r.ownerId === 1)!
  return step(s, { type: 'PLAY_TRAVEL', playerId: 0, cardId: card.id, targetRepKey: target.key })
}

describe('TableBoard', () => {
  it('冒烟：每格一个格子、每位玩家一个座位', () => {
    const s = placeMarkerState()
    const { container } = renderAs(<TableBoard state={s} thinkingId={null} />)
    expect(container.querySelectorAll('.ring-cell')).toHaveLength(s.board.length)
    expect(seats(container)).toHaveLength(s.players.length)
  })

  it('谈判中（不属于需要隐藏的阶段）：行动者与思考状态照常显示', () => {
    const s = biddingState(1, 2)
    const { container } = renderAs(<TableBoard state={s} thinkingId={2} />, 0)
    expect(acting(container)).toEqual([2])
    expect(thinking(container)).toEqual([2])
  })

  it('CLOSING：AI 行动者与思考中被隐藏（不暴露谁手里有干扰牌）', () => {
    const s = closingState() // 0 号宣布成交，轮到 1 号放行
    expect(s.phase).toBe('CLOSING')
    const { container } = renderAs(<TableBoard state={s} thinkingId={1} />, 0)
    expect(acting(container)).toEqual([])
    expect(thinking(container)).toEqual([])
  })

  it('CLOSING 轮到视角玩家自己：照常显示', () => {
    const s = closingState()
    const { container } = renderAs(<TableBoard state={s} thinkingId={1} />, 1)
    expect(acting(container)).toEqual([1])
    expect(thinking(container)).toEqual([1])
  })

  it('REACTION：同样隐藏别人，自己行动时显示', () => {
    const s = reactionState()
    expect(s.phase).toBe('REACTION')
    const hidden = renderAs(<TableBoard state={s} thinkingId={2} />, 0)
    expect(acting(hidden.container)).toEqual([])
    expect(thinking(hidden.container)).toEqual([])
    cleanup()
    const actor = s.pendingReaction!.reactorId
    const shown = renderAs(<TableBoard state={s} thinkingId={actor} />, actor)
    expect(acting(shown.container)).toEqual([actor])
  })

  it('放置标记：只有视角玩家是放置者时格子可点，点击回调格子 id', async () => {
    const s = placeMarkerState()
    const chooser = s.markerChooserId!
    const other = (chooser + 1) % s.players.length
    const onPlace = vi.fn()

    const notMine = renderAs(<TableBoard state={s} thinkingId={null} onPlaceMarker={onPlace} />, other)
    expect(notMine.container.querySelectorAll('.ring-cell.selectable')).toHaveLength(0)
    cleanup()

    const mine = renderAs(<TableBoard state={s} thinkingId={null} onPlaceMarker={onPlace} />, chooser)
    const cells = mine.container.querySelectorAll('.ring-cell.selectable')
    expect(cells).toHaveLength(s.board.length)
    await userEvent.setup().click(cells[2])
    expect(onPlace).toHaveBeenCalledWith(s.board[2].id)
  })
})
