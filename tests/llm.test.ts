// LLM 策略的"按编号选择"协议：解析容错 + 落成合法动作 + 失败时安全兜底
// 以及提示词工程：剪枝、后果注释、局势摘要、角色卡、私人笔记

import { describe, it, expect } from 'vitest'
import { extractJsonObject, parseChoiceResponse, parseQuotes, resolveChoice, createLLMPolicy } from '../src/ai/llmPolicy'
import { buildDecisionPrompt, pruneForLLM, annotateOption } from '../src/ai/prompts'
import { getActingPlayerId, getLegalActions } from '../src/engine/validator'
import { investorRepKey, clanRepKey, demandOf } from '../src/engine/rules'
import { withFallback } from '../src/ai/policy'
import { DEFAULT_LLM_CONFIG } from '../src/ai/llmClient'
import { heuristicPolicy } from '../src/ai/heuristic'
import { PERSONAS, PERSONA_IDS, getPersonaForPlayer } from '../src/ai/personas'
import { AI_ROSTER } from '../src/engine/config'
import { SPEECH_MAX_LEN, NOTE_MAX_LEN } from '../src/prompts'
import { baseState, setInvestors, openDealAt, step, clearHand, giveCards, toBoss } from './helpers'

describe('回复解析', () => {
  it('能从 <think>、代码围栏、前后废话中抠出第一个 JSON 对象', () => {
    expect(extractJsonObject('<think>先想想{}</think>好的：```json\n{"choice": 2, "speech": "成交}"}\n```')).toBe('{"choice": 2, "speech": "成交}"}')
    expect(extractJsonObject('没有 json')).toBeNull()
    expect(extractJsonObject('{"a": {"b": 1}} 尾巴 {"c": 2}')).toBe('{"a": {"b": 1}}')
    expect(extractJsonObject('{"未闭合": 1')).toBeNull()
  })

  it('字段宽容：字符串数字、demand 对象、payout 单数、收款人可为名字', () => {
    expect(parseChoiceResponse('{"choice": "3", "demand": {"amount": "2"}, "payout": [{"playerId": "1", "amount": 2}, {"player": "钱多多", "amount": "1"}]}'))
      .toEqual({ choice: 3, speech: undefined, quotes: [{ amount: 2 }], payouts: [{ playerId: 1, amount: 2 }, { playerId: '钱多多', amount: 1 }], cardIds: undefined, note: undefined })
    expect(parseChoiceResponse('{"choice": 0}')).toBeNull()
    expect(parseChoiceResponse('{"speech": "没选"}')).toBeNull()
    expect(parseChoiceResponse('{"choice": 1, "cardIds": [3, "4"]}')!.cardIds).toEqual([3, 4])
    expect(parseChoiceResponse('{"choice": 1, "cardIds": [3, "4", null, "x"]}')!.cardIds).toBeUndefined()
  })

  it('分成条目任一残缺 → 整组作废，而不是悄悄丢掉那一条', () => {
    expect(parseChoiceResponse('{"choice": 1, "payouts": [{"playerId": 1, "amount": 2}, {"playerId": 2}]}')!.payouts).toBeUndefined()
    expect(parseChoiceResponse('{"choice": 1, "payouts": [{"amount": 2}]}')!.payouts).toBeUndefined()
    expect(parseChoiceResponse('{"choice": 1, "payouts": []}')!.payouts).toBeUndefined()
  })
})

describe('落成动作', () => {
  function bossTurn() {
    let s = baseState(4, 31)
    setInvestors(s, { A: 0, B: 1, C: 2, D: 3 })
    s = toBoss(openDealAt(s, 1, 0))
    return s
  }

  it('序号越界 / 解析失败 → null；合法跳过保持沉默', () => {
    const s = bossTurn()
    const legal = getLegalActions(s, 0)
    expect(resolveChoice('胡言乱语', legal, s)).toBeNull()
    expect(resolveChoice(`{"choice": ${legal.length + 1}}`, legal, s)).toBeNull()
    const idx = legal.findIndex(a => a.type === 'PASS')
    const a = resolveChoice(`{"choice": ${idx + 1}, "speech": "  你们先谈  "}`, legal, s)!
    expect(a.type).toBe('PASS')
    expect(a.say).toBeUndefined()
  })

  it('非Boss SPEAK 可附带要价（被夹到 [0, 总额]），无内容时用默认台词', () => {
    const s = step(bossTurn(), { type: 'PASS', playerId: 0 })
    const legal = getLegalActions(s, 1)
    const idx = legal.findIndex(a => a.type === 'SPEAK')
    const a = resolveChoice(`{"choice": ${idx + 1}, "demand": 99}`, legal, s)!
    expect(a.type).toBe('SPEAK')
    expect(a.type === 'SPEAK' && a.quotes).toEqual([{ amount: 6 }])
    expect(a.say!.length).toBeGreaterThan(0)
    const b = resolveChoice(`{"choice": ${idx + 1}, "demand": -5, "speech": "${'长'.repeat(200)}"}`, legal, s)!
    expect(b.type === 'SPEAK' && b.quotes).toEqual([{ amount: 0 }])
    expect(b.say!.length).toBeLessThanOrEqual(SPEECH_MAX_LEN)
    expect(b.say).not.toContain('长') // 报价夹取后用实际动作台词，不保留原承诺
  })

  it('没给台词时不显示占位符"…"：用该人物的台词库，且与最终报价一致', () => {
    const s = step(bossTurn(), { type: 'PASS', playerId: 0 })
    const legal = getLegalActions(s, 1)
    const idx = legal.findIndex(a => a.type === 'SPEAK')
    const a = resolveChoice(`{"choice": ${idx + 1}, "demand": 3}`, legal, s)!
    expect(a.say).toBeTruthy()
    expect(a.say).not.toBe('…')
    expect(a.say!.trim().length).toBeGreaterThan(1)
  })

  it('demand 的各种写法都能解析成按家族的报价', () => {
    expect(parseQuotes(3)).toEqual([{ amount: 3 }])
    expect(parseQuotes('3')).toEqual([{ amount: 3 }])
    expect(parseQuotes(3, 'B')).toEqual([{ familyId: 'B', amount: 3 }])           // 旧写法 demand + demandFamily
    expect(parseQuotes({ B: 3, D: 1 })).toEqual([{ familyId: 'B', amount: 3 }, { familyId: 'D', amount: 1 }])
    expect(parseQuotes({ b: 3, '*': 2 })).toEqual([{ familyId: 'B', amount: 3 }, { amount: 2 }])   // 小写字母、"*" 默认价
    expect(parseQuotes({ 'B·赤岩集团': 3, 其他: 1 })).toEqual([{ familyId: 'B', amount: 3 }, { amount: 1 }])
    expect(parseQuotes({ 赤岩集团: 3 })).toEqual([{ familyId: 'B', amount: 3 }])   // 家族中文名
    expect(parseQuotes({ amount: 3, family: 'C' })).toEqual([{ familyId: 'C', amount: 3 }])
    expect(parseQuotes([{ family: 'B', amount: 3 }, { family: 'C', amount: 1 }])).toEqual([{ familyId: 'B', amount: 3 }, { familyId: 'C', amount: 1 }])
    expect(parseQuotes({ B: 3, b: 5 })).toEqual([{ familyId: 'B', amount: 3 }])   // 同一家族取第一条
    expect(parseQuotes({ Boss: 3, xyz: 1 })).toBeUndefined()                        // 认不出的键全部跳过
    expect(parseQuotes(null)).toBeUndefined()
    expect(parseQuotes('随便')).toBeUndefined()
  })

  it('多家族玩家用对象 demand 一次报完各家的价；写错的家族丢掉，其余照常生效', () => {
    let s = baseState(4, 39)
    setInvestors(s, { A: 0, B: 1, C: 1, D: 3 }) // 玩家 1 同时持有 B、C
    s.board[0].groups = [{ families: ['A', 'B', 'C'], need: 3 }]; s.board[0].dividends = 4
    s = openDealAt(s, 1, 0)
    expect(getActingPlayerId(s)).toBe(1)
    const legal = getLegalActions(s, 1)
    const idx = legal.findIndex(a => a.type === 'SPEAK')
    const a = resolveChoice(`{"choice": ${idx + 1}, "speech": "B 4、C 1", "demand": {"B": 4, "C": 1, "D": 9}}`, legal, s)!
    expect(a.type === 'SPEAK' && a.quotes).toEqual([{ familyId: 'B', amount: 4 }, { familyId: 'C', amount: 1 }]) // D 与他无关，丢掉
    const after = step(s, a)
    expect(demandOf(after.negotiation!, 1, 'B')).toBe(4)
    expect(demandOf(after.negotiation!, 1, 'C')).toBe(1)
    expect(after.negotiation!.speakCounts[1]).toBe(1)
    // 提示词里说明可以按家族分别报价
    const prompt = buildDecisionPrompt(s, 1, legal).user
    expect(prompt).toContain('不同家族可报不同价')
    expect(prompt).toMatch(/\{"[BC]":\d+,"[BC]":\d+\}/) // 示例按他的两个家族写

    // 拒绝时也可按方案所用的家族分别反报价
    let t = toBoss(s)
    t = step(t, { type: 'PROPOSE_OFFER', playerId: 0, repKeys: [investorRepKey('A'), investorRepKey('B'), investorRepKey('C')], payouts: [{ playerId: 1, amount: 1 }] })
    const legal2 = getLegalActions(t, 1)
    const di = legal2.findIndex(x => x.type === 'DECLINE_OFFER')
    const d = resolveChoice(`{"choice": ${di + 1}, "demand": {"B": 3, "C": 2}}`, legal2, t)!
    expect(d.type === 'DECLINE_OFFER' && d.quotes).toEqual([{ familyId: 'B', amount: 3 }, { familyId: 'C', amount: 2 }])
    const declined = step(t, d)
    expect(demandOf(declined.negotiation!, 1, 'B')).toBe(3)
    expect(demandOf(declined.negotiation!, 1, 'C')).toBe(2)
  })

  it('PROPOSE_OFFER 的自定义分成合法则采用，非法则退回候选方案', () => {
    const s = bossTurn()
    const legal = getLegalActions(s, 0)
    const idx = legal.findIndex(a => a.type === 'PROPOSE_OFFER' && a.payouts.length > 0)
    const good = resolveChoice(`{"choice": ${idx + 1}, "payouts": [{"playerId": 1, "amount": 4}]}`, legal, s)!
    expect(good.type === 'PROPOSE_OFFER' && good.payouts).toEqual([{ playerId: 1, amount: 4 }])
    const bad = resolveChoice(`{"choice": ${idx + 1}, "payouts": [{"playerId": 1, "amount": 40}]}`, legal, s)!
    expect(bad.type === 'PROPOSE_OFFER' && bad.payouts).toEqual((legal[idx] as { payouts: unknown }).payouts)
    // 给 Boss 自己分钱的条目会被剔除
    const self = resolveChoice(`{"choice": ${idx + 1}, "payouts": [{"playerId": 0, "amount": 2}, {"playerId": 1, "amount": 1}]}`, legal, s)!
    expect(self.type === 'PROPOSE_OFFER' && self.payouts).toEqual([{ playerId: 1, amount: 1 }])
  })

  it('PROPOSE_OFFER 分成：收款人可写名字；写错对象或付给旁观者则沿用候选方案', () => {
    // #1 需要 A+B：Boss 0 自有 A，B 的持有者是 1；2、3 是与方案无关的旁观者
    const s = bossTurn()
    const legal = getLegalActions(s, 0)
    const idx = legal.findIndex(a => a.type === 'PROPOSE_OFFER' && a.payouts.length > 0)
    const original = (legal[idx] as { payouts: unknown }).payouts

    const byName = resolveChoice(`{"choice": ${idx + 1}, "payouts": [{"playerId": "${s.players[1].name}", "amount": 3}]}`, legal, s)!
    expect(byName.type === 'PROPOSE_OFFER' && byName.payouts).toEqual([{ playerId: 1, amount: 3 }])

    // 名字对不上任何人 → 整组放弃
    const unknown = resolveChoice(`{"choice": ${idx + 1}, "payouts": [{"playerId": "路人甲", "amount": 3}]}`, legal, s)!
    expect(unknown.type === 'PROPOSE_OFFER' && unknown.payouts).toEqual(original)

    // 截图里的事故：模型想给 1 号 $2M，却把 ID 写成了 2（旁观者）→ 不能让钱落到别人头上
    const wrongId = resolveChoice(`{"choice": ${idx + 1}, "speech": "分你 2M，成交吧", "payouts": [{"playerId": 2, "amount": 2}]}`, legal, s)!
    expect(wrongId.type === 'PROPOSE_OFFER' && wrongId.payouts).toEqual(original)
    expect(wrongId.type === 'PROPOSE_OFFER' && wrongId.payouts.some(p => p.playerId === 2)).toBe(false)

    // 旁观者若已公开索要封口费，则付给他是合理的
    const bribed = step(s, { type: 'PASS', playerId: 0 })
    const spoke = step(bribed, { type: 'SPEAK', playerId: 1, say: '出个价' })
    const asked = step(spoke, { type: 'SPEAK', playerId: 2, say: '给我 1M 我就不捣乱', quotes: [{ amount: 1 }] })
    const back = step(asked, { type: 'PASS', playerId: 3 })
    const legal2 = getLegalActions(back, 0)
    const idx2 = legal2.findIndex(a => a.type === 'PROPOSE_OFFER' && a.payouts.length > 0)
    const hush = resolveChoice(`{"choice": ${idx2 + 1}, "payouts": [{"playerId": 1, "amount": 2}, {"playerId": 2, "amount": 1}]}`, legal2, back)!
    expect(hush.type === 'PROPOSE_OFFER' && hush.payouts).toEqual([{ playerId: 1, amount: 2 }, { playerId: 2, amount: 1 }])
  })

  it('DECLINE_OFFER 可附反报价；DISCARD 可指定弃牌', () => {
    let s = bossTurn()
    s = step(s, { type: 'PROPOSE_OFFER', playerId: 0, repKeys: [investorRepKey('A'), investorRepKey('B')], payouts: [{ playerId: 1, amount: 1 }] })
    const legal = getLegalActions(s, 1)
    const idx = legal.findIndex(a => a.type === 'DECLINE_OFFER')
    const a = resolveChoice(`{"choice": ${idx + 1}, "demand": 3}`, legal, s)!
    expect(a.type === 'DECLINE_OFFER' && a.quotes).toEqual([{ amount: 3 }])

    const h = baseState(4, 32)
    clearHand(h, 0)
    giveCards(h, 0, Array.from({ length: 14 }, () => ({ type: 'RECRUITMENT' as const })))
    h.phase = 'HAND_LIMIT'; h.currentId = 0; h.markerChooserId = null
    const hl = getLegalActions(h, 0)
    const di = hl.findIndex(x => x.type === 'DISCARD')
    const pick = h.players[0].hand.slice(-2).map(c => c.id)
    const d = resolveChoice(`{"choice": ${di + 1}, "cardIds": [${pick.join(',')}]}`, hl, h)!
    expect(d.type === 'DISCARD' && d.cardIds).toEqual(pick)
    const wrong = resolveChoice(`{"choice": ${di + 1}, "cardIds": [999]}`, hl, h)!
    expect(wrong.type === 'DISCARD' && wrong.cardIds).toEqual((hl[di] as { cardIds: unknown }).cardIds)
  })
})

describe('选项剪枝与后果注释', () => {
  it('只剪机械冗余：打飞自己代表的旅行牌、与定向旅行同目标的万能旅行；一分不给的"求人情"方案保留但注明后果', () => {
    let s = baseState(4, 36)
    setInvestors(s, { A: 0, B: 1, C: 2, D: 3 })
    for (let i = 0; i < 4; i++) clearHand(s, i)
    giveCards(s, 2, [{ type: 'TRAVEL', familyId: 'B' }, { type: 'TRAVEL' }, { type: 'TRAVEL', familyId: 'C' }])
    s = openDealAt(s, 1, 0)
    s = step(s, { type: 'PASS', playerId: 1 })
    const legal = getLegalActions(s, 2)
    const pruned = pruneForLLM(s, 2, legal)
    // 自己的 C 代表：定向 C 旅行牌与万能牌都能打，全部剪掉
    expect(legal.some(a => a.type === 'PLAY_TRAVEL' && a.targetRepKey === investorRepKey('C'))).toBe(true)
    expect(pruned.some(a => a.type === 'PLAY_TRAVEL' && a.targetRepKey === investorRepKey('C'))).toBe(false)
    // B 有定向牌可打 → 万能牌打 B 属冗余；万能牌打 A 保留
    const travelsOnB = pruned.filter(a => a.type === 'PLAY_TRAVEL' && a.targetRepKey === investorRepKey('B'))
    expect(travelsOnB).toHaveLength(1)
    expect(s.players[2].hand.find(c => c.id === (travelsOnB[0] as { cardId: number }).cardId)!.familyId).toBe('B')
    expect(pruned.some(a => a.type === 'PLAY_TRAVEL' && a.targetRepKey === investorRepKey('A'))).toBe(true)

    const b = toBoss(s)
    const bossLegal = getLegalActions(b, 0)
    const favor = bossLegal.find(a => a.type === 'PROPOSE_OFFER' && a.payouts.length === 0)!
    expect(favor).toBeTruthy() // 引擎允许一分不给
    expect(pruneForLLM(b, 0, bossLegal)).toContain(favor) // 模型也看得到：做人情是角色的权利
    expect(annotateOption(b, 0, favor)).toContain('求人情') // 但后果写明
  })

  it('注释说明后果：方案作废 / 失去的钱 / 自动同意 / 唯一选择', () => {
    let s = baseState(4, 37)
    setInvestors(s, { A: 0, B: 1, C: 2, D: 3 })
    for (let i = 0; i < 4; i++) clearHand(s, i)
    giveCards(s, 3, [{ type: 'TRAVEL' }])
    s = openDealAt(s, 1, 0)
    s = step(s, { type: 'SPEAK', playerId: 1, say: '3', quotes: [{ familyId: 'B', amount: 3 }] })
    s = step(s, { type: 'PASS', playerId: 2 }); s = step(s, { type: 'PASS', playerId: 3 })
    const keys = [investorRepKey('A'), investorRepKey('B')]
    const propose = { type: 'PROPOSE_OFFER' as const, playerId: 0, repKeys: keys, payouts: [{ playerId: 1, amount: 3 }] }
    expect(annotateOption(s, 0, propose)).toContain('已付到承诺价会自动同意')
    expect(annotateOption(s, 0, { ...propose, payouts: [{ playerId: 1, amount: 2 }] })).toContain('表态')
    s = step(s, propose) // 自动同意
    s = step(s, { type: 'PASS', playerId: 0 }); s = step(s, { type: 'PASS', playerId: 1 }); s = step(s, { type: 'PASS', playerId: 2 })
    const travel = getLegalActions(s, 3).find(a => a.type === 'PLAY_TRAVEL' && a.targetRepKey === investorRepKey('B'))!
    expect(annotateOption(s, 3, travel)).toContain('当前方案作废')
    expect(annotateOption(s, 3, { type: 'PASS_CLOSING', playerId: 3 })).toContain('一分不得')
    expect(annotateOption(s, 1, { type: 'PASS_CLOSING', playerId: 1 })).toContain('$3M')
  })
})

describe('提示词与策略', () => {
  it('决策提示词包含编号列表、局势摘要、角色卡与规则摘要，没有默认答案；谈判中不带棋盘概览；不泄露他人手牌', () => {
    let s = baseState(4, 33)
    setInvestors(s, { A: 0, B: 1, C: 2, D: 3 })
    for (let i = 0; i < 4; i++) clearHand(s, i)
    giveCards(s, 3, [{ type: 'STOP' }])
    s = toBoss(openDealAt(s, 1, 0))
    const legal = getLegalActions(s, 0)
    const { system, user, options } = buildDecisionPrompt(s, 0, legal)
    expect(system).toContain('【怎么玩这个人】')
    expect(system).toContain('【桌面的现实】')
    expect(system).not.toContain('决策常识') // 不再给行为戒律
    expect(options.length).toBeLessThanOrEqual(legal.length)
    for (let i = 1; i <= options.length; i++) expect(user).toContain(`${i}. `)
    expect(user).not.toContain(`${options.length + 1}. `)
    expect(user).toContain('【你的身份】')
    expect(user).toContain('【局势摘要】')
    expect(user).not.toContain('默认建议') // 判断留给模型
    expect(user).toContain('"thought"')
    expect(user).toContain('"note"')
    expect(user).not.toContain('【棋盘概览')
    expect(user).not.toContain('阻止牌#') // 3 号的阻止牌不能出现在 0 号的提示词里
    expect(user).toContain('手牌1张')
    // 分成要按 playerId 指定收款人，所以每位其他玩家都必须带 ID
    for (const p of s.players) if (p.id !== 0) expect(user).toContain(`${p.name}（ID=${p.id}）`)

    // 回合阶段才带棋盘概览
    const t = baseState(4, 33)
    t.phase = 'TURN'; t.currentId = 0; t.markerChooserId = null
    expect(buildDecisionPrompt(t, 0, getLegalActions(t, 0)).user).toContain('【棋盘概览')
  })

  it('每位电脑玩家的 system 提示是它自己的角色卡：以真名开场、带身份与软肋、{{name}} 全部替换', () => {
    const s = baseState(6, 39)
    const seen = new Set<string>()
    expect(s.players.filter(p => p.personaId)).toHaveLength(5)
    for (const p of s.players.filter(p => p.personaId)) {
      const persona = getPersonaForPlayer(p.personaId)
      expect(PERSONA_IDS).toContain(persona.id)
      expect(persona.name).toBe(p.name)
      seen.add(persona.id)
      const { system } = buildDecisionPrompt(s, p.id, getLegalActions(s, p.id))
      expect(system.startsWith(`你是${p.name}，`)).toBe(true)
      expect(system).toContain('软肋')
      expect(system).not.toContain('{{name}}')
      expect(system).toContain(`用${p.name}的方式去赢`)
    }
    expect(seen.size).toBe(5) // 六人局的五位电脑玩家互不重复
    // 花名册与人物一一对应，每个人都有一套完整的启发式参数
    for (const entry of AI_ROSTER) {
      const persona = PERSONAS[entry.personaId]
      expect(persona, entry.personaId).toBeTruthy()
      expect(persona.name).toBe(entry.name)
      expect(persona.title.length).toBeGreaterThan(4)
      expect(persona.play.askMult).toBeGreaterThan(0)
    }
  })

  it('私人笔记：随动作写入自己的 notes，回灌到自己的下一份提示词；不进事件、不给别人看；条数与长度有上限', () => {
    let s = baseState(4, 40)
    setInvestors(s, { A: 0, B: 1, C: 2, D: 3 })
    s = openDealAt(s, 1, 0) // 叫价轮，1 号先行动
    const legal = getLegalActions(s, 1)
    const idx = legal.findIndex(a => a.type === 'PASS')
    const a = resolveChoice(`{"choice": ${idx + 1}, "thought": "先看看 Boss 出多少", "speech": "各位先请。", "note": "  Boss 是 0 号，上局压过我的价，这局不主动让  "}`, legal, s)!
    expect(a.note).toBe('Boss 是 0 号，上局压过我的价，这局不主动让')
    expect(a.say).toBeUndefined()
    expect(a.thought).toBe('先看看 Boss 出多少') // 内心盘算保留在动作负载里供复盘（不进事件、不影响规则）
    expect(resolveChoice(`{"choice": ${idx + 1}, "note": "${'记'.repeat(100)}"}`, legal, s)!.note).toHaveLength(NOTE_MAX_LEN)
    s.players[1].notes = Array.from({ length: 8 }, (_, i) => ({ text: `旧${i}`, dealNo: null, spaceId: null, phase: null })) // 已满 8 条
    s = step(s, a)
    expect(s.players[1].notes).toHaveLength(8) // 上限 8 条：挤掉最旧的
    expect(s.players[1].notes[0].text).toBe('旧1')
    expect(s.players[1].notes.at(-1)).toMatchObject({ text: 'Boss 是 0 号，上局压过我的价，这局不主动让', dealNo: 1, spaceId: 1, phase: 'NEGOTIATION' })
    expect(s.events.some(e => JSON.stringify(e).includes('上局压过我的价'))).toBe(false)
    expect(s.events.some(e => JSON.stringify(e).includes('先看看 Boss 出多少'))).toBe(false)
    expect(s.negotiation!.speeches.some(sp => sp.text.includes('上局压过我的价'))).toBe(false)

    // 回到 1 号时能看到；其他人看不到
    s = step(s, { type: 'PASS', playerId: 2 }); s = step(s, { type: 'PASS', playerId: 3 }); s = step(s, { type: 'PASS', playerId: 0 })
    expect(getActingPlayerId(s)).toBe(1)
    expect(buildDecisionPrompt(s, 1, getLegalActions(s, 1)).user).toContain('【你的私人笔记')
    expect(buildDecisionPrompt(s, 1, getLegalActions(s, 1)).user).toContain('- Boss 是 0 号，上局压过我的价，这局不主动让')
    expect(buildDecisionPrompt(s, 2, getLegalActions(s, 2)).user).not.toContain('上局压过我的价')

    // 引擎对笔记的硬上限 80 字；空白笔记不记（LLM 路径按提示词承诺的 NOTE_MAX_LEN 先截断，见 resolveChoice）
    s = step(s, { type: 'PASS', playerId: 1, note: '长'.repeat(100) })
    expect(s.players[1].notes.at(-1)!.text).toHaveLength(80)
    s = step(s, { type: 'PASS', playerId: 2, note: '   ' })
    expect(s.players[2].notes).toHaveLength(0)
  })

  it('非 Boss 的提示词点明杠杆 / 竞争 / 承诺价', () => {
    let s = baseState(4, 38)
    setInvestors(s, { A: 0, B: 1, C: 2, D: 3 })
    clearHand(s, 2)
    const [clan] = giveCards(s, 2, [{ type: 'CLAN', familyId: 'B' }])
    s = openDealAt(s, 1, 0)
    const solo = buildDecisionPrompt(s, 1, getLegalActions(s, 1)).user
    expect(solo).toContain('唯一代表')
    s = step(s, { type: 'SPEAK', playerId: 1, say: '3', quotes: [{ familyId: 'B', amount: 3 }] })
    s = step(s, { type: 'PLAY_CLAN', playerId: 2, cardId: clan.id, demand: 2 })
    s = step(s, { type: 'PASS', playerId: 3 }); s = step(s, { type: 'PASS', playerId: 0 })
    const contested = buildDecisionPrompt(s, 1, getLegalActions(s, 1)).user
    expect(contested).toContain('竞争者')
    expect(contested).toContain('你已公开承诺价：赤岩集团 $3M')
    expect(clanRepKey(clan.id)).toBeTruthy()
  })

  it('未配置 LLM 时策略返回 null，withFallback 交给启发式；唯一合法动作不请求模型', async () => {
    const policy = createLLMPolicy(() => ({ ...DEFAULT_LLM_CONFIG, enabled: true, apiKey: '' }))
    const s = baseState(4, 34)
    setInvestors(s, { A: 0, B: 1, C: 2, D: 3 })
    const t = openDealAt(s, 1, 0)
    expect(await policy.decide(t, new AbortController().signal)).toBeNull()
    const combined = withFallback(policy, heuristicPolicy)
    const a = await combined.decide(t, new AbortController().signal)
    expect(a).not.toBeNull()
    expect(a!.playerId).toBe(getActingPlayerId(t))

    // 终局掷骰只有一个合法动作：无需模型即可决策
    const e = baseState(4, 35)
    e.phase = 'END_ROLL'; e.currentId = 0; e.markerChooserId = null
    const only = await policy.decide(e, new AbortController().signal)
    expect(only?.type).toBe('ROLL_END')
  })
})
