// ============================================================
// StartScreen — 开局设置：人数 / 版本（15·16·22·30 笔）/ 种子
// ============================================================

import { useState } from 'react'
import type { GameVariantId } from '../engine/types'
import { hasSavedGame } from '../utils/storage'
import { isLLMConfigured } from '../ai/llmClient'
import { AI_ROSTER, VARIANT_LIST, HAND_LIMIT } from '../engine/config'

interface StartScreenProps {
  onStart: (count: number, name: string, seed?: number, variantId?: GameVariantId) => void
  onContinue: () => void
  onSettings: () => void
}

const COUNTS = [3, 4, 5, 6]

export default function StartScreen({ onStart, onContinue, onSettings }: StartScreenProps) {
  const [playerName, setPlayerName] = useState('')
  const [playerCount, setPlayerCount] = useState(4)
  const [variantId, setVariantId] = useState<GameVariantId>('classic')
  const [seedText, setSeedText] = useState('')
  const canContinue = hasSavedGame()
  const llmOn = isLLMConfigured()
  const variant = VARIANT_LIST.find(v => v.id === variantId) ?? VARIANT_LIST[0]

  const start = () => {
    const seed = seedText.trim() === '' ? undefined : (Math.abs(Math.floor(Number(seedText))) >>> 0) || undefined
    onStart(playerCount, playerName.trim() || '你', seed, variantId)
  }

  return (
    <div className="start-screen">
      <h1>I'm the Boss!</h1>
      <p className="subtitle">我是大老板 — 谈判博弈桌游 · 与 AI 同桌讨价还价</p>

      <div className="setup-card">
        <div className="llm-badge">{llmOn ? '🤖 LLM 电脑玩家已启用' : '🎲 使用内置启发式 AI（可在设置中启用 LLM）'}</div>

        <div className="form-group">
          <label>你的名字</label>
          <input value={playerName} onChange={e => setPlayerName(e.target.value)} placeholder="输入名字" maxLength={12}
            onKeyDown={e => e.key === 'Enter' && start()} />
        </div>

        <div className="form-group">
          <label>玩家人数（含你）</label>
          <div className="player-count-selector">
            {COUNTS.map(c => (
              <button key={c} type="button" className={`player-count-btn${c === playerCount ? ' active' : ''}`} onClick={() => setPlayerCount(c)}>{c} 人</button>
            ))}
          </div>
          <p className="form-hint">{playerCount === 3 ? '每人 2 张投资者牌' : playerCount === 6 ? '每人 1 张投资者牌' : `每人 1 张投资者牌，${6 - playerCount} 张放公共区（需招募取得）`}</p>
          <p className="form-hint">{playerCount - 1} 位对手从牌桌常客中随机抽出：{AI_ROSTER.map(r => r.name).join('、')}</p>
        </div>

        <div className="form-group">
          <label>对局版本</label>
          <div className="variant-selector">
            {VARIANT_LIST.map(v => (
              <button
                key={v.id}
                type="button"
                className={`variant-btn${v.id === variantId ? ' active' : ''}`}
                onClick={() => setVariantId(v.id)}
                title={v.blurb}
              >
                <span className="variant-name">{v.name}</span>
                <span className="variant-meta">{v.deals} 笔 · {v.boardSize} 格 · {v.deckSize} 张牌</span>
              </button>
            ))}
          </div>
          <p className="form-hint">{variant.blurb}</p>
          <p className="form-hint">
            {variant.rareCards ? `含稀有牌（利好 / 利空 / 独家协议）· ` : ''}
            {variant.specialSpaces ? '含特殊格（地标 / 抢手 / 黑市 / 猎头）· ' : ''}
            股价 $2M → ${variant.maxShare}M · 第 {variant.firstEndDeal} 笔起可能终局 · 手牌上限 {HAND_LIMIT}
          </p>
        </div>

        <div className="form-group">
          <label>对局种子（可选，同一种子可复现发牌与骰子）</label>
          <input value={seedText} onChange={e => setSeedText(e.target.value)} placeholder="留空随机" inputMode="numeric" />
        </div>

        <button className="btn-primary" onClick={start}>开始新游戏</button>
        {canContinue && <button className="btn continue-btn" onClick={onContinue}>继续上一局</button>}
        <button className="btn settings-link" onClick={onSettings}>⚙️ LLM 设置</button>
      </div>

      <div className="start-tips">
        <p>💡 用别人的投资者必须给分成，对方可以拒绝；同家族多个代表时 Boss 只选一个</p>
        <p>💡 旅行 / 招募 / 老板牌可被阻止牌取消；宣布成交后其他人还有最后一次出牌机会</p>
        <p>💡 最后一位常驻投资者被夺走时，你获得"夺回权"：只需 1 张招募牌即可抢回</p>
      </div>
    </div>
  )
}
