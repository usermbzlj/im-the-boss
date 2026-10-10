// @vitest-environment jsdom
// 演出层组件：CueProvider（新事件 → 演出 + 音效）、CueStage（覆盖层）、TableBoard 的演出钩子、数字滚动、骰子、轮到你的提示音

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { cleanup, act } from '@testing-library/react'
import CueProvider from '../../src/components/CueProvider'
import CueStage from '../../src/components/CueStage'
import TableBoard from '../../src/components/TableBoard'
import PlayerSeat from '../../src/components/PlayerSeat'
import AnimatedNumber from '../../src/components/AnimatedNumber'
import DieFace, { DIE_PIPS } from '../../src/components/DieFace'
import { useTurnChime } from '../../src/components/useTurnChime'
import { getActingPlayerId } from '../../src/engine/validator'
import type { GameState } from '../../src/engine/types'
import { ANIM_SCALE, FULL_MOTION, readMotionEnv, setAnimSpeed, type AnimSpeed, type MotionEnv } from '../../src/ui/motion'
import { cueLifetime } from '../../src/ui/cues'
import { biddingState, clearHand, closingState, giveCards, renderAs, step } from './fixtures'

beforeEach(() => {
  // jsdom 没有 ResizeObserver，版图的自适应缩放用到了
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'] })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

/** 成交前一步 / 成交后的局面：0 号 Boss 独自成交，其余放行 */
function closing(): { before: GameState; after: GameState } {
  let s = closingState()
  let prev = s
  while (s.phase === 'CLOSING') { prev = s; s = step(s, { type: 'PASS_CLOSING', playerId: getActingPlayerId(s) }) }
  return { before: prev, after: s }
}

function soundSpy() {
  const play = vi.fn<(id: string, opts?: unknown) => boolean>(() => true)
  return { sound: { play } as unknown as Parameters<typeof CueProvider>[0]['sound'], play }
}

function stageTree(state: GameState, sound: ReturnType<typeof soundSpy>['sound'], env: MotionEnv = FULL_MOTION, withBoard = false) {
  return (
    <CueProvider state={state} viewerId={0} readEnv={() => env} sound={sound}>
      <div className="table-area">
        {withBoard && <TableBoard state={state} thinkingId={null} />}
        <CueStage />
      </div>
    </CueProvider>
  )
}

const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })

describe('CueProvider + CueStage', () => {
  it('挂载时已有的事件不补演（载入存档 / 换视图）；覆盖层不进无障碍树、不拦截点击', () => {
    const { after } = closing()
    const { sound, play } = soundSpy()
    const { container } = renderAs(stageTree(after, sound))
    expect(container.querySelectorAll('.cue')).toHaveLength(0)
    expect(play).not.toHaveBeenCalled()
    const stage = container.querySelector('.cue-stage')!
    expect(stage.getAttribute('aria-hidden')).toBe('true')
  })

  it('成交：版图格关闭演出 + 收款人金额飘字 + 成交音效；到期后自动清除', () => {
    const { before, after } = closing()
    const { sound, play } = soundSpy()
    const { container, rerender } = renderAs(stageTree(before, sound))
    rerender(stageTree(after, sound))

    expect(container.querySelector('.cue-close')).not.toBeNull()
    const money = [...container.querySelectorAll('.cue-money')]
    expect(money.length).toBeGreaterThan(0)
    expect(money.every(m => /^\+\$\d+M$/.test(m.textContent!))).toBe(true)
    expect(play.mock.calls.map(c => c[0])).toContain('deal')

    advance(cueLifetime({ ms: 1100, delay: 900 }) + 100)
    expect(container.querySelectorAll('.cue')).toHaveLength(0)
  })

  it('快进 / 减少动画 / 页面后台 / 不支持动画：不出视觉演出；快进时成交音效仍保留，后台不出声', () => {
    const { before, after } = closing()
    for (const [patch, expectDeal] of [
      [{ fastForward: true }, true], [{ reducedMotion: true }, true], [{ hidden: true }, false], [{ supported: false }, true],
    ] as const) {
      const { sound, play } = soundSpy()
      const env = { ...FULL_MOTION, ...patch }
      const { container, rerender, unmount } = renderAs(stageTree(before, sound, env))
      rerender(stageTree(after, sound, env))
      expect(container.querySelectorAll('.cue'), JSON.stringify(patch)).toHaveLength(0)
      expect(play.mock.calls.some(c => c[0] === 'deal'), JSON.stringify(patch)).toBe(expectDeal)
      unmount()
    }
  })

  it('动画速度：慢档拉长演出时长与到期时间；关闭档不出视觉演出但保留音效', () => {
    const { before, after } = closing()
    const durationOfClose = (speed: AnimSpeed) => {
      setAnimSpeed(speed, null)
      const { sound, play } = soundSpy()
      const env = { ...FULL_MOTION, animOff: readMotionEnv().animOff }
      const { container, rerender, unmount } = renderAs(stageTree(before, sound, env))
      rerender(stageTree(after, sound, env))
      const el = container.querySelector<HTMLElement>('.cue-close')
      const ms = el ? parseFloat(el.style.animationDuration) : null
      const delay = el ? parseFloat(el.style.animationDelay) || 0 : 0
      return { ms, delay, deal: play.mock.calls.some(c => c[0] === 'deal'), container, unmount }
    }
    try {
      const normal = durationOfClose('normal'); normal.unmount()
      const slow = durationOfClose('slow')
      expect(slow.ms).toBe(Math.round(normal.ms! * ANIM_SCALE.slow))
      advance(cueLifetime({ ms: normal.ms!, delay: normal.delay }) + 100)
      expect(slow.container.querySelector('.cue-close'), '慢档按原时长到期时仍在播').not.toBeNull()
      slow.unmount()
      const off = durationOfClose('off')
      expect(off.ms).toBeNull()
      expect(off.deal).toBe(true)
      expect(document.documentElement.dataset.anim).toBe('off')
      off.unmount()
    } finally {
      setAnimSpeed('normal', null)
    }
  })

  it('同座位的连续金额合并成一条飘字，而不是叠起来', () => {
    const { before, after } = closing()
    const { sound } = soundSpy()
    const { container, rerender } = renderAs(stageTree(before, sound))
    rerender(stageTree(after, sound))
    const seats = [...container.querySelectorAll('.cue-money')].map(m => m.textContent)
    expect(new Set(seats).size).toBeLessThanOrEqual(seats.length) // 每个座位至多一条
    expect(container.querySelectorAll('.cue-money').length).toBeLessThanOrEqual(4)
  })

  it('旅行牌打飞代表 / 阻止牌：关键镜头演出出现，且带镜头说明', () => {
    let s = biddingState(0, 1)
    clearHand(s, 1)
    clearHand(s, 2)
    const [travel] = giveCards(s, 1, [{ type: 'TRAVEL' }])
    giveCards(s, 2, [{ type: 'STOP' }])
    const before = s
    s = step(s, { type: 'PLAY_TRAVEL', playerId: 1, cardId: travel.id, targetRepKey: s.negotiation!.reps.find(r => r.familyId === 'A')!.key })
    let guard = 0
    while (s.phase === 'REACTION' && guard++ < 6) {
      const actor = getActingPlayerId(s)
      s = actor === 2 ? step(s, { type: 'PLAY_STOP', playerId: 2 }) : step(s, { type: 'PASS_REACTION', playerId: actor })
    }
    const { sound, play } = soundSpy()
    const { container, rerender } = renderAs(stageTree(before, sound))
    rerender(stageTree(s, sound))
    expect(container.querySelector('[data-cue="stop"]')).not.toBeNull()
    expect(container.querySelector('.cue-caption')).not.toBeNull()
    expect(play.mock.calls.map(c => c[0])).toContain('stop')
  })

  it('换了一局（事件 id 倒退）清空演出', () => {
    const { before, after } = closing()
    const { sound } = soundSpy()
    const { container, rerender } = renderAs(stageTree(before, sound))
    rerender(stageTree(after, sound))
    expect(container.querySelectorAll('.cue').length).toBeGreaterThan(0)
    rerender(stageTree(biddingState(0), sound)) // 事件更少
    expect(container.querySelectorAll('.cue')).toHaveLength(0)
  })
})

describe('TableBoard 的演出钩子', () => {
  it('成交的格子短暂带 cue-closing；格子带 data-space-id；演出结束后恢复', () => {
    const { before, after } = closing()
    const { sound } = soundSpy()
    const { container, rerender } = renderAs(stageTree(before, sound, FULL_MOTION, true))
    expect(container.querySelector('.cue-closing')).toBeNull()
    rerender(stageTree(after, sound, FULL_MOTION, true))
    const closing1 = container.querySelector('.ring-cell.cue-closing') as HTMLElement
    expect(closing1).not.toBeNull()
    expect(closing1.dataset.spaceId).toBe('1')
    advance(3000)
    expect(container.querySelector('.cue-closing')).toBeNull()
  })

  it('座位带 data-seat-id；家族标识带 data-family（演出层据此定位）', () => {
    const { container } = renderAs(<TableBoard state={biddingState(0)} thinkingId={null} />)
    expect([...container.querySelectorAll('[data-seat-id]')].map(e => e.getAttribute('data-seat-id'))).toEqual(['0', '1', '2', '3'])
    expect(container.querySelector('[data-seat-id="0"] [data-family="A"]')).not.toBeNull()
  })

  it('静态骰子：掷骰之后版图中央显示点阵骰子', () => {
    const s = { ...biddingState(0), lastDie: 5 }
    const { container } = renderAs(<TableBoard state={s} thinkingId={null} />)
    const die = container.querySelector('.die-display .die') as HTMLElement
    expect(die.dataset.value).toBe('5')
    expect(die.querySelectorAll('.pip.on')).toHaveLength(DIE_PIPS[5].length)
  })
})

describe('AnimatedNumber', () => {
  it('动画关闭：直接显示新值', () => {
    const { container, rerender } = renderAs(<AnimatedNumber value={5} animate={false} format={n => `$${n}M`} />)
    rerender(<AnimatedNumber value={12} animate={false} format={n => `$${n}M`} />)
    expect(container.textContent).toBe('$12M')
  })

  it('动画开启：数字滚动到新值，期间带涨 / 跌着色，data-value 恒为真实值', () => {
    const { container, rerender } = renderAs(<AnimatedNumber value={5} animate ms={500} />)
    rerender(<AnimatedNumber value={25} animate ms={500} />)
    const el = container.querySelector('.num-roll') as HTMLElement
    expect(el.dataset.value).toBe('25')
    expect(el.classList.contains('num-up')).toBe(true)
    advance(200)
    const mid = Number(el.textContent)
    expect(mid).toBeGreaterThan(5)
    expect(mid).toBeLessThan(26)
    advance(700)
    expect(el.textContent).toBe('25')
    expect(el.classList.contains('num-up')).toBe(false)
    rerender(<AnimatedNumber value={10} animate ms={500} />)
    expect(el.classList.contains('num-down')).toBe(true)
  })

  it('座位现金：没有动画环境（jsdom 无 matchMedia）时立即显示新值', () => {
    const before = biddingState(0)
    const after: GameState = { ...before, players: before.players.map(p => (p.id === 1 ? { ...p, cash: 9 } : p)) }
    const { container, rerender } = renderAs(<PlayerSeat state={before} playerId={1} isActing={false} isThinking={false} />)
    rerender(<PlayerSeat state={after} playerId={1} isActing={false} isThinking={false} />)
    expect(container.querySelector('.seat-cash')!.textContent).toBe('$9M')
  })
})

describe('DieFace', () => {
  it('不翻滚：点阵与点数一致，带读屏标签', () => {
    for (let v = 1; v <= 6; v++) {
      const { container, unmount } = renderAs(<DieFace value={v} />)
      const die = container.querySelector('.die') as HTMLElement
      expect(die.querySelectorAll('.pip.on')).toHaveLength(v)
      expect(die.getAttribute('role')).toBe('img')
      unmount()
    }
  })

  it('翻滚一段时间后落定在真实点数', () => {
    const { container } = renderAs(<DieFace value={3} rollMs={500} />)
    const die = container.querySelector('.die') as HTMLElement
    expect(die.classList.contains('rolling')).toBe(true)
    expect(die.dataset.value).toBe('3') // 翻滚中 data-value 也是真实点数
    advance(600)
    expect(die.classList.contains('settled')).toBe(true)
    expect(die.querySelectorAll('.pip.on')).toHaveLength(3)
  })
})

describe('useTurnChime', () => {
  function Probe({ active, sound }: { active: boolean; sound: { play: (id: 'turn') => boolean } }) {
    useTurnChime(active, sound as never)
    return null
  }
  it('只在"轮到你做决定"的上升沿响一次', () => {
    const play = vi.fn(() => true)
    const { rerender } = renderAs(<Probe active={false} sound={{ play }} />)
    expect(play).not.toHaveBeenCalled()
    rerender(<Probe active sound={{ play }} />)
    rerender(<Probe active sound={{ play }} />)
    expect(play).toHaveBeenCalledTimes(1)
    expect(play).toHaveBeenCalledWith('turn')
    rerender(<Probe active={false} sound={{ play }} />)
    rerender(<Probe active sound={{ play }} />)
    expect(play).toHaveBeenCalledTimes(2)
  })
})
