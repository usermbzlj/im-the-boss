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
import GameOverCard from './components/GameOverCard'
import ReplayViewer from './components/review/ReplayViewer'
import { useRecording } from './components/review/useRecording'
import RecentStrip from './components/RecentStrip'
import ToastLayer from './components/ToastLayer'
import DealResultCard from './components/DealResultCard'
import PaceControls from './components/PaceControls'
import AiStatusBadge from './components/AiStatusBadge'
import CueProvider, { NoCues } from './components/CueProvider'
import CueStage from './components/CueStage'
import SoundControl from './components/SoundControl'
import { useTurnAlert } from './components/useTurnAlert'
import { useTurnChime } from './components/useTurnChime'
import { markFastForward } from './ui/motion'
import { ViewerProvider } from './components/ViewerContext'
import { useSideTab } from './components/useSideTab'
import { getCurrentTile, getEndProbability } from './engine/rules'
import { getVariant, MAX_OFFERS_PER_BOSS } from './engine/config'
import { getLegalActions } from './engine/validator'
import { needsAttention, canSkipWait } from './ui/attention'
import { proposeAndClose } from './ui/proposeAndClose'
import { clearSavedGame } from './utils/storage'
import { buildReview } from './ui/review'
import { highlightPosition, type Highlight } from './ui/highlights'

/** 视角玩家：单机版人类固定坐 0 号位；组件通过 ViewerProvider / useViewerId 取得，不再各自写死 */
const VIEWER_ID = 0

export default function App() {
  const { snapshot, start, leave, act, continueSaved, getState, skipWait, getLog, getOrigin } = useGameSession()
  const state = snapshot?.state ?? null
  const thinkingId = snapshot?.thinkingId ?? null
  const [showHelp, setShowHelp] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showOffer, setShowOffer] = useState(false)
  /** 手牌多选：弃牌阶段自动进入 discard；桌规兑换由玩家手动进入 trade */
  const [selection, setSelection] = useState<Set<number>>(new Set())
  const [tradeMode, setTradeMode] = useState(false)
  const [resultDismissed, setResultDismissed] = useState(false)
  const gameOver = state?.phase === 'GAME_OVER'
  useEffect(() => { if (!gameOver) setResultDismissed(false) }, [gameOver])

  // 终局后的复盘：录像由动作日志重放而来（分片整理）；不可回放时 recording 为 null，入口随之隐藏。对局进行中没有复盘入口
  const { recording, status: replayStatus } = useRecording(gameOver, getOrigin(), getLog(), state)
  const review = useMemo(() => (gameOver && state ? buildReview(state, recording) : null), [gameOver, state, recording])
  /** 逐步复盘打开时所在的位置；null = 未打开 */
  const [replayAt, setReplayAt] = useState<number | null>(null)
  useEffect(() => { if (!gameOver) setReplayAt(null) }, [gameOver])
  const openHighlight = (h: Highlight) => { const p = highlightPosition(h); if (p != null) setReplayAt(p) }

  const legal = useMemo(() => (state ? getLegalActions(state, VIEWER_ID) : []), [state])
  const hasNeg = !!state?.negotiation
  // 轮到你且需要你做决定：行动区高亮；页面在后台时标题闪烁
  const attention = !!state && needsAttention(state, legal)
  useTurnAlert(attention)
  useTurnChime(attention)

  // 谈判开始自动切到谈判页（用户手动选过标签就不抢），结束时若停在谈判页则退回日志
  const { sideTab, pickTab } = useSideTab(hasNeg, !!state)

  // 选牌模式：弃牌优先；兑换只在动作仍合法时保持。状态一变（出牌 / 换手）就清空选择
  const inHandLimit = state?.phase === 'HAND_LIMIT' && state.currentId === VIEWER_ID
  const canTrade = legal.some(a => a.type === 'TRADE_CARDS')
  const selectMode: 'discard' | 'trade' | null = inHandLimit ? 'discard' : tradeMode && canTrade ? 'trade' : null
  useEffect(() => { setSelection(new Set()) }, [selectMode, state?.stateVersion])
  useEffect(() => { if (!canTrade) setTradeMode(false) }, [canTrade])

  // 方案编辑器只在我是 Boss、轮到我且还有提案次数时有效
  const canEditOffer = !!state && state.phase === 'NEGOTIATION' && state.negotiation?.bossId === VIEWER_ID && state.negotiation.turnId === VIEWER_ID &&
    state.negotiation.offersMade < MAX_OFFERS_PER_BOSS
  useEffect(() => { if (!canEditOffer) setShowOffer(false) }, [canEditOffer])

  if (!state) {
    return (
      <>
        <StartScreen
          onStart={(count, name, seed, variantId, houseRules) => start(count, name, seed, variantId, houseRules)}
          onContinue={() => { continueSaved() }}
          onSettings={() => setShowSettings(true)}
          syncKey={showSettings}
        />
        <SettingsPanel open={showSettings} onClose={() => setShowSettings(false)} />
      </>
    )
  }

  const tile = getCurrentTile(state)
  const toggleSelect = (id: number) => setSelection(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  return (
    <ViewerProvider viewerId={VIEWER_ID}>
    <CueProvider state={state} viewerId={VIEWER_ID}>
    <div className="app">
      <header className="app-header">
        <h1>I'm the Boss!</h1>
        <div className="header-info">
          <span className="variant-tag" title={getVariant(state.variantId).blurb}>{getVariant(state.variantId).name}</span>
          {state.houseRules && <span className="variant-tag house-tag" title="桌规已开启：换牌 / 买牌 / 兑换招募牌 / 病假牌">桌规</span>}
          <span className="stat-chip">成交 <b>{state.completedDeals}/{state.dealTiles.length}</b></span>
          <span className="stat-chip">股价 <b>${tile?.shareValue ?? 0}M</b></span>
          {tile && tile.endFaces.length > 0 && <span className="stat-chip endgame-tag">终局 {getEndProbability(tile)}%</span>}
          <span className="stat-chip muted">牌堆 {state.drawPile.length}</span>
        </div>
        <div className="header-actions">
          <AiStatusBadge status={snapshot!.ai} />
          <PaceControls canSkip={canSkipWait(state, legal)} onSkip={() => { markFastForward(); skipWait() }} syncKey={showSettings} />
          <SoundControl />
          {gameOver && recording && replayAt === null && (
            <button className="btn btn-sm result-fab" onClick={() => setReplayAt(0)}>逐步复盘</button>
          )}
          {gameOver && resultDismissed && (
            <button className="btn btn-sm result-fab" onClick={() => setResultDismissed(false)}>查看最终结果</button>
          )}
          <button className="btn-icon" onClick={() => setShowHelp(true)} title="规则速查">📖</button>
          <button className="btn-icon" onClick={() => setShowSettings(true)} title="设置">⚙️</button>
          <button className="btn-icon" onClick={() => { if (confirm('返回开始界面？当前对局会保留存档，可随时继续。')) leave() }} title="返回开始界面">🏠</button>
        </div>
      </header>

      <PhaseGuide state={state} />
      <RecentStrip state={state} />

      <div className="app-body">
        <div className="table-area">
          <ToastLayer state={state} />
          <CueStage />
          <DealResultCard state={state} onDetails={() => pickTab('history')} />
          <TableBoard state={state} thinkingId={thinkingId} onPlaceMarker={id => act({ type: 'PLACE_MARKER', playerId: VIEWER_ID, spaceId: id })} />
          <ActionDock
            state={state} legal={legal} act={act}
            selection={selection} selectMode={selectMode}
            onToggleTradeMode={() => setTradeMode(v => !v)}
            onOpenOfferEditor={() => setShowOffer(true)}
          />
          <CardHand state={state} legal={legal} act={act} selectMode={selectMode} selection={selection} onToggleSelect={toggleSelect} />
        </div>

        <aside className="sidebar">
          <div className="sidebar-tabs">
            {hasNeg && <button className={`side-tab${sideTab === 'neg' ? ' active' : ''}`} onClick={() => pickTab('neg')}>谈判桌</button>}
            <button className={`side-tab${sideTab === 'log' ? ' active' : ''}`} onClick={() => pickTab('log')}>日志</button>
            <button className={`side-tab${sideTab === 'history' ? ' active' : ''}`} onClick={() => pickTab('history')}>
              交易历史{state.dealHistory.length > 0 && ` (${state.dealHistory.length})`}
            </button>
          </div>
          {sideTab === 'neg' && hasNeg ? <NegotiationPanel state={state} />
            : sideTab === 'history' ? <DealHistoryPanel
              state={state}
              highlights={review?.highlights}
              reviewable={gameOver && !!recording}
              onReviewDeal={n => setReplayAt(recording?.positionOpened(n) ?? 0)}
              onReviewHighlight={openHighlight}
            />
              : <GameLog state={state} />}
        </aside>
      </div>

      {showOffer && canEditOffer && (
        <OfferEditor
          state={state}
          onClose={() => setShowOffer(false)}
          onSubmit={(repKeys, payouts, closeNow) => {
            setShowOffer(false)
            if (closeNow) proposeAndClose(act, getState, VIEWER_ID, repKeys, payouts)
            else act({ type: 'PROPOSE_OFFER', playerId: VIEWER_ID, repKeys, payouts })
          }}
        />
      )}

      {gameOver && !resultDismissed && (
        <GameOverCard
          state={state}
          onRestart={() => { clearSavedGame(); leave() }}
          onReview={() => { pickTab('history'); setResultDismissed(true) }}
          recording={recording}
          replayStatus={replayStatus}
          review={review ?? undefined}
          onOpenReplay={p => setReplayAt(p ?? 0)}
        />
      )}

      {gameOver && recording && replayAt !== null && (
        <NoCues>
          <ReplayViewer
            state={state}
            recording={recording}
            highlights={review?.highlights ?? []}
            initialPosition={replayAt}
            onClose={() => setReplayAt(null)}
          />
        </NoCues>
      )}

      <HelpPanel open={showHelp} onClose={() => setShowHelp(false)} variantId={state.variantId} houseRules={state.houseRules} />
      <SettingsPanel open={showSettings} onClose={() => setShowSettings(false)} />
    </div>
    </CueProvider>
    </ViewerProvider>
  )
}
