// @vitest-environment jsdom
// 反馈与节奏控件：节奏控制 / AI 状态徽标 / 页面标题提醒 / 行动区强调 / 后果前置 / 一键提案成交 / 座位与桌风

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { cleanup, screen, render, renderHook, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import PaceControls from '../../src/components/PaceControls'
import AiStatusBadge from '../../src/components/AiStatusBadge'
import InfoTip from '../../src/components/InfoTip'
import ActionDock from '../../src/components/ActionDock'
import OfferEditor from '../../src/components/OfferEditor'
import PlayerSeat from '../../src/components/PlayerSeat'
import StartScreen from '../../src/components/StartScreen'
import { useTurnAlert, TITLE_BLINK_MS } from '../../src/components/useTurnAlert'
import { TURN_ALERT_TITLE } from '../../src/ui/attention'
import { loadLLMConfig } from '../../src/ai/llmClient'
import { buyCardsCost } from '../../src/engine/rules'
import type { AiRuntimeStatus } from '../../src/game/session'
import type { GameState } from '../../src/engine/types'
import {
  biddingState, bossPlanningState, clearHand, closingState, legalFor, offerKeysOf, offerResponseState, quotedBossState,
  renderAs, step, turnState,
} from './fixtures'

beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); vi.useRealTimers(); document.title = '' })

const status = (p: Partial<AiRuntimeStatus> = {}): AiRuntimeStatus =>
  ({ llmEnabled: true, health: 'ok', lastFallbackReason: null, fallbackCount: 0, ...p })

describe('PaceControls', () => {
  it('电脑速度：读取并写回配置', async () => {
    const user = userEvent.setup()
    render(<PaceControls canSkip={false} onSkip={() => {}} />)
    expect(loadLLMConfig().aiSpeed).toBe('normal')
    expect(screen.getByRole('button', { name: '中' }).getAttribute('aria-pressed')).toBe('true')
    await user.click(screen.getByRole('button', { name: '慢' }))
    expect(loadLLMConfig().aiSpeed).toBe('slow')
    expect(screen.getByRole('button', { name: '慢' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '中' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('读取已保存的速度；syncKey 变化时重读（设置面板关闭后）', () => {
    localStorage.setItem('im-the-boss-llm-config', JSON.stringify({ aiSpeed: 'fast' }))
    const { rerender } = render(<PaceControls canSkip={false} onSkip={() => {}} syncKey={0} />)
    expect(screen.getByRole('button', { name: '快' }).getAttribute('aria-pressed')).toBe('true')
    localStorage.setItem('im-the-boss-llm-config', JSON.stringify({ aiSpeed: 'slow' }))
    rerender(<PaceControls canSkip={false} onSkip={() => {}} syncKey={1} />)
    expect(screen.getByRole('button', { name: '慢' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('快进：不能快进时置灰；能快进时点击触发', async () => {
    const onSkip = vi.fn()
    const { rerender } = render(<PaceControls canSkip={false} onSkip={onSkip} />)
    const btn = () => screen.getByRole('button', { name: /快进/ }) as HTMLButtonElement
    expect(btn().disabled).toBe(true)
    rerender(<PaceControls canSkip onSkip={onSkip} />)
    expect(btn().disabled).toBe(false)
    await userEvent.setup().click(btn())
    expect(onSkip).toHaveBeenCalledTimes(1)
  })
})

describe('AiStatusBadge', () => {
  it('未启用 LLM：灰色"启发式"', () => {
    const { container } = render(<AiStatusBadge status={status({ llmEnabled: false })} />)
    expect(container.querySelector('.ai-badge.off')).not.toBeNull()
  })

  it('正常 / 不稳定 / 已降级：绿 / 黄 / 红，回退原因放在 title', () => {
    const ok = render(<AiStatusBadge status={status()} />)
    expect(ok.container.querySelector('.ai-badge.ok')).not.toBeNull()
    cleanup()
    const deg = render(<AiStatusBadge status={status({ health: 'degraded', lastFallbackReason: '响应超时', fallbackCount: 2 })} />)
    const d = deg.container.querySelector('.ai-badge.degraded')!
    expect(d).not.toBeNull()
    expect(d.getAttribute('title')).toContain('响应超时')
    cleanup()
    const down = render(<AiStatusBadge status={status({ health: 'down', lastFallbackReason: '连接失败', fallbackCount: 9 })} />)
    const x = down.container.querySelector('.ai-badge.down')!
    expect(x).not.toBeNull()
    expect(x.getAttribute('title')).toContain('连接失败')
  })
})

describe('useTurnAlert：页面在后台时标题闪烁', () => {
  let hidden = false
  const setHidden = (v: boolean) => { hidden = v; document.dispatchEvent(new Event('visibilitychange')) }
  beforeEach(() => {
    hidden = false
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
    document.title = '我是大老板'
    vi.useFakeTimers()
  })
  afterEach(() => { delete (document as unknown as { hidden?: boolean }).hidden })

  it('页面可见：不动标题', () => {
    renderHook(() => useTurnAlert(true))
    expect(document.title).toBe('我是大老板')
  })

  it('切到后台：标题交替闪烁；回到前台：恢复', () => {
    renderHook(() => useTurnAlert(true))
    act(() => setHidden(true))
    expect(document.title).toBe(TURN_ALERT_TITLE)
    act(() => { vi.advanceTimersByTime(TITLE_BLINK_MS) })
    expect(document.title).toBe('我是大老板')
    act(() => { vi.advanceTimersByTime(TITLE_BLINK_MS) })
    expect(document.title).toBe(TURN_ALERT_TITLE)
    act(() => setHidden(false))
    expect(document.title).toBe('我是大老板')
    act(() => { vi.advanceTimersByTime(TITLE_BLINK_MS * 3) })
    expect(document.title).toBe('我是大老板')
  })

  it('不需要提醒 / 提醒结束：不闪、恢复', () => {
    const { rerender, unmount } = renderHook(({ on }) => useTurnAlert(on), { initialProps: { on: false } })
    act(() => setHidden(true))
    expect(document.title).toBe('我是大老板')
    rerender({ on: true })
    expect(document.title).toBe(TURN_ALERT_TITLE)
    rerender({ on: false })
    expect(document.title).toBe('我是大老板')
    rerender({ on: true })
    unmount()
    expect(document.title).toBe('我是大老板')
  })
})

describe('InfoTip', () => {
  it('点开显示说明；再点 / Esc 收起', async () => {
    const user = userEvent.setup()
    render(<InfoTip label="说明"><span>这是说明</span></InfoTip>)
    expect(screen.queryByRole('tooltip')).toBeNull()
    await user.click(screen.getByRole('button', { name: '说明' }))
    expect(screen.getByRole('tooltip').textContent).toContain('这是说明')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})

describe('ActionDock：提醒与后果前置', () => {
  const dock = (s: GameState, viewerId = 0) => {
    const act = vi.fn()
    const view = renderAs(
      <ActionDock state={s} legal={legalFor(s, viewerId)} act={act} selection={new Set()} selectMode={null} onToggleTradeMode={() => {}} onOpenOfferEditor={() => {}} />,
      viewerId,
    )
    return { ...view, act, root: view.container.querySelector('.dock') as HTMLElement }
  }

  it('轮到我做决定：行动区高亮并带"轮到你了"', () => {
    const { root, container } = dock(turnState(0))
    expect(root.dataset.myTurn).toBe('true')
    expect(root.classList.contains('my-turn')).toBe(true)
    expect(container.querySelector('.dock-turn-badge')).not.toBeNull()
  })

  it('不是我的回合：不高亮', () => {
    const { root, container } = dock(turnState(1))
    expect(root.dataset.myTurn).toBe('false')
    expect(container.querySelector('.dock-turn-badge')).toBeNull()
  })

  it('成交倒计时里只能放行（没牌可打）：不高亮，避免白闪', () => {
    const s = closingState()
    clearHand(s, 1)
    const { root } = dock(s, 1)
    expect(root.dataset.myTurn).toBe('false')
  })

  it('非 Boss 报价框旁有"报价即承诺"说明；Boss 没有', async () => {
    const non = dock(biddingState(0, 1), 1)
    const callout = non.container.querySelector('[data-testid="commit-callout"]')!
    expect(callout).not.toBeNull()
    await userEvent.setup().click(screen.getByRole('button', { name: '说明：什么是报价即承诺' }))
    expect(screen.getByRole('tooltip')).not.toBeNull()
    cleanup()
    const boss = dock(biddingState(0, 0), 0)
    expect(boss.container.querySelector('[data-testid="commit-callout"]')).toBeNull()
  })

  it('应答方案：同意按钮写明同意后的结果，点击发送 ACCEPT_OFFER', async () => {
    const { container, act } = dock(offerResponseState(), 1)
    const btn = container.querySelector('.accept-btn') as HTMLElement
    expect(btn).not.toBeNull()
    expect(btn.querySelector('.accept-outcome')).not.toBeNull()
    await userEvent.setup().click(btn)
    expect(act).toHaveBeenCalledWith({ type: 'ACCEPT_OFFER', playerId: 1 })
  })

  it('方案已全员同意：Boss 的"宣布成交"最醒目、排在最前', async () => {
    let s = quotedBossState()
    s = step(s, { type: 'PROPOSE_OFFER', playerId: 0, repKeys: offerKeysOf(s), payouts: [{ playerId: 1, amount: 2 }] })
    expect(s.phase).toBe('NEGOTIATION') // 付到承诺价：自动同意，没有应答环节
    const { container, act } = dock(s, 0)
    const cta = container.querySelector('.dock-actions .btn-cta') as HTMLElement
    expect(cta).not.toBeNull()
    expect(container.querySelector('.dock-actions')!.firstElementChild).toBe(cta)
    await userEvent.setup().click(cta)
    expect(act).toHaveBeenCalledWith({ type: 'CLOSE_DEAL', playerId: 0 })
  })

  it('没有全员同意的方案时，"宣布成交"不抢眼', () => {
    const { container } = dock(biddingState(0, 0), 0)
    expect(container.querySelector('.dock-actions .btn-cta')).toBeNull()
  })

  it('买牌花费大：先确认再扣钱；花费小：直接买', async () => {
    const buyState = (cash: number) => {
      const s = turnState(0)
      s.houseRules = true
      clearHand(s, 0)
      s.players[0].cash = cash
      return s
    }
    const buyBtn = (c: HTMLElement) => [...c.querySelectorAll('.dock-house .btn')].find(b => /买 1 张/.test(b.textContent ?? ''))!
    const user = userEvent.setup()

    // 花费小（现金充裕）：一点就买
    const rich = dock(buyState(500), 0)
    await user.click(buyBtn(rich.container))
    expect(rich.act).toHaveBeenCalledTimes(1)
    expect(rich.act.mock.calls[0][0]).toMatchObject({ type: 'BUY_CARDS', count: 1 })
    cleanup()

    // 花费大（≥ 现金一半）：要先确认
    const s = buyState(0)
    s.players[0].cash = buyCardsCost(s, 1) + 1
    const { container, act } = dock(s, 0)
    await user.click(buyBtn(container))
    expect(act).not.toHaveBeenCalled()
    expect(container.querySelector('.buy-confirm')).not.toBeNull()
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(container.querySelector('.buy-confirm')).toBeNull()
    await user.click(buyBtn(container))
    await user.click(screen.getByRole('button', { name: '确认购买' }))
    expect(act).toHaveBeenCalledTimes(1)
    expect(act.mock.calls[0][0]).toMatchObject({ type: 'BUY_CARDS', playerId: 0, count: 1 })
  })
})

describe('OfferEditor：提案并宣布成交', () => {
  const editor = (s: GameState) => {
    const onSubmit = vi.fn()
    const view = renderAs(<OfferEditor state={s} onSubmit={onSubmit} onClose={() => {}} />, 0)
    return { ...view, onSubmit }
  }

  it('还有人需要表态：不出现一键成交', () => {
    editor(bossPlanningState(0))
    expect(screen.queryByRole('button', { name: /提案并宣布成交/ })).toBeNull()
    expect(screen.getByRole('button', { name: '提出方案' })).not.toBeNull()
  })

  it('所有人都会自动同意：出现一键成交，onSubmit 带上 closeNow', async () => {
    const s = quotedBossState() // 1 号 B 报价 $2
    const { onSubmit, container } = editor(s)
    const fill = screen.queryByRole('button', { name: '按公开报价填入' })
    if (fill) await userEvent.setup().click(fill)
    const btn = screen.queryByRole('button', { name: /提案并宣布成交/ })
    if (!btn) {
      // 默认分成未达承诺价：把 1 号的分成改成 2
      const input = container.querySelector('.payout-row input[type="number"]') as HTMLInputElement
      const user = userEvent.setup()
      await user.clear(input)
      await user.type(input, '2')
    }
    await userEvent.setup().click(screen.getByRole('button', { name: /提案并宣布成交/ }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const [repKeys, payouts, closeNow] = onSubmit.mock.calls[0]
    expect(repKeys).toHaveLength(2)
    expect(payouts).toEqual([{ playerId: 1, amount: 2 }])
    expect(closeNow).toBe(true)
  })

  it('普通"提出方案"不带 closeNow', async () => {
    const { onSubmit } = editor(quotedBossState())
    await userEvent.setup().click(screen.getByRole('button', { name: '提出方案' }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][2]).toBeUndefined()
  })
})

describe('PlayerSeat：人物色、态度、气泡', () => {
  const seat = (s: GameState, id: number, props: Partial<Parameters<typeof PlayerSeat>[0]> = {}, viewer = 0) =>
    renderAs(<PlayerSeat state={s} playerId={id} isActing={false} isThinking={false} {...props} />, viewer)

  it('座位带人物主题色变量，同一人物每次相同', () => {
    const s = turnState(0)
    const a = seat(s, 1).container.querySelector('.player-seat') as HTMLElement
    const accent = a.style.getPropertyValue('--seat-accent')
    expect(accent).not.toBe('')
    cleanup()
    const b = seat(s, 1).container.querySelector('.player-seat') as HTMLElement
    expect(b.style.getPropertyValue('--seat-accent')).toBe(accent)
  })

  it('态度图标：非零才显示，原因进 title；自己的座位不显示', () => {
    const s = turnState(0)
    const none = seat(s, 1, { relation: { score: 0, reasons: [] } })
    expect(none.container.querySelector('.seat-relation')).toBeNull()
    cleanup()
    const bad = seat(s, 1, { relation: { score: -1, reasons: ['你上一笔搅了他的局'] } })
    const icon = bad.container.querySelector('.seat-relation')!
    expect(icon).not.toBeNull()
    expect(icon.getAttribute('title')).toContain('你上一笔搅了他的局')
    cleanup()
    const self = seat(s, 0, { relation: { score: 2, reasons: ['x'] } })
    expect(self.container.querySelector('.seat-relation')).toBeNull()
  })

  it('气泡：显示完整台词，点击展开 / 收起；换新台词自动收起', async () => {
    const s = turnState(0)
    const long = '这个价我不接受。'.repeat(8)
    s.players[1].lastSpeech = long
    const user = userEvent.setup()
    const { container, rerender } = seat(s, 1)
    const bubble = () => container.querySelector('.seat-bubble') as HTMLElement
    expect(bubble().textContent).toBe(long)
    expect(bubble().getAttribute('aria-expanded')).toBe('false')
    await user.click(bubble())
    expect(bubble().getAttribute('aria-expanded')).toBe('true')
    expect(bubble().classList.contains('expanded')).toBe(true)
    await user.click(bubble())
    expect(bubble().getAttribute('aria-expanded')).toBe('false')
    await user.click(bubble())
    const s2: GameState = { ...s, players: s.players.map(p => p.id === 1 ? { ...p, lastSpeech: '换一句' } : p) }
    rerender(<PlayerSeat state={s2} playerId={1} isActing={false} isThinking={false} />)
    expect(bubble().textContent).toBe('换一句')
    expect(bubble().getAttribute('aria-expanded')).toBe('false')
  })

  it('没有台词：没有气泡', () => {
    const s = turnState(0)
    s.players[1].lastSpeech = ''
    expect(seat(s, 1).container.querySelector('.seat-bubble')).toBeNull()
  })
})

describe('StartScreen：桌风', () => {
  const screenOf = (syncKey?: unknown) => render(<StartScreen onStart={() => {}} onContinue={() => {}} onSettings={() => {}} syncKey={syncKey} />)

  it('默认商战；点选后写入配置并显示一句话说明', async () => {
    const { container } = screenOf()
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(3)
    expect(screen.getByRole('radio', { name: '商战' }).getAttribute('aria-checked')).toBe('true')
    const hint = () => container.querySelector('.table-style-selector')!.parentElement!.querySelector('.form-hint')!.textContent
    const before = hint()
    await userEvent.setup().click(screen.getByRole('radio', { name: '冷血' }))
    expect(loadLLMConfig().tableStyle).toBe('ruthless')
    expect(screen.getByRole('radio', { name: '冷血' }).getAttribute('aria-checked')).toBe('true')
    expect(hint()).not.toBe(before)
  })

  it('读取已保存的桌风；开局前再确认一次写入', async () => {
    localStorage.setItem('im-the-boss-llm-config', JSON.stringify({ tableStyle: 'friendly' }))
    const onStart = vi.fn()
    render(<StartScreen onStart={onStart} onContinue={() => {}} onSettings={() => {}} />)
    expect(screen.getByRole('radio', { name: '友好' }).getAttribute('aria-checked')).toBe('true')
    await userEvent.setup().click(screen.getByRole('button', { name: '开始新游戏' }))
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(loadLLMConfig().tableStyle).toBe('friendly')
  })

  it('syncKey 变化：重读配置（设置面板里改过）', () => {
    const { rerender } = screenOf(0)
    localStorage.setItem('im-the-boss-llm-config', JSON.stringify({ tableStyle: 'ruthless' }))
    rerender(<StartScreen onStart={() => {}} onContinue={() => {}} onSettings={() => {}} syncKey={1} />)
    expect(screen.getByRole('radio', { name: '冷血' }).getAttribute('aria-checked')).toBe('true')
  })
})