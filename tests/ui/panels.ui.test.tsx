// @vitest-environment jsdom
// 周边面板的 bug 修复回归：设置面板重开 / 关闭规则、终局排名并列、交易历史口径、侧栏标签自动切换、阶段引导不泄露行动者

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { cleanup, screen, fireEvent, renderHook, act, render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SettingsPanel from '../../src/components/SettingsPanel'
import GameOverCard, { rankStandings } from '../../src/components/GameOverCard'
import DealHistoryPanel, { dealTotals } from '../../src/components/DealHistoryPanel'
import PhaseGuide from '../../src/components/PhaseGuide'
import { useSideTab } from '../../src/components/useSideTab'
import { loadLLMConfig, saveLLMConfig, DEFAULT_LLM_CONFIG } from '../../src/ai/llmClient'
import type { DealRecord } from '../../src/engine/types'
import { closingState, gameOverState, renderAs } from './fixtures'

beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('SettingsPanel', () => {
  const modelInput = () => screen.getByPlaceholderText('gpt-4o-mini') as HTMLInputElement

  it('关闭后未保存的修改不残留：重新打开从已保存配置载入', async () => {
    saveLLMConfig({ ...DEFAULT_LLM_CONFIG, model: 'saved-model' })
    const user = userEvent.setup()
    const { rerender } = render(<SettingsPanel open onClose={() => {}} />)
    expect(modelInput().value).toBe('saved-model')
    await user.clear(modelInput())
    await user.type(modelInput(), 'draft-model')
    rerender(<SettingsPanel open={false} onClose={() => {}} />)
    rerender(<SettingsPanel open onClose={() => {}} />)
    expect(modelInput().value).toBe('saved-model')
  })

  it('保存后写入配置并关闭', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<SettingsPanel open onClose={onClose} />)
    await user.clear(modelInput())
    await user.type(modelInput(), 'm1')
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(loadLLMConfig().model).toBe('m1')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('点遮罩不关闭；无改动 Esc 直接关；有改动 Esc 先确认', async () => {
    const onClose = vi.fn()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const user = userEvent.setup()
    const { container } = render(<SettingsPanel open onClose={onClose} />)
    await user.click(container.querySelector('.modal-overlay')!)
    expect(onClose).not.toHaveBeenCalled()

    await user.type(modelInput(), 'x')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()

    confirmSpy.mockReturnValue(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('没有改动时 Esc 直接关闭，不弹确认', () => {
    const onClose = vi.fn()
    const confirmSpy = vi.spyOn(window, 'confirm')
    render(<SettingsPanel open onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(confirmSpy).not.toHaveBeenCalled()
  })
})

describe('终局排名', () => {
  it('rankStandings：并列同名次，之后跳号（1、1、3）', () => {
    const s = gameOverState([10, 10, 4])
    expect(rankStandings(s.players).map(x => x.rank)).toEqual([1, 1, 3])
    expect(rankStandings(s.players).map(x => x.tied)).toEqual([true, true, false])
  })

  it('结果卡：并列者显示同一名次，不再 1、2、3', () => {
    const s = gameOverState([10, 10, 4])
    const { container } = renderAs(<GameOverCard state={s} onRestart={() => {}} onReview={() => {}} />)
    expect([...container.querySelectorAll('.standing')].map(el => el.getAttribute('data-rank'))).toEqual(['1', '1', '3'])
    expect(container.querySelectorAll('.standing.winner')).toHaveLength(2)
  })

  it('无并列：名次依次 1、2、3；按钮回调', async () => {
    const onRestart = vi.fn(), onReview = vi.fn()
    const user = userEvent.setup()
    const s = gameOverState([3, 9, 5])
    const { container } = renderAs(<GameOverCard state={s} onRestart={onRestart} onReview={onReview} />, 1)
    expect([...container.querySelectorAll('.standing')].map(el => el.getAttribute('data-rank'))).toEqual(['1', '2', '3'])
    await user.click(screen.getByRole('button', { name: '再来一局' }))
    await user.click(screen.getByRole('button', { name: '回牌桌复盘' }))
    expect(onRestart).toHaveBeenCalledTimes(1)
    expect(onReview).toHaveBeenCalledTimes(1)
  })
})

describe('DealHistoryPanel 累计口径', () => {
  const rec = (over: Partial<DealRecord>): DealRecord => ({
    id: 1, dealNumber: 1, spaceId: 1, bossId: 0, openerId: 0, success: true, grossValue: 10,
    payouts: [{ playerId: 1, amount: 4 }], rents: [], disruptors: [], ...over,
  })

  it('dealTotals = Boss 净得 + 分成 + 地标租金；流局不计', () => {
    const totals = dealTotals([
      rec({ rents: [{ playerId: 2, amount: 1 }] }),
      rec({ id: 2, dealNumber: 2, bossId: 1, grossValue: 8, payouts: [], rents: [{ playerId: 2, amount: 1 }] }),
      rec({ id: 3, dealNumber: 3, success: false, grossValue: 50 }),
    ])
    expect(Object.fromEntries(totals)).toEqual({ 0: 6, 1: 4 + 8, 2: 2 })
  })

  it('开局现金为 0：关桌规时累计收入等于每人现金，并标注口径与现金', () => {
    // 两笔成交：0 号 Boss 净得 6、1 号分成 4、2 号收租 2；1 号当 Boss 独吞 8 → 现金 6 / 12 / 2
    const s = gameOverState([6, 12, 2])
    s.dealHistory = [rec({ rents: [{ playerId: 2, amount: 2 }] }), rec({ id: 2, dealNumber: 2, bossId: 1, grossValue: 8, payouts: [] })]
    const totals = dealTotals(s.dealHistory)
    for (const p of s.players) expect(totals.get(p.id)).toBe(p.cash)
    const { container } = render(<DealHistoryPanel state={s} />)
    expect(container.querySelector('[data-testid="totals-caption"]')).not.toBeNull()
    expect(container.querySelectorAll('.totals-chip')).toHaveLength(3)
  })
})

describe('useSideTab', () => {
  it('谈判开始自动切到谈判桌，结束退回日志', () => {
    const { result, rerender } = renderHook(({ neg }) => useSideTab(neg, true), { initialProps: { neg: false } })
    expect(result.current.sideTab).toBe('log')
    rerender({ neg: true })
    expect(result.current.sideTab).toBe('neg')
    rerender({ neg: false })
    expect(result.current.sideTab).toBe('log')
  })

  it('用户手动选过标签后，谈判开始不再抢切；结束时停在历史页也不被拽回', () => {
    const { result, rerender } = renderHook(({ neg }) => useSideTab(neg, true), { initialProps: { neg: false } })
    act(() => result.current.pickTab('history'))
    rerender({ neg: true })
    expect(result.current.sideTab).toBe('history')
    rerender({ neg: false })
    expect(result.current.sideTab).toBe('history')
  })

  it('停在谈判桌上时谈判结束，必须退回日志（标签已不存在）', () => {
    const { result, rerender } = renderHook(({ neg }) => useSideTab(neg, true), { initialProps: { neg: true } })
    act(() => result.current.pickTab('neg'))
    rerender({ neg: false })
    expect(result.current.sideTab).toBe('log')
  })

  it('离开对局后清除"手动选过"的记忆', () => {
    const { result, rerender } = renderHook(({ neg, active }) => useSideTab(neg, active), { initialProps: { neg: false, active: true } })
    act(() => result.current.pickTab('history'))
    rerender({ neg: false, active: false })
    rerender({ neg: false, active: true })
    rerender({ neg: true, active: true })
    expect(result.current.sideTab).toBe('neg')
  })
})

describe('PhaseGuide 信息隐藏', () => {
  it('成交倒计时不点名当前被询问者', () => {
    const s = closingState() // 轮到 1 号放行
    const who = s.players[1].name
    const { container } = renderAs(<PhaseGuide state={s} />, 0)
    expect(container.querySelector('.guide-text')!.textContent).not.toContain(who)
    expect(container.querySelector('.phase-guide')!.classList.contains('human-turn')).toBe(false)
  })

  it('轮到视角玩家时高亮', () => {
    const s = closingState()
    const { container } = renderAs(<PhaseGuide state={s} />, 1)
    expect(container.querySelector('.phase-guide')!.classList.contains('human-turn')).toBe(true)
  })
})
