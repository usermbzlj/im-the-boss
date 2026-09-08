// ============================================================
// OfferEditor — Boss 方案编辑器
// 1) 每个需求组：必需组全选；N 选 M 组勾选家族；同家族多代表时单选其一
// 2) 分成：给任意非 Boss 玩家填金额（可一键按公开报价填入）
// 结构合法性由 rules.validateOfferShape 实时校验，与引擎口径完全一致
// ============================================================

import { useMemo, useState } from 'react'
import type { GameState, FamilyId, Payout, Representative } from '../engine/types'
import {
  getCurrentSpace, getGrossValue, oneShareOf, isRequiredGroup, selectReps, demandOf, repCost, validateOfferShape, offerConsent,
  findRep, repPriceOf, commitmentPrice,
} from '../engine/rules'
import { FAMILIES } from '../engine/config'
import { buildOfferCandidates } from '../engine/validator'
import { candidateTitle, describeCandidate, describeOfferError } from '../text/labels'
import FamilyChip from './FamilyChip'

interface OfferEditorProps {
  state: GameState
  onSubmit: (repKeys: string[], payouts: Payout[]) => void
  onClose: () => void
}

const HUMAN_ID = 0

export default function OfferEditor({ state, onSubmit, onClose }: OfferEditorProps) {
  const neg = state.negotiation!
  const space = getCurrentSpace(state)!
  const gross = getGrossValue(state)
  const share = oneShareOf(state)
  const candidates = useMemo(() => buildOfferCandidates(state), [state])

  // 初始：自动选出的最省方案（或当前方案）
  const initial = useMemo(() => {
    const keys = neg.offer?.repKeys ?? selectReps(state).repKeys
    const picks: Partial<Record<FamilyId, string>> = {}
    const chosen: FamilyId[] = []
    for (const k of keys) {
      const rep = neg.reps.find(r => r.key === k)
      if (rep && !rep.travelled) { picks[rep.familyId] = rep.key; chosen.push(rep.familyId) }
    }
    const pay: Record<number, number> = {}
    for (const p of neg.offer?.payouts ?? []) pay[p.playerId] = p.amount
    return { picks, chosen, pay }
  }, [state, neg])

  const [picks, setPicks] = useState<Partial<Record<FamilyId, string>>>(initial.picks)
  const [chosen, setChosen] = useState<FamilyId[]>(initial.chosen)
  const [pay, setPay] = useState<Record<number, number>>(initial.pay)

  const activeOf = (f: FamilyId): Representative[] =>
    neg.reps.filter(r => r.familyId === f && !r.travelled).sort((a, b) => repCost(state, a) - repCost(state, b))

  const pickOf = (f: FamilyId): Representative | undefined => {
    const cands = activeOf(f)
    return cands.find(r => r.key === picks[f]) ?? cands[0]
  }

  // 组装 repKeys：必需组全部家族；可选组按勾选
  const repKeys: string[] = []
  for (const g of space.groups) {
    const fams = isRequiredGroup(g) ? g.families : g.families.filter(f => chosen.includes(f))
    for (const f of fams) {
      const rep = pickOf(f)
      if (rep) repKeys.push(rep.key)
    }
  }
  const payouts: Payout[] = Object.entries(pay).filter(([, a]) => a > 0).map(([id, a]) => ({ playerId: Number(id), amount: a }))
  const error = validateOfferShape(state, repKeys, payouts)
  const total = payouts.reduce((s, p) => s + p.amount, 0)
  // 报价即承诺：付到承诺价的持有者自动同意，其余需表态
  const consent = offerConsent(neg, { repKeys, payouts })

  const toggleFamily = (g: typeof space.groups[number], f: FamilyId) => {
    setChosen(prev => {
      if (prev.includes(f)) return prev.filter(x => x !== f)
      const inGroup = prev.filter(x => g.families.includes(x))
      if (inGroup.length >= g.need) return prev
      return [...prev, f]
    })
  }

  const loadCandidate = (keys: string[], pays: Payout[]) => {
    const p: Partial<Record<FamilyId, string>> = {}
    const c: FamilyId[] = []
    for (const k of keys) {
      const rep = neg.reps.find(r => r.key === k)
      if (rep) { p[rep.familyId] = rep.key; c.push(rep.familyId) }
    }
    setPicks(p)
    setChosen(c)
    const pm: Record<number, number> = {}
    for (const x of pays) pm[x.playerId] = x.amount
    setPay(pm)
  }

  const fillFromDemands = () => {
    const next: Record<number, number> = { ...pay }
    const owners = new Set(repKeys.map(k => neg.reps.find(r => r.key === k)?.ownerId))
    for (const p of state.players) {
      if (p.id === neg.bossId) continue
      if (owners.has(p.id)) {
        // 用了他的代表：按方案里他每个代表各自家族的承诺价相加；没报价的按一份分红估
        let total = 0
        for (const k of repKeys) {
          const r = findRep(neg, k)
          if (r && r.ownerId === p.id) total += repPriceOf(neg, r) ?? share
        }
        next[p.id] = total
      } else {
        // 没用其代表：只有封口费（通用报价）才算
        const hush = demandOf(neg, p.id)
        if (hush != null) next[p.id] = hush
      }
    }
    setPay(next)
  }

  const priceLabel = (r: Representative) => {
    if (r.ownerId === neg.bossId) return 'Boss 自有 · 免费'
    const d = repPriceOf(neg, r)
    return d != null ? `承诺价 $${d}M` : `未报价（约 $${share}M）`
  }

  /** 分成行的承诺价说明：用了其代表 → 各代表价相加；否则显示封口费 */
  const commitLabel = (playerId: number, usesRep: boolean) => {
    if (usesRep) {
      const parts = repKeys.map(k => findRep(neg, k)).filter((r): r is Representative => !!r && r.ownerId === playerId)
      const prices = parts.map(r => repPriceOf(neg, r))
      if (prices.every(x => x == null)) return null
      const total = commitmentPrice(neg, { repKeys }, playerId)
      const detail = parts.length > 1 ? `（${parts.map((r, i) => `${FAMILIES[r.familyId].name} ${prices[i] != null ? `$${prices[i]}M` : '未报'}`).join(' + ')}）` : ''
      return total != null ? `承诺价 $${total}M${detail}` : `部分代表未报价${detail}`
    }
    const hush = demandOf(neg, playerId)
    return hush != null ? `封口费 $${hush}M` : null
  }

  const responseTag = (ownerId: number) => {
    const resp = neg.offer?.responses[ownerId]
    if (!neg.offer || ownerId === neg.bossId) return null
    if (resp === 'DECLINED') return <b className="red"> ✗上次拒绝</b>
    if (resp === 'ACCEPTED') return <b className="green"> ✓上次同意</b>
    return null
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="offer-editor" onClick={e => e.stopPropagation()}>
        <div className="offer-editor-head">
          <h2>提出方案 · #{space.id} 总额 ${gross}M</h2>
          <span className="muted">一份分红 ≈ ${share}M · 本任已提 {neg.offersMade}/5</span>
        </div>

        {candidates.length > 0 && (
          <div className="offer-presets">
            <span className="muted">快速填入：</span>
            {candidates.map(c => (
              <button key={c.key} className="btn btn-sm" title={describeCandidate(c)} onClick={() => loadCandidate(c.repKeys, c.payouts)}>
                {candidateTitle(c)}
              </button>
            ))}
          </div>
        )}

        <div className="offer-section">
          <div className="offer-section-title">1. 选用代表</div>
          {space.groups.map((g, gi) => (
            <div key={gi} className="offer-group">
              <div className="offer-group-head">
                {isRequiredGroup(g) ? <span className="fam-tag req">全部必需</span> : <span className="fam-tag opt">{g.families.join('/')} 中选 {g.need}（已选 {chosen.filter(f => g.families.includes(f)).length}）</span>}
              </div>
              {g.families.map(f => {
                const cands = activeOf(f)
                const included = isRequiredGroup(g) || chosen.includes(f)
                const picked = pickOf(f)
                return (
                  <div key={f} className={`offer-family${included ? '' : ' dim'}`}>
                    <label className="offer-family-head">
                      {!isRequiredGroup(g) && (
                        <input type="checkbox" checked={included} disabled={cands.length === 0} onChange={() => toggleFamily(g, f)} />
                      )}
                      <FamilyChip familyId={f} size="md" />
                    </label>
                    <div className="offer-cands">
                      {cands.length === 0 && <span className="red">无可用代表</span>}
                      {cands.map(r => (
                        <label key={r.key} className={`rep-option${picked?.key === r.key ? ' picked' : ''}`}>
                          <input type="radio" name={`rep-${f}`} disabled={!included} checked={picked?.key === r.key}
                            onChange={() => setPicks({ ...picks, [f]: r.key })} />
                          <span>{state.players[r.ownerId]?.name}{r.ownerId === HUMAN_ID ? '（你）' : ''}</span>
                          <em>{r.source === 'INVESTOR' ? '投资者' : '家族卡'}</em>
                          <i>{priceLabel(r)}</i>
                          {responseTag(r.ownerId)}
                        </label>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        <div className="offer-section">
          <div className="offer-section-title">
            2. 分成
            {neg.demands.length > 0 && <button className="btn btn-sm" onClick={fillFromDemands}>按公开报价填入</button>}
          </div>
          {state.players.filter(p => p.id !== neg.bossId).map(p => {
            const usesRep = repKeys.some(k => neg.reps.find(r => r.key === k)?.ownerId === p.id)
            const auto = consent.auto.includes(p.id)
            const commit = commitLabel(p.id, usesRep)
            return (
              <div key={p.id} className={`payout-row${usesRep ? ' uses-rep' : ''}`}>
                <span className="payout-name">
                  {p.name}{p.id === HUMAN_ID ? '（你）' : ''}
                  {usesRep ? <em>用其代表</em> : <em className="muted">未用其代表</em>}
                  {commit && <i>{commit}</i>}
                  {usesRep && (auto ? <b className="green"> ✓ 付到承诺价，自动同意</b> : <b className="muted"> 需其表态</b>)}
                </span>
                <input type="number" min={0} max={gross} value={pay[p.id] ?? 0}
                  onChange={e => setPay({ ...pay, [p.id]: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
                <span>M</span>
              </div>
            )
          })}
          <div className="payout-total">
            <span>你净得</span>
            <b className={gross - total <= 0 ? 'red' : 'gold'}>${gross - total}M</b>
          </div>
        </div>

        {error
          ? <p className="red offer-error">⚠ {describeOfferError(error)}</p>
          : <p className="green offer-ok">
            方案结构合法。
            {consent.auto.length + consent.asked.length === 0 ? '全用自己的代表，提出后可直接宣布成交。'
              : consent.asked.length === 0 ? '所有持有者都已付到承诺价，提出即视为全员同意，然后可直接宣布成交。'
                : `${consent.asked.map(id => state.players[id]?.name).join('、')} 需表态${consent.auto.length ? `；${consent.auto.map(id => state.players[id]?.name).join('、')} 自动同意` : ''}。`}
          </p>}
        <div className="neg-actions">
          <button className="btn btn-success" disabled={!!error} onClick={() => onSubmit(repKeys, payouts)}>提出方案</button>
          <button className="btn" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  )
}
