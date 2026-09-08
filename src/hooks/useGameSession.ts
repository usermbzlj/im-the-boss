// ============================================================
// useGameSession — 把 GameSession 接进 React
// 组件只读快照、只发动作；AI 驱动、存档、节奏停顿都在 session 内完成。
// 离开对局（leave）即销毁 session：电脑玩家不会在后台继续推进。
// ============================================================

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { GameState, PlayerAction } from '../engine/types'
import { createInitialState } from '../engine/gameEngine'
import { GameSession, type SessionSnapshot } from '../game/session'
import { withFallback } from '../ai/policy'
import { heuristicPolicy } from '../ai/heuristic'
import { createLLMPolicy } from '../ai/llmPolicy'
import { loadLLMConfig, AI_SPEED_DELAYS_MS } from '../ai/llmClient'
import { saveGame } from '../utils/storage'

function createSession(initial: GameState): GameSession {
  const policy = withFallback(createLLMPolicy(loadLLMConfig), heuristicPolicy, reason => console.warn('[AI] 回退到启发式：', reason))
  return new GameSession(initial, {
    policy,
    delay: state => {
      const d = AI_SPEED_DELAYS_MS[loadLLMConfig().aiSpeed]
      return state.phase === 'REACTION' ? d.reaction : d.negotiation
    },
    onChange: state => { if (state.phase !== 'GAME_OVER') saveGame(state) },
    onError: message => console.error('[GameSession]', message),
  })
}

const EMPTY_SUBSCRIBE = () => () => {}

export function useGameSession() {
  const sessionRef = useRef<GameSession | null>(null)
  const [generation, setGeneration] = useState(0)

  // subscribe 的身份随 generation 变化：换 session 后 useSyncExternalStore 会重新订阅
  const subscribe = useCallback((listener: () => void) => sessionRef.current?.subscribe(listener) ?? EMPTY_SUBSCRIBE(), [generation])
  const getSnapshot = useCallback((): SessionSnapshot | null => sessionRef.current?.snapshot ?? null, [])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const replaceSession = useCallback((next: GameSession | null) => {
    sessionRef.current?.destroy()
    sessionRef.current = next
    setGeneration(g => g + 1)
  }, [])

  const start = useCallback((playerCount: number, humanName: string, seed?: number) => {
    replaceSession(createSession(createInitialState(playerCount, humanName, seed)))
  }, [replaceSession])

  const load = useCallback((state: GameState) => {
    replaceSession(createSession(state))
  }, [replaceSession])

  const leave = useCallback(() => replaceSession(null), [replaceSession])

  const act = useCallback((action: PlayerAction) => sessionRef.current?.dispatch(action) ?? false, [])

  // 卸载即销毁 session。StrictMode / HMR 会"卸载后立即重挂"，此时用同一份状态重建，
  // 避免 ref 指向一个已销毁、再也不会推进的 session。
  useEffect(() => {
    const current = sessionRef.current
    if (current?.isDestroyed) replaceSession(createSession(current.state))
    return () => { sessionRef.current?.destroy() }
  }, [replaceSession])

  return { snapshot, start, load, leave, act }
}
