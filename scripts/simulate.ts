// ============================================================
// 自动化对局仿真脚本（临时验证工具，验证完成后可删除）
// ============================================================
// 目标：驱动真实的引擎/validator/fallbackAI代码跑完大量整局，
// 断言不会出现"合法动作非空但reducer拒绝导致stateVersion不变"的冻结，
// 并断言游戏总能在有限步数内结束。
// 用法：npx tsx scripts/simulate.ts [局数]

import { createInitialState, gameReducer } from '../src/engine/gameEngine'
import { getActingPlayerId, getLegalActions, validateAction } from '../src/engine/validator'
import { getFallbackAction } from '../src/ai/fallbackAI'
import type { GameState, GameAction } from '../src/engine/types'

// 步数预算按模式区分：
// - fallback（真实游戏路径）：20000 足够宽裕（实测均值 100~400 步）；
// - random（纯随机合法动作，仅压力测试）：6人局要"凑齐连续6次不被打断的
//   pass"才能结算，实测均值 ~14000 步、长尾可超 20000，预算放到 60000。
//   这是收敛慢而非死循环（谈判内喊话/提案/手牌均有硬上限，干扰选项必然
//   耗尽；冻结类 bug 由下方逐步的 stateVersion 推进断言兜底检测）。
const FALLBACK_MAX_STEPS = Number(process.env.SIM_MAX_STEPS ?? 20000)
const RANDOM_MAX_STEPS = Number(process.env.SIM_MAX_STEPS ?? 60000)
const budgetFor = (mode: 'fallback' | 'random') =>
  mode === 'random' ? RANDOM_MAX_STEPS : FALLBACK_MAX_STEPS

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

interface RunResult {
  ok: boolean
  steps: number
  reason?: string
  finalPhase?: string
  playerCount?: number
}

/**
 * mode='fallback': 全程用 getFallbackAction 决策（模拟真实无LLM对局）
 * mode='random':   全程从 legal[] 里随机挑一个（压力测试极端分支组合）
 */
function runOneGame(playerCount: number, mode: 'fallback' | 'random', seed: number, trace = false): RunResult {
  let state: GameState | null = createInitialState(playerCount, '测试玩家')
  let steps = 0
  let lastVersion = state.stateVersion
  const recentTrace: string[] = []
  const maxSteps = budgetFor(mode)

  while (state && state.phase !== 'GAME_OVER' && steps < maxSteps) {
    steps++
    const actingId = getActingPlayerId(state)
    const legal = getLegalActions(state, actingId)

    if (trace) {
      const line = `#${steps} phase=${state.phase} acting=${actingId} boss=${state.negotiation?.bossPlayerId ?? '-'} propCount=${state.negotiation?.proposalCount ?? '-'} passCount=${state.negotiation?.passCount ?? '-'} readyClose=${state.negotiation?.bossReadyToClose ?? '-'} legal=${legal.length}[${legal.map(l => l.action.type).join(',')}]`
      recentTrace.push(line)
      if (recentTrace.length > 40) recentTrace.shift()
    }

    if (legal.length === 0) {
      if (trace) console.log(recentTrace.join('\n'))
      return { ok: false, steps, reason: `第${steps}步：actingId=${actingId} phase=${state.phase} 无合法动作`, finalPhase: state.phase, playerCount }
    }

    let action: GameAction | null = null
    if (mode === 'fallback') {
      // 人类座位(0)也强制走 fallback 逻辑以便仿真整局（借用同一套启发式）
      const forced: GameState = { ...state, players: state.players.map(p => ({ ...p, isAI: true })) }
      action = getFallbackAction(forced)
      if (!action) action = randomChoice(legal).action
    } else {
      action = randomChoice(legal).action
    }

    if (!validateAction(state, action)) {
      if (trace) console.log(recentTrace.join('\n'))
      return {
        ok: false, steps,
        reason: `第${steps}步：种子${seed} 生成的动作未通过validateAction自检 action=${JSON.stringify(action)}`,
        finalPhase: state.phase, playerCount,
      }
    }

    const next = gameReducer(state, action)
    if (!next) {
      if (trace) console.log(recentTrace.join('\n'))
      return { ok: false, steps, reason: `第${steps}步：reducer返回null`, finalPhase: state.phase, playerCount }
    }

    // 核心冻结检测：合法动作非空、且通过了validateAction自检，
    // 但reducer返回的stateVersion没有推进——说明validator与reducer的
    // 判断口径不一致，这正是本轮重构要消灭的那类bug。
    if (next.stateVersion === lastVersion) {
      if (trace) console.log(recentTrace.join('\n'))
      return {
        ok: false, steps,
        reason: `第${steps}步：stateVersion未推进（${lastVersion}），action=${JSON.stringify(action)} phase=${state.phase}`,
        finalPhase: state.phase, playerCount,
      }
    }
    lastVersion = next.stateVersion
    state = next
  }

  if (!state || state.phase !== 'GAME_OVER') {
    if (trace) console.log(recentTrace.join('\n'))
    return { ok: false, steps, reason: `超过${maxSteps}步未结束`, finalPhase: state?.phase, playerCount }
  }

  return { ok: true, steps, finalPhase: state.phase, playerCount }
}

function main() {
  const traceSeed = process.argv[3] ? Number(process.argv[3]) : null
  if (traceSeed !== null) {
    const playerCount = Number(process.argv[2])
    const mode = (process.argv[4] as 'fallback' | 'random') ?? 'fallback'
    console.log(`单局追踪：玩家数=${playerCount} seed=${traceSeed} mode=${mode}`)
    const result = runOneGame(playerCount, mode, traceSeed, true)
    console.log(result)
    return
  }

  const onlyMode = (process.env.SIM_MODE as 'fallback' | 'random' | undefined) ?? null
  const totalGames = Number(process.argv[2] ?? 200)
  const playerCounts = [3, 4, 5, 6]
  let failCount = 0
  let totalSteps = 0
  const failures: RunResult[] = []

  console.log(`开始仿真 ${totalGames} 局（模式: ${onlyMode ?? '各半 fallback/random'}，步数预算 fallback=${FALLBACK_MAX_STEPS} random=${RANDOM_MAX_STEPS}）…`)

  for (let i = 0; i < totalGames; i++) {
    const playerCount = playerCounts[i % playerCounts.length]
    const mode = onlyMode ?? (i % 2 === 0 ? 'fallback' : 'random')
    const result = runOneGame(playerCount, mode, i)
    totalSteps += result.steps
    if (!result.ok) {
      failCount++
      failures.push(result)
      console.error(`✗ 局#${i} [${playerCount}人/${mode}] 失败: ${result.reason}`)
    } else if (i % 50 === 0) {
      console.log(`  ✓ 局#${i} [${playerCount}人/${mode}] 完成，用了${result.steps}步`)
    }
  }

  console.log(`\n===== 仿真结果 =====`)
  console.log(`总局数: ${totalGames}, 失败: ${failCount}, 平均步数: ${(totalSteps / totalGames).toFixed(1)}`)
  if (failCount > 0) {
    console.log('\n失败详情前10条：')
    for (const f of failures.slice(0, 10)) console.log(' -', f.reason)
    process.exit(1)
  } else {
    console.log('全部通过！无冻结、无reducer/validator不一致、无死循环。')
  }
}

main()
