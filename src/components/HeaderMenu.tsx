// ============================================================
// HeaderMenu — 手机顶栏的"更多"菜单：把规则 / 设置 / 返回 / 复盘 / AI 状态等次要入口收起来
//   · 触发按钮 aria-haspopup="menu" + aria-expanded；菜单 role="menu"，每项 role="menuitem"，触控高度 ≥ 44px
//   · 打开后焦点进入第一项；↑ ↓ Home End 在项之间移动，Esc / 点别处 / Tab 离开收起，并把焦点还给触发按钮
//   · 只在手机档渲染（见 App）；其他档位顶栏直接摆出图标按钮
// ============================================================

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

export interface MenuItem {
  key: string
  icon: string
  label: string
  onSelect: () => void
  /** 强调（如终局后的"逐步复盘"） */
  accent?: boolean
}

interface HeaderMenuProps {
  items: MenuItem[]
  /** 菜单顶部的只读信息（如 AI 状态徽标） */
  info?: ReactNode
  /** 触发按钮右上角的小红点（有重要入口待点，如终局后的结果卡） */
  dot?: boolean
}

export default function HeaderMenu({ items, info, dot }: HeaderMenuProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()

  const close = (restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) btnRef.current?.focus({ preventScroll: true })
  }

  // 打开：焦点进第一项
  useEffect(() => {
    if (!open) return
    rootRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true })
  }, [open])

  // 点别处收起
  useEffect(() => {
    if (!open) return
    const onDown = (e: Event) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const els = [...(rootRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const at = els.indexOf(document.activeElement as HTMLElement)
    const go = (i: number) => { e.preventDefault(); els[(i + els.length) % els.length]?.focus({ preventScroll: true }) }
    switch (e.key) {
      case 'ArrowDown': go(at + 1); break
      case 'ArrowUp': go(at - 1); break
      case 'Home': go(0); break
      case 'End': go(els.length - 1); break
      case 'Escape': e.preventDefault(); e.stopPropagation(); close(true); break
      case 'Tab': close(false); break
    }
  }

  return (
    <div className="header-menu" ref={rootRef}>
      <button
        ref={btnRef} type="button" className="btn-icon header-menu-btn" aria-label="更多" aria-haspopup="menu"
        aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen(v => !v)}
      >
        ⋯{dot && <span className="menu-dot" aria-hidden="true" />}
      </button>
      {open && (
        <div id={menuId} className="header-menu-pop" role="menu" aria-label="更多操作" onKeyDown={onMenuKey}>
          {info && <div className="header-menu-info">{info}</div>}
          {items.map(it => (
            <button
              key={it.key} type="button" role="menuitem" className={`header-menu-item${it.accent ? ' accent' : ''}`}
              onClick={() => { close(false); it.onSelect() }}
            >
              <span aria-hidden="true">{it.icon}</span>{it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
