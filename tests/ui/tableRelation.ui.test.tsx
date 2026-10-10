// @vitest-environment jsdom
// TableBoard 把"AI 对你的态度"传给座位（relationsToward 由 AI 线实现，这里用桩替身验证接线）

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { cleanup } from '@testing-library/react'
import TableBoard from '../../src/components/TableBoard'
import { placeMarkerState, renderAs } from './fixtures'

vi.mock('../../src/ai/relations', () => ({
  relationsToward: () => ({
    1: { score: -2, reasons: ['你上一笔把他的代表打飞了'] },
    2: { score: 0, reasons: [] },
    3: { score: 1, reasons: ['你照顾过他的报价'] },
  }),
}))

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(cleanup)

describe('TableBoard 座位上的态度图标', () => {
  it('非零态度显示图标并带原因；中性与自己的座位不显示', () => {
    const s = placeMarkerState()
    const { container } = renderAs(<TableBoard state={s} thinkingId={null} />, 0)
    const seats = [...container.querySelectorAll('.player-seat')]
    const rel = (i: number) => seats[i].querySelector('.seat-relation')
    expect(rel(0)).toBeNull()
    expect(rel(1)).not.toBeNull()
    expect(rel(1)!.getAttribute('title')).toContain('把他的代表打飞了')
    expect(rel(2)).toBeNull()
    expect(rel(3)).not.toBeNull()
    expect(rel(1)!.textContent).not.toBe(rel(3)!.textContent)
  })
})
