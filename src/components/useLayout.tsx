// ============================================================
// useLayout — 当前布局档位（desktop / narrow / tablet / phone + 矮屏），见 ui/layout.ts
//   · 样式靠 game.css 的 @media；这里只给"需要 JS 才能决定"的地方用（紧凑版图、抽屉语义、座位滚动、焦点管理）
//   · 没有 matchMedia（jsdom / SSR）时按宽屏桌面处理，现有组件测试不受影响
//   · 测试可用 <LayoutProvider value={layoutFor(390, 844)}> 强制某一档
// ============================================================

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { DESKTOP_LAYOUT, MEDIA, layoutFor, type LayoutInfo } from '../ui/layout'

const LayoutContext = createContext<LayoutInfo | null>(null)

export function LayoutProvider({ value, children }: { value: LayoutInfo; children: ReactNode }) {
  return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>
}

/** 读取浏览器当前视口对应的档位；不支持 matchMedia 时返回宽屏桌面 */
export function readLayout(): LayoutInfo {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return DESKTOP_LAYOUT
  return layoutFor(window.innerWidth, window.innerHeight)
}

const sameLayout = (a: LayoutInfo, b: LayoutInfo) =>
  a.tier === b.tier && a.short === b.short && a.drawer === b.drawer && a.compactBoard === b.compactBoard && a.scrollSeats === b.scrollSeats

export function useLayout(): LayoutInfo {
  const forced = useContext(LayoutContext)
  const [live, setLive] = useState<LayoutInfo>(readLayout)

  useEffect(() => {
    if (forced || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const update = () => setLive(prev => { const next = readLayout(); return sameLayout(prev, next) ? prev : next })
    const queries = [MEDIA.drawer, MEDIA.phone, MEDIA.short, '(max-width: 1279px)'].map(q => window.matchMedia(q))
    queries.forEach(q => q.addEventListener?.('change', update))
    window.addEventListener('resize', update)
    update()
    return () => {
      queries.forEach(q => q.removeEventListener?.('change', update))
      window.removeEventListener('resize', update)
    }
  }, [forced])

  return forced ?? live
}
