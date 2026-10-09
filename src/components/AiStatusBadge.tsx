// ============================================================
// AiStatusBadge — 顶栏的电脑玩家状态徽标
//   未启用 LLM：显示"启发式"（灰）；LLM 正常：绿；偶尔回退：黄；熔断 / 不可用：红。
//   回退原因与累计次数放在 title 里。
// ============================================================

import type { AiRuntimeStatus } from '../game/session'

export default function AiStatusBadge({ status }: { status: AiRuntimeStatus }) {
  if (!status.llmEnabled) {
    return <span className="ai-badge off" title="电脑玩家使用内置启发式策略（可在设置里启用 LLM）">启发式</span>
  }
  const reason = status.lastFallbackReason ? `最近一次回退：${status.lastFallbackReason}` : ''
  const count = status.fallbackCount > 0 ? `本局已回退 ${status.fallbackCount} 次` : ''
  const detail = [reason, count].filter(Boolean).join('；')
  if (status.health === 'down') {
    return <span className="ai-badge down" title={`LLM 暂时不可用，电脑玩家改用启发式。${detail}`}>LLM 已降级</span>
  }
  if (status.health === 'degraded') {
    return <span className="ai-badge degraded" title={`LLM 偶尔失败，个别决策回退为启发式。${detail}`}>LLM 不稳定</span>
  }
  return <span className="ai-badge ok" title="LLM 电脑玩家运行正常">LLM</span>
}
