// @vitest-environment jsdom
// OfferEditor：Boss 编方案并提交；点遮罩不关闭，Esc / 取消在有改动时先确认

import { describe, it, expect, vi, afterEach, beforeEach, type MockInstance } from 'vitest'
import { cleanup, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import OfferEditor from '../../src/components/OfferEditor'
import type { GameState } from '../../src/engine/types'
import { bossPlanningState, renderAs } from './fixtures'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function editor(s: GameState = bossPlanningState(0), viewerId = 0) {
  const onSubmit = vi.fn()
  const onClose = vi.fn()
  const view = renderAs(<OfferEditor state={s} onSubmit={onSubmit} onClose={onClose} />, viewerId)
  const payInput = () => view.container.querySelector('.payout-row input[type="number"]') as HTMLInputElement
  return { ...view, onSubmit, onClose, payInput }
}

/** 给第一个分成输入框填 2：制造一处"未提交的改动" */
async function makeDirty(payInput: () => HTMLInputElement) {
  const user = userEvent.setup()
  await user.clear(payInput())
  await user.type(payInput(), '2')
  return user
}

describe('OfferEditor', () => {
  it('冒烟：对话框、选用代表区、分成区、提交与取消按钮', () => {
    const { container } = editor()
    expect(screen.getByRole('dialog')).not.toBeNull()
    expect(container.querySelectorAll('.offer-family').length).toBeGreaterThanOrEqual(2)
    expect(container.querySelectorAll('.payout-row').length).toBe(3) // 除 Boss 外的 3 位
    expect(screen.getByRole('button', { name: '提出方案' })).not.toBeNull()
  })

  it('填分成后提交：onSubmit 收到所选代表与分成', async () => {
    const { onSubmit, payInput } = editor()
    const user = await makeDirty(payInput)
    await user.click(screen.getByRole('button', { name: '提出方案' }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const [repKeys, payouts] = onSubmit.mock.calls[0]
    expect(repKeys).toHaveLength(2)
    expect(payouts).toHaveLength(1)
    expect(payouts[0].amount).toBe(2)
  })

  it('分成超过总额时结构非法：提交按钮置灰', async () => {
    const { payInput } = editor()
    const user = userEvent.setup()
    await user.clear(payInput())
    await user.type(payInput(), '999')
    expect((screen.getByRole('button', { name: '提出方案' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('分成行的"（你）"标记跟随视角', () => {
    const { container } = editor(bossPlanningState(0), 2)
    const names = [...container.querySelectorAll('.payout-name')].map(n => n.textContent ?? '')
    expect(names.filter(t => t.includes('（你）'))).toHaveLength(1)
    expect(names.findIndex(t => t.includes('（你）'))).toBe(1) // Boss 之外依次是 1、2、3 号，2 号排第 2
  })

  describe('关闭规则', () => {
    let confirmSpy: MockInstance<typeof window.confirm>
    beforeEach(() => { confirmSpy = vi.spyOn(window, 'confirm') })

    it('点遮罩不关闭（哪怕没有改动）', async () => {
      const { container, onClose } = editor()
      await userEvent.setup().click(container.querySelector('.modal-overlay')!)
      expect(onClose).not.toHaveBeenCalled()
    })

    it('没有改动：Esc / 取消直接关闭，不弹确认', async () => {
      const { onClose } = editor()
      fireEvent.keyDown(document, { key: 'Escape' })
      await userEvent.setup().click(screen.getByRole('button', { name: '取消' }))
      expect(onClose).toHaveBeenCalledTimes(2)
      expect(confirmSpy).not.toHaveBeenCalled()
    })

    it('有改动：Esc 先确认；拒绝则不关，确认才关', async () => {
      const { onClose, payInput } = editor()
      await makeDirty(payInput)
      confirmSpy.mockReturnValueOnce(false)
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(confirmSpy).toHaveBeenCalledTimes(1)
      expect(onClose).not.toHaveBeenCalled()
      confirmSpy.mockReturnValueOnce(true)
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('有改动：点取消同样先确认', async () => {
      const { onClose, payInput } = editor()
      const user = await makeDirty(payInput)
      confirmSpy.mockReturnValueOnce(false)
      await user.click(screen.getByRole('button', { name: '取消' }))
      expect(onClose).not.toHaveBeenCalled()
      confirmSpy.mockReturnValueOnce(true)
      await user.click(screen.getByRole('button', { name: '取消' }))
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('改了又改回原值：不算有改动', async () => {
      const { onClose, payInput } = editor()
      const user = await makeDirty(payInput)
      await user.clear(payInput())
      await user.type(payInput(), '0')
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(confirmSpy).not.toHaveBeenCalled()
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })
})
