// @vitest-environment jsdom
// 卡面：每种牌的图标 / 标题 / 效果摘要 / 家族色；不可打的牌清晰可读；放大预览；新牌标记；键盘可操作
// 同时覆盖纯逻辑 cardFace（ui/cardInfo）

import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, act, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CardHand, { NEW_CARD_MS } from '../../src/components/CardHand'
import { CARD_ACCENT, CARD_ICONS, CARD_KIND, cardFace } from '../../src/ui/cardInfo'
import { BOOM_BONUS, BUST_PENALTY, FAMILIES } from '../../src/engine/config'
import type { CardType, GameState, InfluenceCard } from '../../src/engine/types'
import { biddingState, clearHand, giveCards, legalFor, renderAs, actSpy } from './fixtures'

afterEach(() => { cleanup(); vi.useRealTimers() })

const ALL_TYPES: CardType[] = ['CLAN', 'TRAVEL', 'RECRUITMENT', 'BOSS', 'STOP', 'BOOM', 'BUST', 'EXCLUSIVE', 'SICK']

describe('cardFace（纯逻辑）', () => {
  it('每种牌都有图标 / 牌种名 / 标题 / 摘要 / 说明 / 主题色', () => {
    for (const type of ALL_TYPES) {
      const card: InfluenceCard = { id: 1, type, familyId: type === 'CLAN' ? 'C' : undefined }
      const f = cardFace(card)
      expect(f.icon, type).toBe(CARD_ICONS[type])
      expect(f.kind, type).toBe(CARD_KIND[type])
      expect(f.title.length, type).toBeGreaterThan(0)
      expect(f.summary.length, type).toBeGreaterThan(0)
      expect(f.detail.length, type).toBeGreaterThan(f.summary.length)
      expect(f.accent, type).toMatch(/^#/)
    }
  })

  it('家族成员卡用家族色与家族名；旅行牌区分万能与定向；稀有牌的数值取自 config', () => {
    expect(cardFace({ id: 1, type: 'CLAN', familyId: 'D' })).toMatchObject({ title: FAMILIES.D.name, accent: FAMILIES.D.color, familyId: 'D' })
    const wild = cardFace({ id: 2, type: 'TRAVEL' })
    const directed = cardFace({ id: 3, type: 'TRAVEL', familyId: 'B' })
    expect(wild.title).not.toBe(directed.title)
    expect(directed.title).toContain(FAMILIES.B.name)
    expect(directed.accent).toBe(CARD_ACCENT.TRAVEL)
    // 家族字母徽章恒用家族色：定向旅行牌与同家族的家族卡颜色一致
    expect(directed.familyColor).toBe(FAMILIES.B.color)
    expect(cardFace({ id: 7, type: 'CLAN', familyId: 'B' }).familyColor).toBe(FAMILIES.B.color)
    expect(wild.familyColor).toBeUndefined()
    expect(cardFace({ id: 4, type: 'BOOM' }).summary).toContain(String(BOOM_BONUS))
    expect(cardFace({ id: 5, type: 'BUST' }).summary).toContain(String(BUST_PENALTY))
    expect(cardFace({ id: 6, type: 'BOOM' }).badge).toBe('稀有')
    expect(cardFace({ id: 7, type: 'SICK' }).badge).toBe('桌规')
  })
})

/** 叫价轮，轮到 0 号；0 号手里：家族 B 卡、阻止、万能旅行 */
function hand0(): GameState {
  const s = biddingState(1, 0)
  clearHand(s, 0)
  giveCards(s, 0, [{ type: 'CLAN', familyId: 'B' }, { type: 'STOP' }, { type: 'TRAVEL' }])
  return s
}

function view(s: GameState, viewerId = 0) {
  const { act: actFn } = actSpy()
  return renderAs(
    <CardHand state={s} legal={legalFor(s, viewerId)} act={actFn} selectMode={null} selection={new Set<number>()} onToggleSelect={() => {}} />,
    viewerId,
  )
}
const cardEls = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('.hand-cards .card')]

describe('CardHand 卡面', () => {
  it('每张牌：图标、牌种、标题、一句效果摘要；家族牌有家族色字母徽章与家族色变量', () => {
    const { container } = view(hand0())
    const cards = cardEls(container)
    expect(cards).toHaveLength(3)
    for (const c of cards) {
      expect(c.querySelector('.card-icon')!.textContent!.length).toBeGreaterThan(0)
      expect(c.querySelector('.card-type')!.textContent!.length).toBeGreaterThan(0)
      expect(c.querySelector('.card-name')!.textContent!.length).toBeGreaterThan(0)
      expect(c.querySelector('.card-effect')!.textContent!.length).toBeGreaterThan(0)
    }
    const clan = cards.find(c => c.classList.contains('type-clan'))!
    expect(clan.querySelector('.card-letter')!.textContent).toBe('B')
    expect(clan.style.getPropertyValue('--accent')).toBe(FAMILIES.B.color)
    expect(clan.textContent).toContain(FAMILIES.B.name)
    const stop = cards.find(c => c.classList.contains('type-stop'))!
    expect(stop.querySelector('.card-letter')).toBeNull()
    expect(stop.style.getPropertyValue('--accent')).toBe(CARD_ACCENT.STOP)
  })

  it('不可打的牌：降低存在感（idle、aria-disabled）但摘要文字仍在、不再用 opacity 把文字压暗', () => {
    const { container } = view(hand0())
    const stop = cardEls(container).find(c => c.classList.contains('type-stop'))!
    expect(stop.classList.contains('idle')).toBe(true)
    expect(stop.getAttribute('aria-disabled')).toBe('true')
    expect(stop.querySelector('.card-effect')!.textContent!.length).toBeGreaterThan(0)
    expect(stop.style.opacity).toBe('')
    const clan = cardEls(container).find(c => c.classList.contains('type-clan'))!
    expect(clan.classList.contains('playable')).toBe(true)
    expect(clan.getAttribute('aria-disabled')).toBeNull()
  })

  it('卡牌是可聚焦的按钮：读屏标签含牌种与效果；Enter 打开弹层并把焦点移进去，Esc 收起且焦点回到这张牌', async () => {
    const user = userEvent.setup()
    const { container } = view(hand0())
    const clan = cardEls(container).find(c => c.classList.contains('type-clan'))!
    expect(clan.getAttribute('role')).toBe('button')
    expect(clan.tabIndex).toBe(0)
    expect(clan.getAttribute('aria-label')).toContain(FAMILIES.B.name)
    clan.focus()
    await user.keyboard('{Enter}')
    const pop = container.querySelector('.card-popover') as HTMLElement
    expect(pop).not.toBeNull()
    expect(pop.contains(document.activeElement)).toBe(true) // 焦点进入弹层，键盘用户能直接操作出牌选项
    await user.keyboard('{Escape}')
    expect(container.querySelector('.card-popover')).toBeNull()
    expect(document.activeElement).toBe(clan) // 焦点还给这张牌
  })

  it('键盘聚焦放大预览：完整说明 + 当前能 / 不能打的原因；失焦收起', async () => {
    const user = userEvent.setup()
    const { container } = view(hand0())
    await user.tab()
    const zoom = container.querySelector('.card-zoom') as HTMLElement
    expect(zoom).not.toBeNull()
    expect(zoom.getAttribute('role')).toBe('tooltip')
    expect(zoom.querySelector('.zoom-detail')!.textContent!.length).toBeGreaterThan(10)
    expect(zoom.querySelector('.zoom-status')!.textContent!.length).toBeGreaterThan(0)
    const focused = document.activeElement as HTMLElement
    expect(focused.getAttribute('aria-describedby')).toBe('card-zoom')
    // （jsdom 的 :focus-visible 只对首次聚焦成立，所以不测"换牌跟随"）
    act(() => { (document.activeElement as HTMLElement).blur() })
    expect(container.querySelector('.card-zoom')).toBeNull()
  })

  it('鼠标悬停约 0.3 秒后放大，移开立刻收起；点击打开弹层时不再显示预览', () => {
    vi.useFakeTimers()
    const { container } = view(hand0())
    const clan = cardEls(container).find(c => c.classList.contains('type-clan'))!
    fireEvent.pointerEnter(clan, { pointerType: 'mouse' })
    expect(container.querySelector('.card-zoom')).toBeNull()
    act(() => { vi.advanceTimersByTime(350) })
    expect(container.querySelector('.card-zoom')).not.toBeNull()
    fireEvent.pointerLeave(clan, { pointerType: 'mouse' })
    expect(container.querySelector('.card-zoom')).toBeNull()

    fireEvent.pointerEnter(clan, { pointerType: 'mouse' })
    act(() => { vi.advanceTimersByTime(350) })
    fireEvent.pointerDown(clan, { pointerType: 'mouse' })
    fireEvent.click(clan)
    expect(container.querySelector('.card-popover')).not.toBeNull()
    expect(container.querySelector('.card-zoom')).toBeNull()
  })

  it('触屏长按放大，且长按后的那次点击不会误打出牌', () => {
    vi.useFakeTimers()
    const { container } = view(hand0())
    const clan = cardEls(container).find(c => c.classList.contains('type-clan'))!
    fireEvent.pointerDown(clan, { pointerType: 'touch' })
    act(() => { vi.advanceTimersByTime(520) })
    expect(container.querySelector('.card-zoom')).not.toBeNull()
    fireEvent.pointerUp(clan, { pointerType: 'touch' })
    fireEvent.click(clan) // 长按结束时浏览器补发的 click
    expect(container.querySelector('.card-popover')).toBeNull()
    fireEvent.click(clan) // 之后的正常点击照常打开
    expect(container.querySelector('.card-popover')).not.toBeNull()
  })

  it('新抽到的牌带"新"标记与入场类，到时消失；挂载时已有的手牌不算新', () => {
    vi.useFakeTimers()
    const s = hand0()
    const act0 = actSpy().act
    const props = { act: act0, selectMode: null, selection: new Set<number>(), onToggleSelect: () => {} }
    const { container, rerender } = renderAs(<CardHand state={s} legal={legalFor(s, 0)} {...props} />)
    expect(container.querySelectorAll('.card-new-badge')).toHaveLength(0)

    const s2 = structuredClone(s)
    const [fresh] = giveCards(s2, 0, [{ type: 'BOSS' }])
    rerender(<CardHand state={s2} legal={legalFor(s2, 0)} {...props} />)
    const badges = container.querySelectorAll('.card-new-badge')
    expect(badges).toHaveLength(1)
    const card = badges[0].closest('.card') as HTMLElement
    expect(card.dataset.cardId).toBe(String(fresh.id))
    expect(card.classList.contains('card-new')).toBe(true)
    expect(card.getAttribute('aria-label')).toContain('新')

    act(() => { vi.advanceTimersByTime(NEW_CARD_MS + 50) })
    expect(container.querySelectorAll('.card-new-badge')).toHaveLength(0)
    expect(container.querySelector('.card-new')).toBeNull()
  })

  it('打出一张牌（手牌减少）不会让其余的牌变成"新"', () => {
    const s = hand0()
    const props = { act: actSpy().act, selectMode: null, selection: new Set<number>(), onToggleSelect: () => {} }
    const { container, rerender } = renderAs(<CardHand state={s} legal={legalFor(s, 0)} {...props} />)
    const s2 = structuredClone(s)
    s2.players[0].hand.shift()
    rerender(<CardHand state={s2} legal={legalFor(s2, 0)} {...props} />)
    expect(container.querySelectorAll('.card-new-badge')).toHaveLength(0)
  })

  it('选牌模式：已选的牌带"弃"标记；点击仍走 onToggleSelect', async () => {
    const user = userEvent.setup()
    const s = hand0()
    const onToggle = vi.fn()
    const first = s.players[0].hand[0].id
    const { container } = renderAs(
      <CardHand state={s} legal={legalFor(s, 0)} act={vi.fn()} selectMode="discard" selection={new Set([first])} onToggleSelect={onToggle} />,
    )
    const sel = container.querySelector('.card.selected') as HTMLElement
    expect(within(sel).getByText('弃')).toBeTruthy()
    await user.click(cardEls(container)[1])
    expect(onToggle).toHaveBeenCalledWith(s.players[0].hand[1].id)
  })
})
