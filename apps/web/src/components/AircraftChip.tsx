import { useEffect, useRef, useState } from 'react'
import { useAircraftProfiles } from '../db/useAircraftProfiles'
import type { AircraftProfileDocType } from '../db/index'
import css from './AircraftChip.module.css'

/**
 * The plan's aircraft, in the Route header: a chip that opens a short list
 * of the saved aircraft profiles to switch to, plus "Manage aircraft…"
 * (the Aircraft section). With no profiles the chip goes straight there.
 */
export default function AircraftChip({ selected, onSelect, onManage }: {
  selected?: AircraftProfileDocType
  onSelect?: (id: string | null) => void
  onManage: () => void
}) {
  const { profiles } = useAircraftProfiles()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)

  // Close on a click outside or Esc.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [open])

  const label = (p: AircraftProfileDocType) => p.registration?.trim() || p.name
  // Spans, not buttons: the chip sits inside the section header's button.
  const pick = (id: string) => { onSelect?.(id); setOpen(false) }
  const manage = () => { setOpen(false); onManage() }
  return (
    <span ref={ref} className={css.wrap} onClick={(e) => e.stopPropagation()}>
      <span
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`${css.chip}${selected ? '' : ` ${css.none}`}`}
        title={selected
          ? `Aircraft for this plan: ${selected.name}. Click to change.`
          : 'No aircraft: pick one for speeds, fuel and times en route'}
        onClick={() => (profiles.length === 0 ? onManage() : setOpen((o) => !o))}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); profiles.length === 0 ? onManage() : setOpen((o) => !o) } }}
      >
        {selected ? label(selected) : 'No aircraft'} {'\u25be'}
      </span>
      {open && (
        <span className={css.menu} role="menu">
          {profiles.map((p) => (
            <span
              key={p.id}
              role="menuitemradio"
              tabIndex={0}
              aria-checked={p.id === selected?.id}
              className={`${css.item}${p.id === selected?.id ? ` ${css.itemOn}` : ''}`}
              onClick={() => pick(p.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(p.id) } }}
            >
              <span className={css.itemReg}>{label(p)}</span>
              {p.registration?.trim() && p.name !== p.registration && <span className={css.itemName}>{p.name}</span>}
            </span>
          ))}
          <span
            role="menuitem"
            tabIndex={0}
            className={`${css.item} ${css.manage}`}
            onClick={manage}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); manage() } }}
          >
            Manage aircraft{'\u2026'}
          </span>
        </span>
      )}
    </span>
  )
}
