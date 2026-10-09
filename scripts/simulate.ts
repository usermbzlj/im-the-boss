// ============================================================
// 命令行仿真：批量跑完整对局做回归，或追踪单局
//   npm run simulate                 # 200 局：heuristic/random 各半，3~6 人轮换，四个变体轮换
//   npm run simulate -- 400          # 400 局
//   npm run simulate -- 4 7 random   # 单局追踪：4 人局 seed=7 random 模式，打印全部事件
//   npm run simulate -- 4 7 heuristic marathon   # 单局追踪指定变体
//   SIM_MODE=heuristic npm run simulate -- 100
//   SIM_VARIANT=expansion npm run simulate -- 100   # 只跑某个变体（classic / full / expansion / marathon）
//   SIM_HOUSE=1 npm run simulate -- 100     # 强制开 / 关桌规（1 / 0；省略按变体默认：经典关、其余开）
//   SIM_SESSION=1 npm run simulate -- 20   # 额外用 GameSession 运行时跑 20 局（同时校验动作日志可重放）
//   SIM_REPLAY=1 npm run simulate -- 100   # 每局跑完用"开局参数 + 动作日志"重放，终态必须逐位一致
// ============================================================

import { runGame, runGameViaSession, narrateGame, type SimMode, type SimResult } from '../src/sim/harness'
import { VARIANT_IDS } from '../src/engine/config'
import type { GameVariantId } from '../src/engine/types'

const MAX_STEPS = Number(process.env.SIM_MAX_STEPS ?? 60000)
/** 桌规开关：SIM_HOUSE=1 / 0；省略则按变体默认 */
const HOUSE: boolean | undefined = process.env.SIM_HOUSE === undefined ? undefined : process.env.SIM_HOUSE !== '0'
/** 重放一致性检查：SIM_REPLAY=1 */
const REPLAY = process.env.SIM_REPLAY !== undefined && process.env.SIM_REPLAY !== '0'

async function main() {
  if (process.argv[3] !== undefined) {
    const playerCount = Number(process.argv[2])
    const seed = Number(process.argv[3])
    const mode = (process.argv[4] as SimMode) ?? 'heuristic'
    const variantId = (process.argv[5] as GameVariantId | undefined) ?? 'classic'
    console.log(`单局追踪：${playerCount} 人 seed=${seed} mode=${mode} variant=${variantId}${HOUSE === undefined ? '' : ` houseRules=${HOUSE}`}`)
    const r = runGame({ playerCount, seed, mode, maxSteps: MAX_STEPS, trace: true, variantId, houseRules: HOUSE, checkReplay: REPLAY })
    if (!r.ok) console.log(r.trace.join('\n'))
    for (const line of narrateGame(r.final)) console.log(line)
    console.log({ ok: r.ok, steps: r.steps, reason: r.reason, deals: r.deals, failedDeals: r.failedDeals, cash: r.cash })
    process.exit(r.ok ? 0 : 1)
  }

  const onlyMode = (process.env.SIM_MODE as SimMode | undefined) ?? null
  const onlyVariant = (process.env.SIM_VARIANT as GameVariantId | undefined) ?? null
  const total = Number(process.argv[2] ?? 200)
  const counts = [3, 4, 5, 6]
  const failures: SimResult[] = []
  /** 桌规用量：换牌 / 买牌 / 兑换 / 病假生效 / 缺代表速流局 / 银行收入 */
  type House = { swaps: number; buys: number; trades: number; sick: number; incomplete: number; bank: number }
  type Bucket = { games: number; steps: number; deals: number; failedDeals: number; house: House }
  const newBucket = (): Bucket => ({ games: 0, steps: 0, deals: 0, failedDeals: 0, house: { swaps: 0, buys: 0, trades: 0, sick: 0, incomplete: 0, bank: 0 } })
  const stats: Record<string, Bucket> = {}
  console.log(`开始仿真 ${total} 局（模式：${onlyMode ?? 'heuristic/random 各半'}，变体：${onlyVariant ?? '四种轮换'}，桌规：${HOUSE === undefined ? '按变体默认' : HOUSE ? '开' : '关'}，步数预算 ${MAX_STEPS}${REPLAY ? '，校验重放一致' : ''}）…`)
  const t0 = Date.now()
  for (let i = 0; i < total; i++) {
    const playerCount = counts[i % counts.length]
    const mode: SimMode = onlyMode ?? (i % 2 === 0 ? 'heuristic' : 'random')
    const variantId: GameVariantId = onlyVariant ?? VARIANT_IDS[Math.floor(i / 2) % VARIANT_IDS.length]
    const house: House = { swaps: 0, buys: 0, trades: 0, sick: 0, incomplete: 0, bank: 0 }
    const r = runGame({
      playerCount, seed: i, mode, maxSteps: MAX_STEPS, trace: true, variantId, houseRules: HOUSE, checkReplay: REPLAY,
      onEvent: e => {
        if (e.kind === 'CARD_SWAPPED') house.swaps++
        else if (e.kind === 'CARDS_BOUGHT') house.buys++
        else if (e.kind === 'CARDS_TRADED') house.trades++
        else if (e.kind === 'SICK_RESOLVED') house.sick++
        else if (e.kind === 'DEAL_FAILED' && e.reason === 'INCOMPLETE') house.incomplete++
      },
    })
    house.bank = r.final.bank
    const key = `${variantId}${r.final.houseRules ? '+桌规' : ''}/${mode}`
    const st = (stats[key] ??= newBucket())
    st.games++
    st.steps += r.steps
    st.deals += r.deals
    st.failedDeals += r.failedDeals
    for (const k of Object.keys(house) as Array<keyof House>) st.house[k] += house[k]
    if (!r.ok) {
      failures.push(r)
      console.error(`✗ 局#${i} [${playerCount}人/${mode}/${variantId}] ${r.reason}`)
      console.error(r.trace.slice(-20).join('\n'))
    } else if (i % 50 === 0) {
      console.log(`  ✓ 局#${i} [${playerCount}人/${mode}/${variantId}] ${r.steps} 步，成交 ${r.deals} 笔（流局 ${r.failedDeals}），现金 ${r.cash.join('/')}`)
    }
  }

  let sessionFailures = 0
  const sessionGames = process.env.SIM_SESSION ? Number(process.env.SIM_SESSION) || 20 : 0
  for (let i = 0; i < sessionGames; i++) {
    const variantId: GameVariantId = onlyVariant ?? VARIANT_IDS[i % VARIANT_IDS.length]
    const r = await runGameViaSession({ playerCount: counts[i % counts.length], seed: 1000 + i, maxSteps: MAX_STEPS, variantId, houseRules: HOUSE, checkReplay: true })
    if (!r.ok) { sessionFailures++; console.error(`✗ session 局#${i} [${variantId}]: ${r.reason}`) }
  }

  console.log('\n===== 仿真结果 =====')
  console.log(`总局数 ${total}，失败 ${failures.length}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  for (const key of Object.keys(stats).sort()) {
    const st = stats[key]
    if (!st.games) continue
    const h = st.house
    const per = (n: number) => (n / st.games).toFixed(1)
    const houseLine = key.includes('+桌规')
      ? `；每局桌规：换牌 ${per(h.swaps)} / 买牌 ${per(h.buys)} / 兑换 ${per(h.trades)} / 病假 ${per(h.sick)}，银行收入 $${per(h.bank)}M`
      : ''
    console.log(`  ${key}: ${st.games} 局，平均 ${per(st.steps)} 步，平均成交 ${per(st.deals)} 笔 / 流局 ${per(st.failedDeals)} 笔（其中缺代表速流局 ${per(h.incomplete)}）${houseLine}`)
  }
  if (sessionGames) console.log(`  GameSession 运行时：${sessionGames} 局，失败 ${sessionFailures}`)
  if (failures.length || sessionFailures) {
    console.log('\n失败详情（前 10 条）：')
    for (const f of failures.slice(0, 10)) console.log(` - seed=${f.seed} ${f.playerCount}人/${f.mode}/${f.variantId}: ${f.reason}`)
    process.exit(1)
  }
  console.log('全部通过：无冻结、无口径不一致、无死循环、卡牌/现金守恒。')
}

main().catch(e => { console.error(e); process.exit(1) })
