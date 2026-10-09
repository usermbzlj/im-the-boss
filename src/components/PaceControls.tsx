// ============================================================
// PaceControls — 顶栏的节奏控制：电脑速度（快 / 中 / 慢）+ 快进
//   速度读写 LLMConfig.aiSpeed（session 每步实时读取，改了立刻生效）；
//   快进 = 跳过当前电脑行动前的停顿，只在"不是在等你做决定"时可点。
// ============================================================

import { useEffect, useState } from 'react'
import { loadLLMConfig, saveLLMConfig, type AISpeed } from '../ai/llmClient'

const SPEEDS: Array<{ id: AISpeed; label: string; title: string }> = [
  { id: 'fast', label: '快', title: '电脑出手快（停顿很短）' },
  { id: 'normal', label: '中', title: '电脑出手速度适中' },
  { id: 'slow', label: '慢', title: '电脑出手慢，便于看清每一步' },
]

interface PaceControlsProps {
  /** 当前能否快进（电脑在行动 / 自动放行窗口） */
  canSkip: boolean
  onSkip: () => void
  /** 变化时重新读取配置（例如设置面板关闭后） */
  syncKey?: unknown
}

export default function PaceControls({ canSkip, onSkip, syncKey }: PaceControlsProps) {
  const [speed, setSpeed] = useState<AISpeed>(() => loadLLMConfig().aiSpeed)
  useEffect(() => { setSpeed(loadLLMConfig().aiSpeed) }, [syncKey])

  const pick = (next: AISpeed) => {
    setSpeed(next)
    try { saveLLMConfig({ ...loadLLMConfig(), aiSpeed: next }) } catch { /* 存储不可用：只改当前显示 */ }
  }

  return (
    <div className="pace-controls">
      <div className="pace-speed" role="group" aria-label="电脑速度">
        <span className="pace-label">电脑速度</span>
        {SPEEDS.map(s => (
          <button key={s.id} type="button" className={`pace-btn${speed === s.id ? ' active' : ''}`} aria-pressed={speed === s.id} title={s.title} onClick={() => pick(s.id)}>
            {s.label}
          </button>
        ))}
      </div>
      <button type="button" className="btn btn-sm pace-skip" disabled={!canSkip} onClick={onSkip}
        title={canSkip ? '跳过电脑行动前的停顿' : '现在轮到你（或没有可跳过的等待）'}>
        快进 ⏩
      </button>
    </div>
  )
}
