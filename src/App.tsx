// ============================================================
// App — 主入口与整体布局
//   顶栏 / 阶段引导 / [版图 + 底部操作区与手牌] + [侧栏：谈判桌 · 日志 · 历史]
// 状态与 AI 驱动全部在 GameSession 内；这里只读快照、发动作、管理面板开关。
// ============================================================

import { useEffect, useMemo, useState } from 'react'
import { useGameSession } from './hooks/useGameSession'
import StartScreen from './components/StartScreen'
import TableBoard from './components/TableBoard'
import CardHand from './components/CardHand'
import ActionDock from './components/ActionDock'
import GameLog from './components/GameLog'
import DealHistoryPanel from './components/DealHistoryPanel'
import NegotiationPanel from './components/NegotiationPanel'
import OfferEditor from './components/OfferEditor'
import PhaseGuide from './components/PhaseGuide'
import HelpPanel from './components/HelpPanel'
import SettingsPanel from './components/SettingsPanel'
import { getCurrentTile, getEndProbability } from './engine/rules'
import { getLegalActions } from './engine/validator'
import { loadSavedGame, clearSavedGame } from './utils/storage'

const HUMAN_ID = 0
type SideTab = 'neg' | 'log' | 'history'

export default function App() {
  const { snapshot, start, load, leave, act } = useGameSession()
  const state = snapshot?.state ?? null
  const thinkingId = snapshot?.thinkingId ?? null
  const [showHelp, setShowHelp] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showOffer, setShowOffer] = useState(false)
  const [sideTab, setSideTab] = useState<SideTab>('log')
  const [discardSelection, setDiscardSelection] = useState<Set<number>>(new Set())
  const [resultDismissed, setResultDismissed] = useState(false)
  const gameOver = state?.phase === 'GAME_OVER'
  useEffect(() => { if (!gameOver) setResultDismissed(false) }, [gameOver])

  const legal = useMemo(() => (state ? getLegalActions(state, HUMAN_ID) : []), [state])
  const hasNeg = !!state?.negotiation

  // 谈判开始自动切到谈判页，结束切回日志
  useEffect(() => { setSideTab(hasNeg ? 'neg' : 'log') }, [hasNeg])

  // 离开手牌上限阶段 / 手牌变化时清空弃牌选择
  const inHandLimit = state?.phase === 'HAND_LIMIT' && state.currentId === HUMAN_ID
  useEffect(() => { if (!inHandLimit) setDiscardSelection(new Set()) }, [inHandLimit, state?.stateVersion])

  // 方案编辑器只在我是 Boss 且轮到我时有效
  const canEditOffer = !!state && state.phase === 'NEGOTIATION' && state.negotiation?.bossId === HUMAN_ID && state.negotiation.turnId === HUMAN_ID
  useEffect(() => { if (!canEditOffer) setShowOffer(false) }, [canEditOffer])

  if (!state) {
    return (
      <>
        <StartScreen
          onStart={(count, name, seed) => start(count, name, seed)}
          onContinue={() => { const saved = loadSavedGame(); if (saved) load(saved) }}
          onSettings={() => setShowSettings(true)}
        />
        <SettingsPanel open={showSettings} onClose={() => setShowSettings(false)} />
      </>
    )
  }

  const tile = getCurrentTile(state)
  const toggleDiscard = (id: number) => setDiscardSelection(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  return (
    <div className="app">
      <header className="app-header">
        <h1>I'm the Boss!</h1>
        <div className="header-info">
          <span>成交 {state.completedDeals}/15</span>
          <span>股价 ${tile?.shareValue ?? 0}M</span>
          {tile && tile.endFaces.length > 0 && <span className="endgame-tag">终局 {getEndProbability(tile)}%</span>}
          <span className="muted">牌堆 {state.drawPile.length}</span>
        </div>
        <div className="header-actions">
          <button className="btn-icon" onClick={() => setShowHelp(true)} title="规则速查">📖</button>
          <button className="btn-icon" onClick={() => setShowSettings(true)} title="设置">⚙️</button>
          <button className="btn-icon" onClick={() => { if (confirm('返回开始界面？当前对局会保留存档，可随时继续。')) leave() }} title="返回开始界面">🏠</button>
        </div>
      </header>

      <PhaseGuide state={state} />

      <div className="app-body">
        <div className="table-area">
          <TableBoard state={state} thinkingId={thinkingId} onPlaceMarker={id => act({ type: 'PLACE_MARKER', playerId: HUMAN_ID, spaceId: id })} />
          <ActionDock state={state} legal={legal} act={act} discardSelection={discardSelection} onOpenOfferEditor={() => setShowOffer(true)} />
          <CardHand state={state} legal={legal} act={act} discardMode={!!inHandLimit} discardSelection={discardSelection} onToggleDiscard={toggleDiscard} />
        </div>

        <aside className="sidebar">
          <div className="sidebar-tabs">
            {hasNeg && <button className={`side-tab${sideTab === 'neg' ? ' active' : ''}`} onClick={() => setSideTab('neg')}>谈判桌</button>}
            <button className={`side-tab${sideTab === 'log' ? ' active' : ''}`} onClick={() => setSideTab('log')}>日志</button>
            <button className={`side-tab${sideTab === 'history' ? ' active' : ''}`} onClick={() => setSideTab('history')}>
              交易历史{state.dealHistory.length > 0 && ` (${state.dealHistory.length})`}
            </button>
          </div>
          {sideTab === 'neg' && hasNeg ? <NegotiationPanel state={state} />
            : sideTab === 'history' ? <DealHistoryPanel state={state} />
              : <GameLog state={state} />}
        </aside>
      </div>

      {showOffer && canEditOffer && (
        <OfferEditor
          state={state}
          onClose={() => setShowOffer(false)}
          onSubmit={(repKeys, payouts) => { act({ type: 'PROPOSE_OFFER', playerId: HUMAN_ID, repKeys, payouts }); setShowOffer(false) }}
        />
      )}

      {gameOver && resultDismissed && (
        <button className="btn result-fab" onClick={() => setResultDismissed(false)}>查看最终结果</button>
      )}
      {gameOver && !resultDismissed && (
        <div className="modal-overlay">
          <div className="game-over-card">
            <h2>🎉 游戏结束</h2>
            <p className="winner-name">
              {state.winnerIds.map(id => state.players[id].name).join('、')}{state.winnerIds.length > 1 ? ' 并列' : ''}获胜！
            </p>
            <div className="final-standings">
              {[...state.players].sort((a, b) => b.cash - a.cash).map((p, i) => (
                <div key={p.id} className={`standing${state.winnerIds.includes(p.id) ? ' winner' : ''}`}>
                  <span>{i + 1}. {p.name}{p.id === HUMAN_ID ? '（你）' : ''}</span>
                  <span>${p.cash}M</span>
                </div>
              ))}
            </div>
            <div className="neg-actions">
              <button className="btn-primary" onClick={() => { clearSavedGame(); leave() }}>再来一局</button>
              <button className="btn" onClick={() => { setSideTab('history'); setResultDismissed(true) }}>回牌桌复盘</button>
            </div>
          </div>
        </div>
      )}

      <HelpPanel open={showHelp} onClose={() => setShowHelp(false)} />
      <SettingsPanel open={showSettings} onClose={() => setShowSettings(false)} />
    </div>
  )
}
