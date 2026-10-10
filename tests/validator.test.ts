// 合法动作口径：validator 列出的每个动作都必须能被 reducer 接受（性质测试）

import { describe, it, expect } from 'vitest'
import { createInitialState, gameReducer } from '../src/engine/gameEngine'
import { getActingPlayerId, getLegalActions, isLegal, buildOfferCandidates, defaultDiscardIds } from '../src/engine/validator'
import { validateOfferShape, hasMeaningfulClosingPlay } from '../src/engine/rules'
import { heuristicAction } from '../src/ai/heuristic'
import { describeAction } from '../src/text/labels'
import type { GameState } from '../src/engine/types'
import { baseState, setInvestors, openDealAt, clearHand, giveCards } from './helpers'

function randomWalk(seed: number, steps: number, visit: (s: GameState) => void) {
  let s = createInitialState(3 + (seed % 4), '测试', seed)
  for (const p of s.players) p.isAI = true
  let x = seed * 2654435761 >>> 0
  const rnd = () => { x = (x * 1103515245 + 12345) >>> 0; return x / 4294967296 }
  for (let i = 0; i < steps && s.phase !== 'GAME_OVER'; i++) {
    visit(s)
    const legal = getLegalActions(s, getActingPlayerId(s))
    // 交替使用随机与启发式动作，覆盖更多分支
    const action = (i % 3 === 0 ? heuristicAction(s) : null) ?? legal[Math.floor(rnd() * legal.length)]
    s = gameReducer(s, action)!
  }
}

describe('合法动作与引擎口径一致', () => {
  it('随机游走中：每个列出的动作都通过 isLegal 且被 reducer 接受；非行动者没有合法动作', () => {
    let checked = 0
    for (let seed = 1; seed <= 6; seed++) {
      randomWalk(seed, 400, s => {
        const actingId = getActingPlayerId(s)
        expect(actingId).toBeGreaterThanOrEqual(0)
        const legal = getLegalActions(s, actingId)
        expect(legal.length).toBeGreaterThan(0)
        for (const a of legal) {
          expect(a.playerId).toBe(actingId)
          expect(isLegal(s, a), `${a.type} 应合法 phase=${s.phase}`).toBe(true)
          const next = gameReducer(s, a)
          expect(next && next.stateVersion === s.stateVersion + 1, `reducer 应接受 ${a.type}`).toBe(true)
          expect(typeof describeAction(s, a)).toBe('string')
          checked++
        }
        for (const p of s.players) if (p.id !== actingId) expect(getLegalActions(s, p.id)).toEqual([])
        // 启发式策略永远给出合法动作
        const h = heuristicAction(s)
        expect(h && isLegal(s, h)).toBe(true)
      })
    }
    expect(checked).toBeGreaterThan(2000)
  })

  it('成交倒计时：hasMeaningfulClosingPlay 与"除放行外还有合法动作"同口径；旅行 / 招募只指向方案所用代表', () => {
    let closing = 0, meaningful = 0
    for (let seed = 1; seed <= 24; seed++) {
      randomWalk(seed, 500, s => {
        if (s.phase !== 'CLOSING') return
        const id = getActingPlayerId(s)
        const legal = getLegalActions(s, id)
        const extra = legal.filter(a => a.type !== 'PASS_CLOSING')
        expect(hasMeaningfulClosingPlay(s, id), `玩家 ${id}`).toBe(extra.length > 0)
        const used = s.negotiation!.offer!.repKeys
        for (const a of extra) {
          if (a.type === 'PLAY_TRAVEL') expect(used).toContain(a.targetRepKey)
          if (a.type === 'PLAY_RECRUITMENT') expect(used).toContain(`INV:${a.targetFamilyId}`)
        }
        closing++
        if (extra.length) meaningful++
      })
    }
    expect(closing).toBeGreaterThan(20)
    expect(meaningful).toBeGreaterThan(0)
  })

  it('reducer 对非法动作返回原引用（不产生副本）', () => {
    const s = baseState(4, 3)
    expect(gameReducer(s, { type: 'ROLL_MOVE', playerId: 0 })).toBe(s)
    expect(gameReducer(s, { type: 'PASS', playerId: 1 })).toBe(s)
  })
})

describe('方案候选与默认弃牌', () => {
  it('候选方案全部结构合法，且 needsConsent / bossKeep 与内容一致', () => {
    let s = baseState(4, 21)
    setInvestors(s, { A: 0, B: 1, C: 2, D: 3 })
    s = openDealAt(s, 7, 0) // A+B+C 全部 + D/E/F 中 2 → 凑不齐（E、F 在公共区）
    expect(buildOfferCandidates(s)).toEqual([])

    let t = baseState(4, 21)
    setInvestors(t, { A: 0, B: 1, C: 2, D: 3 })
    t = openDealAt(t, 1, 0) // A(Boss) + B(玩家 1)
    const cands = buildOfferCandidates(t)
    expect(cands.length).toBeGreaterThan(0)
    for (const c of cands) {
      expect(validateOfferShape(t, c.repKeys, c.payouts)).toBeNull()
      expect(c.bossKeep).toBe(6 - c.payouts.reduce((n, p) => n + p.amount, 0))
      expect(c.needsConsent).toBe(true)
    }
    expect(cands.map(c => c.key)).toContain('stingy')
    expect(cands.map(c => c.key)).toContain('fair')
  })

  it('默认弃牌先弃最没用的，保留阻止牌 / 老板牌 / 万能旅行牌', () => {
    const s = baseState(4, 22)
    clearHand(s, 0)
    giveCards(s, 0, [{ type: 'STOP' }, { type: 'BOSS' }, { type: 'TRAVEL' }, ...Array.from({ length: 11 }, () => ({ type: 'RECRUITMENT' as const }))])
    expect(s.players[0].hand).toHaveLength(14)
    const ids = defaultDiscardIds(s, 0)
    expect(ids).toHaveLength(2)
    for (const id of ids) expect(s.players[0].hand.find(c => c.id === id)!.type).toBe('RECRUITMENT')
    expect(defaultDiscardIds(baseState(4, 22), 0)).toEqual([]) // 未超限不弃
  })
})
