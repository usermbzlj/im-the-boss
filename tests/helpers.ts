// 测试用的局面搭建工具：从真实初始状态出发，按需摆放投资者与手牌，
// 手牌一律从牌堆里"抽"出对应类型，保证 98 张卡牌守恒不变量在测试中依然成立。

import { expect } from 'vitest'
import type { GameState, PlayerAction, FamilyId, CardType, InfluenceCard, GameVariantId, SpaceKind, BoardSpace } from '../src/engine/types'
import { createInitialState, gameReducer } from '../src/engine/gameEngine'
import { isLegal, getActingPlayerId } from '../src/engine/validator'

export function baseState(playerCount = 4, seed = 1, variantId?: GameVariantId): GameState {
  const s = createInitialState(playerCount, '测试', seed, variantId)
  for (const p of s.players) p.isAI = true
  return s
}

/** 找到版图上第一个指定种类的格子 */
export function spaceOfKind(s: GameState, kind: SpaceKind): BoardSpace {
  const space = s.board.find(b => b.kind === kind)
  if (!space) throw new Error(`版图上没有 ${kind} 格`)
  return space
}

/** 让 ownerId 拥有某格所需的全部家族投资者（其余家族放公共区），使其可独立成交 */
export function ownSpaceFamilies(s: GameState, space: BoardSpace, ownerId: number) {
  for (const inv of s.investors) inv.ownerId = null
  for (const g of space.groups) for (const f of g.families) s.investors.find(inv => inv.familyId === f)!.ownerId = ownerId
}

/** Boss 用自己的投资者直接成交（其他人依次放行） */
export function closeSolo(s: GameState, spaceId: number, bossId: number): GameState {
  s = toBoss(openDealAt(s, spaceId, bossId))
  s = step(s, { type: 'CLOSE_DEAL', playerId: bossId })
  while (s.phase === 'CLOSING') s = step(s, { type: 'PASS_CLOSING', playerId: getActingPlayerId(s) })
  return s
}

/** 指定各家族投资者的持有者（未列出的置为公共区） */
export function setInvestors(s: GameState, owners: Partial<Record<FamilyId, number | null>>) {
  for (const inv of s.investors) inv.ownerId = owners[inv.familyId] ?? null
}

interface CardSpec { type: CardType; familyId?: FamilyId }

/** 从牌堆里抽出符合规格的牌放进玩家手里，返回这些牌 */
export function giveCards(s: GameState, playerId: number, specs: CardSpec[]): InfluenceCard[] {
  const out: InfluenceCard[] = []
  for (const spec of specs) {
    const idx = s.drawPile.findIndex(c => c.type === spec.type && (spec.type === 'TRAVEL' || spec.type === 'CLAN'
      ? (spec.familyId === undefined ? c.familyId === undefined : c.familyId === spec.familyId)
      : true))
    if (idx < 0) throw new Error(`牌堆里没有 ${spec.type}${spec.familyId ?? ''}`)
    const [card] = s.drawPile.splice(idx, 1)
    s.players[playerId].hand.push(card)
    out.push(card)
  }
  return out
}

/** 清空玩家手牌（放回牌堆底部） */
export function clearHand(s: GameState, playerId: number) {
  const p = s.players[playerId]
  s.drawPile.unshift(...p.hand)
  p.hand = []
}

/** 断言动作合法并应用，返回新状态 */
export function step(s: GameState, action: PlayerAction): GameState {
  expect(isLegal(s, action), `动作应合法：${JSON.stringify(action)} phase=${s.phase} acting=${getActingPlayerId(s)}`).toBe(true)
  const next = gameReducer(s, action)
  expect(next, 'reducer 应返回新状态').not.toBeNull()
  expect(next!.stateVersion).toBe(s.stateVersion + 1)
  return next!
}

/** 断言动作被拒绝：isLegal 为 false 且 reducer 返回原引用 */
export function rejects(s: GameState, action: PlayerAction) {
  expect(isLegal(s, action)).toBe(false)
  expect(gameReducer(s, action)).toBe(s)
}

/** 让 bossId 在指定格发起交易（跳过放置标记 / 掷骰） */
export function openDealAt(s: GameState, spaceId: number, bossId: number): GameState {
  s.phase = 'TURN'
  s.markerPos = spaceId
  s.currentId = bossId
  s.markerChooserId = null
  return step(s, { type: 'OPEN_DEAL', playerId: bossId })
}

/** 叫价轮：其他玩家依次跳过，直到轮到 Boss（谈判阶段专用） */
export function toBoss(s: GameState): GameState {
  let guard = 0
  while (s.phase === 'NEGOTIATION' && getActingPlayerId(s) !== s.negotiation!.bossId) {
    s = step(s, { type: 'PASS', playerId: getActingPlayerId(s) })
    if (++guard > 12) throw new Error('toBoss: 转了一圈还没轮到 Boss')
  }
  return s
}

export function eventsOf(s: GameState, kind: GameState['events'][number]['kind']) {
  return s.events.filter(e => e.kind === kind)
}

export function totalCash(s: GameState): number {
  return s.players.reduce((n, p) => n + p.cash, 0)
}
