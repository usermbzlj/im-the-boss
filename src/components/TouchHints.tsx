// ============================================================
// TouchHints — 触屏上的 title 替代
//   界面里大量说明写在 title 属性里（版图格需求、座位态度原因、家族名、按钮为何置灰 …），鼠标悬停才看得到，触屏上根本没有。
//   这里统一补一层：在"没有悬停"的设备（hover: none）上，
//     · 轻点带 title 的静态元素（文字 / 徽标 / 版图格 / 座位标签）→ 弹出一个小气泡显示 title 全文；
//     · 长按任何带 title 的元素（含按钮；置灰按钮的原因也在 title 里）→ 同样弹出，并吞掉随后那次点击，不会误触发操作；
//     · 点别处 / 滚动 / 约 5 秒后 / Esc 收起。
//   可交互元素（按钮 / 链接 / 输入 / role=button 等）轻点仍照常工作，不弹气泡——它们的 title 靠长按查看。
//   手牌自带长按放大（CardHand），不在此处理。
// ============================================================

import { useEffect, useRef, useState } from 'react'

/** 长按多久触发（毫秒） */
export const HINT_LONG_PRESS_MS = 500
/** 气泡停留多久（毫秒） */
export const HINT_TTL_MS = 5000
/** 手指移动超过这个距离（px）就不算点按 / 长按 */
const MOVE_TOLERANCE = 10

const INTERACTIVE = 'button, a[href], input, select, textarea, summary, label, [role="button"], [role="tab"], [role="radio"], [role="menuitem"], [role="switch"], [role="checkbox"]'

interface Hint { text: string; left: number; top: number; above: boolean; key: number }

/** 离触点最近的、带非空 title 的祖先元素 */
export function hintTargetOf(el: EventTarget | null): HTMLElement | null {
  if (!(el instanceof Element)) return null
  const t = el.closest<HTMLElement>('[title]')
  if (!t || !t.getAttribute('title')?.trim()) return null
  if (t.closest('.card')) return null // 手牌有自己的放大预览
  return t
}

/** 元素本身或其祖先是可交互控件（轻点会执行操作，不弹气泡） */
export function isInteractiveTarget(t: HTMLElement): boolean {
  return !!t.closest(INTERACTIVE) || t.classList.contains('selectable')
}

function placeHint(t: HTMLElement, text: string, key: number): Hint {
  const r = t.getBoundingClientRect()
  const vw = window.innerWidth, vh = window.innerHeight
  const width = Math.min(280, vw - 24)
  const left = Math.max(12, Math.min(r.left + r.width / 2 - width / 2, vw - width - 12))
  const above = r.bottom + 120 > vh && r.top > 120
  return { text, left, top: above ? r.top - 8 : r.bottom + 8, above, key }
}

export default function TouchHints({ enabled }: { enabled?: boolean }) {
  const [hint, setHint] = useState<Hint | null>(null)
  const seq = useRef(0)
  const on = enabled ?? (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(hover: none)').matches)

  useEffect(() => {
    if (!on) return
    let press: { x: number; y: number; t: number; target: HTMLElement | null; timer: ReturnType<typeof setTimeout> | null; fired: boolean } | null = null
    let swallowClickUntil = 0
    let hideTimer: ReturnType<typeof setTimeout> | null = null

    const hide = () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }; setHint(null) }
    const show = (t: HTMLElement) => {
      const text = t.getAttribute('title')!.trim()
      setHint(placeHint(t, text, ++seq.current))
      if (hideTimer) clearTimeout(hideTimer)
      hideTimer = setTimeout(hide, HINT_TTL_MS)
    }
    const clearPress = () => { if (press?.timer) clearTimeout(press.timer); press = null }

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return
      const inHint = (e.target as Element | null)?.closest?.('.touch-hint')
      if (!inHint) hide()
      clearPress()
      const target = hintTargetOf(e.target)
      if (!target) return
      press = { x: e.clientX, y: e.clientY, t: Date.now(), target, timer: null, fired: false }
      const p = press
      p.timer = setTimeout(() => { p.fired = true; swallowClickUntil = Date.now() + 700; show(target) }, HINT_LONG_PRESS_MS)
    }
    const onMove = (e: PointerEvent) => {
      if (!press) return
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOLERANCE) clearPress()
    }
    const onUp = (e: PointerEvent) => {
      const p = press
      if (!p || e.pointerType === 'mouse') return
      if (p.timer) clearTimeout(p.timer)
      press = null
      if (p.fired || !p.target) return
      // 短按：静态元素弹气泡；可交互元素照常执行自己的操作
      if (Date.now() - p.t < HINT_LONG_PRESS_MS && !isInteractiveTarget(p.target)) show(p.target)
    }
    const onCancel = () => clearPress()
    const onClickCapture = (e: MouseEvent) => {
      if (Date.now() < swallowClickUntil) { swallowClickUntil = 0; e.preventDefault(); e.stopPropagation() }
    }
    const onContextMenu = (e: Event) => { if (press?.fired || Date.now() < swallowClickUntil) e.preventDefault() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide() }

    document.addEventListener('pointerdown', onDown)
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onCancel)
    document.addEventListener('click', onClickCapture, true)
    document.addEventListener('contextmenu', onContextMenu)
    document.addEventListener('keydown', onKey)
    document.addEventListener('scroll', hide, true)
    return () => {
      clearPress()
      if (hideTimer) clearTimeout(hideTimer)
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onCancel)
      document.removeEventListener('click', onClickCapture, true)
      document.removeEventListener('contextmenu', onContextMenu)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('scroll', hide, true)
    }
  }, [on])

  if (!on || !hint) return null
  return (
    <div
      key={hint.key} className={`touch-hint${hint.above ? ' above' : ''}`} role="status"
      style={{ left: hint.left, top: hint.top }}
    >
      {hint.text}
    </div>
  )
}
