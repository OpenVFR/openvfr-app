/**
 * The row at the top of a drawer section's body (or at the end of its filter row): the AI-assistant
 * sparkle and a "⋯" menu with the section's actions. Places and Flight Logs use it. The Route
 * section keeps its own header menu (RoutePlan) and Aircraft has no actions of its own; both use
 * the same 24 px icon button style (`iconSquareBtn`), so the controls look alike.
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { IconDots } from '@tabler/icons-react'
import css from './SectionActions.module.css'

export interface SectionMenuItem {
  label: string
  icon: ReactNode
  onSelect: () => void
  disabled?: boolean
  title?: string
}

export default function SectionActions({ assistant, items = [], label, inline = false }: { assistant?: ReactNode; items?: SectionMenuItem[]; label: string; /** Sits at the end of another row (no margin of its own). */ inline?: boolean }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const enabledItems = () => [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])]

  function closeMenu(restoreFocus: boolean) {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }

  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])

  // Opening moves focus to the first available action, like a menu button does.
  useEffect(() => { if (open) enabledItems()[0]?.focus() }, [open])

  function onMenuKeyDown(e: ReactKeyboardEvent) {
    const list = enabledItems()
    const at = list.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(true) }
    else if (e.key === 'Tab') setOpen(false)
    else if (e.key === 'ArrowDown') { e.preventDefault(); list[(at + 1) % list.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(at - 1 + list.length) % list.length]?.focus() }
    else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus() }
    else if (e.key === 'End') { e.preventDefault(); list[list.length - 1]?.focus() }
  }

  if (!assistant && items.length === 0) return null
  return (
    <div className={`${css.row} ${inline ? css.inline : ''}`}>
      {assistant}
      {items.length > 0 && (
        <div className={css.wrap} ref={wrapRef}>
          <button ref={triggerRef} type="button" className={css.btn} aria-haspopup="menu" aria-expanded={open} aria-label={`${label} actions`} title={`${label} actions`} onClick={() => setOpen(o => !o)}>
            <IconDots size={14} aria-hidden="true" />
          </button>
          {open && (
            <div className={css.menu} role="menu" aria-label={`${label} actions`} ref={menuRef} onKeyDown={onMenuKeyDown}>
              {items.map(it => (
                <button key={it.label} type="button" role="menuitem" className={css.item} disabled={it.disabled} title={it.title} onClick={() => { closeMenu(true); it.onSelect() }}>
                  {it.icon}
                  {it.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
