// ============================================================
// 动效环境（纯逻辑 + 极薄的浏览器读取）：什么时候该跳过动画
//   · prefers-reduced-motion：用户要求减少动效
//   · 页面在后台（document.hidden）：没人看，动画只会堆积
//   · 快进：用户点了"快进"，电脑连续出手，演出会拖慢节奏
//   · 没有 matchMedia（jsdom / 老环境）：按"不播放"处理，让测试与降级路径保持确定
//   · 玩家把"动画速度"设为关闭
// 动画速度（关闭 / 快 / 标准 / 慢）存 localStorage 的 `im-the-boss:anim-speed`：
//   演出层与数字滚动按 ANIM_SCALE 缩放时长；CSS 侧读 <html> 上的 --anim-k 与 data-anim
// ============================================================

export interface MotionEnv {
  reducedMotion: boolean
  hidden: boolean
  fastForward: boolean
  /** 环境能否做动画（没有 matchMedia 视为不能） */
  supported: boolean
  /** 玩家在设置里关掉了动画 */
  animOff?: boolean
}

export type AnimSpeed = 'off' | 'fast' | 'normal' | 'slow'
export const ANIM_SPEEDS: readonly AnimSpeed[] = ['off', 'fast', 'normal', 'slow']
/** 时长倍率：越小越快；off 不播放（倍率只在 CSS 侧兜底） */
export const ANIM_SCALE: Record<AnimSpeed, number> = { off: 0, fast: 0.6, normal: 1, slow: 1.6 }
export const ANIM_STORAGE_KEY = 'im-the-boss:anim-speed'
export const DEFAULT_ANIM_SPEED: AnimSpeed = 'normal'

interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void }
const defaultStorage = (): StorageLike | null => {
  try { return typeof localStorage !== 'undefined' ? localStorage : null } catch { return null }
}

export function loadAnimSpeed(storage: StorageLike | null = defaultStorage()): AnimSpeed {
  try {
    const v = storage?.getItem(ANIM_STORAGE_KEY)
    return (ANIM_SPEEDS as readonly string[]).includes(v ?? '') ? (v as AnimSpeed) : DEFAULT_ANIM_SPEED
  } catch { return DEFAULT_ANIM_SPEED }
}

let animSpeed: AnimSpeed = loadAnimSpeed()
const animListeners = new Set<() => void>()

export function getAnimSpeed(): AnimSpeed {
  return animSpeed
}

/** 改动画速度：立即生效（写 <html> 的 CSS 变量 / 属性）、持久化、通知订阅者 */
export function setAnimSpeed(speed: AnimSpeed, storage: StorageLike | null = defaultStorage()) {
  animSpeed = speed
  try { storage?.setItem(ANIM_STORAGE_KEY, speed) } catch { /* 存不下只影响本次会话 */ }
  applyAnimSpeed()
  animListeners.forEach(fn => fn())
}

export function subscribeAnimSpeed(fn: () => void): () => void {
  animListeners.add(fn)
  return () => { animListeners.delete(fn) }
}

/** 把当前动画速度同步到 <html>：--anim-k 缩放 CSS 动画，data-anim="off" 关掉所有动画 */
export function applyAnimSpeed(speed: AnimSpeed = animSpeed) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.style.setProperty('--anim-k', String(ANIM_SCALE[speed] || 1))
  root.dataset.anim = speed
}

/** 按当前动画速度缩放一段时长（毫秒，取整） */
export function scaleMs(ms: number, speed: AnimSpeed = animSpeed): number {
  return Math.round(ms * (ANIM_SCALE[speed] || 1))
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
  return { reducedMotion: reduced, hidden, fastForward: isFastForward(now), supported: !!mm, animOff: animSpeed === 'off' }
}

/** 完全开放的环境（测试 / 强制播放） */
export const FULL_MOTION: MotionEnv = { reducedMotion: false, hidden: false, fastForward: false, supported: true }

/** 视觉动画是否应当被跳过 */
export function motionBlocked(env: MotionEnv): boolean {
  return !env.supported || env.reducedMotion || env.hidden || env.fastForward || !!env.animOff
}

/** 数字滚动：t ∈ [0,1] 的缓出插值，结果取整；t ≥ 1 恒等于 to */
export function rollValue(from: number, to: number, t: number): number {
  if (t >= 1 || from === to) return to
  if (t <= 0) return from
  const eased = 1 - Math.pow(1 - t, 3)
  return Math.round(from + (to - from) * eased)
}
