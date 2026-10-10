// @vitest-environment jsdom
// ActionDock：按阶段渲染按钮；点击发出的动作对象正确（playerId 跟随视角）

import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ActionDock from '../../src/components/ActionDock'
import type { GameState } from '../../src/engine/types'
import {
  biddingState, bossPlanningState, offerResponseState, closingState, turnState, legalFor, renderAs, actSpy,
} from './fixtures'

afterEach(cleanup)

function dock(s: GameState, viewerId = 0, extra: Partial<Parameters<typeof ActionDock>[0]> = {}) {
  const { act, last } = actSpy()
  const onOpenOfferEditor = vi.fn()
  const view = renderAs(
    <ActionDock
      state={s} legal={legalFor(s, viewerId)} act={act}
      selection={new Set<number>()} selectMode={null}
      onToggleTradeMode={() => {}} onOpenOfferEditor={onOpenOfferEditor}
      {...extra}
    />,
    viewerId,
  )
  return { ...view, act, last, onOpenOfferEditor }
}

describe('ActionDock 冒烟与各阶段动作', () => {
  it('回合开始：发起交易 / 掷骰发出以视角玩家为行动者的动作', async () => {
    const user = userEvent.setup()
    const { act } = dock(turnState(0))
    await user.click(screen.getByRole('button', { name: /发起/ }))
    await user.click(screen.getByRole('button', { name: /掷骰/ }))
    expect(act.mock.calls.map(c => c[0])).toEqual([
      { type: 'OPEN_DEAL', playerId: 0 },
      { type: 'ROLL_MOVE', playerId: 0 },
    ])
  })

  it('非 Boss 填价后报价：发出带 quotes 的 SPEAK', async () => {
    const user = userEvent.setup()
    const s = biddingState(1, 0) // 1 号是 Boss，轮到持有 A 的 0 号叫价
    const { container, last } = dock(s)
    await user.type(container.querySelector('input.demand-input')!, '3')
    await user.click(screen.getByRole('button', { name: /^报价/ }))
    const a = last()!
    expect(a.type).toBe('SPEAK')
    expect(a).toMatchObject({ playerId: 0, quotes: [{ familyId: 'A', amount: 3 }] })
    expect((a as { say: string }).say).toBeTruthy() // 只填价没写台词：自动生成一句
  })

  it('没填任何内容时报价按钮不可点', () => {
    const { container } = dock(biddingState(1, 0))
    expect((screen.getByRole('button', { name: /喊话/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(container.querySelector('input.demand-input')).not.toBeNull()
  })

  it('非 Boss 跳过：PASS', async () => {
    const user = userEvent.setup()
    const { last } = dock(biddingState(1, 0))
    await user.click(screen.getByRole('button', { name: /^跳过/ }))
    expect(last()).toEqual({ type: 'PASS', playerId: 0 })
  })

  it('Boss 编方案阶段：提出方案按钮打开编辑器；没有全员同意的方案时不能宣布成交', async () => {
    const user = userEvent.setup()
    const { onOpenOfferEditor } = dock(bossPlanningState(0))
    await user.click(screen.getByRole('button', { name: /提出方案/ }))
    expect(onOpenOfferEditor).toHaveBeenCalledTimes(1)
    expect((screen.getByRole('button', { name: /宣布成交/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('Boss 放弃交易需二次确认', async () => {
    const user = userEvent.setup()
    const { act, last } = dock(bossPlanningState(0))
    await user.click(screen.getByRole('button', { name: /放弃交易/ }))
    expect(act).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '确定' }))
    expect(last()).toEqual({ type: 'ABANDON_DEAL', playerId: 0 })
  })

  it('视角换成 1 号：方案应答按钮发出 1 号的动作', async () => {
    const user = userEvent.setup()
    const s = offerResponseState()
    const { last, unmount } = dock(s, 1)
    await user.click(screen.getByRole('button', { name: /同意出借/ }))
    expect(last()).toEqual({ type: 'ACCEPT_OFFER', playerId: 1 })
    unmount()
    const again = dock(s, 1)
    await user.click(screen.getByRole('button', { name: /拒绝/ }))
    expect(again.last()).toMatchObject({ type: 'DECLINE_OFFER', playerId: 1 })
  })

  it('成交倒计时：轮到视角玩家时有放行按钮；不是他时只有等待提示', async () => {
    const user = userEvent.setup()
    const s = closingState() // 0 号宣布成交，先问 1 号
    const mine = dock(s, 1)
    await user.click(screen.getByRole('button', { name: '放行' }))
    expect(mine.last()).toEqual({ type: 'PASS_CLOSING', playerId: 1 })
    mine.unmount()

    const other = dock(s, 0)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(other.container.querySelector('.dock-wait')).not.toBeNull()
  })
})
