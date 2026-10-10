// @vitest-environment jsdom
// App 整体：不同视口档位下的顶栏 / 抽屉 / 跳转链接 / 弹层的无障碍语义（端到端冒烟，用真实会话 + 启发式 AI）

import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../../src/App'

/** 把 jsdom 伪装成某个视口：innerWidth / innerHeight + 一个只会回答"不匹配"的 matchMedia（useLayout 靠宽高算档位） */
function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); localStorage.clear() })

async function startGame(user: ReturnType<typeof userEvent.setup>) {
  render(<App />)
  await user.click(screen.getByRole('button', { name: '开始新游戏' }))
  await screen.findByRole('banner') // <header class="app-header">
}

describe('App：桌面档位（≥1280）', () => {
  beforeEach(() => setViewport(1440, 900))

  it('顶栏图标按钮都有名字；没有抽屉手柄；有"跳到行动区"链接；行动区是带标签的区域', async () => {
    const user = userEvent.setup()
    await startGame(user)
    expect(screen.getByRole('button', { name: '规则速查' })).not.toBeNull()
    expect(screen.getByRole('button', { name: '设置' })).not.toBeNull()
    expect(screen.getByRole('button', { name: '返回开始界面' })).not.toBeNull()
    expect(screen.getByRole('button', { name: /音效/ })).not.toBeNull()
    expect(screen.getByRole('button', { name: /快进/ })).not.toBeNull()
    expect(screen.queryByRole('button', { name: '更多' })).toBeNull()
    expect(document.querySelector('.drawer-handle')).toBeNull()
    expect(screen.getByRole('region', { name: '行动区与手牌' })).not.toBeNull()
    expect(screen.getByRole('main')).not.toBeNull()
    const skip = screen.getByRole('button', { name: '跳到行动区' })
    await user.click(skip)
    expect(document.activeElement).toBe(document.getElementById('action-area'))
  })

  it('规则速查：点 📖 打开 dialog，Esc 关闭，焦点回到 📖', async () => {
    const user = userEvent.setup()
    await startGame(user)
    const help = screen.getByRole('button', { name: '规则速查' })
    await user.click(help)
    const dlg = screen.getByRole('dialog', { name: /规则速查/ })
    expect(dlg.getAttribute('aria-modal')).toBe('true')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(help)
  })

  it('侧栏常驻：是带标签的区域 + tablist，不是 dialog，不隐藏', async () => {
    const user = userEvent.setup()
    await startGame(user)
    const side = screen.getByLabelText('谈判桌与日志')
    expect(side.getAttribute('role')).toBeNull()
    expect(side.getAttribute('aria-hidden')).toBeNull()
    expect(within(side).getByRole('tablist', { name: '侧栏' })).not.toBeNull()
    expect(within(side).queryByRole('button', { name: '收起侧栏' })).toBeNull()
  })
})

describe('App：手机档位（≤767）', () => {
  beforeEach(() => setViewport(390, 844))

  it('顶栏：次要入口收进"更多"菜单；菜单项可用键盘选中并打开规则速查', async () => {
    const user = userEvent.setup()
    await startGame(user)
    expect(screen.queryByRole('button', { name: '规则速查' })).toBeNull() // 不再平铺
    expect(screen.getByRole('button', { name: /快进/ })).not.toBeNull() // 速度 / 快进 / 音效仍在顶栏
    expect(screen.getByRole('button', { name: /音效/ })).not.toBeNull()
    expect(screen.getByRole('group', { name: '电脑速度' })).not.toBeNull()
    await user.click(screen.getByRole('button', { name: '更多' }))
    const items = screen.getAllByRole('menuitem').map(i => i.textContent)
    expect(items).toEqual(expect.arrayContaining([expect.stringContaining('规则速查'), expect.stringContaining('设置'), expect.stringContaining('返回开始界面')]))
    await user.click(screen.getByRole('menuitem', { name: /规则速查/ }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('dialog', { name: /规则速查/ })).not.toBeNull()
  })

  it('抽屉：默认收起且对读屏隐藏；手柄打开 → dialog + aria-modal；Esc / 遮罩 / ✕ 都能关；关闭后焦点回到手柄', async () => {
    const user = userEvent.setup()
    await startGame(user)
    const side = document.querySelector('aside.sidebar') as HTMLElement
    expect(side.getAttribute('aria-hidden')).toBe('true')
    expect(side.classList.contains('open')).toBe(false)
    const handle = document.querySelector('.drawer-handle') as HTMLElement
    expect(handle.getAttribute('aria-expanded')).toBe('false')
    expect(handle.getAttribute('aria-controls')).toBe(side.id)

    await user.click(handle)
    expect(handle.getAttribute('aria-expanded')).toBe('true')
    expect(side.classList.contains('open')).toBe(true)
    expect(side.getAttribute('role')).toBe('dialog')
    expect(side.getAttribute('aria-modal')).toBe('true')
    expect(side.getAttribute('aria-hidden')).toBeNull()
    expect(side.contains(document.activeElement)).toBe(true)
    expect(document.querySelector('.sidebar-backdrop')).not.toBeNull()

    await user.keyboard('{Escape}')
    expect(side.classList.contains('open')).toBe(false)
    expect(document.activeElement).toBe(handle)

    await user.click(handle)
    await user.click(document.querySelector('.sidebar-backdrop') as HTMLElement)
    expect(side.classList.contains('open')).toBe(false)

    await user.click(handle)
    await user.click(within(side).getByRole('button', { name: '收起侧栏' }))
    expect(side.classList.contains('open')).toBe(false)
  })

  it('抽屉里切标签：tablist 的 aria-selected 跟随；Tab 不会跑到抽屉外', async () => {
    const user = userEvent.setup()
    await startGame(user)
    await user.click(document.querySelector('.drawer-handle') as HTMLElement)
    const side = document.querySelector('aside.sidebar') as HTMLElement
    const logTab = within(side).getByRole('tab', { name: '日志' })
    await user.click(logTab)
    expect(logTab.getAttribute('aria-selected')).toBe('true')
    for (let i = 0; i < 15; i++) { await user.tab(); expect(side.contains(document.activeElement)).toBe(true) }
  })

  it('行动区在手机上仍是带标签的区域，手牌区可达', async () => {
    const user = userEvent.setup()
    await startGame(user)
    const region = screen.getByRole('region', { name: '行动区与手牌' })
    expect(within(region).getByRole('group', { name: '你的手牌' })).not.toBeNull()
  })
})

describe('App：平板档位（768–1023）', () => {
  beforeEach(() => setViewport(820, 1180))

  it('顶栏仍平铺图标按钮（空间够）；侧栏同样是抽屉', async () => {
    const user = userEvent.setup()
    await startGame(user)
    expect(screen.getByRole('button', { name: '规则速查' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: '更多' })).toBeNull()
    const handle = document.querySelector('.drawer-handle') as HTMLElement
    expect(handle).not.toBeNull()
    await user.click(handle)
    await waitFor(() => expect(document.querySelector('aside.sidebar')!.getAttribute('role')).toBe('dialog'))
  })
})
