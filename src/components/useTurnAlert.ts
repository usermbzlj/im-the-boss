// ============================================================
// useTurnAlert — 轮到你了，但页面不在前台：标题交替闪烁"【轮到你了】"，回到前台立即恢复
// ============================================================

import { useEffect } from 'react'
import { TURN_ALERT_TITLE } from '../ui/attention'

/** 标题闪烁间隔（毫秒） */
export const TITLE_BLINK_MS = 1000

export function useTurnAlert(active: boolean) {
  useEffect(() => {
    if (!active) return
    const original = document.title
    let timer: ReturnType<typeof setInterval> | null = null
    let alt = false

    const stop = () => {
      if (timer) { clearInterval(timer); timer = null }
      alt = false
      document.title = original
    }
    const start = () => {
      if (timer) return
      document.title = TURN_ALERT_TITLE
      alt = true
      timer = setInterval(() => {
        alt = !alt
        document.title = alt ? TURN_ALERT_TITLE : original
      }, TITLE_BLINK_MS)
    }
    const sync = () => { if (document.hidden) start(); else stop() }

    sync()
    document.addEventListener('visibilitychange', sync)
    return () => {
      document.removeEventListener('visibilitychange', sync)
      stop()
    }
  }, [active])
}
