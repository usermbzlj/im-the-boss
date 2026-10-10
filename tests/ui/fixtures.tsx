// 组件测试夹具：用引擎真实的 createInitialState / reducer（经 tests/helpers.ts）搭出各阶段的局面，
// 再提供带视角的渲染函数与"收集动作"的 act 桩。组件测试只断言动作对象与可见元素，不断言大段文案。
//
// 约定的座位：1 号格需要 A + B（见 tests/actionDock.test.ts）；A=0 号、B=1 号、C=2 号、D=3 号持有对应投资者。

import type { ReactElement } from 'react'
import { render } from '@testing-library/react'
import { vi } from 'vitest'
import type { GameState, PlayerAction } from '../../src/engine/types'
import { getLegalActions, getActingPlayerId } from '../../src/engine/validator'
import { ViewerProvider } from '../../src/components/ViewerContext'
import { baseState, setInvestors, openDealAt, toBoss, step, giveCards, clearHand, closeSolo } from '../helpers'

export { giveCards, clearHand, step }

/** 开局：放置金钱标记阶段 */
export function placeMarkerState(): GameState {
  const s = baseState(4, 2)
  setInvestors(s, { A: 0, B: 1, C: 2, D: 3 })
  return s
}

/** 某人的回合（TURN 阶段） */
export function turnState(playerId = 0): GameState {
  const s = placeMarkerState()
  s.phase = 'TURN'
  s.markerPos = 1
  s.currentId = playerId
  s.markerChooserId = null
  return s
}

/** 叫价轮：bossId 在 1 号格开单，然后快进到 actorId 行动（actorId 缺省 = 停在叫价轮第一位） */
export function biddingState(bossId: number, actorId?: number): GameState {
  let s = openDealAt(placeMarkerState(), 1, bossId)
  let guard = 0
  while (actorId != null && s.phase === 'NEGOTIATION' && getActingPlayerId(s) !== actorId) {
    s = step(s, { type: 'PASS', playerId: getActingPlayerId(s) })
    if (++guard > 12) throw new Error('biddingState: 找不到行动者')
  }
  return s
}

/** Boss 编方案：bossId 听完叫价轮，轮到他提案 */
export function bossPlanningState(bossId = 0): GameState {
  return toBoss(openDealAt(placeMarkerState(), 1, bossId))
}

/** 方案应答：Boss（0 号）用 1 号的 B 代表，只给 1 元，未达承诺 → 轮到 1 号应答 */
export function offerResponseState(): GameState {
  const s = bossPlanningState(0)
  const reps = s.negotiation!.reps
  const repKeys = [reps.find(r => r.familyId === 'A')!.key, reps.find(r => r.familyId === 'B')!.key]
  return step(s, { type: 'PROPOSE_OFFER', playerId: 0, repKeys, payouts: [{ playerId: 1, amount: 1 }] })
}

/** 成交倒计时：Boss（0 号）独自凑齐 A+B，宣布成交 → 依次询问 1、2、3 号 */
export function closingState(): GameState {
  const s = placeMarkerState()
  setInvestors(s, { A: 0, B: 0, C: 2, D: 3 })
  return step(toBoss(openDealAt(s, 1, 0)), { type: 'CLOSE_DEAL', playerId: 0 })
}

/** 终局：按给定现金排名（并列者现金相同），胜者 = 现金最高者 */
export function gameOverState(cashes: number[]): GameState {
  const s = baseState(cashes.length, 3)
  s.players.forEach((p, i) => { p.cash = cashes[i] })
  const max = Math.max(...cashes)
  s.phase = 'GAME_OVER'
  s.winnerIds = s.players.filter(p => p.cash === max).map(p => p.id)
  return s
}

/** 带视角的渲染：和 App 一样用 ViewerProvider 包起来 */
export function renderAs(ui: ReactElement, viewerId = 0) {
  const wrap = (el: ReactElement) => <ViewerProvider viewerId={viewerId}>{el}</ViewerProvider>
  const view = render(wrap(ui))
  // rerender 也要带上视角包装，否则树结构变了会整个重新挂载
  return { ...view, rerender: (el: ReactElement) => view.rerender(wrap(el)) }
}

/** act 桩 + 取最后一个动作 */
export function actSpy() {
  const act = vi.fn<(a: PlayerAction) => void>()
  return { act, last: () => act.mock.calls[act.mock.calls.length - 1]?.[0] }
}

/** 视角玩家此刻的合法动作（和 App 里 getLegalActions(state, viewerId) 同口径） */
export function legalFor(s: GameState, viewerId = 0): PlayerAction[] {
  return getLegalActions(s, viewerId)
}

/** 方案已定：Boss（0 号）已听完叫价轮；1 号对 B 报了 $2（承诺价），2、3 号跳过。付到 $2 即自动同意 */
export function quotedBossState(): GameState {
  let s = openDealAt(placeMarkerState(), 1, 0)
  s = step(s, { type: 'SPEAK', playerId: 1, say: '黑松两百万出借', quotes: [{ familyId: 'B', amount: 2 }] })
  return toBoss(s)
}

/** 方案里用 Boss 的 A + 1 号的 B；payout 给 1 号的钱 */
export function offerKeysOf(s: GameState): string[] {
  const reps = s.negotiation!.reps
  return [reps.find(r => r.familyId === 'A')!.key, reps.find(r => r.familyId === 'B')!.key]
}

/** 刚成交一笔：0 号独自凑齐 A + B 成交（dealHistory 有 1 条成功记录） */
export function closedDealState(): GameState {
  const s = placeMarkerState()
  setInvestors(s, { A: 0, B: 0, C: 2, D: 3 })
  return closeSolo(s, 1, 0)
}

/** 刚流局一笔：0 号开单后放弃 */
export function abandonedDealState(): GameState {
  const s = toBoss(openDealAt(placeMarkerState(), 1, 0))
  return step(s, { type: 'ABANDON_DEAL', playerId: 0 })
}