// ============================================================
// InfoTip — ⓘ 小按钮，点击展开一段解释（Esc / 点别处收起）。
// 用来把"报价即承诺"这类关键后果放到按钮旁边，而不是藏在灰色小字里。
// 触屏友好：点按钮展开（不依赖悬停）；手机上气泡贴在屏幕底部、占满宽度（见 game.css .info-tip-pop），不会溢出右缘。
// ============================================================

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

export default function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const popId = useId()

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    // pointerdown：触屏上轻点别处也能收起
    const onDown = (e: Event) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [open])

  return (
    <span className="info-tip" ref={ref}>
      <button type="button" className="info-tip-btn" aria-label={label} aria-expanded={open} aria-controls={open ? popId : undefined} onClick={() => setOpen(v => !v)}>ⓘ</button>
      {open && <span id={popId} className="info-tip-pop" role="tooltip">{children}</span>}
    </span>
  )
}
