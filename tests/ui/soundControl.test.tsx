// @vitest-environment jsdom
// 顶栏音效开关：开 / 关 / 音量，状态存进自己的 localStorage key；不支持时置灰

import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SoundControl from '../../src/components/SoundControl'
import { AUDIO_STORAGE_KEY, createAudioEngine, type AudioContextLike, type StorageLike } from '../../src/audio/engine'

afterEach(cleanup)

class Mem implements StorageLike {
  data = new Map<string, string>()
  getItem(k: string) { return this.data.get(k) ?? null }
  setItem(k: string, v: string) { this.data.set(k, v) }
}

const supportedEngine = (storage = new Mem()) =>
  createAudioEngine({ contextFactory: () => ({} as AudioContextLike), storage, gestureTarget: null })
const unsupportedEngine = () => createAudioEngine({ contextFactory: () => null, storage: new Mem(), gestureTarget: null })

describe('SoundControl', () => {
  it('默认开启：按钮处于按下状态并显示音量滑块；点按钮关闭并写入存储，滑块消失', async () => {
    const user = userEvent.setup()
    const storage = new Mem()
    const engine = supportedEngine(storage)
    render(<SoundControl engine={engine} />)
    const btn = screen.getByRole('button', { name: '音效' })
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('slider', { name: '音量' })).toBeTruthy()

    await user.click(btn)
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByRole('slider')).toBeNull()
    expect(JSON.parse(storage.getItem(AUDIO_STORAGE_KEY)!).enabled).toBe(false)
    expect(engine.getState().enabled).toBe(false)

    await user.click(btn)
    expect(btn.getAttribute('aria-pressed')).toBe('true')
  })

  it('拖动音量滑块：引擎音量随之变化并持久化', () => {
    const storage = new Mem()
    const engine = supportedEngine(storage)
    render(<SoundControl engine={engine} />)
    const slider = screen.getByRole('slider', { name: '音量' }) as HTMLInputElement
    fireEvent.change(slider, { target: { value: '80' } })
    expect(engine.getState().volume).toBeCloseTo(0.8)
    expect(JSON.parse(storage.getItem(AUDIO_STORAGE_KEY)!).volume).toBeCloseTo(0.8)
    expect(slider.value).toBe('80')
  })

  it('读取已保存的偏好：关闭状态下重新挂载仍是关闭', () => {
    const storage = new Mem()
    storage.setItem(AUDIO_STORAGE_KEY, JSON.stringify({ enabled: false, volume: 0.2 }))
    render(<SoundControl engine={supportedEngine(storage)} />)
    expect(screen.getByRole('button', { name: '音效' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('环境不支持 Web Audio：解锁后按钮置灰、没有滑块（安全降级）', () => {
    const engine = unsupportedEngine()
    engine.unlock()
    render(<SoundControl engine={engine} />)
    const btn = screen.getByRole('button', { name: '音效' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(screen.queryByRole('slider')).toBeNull()
  })
})
