// ============================================================
// createSession — GameSession 的装配工厂（依赖注入）
//
// GameSession 本身只认"策略 / 停顿 / 回调"。这里把"策略从哪来、存档存哪、停顿多久"
// 收拢成一个 SessionEnv，让浏览器用真 LLM + localStorage + 拟人节奏，
// 测试用假策略 + 内存存储 + 零延迟，两边走同一条装配路径。
// 浏览器那一份环境在 hooks/browserEnv.ts。
// ============================================================

import type { GameState } from '../engine/types'
import type { Policy } from '../ai/policy'
import type { AiStatusSource } from '../ai/aiStatus'
import { GameSession, type DelayFor } from './session'
import { Autosaver, type SaveSink } from './autosave'
import { createGame, type SavedGame, type StartInput } from './replay'

export interface SessionEnv {
  /** 电脑玩家的决策策略 */
  policy: Policy
  /** 兜底策略（默认启发式） */
  fallback?: Policy
  /** 电脑行动前的停顿；省略 = 不停顿 */
  delayFor?: DelayFor
  /** 人类只能放行的窗口自动放行（默认开） */
  autoPassHuman?: boolean
  /** 电脑玩家运行状况的来源（LLM 熔断监视，由会话订阅并写入 snapshot.ai）；省略 = 不显示 */
  aiStatus?: AiStatusSource
  /** 存档位置；省略或 null = 不存档 */
  store?: SaveSink | null
  /** 读取存档（"继续上一局"用）；省略 = 没有存档可读 */
  loadSaved?: () => SavedGame | null
  /** 存档节流毫秒数（默认 400；<= 0 同步写） */
  saveThrottleMs?: number
  onChange?: (state: GameState) => void
  onError?: (message: string) => void
}

const autosavers = new WeakMap<GameSession, Autosaver>()

/** 立即落盘（页面隐藏 / 即将离开时调用） */
export function flushAutosave(session: GameSession | null | undefined) {
  if (session) autosavers.get(session)?.flush()
}

/** 用已有的完整存档（状态 + 开局参数 + 日志）组装会话 */
export function resumeGameSession(saved: SavedGame | GameState, env: SessionEnv): GameSession {
  const full: SavedGame = 'state' in saved ? saved : { state: saved, origin: null, log: [], replayable: false }
  const saver = env.store ? new Autosaver(env.store, { throttleMs: env.saveThrottleMs }) : null
  const session = new GameSession(full.state, {
    policy: env.policy,
    fallback: env.fallback,
    delayFor: env.delayFor,
    autoPassHuman: env.autoPassHuman,
    aiStatus: env.aiStatus,
    replay: full.replayable && full.origin ? { origin: full.origin, log: full.log } : undefined,
    onChange: state => { env.onChange?.(state); saver?.touch(state) },
    onDestroy: () => saver?.flush(),
    onError: env.onError,
  })
  if (saver) { autosavers.set(session, saver); saver.attach(session) }
  return session
}

/** 开新局：种子在这里定下来并随日志保存，之后整局可重放 */
export function startGameSession(input: StartInput, env: SessionEnv): GameSession {
  const { state, origin } = createGame(input)
  return resumeGameSession({ state, origin, log: [], replayable: true }, env)
}
