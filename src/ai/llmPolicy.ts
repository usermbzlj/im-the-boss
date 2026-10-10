// ============================================================
// LLM 策略 — "按编号选择"协议
//
// 合法动作由 validator 枚举、经 prompts.pruneForLLM 剪枝并附上后果注释后编号成列表；
// 模型回复序号，用 speech / demand / payouts / cardIds 定台词、金额或选牌，
// 可附 thought（内心盘算，不公开，随动作写进动作日志供复盘）与 note（写给下回合自己的私人笔记，存入 Player.notes）。
// 解析出的动作必须通过 isLegal，否则重试一次；仍失败返回 null，
// 由上层（aiPolicy 的混合策略）交给启发式——LLM 永远不会让游戏卡住。
// 这里只管"一次 LLM 决策"；要不要请求（决策分级）、熔断、回退与状态上报在 aiPolicy.ts。
// ============================================================

import type { GameState, Negotiation, PlayerAction, Payout, FamilyId, Quote } from '../engine/types'
import { FAMILY_IDS, FAMILIES } from '../engine/config'
import { chatCompletion, isLLMConfigured, type LLMConfig } from './llmClient'
import { buildDecisionPrompt } from './prompts'
import { RETRY_HINT, SPEECH_MAX_LEN, NOTE_MAX_LEN, THOUGHT_MAX_LEN } from '../prompts'
import { promptNames } from './sanitize'
import type { TableStyle } from './tableStyle'
import { getActingPlayerId, getLegalActions, isLegal } from '../engine/validator'
import { getGrossValue, offerOwners, hasDemand, playerRelevantFamilies, usedFamiliesOf } from '../engine/rules'
import { heuristicSpeech } from './heuristic'
import type { Policy } from './policy'

/**
 * 向模型请求一次决策（含一次"回复无法解析"的重试）。
 * 返回 null = 模型回复了但没给出合法动作；网络错误 / 超时 / 取消直接抛出（调用方按 classifyLLMError 归类）。
 * 编号列表是剪枝后的 options（去掉自伤 / 冗余项），落成动作也必须用同一份列表。
 */
export async function decideWithLLM(
  state: GameState, actingId: number, legal: PlayerAction[], config: LLMConfig, signal: AbortSignal,
  opts: { style?: TableStyle } = {},
): Promise<PlayerAction | null> {
  const { system, user, options } = buildDecisionPrompt(state, actingId, legal, { style: opts.style })
  if (options.length === 1) return { ...options[0], say: heuristicSpeech(state, options[0]) || undefined }
  const raw = await chatCompletion(config, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], { signal, purpose: 'decision' })
  const first = resolveChoice(raw, options, state)
  if (first) return first

  const retrySystem = `${system}\n${RETRY_HINT}\n【你上一次的原始回复】\n${raw.slice(0, 400)}`
  const raw2 = await chatCompletion(config, [
    { role: 'system', content: retrySystem },
    { role: 'user', content: user },
  ], { signal, temperatureOverride: 0, purpose: 'decision-retry' })
  return resolveChoice(raw2, options, state)
}

/**
 * 纯 LLM 策略：每个有选择的决策都请求模型（失败返回 null / 抛出，交给 withFallback）。
 * 游戏里实际用的是 aiPolicy.createAiPolicy（分级 + 熔断 + 人物化兜底）；这个保留给只想要"裸 LLM"的场合与测试。
 */
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
      return decideWithLLM(state, actingId, legal, config, signal, { style: config.tableStyle })
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
  /**
   * 报价（每个代表）：由 demand 字段解析而来——数字 = 通用价；对象 {"B":3,"D":1,"*":2} = 按家族分别报价
   * （"*" 为其余家族的默认价）；也接受 [{family,amount}] 数组与旧的 {amount,family} / demandFamily 写法
   */
  quotes?: Quote[]
  payouts?: RawPayout[]
  cardIds?: number[]
  /** 写给下回合自己的私人笔记 */
  note?: string
  /** 内心盘算（不公开；保留到动作负载供复盘） */
  thought?: string
}

const GENERAL_KEYS = new Set(['*', 'all', 'default', 'other', 'others', 'rest', '其他', '其余', '全部', '默认'])

/** 家族键：字母 A–F（不分大小写、允许 "B·赤岩集团" 这类带说明的写法）或家族中文名 */
function toFamilyId(v: unknown): FamilyId | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  if (!s) return undefined
  const letter = s.charAt(0).toUpperCase()
  if ((FAMILY_IDS as readonly string[]).includes(letter) && (s.length === 1 || !/^[A-Za-z]/.test(s.slice(1)))) return letter as FamilyId
  return FAMILY_IDS.find(f => s.includes(FAMILIES[f].name))
}

/** 把模型五花八门的 demand 写法统一成 Quote[]；解析不出任何有效条目返回 undefined */
export function parseQuotes(demand: unknown, demandFamily?: unknown): Quote[] | undefined {
  const out: Quote[] = []
  const push = (familyId: FamilyId | undefined, amount: number | undefined) => {
    if (amount == null) return
    if (out.some(q => q.familyId === familyId)) return // 同一家族取第一条
    out.push(familyId == null ? { amount } : { familyId, amount })
  }
  /** 对象键 → 家族 / 通用价；认不出的键跳过 */
  const fromMap = (rec: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(rec)) {
      if (GENERAL_KEYS.has(k.trim().toLowerCase())) push(undefined, toInt(v))
      else {
        const fam = toFamilyId(k)
        if (fam) push(fam, toInt(v))
      }
    }
  }
  const single = toInt(demand)
  if (single != null) push(toFamilyId(demandFamily), single)
  else if (Array.isArray(demand)) {
    for (const item of demand) {
      if (!item || typeof item !== 'object') continue
      const rec = item as Record<string, unknown>
      if ('amount' in rec) push(toFamilyId(rec.family ?? rec.familyId), toInt(rec.amount))
      else fromMap(rec)
    }
  } else if (demand && typeof demand === 'object') {
    const rec = demand as Record<string, unknown>
    if ('amount' in rec) push(toFamilyId(rec.family ?? rec.familyId ?? demandFamily), toInt(rec.amount))
    else fromMap(rec)
  }
  return out.length ? out : undefined
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
    const quotes = parseQuotes(obj.demand ?? obj.quotes ?? obj.counter, obj.demandFamily ?? obj.family)
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
    const thought = typeof obj.thought === 'string' && obj.thought.trim() ? obj.thought.trim() : undefined
    return { choice, speech: typeof obj.speech === 'string' ? obj.speech : undefined, quotes, payouts, cardIds, note, thought }
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

  // 台词压成单行再按提示词里承诺的长度截断（提示词写 ≤SPEECH_MAX_LEN，这里就按它截）
  const speech = [...restoreNames(state, (parsed.speech ?? '').replace(/\s+/g, ' ').trim())].slice(0, SPEECH_MAX_LEN).join('')
  const gross = getGrossValue(state)
  const clamp = (d: number) => Math.max(0, Math.min(gross, d))
  /** 只保留作用域内的家族条目与通用价（模型写错的家族直接丢掉，其余照常生效） */
  const scoped = (scope: FamilyId[]): Quote[] | undefined => {
    const kept = (parsed.quotes ?? [])
      .filter(q => q.familyId == null || scope.includes(q.familyId))
      .map(q => ({ ...q, amount: clamp(q.amount) }))
    return kept.length ? kept : undefined
  }
  let action: PlayerAction = structuredClone(option)

  switch (action.type) {
    case 'SPEAK': {
      const quotes = scoped(playerRelevantFamilies(state, action.playerId))
      if (quotes) action.quotes = quotes
      // 模型没给台词：用该人物的台词库按最终报价说一句，不再显示"…"
      action.say = speech || heuristicSpeech(state, action) || undefined
      break
    }
    case 'PLAY_CLAN': {
      // 这张卡的家族有单独报价就用它，否则用通用价
      const { playerId, cardId } = action
      const fam = state.players[playerId]?.hand.find(c => c.id === cardId)?.familyId
      const q = parsed.quotes?.find(x => x.familyId === fam) ?? parsed.quotes?.find(x => x.familyId == null)
      if (q) action.demand = clamp(q.amount)
      break
    }
    case 'DECLINE_OFFER': {
      const neg = state.negotiation
      const quotes = neg?.offer ? scoped(usedFamiliesOf(neg, neg.offer, action.playerId)) : undefined
      if (quotes) action.quotes = quotes
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
    case 'DISCARD':
    case 'TRADE_CARDS': {
      // 弃牌 / 兑换：模型可自选牌；选得不合法就沿用默认选牌
      if (parsed.cardIds) {
        const candidate: PlayerAction = { ...action, cardIds: parsed.cardIds }
        if (isLegal(state, candidate)) action = candidate
      }
      break
    }
  }

  if (action.type !== 'SPEAK') action.say = speech || heuristicSpeech(state, action) || undefined
  if (parsed.note) action.note = [...parsed.note.replace(/\s+/g, ' ')].slice(0, NOTE_MAX_LEN).join('')
  if (parsed.thought) action.thought = [...parsed.thought.replace(/\s+/g, ' ')].slice(0, THOUGHT_MAX_LEN * 2).join('')
  return isLegal(state, action) ? action : null
}

/** 台词里模型用的是提示词里的替身名（见 sanitize.promptNames）：上桌前换回玩家的真实名字 */
export function restoreNames(state: GameState, text: string): string {
  const names = promptNames(state.players)
  return state.players
    .filter(p => names[p.id] !== p.name)
    .sort((a, b) => names[b.id].length - names[a.id].length)
    .reduce((t, p) => t.split(names[p.id]).join(p.name), text)
}

/** 把"玩家 ID 或玩家名"落成 ID；任一条目无法唯一对应则整组放弃（调用方沿用候选方案的分成） */
export function resolvePayees(state: GameState, raw: RawPayout[]): Payout[] | null {
  const out: Payout[] = []
  for (const p of raw) {
    let id: number | undefined
    if (typeof p.playerId === 'number') id = state.players[p.playerId] ? p.playerId : undefined
    else {
      // 模型看到的是净化后的名字（见 sanitize.promptView），两种写法都认
      const names = promptNames(state.players)
      const matches = state.players.filter(pl => pl.name === p.playerId || names[pl.id] === p.playerId)
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
