// ============================================================
// ActionDock — 人类玩家的操作区：按阶段展示可执行的动作（来源：validator 合法动作）
// ============================================================

import { useState } from 'react'
import type { GameState, PlayerAction } from '../engine/types'
import { FAMILIES, HAND_LIMIT, MAX_SPEECHES_PER_PLAYER } from '../engine/config'
import {
  getGrossValue, oneShareOf, offerShareOf, demandOf, playerActiveFamilies, relevantFamilies, getCurrentSpace, tableCanComplete, canCompleteAlone,
} from '../engine/rules'
import { canClose } from '../engine/validator'
import { describeReactionTarget } from '../text/labels'
import { reactionKindName, describePayouts } from '../text/narrate'
import FamilyChip from './FamilyChip'

interface ActionDockProps {
  state: GameState
  legal: PlayerAction[]
  act: (action: PlayerAction) => void
  discardSelection: Set<number>
  onOpenOfferEditor: () => void
}

const HUMAN_ID = 0

export default function ActionDock({ state, legal, act, discardSelection, onOpenOfferEditor }: ActionDockProps) {
  const [speakText, setSpeakText] = useState('')
  const [demand, setDemand] = useState('')
  const [counter, setCounter] = useState('')
  const [confirmAbandon, setConfirmAbandon] = useState(false)

  const me = state.players[HUMAN_ID]
  const neg = state.negotiation
  const gross = getGrossValue(state)
  const share = oneShareOf(state)
  const has = (type: PlayerAction['type']) => legal.some(a => a.type === type)
  const myTurn = legal.length > 0
  const travelled = new Set(neg?.travelledInvestors ?? [])
  const myInvestors = state.investors.filter(i => i.ownerId === HUMAN_ID)
  const myClanReps = neg?.reps.filter(r => r.ownerId === HUMAN_ID && r.source === 'CLAN') ?? []

  const send = (a: PlayerAction) => {
    act(a)
    setSpeakText('')
    setDemand('')
    setCounter('')
    setConfirmAbandon(false)
  }

  const renderStatus = () => (
    <div className="dock-status">
      <span className="status-cash" title="你的现金">💰 ${me.cash}M</span>
      <span className="status-group">
        <span className="status-label">投资者</span>
        {myInvestors.length === 0 && <span className="status-empty">无（招募三连可夺取）</span>}
        {myInvestors.map(inv => <FamilyChip key={inv.familyId} familyId={inv.familyId} size="md" travelled={travelled.has(inv.familyId)} />)}
      </span>
      {neg && (
        <span className="status-group">
          <span className="status-label">桌上家族卡</span>
          {myClanReps.length === 0 && <span className="status-empty">无</span>}
          {myClanReps.map(r => <FamilyChip key={r.key} familyId={r.familyId} size="md" travelled={r.travelled} />)}
        </span>
      )}
      {neg && demandOf(neg, HUMAN_ID) != null && <span className="status-group"><span className="status-label">你的报价</span><b className="gold">${demandOf(neg, HUMAN_ID)}M</b></span>}
      {neg?.offer && offerShareOf(neg.offer, HUMAN_ID) > 0 && <span className="status-group"><span className="status-label">方案分你</span><b className="gold">${offerShareOf(neg.offer, HUMAN_ID)}M</b></span>}
    </div>
  )

  const renderActions = () => {
    if (state.phase === 'GAME_OVER') return null
    if (!myTurn) {
      const actingId = neg && state.phase === 'NEGOTIATION' ? neg.turnId : null
      return (
        <div className="dock-wait">
          {state.phase === 'REACTION' ? '其他玩家正在决定是否阻止…'
            : state.phase === 'OFFER_RESPONSE' ? '等待代表持有者应答方案…'
              : state.phase === 'CLOSING' ? '成交倒计时：等待其他玩家放行…'
                : actingId != null ? `等待 ${state.players[actingId]?.name} 行动…` : '等待其他玩家…'}
        </div>
      )
    }

    switch (state.phase) {
      case 'PLACE_MARKER':
        return <div className="dock-hint">点击版图上任意未成交的格子，放置金钱标记</div>

      case 'TURN':
      case 'AFTER_MOVE': {
        const space = getCurrentSpace(state)!
        const canSolo = canCompleteAlone(state, HUMAN_ID, space)
        return (
          <div className="dock-actions">
            <button className="btn btn-success btn-lg" onClick={() => send({ type: 'OPEN_DEAL', playerId: HUMAN_ID })}>
              Let's make a deal！发起 #{state.markerPos} 的交易 <b>${gross}M</b>
              <small>{canSolo ? '你的投资者/家族卡可独立凑齐' : '需要向他人借代表'}</small>
            </button>
            {state.phase === 'TURN'
              ? <button className="btn btn-lg" onClick={() => send({ type: 'ROLL_MOVE', playerId: HUMAN_ID })}>🎲 掷骰移动标记</button>
              : <button className="btn btn-lg" onClick={() => send({ type: 'DRAW_CARDS', playerId: HUMAN_ID })}>🃏 抽 3 张牌，结束回合</button>}
          </div>
        )
      }

      case 'HAND_LIMIT': {
        const over = me.hand.length - HAND_LIMIT
        const ready = discardSelection.size === over
        return (
          <div className="dock-actions">
            <span className="dock-hint red">手牌 {me.hand.length} 张，需弃 {over} 张（已选 {discardSelection.size}）{has('PLAY_RECRUITMENT') ? '；或点招募牌打出三连' : ''}</span>
            <button className="btn btn-danger" disabled={!ready} onClick={() => send({ type: 'DISCARD', playerId: HUMAN_ID, cardIds: [...discardSelection] })}>
              弃掉所选 {discardSelection.size}/{over} 张
            </button>
            <button className="btn" onClick={() => {
              const auto = legal.find(a => a.type === 'DISCARD')
              if (auto) send(auto)
            }}>自动弃价值最低的牌</button>
          </div>
        )
      }

      case 'NEGOTIATION': {
        const isBoss = neg!.bossId === HUMAN_ID
        const speakLeft = MAX_SPEECHES_PER_PLAYER - (neg!.speakCounts[HUMAN_ID] ?? 0)
        const space = getCurrentSpace(state)!
        const mine = [...playerActiveFamilies(neg!, HUMAN_ID)].filter(f => relevantFamilies(space).includes(f))
        const closable = canClose(state)
        return (
          <div className="dock-neg">
            {has('SPEAK') && (
              <div className="speak-box">
                <input value={speakText} maxLength={120} placeholder={isBoss ? '对桌上的人说点什么…' : mine.length ? `喊话并报价：我的 ${mine.map(f => FAMILIES[f].name).join('/')} 出借价…` : '喊话：施压 / 表态 / 索要封口费…'}
                  onChange={e => setSpeakText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && speakText.trim()) doSpeak() }} />
                {!isBoss && (
                  <input className="demand-input" type="number" min={0} max={gross} value={demand} placeholder={`要价 ≈${share}`} title={mine.length ? '你的代表出借价（$M）' : '封口费：不搅局的价码（$M）'}
                    onChange={e => setDemand(e.target.value)} />
                )}
                <button className="btn" disabled={!speakText.trim()} onClick={doSpeak}>喊话（剩 {speakLeft}）</button>
              </div>
            )}
            <div className="dock-actions">
              {isBoss ? (
                <>
                  <button className="btn" disabled={!has('PROPOSE_OFFER') && !tableCanComplete(state)} onClick={onOpenOfferEditor}
                    title={tableCanComplete(state) ? '指定选用的代表与分成' : '桌上代表还凑不齐需求，先等人打家族卡/报价'}>
                    {neg!.offer ? '修改方案' : '提出方案'}{!tableCanComplete(state) && '（代表不足）'}
                  </button>
                  <button className="btn btn-success" disabled={!closable} onClick={() => send({ type: 'CLOSE_DEAL', playerId: HUMAN_ID })}
                    title={closable ? '进入"Going once, going twice"倒计时，无人干扰即结算' : '需先有全员同意的方案，或仅用自己的代表凑齐'}>
                    ✓ 宣布成交
                  </button>
                  <button className="btn" onClick={() => send({ type: 'PASS', playerId: HUMAN_ID })} title="让其他人先出牌/报价">让他人先行动</button>
                  {confirmAbandon
                    ? <><span className="red">确定放弃？家族卡收回，无人拿钱</span><button className="btn btn-danger" onClick={() => send({ type: 'ABANDON_DEAL', playerId: HUMAN_ID })}>确定</button><button className="btn" onClick={() => setConfirmAbandon(false)}>取消</button></>
                    : <button className="btn btn-danger" onClick={() => setConfirmAbandon(true)}>放弃交易</button>}
                </>
              ) : (
                <>
                  <button className="btn" onClick={() => send({ type: 'PASS', playerId: HUMAN_ID })}>跳过</button>
                  <span className="dock-hint">从下方手牌打出家族成员 / 旅行 / 招募 / 老板牌</span>
                </>
              )}
            </div>
          </div>
        )
      }

      case 'OFFER_RESPONSE': {
        const myShare = offerShareOf(neg!.offer, HUMAN_ID)
        const myAsk = demandOf(neg!, HUMAN_ID)
        const toOthers = neg!.offer?.payouts.filter(p => p.playerId !== HUMAN_ID && p.amount > 0) ?? []
        return (
          <div className="dock-actions">
            <span className="dock-hint">
              Boss {state.players[neg!.bossId]?.name} 要用你的代表，分给你 <b className="gold">${myShare}M</b>{myAsk != null ? `（你要价 $${myAsk}M）` : ''}
              {toOthers.length > 0 && <span className="muted">；另付 {describePayouts(state, toOthers)}</span>}
            </span>
            <button className="btn btn-success" onClick={() => send({ type: 'ACCEPT_OFFER', playerId: HUMAN_ID })}>✓ 同意出借（拿 ${myShare}M）</button>
            <input className="demand-input" type="number" min={0} max={gross} value={counter} placeholder="反报价" onChange={e => setCounter(e.target.value)} />
            <button className="btn btn-danger" onClick={() => send({ type: 'DECLINE_OFFER', playerId: HUMAN_ID, counter: counter.trim() === '' ? undefined : Math.max(0, Math.floor(Number(counter) || 0)) })}>✗ 拒绝</button>
          </div>
        )
      }

      case 'REACTION': {
        const pr = state.pendingReaction!
        const canStop = has('PLAY_STOP')
        return (
          <div className="dock-actions">
            <span className="dock-hint">⚡ {state.players[pr.actorId]?.name} 打出了{reactionKindName(pr.kind)} → {describeReactionTarget(state, pr)}{canStop ? '' : '（你没有阻止牌，稍后自动放行）'}</span>
            {canStop && <button className="btn btn-danger" onClick={() => send({ type: 'PLAY_STOP', playerId: HUMAN_ID })}>🛑 打出阻止牌</button>}
            <button className="btn" onClick={() => send({ type: 'PASS_REACTION', playerId: HUMAN_ID })}>{canStop ? '不阻止' : '放行'}</button>
          </div>
        )
      }

      case 'CLOSING': {
        const myShare = offerShareOf(neg!.offer, HUMAN_ID)
        return (
          <div className="dock-actions">
            <span className="dock-hint">Boss 宣布成交，你{myShare > 0 ? <>将分得 <b className="gold">${myShare}M</b></> : '拿不到钱'}。最后机会：放行，或从手牌打旅行 / 招募 / 老板牌</span>
            <button className="btn btn-success" onClick={() => send({ type: 'PASS_CLOSING', playerId: HUMAN_ID })}>放行</button>
          </div>
        )
      }

      case 'END_ROLL':
        return (
          <div className="dock-actions">
            <button className="btn btn-danger btn-lg" onClick={() => send({ type: 'ROLL_END', playerId: HUMAN_ID })}>🎲 掷骰判定终局</button>
          </div>
        )
      default:
        return null
    }
  }

  function doSpeak() {
    if (!speakText.trim()) return
    const isBoss = neg?.bossId === HUMAN_ID
    const d = !isBoss && demand.trim() !== '' ? Math.max(0, Math.min(gross, Math.floor(Number(demand) || 0))) : undefined
    const space = getCurrentSpace(state)
    const mine = neg && space ? [...playerActiveFamilies(neg, HUMAN_ID)].filter(f => relevantFamilies(space).includes(f)) : []
    send({ type: 'SPEAK', playerId: HUMAN_ID, say: speakText.trim(), demand: d, demandFamily: d != null && mine.length ? mine[0] : undefined })
  }

  return (
    <div className="dock">
      {renderStatus()}
      {renderActions()}
    </div>
  )
}
