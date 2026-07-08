// ============================================================
// 游戏存档
// ============================================================

import type { GameState } from '../engine/types'
import { normalizeGameState } from '../engine/gameEngine'

const SAVE_KEY = 'im-the-boss-save'

export function saveGame(state: GameState) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(state))
  } catch { /* ignore */ }
}

export function loadSavedGame(): GameState | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    if (!raw) return null
    return normalizeGameState(JSON.parse(raw) as GameState)
  } catch {
    return null
  }
}

export function clearSavedGame() {
  localStorage.removeItem(SAVE_KEY)
}

export function hasSavedGame(): boolean {
  return !!localStorage.getItem(SAVE_KEY)
}
