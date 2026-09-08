// 整局回归：启发式 / 随机策略各跑若干局，任何一步违反不变量或卡死都算失败
// （更大规模的批量仿真用 npm run simulate）

import { describe, it, expect } from 'vitest'
import { runGame, runGameViaSession, narrateGame } from '../src/sim/harness'

const seeds = Array.from({ length: 12 }, (_, i) => i + 1)

describe('整局仿真', () => {
  it.each([3, 4, 5, 6])('启发式策略 %i 人局：全部跑到终局且不变量成立', playerCount => {
    for (const seed of seeds) {
      const r = runGame({ playerCount, seed, mode: 'heuristic' })
      expect(r.ok, `seed=${seed}: ${r.reason}`).toBe(true)
      expect(r.final.phase).toBe('GAME_OVER')
      expect(r.deals).toBeGreaterThanOrEqual(10)
      expect(r.deals).toBeLessThanOrEqual(15)
      expect(r.final.winnerIds.length).toBeGreaterThan(0)
    }
  })

  it.each([3, 6])('随机策略 %i 人局：任何合法动作序列都不会破坏不变量', playerCount => {
    for (const seed of seeds) {
      const r = runGame({ playerCount, seed, mode: 'random' })
      expect(r.ok, `seed=${seed}: ${r.reason}`).toBe(true)
    }
  })

  it('经由 GameSession 运行时跑完一局，结果与同步仿真一致（同种子）', async () => {
    const viaSession = await runGameViaSession({ playerCount: 4, seed: 7 })
    expect(viaSession.ok, viaSession.reason).toBe(true)
    const direct = runGame({ playerCount: 4, seed: 7, mode: 'heuristic' })
    expect(viaSession.final.stateVersion).toBe(direct.final.stateVersion)
    expect(viaSession.cash).toEqual(direct.cash)
    expect(viaSession.final.winnerIds).toEqual(direct.final.winnerIds)
  })

  it('谈判是活的：多数交易里有人公开报价，且承诺价机制在被使用（自动同意出现）', () => {
    let opened = 0, withBid = 0, autoAccepts = 0, offers = 0
    for (const seed of seeds) {
      const r = runGame({ playerCount: 4, seed, mode: 'heuristic' })
      // 事件流只保留末尾 300 条：按其中完整出现的交易统计
      let sawBid = false, inDeal = false
      for (const e of r.final.events) {
        if (e.kind === 'DEAL_OPENED') { inDeal = true; sawBid = false; opened++; continue }
        if (!inDeal) continue
        if (e.kind === 'DEMAND') sawBid = true
        if (e.kind === 'OFFER_PROPOSED') offers++
        if (e.kind === 'OFFER_ACCEPTED' && e.auto) autoAccepts++
        if (e.kind === 'DEAL_CLOSED' || e.kind === 'DEAL_FAILED') { inDeal = false; if (sawBid) withBid++ }
      }
    }
    expect(opened).toBeGreaterThan(30)
    expect(withBid / opened).toBeGreaterThan(0.5)
    expect(autoAccepts).toBeGreaterThan(offers * 0.3)
  })

  it('事件流可以完整讲述整局，条数与事件数一致且无空行', () => {
    const r = runGame({ playerCount: 4, seed: 3, mode: 'heuristic' })
    const lines = narrateGame(r.final)
    expect(lines).toHaveLength(r.final.events.length)
    expect(lines.every(l => l.trim().length > 0)).toBe(true)
    expect(lines.at(-1)).toMatch(/游戏结束|获胜|胜/)
  })
})
