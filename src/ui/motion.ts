// ============================================================
// 动效环境（纯逻辑 + 极薄的浏览器读取）：什么时候该跳过动画
//   · prefers-reduced-motion：用户要求减少动效
//   · 页面在后台（document.hidden）：没人看，动画只会堆积
//   · 快进：用户点了"快进"，电脑连续出手，演出会拖慢节奏
//   · 没有 matchMedia（jsdom / 老环境）：按"不播放"处理，让测试与降级路径保持确定
// ============================================================

export interface MotionEnv {
  reducedMotion: boolean
  hidden: boolean
  fastForward: boolean
  /** 环境能否做动画（没有 matchMedia 视为不能） */
  supported: boolean
}

/** 快进按下后多长时间内视为"快进中"（毫秒） */
export const FAST_FORWARD_MS = 2000

let fastUntil = 0

/** 用户点了快进：此后一小段时间内跳过演出 */
export function markFastForward(now: number = Date.now(), ms: number = FAST_FORWARD_MS) {
  fastUntil = Math.max(fastUntil, now + ms)
}

export function isFastForward(now: number = Date.now()): boolean {
  return now < fastUntil
}

/** 测试用：清掉快进标记 */
export function resetFastForward() {
  fastUntil = 0
}

/** 读取当前浏览器的动效环境（安全：任何环境缺失都退化为"不支持"） */
export function readMotionEnv(now: number = Date.now()): MotionEnv {
  const hasWindow = typeof window !== 'undefined'
  const mm = hasWindow && typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : null
  let reduced = false
  try { reduced = !!mm?.('(prefers-reduced-motion: reduce)').matches } catch { reduced = false }
  const hidden = typeof document !== 'undefined' && document.hidden === true
  return { reducedMotion: reduced, hidden, fastForward: isFastForward(now), supported: !!mm }
}

/** 完全开放的环境（测试 / 强制播放） */
export const FULL_MOTION: MotionEnv = { reducedMotion: false, hidden: false, fastForward: false, supported: true }

/** 视觉动画是否应当被跳过 */
export function motionBlocked(env: MotionEnv): boolean {
  return !env.supported || env.reducedMotion || env.hidden || env.fastForward
}

/** 数字滚动：t ∈ [0,1] 的缓出插值，结果取整；t ≥ 1 恒等于 to */
export function rollValue(from: number, to: number, t: number): number {
  if (t >= 1 || from === to) return to
  if (t <= 0) return from
  const eased = 1 - Math.pow(1 - t, 3)
  return Math.round(from + (to - from) * eased)
}
