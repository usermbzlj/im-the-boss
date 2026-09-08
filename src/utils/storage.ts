// ============================================================
// 游戏存档（带版本号：引擎状态结构变化时旧档自动失效，避免加载后崩溃）
// ============================================================

import type { GameState } from '../engine/types'
import { SAVE_VERSION } from '../engine/gameEngine'

const SAVE_KEY = 'im-the-boss-save'

export function saveGame(state: GameState) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(state))
  } catch { /* 存储满/隐私模式：忽略 */ }
}

export function loadSavedGame(): GameState | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<GameState>
    if (parsed.saveVersion !== SAVE_VERSION || !Array.isArray(parsed.players) || !parsed.phase) {
      localStorage.removeItem(SAVE_KEY)
      return null
    }
    return parsed as GameState
  } catch {
    localStorage.removeItem(SAVE_KEY)
    return null
  }
}

export function clearSavedGame() {
  localStorage.removeItem(SAVE_KEY)
}

export function hasSavedGame(): boolean {
  return loadSavedGame() !== null
}
