// ============================================================
// 音频引擎：Web Audio 实时合成 + 开关 / 音量持久化 + 安全降级
//   · 默认开启，但浏览器要求首次用户交互后才允许发声：在 pointerdown / keydown / touchstart 上"解锁"
//     （创建并 resume AudioContext）；解锁之前 play() 直接忽略，不排队、不报错
//   · 没有 AudioContext（测试 / 老环境）→ supported = false，所有方法安全空转
//   · 主链路：各音符 → 总增益（音量）→ 压缩器（防爆音）→ 输出
//   · 开关与音量存 localStorage 的 `im-the-boss:audio`（读写失败只影响当前会话）
// ============================================================

import { RECIPES, SFX_MIN_GAP_MS, type SfxId, type Tone } from './sfx'

/** 本模块用到的 AudioContext 最小子集（真 AudioContext 与测试里的假实现都满足） */
export interface ParamLike {
  value: number
  setValueAtTime(v: number, t: number): unknown
  linearRampToValueAtTime(v: number, t: number): unknown
  exponentialRampToValueAtTime(v: number, t: number): unknown
}
export interface AudioNodeLike { connect(dest: unknown): unknown; disconnect?(): unknown }
export interface OscillatorLike extends AudioNodeLike {
  type: string
  frequency: ParamLike
  start(t: number): void
  stop(t: number): void
  onended: (() => void) | null
}
export interface GainLike extends AudioNodeLike { gain: ParamLike }
export interface FilterLike extends AudioNodeLike { type: string; frequency: ParamLike }
export interface CompressorLike extends AudioNodeLike {}
export interface AudioContextLike {
  readonly currentTime: number
  readonly state: string
  readonly destination: unknown
  createOscillator(): OscillatorLike
  createGain(): GainLike
  createBiquadFilter(): FilterLike
  createDynamicsCompressor(): CompressorLike
  resume(): Promise<void> | void
  close?(): Promise<void> | void
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface AudioPrefs { enabled: boolean; volume: number }
export interface AudioState extends AudioPrefs {
  /** 环境是否支持 Web Audio */
  supported: boolean
  /** 是否已被用户交互解锁（能发声） */
  unlocked: boolean
}

export const AUDIO_STORAGE_KEY = 'im-the-boss:audio'
export const DEFAULT_AUDIO_PREFS: AudioPrefs = { enabled: true, volume: 0.5 }

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)

/** 读取偏好；缺失 / 损坏 / 越界都回落到默认值 */
export function loadAudioPrefs(storage: StorageLike | null | undefined): AudioPrefs {
  try {
    const raw = storage?.getItem(AUDIO_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_AUDIO_PREFS }
    const p = JSON.parse(raw) as Partial<AudioPrefs>
    return {
      enabled: typeof p.enabled === 'boolean' ? p.enabled : DEFAULT_AUDIO_PREFS.enabled,
      volume: typeof p.volume === 'number' ? clamp01(p.volume) : DEFAULT_AUDIO_PREFS.volume,
    }
  } catch {
    return { ...DEFAULT_AUDIO_PREFS }
  }
}

/** 滑块音量（线性 0–1）→ 实际增益：平方曲线更贴合听感，整体再留余量 */
export function masterGainOf(volume: number): number {
  const v = clamp01(volume)
  return v * v * 0.8
}

export interface AudioEngineOptions {
  /** 创建 AudioContext；返回 null = 不支持。默认取 window.AudioContext / webkitAudioContext */
  contextFactory?: () => AudioContextLike | null
  storage?: StorageLike | null
  /** 监听"首次用户交互"的目标，默认 window；传 null 则不自动解锁（测试里手动 unlock） */
  gestureTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null
  now?: () => number
}

export interface PlayOptions {
  /** 延后多少毫秒开始（由音频时钟精确调度） */
  delayMs?: number
  /** 额外力度系数 0–1 */
  gain?: number
}

export interface AudioEngine {
  getState(): AudioState
  subscribe(listener: () => void): () => void
  setEnabled(enabled: boolean): void
  toggle(): void
  setVolume(volume: number): void
  /** 播放；返回是否真的发声（关闭 / 未解锁 / 不支持 / 被节流时为 false） */
  play(id: SfxId, opts?: PlayOptions): boolean
  /** 手动解锁（一般不用调：首次交互自动解锁） */
  unlock(): void
  dispose(): void
}

function defaultContextFactory(): AudioContextLike | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { AudioContext?: new () => AudioContextLike; webkitAudioContext?: new () => AudioContextLike }
  const Ctor = w.AudioContext ?? w.webkitAudioContext
  if (!Ctor) return null
  try { return new Ctor() } catch { return null }
}

function defaultStorage(): StorageLike | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null } catch { return null }
}

const GESTURE_EVENTS = ['pointerdown', 'keydown', 'touchstart'] as const

/** 把一个音符排进音频时钟：振荡器 → （低通）→ 包络增益 → 出口 */
function scheduleTone(ctx: AudioContextLike, out: AudioNodeLike, tone: Tone, t0: number, scale: number) {
  const start = t0 + tone.at
  const attack = tone.attack ?? 0.008
  const end = start + tone.dur
  const osc = ctx.createOscillator()
  osc.type = tone.wave
  osc.frequency.setValueAtTime(tone.freq, start)
  if (tone.to != null && tone.to > 0) osc.frequency.exponentialRampToValueAtTime(tone.to, end)

  const env = ctx.createGain()
  const peak = Math.max(0.0002, tone.gain * scale)
  env.gain.setValueAtTime(0.0001, start)
  env.gain.linearRampToValueAtTime(peak, start + Math.min(attack, tone.dur * 0.5))
  env.gain.exponentialRampToValueAtTime(0.0001, end)

  if (tone.lowpass) {
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(tone.lowpass, start)
    osc.connect(filter)
    filter.connect(env)
  } else {
    osc.connect(env)
  }
  env.connect(out)
  osc.start(start)
  osc.stop(end + 0.03)
  osc.onended = () => { try { osc.disconnect?.(); env.disconnect?.() } catch { /* 已断开 */ } }
}

export function createAudioEngine(options: AudioEngineOptions = {}): AudioEngine {
  const storage = options.storage === undefined ? defaultStorage() : options.storage
  const now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()))
  const contextFactory = options.contextFactory ?? defaultContextFactory
  const target = options.gestureTarget === undefined ? (typeof window !== 'undefined' ? window : null) : options.gestureTarget

  let prefs = loadAudioPrefs(storage)
  let ctx: AudioContextLike | null = null
  let master: GainLike | null = null
  let supported = options.contextFactory ? true : (typeof window !== 'undefined' && !!((window as unknown as Record<string, unknown>).AudioContext ?? (window as unknown as Record<string, unknown>).webkitAudioContext))
  let unlocked = false
  let disposed = false
  const lastPlayed = new Map<SfxId, number>()
  const listeners = new Set<() => void>()
  let cached: AudioState | null = null

  const snapshot = (): AudioState => {
    if (!cached || cached.enabled !== prefs.enabled || cached.volume !== prefs.volume || cached.supported !== supported || cached.unlocked !== unlocked) {
      cached = { enabled: prefs.enabled, volume: prefs.volume, supported, unlocked }
    }
    return cached
  }
  const emit = () => listeners.forEach(l => l())
  const persist = () => { try { storage?.setItem(AUDIO_STORAGE_KEY, JSON.stringify(prefs)) } catch { /* 存储不可用 */ } }

  const detach = () => { if (target) for (const ev of GESTURE_EVENTS) target.removeEventListener(ev, onGesture, true) }
  function onGesture() { unlock() }

  function unlock() {
    if (disposed || unlocked) return
    try {
      ctx = contextFactory()
      if (!ctx) { supported = false; detach(); emit(); return }
      const comp = ctx.createDynamicsCompressor()
      master = ctx.createGain()
      master.gain.setValueAtTime(masterGainOf(prefs.volume), ctx.currentTime)
      master.connect(comp)
      comp.connect(ctx.destination)
      void ctx.resume()
      unlocked = true
      detach()
    } catch {
      supported = false
      ctx = null
      master = null
      detach()
    }
    emit()
  }

  function setEnabled(enabled: boolean) {
    if (prefs.enabled === enabled) return
    prefs = { ...prefs, enabled }
    persist()
    emit()
  }

  if (supported && target) for (const ev of GESTURE_EVENTS) target.addEventListener(ev, onGesture, true)

  return {
    getState: snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    setEnabled,
    toggle() { setEnabled(!prefs.enabled) },
    setVolume(volume) {
      const v = clamp01(volume)
      if (prefs.volume === v) return
      prefs = { ...prefs, volume: v }
      if (ctx && master) master.gain.setValueAtTime(masterGainOf(v), ctx.currentTime)
      persist()
      emit()
    },
    play(id, opts = {}) {
      if (disposed || !prefs.enabled || !supported || !unlocked || !ctx || !master || prefs.volume <= 0) return false
      const t = now()
      const last = lastPlayed.get(id)
      if (last != null && t - last < SFX_MIN_GAP_MS[id]) return false
      lastPlayed.set(id, t)
      try {
        if (ctx.state === 'suspended') void ctx.resume()
        const t0 = ctx.currentTime + 0.01 + Math.max(0, opts.delayMs ?? 0) / 1000
        const scale = clamp01(opts.gain ?? 1)
        for (const tone of RECIPES[id]) scheduleTone(ctx, master, tone, t0, scale)
        return true
      } catch {
        return false
      }
    },
    unlock,
    dispose() {
      disposed = true
      detach()
      listeners.clear()
      try { void ctx?.close?.() } catch { /* 忽略 */ }
      ctx = null
      master = null
    },
  }
}
