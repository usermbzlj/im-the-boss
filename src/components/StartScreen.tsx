// ============================================================
// StartScreen
// ============================================================

import { useState } from 'react'
import { hasSavedGame } from '../utils/storage'
import { isLLMConfigured } from '../ai/llmClient'

interface StartScreenProps {
  onStart: (count: number, name: string) => void
  onContinue: () => void
  onSettings: () => void
}

const COUNTS = [3, 4, 5, 6]

export default function StartScreen({ onStart, onContinue, onSettings }: StartScreenProps) {
  const [playerName, setPlayerName] = useState('')
  const [playerCount, setPlayerCount] = useState(4)
  const canContinue = hasSavedGame()
  const llmOn = isLLMConfigured()

  return (
    <div className="start-screen">
      <h1>我是大老板</h1>
      <p className="subtitle">I'm the Boss! — 谈判博弈桌游</p>

      <div className="setup-card">
        <div className="llm-badge">{llmOn ? '🤖 LLM 电脑玩家已启用' : '🎲 将使用基础 AI（可在设置中启用 LLM）'}</div>

        <div className="form-group">
          <label>你的名字</label>
          <input value={playerName} onChange={e => setPlayerName(e.target.value)} placeholder="输入名字" maxLength={12}
            onKeyDown={e => e.key === 'Enter' && onStart(playerCount, playerName.trim() || '你')} />
        </div>

        <div className="form-group">
          <label>玩家人数（含你）</label>
          <div className="player-count-selector">
            {COUNTS.map(c => (
              <button key={c} type="button"
                className={`player-count-btn${c === playerCount ? ' active' : ''}`}
                onClick={() => setPlayerCount(c)}>{c}人</button>
            ))}
          </div>
        </div>

        <button className="btn-primary" onClick={() => onStart(playerCount, playerName.trim() || '你')}>
          开始新游戏
        </button>
        {canContinue && (
          <button className="btn continue-btn" onClick={onContinue}>继续上一局</button>
        )}
        <button className="btn settings-link" onClick={onSettings}>⚙️ LLM 设置</button>
      </div>

      <div className="start-tips">
        <p>💡 使用他人投资者须合理分成，对方可拒绝出借</p>
        <p>💡 旅行/老板/招募牌可被阻止牌反制</p>
      </div>
    </div>
  )
}
