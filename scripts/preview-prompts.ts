// ============================================================
// 提示词预览：用固定种子跑几局（全员启发式代打），在典型局面第一次出现时，
// 把电脑玩家这一刻会收到的完整 system / user 消息写成 Markdown，方便审查改动后的效果。
//
//   npm run prompts:preview                 # 默认：完整 · 16 笔，4 人，商战，人类名留空（= "你"）
//   npm run prompts:preview -- ruthless     # 指定桌风：friendly / business / ruthless
//
// 输出目录 prompt-preview/（已 gitignore），每次运行先清空。
// ============================================================

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInitialState, gameReducer } from '../src/engine/gameEngine'
import { getActingPlayerId, getLegalActions } from '../src/engine/validator'
import { playerRelevantFamilies, soleRepFamilies } from '../src/engine/rules'
import type { GameState } from '../src/engine/types'
import { heuristicAction } from '../src/ai/heuristic'
import { buildDecisionPrompt } from '../src/ai/prompts'
import { isTableStyle, type TableStyle } from '../src/ai/tableStyle'

const OUT_DIR = 'prompt-preview'
const style: TableStyle = isTableStyle(process.argv[2]) ? process.argv[2] : 'business'

interface Scenario { file: string; title: string; match: (s: GameState, id: number) => boolean }

const nonBoss = (s: GameState, id: number) => s.phase === 'NEGOTIATION' && s.negotiation != null && s.negotiation.bossId !== id
const SCENARIOS: Scenario[] = [
  { file: '01-回合开始', title: '自己的回合：开单 / 掷骰', match: s => s.phase === 'TURN' },
  { file: '02-叫价-唯一代表', title: '叫价轮：手里有唯一代表（有杠杆）', match: (s, id) => nonBoss(s, id) && soleRepFamilies(s, id).length > 0 },
  { file: '03-叫价-有竞争者', title: '叫价轮：有相关代表但不唯一', match: (s, id) => nonBoss(s, id) && playerRelevantFamilies(s, id).length > 0 && soleRepFamilies(s, id).length === 0 },
  { file: '04-叫价-无相关代表', title: '叫价轮：没有相关代表（只能封口费 / 搅局）', match: (s, id) => nonBoss(s, id) && playerRelevantFamilies(s, id).length === 0 },
  { file: '05-Boss-提案', title: 'Boss：提方案 / 宣布成交', match: (s, id) => s.phase === 'NEGOTIATION' && s.negotiation?.bossId === id && s.negotiation.offersMade === 0 && s.negotiation.speeches.length > 0 },
  { file: '06-应答方案', title: '应答 Boss 的方案', match: s => s.phase === 'OFFER_RESPONSE' },
  { file: '07-反应窗口', title: '反应窗口：是否打阻止牌', match: s => s.phase === 'REACTION' },
  { file: '08-成交倒计时', title: '成交倒计时：最后出牌机会', match: s => s.phase === 'CLOSING' },
]

rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(OUT_DIR, { recursive: true })

const done = new Set<string>()
for (let seed = 1; seed <= 40 && done.size < SCENARIOS.length; seed++) {
  let s: GameState | null = createInitialState(4, '', seed, 'full', { houseRules: true })
  for (let step = 0; s && s.phase !== 'GAME_OVER' && step < 4000 && done.size < SCENARIOS.length; step++) {
    const id = getActingPlayerId(s)
    if (id < 0) break
    const legal = getLegalActions(s, id)
    if (s.players[id].isAI && legal.length > 1) {
      for (const sc of SCENARIOS) {
        if (done.has(sc.file) || !sc.match(s, id)) continue
        const p = buildDecisionPrompt(s, id, legal, { style })
        writeFileSync(join(OUT_DIR, `${sc.file}.md`), [
          `# ${sc.title}`,
          `种子 ${seed} · 第 ${step} 步 · ${s.players[id].name}（ID=${id}）· 桌风 ${style} · ${p.options.length} 个选项`,
          '', '## system', '', '```text', p.system.trim(), '```', '', '## user', '', '```text', p.user.trim(), '```', '',
        ].join('\n'), 'utf8')
        done.add(sc.file)
      }
    }
    const action = heuristicAction(s, { style })
    if (!action) break
    s = gameReducer(s, action)
  }
}

for (const sc of SCENARIOS) console.log(`${done.has(sc.file) ? '✓' : '✗ 未遇到'} ${OUT_DIR}/${sc.file}.md  ${sc.title}`)
