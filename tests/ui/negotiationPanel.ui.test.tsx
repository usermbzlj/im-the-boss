// @vitest-environment jsdom
// NegotiationPanel：只读谈判桌视图；"（你）"与"我的喊话"跟随视角

import { describe, it, expect, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import NegotiationPanel from '../../src/components/NegotiationPanel'
import { biddingState, offerResponseState, placeMarkerState, renderAs, step } from './fixtures'

afterEach(cleanup)

describe('NegotiationPanel', () => {
  it('没有进行中的交易：不渲染谈判内容', () => {
    const { container } = renderAs(<NegotiationPanel state={placeMarkerState()} />)
    expect(container.querySelector('.neg-panel')).toBeNull()
  })

  it('叫价轮冒烟：Boss 标签、需求组席位、"还没有方案"', () => {
    const s = biddingState(1, 0)
    const { container } = renderAs(<NegotiationPanel state={s} />)
    expect(container.querySelector('.boss-tag')).not.toBeNull()
    expect(container.querySelectorAll('.fam-row').length).toBeGreaterThanOrEqual(2) // 1 号格需要 A + B
    expect(container.querySelector('.offer-view')).toBeNull()
  })

  it('Boss 标签的"（你）"只出现在视角玩家身上', () => {
    const s = biddingState(1, 0)
    const asBoss = renderAs(<NegotiationPanel state={s} />, 1)
    expect(asBoss.container.querySelector('.boss-tag')!.textContent).toContain('（你）')
    cleanup()
    const asOther = renderAs(<NegotiationPanel state={s} />, 0)
    expect(asOther.container.querySelector('.boss-tag')!.textContent).not.toContain('（你）')
  })

  it('喊话记录：视角玩家自己的话带 mine 样式', () => {
    const s = step(biddingState(1, 0), { type: 'SPEAK', playerId: 0, say: '价码好商量' })
    const me = renderAs(<NegotiationPanel state={s} />, 0)
    expect(me.container.querySelectorAll('.chat-line.mine')).toHaveLength(1)
    cleanup()
    const other = renderAs(<NegotiationPanel state={s} />, 2)
    expect(other.container.querySelectorAll('.chat-line')).toHaveLength(1)
    expect(other.container.querySelectorAll('.chat-line.mine')).toHaveLength(0)
  })

  it('方案应答阶段：显示当前方案与待表态的持有者', () => {
    const s = offerResponseState()
    const { container } = renderAs(<NegotiationPanel state={s} />, 1)
    expect(container.querySelector('.offer-view')).not.toBeNull()
    expect(container.querySelectorAll('.offer-status .resp.wait').length).toBeGreaterThan(0)
  })
})
