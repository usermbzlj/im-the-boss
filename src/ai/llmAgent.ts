// ============================================================
// LLM Agent — 全量 AI 决策
// ============================================================
//
// 协议说明（相对旧版的核心变化）：
// 旧版要求模型把完整的 action JSON 抄一遍（包括 PROPOSE_CONTRACT 这种深嵌套
// 结构），任何字段抄错、类型不对、或者干脆构造出一个合法列表里根本不存在的
// 动作，都会导致 validateAction 失败。现在改为"按编号选择"：合法动作已经在
// formatLegalActionsForLLM 里编号列出，模型只需要回复选中的序号；
// PROPOSE_CONTRACT 的候选合约也已由 contractBuilder 在服务端算好（独吞/均分/
// 满足要价），模型至多用 payout 字段微调具体金额，其余结构完全不需要模型生成。
// 这从根源上消除了"LLM 编造非法结构"这一类失败源。

import type { GameState, GameAction, DealContract, PriceDemand, FamilyId } from '../engine/types'
import { chatCompletion, loadLLMConfig, isLLMConfigured } from './llmClient'
import { buildDecisionPrompt } from './prompts'
import { DECISION_PROMPTS } from './promptTexts'
import { validateAction, getActingPlayerId, getLegalActions, type LegalActionOption } from '../engine/validator'
import { canPlayerDemand } from '../engine/gameEngine'
import { getFallbackAction, getFallbackSpeech } from './fallbackAI'

export interface AIDecision {
  action: GameAction
  speech: string
}

const SPEECH_MAX_LEN = 120

export async function decideAI(
  state: GameState,
  signal?: AbortSignal,
): Promise<AIDecision | null> {
  const actingId = getActingPlayerId(state)
  const player = state.players.find(p => p.id === actingId)
  if (!player?.isAI) return null

  const legal = getLegalActions(state, actingId)
  if (legal.length === 0) return null

  // 唯一合法动作时没必要请求 LLM：省时间省成本，也避免了"强制动作也要等一次
  // 完整 LLM 往返（含超时）"的糟糕体验——典型例子是 END_GAME_ROLL 阶段永远
  // 只有"掷骰"一个选项。
  if (legal.length === 1) {
    const action = legal[0].action
    return { action, speech: getFallbackSpeech(action, state, actingId) }
  }

  const config = loadLLMConfig()
  if (!isLLMConfigured(config)) {
    return fallbackDecision(state, actingId)
  }

  try {
    const { system, user } = buildDecisionPrompt(state, actingId, legal)
    // 超时不再硬编码 15s/10s，跟随设置面板的"请求超时"，让 thinking 模型
    // 有足够的推理窗口（超时兜底仍由 fallback AI 保证游戏不卡死）。
    const raw = await chatCompletion(config, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { signal, purpose: 'decision' })

    const first = resolveChoice(raw, legal, state)
    if (first) return first

    // 重试：把上一次的原始回复和解析/校验失败的事实一并喂回去（而不是笼统的
    // "上次无效"），并把温度压到 0 换取更稳定、更服从格式要求的输出。
    const retrySystem = `${system}\n${DECISION_PROMPTS.retryHint}\n【你上一次的原始回复】\n${raw.slice(0, 400)}`
    const raw2 = await chatCompletion(config, [
      { role: 'system', content: retrySystem },
      { role: 'user', content: user },
    ], { signal, temperatureOverride: 0, purpose: 'decision-retry' })

    const second = resolveChoice(raw2, legal, state)
    if (second) return second
  } catch (e) {
    if (signal?.aborted) return null // 该回合已过期（组件卸载/状态已推进），不应再抢占式地返回动作
    console.warn('LLM decision failed, using fallback:', e)
  }

  return fallbackDecision(state, actingId)
}

function fallbackDecision(state: GameState, actingId: number): AIDecision | null {
  const action = getFallbackAction(state)
  if (!action) return null
  return { action, speech: getFallbackSpeech(action, state, actingId) }
}

interface ChoiceResponse {
  choice: number
  speech?: string
  payout?: Array<{ playerId: number; amount: number }>
  demand?: { amount: number; familyId?: FamilyId; note?: string }
}

/**
 * 从模型输出里剥离思考痕迹（<think> 块、markdown 代码围栏）后，用括号配对
 * 扫描提取第一个完整的 JSON 对象。贪婪正则在"思考文本里也出现花括号"时
 * 会截出不可解析的片段，这里的状态机扫描对 thinking 模型的输出更可靠。
 */
function extractJsonObject(raw: string): string | null {
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '')
  const start = cleaned.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
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
    else if (ch === '}') {
      depth--
      if (depth === 0) return cleaned.slice(start, i + 1)
    }
  }
  return null
}

function parseChoiceResponse(raw: string): ChoiceResponse | null {
  try {
    const jsonText = extractJsonObject(raw)
    if (!jsonText) return null
    const obj = JSON.parse(jsonText)
    const choice = Number(obj.choice)
    if (!Number.isInteger(choice) || choice < 1) return null
    const payout = Array.isArray(obj.payout)
      ? obj.payout.filter((p: unknown): p is { playerId: number; amount: number } =>
        !!p && typeof p === 'object' &&
        typeof (p as Record<string, unknown>).playerId === 'number' &&
        typeof (p as Record<string, unknown>).amount === 'number',
      )
      : undefined
    const demand = obj.demand && typeof obj.demand === 'object' && typeof obj.demand.amount === 'number'
      ? obj.demand as { amount: number; familyId?: FamilyId; note?: string }
      : undefined
    return {
      choice,
      speech: typeof obj.speech === 'string' ? obj.speech : undefined,
      payout,
      demand,
    }
  } catch {
    return null
  }
}

function resolveChoice(
  raw: string,
  legal: LegalActionOption[],
  state: GameState,
): AIDecision | null {
  const parsed = parseChoiceResponse(raw)
  if (!parsed) return null
  const option = legal[parsed.choice - 1]
  if (!option) return null

  const speechText = (parsed.speech ?? '').trim().slice(0, SPEECH_MAX_LEN)
  let action: GameAction = structuredClone(option.action)

  if (action.type === 'SPEAK') {
    // 合法动作列表里的 SPEAK 模板自带占位符文本 "…"；旧版解析逻辑只在
    // !action.text 时才用 speech 覆盖，而 "…" 是真值，导致模型即便认真填写了
    // speech 字段，玩家最终看到的喊话内容仍然是占位符。这里统一以模型给出的
    // speech 为准。
    action.text = speechText || DECISION_PROMPTS.defaultSpeech
    // 要价资格门槛：没有相关有效代表在场时，模型给的 demand 直接丢弃
    //（引擎侧还有同样的校验兜底，这里提前拦截避免误导性的日志）。
    if (parsed.demand && canPlayerDemand(state, action.playerId)) {
      const demand: PriceDemand = {
        playerId: action.playerId,
        amount: Math.max(0, Math.floor(parsed.demand.amount)),
        familyId: parsed.demand.familyId,
        note: parsed.demand.note,
      }
      action.demand = demand
    }
  }

  if (action.type === 'PROPOSE_CONTRACT' && parsed.payout) {
    const bossId = action.contract.bossPlayerId
    const overriddenPayout: DealContract['payout'] = parsed.payout
      .filter(p => p.playerId !== bossId)
      .map(p => ({ playerId: p.playerId, amount: Math.max(0, Math.floor(p.amount)) }))
    action = { ...action, contract: { ...action.contract, payout: overriddenPayout } }
  }

  if (!validateAction(state, action)) return null
  return { action, speech: speechText || DECISION_PROMPTS.defaultSpeech }
}
