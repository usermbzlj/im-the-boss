// ============================================================
// useGame — 异步 AI 管线 + 存档
// ============================================================

import { useReducer, useRef, useEffect, useCallback } from 'react'
import type { GameState, GameAction } from '../engine/types'
import { gameReducer } from '../engine/gameEngine'
import { getActingPlayerId } from '../engine/validator'
import { decideAI } from '../ai/llmAgent'
import { getFallbackAction } from '../ai/fallbackAI'
import { loadLLMConfig, AI_SPEED_DELAYS_MS } from '../ai/llmClient'
import { saveGame } from '../utils/storage'

export function useGame() {
  const [state, dispatch] = useReducer(gameReducer, null as GameState | null)
  const stateRef = useRef(state)
  stateRef.current = state
  const abortRef = useRef<AbortController | null>(null)
  const aiFlightRef = useRef<string | null>(null)
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const startGame = useCallback((playerCount: number, humanName: string) => {
    abortRef.current?.abort()
    aiFlightRef.current = null
    dispatch({ type: 'START_GAME', playerCount, humanPlayerName: humanName })
  }, [])

  const loadGame = useCallback((loaded: GameState) => {
    abortRef.current?.abort()
    aiFlightRef.current = null
    dispatch({ type: 'LOAD_GAME', state: loaded })
  }, [])

  const dispatchAction = useCallback((action: GameAction) => {
    dispatch(action)
  }, [])

  /**
   * 看门狗：任何一次 AI 决策周期（LLM 或 fallback）结束后，都应当让
   * stateVersion 至少推进 expectedMinVersion。如果 reducer 因为动作不合法而
   * 静默拒绝（返回同一个 state 引用），或者决策过程中途抛出未被内部捕获的
   * 异常，stateVersion 会原地不动——而 AI 管线的触发完全依赖 stateVersion
   * 变化，于是游戏会永久卡在"AI 思考中"。这里用一个短延迟兜底：到点后如果
   * 版本号没有达到预期、且仍轮到同一个 AI 行动，就强制执行一个保证合法的
   * 启发式动作，确保游戏在任何异常情况下都能继续推进。
   */
  const scheduleWatchdog = useCallback((expectedMinVersion: number, actorId: number, controller: AbortController) => {
    if (watchdogRef.current) clearTimeout(watchdogRef.current)
    watchdogRef.current = setTimeout(() => {
      if (controller.signal.aborted) return
      const cur = stateRef.current
      if (!cur || cur.phase === 'GAME_OVER') return
      if (cur.stateVersion >= expectedMinVersion) return
      if (getActingPlayerId(cur) !== actorId) return
      console.warn(`[AI watchdog] 玩家#${actorId} 的动作未能推进游戏状态（可能被引擎拒绝或请求异常），强制执行兜底动作`)
      const fallback = getFallbackAction(cur)
      if (fallback) dispatch(fallback)
    }, 250)
  }, [])

  const stateVersion = state?.stateVersion
  const phase = state?.phase
  const actingId = state ? getActingPlayerId(state) : null
  const actingIsAI = !!(
    state &&
    actingId != null &&
    state.players.find(p => p.id === actingId)?.isAI
  )

  // 自动存档
  useEffect(() => {
    if (state && state.phase !== 'GAME_OVER') {
      saveGame(state)
    }
  }, [state])

  // 异步 AI 管线（依赖游戏回合关键字段，避免 thinking 状态触发重入）
  useEffect(() => {
    const current = stateRef.current
    if (!current || current.phase === 'GAME_OVER') return

    const actorId = getActingPlayerId(current)
    const actor = current.players.find(p => p.id === actorId)

    if (!actor?.isAI) {
      aiFlightRef.current = null
      if (current.thinkingPlayerId !== null) {
        dispatch({ type: 'SET_AI_THINKING', playerId: null })
      }
      return
    }

    const flightKey = `${current.stateVersion}-${actorId}`
    if (aiFlightRef.current === flightKey) return
    aiFlightRef.current = flightKey

    if (current.thinkingPlayerId !== actorId) {
      dispatch({ type: 'SET_AI_THINKING', playerId: actorId })
    }

    const versionAtStart = current.stateVersion
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    // 速度档位来自设置面板（见 llmClient.ts AI_SPEED_DELAYS_MS），替换掉之前
    // 写死的 400/600ms——不同玩家对"AI思考停顿"的耐心差异很大，写死的节奏
    // 要么让快速刷流程的人觉得拖沓，要么让想细看谈判的人觉得太赶。
    const speedDelays = AI_SPEED_DELAYS_MS[loadLLMConfig().aiSpeed]
    const delay = current.phase === 'REACTION_WINDOW' ? speedDelays.reaction : speedDelays.negotiation

    const timer = setTimeout(async () => {
      try {
        const cur = stateRef.current
        if (!cur || cur.stateVersion !== versionAtStart) return

        const decision = await decideAI(cur, controller.signal)
        if (!decision || controller.signal.aborted) return

        const latest = stateRef.current
        if (!latest || latest.stateVersion !== versionAtStart) return

        if (decision.speech && decision.action.type !== 'SPEAK') {
          dispatch({ type: 'ADD_SPEECH_BUBBLE', playerId: actorId, text: decision.speech })
        }
        dispatch(decision.action)
        scheduleWatchdog(versionAtStart + 1, actorId, controller)
      } catch (e) {
        if (!controller.signal.aborted) {
          console.warn('AI error', e)
          // 决策管线本身抛出异常时同样不能让游戏卡死：立即换用启发式兜底。
          const cur = stateRef.current
          if (cur && cur.stateVersion === versionAtStart && getActingPlayerId(cur) === actorId) {
            const fallback = getFallbackAction(cur)
            if (fallback) dispatch(fallback)
          }
        }
      } finally {
        if (!controller.signal.aborted && stateRef.current?.thinkingPlayerId === actorId) {
          dispatch({ type: 'SET_AI_THINKING', playerId: null })
        }
        if (aiFlightRef.current === flightKey) {
          aiFlightRef.current = null
        }
      }
    }, delay)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [stateVersion, phase, actingId, actingIsAI, scheduleWatchdog])

  useEffect(() => () => {
    abortRef.current?.abort()
    if (watchdogRef.current) clearTimeout(watchdogRef.current)
  }, [])

  return { state, dispatch: dispatchAction, startGame, loadGame }
}
