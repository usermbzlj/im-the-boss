// ============================================================
// App — 主入口与整体布局
//   顶栏 / 阶段引导 / [版图 + 底部操作区与手牌] + [侧栏：谈判桌 · 日志 · 历史]
// 状态与 AI 驱动全部在 GameSession 内；这里只读快照、发动作、管理面板开关。
//
// 响应式（断点与 styles/game.css 的 @media、ui/layout.ts 一致）：
//   · ≥1024：侧栏常驻；<1024（平板 / 手机）：侧栏变抽屉——行动区上方有一条手柄（DrawerHandle，带未读提示）一键打开，
//     平板是右侧抽屉，手机是底部全屏 sheet；抽屉打开时按弹层处理（role="dialog"、焦点圈、Esc 关闭、焦点还给手柄）。
//   · 手机顶栏：次要入口（规则 / 设置 / 返回 / 复盘 / AI 状态）收进"更多"菜单，速度 / 快进 / 音效留在外面。
//   · 行动区与手牌包在 .table-bottom 里：桌面上只是把两块叠在一起（视觉与旧版一致），手机上固定在底部、行动区自己滚动、手牌始终可见。
// ============================================================

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
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
import HeaderMenu, { type MenuItem } from './components/HeaderMenu'
import DrawerHandle from './components/DrawerHandle'
import LiveAnnouncer from './components/LiveAnnouncer'
import TouchHints from './components/TouchHints'
import { useLayout } from './components/useLayout'
import { useUnread } from './components/useUnread'
import { useModalDismiss } from './components/useModalDismiss'
import { useTurnAlert } from './components/useTurnAlert'
import { useTurnChime } from './components/useTurnChime'
import { markFastForward } from './ui/motion'
import { ViewerProvider } from './components/ViewerContext'
import { useSideTab, type SideTab } from './components/useSideTab'
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

/** 侧栏抽屉打开期间的弹层行为（Esc 关闭、焦点圈、关闭后焦点回手柄）：只在抽屉模式 + 打开时挂载 */
function DrawerBehavior({ rootRef, onClose }: { rootRef: RefObject<HTMLElement | null>; onClose: () => void }) {
  useModalDismiss(false, onClose, rootRef)
  return null
}

export default function App() {
  const { snapshot, start, leave, act, continueSaved, getState, skipWait, getLog, getOrigin } = useGameSession()
  const state = snapshot?.state ?? null
  const thinkingId = snapshot?.thinkingId ?? null
  const layoutEnv = useLayout()
  const [showHelp, setShowHelp] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showOffer, setShowOffer] = useState(false)
  /** 平板 / 手机：侧栏抽屉是否打开（桌面档位侧栏常驻，此值无意义） */
  const [sideOpen, setSideOpen] = useState(false)
  const sidebarRef = useRef<HTMLElement>(null)
  const sidebarId = useId()
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

  // 抽屉模式：切回桌面档位时收起；未读 = 抽屉收起期间别人的重要动态（与提示框同一套筛选）
  const drawer = layoutEnv.drawer
  useEffect(() => { if (!drawer) setSideOpen(false) }, [drawer])
  useEffect(() => { if (!state) setSideOpen(false) }, [state])
  const sideVisible = !drawer || sideOpen
  const unread = useUnread(state, VIEWER_ID, sideVisible)
  /** 切到某个标签；抽屉模式下顺手把抽屉打开（用户明确想看那一页） */
  const openSide = (tab: SideTab) => { pickTab(tab); if (drawer) setSideOpen(true) }

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
        <TouchHints />
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

  const goHome = () => { if (confirm('返回开始界面？当前对局会保留存档，可随时继续。')) leave() }
  const phone = layoutEnv.tier === 'phone'
  const showReplayBtn = gameOver && !!recording && replayAt === null
  const showResultBtn = gameOver && resultDismissed
  const menuItems: MenuItem[] = [
    ...(showReplayBtn ? [{ key: 'replay', icon: '🎞', label: '逐步复盘', accent: true, onSelect: () => setReplayAt(0) }] : []),
    ...(showResultBtn ? [{ key: 'result', icon: '🏆', label: '查看最终结果', accent: true, onSelect: () => setResultDismissed(false) }] : []),
    { key: 'help', icon: '📖', label: '规则速查', onSelect: () => setShowHelp(true) },
    { key: 'settings', icon: '⚙️', label: '设置', onSelect: () => setShowSettings(true) },
    { key: 'home', icon: '🏠', label: '返回开始界面', onSelect: goHome },
  ]

  return (
    <ViewerProvider viewerId={VIEWER_ID}>
    <CueProvider state={state} viewerId={VIEWER_ID}>
    <div className="app">
      <button type="button" className="skip-link" onClick={() => document.getElementById('action-area')?.focus()}>跳到行动区</button>
      <header className="app-header">
        <h1>I'm the Boss!</h1>
        <div className="header-info" role="group" aria-label="对局信息">
          <span className="variant-tag" title={getVariant(state.variantId).blurb}>{getVariant(state.variantId).name}</span>
          {state.houseRules && <span className="variant-tag house-tag" title="桌规已开启：换牌 / 买牌 / 兑换招募牌 / 病假牌">桌规</span>}
          <span className="stat-chip">成交 <b>{state.completedDeals}/{state.dealTiles.length}</b></span>
          <span className="stat-chip">股价 <b>${tile?.shareValue ?? 0}M</b></span>
          {tile && tile.endFaces.length > 0 && <span className="stat-chip endgame-tag">终局 {getEndProbability(tile)}%</span>}
          <span className="stat-chip muted">牌堆 {state.drawPile.length}</span>
        </div>
        <div className="header-actions">
          {!phone && <AiStatusBadge status={snapshot!.ai} />}
          <PaceControls canSkip={canSkipWait(state, legal)} onSkip={() => { markFastForward(); skipWait() }} syncKey={showSettings} />
          <SoundControl />
          {phone ? (
            <HeaderMenu items={menuItems} info={<AiStatusBadge status={snapshot!.ai} />} dot={showReplayBtn || showResultBtn} />
          ) : (
            <>
              {showReplayBtn && <button className="btn btn-sm result-fab" onClick={() => setReplayAt(0)}>逐步复盘</button>}
              {showResultBtn && <button className="btn btn-sm result-fab" onClick={() => setResultDismissed(false)}>查看最终结果</button>}
              <button className="btn-icon" onClick={() => setShowHelp(true)} title="规则速查" aria-label="规则速查">📖</button>
              <button className="btn-icon" onClick={() => setShowSettings(true)} title="设置" aria-label="设置">⚙️</button>
              <button className="btn-icon" onClick={goHome} title="返回开始界面" aria-label="返回开始界面">🏠</button>
            </>
          )}
        </div>
      </header>

      <PhaseGuide state={state} />
      <RecentStrip state={state} />

      <div className="app-body">
        <main className="table-area" id="main">
          <CueStage />
          <TableBoard state={state} thinkingId={thinkingId} onPlaceMarker={id => act({ type: 'PLACE_MARKER', playerId: VIEWER_ID, spaceId: id })} />
          {/* 结算卡与提示框共用一个贴在版图下沿的竖向栈：互不遮挡，也不挡座位行（金钱飞向座位的演出在那里） */}
          <div className="float-anchor">
            <div className="float-stack">
              <DealResultCard state={state} onDetails={() => openSide('history')} />
              <ToastLayer state={state} />
            </div>
          </div>
          {/* 桌面：行动区 + 手牌叠在一起；平板 / 手机：另含侧栏手柄，手机上固定在底部 */}
          <div className="table-bottom" id="action-area" tabIndex={-1} role="region" aria-label="行动区与手牌">
            {drawer && <DrawerHandle open={sideOpen} negotiating={hasNeg} unread={unread} controlsId={sidebarId} onToggle={() => setSideOpen(v => !v)} />}
            <ActionDock
              state={state} legal={legal} act={act}
              selection={selection} selectMode={selectMode}
              onToggleTradeMode={() => setTradeMode(v => !v)}
              onOpenOfferEditor={() => setShowOffer(true)}
            />
            <CardHand state={state} legal={legal} act={act} selectMode={selectMode} selection={selection} onToggleSelect={toggleSelect} />
          </div>
        </main>

        {drawer && sideOpen && <div className="sidebar-backdrop" onClick={() => setSideOpen(false)} aria-hidden="true" />}
        <aside
          id={sidebarId} ref={sidebarRef} className={`sidebar${sideOpen ? ' open' : ''}`} aria-label="谈判桌与日志"
          {...(drawer && sideOpen ? { role: 'dialog' } : null)}
          aria-hidden={drawer && !sideOpen ? true : undefined}
        >
          {drawer && sideOpen && <DrawerBehavior rootRef={sidebarRef} onClose={() => setSideOpen(false)} />}
          <div className="sidebar-head">
            <div className="sidebar-tabs" role="tablist" aria-label="侧栏">
              {hasNeg && <button role="tab" aria-selected={sideTab === 'neg'} className={`side-tab${sideTab === 'neg' ? ' active' : ''}`} onClick={() => pickTab('neg')}>谈判桌</button>}
              <button role="tab" aria-selected={sideTab === 'log'} className={`side-tab${sideTab === 'log' ? ' active' : ''}`} onClick={() => pickTab('log')}>日志</button>
              <button role="tab" aria-selected={sideTab === 'history'} className={`side-tab${sideTab === 'history' ? ' active' : ''}`} onClick={() => pickTab('history')}>
                交易历史{state.dealHistory.length > 0 && ` (${state.dealHistory.length})`}
              </button>
            </div>
            {drawer && <button type="button" className="sidebar-close" aria-label="收起侧栏" onClick={() => setSideOpen(false)}>✕</button>}
          </div>
          <div className="sidebar-panel" role="tabpanel">
            {sideTab === 'neg' && hasNeg ? <NegotiationPanel state={state} />
              : sideTab === 'history' ? <DealHistoryPanel
                state={state}
                highlights={review?.highlights}
                reviewable={gameOver && !!recording}
                onReviewDeal={n => setReplayAt(recording?.positionOpened(n) ?? 0)}
                onReviewHighlight={openHighlight}
              />
                : <GameLog state={state} />}
          </div>
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
      <LiveAnnouncer state={state} viewerId={VIEWER_ID} attention={attention} />
      <TouchHints />
    </div>
    </CueProvider>
    </ViewerProvider>
  )
}
