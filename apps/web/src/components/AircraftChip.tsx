import { useEffect, useRef, useState } from 'react'
import { useAircraftProfiles } from '../db/useAircraftProfiles'
import type { AircraftProfileDocType } from '../db/index'
import css from './AircraftChip.module.css'

/**
 * The plan's aircraft, in the Route header: a chip that opens a short list
 * of the saved aircraft profiles to switch to, plus "Manage aircraft…"
 * (the Aircraft section). With no profiles the chip goes straight there.
 *
 * Menu keyboard: opens with focus on the current aircraft, ↑/↓ (Home/End)
 * move, Enter/Space pick, Esc closes and returns focus to the chip, Tab
 * closes.
 */
export default function AircraftChip({ selected, onSelect, onManage }: {
  selected?: AircraftProfileDocType
  onSelect?: (id: string | null) => void
  onManage: () => void
}) {
  const { profiles } = useAircraftProfiles()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const chipRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close on a click outside.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  // Focus the current aircraft (or the first item) when the menu opens.
  useEffect(() => {
    if (!open) return
    const items = menuItems()
    const current = items.find((el) => el.getAttribute('aria-checked') === 'true')
    ;(current ?? items[0])?.focus()
  }, [open])

  const menuItems = () => [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [])]
  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) chipRef.current?.focus()
  }
  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = menuItems()
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    const move = (to: number) => { e.preventDefault(); items[(to + items.length) % items.length]?.focus() }
    if (e.key === 'ArrowDown') move(i + 1)
    else if (e.key === 'ArrowUp') move(i - 1)
    else if (e.key === 'Home') move(0)
    else if (e.key === 'End') move(items.length - 1)
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true) }
    else if (e.key === 'Tab') close(false)
  }

  const label = (p: AircraftProfileDocType) => p.registration?.trim() || p.name
  const pick = (id: string) => { onSelect?.(id); close(true) }
  const manage = () => { setOpen(false); onManage() }
  const toggleMenu = () => (profiles.length === 0 ? onManage() : setOpen((o) => !o))
  return (
    <span ref={ref} className={css.wrap}>
      <button
        ref={chipRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={selected ? `Aircraft: ${selected.name}` : 'No aircraft selected'}
        className={`${css.chip}${selected ? '' : ` ${css.none}`}`}
        title={selected
          ? `Aircraft for this plan: ${selected.name}. Click to change.`
          : 'No aircraft: pick one for speeds, fuel and times en route'}
        onClick={toggleMenu}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open && profiles.length > 0) { e.preventDefault(); setOpen(true) } }}
      >
        {selected ? label(selected) : 'No aircraft'} {'\u25be'}
      </button>
      {open && (
        <div ref={menuRef} className={css.menu} role="menu" aria-label="Aircraft" onKeyDown={onMenuKey}>
          {profiles.map((p) => (
            <button
              key={p.id}
              type="button"
              role="menuitemradio"
              tabIndex={-1}
              aria-checked={p.id === selected?.id}
              className={`${css.item}${p.id === selected?.id ? ` ${css.itemOn}` : ''}`}
              onClick={() => pick(p.id)}
            >
              <span className={css.itemReg}>{label(p)}</span>
              {p.registration?.trim() && p.name !== p.registration && <span className={css.itemName}>{p.name}</span>}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={`${css.item} ${css.manage}`}
            onClick={manage}
          >
            Manage aircraft{'\u2026'}
          </button>
        </div>
      )}
    </span>
  )
}
