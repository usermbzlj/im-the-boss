// ============================================================
// DieFace — CSS 骰子：1–6 点的点阵；rolling 时快速翻滚随机点数，到时间后落定在真实点数。
//   翻滚的随机点数只是视觉，不参与任何游戏逻辑；真实点数恒在 data-value 上。
// ============================================================

import { useEffect, useState } from 'react'

/** 3×3 点阵里哪些格亮（下标 0–8，行优先） */
export const DIE_PIPS: Record<number, readonly number[]> = {
  1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8],
}

interface DieFaceProps {
  value: number
  /** 翻滚总时长（毫秒），0 = 不翻滚直接显示 */
  rollMs?: number
  className?: string
}

const clampFace = (n: number) => Math.min(6, Math.max(1, Math.round(n) || 1))

export default function DieFace({ value, rollMs = 0, className }: DieFaceProps) {
  const [shown, setShown] = useState(rollMs > 0 ? clampFace(Math.random() * 6 + 1) : clampFace(value))
  const [rolling, setRolling] = useState(rollMs > 0)

  useEffect(() => {
    if (rollMs <= 0) { setShown(clampFace(value)); setRolling(false); return }
    setRolling(true)
    const tick = setInterval(() => setShown(clampFace(Math.random() * 6 + 1)), 70)
    const done = setTimeout(() => { clearInterval(tick); setShown(clampFace(value)); setRolling(false) }, rollMs)
    return () => { clearInterval(tick); clearTimeout(done) }
  }, [value, rollMs])

  const pips = DIE_PIPS[shown]
  return (
    <span className={`die${rolling ? ' rolling' : ' settled'}${className ? ` ${className}` : ''}`} data-value={clampFace(value)} role="img" aria-label={`骰子 ${clampFace(value)} 点`}>
      {Array.from({ length: 9 }, (_, i) => <i key={i} className={pips.includes(i) ? 'pip on' : 'pip'} />)}
    </span>
  )
}
