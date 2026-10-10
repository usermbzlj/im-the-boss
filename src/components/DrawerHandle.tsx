// ============================================================
// DrawerHandle — 平板 / 手机上，行动区上方的一条"谈判桌 / 日志"手柄：一键打开侧栏抽屉，带未读提示
//   桌面档位（侧栏常驻）由 CSS 隐藏；这里只管结构与语义。
// ============================================================

import { unreadLabel } from '../ui/unread'

interface DrawerHandleProps {
  open: boolean
  /** 当前侧栏会显示什么：谈判中 = 谈判桌，否则日志 */
  negotiating: boolean
  unread: number
  controlsId: string
  onToggle: () => void
}

export default function DrawerHandle({ open, negotiating, unread, controlsId, onToggle }: DrawerHandleProps) {
  const label = negotiating ? '谈判桌' : '日志与交易历史'
  return (
    <button
      type="button"
      className={`drawer-handle${unread > 0 ? ' has-unread' : ''}${negotiating ? ' negotiating' : ''}`}
      aria-expanded={open}
      aria-controls={controlsId}
      aria-label={`${open ? '收起' : '打开'}${label}${unread > 0 ? `，${unread} 条未读动态` : ''}`}
      onClick={onToggle}
    >
      <span className="drawer-handle-grip" aria-hidden="true" />
      <span className="drawer-handle-icon" aria-hidden="true">{negotiating ? '🤝' : '📜'}</span>
      <span className="drawer-handle-label">{label}</span>
      {unread > 0 && <span className="drawer-unread" aria-hidden="true">{unreadLabel(unread)}</span>}
      <span className="drawer-handle-caret" aria-hidden="true">{open ? '▼' : '▲'}</span>
    </button>
  )
}
