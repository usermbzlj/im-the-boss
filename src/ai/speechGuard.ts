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
const TITLES = '(?:总|先生|女士|老板|律师|老师|叔|哥|姐|boss)'
const MONEY = /(?:\$|＄)?\s*(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万]+?)\s*(百万(?:元)?|千万(?:元)?|万(?:元)?|M(?![a-z]))/gi
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const sentenceKey = (text: string) => text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
const cleanLine = (text: string) => [...text.replace(/\s+/g, ' ').trim()].slice(0, SPEECH_MAX_LEN).join('')
const sentenceAt = (text: string, index: number) => {
  const start = text.slice(0, index).search(/[^。；;！？!?]*$/)
  return text.slice(start).split(/[。；;！？!?]/)[0]
}

/** Buying/countering another representative is free discussion, not our lending commitment. */
function paymentOrReference(text: string): boolean {
  return /我(?:按|愿意|最多|可以|可|只)?[^，。；;]{0,8}(?:付|支付|给你|给您|出钱|买你|借你)/.test(text)
    || /(?:给你|给您|付你|付您|支付给|分给)/.test(text)
    || /(?:你|您|他|她)(?:的|要|报|方才|刚才)|(?:旧|原|刚才|此前)价|要价|(?:按|照).{0,6}(?:报|价)/.test(text)
    || /(?:你|您|请|希望|建议|能否|可否|能不能).{0,10}(?:降|让|压|减)|(?:行不行|如何|太高|太贵|贵了|高了|还价)/.test(text)
    || /预算|建议(?:方案|分成|分配)|方案建议/.test(text)
}

function resultingBoss(state: GameState, action: PlayerAction): number | undefined {
  return action.type === 'PLAY_BOSS' || action.type === 'OPEN_DEAL' ? action.playerId : state.negotiation?.bossId
}

function uniqueSurname(state: GameState, name: string): boolean {
  return state.players.filter(p => p.name[0] === name[0]).length === 1
}

function otherTimeOrHypothesis(text: string): boolean {
  return /上(?:一)?(?:笔|单|次)|刚才|以前|曾经|下(?:一)?(?:笔|单|次)|如果|假如|要是|倘若/.test(text)
}

function roleQualifier(text: string, index: number): boolean {
  const before = text.slice(0, index)
  const clause = before.split(/[，,。；;！？!?]/).at(-1) ?? ''
  // An old price mentioned elsewhere in this sentence does not change the current speaker's role.
  return otherTimeOrHypothesis(clause) || /(?:他说|她说|你说|您说|他们说|原话是)[:：]?["“]?\s*$/.test(before)
}

/** Check explicit identity/address claims; do not infer roles from tone or bargaining targets. */
function wrongBossRole(state: GameState, action: PlayerAction, text: string): boolean {
  const bossId = resultingBoss(state, action)
  if (bossId == null) return false
  for (const player of state.players) {
    const names = uniqueSurname(state, player.name) ? `${escapeRegex(player.name)}|${escapeRegex(player.name[0])}` : escapeRegex(player.name)
    const alias = `(?:${names})\\s*boss`
    for (const match of text.matchAll(new RegExp(alias, 'gi'))) {
      const sentence = sentenceAt(text, match.index!)
      if (roleQualifier(text, match.index!)) continue
      // A takeover may legitimately address the outgoing Boss while demanding that they yield.
      if (action.type === 'PLAY_BOSS' && player.id === state.negotiation?.bossId && /让位|接手|接管|换我|由我/.test(sentence)) continue
      if (player.id !== bossId) return true
      const prefix = text.slice(0, match.index).split(/[，,。；;！？!?]/).at(-1)?.trim() ?? ''
      const after = text.slice(match.index! + match[0].length)
      // "我是顾Boss" is self-identification; "顾Boss，我的价…" is addressing an opponent.
      if (player.id === action.playerId && !prefix && /^[，,:：]|^\s*这[单笔]/.test(after)
        && !/^[，,:：\s]*(?:就是我|是我|由我|本笔由我)/.test(after)) return true
    }
  }
  const claim = /我(?:就是|是|来当|当)\s*boss|boss\s*(?:就是|是|由)\s*我/gi
  if (bossId !== action.playerId && [...text.matchAll(claim)].some(m => {
    const sentence = sentenceAt(text, m.index!)
    return !roleQualifier(text, m.index!) && !/我当\s*boss(?:时|以后|的话)/i.test(sentence)
  })) return true
  if (bossId === action.playerId && /我不是\s*boss/i.test(text) && !otherTimeOrHypothesis(text)) return true
  if (bossId !== action.playerId) return false
  const speaker = state.players[action.playerId]
  const selfName = uniqueSurname(state, speaker.name)
    ? `(?:${escapeRegex(speaker.name)}|${escapeRegex(speaker.name[0])}${TITLES})` : escapeRegex(speaker.name)
  if (new RegExp(`^${selfName}[，,:：].*(?:你|您)(?:方才|刚才|的|先)`, 'i').test(text)) return true
  return /^(?:boss|老板)[，,:：].*(?:给我|分我|我的价|我报价)/i.test(text)
}

function bossBribe(state: GameState, action: PlayerAction, text: string): boolean {
  if (resultingBoss(state, action) !== action.playerId) return false
  for (const sentence of text.split(/[。；;！？!?]/)) {
    if (![...sentence.matchAll(MONEY)].length || /^(?:上一笔|上笔|上次|下一笔|下笔|下次|以前|如果|假如)/.test(sentence.trim())) continue
    if (!/封口费|不干预|不插手|袖手旁观|不搅局|不添乱|不动牌|不翻船|保持中立/.test(sentence)) continue
    if (/不要封口费|不(?:收|要)封口费|不是封口费|无需封口费/.test(sentence)) continue
    if (/(?:净得|收益|我保留|我留)/.test(sentence) && !/对价|换我|封口费|给我|分我/.test(sentence)) continue
    const other = namedPlayer(state, sentence)
    // A Boss can pay someone else for staying quiet, or quote what they said.
    if (other != null && other !== action.playerId && /(?:你|您|他|她)(?:不|的|要|说)|(?:给|付|分给|报价|原话|说)/.test(sentence)
      && !/换我|给我|分我|我的封口费/.test(sentence)) continue
    if (/我(?:愿意|可以|会)?(?:不干预|不插手|不搅局|不添乱|不动牌|不翻船|袖手旁观|保持中立)|换我|给我|分我|我的封口费/.test(sentence)) return true
    if (other == null || other === action.playerId) return true
  }
  return false
}

function foreignRepresentative(state: GameState, action: PlayerAction, text: string): boolean {
  if (action.type !== 'SPEAK' && action.type !== 'DECLINE_OFFER' && action.type !== 'PLAY_CLAN') return false
  const mine = new Set(playerRelevantFamilies(state, action.playerId))
  const privateClans = new Set(state.players[action.playerId]?.hand.filter(c => c.type === 'CLAN').map(c => c.familyId))
  if (action.type === 'PLAY_CLAN') {
    const family = state.players[action.playerId]?.hand.find(c => c.id === action.cardId)?.familyId
    if (family) mine.add(family)
  }
  for (const family of FAMILY_IDS) {
    if (mine.has(family)) continue
    const label = escapeRegex(FAMILIES[family].name)
    const ownership = new RegExp(`我的\\s*${label}|我(?:持有|代表|有)\\s*${label}|${label}(?:的(?:代表|人|投资者))?\\s*(?:是我的|在我手里|归我|我(?:出人|派人|有|持有))`)
    for (const sentence of text.split(/[。；;！？!?]/)) {
      if (!ownership.test(sentence)) continue
      // A real card in one's own hand may be disclosed; it is not yet a played representative.
      const disclosure = action.type === 'SPEAK' && !action.quotes?.length && privateClans.has(family)
        && /成员牌|成员卡|家族牌|家族卡/.test(sentence)
        && !/我的.{0,6}(?:代表|投资者)|我代表|出借|付到(?:即|就|便)|我(?:就|才)?同意/.test(sentence)
      if (!disclosure) return true
    }
  }
  for (const match of text.matchAll(MONEY)) {
    const before = text.slice(0, match.index).split(/[，,。；;！？!?、]/).at(-1) ?? ''
    const after = text.slice(match.index! + match[0].length).split(/[，,。；;！？!?、]/)[0]
    const clause = `${before}${after}`
    const family = FAMILY_IDS.find(f => clause.includes(FAMILIES[f].name)
      || new RegExp(`(?:^|[^A-Za-z])${f}\\s*[:：]?\\s*$`, 'i').test(before))
    if (!family || mine.has(family)) continue
    const sentence = sentenceAt(text, match.index!)
    const named = namedPlayer(state, clause)
    if ((named != null && named !== action.playerId) || paymentOrReference(sentence)) continue
    // A terse family+sum in a lending action claims that family; explicit loan promises do too.
    if (('quotes' in action && action.quotes?.length && mine.size > 0 && resultingBoss(state, action) !== action.playerId)
      || /付到(?:即|就|便)|少一分|不让价|一分不让|我(?:就|才)?同意|我出人/.test(clause)) return true
  }
  return false
}

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
    return !surnamePresent && new RegExp(`${surname}${TITLES}`, 'i').test(text)
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
  // A Boss's speech may negotiate payments, but it is not a representative lending price.
  if (action.type === 'SPEAK' && neg?.bossId === action.playerId) return facts
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
    const title = uniqueSurname(state, player.name)
      ? [...text.matchAll(new RegExp(`${escapeRegex(player.name[0])}${TITLES}`, 'gi'))].at(-1)?.index ?? -1 : -1
    const index = Math.max(full, title)
    if (index > last) { last = index; id = player.id }
  }
  const boss = [...text.matchAll(/(?:^|[\s，,。:：;；！？!?])boss(?=$|[^A-Za-z])/gi)].at(-1)
  if (boss && boss.index! >= last && state.negotiation) id = state.negotiation.bossId
  return id
}

function wrongMoney(state: GameState, action: PlayerAction, text: string): boolean {
  const facts = moneyFacts(state, action)
  for (const match of text.matchAll(MONEY)) {
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
    if (facts.quotes && /我(?:按|愿意|最多|可以|可|只)?[^，。；;]{0,8}(?:付|支付|给你|给您|出钱|买你|借你)|(?:给你|给您|付你|付您|支付给|分给)/.test(clause)) continue
    if (facts.quotes && /(?:旧价|原价|此前报价|刚才报价|(?:你|您|他|她)(?:的|方才的|刚才的)?(?:报|要)价)[^，。]{0,4}$/.test(before)) continue
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
    && !unknownPlayer(state, line) && !wrongBossRole(state, action, line) && !bossBribe(state, action, line)
    && !foreignRepresentative(state, action, line) && !falseMissingClaim(state, line) && !wrongMoney(state, action, line)
  const line = cleanLine(speech)
  if (!corrected && valid(line)) return line
  const fallback = cleanLine(heuristicSpeech(state, action))
  if (valid(fallback)) return fallback
  return factualLines(state, action).map(cleanLine).find(valid)
}
