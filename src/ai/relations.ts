// ============================================================
// 关系记忆：每位玩家对其他人的态度（-2 记仇 … +2 交好）
// 纯函数，只由对局状态（交易历史 / 事件）推导，不入存档，重放天然一致。
// 启发式、LLM 提示词与界面共用同一口径。
// ============================================================

import type { GameState } from '../engine/types'

export type RelationScore = -2 | -1 | 0 | 1 | 2

export interface Relation {
  score: RelationScore
  /** 形成这个态度的最近几条原因（中文短句，界面与提示词直接使用） */
  reasons: string[]
}

/** fromId 对每位其他玩家的态度（键为对方 id） */
export function relationsOf(_state: GameState, _fromId: number): Record<number, Relation> {
  return {}
}

/** 每位其他玩家对 targetId 的态度（键为对方 id）——界面用来显示"谁记你的仇" */
export function relationsToward(state: GameState, targetId: number): Record<number, Relation> {
  const out: Record<number, Relation> = {}
  for (const p of state.players) {
    if (p.id === targetId) continue
    out[p.id] = relationsOf(state, p.id)[targetId] ?? { score: 0, reasons: [] }
  }
  return out
}
