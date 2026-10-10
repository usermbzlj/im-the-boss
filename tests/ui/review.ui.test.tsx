// @vitest-environment jsdom
// 终局与复盘组件：GameOverCard（统计 / 走势 / 精彩 / 入口显隐）、ReplayViewer（步进 / 跳转 / 揭晓 / 自动播放 / 只读）、
// 交易历史的复盘入口、useRecording、复盘导航，以及从存档续局到终局再进复盘的整条链路

import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest'
import { cleanup, screen, fireEvent, render, renderHook, waitFor, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import GameOverCard from '../../src/components/GameOverCard'
import ReplayViewer from '../../src/components/review/ReplayViewer'
import DealHistoryPanel from '../../src/components/DealHistoryPanel'
import TableBoard from '../../src/components/TableBoard'
import CashChart from '../../src/components/review/CashChart'
import { useRecording } from '../../src/components/review/useRecording'
import App from '../../src/App'
import { buildReview } from '../../src/ui/review'
import { highlightPosition } from '../../src/ui/highlights'
import {
  highlightPositions, isMinorStep, nextDealPosition, nextHighlightPosition, nextPosition, prevDealPosition, prevHighlightPosition, stepDelayMs,
} from '../../src/ui/replayNav'
import { computeStats } from '../../src/ui/stats'
import { getDefaultStore } from '../../src/utils/storage'
import { biddingState, gameOverState, renderAs, step, giveCards, clearHand } from './fixtures'
import { playedGame } from './played'

// jsdom 没有 ResizeObserver，版图的自适应缩放用到它
beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); vi.useRealTimers() })

const game = () => playedGame(4, 11, 'classic')
const small = () => playedGame(3, 7, 'expansion')

describe('GameOverCard', () => {
  it('胜者 + 每人名次 / 构成 / 关键数据 + 现金走势 + 精彩时刻', () => {
    const { state, recording } = game()
    const { container } = renderAs(<GameOverCard state={state} recording={recording} onRestart={() => {}} onReview={() => {}} onOpenReplay={() => {}} />)
    const winners = state.winnerIds.map(id => state.players[id].name).join('、')
    expect(container.querySelector('.winner-name')!.textContent).toContain(winners)
    // 排名：每人一行，最高者标 winner，名次与现金一致
    const rows = [...container.querySelectorAll('.standing')]
    expect(rows).toHaveLength(state.players.length)
    expect(rows[0].classList.contains('winner')).toBe(true)
    expect(rows.map(r => r.querySelector('.standing-cash')!.textContent)).toEqual(
      [...state.players].sort((a, b) => b.cash - a.cash).map(p => `$${p.cash}M`))
    expect(rows[0].textContent).toMatch(/Boss \d+ 次（成交 \d+ · 流局 \d+）/)
    expect(rows[0].textContent).toContain('Boss 所得')
    // 走势：每位玩家一条线，终点圆点
    expect(container.querySelectorAll('.cc-series')).toHaveLength(state.players.length)
    expect(container.querySelector('svg[role="img"]')).not.toBeNull()
    // 精彩时刻 + 口径对账
    expect(container.querySelectorAll('.hl-item').length).toBeGreaterThan(0)
    expect(container.querySelector('.go-basis summary')!.textContent).toContain('已与引擎对账')
  })

  it('有录像：显示"逐步复盘"，点击打开（不带位置）；精彩时刻的"回放"带上动作位置', async () => {
    const user = userEvent.setup()
    const { state, recording } = game()
    const review = buildReview(state, recording)
    const onOpenReplay = vi.fn()
    renderAs(<GameOverCard state={state} recording={recording} review={review} onRestart={() => {}} onReview={() => {}} onOpenReplay={onOpenReplay} />)
    await user.click(screen.getByRole('button', { name: '逐步复盘' }))
    expect(onOpenReplay).toHaveBeenLastCalledWith()
    const first = review.highlights.find(h => h.actionIndex != null)!
    const buttons = screen.getAllByRole('button', { name: /^回放：/ })
    expect(buttons).toHaveLength(review.highlights.length)
    await user.click(buttons[review.highlights.indexOf(first)])
    expect(onOpenReplay).toHaveBeenLastCalledWith(highlightPosition(first))
  })

  it('不可回放：没有"逐步复盘"入口、没有回放按钮，只展示基于交易历史的统计，并说明原因', () => {
    const { state } = game()
    renderAs(<GameOverCard state={state} recording={null} replayStatus="unavailable" onRestart={() => {}} onReview={() => {}} onOpenReplay={() => {}} />)
    expect(screen.queryByRole('button', { name: '逐步复盘' })).toBeNull()
    expect(screen.queryAllByRole('button', { name: /^回放：/ })).toHaveLength(0)
    expect(screen.getByText(/无法逐步复盘/)).toBeTruthy()
    // 统计与精彩时刻（基于交易历史）仍在
    expect(document.querySelectorAll('.standing').length).toBe(state.players.length)
    expect(document.querySelectorAll('.hl-item').length).toBeGreaterThan(0)
    expect(document.querySelector('.cc-series')).not.toBeNull()
    expect(screen.getByRole('button', { name: '再来一局' })).toBeTruthy()
  })

  it('录像整理中：入口禁用并提示；整理完成后出现', () => {
    const { state, recording } = game()
    const props = { state, onRestart: () => {}, onReview: () => {}, onOpenReplay: () => {} }
    const { rerender } = renderAs(<GameOverCard {...props} recording={null} replayStatus="building" />)
    expect((screen.getByRole('button', { name: '正在整理复盘…' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: '逐步复盘' })).toBeNull()
    rerender(<GameOverCard {...props} recording={recording} replayStatus="ready" />)
    expect(screen.getByRole('button', { name: '逐步复盘' })).toBeTruthy()
  })

  it('并列：沿用 rankStandings 的 1、1、3；视角玩家标"你"', () => {
    const s = gameOverState([10, 10, 4])
    const { container } = renderAs(<GameOverCard state={s} onRestart={() => {}} onReview={() => {}} />, 2)
    expect([...container.querySelectorAll('.standing')].map(el => el.getAttribute('data-rank'))).toEqual(['1', '1', '3'])
    expect(container.querySelector('.winner-name')!.textContent).toContain('并列')
    expect(container.querySelector('.standing[data-rank="3"]')!.textContent).toContain('（你）')
  })
})

describe('CashChart', () => {
  it('点某一笔交易回调交易编号；游标与精彩标记渲染', async () => {
    const user = userEvent.setup()
    const { state, recording } = small()
    const stats = computeStats(state, recording)
    const onPickDeal = vi.fn()
    const { container } = renderAs(<CashChart series={stats.cashSeries} players={state.players} winnerIds={state.winnerIds} cursorDeal={2} markers={[1, 3]} onPickDeal={onPickDeal} />)
    expect(container.querySelectorAll('.cc-hit')).toHaveLength(state.dealHistory.length)
    expect(container.querySelector('.cc-cursor')).not.toBeNull()
    expect(container.querySelectorAll('.cc-marker')).toHaveLength(2)
    await user.click(container.querySelectorAll('.cc-hit')[4])
    expect(onPickDeal).toHaveBeenCalledWith(5)
  })

  it('还没有交易：给出说明而不是画空图', () => {
    const s = gameOverState([0, 0, 0])
    const { container } = renderAs(<CashChart series={computeStats(s, null).cashSeries} players={s.players} winnerIds={[]} />)
    expect(container.querySelector('svg')).toBeNull()
    expect(container.textContent).toContain('没有走势')
  })
})

describe('ReplayViewer', () => {
  // 每次 effect 重新排期要等一次 render：分小段推进计时器，让 React 在段间提交\r
  const run = (ms: number) => { for (let t = 0; t < ms; t += 100) act(() => { vi.advanceTimersByTime(100) }) }
  const mount = (opts: { initialPosition?: number; onClose?: () => void } = {}) => {
    const { state, recording } = small()
    const review = buildReview(state, recording)
    const view = renderAs(<ReplayViewer state={state} recording={recording} highlights={review.highlights} onClose={opts.onClose ?? (() => {})} initialPosition={opts.initialPosition} />)
    return { state, recording, review, ...view }
  }
  const stepLabel = () => document.querySelector('.rv-step')!.getAttribute('data-position')

  it('从开局开始；下一步 / 上一步逐步前后翻，边界按钮禁用', async () => {
    const user = userEvent.setup()
    const { recording } = mount()
    expect(stepLabel()).toBe('0')
    expect((screen.getByRole('button', { name: /上一步/ }) as HTMLButtonElement).disabled).toBe(true)
    await user.click(screen.getByRole('button', { name: /下一步/ }))
    await user.click(screen.getByRole('button', { name: /下一步/ }))
    expect(stepLabel()).toBe('2')
    expect(document.querySelector('.rv-step')!.textContent).toContain('第 2 步')
    await user.click(screen.getByRole('button', { name: /上一步/ }))
    expect(stepLabel()).toBe('1')
    // 直接到终点：下一步禁用
    fireEvent.change(screen.getByLabelText('进度'), { target: { value: String(recording.length) } })
    expect((screen.getByRole('button', { name: /下一步/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('进度条拖动：中间的版图渲染的就是那一步的状态（只读）', () => {
    const { recording } = mount()
    const mid = Math.floor(recording.length / 2)
    fireEvent.change(screen.getByLabelText('进度'), { target: { value: String(mid) } })
    expect(stepLabel()).toBe(String(mid))
    const closed = document.querySelectorAll('.ring-cell.closed').length
    expect(closed).toBe(recording.stateAt(mid).board.filter(b => b.closedByTileId != null).length)
    // 座位现金与那一步一致
    const cash = [...document.querySelectorAll('.player-seat .seat-cash')].map(el => el.textContent)
    expect(cash).toEqual(recording.stateAt(mid).players.map(p => `$${p.cash}M`))
    // 只读：开局时的版图格子不可点（PLACE_MARKER 阶段原本是可选的）
    fireEvent.change(screen.getByLabelText('进度'), { target: { value: '0' } })
    expect(document.querySelectorAll('.ring-cell.selectable')).toHaveLength(0)
  })

  it('按交易跳转：点交易 chip 跳到该笔开单后；"上一笔 / 下一笔"在交易之间移动', async () => {
    const user = userEvent.setup()
    const { recording } = mount()
    const chips = document.querySelectorAll('.rv-deal-chip')
    expect(chips).toHaveLength(recording.deals.length)
    await user.click(chips[3])
    expect(stepLabel()).toBe(String(recording.positionOpened(4)))
    expect(chips[3].classList.contains('active')).toBe(true)
    expect(recording.stateAt(Number(stepLabel())).negotiation).not.toBeNull()
    await user.click(screen.getByRole('button', { name: /下一笔/ }))
    expect(stepLabel()).toBe(String(recording.positionOpened(5)))
    await user.click(screen.getByRole('button', { name: /上一笔/ }))
    expect(stepLabel()).toBe(String(recording.positionOpened(4)))
  })

  it('揭晓幕后：手牌与思考默认显示，关闭后隐藏（只剩张数）', async () => {
    const user = userEvent.setup()
    const { recording } = small()
    // AI 线给 PlayerAction 加的可选 thought：安全读取
    const idx = recording.steps.findIndex(s => s.action.type === 'SPEAK' || s.action.type === 'PASS')
    ;(recording.steps[idx].action as { thought?: string }).thought = '先看看大家的底牌'
    ;(recording.steps[idx].action as { note?: string }).note = '白珩可能想截胡'
    const { state } = small()
    renderAs(<ReplayViewer state={state} recording={recording} highlights={[]} initialPosition={idx + 1} onClose={() => {}} />)
    expect(document.querySelectorAll('.rv-hand-cards .rv-card').length).toBeGreaterThan(0)
    expect(screen.getByLabelText('思考').textContent).toContain('先看看大家的底牌')
    expect(screen.getByLabelText('私人笔记').textContent).toContain('白珩可能想截胡')

    await user.click(screen.getByRole('checkbox', { name: /揭晓幕后/ }))
    expect(document.querySelectorAll('.rv-hand-cards .rv-card')).toHaveLength(0)
    expect(document.querySelector('.rv-hand-cards')!.textContent).toContain('已隐藏')
    expect(screen.queryByLabelText('思考')).toBeNull()
    expect(screen.queryByLabelText('私人笔记')).toBeNull()

    await user.click(screen.getByRole('checkbox', { name: /揭晓幕后/ }))
    expect(document.querySelectorAll('.rv-hand-cards .rv-card').length).toBeGreaterThan(0)
  })

  it('这一步的内容：行动者、动作描述、台词；每位玩家手牌张数 = 状态里的手牌', () => {
    const { recording, state } = small()
    const idx = recording.steps.findIndex(s => s.action.say && s.action.type === 'SPEAK')
    const sayStep = idx >= 0 ? idx : recording.steps.findIndex(s => s.action.type === 'PLAY_CLAN')
    const pos = sayStep + 1
    renderAs(<ReplayViewer state={state} recording={recording} highlights={[]} initialPosition={pos} onClose={() => {}} />)
    const step = recording.steps[sayStep]
    expect(document.querySelector('.rv-actor')!.textContent).toContain(state.players[step.action.playerId].name)
    expect(document.querySelector('.rv-action')!.textContent!.length).toBeGreaterThan(2)
    if (step.action.say) expect(document.querySelector('.rv-say')!.textContent).toContain(step.action.say)
    const hands = recording.stateAt(pos).players.map(p => p.hand.length)
    const shown = [...document.querySelectorAll('.rv-hand')].map(el => [...el.querySelectorAll('.rv-card')].reduce((s, c) => s + Number(c.querySelector('b')?.textContent?.slice(1) ?? 1), 0))
    expect(shown).toEqual(hands)
  })

  it('自动播放：按间隔前进，暂停即停；调速改变间隔；到终点自动停', () => {
    vi.useFakeTimers()
    const { recording } = mount()
    const speedLabel = () => document.querySelector('.rv-speed-label')!.textContent
    fireEvent.click(screen.getByRole('button', { name: /播放/ }))
    run(5000)
    const advanced = Number(stepLabel())
    expect(advanced).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: /暂停/ }))
    run(5000)
    expect(stepLabel()).toBe(String(advanced))

    // 调到最快：同样时间走得更远
    expect(speedLabel()).toBe('1×')
    fireEvent.click(screen.getByRole('button', { name: '加速' }))
    fireEvent.click(screen.getByRole('button', { name: '加速' }))
    expect(speedLabel()).toBe('4×')
    fireEvent.click(screen.getByRole('button', { name: /播放/ }))
    run(5000)
    expect(Number(stepLabel())).toBeGreaterThan(advanced + 4)
    // 播到头自动停下，按钮变成"重播"
    run(10 * 60 * 1000)
    expect(stepLabel()).toBe(String(recording.length))
    expect(screen.getByRole('button', { name: /重播/ })).toBeTruthy()
  })

  it('拖动进度条 / 单步会暂停自动播放', () => {
    vi.useFakeTimers()
    mount()
    fireEvent.click(screen.getByRole('button', { name: /播放/ }))
    act(() => { vi.advanceTimersByTime(1000) })
    fireEvent.change(screen.getByLabelText('进度'), { target: { value: '5' } })
    act(() => { vi.advanceTimersByTime(20000) })
    expect(stepLabel()).toBe('5')
    expect(screen.getByRole('button', { name: /播放/ })).toBeTruthy()
  })

  it('精彩时刻：标签页里"回放"跳到对应动作；上一个 / 下一个精彩按钮', async () => {
    const user = userEvent.setup()
    const { review } = mount()
    const positions = highlightPositions(review.highlights)
    expect(positions.length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: /▶◆/ }))
    expect(stepLabel()).toBe(String(positions[0]))
    expect(document.querySelector('.rv-hl-flag')).not.toBeNull() // 当前步就是精彩时刻：侧栏有提示
    await user.click(screen.getByRole('tab', { name: /精彩时刻/ }))
    const last = review.highlights.reduce((a, b) => (highlightPosition(b)! > highlightPosition(a)! ? b : a))
    await user.click(screen.getByRole('button', { name: `回放：${last.title}` }))
    expect(stepLabel()).toBe(String(highlightPosition(last)))
    await user.click(screen.getByRole('button', { name: /◆◀/ }))
    expect(Number(stepLabel())).toBeLessThan(highlightPosition(last)!)
  })

  it('谈判中显示谈判桌，交易之间显示刚结束那笔的事件流', () => {
    const { recording } = mount()
    const d = recording.deals[2]
    fireEvent.change(screen.getByLabelText('进度'), { target: { value: String(d.openStep + 2) } })
    expect(document.querySelector('.neg-panel')).not.toBeNull()
    fireEvent.change(screen.getByLabelText('进度'), { target: { value: String(d.endStep + 1) } })
    expect(document.querySelector('.neg-panel')).toBeNull()
    expect(document.querySelector('.neg-feed')).not.toBeNull()
  })

  it('键盘：← → 单步，空格播放 / 暂停，Esc 关闭', () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    mount({ onClose, initialPosition: 3 })
    fireEvent.keyDown(document, { key: 'ArrowRight' })
    expect(stepLabel()).toBe('4')
    fireEvent.keyDown(document, { key: 'ArrowLeft' })
    fireEvent.keyDown(document, { key: 'ArrowLeft' })
    expect(stepLabel()).toBe('2')
    fireEvent.keyDown(document, { key: 'Home' })
    expect(stepLabel()).toBe('0')
    fireEvent.keyDown(document, { key: ' ' })
    act(() => { vi.advanceTimersByTime(3000) })
    expect(Number(stepLabel())).toBeGreaterThan(0)
    fireEvent.keyDown(document, { key: ' ' })
    const frozen = stepLabel()
    act(() => { vi.advanceTimersByTime(3000) })
    expect(stepLabel()).toBe(frozen)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('initialPosition 越界会被夹到合法范围；"返回终局"回调关闭', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const { recording } = mount({ initialPosition: 99999, onClose })
    expect(stepLabel()).toBe(String(recording.length))
    await user.click(screen.getByRole('button', { name: '返回终局' }))
    expect(onClose).toHaveBeenCalled()
  })
})

describe('TableBoard readOnly', () => {
  it('默认行为不变：反应窗口不暴露行动者；readOnly（复盘）则一切公开', () => {
    const s = biddingState(1, 0)
    clearHand(s, 0)
    giveCards(s, 0, [{ type: 'TRAVEL' }])
    const target = s.negotiation!.reps.find(r => r.ownerId === 1)!
    const reacting = step(s, { type: 'PLAY_TRAVEL', playerId: 0, cardId: s.players[0].hand[0].id, targetRepKey: target.key })
    expect(reacting.phase).toBe('REACTION')
    const acting = (c: HTMLElement) => [...c.querySelectorAll('.player-seat')].filter(el => el.classList.contains('acting')).length
    const hidden = renderAs(<TableBoard state={reacting} thinkingId={null} />, 3)
    expect(acting(hidden.container)).toBe(0)
    hidden.unmount()
    const open = renderAs(<TableBoard state={reacting} thinkingId={null} readOnly />, 3)
    expect(acting(open.container)).toBe(1)
  })
})

describe('DealHistoryPanel 终局复盘入口', () => {
  it('reviewable：每笔有"在复盘中查看"（交易编号 = 下标 + 1）和精彩标签；否则都不显示', async () => {
    const user = userEvent.setup()
    const { state, recording } = small()
    const { highlights } = buildReview(state, recording)
    const onReviewDeal = vi.fn(), onReviewHighlight = vi.fn()
    const { container, rerender } = render(
      <DealHistoryPanel state={state} highlights={highlights} reviewable onReviewDeal={onReviewDeal} onReviewHighlight={onReviewHighlight} />)
    const buttons = screen.getAllByRole('button', { name: '在复盘中查看' })
    expect(buttons).toHaveLength(state.dealHistory.length)
    // 列表倒序：第一个按钮是最后一笔
    await user.click(buttons[0])
    expect(onReviewDeal).toHaveBeenLastCalledWith(state.dealHistory.length)
    await user.click(buttons[buttons.length - 1])
    expect(onReviewDeal).toHaveBeenLastCalledWith(1)

    const tagged = highlights.find(h => h.actionIndex != null)!
    const card = container.querySelector(`.deal-record[data-deal-no="${tagged.dealNo}"]`)!
    const tag = within(card as HTMLElement).getAllByRole('button').find(b => b.classList.contains('hl-tag'))!
    await user.click(tag)
    expect(onReviewHighlight).toHaveBeenCalled()

    rerender(<DealHistoryPanel state={state} highlights={highlights} reviewable={false} />)
    expect(screen.queryAllByRole('button', { name: '在复盘中查看' })).toHaveLength(0)
    // 不可复盘时标签只展示，不能点
    expect(container.querySelectorAll('button.hl-tag')).toHaveLength(0)
    expect(container.querySelectorAll('.hl-tag.static').length).toBeGreaterThan(0)
  })

  it('进行中的对局（不传复盘参数）：和以前一样，没有任何复盘元素', () => {
    const { state } = small()
    const { container } = render(<DealHistoryPanel state={state} />)
    expect(container.querySelector('.deal-record-review')).toBeNull()
    expect(container.querySelectorAll('.deal-record')).toHaveLength(state.dealHistory.length)
  })
})

describe('useRecording', () => {
  it('终局 + 日志自洽：分片整理后 ready；对局进行中 idle；缺开局参数 / 日志接不上 unavailable', async () => {
    const { state, origin, log } = small()
    const idle = renderHook(() => useRecording(false, origin, log, state))
    expect(idle.result.current.status).toBe('idle')

    const ok = renderHook(() => useRecording(true, origin, log, state))
    expect(['building', 'ready']).toContain(ok.result.current.status)
    await waitFor(() => expect(ok.result.current.status).toBe('ready'))
    expect(ok.result.current.recording!.length).toBe(log.length)

    expect(renderHook(() => useRecording(true, null, [], state)).result.current).toEqual({ recording: null, status: 'unavailable' })
    expect(renderHook(() => useRecording(true, origin, log.slice(0, -2), state)).result.current.status).toBe('unavailable')
    // 日志自洽但对不上终态（现金被改过）→ 整理完后判不可回放
    const tampered = structuredClone(state)
    tampered.players[0].cash += 7
    const bad = renderHook(() => useRecording(true, origin, log, tampered))
    await waitFor(() => expect(bad.result.current.status).toBe('unavailable'))
    expect(bad.result.current.recording).toBeNull()
  })
})

describe('replayNav', () => {
  it('跳过放行：自动播放越过只有放行 / 跳过的步骤，但台词步不跳；单步总是前进一步', () => {
    const { recording } = game()
    const minor = recording.steps.findIndex(s => isMinorStep(s))
    expect(minor).toBeGreaterThanOrEqual(0)
    expect(nextPosition(recording, minor - 1 < 0 ? 0 : minor - 1, false)).toBe(Math.max(1, minor))
    for (let p = 0; p < recording.length; p += 7) {
      const n = nextPosition(recording, p, true)
      expect(n).toBeGreaterThan(p)
      for (let q = p + 1; q < n; q++) expect(isMinorStep(recording.steps[q - 1])).toBe(true)
      if (n < recording.length) expect(isMinorStep(recording.steps[n - 1])).toBe(false)
    }
    expect(nextPosition(recording, recording.length, true)).toBe(recording.length)
    expect(recording.steps.filter(s => s.action.say).every(s => !isMinorStep(s))).toBe(true)
  })

  it('交易与精彩时刻的前后跳转；停留时长随倍速与台词变化', () => {
    const { recording, state } = game()
    const first = recording.positionOpened(1)!
    expect(prevDealPosition(recording, first)).toBeNull()
    expect(nextDealPosition(recording, 0)).toBe(first)
    expect(nextDealPosition(recording, recording.positionOpened(recording.deals.length)!)).toBeNull()
    // 在本笔中间按"上一笔"回到本笔开头
    const mid = recording.positionOpened(3)! + 2
    expect(prevDealPosition(recording, mid)).toBe(recording.positionOpened(3))

    const { highlights } = buildReview(state, recording)
    const ps = highlightPositions(highlights)
    expect([...ps].sort((a, b) => a - b)).toEqual(ps)
    expect(nextHighlightPosition(highlights, 0)).toBe(ps[0])
    expect(prevHighlightPosition(highlights, ps[0])).toBeNull()
    expect(prevHighlightPosition(highlights, ps[ps.length - 1] + 1)).toBe(ps[ps.length - 1])
    expect(nextHighlightPosition(highlights, ps[ps.length - 1])).toBeNull()

    const plain = recording.steps.find(s => !s.action.say)!
    const talk = recording.steps.find(s => s.action.say)
    expect(stepDelayMs(plain, 2)).toBeLessThan(stepDelayMs(plain, 1))
    if (talk) expect(stepDelayMs(talk, 1)).toBeGreaterThan(stepDelayMs(plain, 1))
    expect(stepDelayMs(null, 8)).toBeGreaterThan(0)
  })
})

describe('App：从存档续局到终局 → 复盘', () => {
  it('终局存档（可回放）：结果卡出现"逐步复盘"，打开后可步进、关闭回到结果卡；对局进行中没有入口', async () => {
    const user = userEvent.setup()
    const { state, origin, log } = small()
    getDefaultStore().save({ state, origin, log, replayable: true })
    render(<App />)
    await user.click(screen.getByRole('button', { name: '继续上一局' }))
    expect(screen.getByRole('dialog', { name: '游戏结束' })).toBeTruthy()
    // 录像整理好后入口出现
    const open = (await screen.findAllByRole('button', { name: '逐步复盘' }, { timeout: 15000 }))[0]
    // 交易历史页也能进复盘
    await user.click(open)
    const viewer = screen.getByRole('dialog', { name: '逐步复盘' })
    expect(viewer).toBeTruthy()
    await user.click(within(viewer).getByRole('button', { name: /下一步/ }))
    expect(viewer.querySelector('.rv-step')!.getAttribute('data-position')).toBe('1')
    await user.click(within(viewer).getByRole('button', { name: '返回终局' }))
    expect(screen.queryByRole('dialog', { name: '逐步复盘' })).toBeNull()
    expect(screen.getByRole('dialog', { name: '游戏结束' })).toBeTruthy()

    // 回牌桌 → 交易历史页每笔有"在复盘中查看"，点击直接打开复盘并停在那一笔开单后
    await user.click(screen.getByRole('button', { name: '回到牌桌' }))
    const reviewButtons = await screen.findAllByRole('button', { name: '在复盘中查看' })
    expect(reviewButtons).toHaveLength(state.dealHistory.length)
    await user.click(reviewButtons[reviewButtons.length - 1]) // 第 1 次交易
    const v2 = screen.getByRole('dialog', { name: '逐步复盘' })
    expect(v2.querySelector('.rv-step')!.getAttribute('data-position')).toBe(String(playedGame(3, 7, 'expansion').recording.positionOpened(1)))
  }, 40000)

  it('存档不可回放（没有开局参数 / 日志）：结果卡只有统计，没有任何复盘入口', async () => {
    const user = userEvent.setup()
    const { state } = small()
    getDefaultStore().save({ state, origin: null, log: [], replayable: false })
    render(<App />)
    await user.click(screen.getByRole('button', { name: '继续上一局' }))
    expect(screen.getByRole('dialog', { name: '游戏结束' })).toBeTruthy()
    expect(screen.getByText(/无法逐步复盘/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '逐步复盘' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '回到牌桌' }))
    expect(screen.queryAllByRole('button', { name: '在复盘中查看' })).toHaveLength(0)
    expect(screen.queryAllByRole('button', { name: '逐步复盘' })).toHaveLength(0)
  })
})
