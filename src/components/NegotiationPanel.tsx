// ============================================================
// NegotiationPanel — 谈判桌全景（侧栏）：席位竞价 / 当前方案 / 报价 / 喊话流
// 只负责展示；所有操作在底部操作区（ActionDock）与手牌完成
// ============================================================

import { useEffect, useRef } from 'react'
import type { GameState, FamilyId, Representative } from '../engine/types'
import { MAX_OFFERS_PER_BOSS, LANDMARK_RENT } from '../engine/config'
import {
  getCurrentSpace, getCurrentTile, getGrossValue, oneShareOf, isRequiredGroup,
  activeRepsOfFamily, repPriceOf, offerOwners, findRep, playerActiveFamilies, meetsCommitment,
  effectiveShareValue, isBlackMarketDeal, isExclusiveLocked,
} from '../engine/rules'
import { canClose } from '../engine/validator'
import { spaceKindName, spaceKindEffect } from '../text/narrate'
import FamilyChip from './FamilyChip'
import { useViewerId } from './ViewerContext'


export default function NegotiationPanel({ state }: { state: GameState }) {
  const viewerId = useViewerId()
  const neg = state.negotiation
  const space = getCurrentSpace(state)
  const chatRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = chatRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [neg?.speeches.length])

  if (!neg || !space) return <div className="log-panel"><p className="muted pad">当前没有进行中的交易</p></div>

  const tile = getCurrentTile(state)
  const gross = getGrossValue(state)
  const share = oneShareOf(state)
  const shareNow = effectiveShareValue(state, space)
  const boss = state.players[neg.bossId]
  const offer = neg.offer
  const badges: Array<{ text: string; tone: 'gold' | 'red' | 'green' | 'muted'; title: string }> = []
  if (space.kind !== 'STANDARD') badges.push({ text: spaceKindName(space.kind), tone: space.kind === 'BLACK_MARKET' ? 'muted' : 'gold', title: spaceKindEffect(space.kind) })
  if (space.kind === 'LANDMARK') badges.push({ text: `成交者成为地标主人，此后每笔成交收 $${LANDMARK_RENT}M`, tone: 'gold', title: '地标' })
  if (isBlackMarketDeal(state)) badges.push({ text: '黑市：出牌无反应窗口，阻止牌无效', tone: 'red', title: '黑市' })
  if (isExclusiveLocked(state)) badges.push({ text: '🔒 独家协议：老板 / 旅行 / 利空牌已封锁', tone: 'green', title: '独家协议' })
  if (neg.priceDelta > 0) badges.push({ text: `📈 利好 +$${neg.priceDelta}M/份`, tone: 'green', title: '利好牌生效' })
  if (neg.priceDelta < 0) badges.push({ text: `📉 利空 −$${-neg.priceDelta}M/份`, tone: 'red', title: '利空牌生效' })
  const name = (id: number) => `${state.players[id]?.name ?? '?'}${id === viewerId ? '（你）' : ''}`
  if (state.turn.sick.length) badges.push({ text: `🤒 病假：${state.turn.sick.map(name).join('、')}（本回合不能主动出牌）`, tone: 'muted', title: '病假牌生效：只能被动打阻止牌' })

  const priceOf = (r: Representative) => {
    if (r.ownerId === neg.bossId) return 'Boss 自有'
    const d = repPriceOf(neg, r)
    return d != null ? `承诺价 $${d}M` : '未报价'
  }
  // 谈判轮次里轮到谁（叫价轮：Boss 左手边起，Boss 末位）
  const turnName = state.phase === 'NEGOTIATION' ? name(neg.turnId) : null

  const renderFamily = (f: FamilyId, required: boolean) => {
    const reps = neg.reps.filter(r => r.familyId === f)
    const covered = activeRepsOfFamily(neg, f).length > 0
    return (
      <div key={f} className={`fam-row${covered ? '' : ' missing'}`}>
        <div className="fam-head">
          <FamilyChip familyId={f} size="md" kind={required ? 'required' : 'optional'} />
          <span className={`fam-state ${covered ? 'green' : 'red'}`}>{covered ? '✓' : '缺'}</span>
        </div>
        <div className="fam-cands">
          {reps.length === 0 && <span className="muted">无代表 — 等该家族投资者的持有者报价，或有人打家族成员卡</span>}
          {reps.map(r => {
            const inOffer = !!offer?.repKeys.includes(r.key)
            const resp = offer?.responses[r.ownerId]
            return (
              <span key={r.key} className={`cand${r.travelled ? ' travelled' : ''}${inOffer ? ' in-offer' : ''}`}
                title={r.source === 'INVESTOR' ? '投资者牌（长期）' : '家族成员卡（本笔交易临时）'}>
                {inOffer && <b className="cand-star">★</b>}
                {name(r.ownerId)}
                <em>{r.source === 'INVESTOR' ? '投资者' : '家族卡'}</em>
                {r.travelled ? <b className="red">已失效</b> : <i>{priceOf(r)}</i>}
                {inOffer && r.ownerId !== neg.bossId && resp && <b className={resp === 'ACCEPTED' ? 'green' : 'red'}>{resp === 'ACCEPTED' ? (meetsCommitment(neg, offer!, r.ownerId) ? '按价同意' : '同意') : '拒绝'}</b>}
              </span>
            )
          })}
        </div>
      </div>
    )
  }

  const bribes = neg.demands.filter(d => d.familyId == null && d.playerId !== neg.bossId && playerActiveFamilies(neg, d.playerId).size === 0)

  return (
    <div className="neg-panel">
      <div className="neg-header">
        <div>
          <div className="boss-tag">👑 {name(neg.bossId)} 是 Boss{neg.openerId !== neg.bossId && <span className="muted">（发起者 {state.players[neg.openerId]?.name}）</span>}</div>
          <div className="neg-sub">
            #{neg.spaceId} · {space.dividends} 份 × ${shareNow}M{shareNow !== (tile?.shareValue ?? 0) ? `（景气牌 $${tile?.shareValue}M）` : ''} · 一份 ≈ ${share}M · 方案 {neg.offersMade}/{MAX_OFFERS_PER_BOSS}{turnName ? ` · 轮到 ${turnName}` : ''}
          </div>
        </div>
        <div className="neg-gross">${gross}M</div>
      </div>
      {badges.length > 0 && (
        <div className="neg-badges">
          {badges.map((b, i) => <span key={i} className={`neg-badge ${b.tone}`} title={b.title}>{b.text}</span>)}
        </div>
      )}

      <div className="neg-block">
        <div className="neg-block-title">席位与叫价 <span className="muted" title="报价即承诺：Boss 的方案付到承诺价，持有者视为自动同意">同家族多代表时 Boss 只选其一 · 承诺价付到即成</span></div>
        {space.groups.map((g, i) => (
          <div key={i} className="fam-group">
            <div className="fam-group-title">
              {isRequiredGroup(g) ? <span className="fam-tag req">全部必需</span> : <span className="fam-tag opt">{g.families.join('/')} 中选 {g.need}</span>}
              <span className="muted">{g.families.filter(f => activeRepsOfFamily(neg, f).length > 0).length}/{g.need}</span>
            </div>
            {g.families.map(f => renderFamily(f, isRequiredGroup(g)))}
          </div>
        ))}
      </div>

      <div className="neg-block">
        <div className="neg-block-title">当前方案</div>
        {offer ? (
          <div className="offer-view">
            <div className="offer-reps">
              {offer.repKeys.map(k => {
                const r = findRep(neg, k)
                return r ? <span key={k} className="offer-rep"><FamilyChip familyId={r.familyId} size="sm" />←{state.players[r.ownerId]?.name}</span> : null
              })}
            </div>
            {offer.payouts.length > 0 ? offer.payouts.map(p => (
              <div key={p.playerId} className="payout-line">
                <span>{name(p.playerId)}</span>
                <b className="gold">${p.amount}M</b>
              </div>
            )) : <div className="muted">不给任何人分成</div>}
            <div className="payout-line boss-net">
              <span>{boss?.name} 净得</span>
              <b className="gold">${Math.max(0, gross - offer.payouts.reduce((s, p) => s + p.amount, 0))}M</b>
            </div>
            <div className="offer-status">
              {offerOwners(neg, offer).length === 0
                ? '只用 Boss 自己的代表，无需他人同意'
                : offerOwners(neg, offer).map(id => (
                  <span key={id} className={`resp ${offer.responses[id] === 'ACCEPTED' ? 'ok' : offer.responses[id] === 'DECLINED' ? 'no' : 'wait'}`}>
                    {state.players[id]?.name}：{offer.responses[id] === 'ACCEPTED' ? '同意' : offer.responses[id] === 'DECLINED' ? '拒绝' : '待表态'}
                  </span>
                ))}
              {canClose(state) && state.phase === 'NEGOTIATION' && <b className="green"> · 可宣布成交</b>}
            </div>
          </div>
        ) : (
          <div className="muted">{state.phase === 'NEGOTIATION' && neg.turnId !== neg.bossId ? '叫价轮：各方报出借价 / 打家族卡入场，Boss 听完再拼方案' : 'Boss 尚未提出方案'}</div>
        )}
      </div>

      {bribes.length > 0 && (
        <div className="neg-block">
          <div className="neg-block-title">封口费要求</div>
          {bribes.map(d => <div key={d.playerId} className="muted">{name(d.playerId)} 要 ${d.amount}M 才不搅局</div>)}
        </div>
      )}

      {neg.disruptors.length > 0 && (
        <div className="neg-block muted">本笔已出过干扰牌：{neg.disruptors.map(id => state.players[id]?.name).join('、')}</div>
      )}

      <div className="neg-block neg-chat-block">
        <div className="neg-block-title">谈判桌喊话</div>
        <div className="neg-chat" ref={chatRef}>
          {neg.speeches.length === 0 && <span className="muted">还没人说话</span>}
          {neg.speeches.map(s => (
            <div key={s.id} className={`chat-line${s.playerId === viewerId ? ' mine' : ''}${s.playerId === neg.bossId ? ' boss' : ''}`}>
              <b>{state.players[s.playerId]?.name}</b>：{s.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
