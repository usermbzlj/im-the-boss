// ============================================================
// LLM 策略 — "按编号选择"协议
//
// 合法动作由 validator 枚举、由 text/labels 编号成列表；模型只回复序号，
// 至多用 speech / demand / payouts / cardIds 微调台词、金额或选牌。
// 解析出的动作必须通过 isLegal，否则重试一次；仍失败返回 null，
// 由 withFallback 交给启发式策略——LLM 永远不会让游戏卡住。
// ============================================================

import type { GameState, PlayerAction, Payout } from '../engine/types'
import { chatCompletion, isLLMConfigured, type LLMConfig } from './llmClient'
import { buildDecisionPrompt } from './prompts'
import { DECISION_PROMPTS } from './promptTexts'
import { getActingPlayerId, getLegalActions, isLegal } from '../engine/validator'
import { getGrossValue, playerActiveFamilies } from '../engine/rules'
import { heuristicSpeech } from './heuristic'
import type { Policy } from './policy'

const SPEECH_MAX_LEN = 120

export function createLLMPolicy(getConfig: () => LLMConfig): Policy {
  return {
    name: 'llm',
    async decide(state, signal) {
      const actingId = getActingPlayerId(state)
      const legal = getLegalActions(state, actingId)
      if (legal.length === 0) return null

      // 唯一合法动作（终局掷骰、无阻止牌时的放行……）无需请求模型
      if (legal.length === 1) return { ...legal[0], say: heuristicSpeech(state, legal[0]) || undefined }

      const config = getConfig()
      if (!isLLMConfigured(config)) return null

      const { system, user } = buildDecisionPrompt(state, actingId, legal)
      const raw = await chatCompletion(config, [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ], { signal, purpose: 'decision' })
      const first = resolveChoice(raw, legal, state)
      if (first) return first

      const retrySystem = `${system}\n${DECISION_PROMPTS.retryHint}\n【你上一次的原始回复】\n${raw.slice(0, 400)}`
      const raw2 = await chatCompletion(config, [
        { role: 'system', content: retrySystem },
        { role: 'user', content: user },
      ], { signal, temperatureOverride: 0, purpose: 'decision-retry' })
      return resolveChoice(raw2, legal, state)
    },
  }
}

interface ChoiceResponse {
  choice: number
  speech?: string
  demand?: number
  payouts?: Payout[]
  cardIds?: number[]
}

/** 剥离 <think> 与代码围栏后，用括号配对提取第一个完整 JSON 对象 */
export function extractJsonObject(raw: string): string | null {
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '')
  const start = cleaned.indexOf('{')
  if (start < 0) return null
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return cleaned.slice(start, i + 1) }
  }
  return null
}

function toInt(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : undefined
}

export function parseChoiceResponse(raw: string): ChoiceResponse | null {
  try {
    const text = extractJsonObject(raw)
    if (!text) return null
    const obj = JSON.parse(text)
    const choice = toInt(obj.choice)
    if (choice == null || choice < 1) return null
    const demand = obj.demand && typeof obj.demand === 'object' ? toInt(obj.demand.amount) : toInt(obj.demand)
    const rawPayouts = obj.payouts ?? obj.payout
    const payouts = Array.isArray(rawPayouts)
      ? rawPayouts.map((p: Record<string, unknown>) => ({ playerId: toInt(p?.playerId), amount: toInt(p?.amount) }))
        .filter((p: { playerId?: number; amount?: number }): p is Payout => p.playerId != null && p.amount != null)
      : undefined
    const cardIds = Array.isArray(obj.cardIds) ? obj.cardIds.map(toInt).filter((n: number | undefined): n is number => n != null) : undefined
    return { choice, speech: typeof obj.speech === 'string' ? obj.speech : undefined, demand, payouts, cardIds }
  } catch {
    return null
  }
}

/** 把模型回复落成合法动作；任何不合法之处都返回 null（调用方重试或兜底） */
export function resolveChoice(raw: string, legal: PlayerAction[], state: GameState): PlayerAction | null {
  const parsed = parseChoiceResponse(raw)
  if (!parsed) return null
  const option = legal[parsed.choice - 1]
  if (!option) return null

  const speech = (parsed.speech ?? '').trim().slice(0, SPEECH_MAX_LEN)
  const gross = getGrossValue(state)
  const clampDemand = (d: number | undefined) => d == null ? undefined : Math.max(0, Math.min(gross, d))
  let action: PlayerAction = structuredClone(option)

  switch (action.type) {
    case 'SPEAK': {
      action.say = speech || DECISION_PROMPTS.defaultSpeech
      const demand = clampDemand(parsed.demand)
      if (demand != null) {
        action.demand = demand
        const mine = state.negotiation ? [...playerActiveFamilies(state.negotiation, action.playerId)] : []
        if (mine.length > 0) action.demandFamily = mine[0]
      }
      break
    }
    case 'PLAY_CLAN': {
      const demand = clampDemand(parsed.demand)
      if (demand != null) action.demand = demand
      break
    }
    case 'DECLINE_OFFER': {
      const counter = clampDemand(parsed.demand)
      if (counter != null) action.counter = counter
      break
    }
    case 'PROPOSE_OFFER': {
      if (parsed.payouts && state.negotiation) {
        const bossId = state.negotiation.bossId
        const candidate: PlayerAction = { ...action, payouts: parsed.payouts.filter(p => p.playerId !== bossId && p.amount >= 0) }
        if (isLegal(state, candidate)) action = candidate
      }
      break
    }
    case 'DISCARD': {
      if (parsed.cardIds) {
        const candidate: PlayerAction = { ...action, cardIds: parsed.cardIds }
        if (isLegal(state, candidate)) action = candidate
      }
      break
    }
  }

  if (action.type !== 'SPEAK') action.say = speech || heuristicSpeech(state, action) || undefined
  return isLegal(state, action) ? action : null
}
