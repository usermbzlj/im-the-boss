// ============================================================
// LLM 策略 — "按编号选择"协议
//
// 合法动作由 validator 枚举、经 prompts.pruneForLLM 剪枝并附上后果注释后编号成列表；
// 模型回复序号，用 speech / demand / payouts / cardIds 定台词、金额或选牌，
// 可附 thought（内心盘算，只用于让它想清楚，不落地）与 note（写给下回合自己的私人笔记，存入 Player.notes）。
// 解析出的动作必须通过 isLegal，否则重试一次；仍失败返回 null，
// 由 withFallback 交给启发式策略——LLM 永远不会让游戏卡住。
// ============================================================

import type { GameState, Negotiation, PlayerAction, Payout, FamilyId } from '../engine/types'
import { FAMILY_IDS } from '../engine/config'
import { chatCompletion, isLLMConfigured, type LLMConfig } from './llmClient'
import { buildDecisionPrompt } from './prompts'
import { DECISION_PROMPTS } from './promptTexts'
import { getActingPlayerId, getLegalActions, isLegal } from '../engine/validator'
import { getGrossValue, offerOwners, hasDemand, playerRelevantFamilies } from '../engine/rules'
import { heuristicSpeech } from './heuristic'
import type { Policy } from './policy'

const SPEECH_MAX_LEN = 120
const NOTE_MAX_LEN = 80

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

      // 编号列表是剪枝后的 options（去掉自伤 / 冗余项），落成动作也必须用同一份列表
      const { system, user, options } = buildDecisionPrompt(state, actingId, legal)
      if (options.length === 1) return { ...options[0], say: heuristicSpeech(state, options[0]) || undefined }
      const raw = await chatCompletion(config, [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ], { signal, purpose: 'decision' })
      const first = resolveChoice(raw, options, state)
      if (first) return first

      const retrySystem = `${system}\n${DECISION_PROMPTS.retryHint}\n【你上一次的原始回复】\n${raw.slice(0, 400)}`
      const raw2 = await chatCompletion(config, [
        { role: 'system', content: retrySystem },
        { role: 'user', content: user },
      ], { signal, temperatureOverride: 0, purpose: 'decision-retry' })
      return resolveChoice(raw2, options, state)
    },
  }
}

/** 模型写的分成条目：收款人可以是玩家 ID，也可以是玩家名（模型更习惯用名字） */
export interface RawPayout {
  playerId: number | string
  amount: number
}

interface ChoiceResponse {
  choice: number
  speech?: string
  demand?: number
  /** 喊话报价时可指定只对某一家族报价（家族字母 A–F） */
  demandFamily?: FamilyId
  payouts?: RawPayout[]
  cardIds?: number[]
  /** 写给下回合自己的私人笔记 */
  note?: string
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

/** 收款人：数字（或数字串）当 ID，其余非空字符串当玩家名 */
function toPayee(v: unknown): number | string | undefined {
  const n = toInt(v)
  if (n != null) return n
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

export function parseChoiceResponse(raw: string): ChoiceResponse | null {
  try {
    const text = extractJsonObject(raw)
    if (!text) return null
    const obj = JSON.parse(text)
    const choice = toInt(obj.choice)
    if (choice == null || choice < 1) return null
    const demand = obj.demand && typeof obj.demand === 'object' ? toInt(obj.demand.amount) : toInt(obj.demand)
    const famRaw = obj.demandFamily ?? obj.family ?? (obj.demand && typeof obj.demand === 'object' ? obj.demand.family : undefined)
    const famLetter = typeof famRaw === 'string' ? famRaw.trim().charAt(0).toUpperCase() : ''
    const demandFamily = (FAMILY_IDS as readonly string[]).includes(famLetter) ? famLetter as FamilyId : undefined
    // 分成条目任一残缺则整组作废：宁可沿用候选方案，也不能把"给某人 $2M"悄悄变成"谁都不给"
    // （空数组同样视为"不覆盖"——"独吞"本身就是一个独立的编号选项）
    const rawPayouts = obj.payouts ?? obj.payout
    let payouts: RawPayout[] | undefined
    if (Array.isArray(rawPayouts) && rawPayouts.length > 0) {
      const list = rawPayouts.map((p: Record<string, unknown> | null) => ({
        playerId: toPayee(p?.playerId ?? p?.player ?? p?.name ?? p?.to),
        amount: toInt(p?.amount),
      }))
      payouts = list.every((p): p is RawPayout => p.playerId != null && p.amount != null) ? list : undefined
    }
    const cardIds = Array.isArray(obj.cardIds) ? obj.cardIds.map(toInt).filter((n: number | undefined): n is number => n != null) : undefined
    const note = typeof obj.note === 'string' && obj.note.trim() ? obj.note.trim() : undefined
    // thought 字段是模型自己的盘算，读过即弃：既不落地也不展示
    return { choice, speech: typeof obj.speech === 'string' ? obj.speech : undefined, demand, demandFamily, payouts, cardIds, note }
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
        // 指定了家族且确实是我在本格的相关代表 → 只对该家族报价；否则由引擎对我所有相关代表记同一价（无代表则为封口费）
        if (parsed.demandFamily && playerRelevantFamilies(state, action.playerId).includes(parsed.demandFamily)) action.demandFamily = parsed.demandFamily
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
      const neg = state.negotiation
      const payouts = parsed.payouts && neg ? resolvePayees(state, parsed.payouts) : null
      if (payouts && neg) {
        const candidate = { ...action, payouts: payouts.filter(p => p.playerId !== neg.bossId && p.amount >= 0) }
        if (payoutsPlausible(neg, candidate) && isLegal(state, candidate)) action = candidate
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
  if (parsed.note) action.note = parsed.note.slice(0, NOTE_MAX_LEN)
  return isLegal(state, action) ? action : null
}

/** 把"玩家 ID 或玩家名"落成 ID；任一条目无法唯一对应则整组放弃（调用方沿用候选方案的分成） */
export function resolvePayees(state: GameState, raw: RawPayout[]): Payout[] | null {
  const out: Payout[] = []
  for (const p of raw) {
    let id: number | undefined
    if (typeof p.playerId === 'number') id = state.players[p.playerId] ? p.playerId : undefined
    else {
      const matches = state.players.filter(pl => pl.name === p.playerId)
      id = matches.length === 1 ? matches[0].id : undefined
    }
    if (id == null) return null
    out.push({ playerId: id, amount: p.amount })
  }
  return out
}

/**
 * 分成只能付给方案中代表的持有者，或已公开要价（封口费）的人。
 * 付钱给一个既不出人也没开口的旁观者，几乎一定是模型把收款人弄错了——
 * 这种方案若放行，台词里承诺的钱就会落到别人头上，被用代表的人反而拿 $0。
 */
function payoutsPlausible(neg: Negotiation, action: { repKeys: string[]; payouts: Payout[] }): boolean {
  const owners = new Set(offerOwners(neg, action))
  return action.payouts.every(p => owners.has(p.playerId) || hasDemand(neg, p.playerId))
}
