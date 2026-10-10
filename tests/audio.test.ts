// 音效：配方合理性、引擎的解锁 / 开关 / 音量 / 持久化 / 节流 / 无 AudioContext 降级（用假 AudioContext，不依赖浏览器）

import { describe, it, expect } from 'vitest'
import {
  AUDIO_STORAGE_KEY, DEFAULT_AUDIO_PREFS, createAudioEngine, loadAudioPrefs, masterGainOf,
  type AudioContextLike, type StorageLike,
} from '../src/audio/engine'
import { RECIPES, SFX_IDS, SFX_MIN_GAP_MS, SFX_PRIORITY, recipeDuration } from '../src/audio/sfx'

class MemStorage implements StorageLike {
  data = new Map<string, string>()
  getItem(k: string) { return this.data.get(k) ?? null }
  setItem(k: string, v: string) { this.data.set(k, v) }
}

/** 假 AudioContext：记录创建了多少振荡器 / 增益节点与主增益的取值 */
function fakeContext() {
  const log = { oscillators: 0, started: 0, gains: [] as number[], resumed: 0, filters: 0, compressors: 0, lastMasterGain: -1 }
  const param = (onSet?: (v: number) => void) => ({
    value: 0,
    setValueAtTime(v: number) { onSet?.(v) },
    linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {},
  })
  let gainNodes = 0
  const ctx: AudioContextLike = {
    currentTime: 0,
    state: 'suspended',
    destination: {},
    createOscillator() {
      log.oscillators++
      return { type: '', frequency: param(), connect() {}, disconnect() {}, start() { log.started++ }, stop() {}, onended: null }
    },
    createGain() {
      const first = gainNodes++ === 0 // 第一个创建的增益是主增益
      return { gain: param(v => { if (first) log.lastMasterGain = v }), connect() {}, disconnect() {} }
    },
    createBiquadFilter() { log.filters++; return { type: '', frequency: param(), connect() {}, disconnect() {} } },
    createDynamicsCompressor() { log.compressors++; return { connect() {}, disconnect() {} } },
    resume() { log.resumed++ },
  }
  return { ctx, log }
}

const gestureTarget = () => {
  const handlers = new Map<string, Set<() => void>>()
  return {
    addEventListener(t: string, fn: () => void) { (handlers.get(t) ?? handlers.set(t, new Set()).get(t)!).add(fn) },
    removeEventListener(t: string, fn: () => void) { handlers.get(t)?.delete(fn) },
    fire(t: string) { handlers.get(t)?.forEach(fn => fn()) },
    count: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
  }
}

describe('音效配方', () => {
  it('覆盖所有音效 id，且每个都有音符、时长在 1.6 秒内、音量克制', () => {
    for (const id of SFX_IDS) {
      const r = RECIPES[id]
      expect(r.length, id).toBeGreaterThan(0)
      expect(recipeDuration(id), id).toBeLessThanOrEqual(1.6)
      for (const n of r) {
        expect(n.gain, id).toBeGreaterThan(0)
        expect(n.gain, id).toBeLessThanOrEqual(0.4)
        expect(n.freq, id).toBeGreaterThan(40)
        expect(n.freq, id).toBeLessThan(5000)
        expect(n.dur, id).toBeGreaterThan(0)
        expect(n.at, id).toBeGreaterThanOrEqual(0)
      }
      expect(SFX_MIN_GAP_MS[id]).toBeGreaterThan(0)
      expect(SFX_PRIORITY[id]).toBeGreaterThan(0)
    }
    expect(Object.keys(RECIPES).sort()).toEqual([...SFX_IDS].sort())
  })

  it('成交是悦耳的和弦（至少四个音，含 C 大三和弦音），终局胜利比成交更长', () => {
    const deal = RECIPES.deal.map(n => Math.round(n.freq))
    expect(deal.length).toBeGreaterThanOrEqual(4)
    expect(deal).toEqual(expect.arrayContaining([523, 659, 784]))
    expect(recipeDuration('win')).toBeGreaterThan(recipeDuration('coin'))
  })
})

describe('引擎：解锁与播放', () => {
  it('默认开启，但首次用户交互之前不发声（不排队）；交互后才创建 AudioContext 并可播放', () => {
    const { ctx, log } = fakeContext()
    const target = gestureTarget()
    const e = createAudioEngine({ contextFactory: () => ctx, storage: new MemStorage(), gestureTarget: target, now: () => 1000 })
    expect(e.getState()).toMatchObject({ enabled: true, unlocked: false, supported: true })
    expect(e.play('coin')).toBe(false)
    expect(log.oscillators).toBe(0)

    target.fire('pointerdown')
    expect(e.getState().unlocked).toBe(true)
    expect(log.compressors).toBe(1)
    expect(log.resumed).toBeGreaterThanOrEqual(1)
    expect(target.count()).toBe(0) // 解锁后不再监听
    expect(e.play('coin')).toBe(true)
    expect(log.oscillators).toBe(RECIPES.coin.length)
    expect(log.started).toBe(RECIPES.coin.length)
  })

  it('关闭后不发声，重新开启恢复', () => {
    const { ctx, log } = fakeContext()
    let t = 0
    const e = createAudioEngine({ contextFactory: () => ctx, storage: new MemStorage(), gestureTarget: null, now: () => (t += 5000) })
    e.unlock()
    e.setEnabled(false)
    expect(e.play('play')).toBe(false)
    expect(log.oscillators).toBe(0)
    e.toggle()
    expect(e.getState().enabled).toBe(true)
    expect(e.play('play')).toBe(true)
  })

  it('音量为 0 不发声；音量变化实时作用到主增益且单调（平方曲线）', () => {
    const { ctx, log } = fakeContext()
    const e = createAudioEngine({ contextFactory: () => ctx, storage: new MemStorage(), gestureTarget: null, now: () => 0 })
    e.unlock()
    e.setVolume(0.4)
    const g1 = log.lastMasterGain
    e.setVolume(0.8)
    const g2 = log.lastMasterGain
    expect(g2).toBeGreaterThan(g1)
    expect(g1).toBeCloseTo(masterGainOf(0.4))
    expect(masterGainOf(1)).toBeLessThanOrEqual(0.8)
    e.setVolume(0)
    expect(e.play('deal')).toBe(false)
    e.setVolume(7) // 越界被夹住
    expect(e.getState().volume).toBe(1)
    e.setVolume(-1)
    expect(e.getState().volume).toBe(0)
  })

  it('同一音效连续触发被节流（防快进时的连环爆音），不同音效互不影响', () => {
    const { ctx } = fakeContext()
    let t = 10_000
    const e = createAudioEngine({ contextFactory: () => ctx, storage: new MemStorage(), gestureTarget: null, now: () => t })
    e.unlock()
    expect(e.play('coin')).toBe(true)
    t += 20
    expect(e.play('coin')).toBe(false)
    expect(e.play('stop')).toBe(true)
    t += SFX_MIN_GAP_MS.coin
    expect(e.play('coin')).toBe(true)
  })

  it('延迟播放：delayMs 通过音频时钟排程（振荡器照常创建）', () => {
    const { ctx, log } = fakeContext()
    const e = createAudioEngine({ contextFactory: () => ctx, storage: new MemStorage(), gestureTarget: null, now: () => 0 })
    e.unlock()
    expect(e.play('up', { delayMs: 170 })).toBe(true)
    expect(log.oscillators).toBe(RECIPES.up.length)
  })
})

describe('引擎：持久化与降级', () => {
  it('开关与音量写入自己的 localStorage key，重建后恢复', () => {
    const storage = new MemStorage()
    const a = createAudioEngine({ contextFactory: () => null, storage, gestureTarget: null })
    a.setEnabled(false)
    a.setVolume(0.25)
    expect(JSON.parse(storage.getItem(AUDIO_STORAGE_KEY)!)).toEqual({ enabled: false, volume: 0.25 })
    const b = createAudioEngine({ contextFactory: () => null, storage, gestureTarget: null })
    expect(b.getState()).toMatchObject({ enabled: false, volume: 0.25 })
  })

  it('偏好缺失 / 损坏 / 越界都回落到默认值', () => {
    expect(loadAudioPrefs(null)).toEqual(DEFAULT_AUDIO_PREFS)
    const s = new MemStorage()
    s.setItem(AUDIO_STORAGE_KEY, '{oops')
    expect(loadAudioPrefs(s)).toEqual(DEFAULT_AUDIO_PREFS)
    s.setItem(AUDIO_STORAGE_KEY, JSON.stringify({ enabled: 'yes', volume: 9 }))
    expect(loadAudioPrefs(s)).toEqual({ enabled: true, volume: 1 })
  })

  it('存储抛错时不影响使用', () => {
    const bad: StorageLike = { getItem() { throw new Error('denied') }, setItem() { throw new Error('quota') } }
    const e = createAudioEngine({ contextFactory: () => null, storage: bad, gestureTarget: null })
    expect(() => e.setVolume(0.3)).not.toThrow()
    expect(e.getState().volume).toBe(0.3)
  })

  it('没有 AudioContext（contextFactory 返回 null / 抛错）：解锁后标记为不支持，play 安全返回 false', () => {
    const none = createAudioEngine({ contextFactory: () => null, storage: new MemStorage(), gestureTarget: null })
    none.unlock()
    expect(none.getState().supported).toBe(false)
    expect(none.play('deal')).toBe(false)
    const boom = createAudioEngine({ contextFactory: () => { throw new Error('no audio') }, storage: new MemStorage(), gestureTarget: null })
    expect(() => boom.unlock()).not.toThrow()
    expect(boom.play('deal')).toBe(false)
  })

  it('Node 环境（没有 window.AudioContext）：默认引擎直接降级为不支持，全部方法空转', () => {
    const e = createAudioEngine({ storage: new MemStorage() })
    expect(e.getState().supported).toBe(false)
    expect(() => { e.unlock(); e.toggle(); e.setVolume(0.9); e.play('win'); e.dispose() }).not.toThrow()
  })

  it('订阅：状态变化通知监听者，取消订阅后不再通知；快照在无变化时引用稳定', () => {
    const e = createAudioEngine({ contextFactory: () => null, storage: new MemStorage(), gestureTarget: null })
    let n = 0
    const off = e.subscribe(() => { n++ })
    const s1 = e.getState()
    expect(e.getState()).toBe(s1)
    e.setEnabled(false)
    e.setEnabled(false) // 没变化
    expect(n).toBe(1)
    expect(e.getState()).not.toBe(s1)
    off()
    e.setEnabled(true)
    expect(n).toBe(1)
  })
})
