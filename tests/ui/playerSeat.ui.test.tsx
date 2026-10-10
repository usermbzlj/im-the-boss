// @vitest-environment jsdom
// PlayerSeat：座位卡；"你"标记跟随视角；Boss / 行动 / 思考 / 报价徽标

import { describe, it, expect, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import PlayerSeat from '../../src/components/PlayerSeat'
import { biddingState, placeMarkerState, renderAs, step } from './fixtures'

afterEach(cleanup)

describe('PlayerSeat', () => {
  it('冒烟：名字、现金、手牌数', () => {
    const s = placeMarkerState()
    s.players[2].cash = 7
    const { container } = renderAs(<PlayerSeat state={s} playerId={2} isActing={false} isThinking={false} />)
    expect(container.querySelector('.seat-name')!.textContent).toContain(s.players[2].name)
    expect(container.querySelector('.seat-cash')!.textContent).toContain('7')
    expect(container.querySelector('.seat-meta')!.textContent).toContain(String(s.players[2].hand.length))
  })

  it('"你"标记只在视角玩家的座位上', () => {
    const s = placeMarkerState()
    const as0 = renderAs(<PlayerSeat state={s} playerId={0} isActing={false} isThinking={false} />, 0)
    expect(as0.container.querySelector('.seat-you')).not.toBeNull()
    cleanup()
    const as1 = renderAs(<PlayerSeat state={s} playerId={0} isActing={false} isThinking={false} />, 1)
    expect(as1.container.querySelector('.seat-you')).toBeNull()
    expect(as1.container.querySelector('.player-seat')!.classList.contains('is-human')).toBe(false)
    cleanup()
    const seat1 = renderAs(<PlayerSeat state={s} playerId={1} isActing={false} isThinking={false} />, 1)
    expect(seat1.container.querySelector('.seat-you')).not.toBeNull()
  })

  it('行动 / 思考 / Boss 徽标', () => {
    const s = biddingState(1, 0)
    const boss = renderAs(<PlayerSeat state={s} playerId={1} isActing isThinking />)
    expect(boss.container.querySelector('.player-seat')!.classList.contains('acting')).toBe(true)
    expect(boss.container.querySelector('.seat-boss')).not.toBeNull()
    expect(boss.container.querySelector('.seat-thinking')).not.toBeNull()
    cleanup()
    const idle = renderAs(<PlayerSeat state={s} playerId={2} isActing={false} isThinking={false} />)
    expect(idle.container.querySelector('.seat-boss')).toBeNull()
    expect(idle.container.querySelector('.seat-thinking')).toBeNull()
  })

  it('公开报价显示在座位上', () => {
    const s = step(biddingState(1, 0), { type: 'SPEAK', playerId: 0, say: '三百万', quotes: [{ familyId: 'A', amount: 3 }] })
    const { container } = renderAs(<PlayerSeat state={s} playerId={0} isActing={false} isThinking={false} />)
    expect(container.querySelector('.seat-demand')!.textContent).toContain('3')
  })

  it('不存在的座位：不渲染', () => {
    const { container } = renderAs(<PlayerSeat state={placeMarkerState()} playerId={9} isActing={false} isThinking={false} />)
    expect(container.innerHTML).toBe('')
  })
})
