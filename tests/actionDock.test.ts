// 操作区：按钮可用性与引擎合法动作同口径（服务端渲染成静态 HTML 检查，无需浏览器）

import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ActionDock from '../src/components/ActionDock'
import { MAX_OFFERS_PER_BOSS } from '../src/engine/config'
import { getLegalActions } from '../src/engine/validator'
import type { GameState } from '../src/engine/types'
import { baseState, setInvestors, openDealAt, toBoss } from './helpers'

function renderDock(s: GameState): string {
  return renderToStaticMarkup(createElement(ActionDock, {
    state: s, legal: getLegalActions(s, 0), act: () => {},
    selection: new Set<number>(), selectMode: null,
    onToggleTradeMode: () => {}, onOpenOfferEditor: () => {},
  }))
}

/** 找到"提出方案 / 修改方案"按钮的开标签与文字 */
function proposeButton(html: string): string {
  const m = html.match(/<button[^>]*>(?:提出方案|修改方案)[^<]*<\/button>/)
  expect(m, '应渲染出提案按钮').not.toBeNull()
  return m![0]
}

describe('ActionDock 提案按钮', () => {
  function bossTurn() {
    const s = baseState(4, 2)
    setInvestors(s, { A: 0, B: 1, C: 2, D: 3 })
    return toBoss(openDealAt(s, 1, 0)) // 人类（0）是 Boss，桌上 A+B 凑得齐
  }

  it('还有提案次数时可点', () => {
    const s = bossTurn()
    expect(getLegalActions(s, 0).some(a => a.type === 'PROPOSE_OFFER')).toBe(true)
    expect(proposeButton(renderDock(s))).not.toContain('disabled')
  })

  it('本任 Boss 提案次数用完：引擎不再接受提案，按钮置灰并说明原因', () => {
    const s = bossTurn()
    s.negotiation!.offersMade = MAX_OFFERS_PER_BOSS
    expect(getLegalActions(s, 0).some(a => a.type === 'PROPOSE_OFFER')).toBe(false)
    const btn = proposeButton(renderDock(s))
    expect(btn).toContain('disabled')
    expect(btn).toContain('次数已用完')
  })
})
