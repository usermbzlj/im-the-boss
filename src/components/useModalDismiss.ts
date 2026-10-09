// ============================================================
// useModalDismiss — 弹层的关闭规则：点遮罩不关闭，Esc 才关闭；有未保存改动时先确认
//   之前点遮罩直接关闭，误触会丢掉已填内容（方案编辑器 / 设置）。
// ============================================================

import { useCallback, useEffect, useRef } from 'react'

export const DISCARD_CONFIRM_MESSAGE = '有未保存的修改，确定放弃吗？'

/**
 * 返回 requestClose：无改动直接 onClose；有改动先 confirm，确认后才 onClose。
 * 同时在弹层存活期间监听 Esc，行为与 requestClose 相同。
 */
export function useModalDismiss(dirty: boolean, onClose: () => void): () => void {
  const latest = useRef({ dirty, onClose })
  latest.current = { dirty, onClose }

  const requestClose = useCallback(() => {
    const { dirty: d, onClose: close } = latest.current
    if (d && !window.confirm(DISCARD_CONFIRM_MESSAGE)) return
    close()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      requestClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [requestClose])

  return requestClose
}
