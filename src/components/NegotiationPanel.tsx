// ============================================================
// NegotiationPanel — 谈判 / 反应 / 出借确认
// ============================================================
//
// 核心视图是"席位与竞价"：把交易需求按家族分行，每行列出该家族的全部
// 候选代表（谁的、投资者牌还是临时卡、要价多少、是否被打飞、是否已被
// 选入方案），必需/可选、缺口一目了然。Boss 编辑方案时可以在同家族的
// 竞价者之间挑人、并勾选用哪些可选家族——这是"竞价"机制的操作入口。

import { useState } from 'react'
import type { GameState, GameAction, DealContract, Representative, FamilyId } from '../engine/types'
import { FAMILIES } from '../engine/config'
import {
  getGrossDealValue, getCurrentBoardSpace, getCurrentDealTile,
  buildSelectedRepresentatives, canPlayerDemand, getRepCost, validateContractShape,
  MAX_PROPOSALS_PER_BOSS,
} from '../engine/gameEngine'
import FamilyChip from './FamilyChip'

interface NegotiationPanelProps {
  state: GameState
  dispatch: React.Dispatch<GameAction>
}

const HUMAN_ID = 0

const repKey = (r: Representative) => `${r.familyId}:${r.sourceType}:${r.ownerPlayerId}:${r.cardId ?? ''}`

export default function NegotiationPanel({ state, dispatch }: NegotiationPanelProps) {
  const [payouts, setPayouts] = useState<Record<number, number>>({})
  const [showContract, setShowContract] = useState(false)
  const [repPicks, setRepPicks] = useState<Record<string, string>>({})
  const [optPicks, setOptPicks] = useState<FamilyId[]>([])
  const [speakText, setSpeakText] = useState('')
  const [demandAmount, setDemandAmount] = useState(0)
  const [demandFamily, setDemandFamily] = useState<'' | FamilyId>('')
  const [passWarn, setPassWarn] = useState(false)

  const neg = state.negotiation
  const space = getCurrentBoardSpace(state)
  const tile = getCurrentDealTile(state)
  const gross = getGrossDealValue(state)

  // ---------- 反应窗口 ----------
  if (state.phase === 'REACTION_WINDOW' && state.pendingReactionWindow) {
    const pw = state.pendingReactionWindow
    const cardLabel = pw.card.type === 'TRAVEL' ? '旅行牌' : pw.card.type === 'BOSS' ? '老板牌' : '招募三连'
    const actor = state.players.find(p => p.id === pw.playerId)
    const humanTurn = pw.reactorId === HUMAN_ID
    const hasStop = state.players[HUMAN_ID]?.hand.some(c => c.type === 'STOP')

    return (
      <div className="neg-panel reaction">
        <h3>⚠️ {actor?.name} 打出了{cardLabel}</h3>
        <p>目标：{pw.target}</p>
        {humanTurn ? (
          <div className="neg-actions">
            <button className="btn btn-danger" disabled={!hasStop}
              onClick={() => dispatch({ type: 'PLAY_STOP', playerId: HUMAN_ID })}>
              {hasStop ? '🛑 打出阻止牌' : '你没有阻止牌'}
            </button>
            <button className="btn" onClick={() => dispatch({ type: 'PASS_REACTION', playerId: HUMAN_ID })}>
              不干预
            </button>
          </div>
        ) : (
          // 反应资格只发给持有阻止牌的玩家（见 gameEngine nextReactorWithStop），
          // 点名等待对象会泄露"谁手里有阻止牌"，故使用不指名的通用文案。
          <p className="muted">等待其他玩家决定是否反应…</p>
        )}
      </div>
    )
  }

  // ---------- 出借确认 ----------
  if (state.phase === 'CONSENT_CHECK' && neg) {
    const currentId = neg.consentQueue[neg.consentIndex]
    const current = state.players.find(p => p.id === currentId)
    const contract = neg.proposedContract
    const myShare = contract?.payout.find(p => p.playerId === currentId)?.amount ?? 0
    const myReps = contract?.selectedRepresentatives.filter(r => r.ownerPlayerId === currentId) ?? []
    const myDemand = neg.demands.find(d => d.playerId === currentId)
    const humanTurn = currentId === HUMAN_ID
    const remaining = neg.consentQueue.length - neg.consentIndex
    const proposalsLeft = MAX_PROPOSALS_PER_BOSS - neg.proposalCount

    return (
      <div className="neg-panel consent">
        <h3>🤝 出借确认 ({neg.consentIndex + 1}/{neg.consentQueue.length})</h3>
        <p>Boss <b>{state.players[neg.bossPlayerId]?.name}</b> 的方案要使用 <b>{current?.name}{humanTurn ? '（你）' : ''}</b> 的代表：</p>
        <div className="consent-reps">
          {myReps.map((r, i) => (
            <span key={i} className="consent-rep">
              <FamilyChip familyId={r.familyId} size="md" />
              <em>{r.sourceType === 'INVESTOR' ? '投资者牌' : '临时卡（成交后弃掉）'}</em>
            </span>
          ))}
        </div>
        <p className="consent-payout">
          方案分给{humanTurn ? '你' : 'TA'}：<b className={myShare > 0 ? 'green' : 'red'}>${myShare}M</b>
          {myDemand && <span className="muted">（此前要价 ${myDemand.amount}M）</span>}
        </p>
        <p className="muted consent-hint">
          拒绝 → 方案作废回到谈判{proposalsLeft <= 0
            ? '；⚠️ Boss已无提案机会，拒绝将导致整笔交易直接流局'
            : `（Boss还可再提案 ${proposalsLeft} 次）`}
        </p>
        <p className="muted">还剩 {remaining} 人待确认</p>
        {humanTurn ? (
          <div className="neg-actions">
            <button className="btn btn-success" onClick={() => dispatch({ type: 'CONSENT_AGREE', playerId: HUMAN_ID })}>
              ✓ 同意出借（拿 ${myShare}M）
            </button>
            <button className="btn btn-danger" onClick={() => dispatch({ type: 'CONSENT_REFUSE', playerId: HUMAN_ID })}>
              ✗ 拒绝出借
            </button>
          </div>
        ) : (
          <p className="muted">等待 {current?.name} 确认…</p>
        )}
      </div>
    )
  }

  if (state.phase !== 'NEGOTIATION' || !neg || !space) return null

  const boss = state.players[neg.bossPlayerId]
  const isHumanBoss = neg.bossPlayerId === HUMAN_ID
  const isHumanTurn = neg.turnPlayerId === HUMAN_ID
  const turnPlayer = state.players[neg.turnPlayerId]

  const activeReps = neg.representatives.filter(r => !r.isTravelled)
  const activeFamilies = new Set(activeReps.map(r => r.familyId))
  const requiredMet = space.requiredFamilies.every(f => activeFamilies.has(f))
  const optionalHave = space.optionalFamilies.filter(f => activeFamilies.has(f)).length
  const optionalMet = optionalHave >= space.optionalNeed
  const canClose = requiredMet && optionalMet
  const nonBossPlayers = state.players.filter(p => p.id !== neg.bossPlayerId)
  const totalPayout = Object.values(payouts).reduce((s, v) => s + v, 0)
  const bossKeeps = gross - totalPayout
  const passesUntilSettle = state.players.length - neg.passCount
  const speakLeft = 3 - (neg.speakCounts[HUMAN_ID] ?? 0)
  const proposalsLeft = MAX_PROPOSALS_PER_BOSS - neg.proposalCount
  const canPropose = proposalsLeft > 0
  const humanCanDemand = canPlayerDemand(state, HUMAN_ID)

  const relevantSet = new Set<FamilyId>([...space.requiredFamilies, ...space.optionalFamilies])
  const contractKeys = new Set((neg.proposedContract?.selectedRepresentatives ?? []).map(repKey))

  const candidatesOf = (f: FamilyId) =>
    neg.representatives
      .filter(r => r.familyId === f)
      .sort((a, b) =>
        (a.isTravelled ? 1 : 0) - (b.isTravelled ? 1 : 0) ||
        getRepCost(state, a) - getRepCost(state, b))

  const activeCandsOf = (f: FamilyId) => candidatesOf(f).filter(r => !r.isTravelled)

  const demandLabelOf = (r: Representative) => {
    if (r.ownerPlayerId === neg.bossPlayerId) return 'Boss自有'
    const d = neg.demands.find(x => x.playerId === r.ownerPlayerId && (x.familyId === r.familyId || x.familyId == null))
    return d ? `要$${d.amount}M` : '未要价'
  }

  // ---------- 竞价席位行 ----------
  const renderFamilyRow = (f: FamilyId, required: boolean) => {
    const cands = candidatesOf(f)
    const covered = activeFamilies.has(f)
    return (
      <div key={`${f}-${required}`} className="fam-row">
        <div className="fam-head">
          <FamilyChip familyId={f} size="md" />
          <span className={`fam-tag ${required ? 'req' : 'opt'}`}>{required ? '必需' : '可选'}</span>
          <span className={`fam-state ${covered ? 'green' : 'red'}`}>{covered ? '✓' : '缺'}</span>
        </div>
        <div className="fam-cands">
          {cands.length === 0 && <span className="muted">无代表 — 需该家族投资者或有人打出家族成员卡</span>}
          {cands.map(r => (
            <span
              key={repKey(r)}
              className={`cand${r.isTravelled ? ' travelled' : ''}${contractKeys.has(repKey(r)) ? ' in-contract' : ''}`}
              title={r.sourceType === 'INVESTOR' ? '投资者牌（常驻身份）' : '家族成员卡（临时身份，被选用成交后弃掉）'}
            >
              {contractKeys.has(repKey(r)) && <b className="cand-star">★</b>}
              {state.players[r.ownerPlayerId]?.name}{r.ownerPlayerId === HUMAN_ID ? '(你)' : ''}
              <em>{r.sourceType === 'INVESTOR' ? '投资者' : '临时卡'}</em>
              {r.isTravelled
                ? <b className="red">已打飞</b>
                : <i className="cand-price">{demandLabelOf(r)}</i>}
            </span>
          ))}
        </div>
      </div>
    )
  }

  // ---------- Boss 方案编辑 ----------
  const openEditor = () => {
    const auto = buildSelectedRepresentatives(state)
    const picks: Record<string, string> = {}
    for (const r of auto) picks[r.familyId] = repKey(r)
    setRepPicks(picks)
    setOptPicks(auto.map(r => r.familyId).filter(f => !space.requiredFamilies.includes(f)))
    const pay: Record<number, number> = {}
    for (const p of neg.proposedContract?.payout ?? []) pay[p.playerId] = p.amount
    setPayouts(pay)
    setShowContract(true)
  }

  const pickRep = (f: FamilyId): Representative | undefined => {
    const cands = activeCandsOf(f)
    return cands.find(r => repKey(r) === repPicks[f]) ?? cands[0]
  }

  const buildDraft = (): DealContract | null => {
    const chosen: Representative[] = []
    for (const f of space.requiredFamilies) {
      const rep = pickRep(f)
      if (!rep) return null
      chosen.push({ ...rep })
    }
    for (const f of optPicks.slice(0, space.optionalNeed)) {
      const rep = pickRep(f)
      if (rep) chosen.push({ ...rep })
    }
    const payout = Object.entries(payouts)
      .filter(([, amount]) => amount > 0)
      .map(([pid, amount]) => ({ playerId: Number(pid), amount }))
    return { bossPlayerId: neg.bossPlayerId, selectedRepresentatives: chosen, payout }
  }

  const draft = showContract ? buildDraft() : null
  const draftValid = !!draft && validateContractShape(state, draft)

  const handleSubmitContract = () => {
    if (!draft || !draftValid || !canPropose) return
    dispatch({ type: 'PROPOSE_CONTRACT', contract: draft })
    setShowContract(false)
  }

  const handleFillFromDemands = () => {
    const filled: Record<number, number> = { ...payouts }
    for (const p of nonBossPlayers) {
      const demand = neg.demands.find(d => d.playerId === p.id)
      if (demand) filled[p.id] = demand.amount
    }
    setPayouts(filled)
  }

  const toggleOpt = (f: FamilyId) => {
    setOptPicks(prev => prev.includes(f)
      ? prev.filter(x => x !== f)
      : prev.length < space.optionalNeed ? [...prev, f] : prev)
  }

  const renderRepRadios = (f: FamilyId) => {
    const cands = activeCandsOf(f)
    if (cands.length === 0) return <span className="red">无可用代表</span>
    const picked = pickRep(f)
    return cands.map(r => (
      <label key={repKey(r)} className="rep-option">
        <input
          type="radio"
          name={`rep-${f}`}
          checked={!!picked && repKey(picked) === repKey(r)}
          onChange={() => setRepPicks({ ...repPicks, [f]: repKey(r) })}
        />
        {state.players[r.ownerPlayerId]?.name}{r.ownerPlayerId === HUMAN_ID ? '(你)' : ''}
        <em>{r.sourceType === 'INVESTOR' ? '投资者' : '临时卡'}</em>
        <i>{demandLabelOf(r)}</i>
      </label>
    ))
  }

  // ---------- 喊话 ----------
  const myDemandFamilies = [...new Set(
    neg.representatives
      .filter(r => r.ownerPlayerId === HUMAN_ID && !r.isTravelled && relevantSet.has(r.familyId))
      .map(r => r.familyId),
  )]

  const handleSpeak = () => {
    if (!speakText.trim() || speakLeft <= 0) return
    dispatch({
      type: 'SPEAK',
      playerId: HUMAN_ID,
      text: speakText.trim(),
      demand: humanCanDemand && demandAmount > 0
        ? { playerId: HUMAN_ID, amount: demandAmount, familyId: demandFamily || undefined }
        : undefined,
    })
    setSpeakText('')
    setDemandAmount(0)
    setDemandFamily('')
  }

  const handlePass = () => {
    if (neg.bossReadyToClose && passesUntilSettle <= 1) {
      setPassWarn(true)
      return
    }
    doPass()
  }

  const doPass = () => {
    setPassWarn(false)
    dispatch({ type: 'PASS_NEGOTIATION', playerId: HUMAN_ID })
  }

  return (
    <div className="neg-panel">
      <div className="neg-header">
        <div>
          <span className="boss-tag">👑 {boss?.name}{isHumanBoss ? '（你）' : ''} 是 Boss</span>
          <div className="neg-sub">
            格#{neg.boardSpaceId} · {space.dividends}份 × ${tile?.shareValue}M/股 · 提案 {neg.proposalCount}/{MAX_PROPOSALS_PER_BOSS}
          </div>
        </div>
        <div className="neg-gross">${gross}M</div>
      </div>

      {/* 席位与竞价 */}
      <div className="fam-board">
        <div className="fam-board-title">
          席位与竞价
          <span className="muted">（同家族多代表时 Boss 只选其一，通常选要价低者）</span>
        </div>
        {space.requiredFamilies.map(f => renderFamilyRow(f, true))}
        {space.optionalNeed > 0 && (
          <div className="fam-opt-note">以下可选家族需凑 {space.optionalNeed} 个（当前 {Math.min(optionalHave, space.optionalNeed)}/{space.optionalNeed}）</div>
        )}
        {space.optionalFamilies.map(f => renderFamilyRow(f, false))}
      </div>

      {/* 当前方案 */}
      {neg.proposedContract && (
        <div className="neg-contract-display">
          <div className="req-label">当前方案（选用代表见上方 ★ 标记）</div>
          {neg.proposedContract.payout.filter(p => p.amount > 0).map(p => (
            <div key={p.playerId} className="payout-row">
              <span>{state.players[p.playerId]?.name}{p.playerId === HUMAN_ID ? '（你）' : ''}</span>
              <span className="gold">${p.amount}M</span>
            </div>
          ))}
          {neg.proposedContract.payout.every(p => p.amount === 0) && (
            <span className="muted">Boss 未分给任何人</span>
          )}
          <div className="payout-row boss-net-row">
            <span>{boss?.name} 净得</span>
            <span className="gold">${gross - neg.proposedContract.payout.reduce((s, p) => s + p.amount, 0)}M</span>
          </div>
        </div>
      )}

      {/* 喊话流 */}
      {neg.speeches.length > 0 && (
        <div className="neg-chat">
          {neg.speeches.slice(-8).map(s => (
            <div key={s.id} className={`chat-line${s.playerId === HUMAN_ID ? ' mine' : ''}`}>
              <b>{state.players[s.playerId]?.name}</b>：{s.text}
            </div>
          ))}
        </div>
      )}

      {/* 进度 */}
      <div className="neg-progress">
        行动轮到：<b>{turnPlayer?.name}{isHumanTurn ? '（你）' : ''}</b>
        {neg.bossReadyToClose && (
          <span className="warn"> · Boss已宣布成交，还差 <b>{passesUntilSettle}</b> 人跳过即{canClose ? '进入出借确认' : '流局'}</span>
        )}
      </div>

      {/* 人类喊话 */}
      {isHumanTurn && speakLeft > 0 && (
        <div className="speak-box">
          <input value={speakText} onChange={e => setSpeakText(e.target.value)} placeholder="喊话…" maxLength={120} />
          {humanCanDemand ? (
            <>
              <input type="number" min={0} value={demandAmount || ''} onChange={e => setDemandAmount(Number(e.target.value) || 0)}
                placeholder="要价" className="demand-input" title="你的最低分成要价（$M）" />
              <select className="demand-family" value={demandFamily} onChange={e => setDemandFamily(e.target.value as '' | FamilyId)}
                title="要价针对的家族（竞价时指定，留空为通用）">
                <option value="">通用</option>
                {myDemandFamilies.map(f => (
                  <option key={f} value={f}>{f}·{FAMILIES[f].name}</option>
                ))}
              </select>
            </>
          ) : (
            <span className="hint no-demand-hint" title="要价资格：需有未被打飞、且属于本格需求家族的在场代表">
              无代表在场，不能要价
            </span>
          )}
          <button className="btn" onClick={handleSpeak} disabled={!speakText.trim()}>喊话({speakLeft})</button>
        </div>
      )}

      {/* Boss 方案编辑 */}
      {showContract && isHumanBoss && isHumanTurn && (
        <div className="contract-panel">
          <div className="req-label">
            编辑方案（总额 ${gross}M） · 剩余 {proposalsLeft}/{MAX_PROPOSALS_PER_BOSS} 次提案机会
          </div>

          <div className="req-label">1️⃣ 选择参与代表（同家族多人竞价时挑一个）</div>
          {space.requiredFamilies.map(f => (
            <div key={f} className="rep-select-row">
              <span className="rep-select-head">
                <FamilyChip familyId={f} size="sm" />
                <span className="fam-tag req">必需</span>
              </span>
              {renderRepRadios(f)}
            </div>
          ))}
          {space.optionalNeed > 0 && (
            <>
              <div className="req-label">可选家族（勾选 {space.optionalNeed} 个，已选 {optPicks.length}）</div>
              {space.optionalFamilies.map(f => {
                const usable = activeCandsOf(f).length > 0
                const checked = optPicks.includes(f)
                return (
                  <div key={f} className="rep-select-row">
                    <label className="rep-select-head opt-check">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!usable || (!checked && optPicks.length >= space.optionalNeed)}
                        onChange={() => toggleOpt(f)}
                      />
                      <FamilyChip familyId={f} size="sm" />
                    </label>
                    {usable
                      ? (checked ? renderRepRadios(f) : <span className="muted">未选用</span>)
                      : <span className="muted">无可用代表</span>}
                  </div>
                )
              })}
            </>
          )}

          <div className="req-label">2️⃣ 分成（可分给任何人，包括未出代表者，换取不搅局）</div>
          {neg.demands.length > 0 && (
            <button className="btn fill-demands-btn" onClick={handleFillFromDemands}>
              💡 一键按要价填入
            </button>
          )}
          {nonBossPlayers.map(p => {
            const demand = neg.demands.find(d => d.playerId === p.id)
            return (
              <div key={p.id} className="contract-row">
                <span>{p.name}{p.id === HUMAN_ID ? '（你）' : ''}{demand ? ` (要价$${demand.amount}M${demand.familyId ? `·${FAMILIES[demand.familyId].name}` : ''})` : ''}</span>
                <input type="number" min={0} max={gross} value={payouts[p.id] || 0}
                  onChange={e => setPayouts({ ...payouts, [p.id]: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
                <span>M</span>
              </div>
            )
          })}
          <div className="contract-total">
            <span>你净得</span>
            <span className={bossKeeps < 0 ? 'red' : 'gold'}>${bossKeeps}M</span>
          </div>
          {!draftValid && (
            <p className="red contract-invalid">
              方案暂不合法：请确认必需家族都有代表、可选家族勾满 {space.optionalNeed} 个、分成不超过总额
            </p>
          )}
          <div className="neg-actions">
            <button className="btn btn-success" disabled={!draftValid || !canPropose} onClick={handleSubmitContract}>
              确认方案
            </button>
            <button className="btn" onClick={() => setShowContract(false)}>取消</button>
          </div>
        </div>
      )}

      {/* 操作 */}
      <div className="neg-actions">
        {!isHumanTurn ? (
          <span className="muted">等待 {turnPlayer?.name}…（轮到你时可从下方手牌出牌）</span>
        ) : isHumanBoss ? (
          <>
            {!showContract && (
              <button className="btn" disabled={!canPropose} onClick={openEditor}
                title={canPropose ? undefined : `已达到${MAX_PROPOSALS_PER_BOSS}次提案上限`}>
                {neg.proposedContract ? `修改方案（剩${proposalsLeft}次）` : '提出方案'}
              </button>
            )}
            <button className="btn btn-success" disabled={!canClose} onClick={() => dispatch({ type: 'CLOSE_DEAL' })}
              title={neg.proposedContract ? '按当前方案进入最后反应与出借确认' : '未提方案将按"无分成"默认方案执行，代表持有者很可能拒绝'}>
              {canClose ? '✓ 宣布成交' : '条件不足'}
            </button>
            <button className="btn" onClick={handlePass}>让他人行动</button>
            <button className="btn btn-danger" onClick={() => dispatch({ type: 'FAIL_DEAL' })}>放弃</button>
          </>
        ) : (
          <>
            <button className="btn" onClick={handlePass}>跳过</button>
            <span className="hint">💡 从手牌打出家族/旅行/招募/老板牌</span>
          </>
        )}
      </div>

      {passWarn && (
        <div className="warn-dialog">
          <p>⚠️ 再跳过将直接{canClose && neg.bossReadyToClose ? '进入出借确认' : '流局'}！确定？</p>
          <button className="btn btn-danger" onClick={doPass}>确定跳过</button>
          <button className="btn" onClick={() => setPassWarn(false)}>取消</button>
        </div>
      )}
    </div>
  )
}
