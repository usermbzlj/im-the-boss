// ============================================================
// useRecording — 终局后把"开局参数 + 动作日志"整理成录像（分片执行，不卡界面）
//   enabled 为假（对局进行中）什么都不做——对局进行中不提供复盘入口
//   不可回放（没有开局参数 / 日志接不上状态 / 重放对不上终态）→ status = 'unavailable'
// ============================================================

import { useEffect, useState } from 'react'
import type { GameState } from '../../engine/types'
import type { ActionLogEntry, StartParams } from '../../game/replay'
import { RecordingBuilder, logFitsState, matchesState, type Recording } from '../../ui/recording'
import type { ReplayStatus } from '../GameOverCard'

export interface RecordingResult {
  recording: Recording | null
  status: ReplayStatus
}

const IDLE: RecordingResult = { recording: null, status: 'idle' }

export function useRecording(enabled: boolean, origin: StartParams | null, log: readonly ActionLogEntry[], state: GameState | null): RecordingResult {
  const [result, setResult] = useState<RecordingResult>(IDLE)
  const logLength = log.length
  const version = state?.stateVersion

  useEffect(() => {
    if (!enabled || !state) { setResult(IDLE); return }
    if (!origin || !logFitsState(log, state)) { setResult({ recording: null, status: 'unavailable' }); return }
    let builder: RecordingBuilder
    try {
      builder = new RecordingBuilder(origin, log)
    } catch {
      setResult({ recording: null, status: 'unavailable' })
      return
    }
    setResult({ recording: null, status: 'building' })
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = () => {
      if (cancelled) return
      try {
        if (builder.run(20)) {
          const rec = builder.result()
          setResult(matchesState(rec, state) ? { recording: rec, status: 'ready' } : { recording: null, status: 'unavailable' })
          return
        }
      } catch {
        setResult({ recording: null, status: 'unavailable' })
        return
      }
      timer = setTimeout(tick, 0)
    }
    timer = setTimeout(tick, 0)
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
    // 状态对象每步都会换；终局后只在"是否终局 / 日志长度 / 状态版本"变化时重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, origin, logLength, version])

  return result
}
