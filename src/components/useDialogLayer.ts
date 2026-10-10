// ============================================================
// useDialogLayer — 弹层的键盘 / 焦点管理（role="dialog" aria-modal 的配套行为）
//   · 打开时：记住触发元素，焦点移进弹层（弹层根元素 tabIndex=-1，焦点落在根上，读屏先读标题）
//   · 打开期间：Tab / Shift+Tab 在弹层内循环；焦点跑到弹层外会被拉回
//   · 关闭时：焦点回到触发元素（它已被移除则不处理）
//   · 多层弹层（终局卡 → 复盘器）用栈管理：只有最上面一层响应 Tab / Esc
//   · 弹层根元素没有显式传 ref 时，自动认领"最后一个还没被认领的 [role="dialog"]"——这样不改 SettingsPanel 也能获得这套行为；
//     认领时顺手补上 aria-modal="true"
// ============================================================

import { useEffect, useRef, type RefObject } from 'react'

export interface DialogLayer {
  root: HTMLElement | null
  trigger: HTMLElement | null
}

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])',
  'textarea:not([disabled])', 'summary', '[tabindex]:not([tabindex="-1"])',
].join(',')

const stack: DialogLayer[] = []
const claimed = new WeakSet<HTMLElement>()

/** 弹层内可聚焦的元素（按文档顺序，跳过 hidden / inert 子树） */
export function focusablesIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => !el.closest('[hidden], [inert]') && el.tabIndex >= 0)
}

export function isTopLayer(layer: DialogLayer | null): boolean {
  return !!layer && stack[stack.length - 1] === layer
}

function findUnclaimedDialog(): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
  for (let i = all.length - 1; i >= 0; i--) if (!claimed.has(all[i])) return all[i]
  return null
}

function safeFocus(el: HTMLElement | null | undefined) {
  try { el?.focus({ preventScroll: true }) } catch { /* 元素已不可聚焦 */ }
}

export function useDialogLayer(ref?: RefObject<HTMLElement | null>): RefObject<DialogLayer | null> {
  const layerRef = useRef<DialogLayer | null>(null)

  useEffect(() => {
    const active = document.activeElement
    const trigger = active instanceof HTMLElement && active !== document.body ? active : null
    const root = ref?.current ?? findUnclaimedDialog()
    const layer: DialogLayer = { root, trigger }
    layerRef.current = layer
    stack.push(layer)
    /** 本层补上的属性：卸载时撤销（根元素可能是复用的，如侧栏抽屉关闭后不再是弹层） */
    const added: string[] = []
    if (root) {
      claimed.add(root)
      if (!root.hasAttribute('aria-modal')) { root.setAttribute('aria-modal', 'true'); added.push('aria-modal') }
      if (!root.hasAttribute('tabindex')) { root.setAttribute('tabindex', '-1'); added.push('tabindex') }
      // 弹层里标了 data-autofocus 的元素优先（如输入框）；否则焦点落在弹层根上
      safeFocus(root.querySelector<HTMLElement>('[data-autofocus]') ?? root)
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !root || !isTopLayer(layer)) return
      const items = focusablesIn(root)
      if (items.length === 0) { e.preventDefault(); safeFocus(root); return }
      const first = items[0], last = items[items.length - 1]
      const cur = document.activeElement
      if (e.shiftKey && (cur === first || cur === root || !root.contains(cur))) { e.preventDefault(); safeFocus(last) }
      else if (!e.shiftKey && (cur === last || !root.contains(cur))) { e.preventDefault(); safeFocus(first) }
    }
    const onFocusIn = (e: FocusEvent) => {
      if (!root || !isTopLayer(layer) || !(e.target instanceof Node) || root.contains(e.target)) return
      safeFocus(root)
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('focusin', onFocusIn)

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('focusin', onFocusIn)
      const wasTop = isTopLayer(layer)
      const at = stack.indexOf(layer)
      if (at >= 0) stack.splice(at, 1)
      if (root) { claimed.delete(root); added.forEach(a => root.removeAttribute(a)) }
      layerRef.current = null
      if (!wasTop) return
      // 回到触发元素；它已不在页面里时，把焦点交还给下面一层弹层
      if (trigger && trigger.isConnected) safeFocus(trigger)
      else safeFocus(stack[stack.length - 1]?.root)
    }
    // 只在挂载 / 卸载时执行：弹层的生命周期就是组件的生命周期
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return layerRef
}
