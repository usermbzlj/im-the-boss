// ============================================================
// StartScreen — 开局设置：人数 / 版本（15·16·22·30 笔）/ 种子
// ============================================================

import { useEffect, useState } from 'react'
import type { GameVariantId } from '../engine/types'
import { hasSavedGame } from '../utils/storage'
import { parseSeed } from '../utils/seed'
import { isLLMConfigured, loadLLMConfig, saveLLMConfig, TABLE_STYLES, type TableStyle } from '../ai/llmClient'
import { AI_ROSTER, VARIANT_LIST, HAND_LIMIT, BUY_CARDS_COST_SHARES } from '../engine/config'

interface StartScreenProps {
  onStart: (count: number, name: string, seed?: number, variantId?: GameVariantId, houseRules?: boolean) => void
  onContinue: () => void
  onSettings: () => void
  /** 变化时重新读取桌风等配置（例如设置面板关闭后） */
  syncKey?: unknown
}

const COUNTS = [3, 4, 5, 6]

/** 桌风：电脑玩家整体的强硬程度 */
export const TABLE_STYLE_INFO: Record<TableStyle, { name: string; blurb: string }> = {
  friendly: { name: '友好', blurb: '电脑玩家讲人情、好说话，更愿意让利成交——适合熟悉规则。' },
  business: { name: '商战', blurb: '各凭本事、讲价码，不白送也不赶尽杀绝——默认体验。' },
  ruthless: { name: '冷血', blurb: '寸利不让，爱搅局也记仇，谈判更激烈、更考验你。' },
}

function readTableStyle(): TableStyle {
  try {
    const s = loadLLMConfig().tableStyle
    return TABLE_STYLES.includes(s) ? s : 'business'
  } catch {
    return 'business'
  }
}

export default function StartScreen({ onStart, onContinue, onSettings, syncKey }: StartScreenProps) {
  const [tableStyle, setTableStyle] = useState<TableStyle>(readTableStyle)
  useEffect(() => { setTableStyle(readTableStyle()) }, [syncKey])
  const pickStyle = (next: TableStyle) => {
    setTableStyle(next)
    try { saveLLMConfig({ ...loadLLMConfig(), tableStyle: next }) } catch { /* 存储不可用：只对本次显示生效 */ }
  }
  const [playerName, setPlayerName] = useState('')
  const [playerCount, setPlayerCount] = useState(4)
  const [variantId, setVariantId] = useState<GameVariantId>('classic')
  /** 桌规开关：null = 跟随版本默认（经典关、其余开），用户点过则以用户为准 */
  const [houseRulesChoice, setHouseRulesChoice] = useState<boolean | null>(null)
  const [seedText, setSeedText] = useState('')
  const canContinue = hasSavedGame()
  const llmOn = isLLMConfigured()
  const variant = VARIANT_LIST.find(v => v.id === variantId) ?? VARIANT_LIST[0]
  const houseRules = houseRulesChoice ?? variant.houseRules
  const deckSize = variant.deckSize + (houseRules ? variant.sickCards : 0)

  const start = () => {
    pickStyle(tableStyle) // 确保开局读到的就是界面上选中的桌风
    const seed = parseSeed(seedText) // 注意：0 是合法种子，不能用 || 兜底成随机
    onStart(playerCount, playerName.trim() || '你', seed, variantId, houseRules)
  }

  return (
    <div className="start-screen">
      <h1>I'm the Boss!</h1>
      <p className="subtitle">我是大老板 — 谈判博弈桌游 · 与 AI 同桌讨价还价</p>

      <div className="setup-card">
        <div className="llm-badge">{llmOn ? '🤖 LLM 电脑玩家已启用' : '🎲 使用内置启发式 AI（可在设置中启用 LLM）'}</div>

        <div className="form-group">
          <label htmlFor="start-name">你的名字</label>
          <input id="start-name" autoComplete="nickname" enterKeyHint="go" value={playerName} onChange={e => setPlayerName(e.target.value)} placeholder="输入名字" maxLength={12}
            onKeyDown={e => e.key === 'Enter' && start()} />
        </div>

        <div className="form-group">
          <label id="start-count-label">玩家人数（含你）</label>
          <div className="player-count-selector" role="group" aria-labelledby="start-count-label">
            {COUNTS.map(c => (
              <button key={c} type="button" aria-pressed={c === playerCount} className={`player-count-btn${c === playerCount ? ' active' : ''}`} onClick={() => setPlayerCount(c)}>{c} 人</button>
            ))}
          </div>
          <p className="form-hint">{playerCount === 3 ? '每人 2 张投资者牌' : playerCount === 6 ? '每人 1 张投资者牌' : `每人 1 张投资者牌，${6 - playerCount} 张放公共区（需招募取得）`}</p>
          <p className="form-hint">{playerCount - 1} 位对手从牌桌常客中随机抽出：{AI_ROSTER.map(r => r.name).join('、')}</p>
        </div>

        <div className="form-group">
          <label>桌风（电脑玩家的作风）</label>
          <div className="table-style-selector" role="radiogroup" aria-label="桌风">
            {TABLE_STYLES.map(s => (
              <button key={s} type="button" role="radio" aria-checked={s === tableStyle}
                className={`style-btn${s === tableStyle ? ' active' : ''}`} onClick={() => pickStyle(s)}>
                {TABLE_STYLE_INFO[s].name}
              </button>
            ))}
          </div>
          <p className="form-hint">{TABLE_STYLE_INFO[tableStyle].blurb}</p>
        </div>

        <div className="form-group">
          <label id="start-variant-label">对局版本</label>
          <div className="variant-selector" role="group" aria-labelledby="start-variant-label">
            {VARIANT_LIST.map(v => (
              <button
                key={v.id}
                type="button"
                aria-pressed={v.id === variantId}
                className={`variant-btn${v.id === variantId ? ' active' : ''}`}
                onClick={() => { setVariantId(v.id); setHouseRulesChoice(null) }}
                title={v.blurb}
              >
                <span className="variant-name">{v.name}</span>
                <span className="variant-meta">{v.deals} 笔 · {v.boardSize} 格 · {v.deckSize + (v.houseRules ? v.sickCards : 0)} 张牌</span>
              </button>
            ))}
          </div>
          <p className="form-hint">{variant.blurb}</p>
          <p className="form-hint">
            {variant.rareCards ? `含稀有牌（利好 / 利空 / 独家协议）· ` : ''}
            {variant.specialSpaces ? '含特殊格（地标 / 抢手 / 黑市 / 猎头）· ' : ''}
            股价 $2M → ${variant.maxShare}M · 第 {variant.firstEndDeal} 笔起可能终局 · 手牌上限 {HAND_LIMIT} · 本局 {deckSize} 张牌
          </p>
        </div>

        <div className="form-group">
          <label className="check-row" title="桌规是一组可选规则：换牌 / 买牌 / 兑换招募牌 / 病假牌。经典版默认关闭（官方原味），其余版本默认开启">
            <input type="checkbox" checked={houseRules} onChange={e => setHouseRulesChoice(e.target.checked)} />
            <span>桌规 <span className="muted">{houseRules ? '已开启' : '未开启'}{houseRulesChoice == null ? '（版本默认）' : ''}</span></span>
          </label>
          <p className="form-hint house-rules-hint">
            <b>换牌</b>：持有某家族投资者时，手里该家族的成员牌 ↔ 同家族旅行牌（每回合一次）·
            <b>买牌</b>：回合开始付 {BUY_CARDS_COST_SHARES.join(' / ')} 份股价多抽 1 / 2 / 3 张 ·
            <b>兑换</b>：两张不同种类的牌 + 一份股价 → 2 张招募牌 ·
            <b>病假牌 ×{variant.sickCards}</b>：指定一人本回合不能主动出牌
          </p>
        </div>

        <div className="form-group">
          <label htmlFor="start-seed">对局种子（可选，同一种子可复现发牌与骰子）</label>
          <input id="start-seed" value={seedText} onChange={e => setSeedText(e.target.value)} placeholder="留空随机" inputMode="numeric" />
        </div>

        <button className="btn-primary" onClick={start}>开始新游戏</button>
        {canContinue && <button className="btn continue-btn" onClick={onContinue}>继续上一局</button>}
        <button className="btn settings-link" onClick={onSettings}>⚙️ 设置（LLM / 动画）</button>
      </div>

      <div className="start-tips">
        <p>💡 用别人的投资者必须给分成，对方可以拒绝；同家族多个代表时 Boss 只选一个</p>
        <p>💡 旅行 / 招募 / 老板牌可被阻止牌取消；宣布成交后其他人还有最后一次出牌机会</p>
        <p>💡 最后一位常驻投资者被夺走时，你获得"夺回权"：只需 1 张招募牌即可抢回</p>
        <p>💡 桌规：自家投资者多余的成员卡可换成机票打飞竞争者；没招募牌时用两张废牌 + 一份股价换两张，立刻夺回</p>
      </div>
    </div>
  )
}
