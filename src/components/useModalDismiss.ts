// ============================================================
// useModalDismiss — 弹层的关闭规则：点遮罩不关闭，Esc 才关闭；有未保存改动时先确认
//   之前点遮罩直接关闭，误触会丢掉已填内容（方案编辑器 / 设置）。
//   同时接入 useDialogLayer：打开时聚焦进弹层、Tab 在弹层内循环、关闭后焦点回到触发元素；
//   多层弹层时只有最上面一层响应 Esc。
// ============================================================

import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { isTopLayer, useDialogLayer } from './useDialogLayer'

export const DISCARD_CONFIRM_MESSAGE = '有未保存的修改，确定放弃吗？'

/**
 * 返回 requestClose：无改动直接 onClose；有改动先 confirm，确认后才 onClose。
 * 同时在弹层存活期间监听 Esc，行为与 requestClose 相同。
 * root：弹层根元素（可省略——省略时自动认领页面里最后一个 [role="dialog"]）。
 */
export function useModalDismiss(dirty: boolean, onClose: () => void, root?: RefObject<HTMLElement | null>): () => void {
  const latest = useRef({ dirty, onClose })
  latest.current = { dirty, onClose }
  const layer = useDialogLayer(root)

  const requestClose = useCallback(() => {
    const { dirty: d, onClose: close } = latest.current
    if (d && !window.confirm(DISCARD_CONFIRM_MESSAGE)) return
    close()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (layer.current && !isTopLayer(layer.current)) return // 上面还有别的弹层：由它处理
      e.preventDefault()
      requestClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [requestClose, layer])

  return requestClose
}
