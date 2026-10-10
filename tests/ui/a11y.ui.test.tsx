// @vitest-environment jsdom
// 可访问性与窄屏：语义 / 键盘 / 弹层焦点管理 / 抽屉 / 手机顶栏菜单 / 触屏提示 / 读屏播报

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { cleanup, screen, within, act as rtlAct, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { readStyle } from './readStyle'
import TableBoard from '../../src/components/TableBoard'
import CardHand from '../../src/components/CardHand'
import HeaderMenu, { type MenuItem } from '../../src/components/HeaderMenu'
import DrawerHandle from '../../src/components/DrawerHandle'
import LiveAnnouncer from '../../src/components/LiveAnnouncer'
import HelpPanel from '../../src/components/HelpPanel'
import OfferEditor from '../../src/components/OfferEditor'
import TouchHints, { HINT_LONG_PRESS_MS, hintTargetOf, isInteractiveTarget } from '../../src/components/TouchHints'
import { LayoutProvider } from '../../src/components/useLayout'
import { useModalDismiss } from '../../src/components/useModalDismiss'
import { layoutFor } from '../../src/ui/layout'
import {
  actSpy, biddingState, bossPlanningState, clearHand, giveCards, legalFor, offerResponseState, placeMarkerState, renderAs, turnState,
} from './fixtures'

// jsdom 没有 ResizeObserver，版图的自适应缩放用到它
beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.useRealTimers() })

/* ------------------------------------------------------------------ */
/* 版图格子：键盘可操作；紧凑档位                                         */
/* ------------------------------------------------------------------ */
describe('TableBoard：语义与键盘', () => {
  const chooserView = () => {
    const s = placeMarkerState()
    return { s, chooser: s.markerChooserId! }
  }

  it('版图是带标签的分组；不可放置的格子是只读分组，说明写在 aria-label 里', () => {
    const { s } = chooserView()
    const other = (s.markerChooserId! + 1) % s.players.length
    renderAs(<TableBoard state={s} thinkingId={null} />, other)
    expect(screen.getByRole('group', { name: '版图' })).not.toBeNull()
    const cell = document.querySelector('.ring-cell') as HTMLElement
    expect(cell.getAttribute('role')).toBe('group')
    expect(cell.getAttribute('aria-label')).toMatch(/#\d+/)
    expect(cell.tabIndex).toBe(-1) // 只读格子不进 Tab 序
  })

  it('放置者看到的可放置格子是真按钮：可聚焦，Enter / 空格放置，标签含格号与需求', async () => {
    const { s, chooser } = chooserView()
    const onPlace = vi.fn()
    const { container } = renderAs(<TableBoard state={s} thinkingId={null} onPlaceMarker={onPlace} />, chooser)
    const cells = [...container.querySelectorAll<HTMLElement>('.ring-cell.selectable')]
    expect(cells).toHaveLength(s.board.length)
    const c = cells[3]
    expect(c.getAttribute('role')).toBe('button')
    expect(c.tabIndex).toBe(0)
    expect(c.getAttribute('aria-label')).toContain(`#${s.board[3].id}`)
    const user = userEvent.setup()
    c.focus()
    await user.keyboard('{Enter}')
    expect(onPlace).toHaveBeenLastCalledWith(s.board[3].id)
    await user.keyboard(' ')
    expect(onPlace).toHaveBeenCalledTimes(2)
    // 非 Enter / 空格不触发
    await user.keyboard('a')
    expect(onPlace).toHaveBeenCalledTimes(2)
  })

  it('座位是带摘要的分组（名字 / 现金 / 手牌数），读屏不必逐个元素读', () => {
    const s = placeMarkerState()
    const { container } = renderAs(<TableBoard state={s} thinkingId={null} />)
    const seat = container.querySelector('.player-seat') as HTMLElement
    expect(seat.getAttribute('role')).toBe('group')
    expect(seat.getAttribute('aria-label')).toContain(s.players[0].name)
    expect(seat.getAttribute('aria-label')).toContain('$')
  })

  it('手机档位：版图使用紧凑格子（带缩放容器），桌面档位不用', () => {
    const s = placeMarkerState()
    const phone = renderAs(
      <LayoutProvider value={layoutFor(390, 844)}><TableBoard state={s} thinkingId={null} /></LayoutProvider>,
    )
    expect(phone.container.querySelector('.ring-grid.ring-compact')).not.toBeNull()
    expect(phone.container.querySelector('.ring-wrap-compact')).not.toBeNull()
    expect(phone.container.querySelector('.ring-scaler')).not.toBeNull()
    expect(phone.container.querySelectorAll('.ring-cell')).toHaveLength(s.board.length) // 格子一个不少
    cleanup()
    const desk = renderAs(
      <LayoutProvider value={layoutFor(1440, 900)}><TableBoard state={s} thinkingId={null} /></LayoutProvider>,
    )
    expect(desk.container.querySelector('.ring-compact')).toBeNull()
    expect(desk.container.querySelector('.ring-scaler')).toBeNull()
  })

  it('矮屏（横屏手机，即使宽度是平板档）也用紧凑格子', () => {
    const s = placeMarkerState()
    const { container } = renderAs(
      <LayoutProvider value={layoutFor(844, 390)}><TableBoard state={s} thinkingId={null} /></LayoutProvider>,
    )
    expect(container.querySelector('.ring-grid.ring-compact')).not.toBeNull()
  })

  it('紧凑档位下放置仍然可用：点击 / 键盘都能放标记', async () => {
    const { s, chooser } = chooserView()
    const onPlace = vi.fn()
    const { container } = renderAs(
      <LayoutProvider value={layoutFor(390, 844)}><TableBoard state={s} thinkingId={null} onPlaceMarker={onPlace} /></LayoutProvider>,
      chooser,
    )
    const cell = container.querySelectorAll<HTMLElement>('.ring-cell.selectable')[1]
    await userEvent.setup().click(cell)
    expect(onPlace).toHaveBeenCalledWith(s.board[1].id)
  })
})

/* ------------------------------------------------------------------ */
/* 手牌：按钮语义 + 键盘                                                  */
/* ------------------------------------------------------------------ */
describe('CardHand：键盘与读屏', () => {
  function handView() {
    const s = biddingState(1, 0)
    clearHand(s, 0)
    giveCards(s, 0, [{ type: 'CLAN', familyId: 'B' }, { type: 'STOP' }])
    const { act, last } = actSpy()
    const view = renderAs(
      <CardHand state={s} legal={legalFor(s, 0)} act={act} selectMode={null} selection={new Set<number>()} onToggleSelect={() => {}} />,
      0,
    )
    return { ...view, s, act, last }
  }

  it('手牌区是带标签的分组；每张牌是按钮，读屏标签含牌名；打不出的牌标 aria-disabled', () => {
    const { container } = handView()
    expect(screen.getByRole('group', { name: '你的手牌' })).not.toBeNull()
    const cards = [...container.querySelectorAll<HTMLElement>('.hand-cards .card')]
    expect(cards.length).toBe(2)
    for (const c of cards) {
      expect(c.getAttribute('role')).toBe('button')
      expect(c.tabIndex).toBe(0)
      expect((c.getAttribute('aria-label') ?? '').length).toBeGreaterThan(2)
    }
    const stop = cards.find(c => c.classList.contains('type-stop'))!
    expect(stop.getAttribute('aria-disabled')).toBe('true')
  })

  it('键盘：Enter 打开出牌弹层（aria-expanded），弹层里 Tab 可达控件并用键盘打出，动作正确', async () => {
    const { container, last, s } = handView()
    const user = userEvent.setup()
    const clan = [...container.querySelectorAll<HTMLElement>('.hand-cards .card')].find(c => c.classList.contains('type-clan'))!
    expect(clan.getAttribute('aria-expanded')).toBe('false')
    clan.focus()
    await user.keyboard('{Enter}')
    expect(clan.getAttribute('aria-expanded')).toBe('true')
    const pop = container.querySelector('.card-popover') as HTMLElement
    expect(pop.getAttribute('role')).toBe('group')
    expect(pop.contains(document.activeElement)).toBe(true) // 焦点进入弹层
    await user.keyboard('4')
    await user.keyboard('{Tab}{Tab}') // 承诺价框 → 台词框 → 打出按钮
    expect(document.activeElement?.textContent).toContain('打出')
    await user.keyboard('{Enter}')
    expect(last()).toMatchObject({ type: 'PLAY_CLAN', playerId: 0, demand: 4, cardId: s.players[0].hand.find(c => c.type === 'CLAN')!.id })
  })

  it('弹层里按 Esc 收起，焦点回到那张牌', async () => {
    const { container } = handView()
    const user = userEvent.setup()
    const clan = [...container.querySelectorAll<HTMLElement>('.hand-cards .card')].find(c => c.classList.contains('type-clan'))!
    clan.focus()
    await user.keyboard('{Enter}')
    expect(container.querySelector('.card-popover')).not.toBeNull()
    await user.keyboard('{Escape}')
    expect(container.querySelector('.card-popover')).toBeNull()
    expect(document.activeElement).toBe(clan)
  })

  it('触屏轻点打不出的牌：弹出放大说明（"为什么现在不能打"），不发动作', async () => {
    const { container, act } = handView()
    const stop = [...container.querySelectorAll<HTMLElement>('.hand-cards .card')].find(c => c.classList.contains('type-stop'))!
    expect(container.querySelector('.card-zoom')).toBeNull()
    await userEvent.setup().click(stop)
    expect(container.querySelector('.card-zoom')).not.toBeNull()
    expect(act).not.toHaveBeenCalled()
  })
})

/* ------------------------------------------------------------------ */
/* 手机顶栏"更多"菜单                                                     */
/* ------------------------------------------------------------------ */
describe('HeaderMenu', () => {
  const items = (onSelect = vi.fn()): MenuItem[] => [
    { key: 'help', icon: '📖', label: '规则速查', onSelect },
    { key: 'settings', icon: '⚙️', label: '设置', onSelect: vi.fn() },
    { key: 'home', icon: '🏠', label: '返回开始界面', onSelect: vi.fn() },
  ]

  it('触发按钮：纯图标也有名字，aria-haspopup / aria-expanded 随开合变化', async () => {
    renderAs(<HeaderMenu items={items()} />)
    const btn = screen.getByRole('button', { name: '更多' })
    expect(btn.getAttribute('aria-haspopup')).toBe('menu')
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    await userEvent.setup().click(btn)
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('menu', { name: '更多操作' })).not.toBeNull()
    expect(screen.getAllByRole('menuitem').map(i => i.textContent)).toEqual(['📖规则速查', '⚙️设置', '🏠返回开始界面'])
  })

  it('打开后焦点在第一项；↑ ↓ Home End 循环移动；Enter 选中并收起', async () => {
    const onSelect = vi.fn()
    renderAs(<HeaderMenu items={items(onSelect)} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '更多' }))
    const [a, b, c] = screen.getAllByRole('menuitem')
    expect(document.activeElement).toBe(a)
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(b)
    await user.keyboard('{End}')
    expect(document.activeElement).toBe(c)
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(a) // 循环
    await user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(c)
    await user.keyboard('{Home}{Enter}')
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('Esc 收起并把焦点还给触发按钮；点菜单外也收起', async () => {
    renderAs(<div><HeaderMenu items={items()} /><button>别处</button></div>)
    const user = userEvent.setup()
    const btn = screen.getByRole('button', { name: '更多' })
    await user.click(btn)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(btn)
    await user.click(btn)
    expect(screen.queryByRole('menu')).not.toBeNull()
    await user.click(screen.getByRole('button', { name: '别处' }))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('每个菜单项的触控高度由 CSS 保证 ≥ 44px：样式表里有 .header-menu-item 的 min-height: 48px', () => {
    expect(readStyle('game.css')).toMatch(/\.header-menu-item\s*\{[^}]*min-height:\s*48px/)
  })
})

/* ------------------------------------------------------------------ */
/* 侧栏抽屉手柄                                                           */
/* ------------------------------------------------------------------ */
describe('DrawerHandle', () => {
  it('读屏标签说明动作与对象；有未读时带条数；aria-expanded / aria-controls 正确', () => {
    const { rerender } = renderAs(<DrawerHandle open={false} negotiating={false} unread={0} controlsId="side" onToggle={() => {}} />)
    const btn = screen.getByRole('button', { name: '打开日志与交易历史' })
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    expect(btn.getAttribute('aria-controls')).toBe('side')
    rerender(<DrawerHandle open={false} negotiating unread={3} controlsId="side" onToggle={() => {}} />)
    expect(screen.getByRole('button', { name: '打开谈判桌，3 条未读动态' })).not.toBeNull()
    expect(document.querySelector('.drawer-handle')!.classList.contains('has-unread')).toBe(true)
    expect(document.querySelector('.drawer-unread')!.textContent).toBe('3')
    rerender(<DrawerHandle open negotiating unread={12} controlsId="side" onToggle={() => {}} />)
    expect(screen.getByRole('button', { name: '收起谈判桌，12 条未读动态' }).getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('.drawer-unread')!.textContent).toBe('9+')
  })

  it('点按 / 键盘 Enter / 空格都触发 onToggle；未读徽标对读屏隐藏（避免重复播报）', async () => {
    const onToggle = vi.fn()
    renderAs(<DrawerHandle open={false} negotiating={false} unread={2} controlsId="side" onToggle={onToggle} />)
    const user = userEvent.setup()
    const btn = screen.getByRole('button')
    await user.click(btn)
    btn.focus()
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(onToggle).toHaveBeenCalledTimes(3)
    expect(document.querySelector('.drawer-unread')!.getAttribute('aria-hidden')).toBe('true')
  })
})

/* ------------------------------------------------------------------ */
/* 读屏播报                                                               */
/* ------------------------------------------------------------------ */
describe('LiveAnnouncer', () => {
  it('不是你做决定时为空；轮到你时播一句；回到别人行动时清空', () => {
    const s = turnState(0)
    const { rerender } = renderAs(<LiveAnnouncer state={s} viewerId={0} attention={false} />)
    const region = screen.getByTestId('turn-announcer')
    expect(region.getAttribute('role')).toBe('status')
    expect(region.getAttribute('aria-live')).toBe('polite')
    expect(region.textContent).toBe('')
    rerender(<LiveAnnouncer state={s} viewerId={0} attention />)
    expect(region.textContent).toMatch(/^轮到你了/)
    rerender(<LiveAnnouncer state={s} viewerId={0} attention={false} />)
    expect(region.textContent).toBe('')
  })

  it('同一阶段内状态变化（别人喊话）不重复播；换阶段才重新播', () => {
    const s1 = biddingState(1, 0)
    const { rerender } = renderAs(<LiveAnnouncer state={s1} viewerId={0} attention />)
    const region = screen.getByTestId('turn-announcer')
    const first = region.textContent
    expect(first).toContain('报价')
    // 同阶段的另一份状态（引用不同）：内容不变、不会清空再写入
    const s2 = { ...s1, stateVersion: s1.stateVersion + 1 }
    rerender(<LiveAnnouncer state={s2} viewerId={0} attention />)
    expect(region.textContent).toBe(first)
    // 换了阶段（叫价轮 → 方案应答，轮到 1 号）才重新播
    rerender(<LiveAnnouncer state={offerResponseState()} viewerId={1} attention />)
    expect(region.textContent).toContain('同意')
  })
})

/* ------------------------------------------------------------------ */
/* 弹层：焦点管理 / Tab 圈 / Esc / 多层                                    */
/* ------------------------------------------------------------------ */
function Layer({ label, onClose, children }: { label: string; onClose: () => void; children?: React.ReactNode }) {
  const close = useModalDismiss(false, onClose)
  // 故意不写 aria-modal / tabIndex：由 useDialogLayer 自动认领并补上（SettingsPanel 就是这么接入的）
  return (
    <div role="dialog" aria-label={label}>
      <button onClick={close}>关闭{label}</button>
      <input aria-label={`${label}输入`} />
      {children}
    </div>
  )
}

function Harness() {
  const [a, setA] = useState(false)
  const [b, setB] = useState(false)
  return (
    <div>
      <button onClick={() => setA(true)}>打开A</button>
      {a && (
        <Layer label="A层" onClose={() => setA(false)}>
          <button onClick={() => setB(true)}>打开B</button>
        </Layer>
      )}
      {b && <Layer label="B层" onClose={() => setB(false)} />}
    </div>
  )
}

describe('弹层焦点管理（useModalDismiss + useDialogLayer）', () => {
  it('打开：焦点进入弹层根；自动补 aria-modal 与 tabindex', async () => {
    renderAs(<Harness />)
    await userEvent.setup().click(screen.getByRole('button', { name: '打开A' }))
    const dlg = screen.getByRole('dialog', { name: 'A层' })
    expect(document.activeElement).toBe(dlg)
    expect(dlg.getAttribute('aria-modal')).toBe('true')
    expect(dlg.getAttribute('tabindex')).toBe('-1')
  })

  it('Tab / Shift+Tab 在弹层内循环，不会跑到弹层外', async () => {
    renderAs(<Harness />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '打开A' }))
    const dlg = screen.getByRole('dialog', { name: 'A层' })
    const items = within(dlg).getAllByRole('button').concat(within(dlg).getAllByRole('textbox'))
    const order = [...dlg.querySelectorAll<HTMLElement>('button, input')]
    expect(order.length).toBe(items.length)
    await user.tab() // 根 → 第一个控件
    expect(document.activeElement).toBe(order[0])
    for (let i = 1; i < order.length; i++) { await user.tab(); expect(document.activeElement).toBe(order[i]) }
    await user.tab() // 最后一个 → 回到第一个（而不是页面上的"打开A"）
    expect(document.activeElement).toBe(order[0])
    await user.tab({ shift: true })
    expect(document.activeElement).toBe(order[order.length - 1])
  })

  it('焦点被强行移到弹层外会被拉回', async () => {
    renderAs(<Harness />)
    await userEvent.setup().click(screen.getByRole('button', { name: '打开A' }))
    const dlg = screen.getByRole('dialog', { name: 'A层' })
    rtlAct(() => { (screen.getByRole('button', { name: '打开A' }) as HTMLElement).focus() })
    expect(dlg.contains(document.activeElement)).toBe(true)
  })

  it('Esc 关闭，焦点回到触发它的按钮', async () => {
    renderAs(<Harness />)
    const user = userEvent.setup()
    const trigger = screen.getByRole('button', { name: '打开A' })
    await user.click(trigger)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('多层弹层：Esc 一次只关最上面一层，焦点逐层交还；Tab 圈只在最上层', async () => {
    renderAs(<Harness />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '打开A' }))
    const openB = screen.getByRole('button', { name: '打开B' })
    await user.click(openB)
    const b = screen.getByRole('dialog', { name: 'B层' })
    expect(document.activeElement).toBe(b)
    // Tab 圈在 B 里
    await user.tab(); await user.tab(); await user.tab()
    expect(b.contains(document.activeElement)).toBe(true)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'B层' })).toBeNull()
    expect(screen.queryByRole('dialog', { name: 'A层' })).not.toBeNull() // A 还在
    expect(document.activeElement).toBe(openB) // 焦点回到触发 B 的按钮
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('真实弹层：规则速查 / 方案编辑器', () => {
  it('HelpPanel：dialog + aria-modal + 标题关联；关闭按钮有名字；Esc 关闭；点遮罩也关闭', async () => {
    const onClose = vi.fn()
    renderAs(<HelpPanel open onClose={onClose} />)
    const dlg = screen.getByRole('dialog', { name: /规则速查/ })
    expect(dlg.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(dlg)
    const user = userEvent.setup()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: '关闭规则速查' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('HelpPanel：open=false 时不渲染；再次打开会重新聚焦进弹层', () => {
    const { rerender } = renderAs(<HelpPanel open={false} onClose={() => {}} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    rerender(<HelpPanel open onClose={() => {}} />)
    expect(document.activeElement).toBe(screen.getByRole('dialog'))
  })

  it('OfferEditor：dialog aria-modal 命名；关闭按钮有名字；分成输入框各有名字；Tab 不会跑出弹层', async () => {
    const onClose = vi.fn()
    renderAs(<OfferEditor state={bossPlanningState(0)} onSubmit={vi.fn()} onClose={onClose} />, 0)
    const dlg = screen.getByRole('dialog')
    expect(dlg.getAttribute('aria-modal')).toBe('true')
    expect(dlg.getAttribute('aria-labelledby')).toBeTruthy()
    expect(screen.getByRole('button', { name: '取消并关闭方案编辑器' })).not.toBeNull()
    const inputs = within(dlg).getAllByRole('spinbutton')
    expect(inputs.length).toBe(3)
    for (const i of inputs) expect(i.getAttribute('aria-label')).toMatch(/^分给.+的金额/)
    const user = userEvent.setup()
    for (let i = 0; i < 40; i++) { await user.tab(); expect(dlg.contains(document.activeElement)).toBe(true) }
  })
})

/* ------------------------------------------------------------------ */
/* 触屏提示（title 的替代）                                               */
/* ------------------------------------------------------------------ */
describe('TouchHints：hover:none 设备上 title 的替代', () => {
  // jsdom 没有 PointerEvent：用 MouseEvent 补上 pointerType
  const pointer = (type: string, target: Element, init: { pointerType?: string } = {}) => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
    Object.defineProperty(e, 'pointerType', { value: init.pointerType ?? 'touch' })
    fireEvent(target, e)
  }

  function view(enabled = true) {
    const onBtn = vi.fn()
    renderAs(
      <div>
        <span data-testid="static" title="股价：每份分红的价值">股价</span>
        <button data-testid="btn" title="本轮已用完" onClick={onBtn}>置灰的按钮</button>
        <div className="ring-cell selectable" data-testid="cell" title="#3 必需 A B"><span data-testid="inner">格子</span></div>
        <TouchHints enabled={enabled} />
      </div>,
    )
    return { onBtn }
  }

  it('hintTargetOf / isInteractiveTarget：找最近的带 title 祖先；按钮 / 可放置格子算可交互', () => {
    view(false)
    const inner = screen.getByTestId('inner')
    expect(hintTargetOf(inner)).toBe(screen.getByTestId('cell'))
    expect(hintTargetOf(document.body)).toBeNull()
    expect(isInteractiveTarget(screen.getByTestId('btn'))).toBe(true)
    expect(isInteractiveTarget(screen.getByTestId('cell'))).toBe(true) // .selectable
    expect(isInteractiveTarget(screen.getByTestId('static'))).toBe(false)
  })

  it('轻点静态带 title 的元素：弹出气泡显示 title 全文（role=status）；点别处收起', () => {
    view()
    const el = screen.getByTestId('static')
    pointer('pointerdown', el, { pointerType: 'touch' })
    pointer('pointerup', el, { pointerType: 'touch' })
    const hint = document.querySelector('.touch-hint')!
    expect(hint.textContent).toBe('股价：每份分红的价值')
    expect(hint.getAttribute('role')).toBe('status')
    pointer('pointerdown', document.body, { pointerType: 'touch' })
    expect(document.querySelector('.touch-hint')).toBeNull()
  })

  it('轻点按钮：照常执行操作，不弹气泡', async () => {
    const { onBtn } = view()
    const btn = screen.getByTestId('btn')
    pointer('pointerdown', btn, { pointerType: 'touch' })
    pointer('pointerup', btn, { pointerType: 'touch' })
    await userEvent.setup().click(btn)
    expect(onBtn).toHaveBeenCalled()
    expect(document.querySelector('.touch-hint')).toBeNull()
  })

  it('长按按钮：弹出 title（置灰原因等），并吞掉随后那次点击，不误触发操作', () => {
    vi.useFakeTimers()
    const { onBtn } = view()
    const btn = screen.getByTestId('btn')
    pointer('pointerdown', btn, { pointerType: 'touch' })
    rtlAct(() => { vi.advanceTimersByTime(HINT_LONG_PRESS_MS + 20) })
    expect(document.querySelector('.touch-hint')!.textContent).toBe('本轮已用完')
    pointer('pointerup', btn, { pointerType: 'touch' })
    fireEvent.click(btn) // 长按松手后浏览器补发的 click
    expect(onBtn).not.toHaveBeenCalled()
    // 之后的正常点击恢复
    fireEvent.click(btn)
    expect(onBtn).toHaveBeenCalledTimes(1)
  })

  it('鼠标不触发（有悬停的设备走原生 title）；enabled=false 时完全不工作', () => {
    view()
    const el = screen.getByTestId('static')
    pointer('pointerdown', el, { pointerType: 'mouse' })
    pointer('pointerup', el, { pointerType: 'mouse' })
    expect(document.querySelector('.touch-hint')).toBeNull()
    cleanup()
    view(false)
    const el2 = screen.getByTestId('static')
    pointer('pointerdown', el2, { pointerType: 'touch' })
    pointer('pointerup', el2, { pointerType: 'touch' })
    expect(document.querySelector('.touch-hint')).toBeNull()
  })

  it('Esc 收起气泡', () => {
    view()
    const el = screen.getByTestId('static')
    pointer('pointerdown', el, { pointerType: 'touch' })
    pointer('pointerup', el, { pointerType: 'touch' })
    expect(document.querySelector('.touch-hint')).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.querySelector('.touch-hint')).toBeNull()
  })
})

/* ------------------------------------------------------------------ */
/* 样式表里的无障碍与触控约定（CSS 无法在 jsdom 渲染，这里守住关键规则不被误删）        */
/* ------------------------------------------------------------------ */
describe('样式约定', () => {
  const css = readStyle('game.css')
  it('全局 prefers-reduced-motion 兜底：动画 / 过渡一律瞬时', () => {
    const block = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'))
    expect(block).toMatch(/animation-duration:\s*0\.001ms\s*!important/)
    expect(block).toMatch(/transition-duration:\s*0\.001ms\s*!important/)
  })

  it('统一的 :focus-visible 样式存在', () => {
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline/)
  })

  it('触控档位：按钮最小高度 44px、输入框 16px（防 iOS 聚焦放大）', () => {
    const block = css.slice(css.indexOf('@media (pointer: coarse)'))
    expect(block).toMatch(/min-height:\s*44px/)
    expect(block).toMatch(/font-size:\s*16px/)
  })

  it('手机档：行动区固定在底部并避让安全区；body 不再 overflow:hidden', () => {
    expect(css).toMatch(/env\(safe-area-inset-bottom/)
    expect(css.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/body\s*\{[^}]*overflow:\s*hidden/)
  })

  it('--muted 提到足够对比度（≥ #9ba5b0）', () => {
    const m = css.match(/--muted:\s*#([0-9a-f]{6})/i)!
    const lum = (hex: string) => {
      const c = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    }
    const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
    for (const bg of ['161b22', '21262d', '2a3039']) expect(ratio(m[1], bg)).toBeGreaterThanOrEqual(4.5)
    expect(ratio('ff7b72', '21262d')).toBeGreaterThanOrEqual(4.5) // .red 文字色
  })
})
