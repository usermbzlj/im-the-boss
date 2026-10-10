// ============================================================
// CueProvider — 事件驱动的演出层：监听新事件 → 调度演出（ui/cues）→ 触发音效，
//   并把"正在播放的演出"通过 context 提供给 CueStage（覆盖层）、TableBoard（格子 / 标记 / 骰子）等。
//   · 演出只是覆盖层：不改变游戏推进、不阻塞操作；到期自动清除
//   · 载入存档 / 换局时以当前最后事件为基线，不会把旧事件补演一遍（与 ToastLayer 同口径）
//   · 快进 / 页面后台 / 减少动画 / 无 matchMedia 环境 → 不产生视觉演出；音效另按 pickSounds 的规则
// ============================================================

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { GameState } from '../engine/types'
import { cueLifetime, mergeActive, motionFilter, pickSounds, planCues, type ActiveCue, type CueKind } from '../ui/cues'
import { readMotionEnv, type MotionEnv } from '../ui/motion'
import { getSound, type AudioEngine } from '../audio'

const EMPTY: readonly ActiveCue[] = []
const CueContext = createContext<readonly ActiveCue[]>(EMPTY)

/** 所有正在播放的演出（不在 CueProvider 内时恒为空，组件照常渲染） */
export function useActiveCues(): readonly ActiveCue[] {
  return useContext(CueContext)
}

/** 屏蔽外层演出：复盘等展示历史状态的子树不应收到实时对局的演出 */
export function NoCues({ children }: { children: ReactNode }) {
  return <CueContext.Provider value={EMPTY}>{children}</CueContext.Provider>
}

/** 某一类演出里满足条件的那些 */
export function useCuesOf(kind: CueKind, pick?: (c: ActiveCue) => boolean): ActiveCue[] {
  const all = useActiveCues()
  return useMemo(() => all.filter(c => c.kind === kind && (!pick || pick(c))), [all, kind, pick])
}

const maxEventId = (state: GameState) => state.events[state.events.length - 1]?.id ?? 0

interface CueProviderProps {
  state: GameState
  viewerId: number
  children: ReactNode
  /** 动效环境读取（测试可注入） */
  readEnv?: () => MotionEnv
  /** 音频引擎（测试可注入；省略 = 全局单例） */
  sound?: Pick<AudioEngine, 'play'>
  now?: () => number
}

export default function CueProvider({ state, viewerId, children, readEnv = readMotionEnv, sound, now = Date.now }: CueProviderProps) {
  const [active, setActive] = useState<readonly ActiveCue[]>(EMPTY)
  const lastSeen = useRef(maxEventId(state))
  const prevMarker = useRef(state.markerPos)
  const idSeq = useRef(0)
  const timers = useRef(new Map<number, { version: number; handle: ReturnType<typeof setTimeout> }>())
  const soundTimers = useRef(new Set<ReturnType<typeof setTimeout>>())

  const play = useCallback((id: Parameters<AudioEngine['play']>[0], delayMs: number) => {
    const engine = sound ?? getSound()
    if (delayMs <= 0) { engine.play(id); return }
    const h = setTimeout(() => { soundTimers.current.delete(h); engine.play(id) }, delayMs)
    soundTimers.current.add(h)
  }, [sound])

  useEffect(() => {
    const max = maxEventId(state)
    if (max < lastSeen.current) { // 换了一局（事件 id 倒退）
      lastSeen.current = max
      prevMarker.current = state.markerPos
      setActive(EMPTY)
      return
    }
    if (max === lastSeen.current) { prevMarker.current = state.markerPos; return }
    const fresh = state.events.filter(e => e.id > lastSeen.current)
    lastSeen.current = max
    const cues = planCues(state, fresh, viewerId, { prevMarkerPos: prevMarker.current })
    prevMarker.current = state.markerPos
    if (cues.length === 0) return
    const env = readEnv()
    for (const s of pickSounds(cues, env)) play(s.id, s.delayMs)
    const visual = motionFilter(cues, env)
    if (visual.length) setActive(cur => mergeActive(cur, visual, now(), () => ++idSeq.current))
  }, [state, viewerId, readEnv, play, now])

  // 每条演出一个到期计时；合并（version 变化）时重新计时
  useEffect(() => {
    const live = new Set(active.map(c => c.id))
    for (const [id, t] of timers.current) {
      if (!live.has(id)) { clearTimeout(t.handle); timers.current.delete(id) }
    }
    for (const c of active) {
      const cur = timers.current.get(c.id)
      if (cur && cur.version === c.version) continue
      if (cur) clearTimeout(cur.handle)
      const handle = setTimeout(() => {
        timers.current.delete(c.id)
        setActive(list => list.filter(x => x.id !== c.id))
      }, cueLifetime(c))
      timers.current.set(c.id, { version: c.version, handle })
    }
  }, [active])

  useEffect(() => () => {
    timers.current.forEach(t => clearTimeout(t.handle))
    timers.current.clear()
    soundTimers.current.forEach(h => clearTimeout(h))
    soundTimers.current.clear()
  }, [])

  return <CueContext.Provider value={active}>{children}</CueContext.Provider>
}
