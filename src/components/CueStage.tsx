// ============================================================
// CueStage — 演出覆盖层：把 CueProvider 里正在播放的演出画在牌桌上
//   · 位置：按 data-* 标记（座位 data-seat-id、版图格 data-space-id、家族标识 data-family、中央景气牌 .deal-pile、
//     手牌 .hand-cards）实时量出目标矩形，演出元素用 CSS 动画（变量 --dx / --dy 描述飞行位移）
//   · 覆盖层整体 pointer-events: none、aria-hidden：不拦截点击、不进入无障碍树，也不影响布局
//   · 终局庆祝通过 portal 挂到 body（盖在结果卡之上），同样不拦截操作
// ============================================================

import { useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { FAMILIES } from '../engine/config'
import type { ActiveCue, CueTarget } from '../ui/cues'
import DieFace from './DieFace'
import { useActiveCues } from './CueProvider'

interface Box { x: number; y: number; w: number; h: number; cx: number; cy: number }

type Part = 'cash' | 'meta' | 'value'

/** 在牌桌区域内找到目标元素，换算成相对覆盖层左上角的矩形；找不到返回 null */
function boxOf(root: HTMLElement, stage: HTMLElement, target: CueTarget | undefined, part?: Part): Box | null {
  if (!target) return null
  let el: Element | null = null
  switch (target.type) {
    case 'seat': {
      const seat = root.querySelector(`[data-seat-id="${target.playerId}"]`)
      el = (part === 'cash' ? seat?.querySelector('.seat-cash') : part === 'meta' ? seat?.querySelector('.seat-meta') : null) ?? seat ?? null
      break
    }
    case 'cell': el = root.querySelector(`[data-space-id="${target.spaceId}"]`); break
    case 'rep': {
      if (target.playerId == null) {
        const pub = root.querySelector('.public-market')
        el = pub?.querySelector(`[data-family="${target.familyId}"]`) ?? pub ?? root.querySelector('.deal-pile')
      } else {
        const seat = root.querySelector(`[data-seat-id="${target.playerId}"]`)
        el = seat?.querySelector(`[data-family="${target.familyId}"]`) ?? seat ?? null
      }
      break
    }
    case 'hand': el = root.querySelector('.hand-cards') ?? root.querySelector('.hand'); break
    case 'pile': el = (part === 'value' ? root.querySelector('.pile-value') : null) ?? root.querySelector('.deal-pile'); break
  }
  if (!el) return null
  const s = stage.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  const x = r.left - s.left, y = r.top - s.top
  return { x, y, w: r.width, h: r.height, cx: x + r.width / 2, cy: y + r.height / 2 }
}

const timing = (c: ActiveCue): CSSProperties => ({ animationDuration: `${c.ms}ms`, animationDelay: `${c.delay}ms` })

/** 确定性的伪随机（0–1），让彩带每次长得一样、渲染无副作用 */
const rnd = (i: number, salt: number) => {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453
  return x - Math.floor(x)
}

const CONFETTI_COLORS = ['#f0b429', '#3fb950', '#58a6ff', '#f85149', '#bc8cff', '#ffd966', '#e67e22']

function WinLayer({ cue }: { cue: ActiveCue }) {
  const good = cue.tone === 'good'
  const pieces = good ? 36 : 14
  return createPortal(
    <div className={`cue-win ${good ? 'tone-good' : 'tone-neutral'}`} aria-hidden="true">
      {Array.from({ length: pieces }, (_, i) => (
        <span
          key={i}
          className="confetti"
          style={{
            left: `${6 + rnd(i, 1) * 88}%`,
            background: good ? CONFETTI_COLORS[i % CONFETTI_COLORS.length] : '#ffd966',
            animationDuration: `${2300 + rnd(i, 2) * 1500}ms`,
            animationDelay: `${rnd(i, 3) * 500}ms`,
            '--drift': `${(rnd(i, 4) - 0.5) * 160}px`,
            '--spin': `${360 + rnd(i, 5) * 540}deg`,
          } as CSSProperties}
        />
      ))}
      <div className="cue-win-banner" style={{ animationDuration: `${cue.ms}ms` }}>
        <span className="cue-win-icon">🏆</span>
        <span className="cue-win-text">{cue.caption}</span>
      </div>
    </div>,
    document.body,
  )
}

function CueView({ cue, stage }: { cue: ActiveCue; stage: RefObject<HTMLDivElement | null> }) {
  const [boxes, setBoxes] = useState<{ at: Box | null; from: Box | null } | null>(null)

  useLayoutEffect(() => {
    const el = stage.current
    const root = el?.parentElement
    if (!el || !root) { setBoxes({ at: null, from: null }); return }
    const part: Part | undefined = cue.kind === 'money' ? 'cash' : cue.kind === 'draw' ? 'meta' : cue.kind === 'price' ? 'value' : undefined
    setBoxes({ at: boxOf(root, el, cue.target, part), from: boxOf(root, el, cue.from) })
  }, [cue, stage])

  if (cue.kind === 'win') return <WinLayer cue={cue} />
  if (!boxes) return null
  const sr = stage.current?.getBoundingClientRect()
  const fallback: Box = { x: 0, y: 0, w: sr?.width ?? 0, h: sr?.height ?? 0, cx: (sr?.width ?? 0) / 2, cy: (sr?.height ?? 0) / 2 }
  const at = boxes.at ?? fallback
  const from = boxes.from
  const tone = `tone-${cue.tone}${cue.mine ? ' mine' : ''}`
  const famColor = cue.familyId ? FAMILIES[cue.familyId].color : undefined
  const fly = (a: Box, b: Box): CSSProperties => ({ left: a.cx, top: a.cy, '--dx': `${b.cx - a.cx}px`, '--dy': `${b.cy - a.cy}px`, ...timing(cue) } as CSSProperties)
  const caption = cue.drama && cue.caption && cue.kind !== 'close'
    ? <div className={`cue cue-caption ${tone}`} style={timing(cue)}>{cue.icon && <span>{cue.icon}</span>}{cue.caption}</div>
    : null

  switch (cue.kind) {
    case 'money':
      return <div className={`cue cue-money ${tone}`} data-cue="money" style={{ left: at.cx, top: at.y, ...timing(cue) }}>{cue.text}</div>
    case 'draw':
      if (cue.target.type === 'hand') {
        const n = Math.min(cue.amount ?? 1, 4)
        const origin = from ?? { ...at, cx: at.cx, cy: at.y - 120 }
        return (
          <>
            {Array.from({ length: n }, (_, i) => (
              <div key={i} className="cue cue-fly cue-cardback" data-cue="draw"
                style={{ ...fly(origin, at), animationDelay: `${cue.delay + i * 90}ms` }} />
            ))}
          </>
        )
      }
      return <div className="cue cue-money cue-draw tone-neutral" data-cue="draw" style={{ left: at.cx, top: at.cy, ...timing(cue) }}>🂠 {cue.text}</div>
    case 'play':
      return (
        <div className="cue cue-play" data-cue="play" style={{ left: at.x, top: at.y, width: at.w, height: at.h, ...timing(cue) }}>
          <span className="cue-play-icon">{cue.icon}</span>
        </div>
      )
    case 'boss': {
      const a = from ?? at
      return (
        <>
          <div className="cue cue-fly cue-boss" data-cue="boss" style={fly(a, at)}><span>👑</span></div>
          <div className={`cue cue-ring ${tone}`} style={{ left: at.x, top: at.y, width: at.w, height: at.h, ...timing(cue) }} />
          {caption}
        </>
      )
    }
    case 'travel':
      return (
        <>
          <div className="cue cue-ghost cue-travel" data-cue="travel" style={{ left: at.cx, top: at.cy, ...timing(cue) }}>
            <span className="cue-chip" style={{ background: famColor }}>{cue.familyId}</span>
            <span className="cue-ghost-icon">✈️</span>
          </div>
          {caption}
        </>
      )
    case 'recruit': {
      const a = from ?? at
      return (
        <>
          <div className="cue cue-fly cue-recruit" data-cue="recruit" style={fly(a, at)}>
            <span className="cue-chip" style={{ background: famColor }}>{cue.familyId}</span>
          </div>
          <div className={`cue cue-ring ${tone}`} style={{ left: at.x, top: at.y, width: at.w, height: at.h, ...timing(cue), animationDelay: `${cue.delay + cue.ms * 0.5}ms` }} />
          {caption}
        </>
      )
    }
    case 'stop':
      return (
        <>
          <div className="cue cue-stop" data-cue="stop" style={{ left: at.cx, top: at.cy, ...timing(cue) }}>
            <span className="cue-stop-card"><span>{cue.icon}</span></span>
            <span className="cue-stop-mark">🛑</span>
          </div>
          {caption}
        </>
      )
    case 'price':
      return (
        <>
          <div className={`cue cue-price ${tone}`} data-cue="price" style={{ left: at.cx, top: at.cy, ...timing(cue) }}>{cue.text}</div>
          {caption}
        </>
      )
    case 'close':
      return (
        <div className="cue cue-close" data-cue="close" style={{ left: at.x, top: at.y, width: at.w, height: at.h, ...timing(cue) }}>
          <span className="cue-close-ring" />
          {Array.from({ length: 8 }, (_, i) => <span key={i} className="cue-spark" style={{ '--a': `${i * 45}deg` } as CSSProperties} />)}
          <span className="cue-close-stamp">成交</span>
        </div>
      )
    case 'fail':
      return (
        <div className="cue cue-fail" data-cue="fail" style={{ left: at.x, top: at.y, width: at.w, height: at.h, ...timing(cue) }}>
          <span>✕ {cue.text}</span>
        </div>
      )
    case 'dice':
      return (
        <div className={`cue cue-dice ${tone}`} data-cue="dice" style={{ left: at.cx, top: at.cy, ...timing(cue) }}>
          <DieFace value={cue.die ?? 1} rollMs={Math.round(cue.ms * 0.6)} />
        </div>
      )
    case 'marker': {
      if (!from) {
        return <div className="cue cue-drop" data-cue="marker" style={{ left: at.cx, top: at.cy, ...timing(cue) }}>💰</div>
      }
      return <div className="cue cue-fly cue-marker" data-cue="marker" style={fly(from, at)}>💰</div>
    }
    default:
      return null
  }
}

export default function CueStage() {
  const cues = useActiveCues()
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div className="cue-stage" ref={ref} aria-hidden="true" data-testid="cue-stage">
      {cues.map(c => <CueView key={`${c.id}:${c.version}`} cue={c} stage={ref} />)}
    </div>
  )
}
