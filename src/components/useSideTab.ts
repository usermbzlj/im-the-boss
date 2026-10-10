// ============================================================
// useSideTab — 侧栏标签页：谈判开始 / 结束时的自动切换，但不抢用户的选择
//   规则：
//   1. 用户手动点过标签后，谈判开始不再自动切到"谈判桌"（别把正在看历史 / 日志的人拽走）；
//   2. "谈判桌"标签随谈判结束消失，此时若停在它上面，退回日志（这是必须的，不算抢选择）；
//   3. 开新局 / 返回开始页（active=false）时清除"手动选过"的记忆。
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react'

export type SideTab = 'neg' | 'log' | 'history'

export function useSideTab(hasNeg: boolean, active: boolean): { sideTab: SideTab; pickTab: (tab: SideTab) => void } {
  const [sideTab, setSideTab] = useState<SideTab>('log')
  const manual = useRef(false)

  useEffect(() => {
    if (hasNeg) { if (!manual.current) setSideTab('neg') }
    else setSideTab(t => (t === 'neg' ? 'log' : t))
  }, [hasNeg])

  useEffect(() => {
    if (!active) { manual.current = false; setSideTab('log') }
  }, [active])

  const pickTab = useCallback((tab: SideTab) => { manual.current = true; setSideTab(tab) }, [])
  return { sideTab, pickTab }
}
