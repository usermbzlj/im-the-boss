// 由状态版本派生的可复现伪随机数（启发式与台词挑选共用）。
// 同一个状态 + 同一个 salt 永远得到同一个数；不读时钟、不读 Math.random，所以仿真与重放一致。

import type { GameState } from '../engine/types'

export function stateRand(state: GameState, salt: number): number {
  let h = (state.stateVersion * 2654435761 + salt * 40503 + state.rng) >>> 0
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b); h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

export const pickBy = <T,>(arr: readonly T[], r: number): T => arr[Math.min(arr.length - 1, Math.floor(r * arr.length))]
