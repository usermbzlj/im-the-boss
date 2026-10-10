// ============================================================
// useTurnChime — 轮到你做决定的那一刻（needsAttention 由假变真）响一声"叮咚"
//   只在上升沿响一次；自动放行的窗口不算（needsAttention 已排除）；页面在后台也响（提醒你回来）。
// ============================================================

import { useEffect, useRef } from 'react'
import { getSound, type AudioEngine } from '../audio'

export function useTurnChime(active: boolean, sound: Pick<AudioEngine, 'play'> = getSound()) {
  const was = useRef(false)
  useEffect(() => {
    if (active && !was.current) sound.play('turn')
    was.current = active
  }, [active, sound])
}
