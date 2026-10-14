// A small guard for facts we can verify from the final action. It deliberately
// does not interpret threats, jokes, bargaining history, or general sentiment.
import type { FamilyId, GameState, PlayerAction } from '../engine/types'
import { AI_ROSTER, FAMILY_IDS, FAMILIES } from '../engine/config'
import {
  buyCardsCost, demandOf, familiesSatisfy, getCurrentSpace, getGrossValue, grossValueOf,
  playerRelevantFamilies, resolveQuotes, settlePayouts, tableCanComplete, tradeCost, usedFamiliesOf,
} from '../engine/rules'
import { heuristicSpeech } from './heuristic'
import { SPEECH_MAX_LEN } from '../prompts'

const SILENT = new Set<PlayerAction['type']>([
  'PASS', 'PASS_CLOSING', 'PASS_REACTION', 'ROLL_MOVE', 'DRAW_CARDS', 'ROLL_END',
])
const TITLES = '(?:总|先生|女士|老板|律师|老师|叔|哥|姐)'
const sentenceKey = (text: string) => text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
const cleanLine = (text: string) => [...text.replace(/\s+/g, ' ').trim()].slice(0, SPEECH_MAX_LEN).join('')

function repeated(state: GameState, actorId: number, text: string): boolean {
  const speeches = state.negotiation?.speeches ?? []
  const key = sentenceKey(text)
  if (!key) return true
  return speeches.some(s => s.playerId === actorId && sentenceKey(s.text) === key)
    || (speeches.at(-1)?.playerId !== actorId && sentenceKey(speeches.at(-1)?.text ?? '') === key)
}

function unknownPlayer(state: GameState, text: string): boolean {
  return AI_ROSTER.some(({ name }) => {
    const fullNamePresent = state.players.some(p => p.name.includes(name))
    if (!fullNamePresent && text.includes(name)) return true
    const surname = name[0]
    const surnamePresent = state.players.some(p => p.name.startsWith(surname) || p.name.includes(name))
    return !surnamePresent && new RegExp(`${surname}${TITLES}`).test(text)
  })
}

/** Only public investors / played representatives count; opponents' hands are never read. */
function falseMissingClaim(state: GameState, text: string): boolean {
  const space = getCurrentSpace(state)
  if (!space) return false
  const complete = state.negotiation ? tableCanComplete(state)
    : familiesSatisfy(space, state.investors.filter(i => i.ownerId != null).map(i => i.familyId))
  if (!complete) return false
  const claims = text.matchAll(/(?:桌上|这一格|这格|本格|当前格|这一单|这单|本单)([^，。；;！？!?]{0,12})(?:凑不齐|凑不够|人手不齐|代表不齐)/g)
  return [...claims].some(m => !/(?:我|自己|手里|这边|我方)/.test(m[1]))
}

function chineseNumber(text: string): number | undefined {
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text)
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 }
  let total = 0, section = 0, digit = 0
  for (const char of text) {
    if (char in digits) digit = digits[char]
    else if (char in units) {
      const unit = units[char]
      if (unit === 10000) { total += (section + digit) * unit; section = 0 }
      else section += (digit || 1) * unit
      digit = 0
    } else return undefined
  }
  return total + section + digit
}

interface MoneyFacts {
  family: Map<FamilyId, number>
  scope: Set<FamilyId>
  own: number[]
  payees: Map<number, number> | null
  quotes: boolean
  gross: number
}

function moneyFacts(state: GameState, action: PlayerAction): MoneyFacts {
  const neg = state.negotiation
  const facts: MoneyFacts = { family: new Map(), scope: new Set(), own: [], payees: null, quotes: false, gross: getGrossValue(state) }
  if (action.type === 'PLACE_MARKER') {
    const space = state.board.find(s => s.id === action.spaceId)
    if (space) facts.gross = grossValueOf(state, space)
  }
  if (action.type === 'SPEAK' || action.type === 'DECLINE_OFFER') {
    facts.quotes = true
    const scope = action.type === 'DECLINE_OFFER' && neg?.offer
      ? usedFamiliesOf(neg, neg.offer, action.playerId) : playerRelevantFamilies(state, action.playerId)
    facts.scope = new Set(scope)
    for (const family of scope) {
      const price = neg ? demandOf(neg, action.playerId, family) : undefined
      if (price != null) facts.family.set(family, price)
    }
    for (const quote of resolveQuotes(action.quotes ?? [], scope)) {
      for (const family of quote.familyIds) facts.family.set(family, quote.amount)
      if (!quote.familyIds.length) facts.own.push(quote.amount)
    }
    if (!scope.length && !facts.own.length && neg) {
      const price = demandOf(neg, action.playerId)
      if (price != null) facts.own.push(price)
    }
    facts.own.push(...facts.family.values())
  } else if (action.type === 'PLAY_CLAN') {
    facts.quotes = true
    const family = state.players[action.playerId]?.hand.find(c => c.id === action.cardId)?.familyId
    if (family) facts.scope.add(family)
    if (action.demand != null) {
      if (family) facts.family.set(family, action.demand)
      facts.own.push(action.demand)
    }
  } else if (action.type === 'PROPOSE_OFFER') {
    facts.payees = new Map(action.payouts.map(p => [p.playerId, p.amount]))
    facts.own = [Math.max(0, facts.gross - action.payouts.reduce((sum, p) => sum + p.amount, 0))]
  } else if ((action.type === 'ACCEPT_OFFER' || action.type === 'CLOSE_DEAL') && neg?.offer) {
    const paid = settlePayouts(neg.offer.payouts, facts.gross, neg.bossId)
    facts.payees = new Map(paid.map(p => [p.playerId, p.amount]))
    facts.payees.set(neg.bossId, facts.gross - paid.reduce((sum, p) => sum + p.amount, 0))
    facts.own = [facts.payees.get(action.playerId) ?? 0]
  } else if (action.type === 'BUY_CARDS') facts.own = [buyCardsCost(state, action.count)]
  else if (action.type === 'TRADE_CARDS') facts.own = [tradeCost(state)]
  return facts
}

/** A name directly next to a sum identifies the payee; honorifics use an existing surname only. */
function namedPlayer(state: GameState, text: string): number | undefined {
  let last = -1, id: number | undefined
  for (const player of state.players) {
    const full = text.lastIndexOf(player.name)
    const title = [...text.matchAll(new RegExp(`${player.name[0]}${TITLES}`, 'g'))].at(-1)?.index ?? -1
    const index = Math.max(full, title)
    if (index > last) { last = index; id = player.id }
  }
  return id
}

function wrongMoney(state: GameState, action: PlayerAction, text: string): boolean {
  const facts = moneyFacts(state, action)
  const money = /(?:\$|＄)?\s*(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万]+?)\s*(百万(?:元)?|千万(?:元)?|万(?:元)?|M(?![a-z]))/gi
  for (const match of text.matchAll(money)) {
    const raw = chineseNumber(match[1])
    if (raw == null) continue
    const amount = raw * (match[2].startsWith('千万') ? 10 : match[2].startsWith('万') ? 0.01 : 1)
    const before = text.slice(0, match.index).split(/[，,。；;！？!?、]/).at(-1) ?? ''
    const after = text.slice(match.index! + match[0].length).split(/[，,。；;！？!?、]/)[0]
    const clause = `${before}${after}`
    if (/(?:总额|总共|这单值|盘子|交易额)[^，。]{0,8}$/.test(before)) {
      if (amount !== facts.gross) return true
      continue
    }
    const name = namedPlayer(state, before) ?? namedPlayer(state, after)
    const self = /(?:我(?:的|要|拿|得|收|留|出|这边|净得|到手|报价)|给我|分我)/.test(clause)
    if (name != null && name !== action.playerId && !self) {
      if (facts.payees && amount !== (facts.payees.get(name) ?? 0)) return true
      continue // Quoting another player's ask is allowed; it is not our own commitment.
    }
    const family = FAMILY_IDS.find(f => clause.includes(FAMILIES[f].name)
      || new RegExp(`(?:^|[^A-Za-z])${f}(?:$|[^A-Za-z])`, 'i').test(before))
    if (family && facts.scope.has(family)) {
      if (amount !== facts.family.get(family)) return true
      continue
    }
    if (facts.quotes && (family == null || self)) {
      if (!facts.own.includes(amount)) return true
      if (/每(?:个|家|位)|统一|全部同价/.test(clause) && new Set(facts.own).size > 1) return true
    } else if ((self || name === action.playerId) && facts.own.length && !facts.own.includes(amount)) return true
  }
  return false
}

function factualLines(state: GameState, action: PlayerAction): string[] {
  const facts = moneyFacts(state, action)
  const quote = [...facts.family].map(([f, amount]) => `${FAMILIES[f].name} $${amount}M`).join('、')
    || (facts.quotes && facts.own.length ? `$${facts.own[0]}M` : '')
  if (facts.quotes && quote) return [`${quote}，付到就同意。`, `我的条件：${quote}。`, `${quote}，请考虑。`, `照这个价：${quote}。`, `${quote}，这是本笔的报价。`]
  if (action.type === 'PLAY_CLAN') {
    const family = state.players[action.playerId]?.hand.find(c => c.id === action.cardId)?.familyId
    if (family) return [`我派出${FAMILIES[family].name}的代表。`, `${FAMILIES[family].name}的人我带来了。`]
  }
  const lead = action.type === 'PROPOSE_OFFER' ? '这份方案请各位表态。'
    : action.type === 'DECLINE_OFFER' ? '这份方案我不同意。'
      : action.type === 'ACCEPT_OFFER' ? '这份方案我同意。'
        : action.type === 'CLOSE_DEAL' ? '就按这份方案成交。'
          : action.type === 'ABANDON_DEAL' ? '这笔交易我放弃。'
            : action.type === 'OPEN_DEAL' ? '这一格我来发起交易。' : '我的决定在这里，诸位请。'
  return [lead, '条件我说清楚了，诸位斟酌。', '各位还有什么打算？', '这一笔，咱们接着谈。', '我先听听各位的条件。', '这笔先按眼前的局面来。']
}

/** Run after parsing/repairing the final legal action, never before its amounts are known. */
export function actionSpeech(state: GameState, action: PlayerAction, speech: string, corrected = false): string | undefined {
  if (SILENT.has(action.type)) return undefined
  const valid = (line: string) => !!line && !repeated(state, action.playerId, line)
    && !unknownPlayer(state, line) && !falseMissingClaim(state, line) && !wrongMoney(state, action, line)
  const line = cleanLine(speech)
  if (!corrected && valid(line)) return line
  const fallback = cleanLine(heuristicSpeech(state, action))
  if (valid(fallback)) return fallback
  return factualLines(state, action).map(cleanLine).find(valid)
}
