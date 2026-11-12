/**
 * The row at the top of a drawer section's body: the AI-assistant sparkle and a "⋯" menu with the
 * section's import / export actions. Route, Places, Aircraft and Flight Logs all use it, so
 * they look and behave the same: icon buttons on the right, actions in the menu.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
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

  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', esc) }
  }, [open])

  if (!assistant && items.length === 0) return null
  return (
    <div className={`${css.row} ${inline ? css.inline : ''}`}>
      {assistant}
      {items.length > 0 && (
        <div className={css.wrap} ref={wrapRef}>
          <button type="button" className={css.btn} aria-haspopup="menu" aria-expanded={open} aria-label={`${label} actions`} title={`${label} actions`} onClick={() => setOpen(o => !o)}>
            <IconDots size={14} aria-hidden="true" />
          </button>
          {open && (
            <div className={css.menu} role="menu" aria-label={`${label} actions`}>
              {items.map(it => (
                <button key={it.label} type="button" role="menuitem" className={css.item} disabled={it.disabled} title={it.title} onClick={() => { setOpen(false); it.onSelect() }}>
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
