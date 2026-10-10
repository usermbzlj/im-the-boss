// ============================================================
// AnimatedNumber — 数字滚动：值变化时从旧值缓出滚到新值（≈0.65 秒），并短暂着色（涨绿 / 跌红）
//   跳过条件与演出层一致（后台 / 快进 / 减少动画 / 无动画环境 / 动画已关闭）：直接显示新值；时长随"动画速度"缩放。
//   data-value 恒为"真实值"，读屏与测试都以它为准；滚动中的中间值只是视觉。
// ============================================================

import { useEffect, useRef, useState } from 'react'
import { motionBlocked, readMotionEnv, rollValue, scaleMs } from '../ui/motion'

interface AnimatedNumberProps {
  value: number
  /** 把数字格式化成文字，默认 $N M 之外的场景自行传入 */
  format?: (n: number) => string
  /** 滚动时长（毫秒） */
  ms?: number
  /** 强制开 / 关动画；省略 = 按当前动效环境判断 */
  animate?: boolean
  className?: string
}

const raf = (fn: (t: number) => void): number =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : (setTimeout(() => fn(Date.now()), 16) as unknown as number)
const caf = (h: number) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(h) : clearTimeout(h))
const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

export default function AnimatedNumber({ value, format = String, ms = 650, animate, className }: AnimatedNumberProps) {
  const [shown, setShown] = useState(value)
  const [dir, setDir] = useState<'up' | 'down' | null>(null)
  const shownRef = useRef(value)
  const prev = useRef(value)

  useEffect(() => {
    if (prev.current === value) return
    const from = shownRef.current
    const up = value > prev.current
    prev.current = value
    const allowed = animate ?? !motionBlocked(readMotionEnv())
    if (!allowed) { shownRef.current = value; setShown(value); setDir(null); return }
    setDir(up ? 'up' : 'down')
    const t0 = clock()
    const dur = Math.max(1, scaleMs(ms))
    let handle = 0
    const tick = () => {
      const p = (clock() - t0) / dur
      const v = rollValue(from, value, p)
      shownRef.current = v
      setShown(v)
      if (p < 1) handle = raf(tick)
      else setDir(null)
    }
    handle = raf(tick)
    return () => caf(handle)
  }, [value, ms, animate])

  return (
    <span className={`num-roll${dir ? ` num-${dir}` : ''}${className ? ` ${className}` : ''}`} data-value={value}>
      {format(shown)}
    </span>
  )
}
