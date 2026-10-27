// ============================================================
// 提示词局面题库：离线结构检查 + 可选真实 LLM 评测
//
//   npm run prompts:eval                 # 只做离线检查（长度、结构、矛盾文案、剪枝）
//   LLM_BASE_URL=… LLM_API_KEY=… LLM_MODEL=… npm run prompts:eval
//                                        # 另对每道题问一次模型，看它选的动作类型
//
// 题库与 prompts:preview 同一套收集逻辑（固定种子、全员启发式代打）。
// ============================================================

import { createInitialState, gameReducer } from '../src/engine/gameEngine'
import { getActingPlayerId, getLegalActions } from '../src/engine/validator'
import { playerRelevantFamilies, soleRepFamilies } from '../src/engine/rules'
import type { GameState, PlayerAction } from '../src/engine/types'
import { heuristicAction } from '../src/ai/heuristic'
import { buildDecisionPrompt } from '../src/ai/prompts'
import { decideWithLLM } from '../src/ai/llmPolicy'
import { DEFAULT_LLM_CONFIG, type LLMConfig } from '../src/ai/llmClient'

interface Case {
  id: string
  title: string
  match: (s: GameState, id: number) => boolean
  /** 剪枝后的列表里不该出现的动作类型 */
  forbid?: PlayerAction['type'][]
  /** 文案不得自相矛盾的关键词（同一选项里同时出现） */
  noBoth?: [string, string]
  /** LLM 选到这些类型记为通过（空 = 只要合法就算过） */
  prefer?: PlayerAction['type'][]
}

const nonBoss = (s: GameState, id: number) => s.phase === 'NEGOTIATION' && s.negotiation != null && s.negotiation.bossId !== id

const CASES: Case[] = [
  { id: 'turn', title: '回合开始', match: s => s.phase === 'TURN' },
  { id: 'sole', title: '叫价·唯一代表', match: (s, id) => nonBoss(s, id) && soleRepFamilies(s, id).length > 0, prefer: ['SPEAK', 'PLAY_CLAN'] },
  { id: 'rival', title: '叫价·有竞争者', match: (s, id) => nonBoss(s, id) && playerRelevantFamilies(s, id).length > 0 && soleRepFamilies(s, id).length === 0 },
  { id: 'bystander', title: '叫价·无相关代表', match: (s, id) => nonBoss(s, id) && playerRelevantFamilies(s, id).length === 0 },
  { id: 'boss', title: 'Boss 提案', match: (s, id) => s.phase === 'NEGOTIATION' && s.negotiation?.bossId === id && (s.negotiation?.speeches.length ?? 0) > 0, forbid: ['PLAY_TRAVEL'], noBoth: ['填 demand', 'demand 必须填 null'], prefer: ['PROPOSE_OFFER', 'PLAY_CLAN'] },
  { id: 'respond', title: '应答方案', match: s => s.phase === 'OFFER_RESPONSE', prefer: ['ACCEPT_OFFER', 'DECLINE_OFFER'] },
  { id: 'reaction', title: '反应窗口', match: s => s.phase === 'REACTION' },
  { id: 'closing', title: '成交倒计时', match: s => s.phase === 'CLOSING' },
]

function collect(): Array<{ c: Case; state: GameState; actor: number }> {
  const found: Array<{ c: Case; state: GameState; actor: number }> = []
  const done = new Set<string>()
  for (let seed = 1; seed <= 40 && done.size < CASES.length; seed++) {
    let s: GameState | null = createInitialState(4, '', seed, 'full', { houseRules: true })
    for (let step = 0; s && s.phase !== 'GAME_OVER' && step < 4000 && done.size < CASES.length; step++) {
      const id = getActingPlayerId(s)
      if (id < 0) break
      const legal = getLegalActions(s, id)
      if (s.players[id].isAI && legal.length > 1) {
        for (const c of CASES) {
          if (done.has(c.id) || !c.match(s, id)) continue
          found.push({ c, state: s, actor: id })
          done.add(c.id)
        }
      }
      const action = heuristicAction(s)
      if (!action) break
      s = gameReducer(s, action)
    }
  }
  return found
}

function envConfig(): LLMConfig | null {
  const apiKey = (process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? '').trim()
  const baseUrl = (process.env.LLM_BASE_URL ?? process.env.OPENAI_BASE_URL ?? DEFAULT_LLM_CONFIG.baseUrl).trim()
  const model = (process.env.LLM_MODEL ?? process.env.OPENAI_MODEL ?? DEFAULT_LLM_CONFIG.model).trim()
  if (!apiKey) return null
  return { ...DEFAULT_LLM_CONFIG, enabled: true, apiKey, baseUrl, model, timeoutSecs: Number(process.env.LLM_TIMEOUT ?? 60) }
}

async function main() {
  const found = collect()
  let fail = 0
  console.log(`离线题库 ${found.length}/${CASES.length} 道`)
  for (const { c, state, actor } of found) {
    const legal = getLegalActions(state, actor)
    const p = buildDecisionPrompt(state, actor, legal)
    const problems: string[] = []
    if (!p.user.includes('【此刻要决定】')) problems.push('user 开头没有【此刻要决定】')
    if (!p.system.includes('【回复格式】')) problems.push('system 没有回复格式')
    if (p.user.includes('"thought"')) problems.push('user 仍含回复格式（应只在 system）')
    if (!p.system.includes('这是桌游')) problems.push('规则摘要不在 system')
    if (p.user.includes('这是桌游')) problems.push('规则摘要仍在 user')
    if (c.forbid) for (const t of c.forbid) if (p.options.some(a => a.type === t)) problems.push(`剪枝后仍有 ${t}`)
    if (c.noBoth) {
      for (const line of p.user.split('\n')) if (line.includes(c.noBoth[0]) && line.includes(c.noBoth[1])) problems.push(`选项自相矛盾：同时含「${c.noBoth[0]}」和「${c.noBoth[1]}」`)
    }
    // Boss 喊话不得再写"填 demand"
    if (c.id === 'boss') {
      const speak = p.user.split('\n').find(l => l.includes('喊话'))
      if (speak?.includes('填 demand') && !speak.includes('不填 demand')) problems.push('Boss 喊话仍要求填 demand')
    }
    const chars = p.system.length + p.user.length
    console.log(`  ${problems.length ? '✗' : '✓'} ${c.title}  system ${p.system.length} / user ${p.user.length}（合计 ${chars}）`)
    for (const m of problems) { console.log(`      ${m}`); fail++ }
  }
  for (const c of CASES) if (!found.some(x => x.c.id === c.id)) { console.log(`  ✗ 未遇到：${c.title}`); fail++ }

  const cfg = envConfig()
  if (!cfg) {
    console.log('\n未设置 LLM_API_KEY：跳过真实模型评测。')
    process.exit(fail ? 1 : 0)
  }
  console.log(`\n真实模型：${cfg.model} @ ${cfg.baseUrl}`)
  let llmFail = 0
  for (const { c, state, actor } of found) {
    const legal = getLegalActions(state, actor)
    try {
      const action = await decideWithLLM(state, actor, legal, cfg, new AbortController().signal)
      const ok = !!action && (!c.prefer || c.prefer.includes(action.type))
      console.log(`  ${ok ? '✓' : '·'} ${c.title} → ${action?.type ?? 'null'}${c.prefer && action && !c.prefer.includes(action.type) ? `（期望 ${c.prefer.join('/')}）` : ''}`)
      if (!action) llmFail++
    } catch (e) {
      console.log(`  ✗ ${c.title} 请求失败：${e instanceof Error ? e.message : e}`)
      llmFail++
    }
  }
  process.exit(fail || llmFail ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
