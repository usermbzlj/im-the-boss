// ============================================================
// ActionDock — 人类玩家的操作区：按阶段展示可执行的动作（来源：validator 合法动作）
// ============================================================

import { useEffect, useState } from 'react'
import type { GameState, PlayerAction, FamilyId, Quote } from '../engine/types'
import { FAMILIES, HAND_LIMIT, MAX_SPEECHES_PER_PLAYER, TRADE_RECRUIT_COUNT } from '../engine/config'
import {
  getGrossValue, oneShareOf, offerShareOf, demandOf, getCurrentSpace, tableCanComplete, canCompleteAlone,
  soleRepFamilies, rivalReps, missingFamilies, playerRelevantFamilies, demandsOf, repPriceOf, commitmentPrice, usedFamiliesOf,
  buyCardsCost, tradeCost, isSick, recruitCountAfterTrade, isValidTradePair, countCards,
} from '../engine/rules'
import { canClose } from '../engine/validator'
import { describeReactionTarget } from '../text/labels'
import { reactionKindName, describePayouts } from '../text/narrate'
import FamilyChip from './FamilyChip'
import type { HandSelectMode } from './CardHand'

interface ActionDockProps {
  state: GameState
  legal: PlayerAction[]
  act: (action: PlayerAction) => void
  /** 手牌多选（弃牌 / 兑换）当前选中的牌 */
  selection: Set<number>
  selectMode: HandSelectMode
  onToggleTradeMode: () => void
  onOpenOfferEditor: () => void
}

const HUMAN_ID = 0
/** 价格框的键：家族字母 = 该家族代表的价；HUSH = 没有代表时的封口费 */
const HUSH = '*'

export default function ActionDock({ state, legal, act, selection, selectMode, onToggleTradeMode, onOpenOfferEditor }: ActionDockProps) {
  const [speakText, setSpeakText] = useState('')
  /** 每个代表一个价格框（喊话报价 / 拒绝时的反报价共用）；空 = 这一家不动 */
  const [prices, setPrices] = useState<Record<string, string>>({})
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
  const sick = isSick(state, HUMAN_ID)
  const tradeMode = selectMode === 'trade'

  // 阶段或方案一换，价格框清空：别把上一份方案的反报价带进下一次喊话
  useEffect(() => { setPrices({}) }, [state.phase, neg?.offer?.id])

  const send = (a: PlayerAction) => {
    act(a)
    setSpeakText('')
    setPrices({})
    setConfirmAbandon(false)
  }

  const setPrice = (key: string, v: string) => setPrices(p => ({ ...p, [key]: v }))
  const toAmount = (v: string) => Math.max(0, Math.min(gross, Math.floor(Number(v) || 0)))
  /** 把填了的价格框收成报价条目：家族键 → 该家族；HUSH → 通用价（封口费） */
  const collectQuotes = (keys: string[]): Quote[] =>
    keys.filter(k => (prices[k] ?? '').trim() !== '')
      .map(k => k === HUSH ? { amount: toAmount(prices[k]) } : { familyId: k as FamilyId, amount: toAmount(prices[k]) })
  const quoteText = (qs: Quote[]) => qs.map(q => `${q.familyId ? FAMILIES[q.familyId].name + ' ' : ''}$${q.amount}M`).join('、')

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
        {myInvestors.length === 0 && <span className="status-empty">无（招募牌可夺取）</span>}
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
      {sick && <span className="status-group red" title="病假牌生效：本回合内不能主动出牌 / 换牌，只能喊话、报价、应答、跳过；阻止牌仍可打">🤒 病假中</span>}
    </div>
  )

  /** 桌规：买牌（1/2/3 张）与兑换招募牌（两张异类牌 + 一份股价）的操作条；只在合法动作里有时出现 */
  const renderHouseRules = () => {
    const buys = legal.filter(a => a.type === 'BUY_CARDS')
    const canTrade = has('TRADE_CARDS')
    if (buys.length === 0 && !canTrade) return null
    const picked = [...selection]
    const pairOk = tradeMode && isValidTradePair(state, HUMAN_ID, picked)
    const after = pairOk ? recruitCountAfterTrade(state, HUMAN_ID, picked) : countCards(me.hand, 'RECRUITMENT') + TRADE_RECRUIT_COUNT
    return (
      <div className="dock-house">
        <span className="dock-house-label" title="桌规动作：不结束你的行动，每回合各限一次">桌规</span>
        {buys.map(a => a.type === 'BUY_CARDS' && (
          <button key={a.count} className="btn btn-sm" onClick={() => send(a)}
            title={`付 $${buyCardsCost(state, a.count)}M 给银行（钱不会回来），立刻多抽 ${a.count} 张`}>
            🃏 买 {a.count} 张 <b>${buyCardsCost(state, a.count)}M</b>
          </button>
        ))}
        {canTrade && !tradeMode && (
          <button className="btn btn-sm" onClick={onToggleTradeMode}
            title={`交出两张不同种类的牌 + 付 $${tradeCost(state)}M 给银行，换 ${TRADE_RECRUIT_COUNT} 张招募牌（不可逆）`}>
            🔁 兑换招募牌 <b>${tradeCost(state)}M</b>
          </button>
        )}
        {tradeMode && (
          <>
            <span className="dock-hint gold">在手牌里点选两张<b>不同种类</b>的牌交出（已选 {selection.size}/2）→ 付 ${tradeCost(state)}M 换 {TRADE_RECRUIT_COUNT} 张招募牌{pairOk ? `，招募牌将有 ${after} 张` : ''}</span>
            <button className="btn btn-success btn-sm" disabled={!pairOk} onClick={() => send({ type: 'TRADE_CARDS', playerId: HUMAN_ID, cardIds: picked })}>确认兑换</button>
            <button className="btn btn-sm" onClick={onToggleTradeMode}>取消</button>
          </>
        )}
      </div>
    )
  }

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
          <>
            <div className="dock-actions">
              <button className="btn btn-success btn-lg" disabled={tradeMode} onClick={() => send({ type: 'OPEN_DEAL', playerId: HUMAN_ID })}>
                Let's make a deal！发起 #{state.markerPos} 的交易 <b>${gross}M</b>
                <small>{canSolo ? '你的投资者/家族卡可独立凑齐' : '需要向他人借代表'}</small>
              </button>
              {state.phase === 'TURN'
                ? <button className="btn btn-lg" disabled={tradeMode} onClick={() => send({ type: 'ROLL_MOVE', playerId: HUMAN_ID })}>🎲 掷骰移动标记</button>
                : <button className="btn btn-lg" disabled={tradeMode} onClick={() => send({ type: 'DRAW_CARDS', playerId: HUMAN_ID })}>🃏 抽 3 张牌，结束回合</button>}
              {has('PLAY_SICK') && !tradeMode && <span className="dock-hint">开单前可从手牌打病假牌，先放倒最可能搅局的人</span>}
            </div>
            {renderHouseRules()}
          </>
        )
      }

      case 'HAND_LIMIT': {
        const over = me.hand.length - HAND_LIMIT
        const ready = selection.size === over
        return (
          <div className="dock-actions">
            <span className="dock-hint red">手牌 {me.hand.length} 张，需弃 {over} 张（已选 {selection.size}）{has('PLAY_RECRUITMENT') ? '；或点招募牌夺取投资者' : ''}</span>
            <button className="btn btn-danger" disabled={!ready} onClick={() => send({ type: 'DISCARD', playerId: HUMAN_ID, cardIds: [...selection] })}>
              弃掉所选 {selection.size}/{over} 张
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
        const quoteKeys = isBoss ? [] : mine.length ? mine : [HUSH]
        const pending = collectQuotes(quoteKeys)
        const canSend = !!speakText.trim() || pending.length > 0
        const complete = tableCanComplete(state)
        const passTitle = complete ? '本轮不行动（连续两轮全员跳过会流局）' : '桌上凑不齐代表：全员跳过一轮就直接流局'
        return (
          <div className="dock-neg">
            {sick && <span className="dock-hint red">🤒 你本回合病假中：不能主动出牌 / 换牌，只能喊话、报价、应答、跳过（阻止牌仍可打）</span>}
            {has('SPEAK') && (
              <div className="speak-box">
                {!isBoss && (
                  <div className="quote-grid" title="每个代表单独一个价（$M）：留空 = 这一家不改；Boss 付到你的价即视为你同意">
                    {mine.length ? mine.map(f => {
                      const cur = demandOf(neg!, HUMAN_ID, f)
                      return (
                        <label key={f} className="quote-row" title={`${FAMILIES[f].name}代表的出借价（$M）${cur != null ? `，当前承诺 $${cur}M` : ''}`}>
                          <FamilyChip familyId={f} size="md" />
                          <input className="demand-input" type="number" min={0} max={gross} value={prices[f] ?? ''}
                            placeholder={cur != null ? `现 ${cur}` : `≈${share}`} onChange={e => setPrice(f, e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter' && canSend) doSpeak() }} />
                        </label>
                      )
                    }) : (
                      <label className="quote-row" title="封口费：不搅局的价码（$M）">
                        <span className="quote-name">封口费</span>
                        <input className="demand-input" type="number" min={0} max={gross} value={prices[HUSH] ?? ''}
                          placeholder={demandOf(neg!, HUMAN_ID) != null ? `现 ${demandOf(neg!, HUMAN_ID)}` : `≈${Math.max(1, Math.round(share / 2))}`}
                          onChange={e => setPrice(HUSH, e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && canSend) doSpeak() }} />
                      </label>
                    )}
                    {mine.length > 0 && (
                      <button className="btn btn-sm" title="每个代表都填一份分红" onClick={() => setPrices(Object.fromEntries(mine.map(f => [f, String(share)])))}>
                        全部 ≈${share}M
                      </button>
                    )}
                  </div>
                )}
                <input className="speak-text" value={speakText} maxLength={120} placeholder={isBoss ? '对桌上的人说点什么…' : mine.length ? '台词（可空：只报价会自动生成一句）' : '喊话：施压 / 表态 / 索要封口费…'}
                  onChange={e => setSpeakText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && canSend) doSpeak() }} />
                <button className="btn" disabled={!canSend} onClick={doSpeak}>
                  {pending.length ? `报价 ${quoteText(pending)}` : '喊话'}（剩 {speakLeft}）
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
                  <button className="btn" onClick={() => send({ type: 'PASS', playerId: HUMAN_ID })} title={complete ? '再听一轮叫价' : passTitle}>再听一轮{!complete && '（缺代表）'}</button>
                  {confirmAbandon
                    ? <><span className="red">确定放弃？家族卡收回，无人拿钱</span><button className="btn btn-danger" onClick={() => send({ type: 'ABANDON_DEAL', playerId: HUMAN_ID })}>确定</button><button className="btn" onClick={() => setConfirmAbandon(false)}>取消</button></>
                    : <button className="btn btn-danger" onClick={() => setConfirmAbandon(true)}>放弃交易</button>}
                </>
              ) : (
                <>
                  <button className="btn" onClick={() => send({ type: 'PASS', playerId: HUMAN_ID })} title={passTitle}>跳过</button>
                  <span className="dock-hint">
                    {sick ? '病假中：只能喊话 / 报价 / 跳过' : `从下方手牌打出家族成员 / 旅行 / 招募 / 老板${state.houseRules ? ' / 病假' : ''}牌`}
                    {!complete && <span className="muted">；桌上凑不齐代表，全员跳过一轮即流局</span>}
                  </span>
                </>
              )}
            </div>
            {renderHouseRules()}
          </div>
        )
      }

      case 'OFFER_RESPONSE': {
        const offer = neg!.offer!
        const myShare = offerShareOf(offer, HUMAN_ID)
        const myAsk = commitmentPrice(neg!, offer, HUMAN_ID)
        const toOthers = offer.payouts.filter(p => p.playerId !== HUMAN_ID && p.amount > 0)
        const used = usedFamiliesOf(neg!, offer, HUMAN_ID)
        const counters = collectQuotes(used)
        return (
          <div className="dock-actions">
            <span className="dock-hint">
              Boss {state.players[neg!.bossId]?.name} 要用你的 {used.map(f => FAMILIES[f].name).join('、')} 代表，分给你 <b className="gold">${myShare}M</b>{myAsk != null ? `（低于你对这些代表的承诺价合计 $${myAsk}M）` : ''}
              {toOthers.length > 0 && <span className="muted">；另付 {describePayouts(state, toOthers)}</span>}
              <span className="muted">。同意后 ${myShare}M（按代表折算）成为你的承诺价；拒绝时可给每个代表分别反报价（成为新承诺价）</span>
            </span>
            <button className="btn btn-success" onClick={() => send({ type: 'ACCEPT_OFFER', playerId: HUMAN_ID })}>✓ 同意出借（拿 ${myShare}M）</button>
            <div className="quote-grid" title="每个代表分别反报价（$M）；留空 = 这一家不改">
              {used.map(f => {
                const cur = demandOf(neg!, HUMAN_ID, f)
                return (
                  <label key={f} className="quote-row" title={`${FAMILIES[f].name}代表的反报价（$M）${cur != null ? `，当前承诺 $${cur}M` : ''}`}>
                    <FamilyChip familyId={f} size="md" />
                    <input className="demand-input" type="number" min={0} max={gross} value={prices[f] ?? ''}
                      placeholder={cur != null ? `现 ${cur}` : '反报价'} onChange={e => setPrice(f, e.target.value)} />
                  </label>
                )
              })}
            </div>
            <button className="btn btn-danger" onClick={() => send({ type: 'DECLINE_OFFER', playerId: HUMAN_ID, quotes: counters.length ? counters : undefined })}>
              ✗ 拒绝{counters.length ? `，反报价 ${quoteText(counters)}` : ''}
            </button>
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
              {canDisrupt ? `最后机会：放行，或从手牌打旅行 / 招募 / 老板${state.houseRules ? ' / 病假' : ''}牌` : sick ? '你病假中，不能打干扰牌，稍后自动放行' : '你没有可打的干扰牌，稍后自动放行'}
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
    const mine = playerRelevantFamilies(state, HUMAN_ID)
    const quotes = isBoss ? [] : collectQuotes(mine.length ? mine : [HUSH])
    if (!speakText.trim() && quotes.length === 0) return
    // 只填了价没写台词：自动生成一句，报价本身就是话
    const say = speakText.trim() || (mine.length
      ? quotes.length === 1
        ? `我的${FAMILIES[quotes[0].familyId!].name}，$${quotes[0].amount}M 出借，付到就成。`
        : `我这边：${quoteText(quotes)}，各是各的价，付到就成。`
      : `分我 $${quotes[0].amount}M，我不捣乱。`)
    send({ type: 'SPEAK', playerId: HUMAN_ID, say, quotes: quotes.length ? quotes : undefined })
  }

  return (
    <div className="dock">
      {renderStatus()}
      {renderActions()}
    </div>
  )
}
