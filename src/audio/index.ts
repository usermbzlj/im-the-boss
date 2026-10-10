// ============================================================
// 音频模块出口：全局单例（懒创建）+ React 订阅 hook
// ============================================================

import { useSyncExternalStore } from 'react'
import { createAudioEngine, type AudioEngine, type AudioState } from './engine'

export type { AudioEngine, AudioState } from './engine'
export { createAudioEngine, AUDIO_STORAGE_KEY, DEFAULT_AUDIO_PREFS, loadAudioPrefs, masterGainOf } from './engine'
export type { SfxId } from './sfx'
export { SFX_IDS, SFX_PRIORITY, RECIPES, recipeDuration } from './sfx'

let instance: AudioEngine | null = null

/** 全局音频引擎（首次调用时创建，并开始监听首次用户交互） */
export function getSound(): AudioEngine {
  if (!instance) instance = createAudioEngine()
  return instance
}

/** 测试用：换掉 / 清掉全局单例 */
export function setSoundForTests(engine: AudioEngine | null) {
  instance?.dispose()
  instance = engine
}

/** 订阅音频状态（开关 / 音量 / 是否解锁） */
export function useAudioState(engine: AudioEngine = getSound()): AudioState {
  return useSyncExternalStore(engine.subscribe, engine.getState, engine.getState)
}
