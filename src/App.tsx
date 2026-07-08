// ============================================================
// App — 主入口
// ============================================================

import { useState } from 'react'
import { useGame } from './hooks/useGame'
import StartScreen from './components/StartScreen'
import TableBoard from './components/TableBoard'
import CardHand from './components/CardHand'
import GameLog from './components/GameLog'
import DealHistoryPanel from './components/DealHistoryPanel'
import NegotiationPanel from './components/NegotiationPanel'
import PhaseGuide from './components/PhaseGuide'
import HelpPanel from './components/HelpPanel'
import SettingsPanel from './components/SettingsPanel'
import { getGrossDealValue, getCurrentDealTile, getEndGameProbability } from './engine/gameEngine'
import { getActingPlayerId } from './engine/validator'
import { loadSavedGame } from './utils/storage'

export default function App() {
  const { state, dispatch, startGame, loadGame } = useGame()
  const [gameStarted, setGameStarted] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [sidebarTab, setSidebarTab] = useState<'log' | 'history'>('log')

  if (!gameStarted || !state) {
    return (
      <>
        <StartScreen
          onStart={(count, name) => { startGame(count, name); setGameStarted(true) }}
          onContinue={() => {
            const saved = loadSavedGame()
            if (saved) { loadGame(saved); setGameStarted(true) }
          }}
          onSettings={() => setShowSettings(true)}
        />
        <SettingsPanel open={showSettings} onClose={() => setShowSettings(false)} />
      </>
    )
  }

  const tile = getCurrentDealTile(state)
  const gross = getGrossDealValue(state)
  const actingId = getActingPlayerId(state)
  const isHumanActing = actingId === 0 && !state.players[0]?.isAI
  const inOverlay = ['NEGOTIATION', 'REACTION_WINDOW', 'CONSENT_CHECK'].includes(state.phase) && !!state.negotiation

  return (
    <div className="app">
      <header className="app-header">
        <h1>我是大老板</h1>
        <div className="header-info">
          <span>交易 {state.completedDeals}/15</span>
          <span>股价 ${tile?.shareValue}M</span>
          {state.completedDeals >= 9 && tile && (
            <span className="endgame-tag">终局 {getEndGameProbability(tile)}%</span>
          )}
          <span className="muted">牌堆{state.drawPile.length}</span>
        </div>
        <div className="header-actions">
          <button className="btn-icon" onClick={() => setShowHelp(true)} title="规则">📖</button>
          <button className="btn-icon" onClick={() => setShowSettings(true)} title="设置">⚙️</button>
        </div>
      </header>

      <PhaseGuide state={state} />

      <div className="app-body">
        <div className="table-area">
          <TableBoard
            state={state}
            onChooseMarker={id => dispatch({ type: 'CHOOSE_MARKER_POSITION', spaceId: id })}
          />

          {/* 人类行动按钮 */}
          {isHumanActing && !inOverlay && (
            <div className="action-bar">
              {state.phase === 'TURN_START' && (
                <>
                  <button className="btn btn-success" onClick={() => dispatch({ type: 'CHOOSE_DEAL' })}>
                    发起交易 ${gross}M
                  </button>
                  <button className="btn" onClick={() => dispatch({ type: 'CHOOSE_ROLL' })}>🎲 掷骰移动</button>
                </>
              )}
              {state.phase === 'POST_MOVE_CHOICE' && (
                <>
                  <button className="btn btn-success" onClick={() => dispatch({ type: 'CHOOSE_DEAL' })}>
                    发起交易 ${gross}M
                  </button>
                  <button className="btn" onClick={() => dispatch({ type: 'CHOOSE_DRAW' })}>抽3张牌</button>
                </>
              )}
              {state.phase === 'END_GAME_ROLL' && (
                <button className="btn btn-danger" onClick={() => dispatch({ type: 'ROLL_DIE' })}>
                  掷骰判定终局
                </button>
              )}
            </div>
          )}

          <CardHand state={state} dispatch={dispatch} />
        </div>

        <aside className="log-sidebar">
          <div className="log-sidebar-tabs">
            <button className={`log-tab${sidebarTab === 'log' ? ' active' : ''}`} onClick={() => setSidebarTab('log')}>
              游戏日志
            </button>
            <button className={`log-tab${sidebarTab === 'history' ? ' active' : ''}`} onClick={() => setSidebarTab('history')}>
              交易历史 {state.dealHistory.length > 0 && `(${state.dealHistory.length})`}
            </button>
          </div>
          {sidebarTab === 'log' ? <GameLog log={state.log} /> : <DealHistoryPanel state={state} />}
        </aside>
      </div>

      {inOverlay && (
        <NegotiationPanel state={state} dispatch={dispatch} />
      )}

      {state.phase === 'GAME_OVER' && (
        <div className="game-over-overlay">
          <div className="game-over-card">
            <h2>🎉 游戏结束</h2>
            {state.winnerIds.length > 1 ? (
              <p className="winner-name">{state.winnerIds.map(id => state.players[id].name).join('、')} 并列获胜！</p>
            ) : (
              <p className="winner-name">{state.players[state.winnerId!]?.name} 获胜！</p>
            )}
            <div className="final-standings">
              {[...state.players].sort((a, b) => b.cash - a.cash).map((p, i) => (
                <div key={p.id} className={`standing${state.winnerIds.includes(p.id) ? ' winner' : ''}`}>
                  <span>{i + 1}. {p.name}{p.id === 0 ? '（你）' : ''}</span>
                  <span>${p.cash}M</span>
                </div>
              ))}
            </div>
            <button className="btn-primary" onClick={() => setGameStarted(false)}>再来一局</button>
          </div>
        </div>
      )}

      <HelpPanel open={showHelp} onClose={() => setShowHelp(false)} />
      <SettingsPanel open={showSettings} onClose={() => setShowSettings(false)} />
    </div>
  )
}
