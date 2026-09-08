// ============================================================
// ActionDock — 人类玩家的操作区：按阶段展示可执行的动作（来源：validator 合法动作）
// ============================================================

import { useState } from 'react'
import type { GameState, PlayerAction, FamilyId } from '../engine/types'
import { FAMILIES, HAND_LIMIT, MAX_SPEECHES_PER_PLAYER } from '../engine/config'
import {
  getGrossValue, oneShareOf, offerShareOf, demandOf, getCurrentSpace, tableCanComplete, canCompleteAlone,
  soleRepFamilies, rivalReps, missingFamilies, playerRelevantFamilies, demandsOf, repPriceOf, commitmentPrice,
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
  /** 报价针对的家族：'' = 本格我所有相关代表同价 */
  const [demandFam, setDemandFam] = useState<'' | FamilyId>('')
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
    setDemandFam('')
    setCounter('')
    setConfirmAbandon(false)
  }

  /** 状态栏里"你的承诺价"：按家族分列，通用价标为封口费 */
  const myDemandLabel = () => {
    if (!neg) return null
    const ds = demandsOf(neg, HUMAN_ID)
    if (ds.length === 0) return null
    return ds.map(d => `${d.familyId ? FAMILIES[d.familyId].name + ' ' : ds.length > 1 ? '封口费 ' : ''}$${d.amount}M`).join(' · ')
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
      {myDemandLabel() && <span className="status-group" title="报价即承诺（每个代表）：Boss 的方案付到这个价，视为你自动同意"><span className="status-label">你的承诺价</span><b className="gold">{myDemandLabel()}</b></span>}
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
        const mine = playerRelevantFamilies(state, HUMAN_ID)
        const closable = canClose(state)
        const myAsks = mine.map(f => ({ f, price: demandOf(neg!, HUMAN_ID, f) })).filter(x => x.price != null)
        const hush = mine.length === 0 ? demandOf(neg!, HUMAN_ID) : undefined
        const sole = soleRepFamilies(state, HUMAN_ID)
        const missing = missingFamilies(state)
        // 非 Boss 的筹码提示：唯一代表可抬价；有竞争者要比他低；没代表只能靠手牌
        const leverageHint = !isBoss && (mine.length
          ? mine.map(f => {
            const tag = demandOf(neg!, HUMAN_ID, f) != null ? `（你报 $${demandOf(neg!, HUMAN_ID, f)}M）` : ''
            if (sole.includes(f)) return `${FAMILIES[f].name}只有你有，没你做不成 → 可抬价${tag}`
            const rivals = rivalReps(state, HUMAN_ID, f)
            if (rivals.some(r => r.ownerId === neg!.bossId)) return `${FAMILIES[f].name} Boss 自己也有 → 你的几乎不会被选${tag}`
            if (rivals.length) return `${FAMILIES[f].name}有竞争者（${rivals.map(r => `${state.players[r.ownerId]?.name}${repPriceOf(neg!, r) != null ? ` $${repPriceOf(neg!, r)}M` : ''}`).join('、')}）→ 报得更低才会被选${tag}`
            return `${FAMILIES[f].name}可出借，一份分红 ≈ $${share}M${tag}`
          }).join('；')
          : `你没有本格相关代表${missing.length ? `（缺 ${missing.map(f => FAMILIES[f].name).join('、')}，有家族卡就打）` : ''}；可索要封口费或打干扰牌`)
        return (
          <div className="dock-neg">
            {has('SPEAK') && (
              <div className="speak-box">
                {!isBoss && (
                  <>
                    {mine.length > 1 && (
                      <select className="demand-fam" value={demandFam} onChange={e => setDemandFam(e.target.value as '' | FamilyId)}
                        title="只对某一家族的代表报价，其他家族的报价不变；不同家族可以报不同价">
                        <option value="">全部代表</option>
                        {mine.map(f => <option key={f} value={f}>{FAMILIES[f].name}</option>)}
                      </select>
                    )}
                    <input className="demand-input" type="number" min={0} max={gross} value={demand} placeholder={`承诺价 ≈${share}`}
                      title={mine.length ? '你的代表出借价（$M / 每个代表）：Boss 付到即视为你同意' : '封口费：不搅局的价码（$M）'}
                      onChange={e => setDemand(e.target.value)} />
                    <button className="btn btn-sm" onClick={() => setDemand(String(share))} title="填入一份分红">≈${share}M</button>
                  </>
                )}
                <input className="speak-text" value={speakText} maxLength={120} placeholder={isBoss ? '对桌上的人说点什么…' : mine.length ? '台词（可空：只报价会自动生成一句）' : '喊话：施压 / 表态 / 索要封口费…'}
                  onChange={e => setSpeakText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && (speakText.trim() || demand.trim())) doSpeak() }} />
                <button className="btn" disabled={!speakText.trim() && (isBoss || demand.trim() === '')} onClick={doSpeak}>
                  {!isBoss && demand.trim() !== '' ? `报价 $${Math.max(0, Math.floor(Number(demand) || 0))}M` : '喊话'}（剩 {speakLeft}）
                </button>
              </div>
            )}
            {!isBoss && (
              <span className="dock-hint">
                {leverageHint}
                {myAsks.length > 0
                  ? <>。你当前承诺价（每个代表）<b className="gold">{myAsks.map(x => `${mine.length > 1 ? FAMILIES[x.f].name + ' ' : ''}$${x.price}M`).join('、')}</b>：Boss 付到即自动同意</>
                  : hush != null ? <>。你要的封口费 <b className="gold">${hush}M</b></>
                    : '。报价即承诺：Boss 付到你的价就视为同意'}
              </span>
            )}
            <div className="dock-actions">
              {isBoss ? (
                <>
                  <button className="btn" disabled={!has('PROPOSE_OFFER') && !tableCanComplete(state)} onClick={onOpenOfferEditor}
                    title={tableCanComplete(state) ? '指定选用的代表与分成；付到对方承诺价的会自动同意' : '桌上代表还凑不齐需求，先等人打家族卡/报价'}>
                    {neg!.offer ? '修改方案' : '提出方案'}{!tableCanComplete(state) && '（代表不足）'}
                  </button>
                  <button className="btn btn-success" disabled={!closable} onClick={() => send({ type: 'CLOSE_DEAL', playerId: HUMAN_ID })}
                    title={closable ? '进入"Going once, going twice"倒计时，无人干扰即结算' : '需先有全员同意的方案，或仅用自己的代表凑齐'}>
                    ✓ 宣布成交
                  </button>
                  <button className="btn" onClick={() => send({ type: 'PASS', playerId: HUMAN_ID })} title="再听一轮叫价">再听一轮</button>
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
        const myAsk = neg!.offer ? commitmentPrice(neg!, neg!.offer, HUMAN_ID) : undefined
        const toOthers = neg!.offer?.payouts.filter(p => p.playerId !== HUMAN_ID && p.amount > 0) ?? []
        return (
          <div className="dock-actions">
            <span className="dock-hint">
              Boss {state.players[neg!.bossId]?.name} 要用你的代表，分给你 <b className="gold">${myShare}M</b>{myAsk != null ? `（低于你对这些代表的承诺价合计 $${myAsk}M）` : ''}
              {toOthers.length > 0 && <span className="muted">；另付 {describePayouts(state, toOthers)}</span>}
              <span className="muted">。同意后 ${myShare}M（按代表折算）成为你的承诺价；拒绝可反报价（每个代表，成为新承诺价）</span>
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
        const canDisrupt = legal.some(a => a.type !== 'PASS_CLOSING')
        return (
          <div className="dock-actions">
            <span className="dock-hint">
              Boss 宣布成交，你{myShare > 0 ? <>将分得 <b className="gold">${myShare}M</b></> : '拿不到钱'}。
              {canDisrupt ? '最后机会：放行，或从手牌打旅行 / 招募 / 老板牌' : '你没有可打的干扰牌，稍后自动放行'}
            </span>
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
    const isBoss = neg?.bossId === HUMAN_ID
    const d = !isBoss && demand.trim() !== '' ? Math.max(0, Math.min(gross, Math.floor(Number(demand) || 0))) : undefined
    if (!speakText.trim() && d == null) return
    const mine = playerRelevantFamilies(state, HUMAN_ID)
    const fam = d != null && demandFam && mine.includes(demandFam) ? demandFam : undefined
    const target = fam ? [fam] : mine
    // 只填了价没写台词：自动生成一句，报价本身就是话
    const say = speakText.trim() || (target.length ? `我的${target.map(f => FAMILIES[f].name).join('/')}，$${d}M 出借，付到就成。` : `分我 $${d}M，我不捣乱。`)
    send({ type: 'SPEAK', playerId: HUMAN_ID, say, demand: d, demandFamily: fam })
  }

  return (
    <div className="dock">
      {renderStatus()}
      {renderActions()}
    </div>
  )
}
