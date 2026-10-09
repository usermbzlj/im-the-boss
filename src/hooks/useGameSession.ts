// ============================================================
// useGameSession — 把 GameSession 接进 React
// 组件只读快照、只发动作；AI 驱动、存档、节奏停顿都在 session 内完成（装配见 game/createSession.ts）。
// 离开对局（leave）即销毁 session：电脑玩家不会在后台继续推进。
// 终局也会存档：终局后回首页"继续上一局"直接回到终局画面。
// ============================================================

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { GameState, PlayerAction, GameVariantId } from '../engine/types'
import type { GameSession, SessionSnapshot } from '../game/session'
import { startGameSession, resumeGameSession, flushAutosave, type SessionEnv } from '../game/createSession'
import type { ActionLogEntry, SavedGame, StartParams } from '../game/replay'
import { createBrowserEnv } from './browserEnv'
import { savedGameFor } from '../utils/storage'

const EMPTY_SUBSCRIBE = () => () => {}
const NO_LOG: readonly ActionLogEntry[] = []

/** envFactory：每开 / 载入一局调用一次；默认是浏览器环境（测试可注入假策略 / 假存储） */
export function useGameSession(envFactory: () => SessionEnv = createBrowserEnv) {
  const sessionRef = useRef<GameSession | null>(null)
  const envRef = useRef(envFactory)
  envRef.current = envFactory
  const [generation, setGeneration] = useState(0)

  // subscribe 的身份随 generation 变化：换 session 后 useSyncExternalStore 会重新订阅
  const subscribe = useCallback((listener: () => void) => sessionRef.current?.subscribe(listener) ?? EMPTY_SUBSCRIBE(), [generation])
  const getSnapshot = useCallback((): SessionSnapshot | null => sessionRef.current?.snapshot ?? null, [])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  /** 先销毁旧 session（让它做完最后一次落盘），再建新的——否则旧局的收尾存档会盖掉新局 */
  const replaceSession = useCallback((make: (() => GameSession) | null) => {
    sessionRef.current?.destroy()
    sessionRef.current = make ? make() : null
    setGeneration(g => g + 1)
  }, [])

  const start = useCallback((playerCount: number, humanName: string, seed?: number, variantId?: GameVariantId, houseRules?: boolean) => {
    replaceSession(() => startGameSession({ playerCount, humanName, seed, variantId, houseRules }, envRef.current()))
  }, [replaceSession])

  /** 载入一局：传 GameState（旧用法；若正是 loadSavedGame 刚读出的那份，会自动带回开局参数与日志）或完整 SavedGame */
  const load = useCallback((saved: GameState | SavedGame) => {
    const full = 'state' in saved ? saved : savedGameFor(saved) ?? saved
    replaceSession(() => resumeGameSession(full, envRef.current()))
  }, [replaceSession])

  /** 继续上一局（读 localStorage 里的存档，含日志）。没有可用存档返回 false */
  const continueSaved = useCallback((): boolean => {
    const saved = envRef.current().loadSaved?.() ?? null
    if (!saved) return false
    load(saved)
    return true
  }, [load])

  const leave = useCallback(() => replaceSession(null), [replaceSession])

  const act = useCallback((action: PlayerAction) => sessionRef.current?.dispatch(action) ?? false, [])

  /** 当前动作日志（只读；随 snapshot.logLength 增长，组件读它即可按动作分组事件） */
  const getLog = useCallback((): readonly ActionLogEntry[] => sessionRef.current?.log ?? NO_LOG, [])
  const getOrigin = useCallback((): StartParams | null => sessionRef.current?.origin ?? null, [])

  // 卸载即销毁 session。StrictMode / HMR 会"卸载后立即重挂"，此时用同一份存档重建（含动作日志），
  // 避免 ref 指向一个已销毁、再也不会推进的 session。
  useEffect(() => {
    const current = sessionRef.current
    if (current?.isDestroyed) replaceSession(() => resumeGameSession(current.toSaved(), envRef.current()))
    const onHide = () => flushAutosave(sessionRef.current)
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      sessionRef.current?.destroy()
    }
  }, [replaceSession])

  return { snapshot, start, load, leave, act, continueSaved, getLog, getOrigin }
}
