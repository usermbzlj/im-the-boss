// ============================================================
// InfoTip — ⓘ 小按钮，点击展开一段解释（Esc / 点别处收起）。
// 用来把"报价即承诺"这类关键后果放到按钮旁边，而不是藏在灰色小字里。
// ============================================================

import { useEffect, useRef, useState, type ReactNode } from 'react'

export default function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  return (
    <span className="info-tip" ref={ref}>
      <button type="button" className="info-tip-btn" aria-label={label} aria-expanded={open} onClick={() => setOpen(v => !v)}>ⓘ</button>
      {open && <span className="info-tip-pop" role="tooltip">{children}</span>}
    </span>
  )
}
