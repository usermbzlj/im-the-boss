// ============================================================
// layout — 响应式布局的断点与"当前是哪一档"的纯函数（无 React，可直接单测）
//
// 断点必须与 styles/game.css 里的 @media 保持一致（CSS 管样式，这里管"需要 JS 才能决定"的事：
// 版图用紧凑格子、座位滚动到行动者、侧栏当抽屉时的焦点管理 / 语义等）：
//
//   desktop  ≥ 1280      原样：侧栏常驻 390px
//   narrow   1024–1279   侧栏常驻 330px，座位改成单行横滚的紧凑卡
//   tablet   768–1023    侧栏变成右侧抽屉（行动区上方有一条"谈判桌 / 日志"手柄，带未读提示）
//   phone    ≤ 767       侧栏变成底部全屏 sheet；行动区固定在底部；版图用紧凑格子
//   short    高度 ≤ 500  横屏手机 / 矮窗口：版图在左、行动区与手牌在右，压缩纵向空间（与宽度档正交）
// ============================================================

export const BREAKPOINTS = {
  /** ≤ 此宽度 = 手机 */
  phoneMax: 767,
  /** ≤ 此宽度 = 侧栏是抽屉（平板 + 手机） */
  drawerMax: 1023,
  /** ≤ 此宽度 = 窄桌面（侧栏收窄、座位紧凑） */
  narrowMax: 1279,
  /** ≤ 此高度 = 矮屏（横屏手机） */
  shortMaxHeight: 500,
} as const

/** CSS 媒体查询的文本版本（matchMedia 用；与 game.css 一一对应） */
export const MEDIA = {
  drawer: `(max-width: ${BREAKPOINTS.drawerMax}px)`,
  phone: `(max-width: ${BREAKPOINTS.phoneMax}px)`,
  short: `(max-height: ${BREAKPOINTS.shortMaxHeight}px)`,
} as const

export type LayoutTier = 'desktop' | 'narrow' | 'tablet' | 'phone'

export interface LayoutInfo {
  tier: LayoutTier
  /** 侧栏是抽屉（tablet / phone） */
  drawer: boolean
  /** 矮屏（横屏手机）：纵向空间极少 */
  short: boolean
  /** 版图使用紧凑格子（手机竖屏 / 矮屏） */
  compactBoard: boolean
  /** 座位排成单行横滚（窄桌面及以下） */
  scrollSeats: boolean
}

/** 按视口宽高判定布局档位；非法 / 缺失的尺寸一律按宽屏桌面处理（SSR / jsdom 缺省） */
export function layoutFor(width: number, height: number): LayoutInfo {
  const w = Number.isFinite(width) && width > 0 ? width : Infinity
  const h = Number.isFinite(height) && height > 0 ? height : Infinity
  const tier: LayoutTier = w <= BREAKPOINTS.phoneMax ? 'phone'
    : w <= BREAKPOINTS.drawerMax ? 'tablet'
      : w <= BREAKPOINTS.narrowMax ? 'narrow'
        : 'desktop'
  const short = h <= BREAKPOINTS.shortMaxHeight
  return {
    tier,
    drawer: tier === 'phone' || tier === 'tablet',
    short,
    compactBoard: tier === 'phone' || short,
    scrollSeats: tier !== 'desktop',
  }
}

export const DESKTOP_LAYOUT: LayoutInfo = layoutFor(Infinity, Infinity)
