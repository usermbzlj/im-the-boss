// ============================================================
// 策略竞技场：新旧启发式按座位混坐对打，衡量"改完是否更强"
//   npm run arena                       # 400 局，经典版，基线 = main 分支的 heuristic.ts
//   npm run arena -- 800 expansion      # 局数、变体（classic / full / expansion / marathon / mix）
//   ARENA_BASE=<git ref> npm run arena  # 指定基线版本
//
// 每局一半座位（随机挑选、按种子固定）用候选策略，其余用基线；同一种子再跑一局座位互换的镜像局，
// 抵消座位与发牌运气。相对胜率 = 实际胜场 / 公平期望（Σ 1/人数），1 为持平。
// 另跑全候选、全基线各一组，比较流局率、直接开单比例、先手胜率等桌面指标。
// ============================================================

import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { GameState, GameVariantId, PlayerAction } from '../src/engine/types'
import { gameReducer } from '../src/engine/gameEngine'
import { getActingPlayerId, getLegalActions, isLegal } from '../src/engine/validator'
import { AI_ROSTER, VARIANT_IDS } from '../src/engine/config'
import { createGame } from '../src/game/replay'
import { heuristicAction } from '../src/ai/heuristic'
import { checkInvariants } from '../src/sim/harness'

type Decide = (s: GameState) => PlayerAction | null

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE_REF = process.env.ARENA_BASE ?? 'main'
const baselineFile = resolve(root, 'src/ai/.baseline-heuristic.ts')

async function loadBaseline(): Promise<Decide> {
  const src = execSync(`git show ${BASE_REF}:src/ai/heuristic.ts`, { cwd: root, encoding: 'utf8' })
  mkdirSync(dirname(baselineFile), { recursive: true })
  writeFileSync(baselineFile, `// 自动生成：${BASE_REF} 的 heuristic.ts（竞技场基线，勿提交）\n${src}`)
  const mod = await import(pathToFileURL(baselineFile).href)
  return (s: GameState) => mod.heuristicAction(s)
}

interface GameStats {
  ok: boolean
  reason?: string
  winners: number[]
  playerCount: number
  startId: number
  deals: number
  failed: Record<string, number>
  opens: number
  openAfterMove: number
  takeovers: number
  steps: number
}

function play(seed: number, playerCount: number, variantId: GameVariantId, seats: Decide[]): GameStats {
  const { state: init } = createGame({ playerCount, humanName: '座位0', seed, variantId, allAI: true })
  // 座位 0 默认没有人物；给它一个本局未出场的常客，免得它总按默认人物打
  const used = new Set(init.players.map(p => p.personaId))
  init.players[0].personaId = AI_ROSTER.find(r => !used.has(r.personaId))?.personaId
  const started = init.events.find(e => e.kind === 'GAME_STARTED')
  const startId = started && started.kind === 'GAME_STARTED' ? started.startPlayerId : 0
  let state = init
  let steps = 0
  const st: GameStats = { ok: true, winners: [], playerCount, startId, deals: 0, failed: {}, opens: 0, openAfterMove: 0, takeovers: 0, steps: 0 }
  let moved = false
  while (state.phase !== 'GAME_OVER' && steps < 80000) {
    steps++
    const actor = getActingPlayerId(state)
    const legal = getLegalActions(state, actor)
    if (legal.length === 0) return { ...st, ok: false, reason: `无合法动作 phase=${state.phase}` }
    let action = seats[actor](state)
    if (!action || !isLegal(state, action)) action = legal[0]
    const next = gameReducer(state, action)
    const lastId = state.events.at(-1)?.id ?? 0
    for (const e of next.events) {
      if (e.id <= lastId) continue
      if (e.kind === 'MARKER_MOVED') moved = true
      else if (e.kind === 'DEAL_OPENED') { st.opens++; if (moved) st.openAfterMove++ }
      else if (e.kind === 'CARDS_DRAWN' || e.kind === 'DEAL_CLOSED' || e.kind === 'DEAL_FAILED') moved = false
      if (e.kind === 'DEAL_FAILED') st.failed[e.reason] = (st.failed[e.reason] ?? 0) + 1
      if (e.kind === 'BOSS_RESOLVED') st.takeovers++
    }
    state = next
    const bad = checkInvariants(state)
    if (bad) return { ...st, ok: false, reason: bad }
  }
  if (state.phase !== 'GAME_OVER') return { ...st, ok: false, reason: '步数超限' }
  return { ...st, winners: state.winnerIds, deals: state.completedDeals, steps }
}

/** 由种子决定哪些座位用候选策略（恰好一半，奇数人数时轮流多给一边） */
function candidateSeats(seed: number, n: number): Set<number> {
  const seats = Array.from({ length: n }, (_, i) => i)
  let x = seed * 2654435761 >>> 0
  for (let i = n - 1; i > 0; i--) { x = (x * 1103515245 + 12345) >>> 0; const j = x % (i + 1); [seats[i], seats[j]] = [seats[j], seats[i]] }
  const k = n % 2 === 0 ? n / 2 : (seed % 2 === 0 ? Math.ceil(n / 2) : Math.floor(n / 2))
  return new Set(seats.slice(0, k))
}

function pct(a: number, b: number) { return b ? `${(100 * a / b).toFixed(1)}%` : '-' }

function summarize(label: string, games: GameStats[]) {
  const n = games.length
  const deals = games.reduce((s, g) => s + g.deals, 0)
  const failed = games.reduce((s, g) => s + Object.values(g.failed).reduce((a, b) => a + b, 0), 0)
  const reasons: Record<string, number> = {}
  for (const g of games) for (const [k, v] of Object.entries(g.failed)) reasons[k] = (reasons[k] ?? 0) + v
  const opens = games.reduce((s, g) => s + g.opens, 0)
  const afterMove = games.reduce((s, g) => s + g.openAfterMove, 0)
  let starterWin = 0, starterFair = 0
  for (const g of games) { starterFair += 1 / g.playerCount; if (g.winners.includes(g.startId)) starterWin += 1 / g.winners.length }
  console.log(`  [${label}] ${n} 局：每局成交 ${(deals / n).toFixed(1)}、流局 ${(failed / n).toFixed(1)}（流局率 ${pct(failed, deals + failed)}；${Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(' / ')}）`)
  console.log(`  [${label}] 掷骰后开单占 ${pct(afterMove, opens)}；每局夺权 ${(games.reduce((s, g) => s + g.takeovers, 0) / n).toFixed(1)}；平均步数 ${(games.reduce((s, g) => s + g.steps, 0) / n).toFixed(0)}；起始玩家相对胜率 ${(starterWin / starterFair).toFixed(2)}`)
}

async function main() {
  const total = Number(process.argv[2] ?? 400)
  const variantArg = process.argv[3] ?? 'classic'
  const variantOf = (i: number): GameVariantId => variantArg === 'mix' ? VARIANT_IDS[i % VARIANT_IDS.length] : variantArg as GameVariantId
  const baseline = await loadBaseline()
  const candidate: Decide = s => heuristicAction(s)
  const counts = [3, 4, 5, 6]

  let candWins = 0, candFair = 0, baseWins = 0, baseFair = 0, errors = 0
  const t0 = Date.now()
  for (let i = 0; i < total; i++) {
    const n = counts[i % counts.length]
    const seed = 70000 + Math.floor(i / 2)
    const set = candidateSeats(seed, n)
    const mirrored = i % 2 === 1
    const isCand = (seat: number) => set.has(seat) !== mirrored
    const seats = Array.from({ length: n }, (_, s) => isCand(s) ? candidate : baseline)
    const g = play(seed * 4 + n, n, variantOf(i), seats)
    if (!g.ok) { errors++; console.error(`✗ 局#${i}: ${g.reason}`); continue }
    for (let s = 0; s < n; s++) {
      const share = g.winners.includes(s) ? 1 / g.winners.length : 0
      if (isCand(s)) { candWins += share; candFair += 1 / n } else { baseWins += share; baseFair += 1 / n }
    }
  }
  console.log(`\n===== 竞技场：候选（工作区）vs 基线（${BASE_REF}），${total} 局混坐，变体 ${variantArg}，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s =====`)
  console.log(`  候选相对胜率 ${(candWins / candFair).toFixed(3)}（胜 ${candWins.toFixed(1)} / 期望 ${candFair.toFixed(1)}）`)
  console.log(`  基线相对胜率 ${(baseWins / baseFair).toFixed(3)}（胜 ${baseWins.toFixed(1)} / 期望 ${baseFair.toFixed(1)}）`)
  if (errors) console.log(`  异常局 ${errors}`)

  const pure = Math.min(Number(process.env.ARENA_PURE ?? 200), total)
  if (pure <= 0) { if (errors) process.exit(1); return }
  const run = (d: Decide) => Array.from({ length: pure }, (_, i) => play(90000 + i, counts[i % 4], variantOf(i), Array(counts[i % 4]).fill(d))).filter(g => g.ok)
  console.log(`\n桌面指标（各 ${pure} 局同策略自对弈）：`)
  summarize('候选', run(candidate))
  summarize('基线', run(baseline))
  if (errors) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
