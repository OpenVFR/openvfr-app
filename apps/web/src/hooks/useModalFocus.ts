/**
 * What a modal dialog owes the keyboard and screen readers: focus moves into it, Tab stays inside,
 * Escape closes it (and nothing behind it hears that key), and focus goes back to where it came from.
 * Returns the ref to put on the dialog's card.
 */
import { useEffect, useRef } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

export function useModalFocus(onClose: () => void, returnFocusTo?: HTMLElement | null) {
  const cardRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const card = cardRef.current
    const target = returnFocusTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    ;(card?.querySelector<HTMLElement>('input, select, textarea') ?? card?.querySelector<HTMLElement>('button'))?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRef.current(); return }
      if (e.key !== 'Tab' || !cardRef.current) return
      const items = [...cardRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => el.offsetParent !== null)
      if (items.length === 0) return
      const first = items[0]!, last = items[items.length - 1]!
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      else if (!cardRef.current.contains(document.activeElement)) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('keydown', onKey, true); target?.focus() }
    // Once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return cardRef
}
