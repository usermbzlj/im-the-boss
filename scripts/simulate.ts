// ============================================================
// 命令行仿真：批量跑完整对局做回归，或追踪单局
//   npm run simulate                 # 200 局：heuristic/random 各半，3~6 人轮换
//   npm run simulate -- 400          # 400 局
//   npm run simulate -- 4 7 random   # 单局追踪：4 人局 seed=7 random 模式，打印全部事件
//   SIM_MODE=heuristic npm run simulate -- 100
//   SIM_SESSION=1 npm run simulate -- 20   # 额外用 GameSession 运行时跑 20 局
// ============================================================

import { runGame, runGameViaSession, narrateGame, type SimMode, type SimResult } from '../src/sim/harness'

const MAX_STEPS = Number(process.env.SIM_MAX_STEPS ?? 30000)

async function main() {
  if (process.argv[3] !== undefined) {
    const playerCount = Number(process.argv[2])
    const seed = Number(process.argv[3])
    const mode = (process.argv[4] as SimMode) ?? 'heuristic'
    console.log(`单局追踪：${playerCount} 人 seed=${seed} mode=${mode}`)
    const r = runGame({ playerCount, seed, mode, maxSteps: MAX_STEPS, trace: true })
    if (!r.ok) console.log(r.trace.join('\n'))
    for (const line of narrateGame(r.final)) console.log(line)
    console.log({ ok: r.ok, steps: r.steps, reason: r.reason, deals: r.deals, failedDeals: r.failedDeals, cash: r.cash })
    process.exit(r.ok ? 0 : 1)
  }

  const onlyMode = (process.env.SIM_MODE as SimMode | undefined) ?? null
  const total = Number(process.argv[2] ?? 200)
  const counts = [3, 4, 5, 6]
  const failures: SimResult[] = []
  const stats: Record<SimMode, { games: number; steps: number; deals: number; failedDeals: number }> = {
    heuristic: { games: 0, steps: 0, deals: 0, failedDeals: 0 },
    random: { games: 0, steps: 0, deals: 0, failedDeals: 0 },
  }
  console.log(`开始仿真 ${total} 局（模式：${onlyMode ?? 'heuristic/random 各半'}，步数预算 ${MAX_STEPS}）…`)
  const t0 = Date.now()
  for (let i = 0; i < total; i++) {
    const playerCount = counts[i % counts.length]
    const mode: SimMode = onlyMode ?? (i % 2 === 0 ? 'heuristic' : 'random')
    const r = runGame({ playerCount, seed: i, mode, maxSteps: MAX_STEPS, trace: true })
    stats[mode].games++
    stats[mode].steps += r.steps
    stats[mode].deals += r.deals
    stats[mode].failedDeals += r.failedDeals
    if (!r.ok) {
      failures.push(r)
      console.error(`✗ 局#${i} [${playerCount}人/${mode}] ${r.reason}`)
      console.error(r.trace.slice(-20).join('\n'))
    } else if (i % 50 === 0) {
      console.log(`  ✓ 局#${i} [${playerCount}人/${mode}] ${r.steps} 步，成交 ${r.deals} 笔（流局 ${r.failedDeals}），现金 ${r.cash.join('/')}`)
    }
  }

  let sessionFailures = 0
  const sessionGames = process.env.SIM_SESSION ? Number(process.env.SIM_SESSION) || 20 : 0
  for (let i = 0; i < sessionGames; i++) {
    const r = await runGameViaSession({ playerCount: counts[i % counts.length], seed: 1000 + i, maxSteps: MAX_STEPS })
    if (!r.ok) { sessionFailures++; console.error(`✗ session 局#${i}: ${r.reason}`) }
  }

  console.log('\n===== 仿真结果 =====')
  console.log(`总局数 ${total}，失败 ${failures.length}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  for (const m of ['heuristic', 'random'] as SimMode[]) {
    const st = stats[m]
    if (st.games) console.log(`  ${m}: ${st.games} 局，平均 ${(st.steps / st.games).toFixed(1)} 步，平均成交 ${(st.deals / st.games).toFixed(1)} 笔 / 流局 ${(st.failedDeals / st.games).toFixed(1)} 笔`)
  }
  if (sessionGames) console.log(`  GameSession 运行时：${sessionGames} 局，失败 ${sessionFailures}`)
  if (failures.length || sessionFailures) {
    console.log('\n失败详情（前 10 条）：')
    for (const f of failures.slice(0, 10)) console.log(` - seed=${f.seed} ${f.playerCount}人/${f.mode}: ${f.reason}`)
    process.exit(1)
  }
  console.log('全部通过：无冻结、无口径不一致、无死循环、卡牌/现金守恒。')
}

main().catch(e => { console.error(e); process.exit(1) })
