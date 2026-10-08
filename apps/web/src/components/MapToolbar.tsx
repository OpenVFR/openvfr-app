import { useEffect, useRef, useState, type ReactNode } from 'react'
import { IconGridDots } from '@tabler/icons-react'
import css from './MapToolbar.module.css'

/** One action: a tile in the menu, or a standalone one-tap map button. */
export interface ToolItem {
  id: string
  label: string
  /** One-sentence hover/long-press hint: what it does and how it behaves. */
  description?: string
  icon: ReactNode
  active?: boolean
  dim?: boolean
  /** Keep the menu open after selecting. */
  keepOpen?: boolean
  onSelect: () => void
}

export interface ToolGroupDef {
  id: string
  label: string
  items: ToolItem[]
}

/** Hover text: "Label — description" (just the label when there's no description). */
function hint(it: ToolItem): string {
  return it.description ? `${it.label} — ${it.description}` : it.label
}

function Glyph({ icon }: { icon: ReactNode }) {
  return <span className={css.glyph}>{icon}</span>
}

/**
 * Map toolbar: one 3×3 dot-grid button opens a compact tile menu (grouped sections) to
 * the left. `solos` are one-tap buttons that stay on the map next to it.
 * Closes on selection, outside tap or Esc.
 */
export default function MapToolbar({ groups, solos }: { groups: ToolGroupDef[]; solos: ToolItem[] }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: Event) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const anyActive = groups.flatMap(g => g.items).some(i => i.active)

  return (
    <div ref={rootRef} className={css.root}>
      <div className={css.group}>
        {open && (
          <div className={css.menu} role="menu" aria-label="Map tools">
            {groups.map(g => (
              <div key={g.id} className={css.menuSection}>
                <div className={css.menuHeading}>{g.label}</div>
                <div className={css.menuGrid}>
                  {g.items.map(it => (
                    <button
                      key={it.id}
                      role="menuitem"
                      title={hint(it)}
                      className={`${css.tile} ${it.active ? css.tileActive : ''} ${it.dim ? css.dim : ''}`}
                      onClick={() => { it.onSelect(); if (!it.keepOpen) setOpen(false) }}
                    >
                      <Glyph icon={it.icon} /><span className={css.tileLabel}>{it.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        <button
          className={`${css.btn} ${anyActive ? css.active : ''} ${open ? css.open : ''}`}
          title={anyActive ? 'Map tools — find places, ruler and route editing. A tool is active (highlighted).' : 'Map tools — find places, ruler and route editing'}
          aria-label="Map tools"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(o => !o)}
        >
          <Glyph icon={<IconGridDots size={18} stroke={2} />} />
        </button>
      </div>
      {solos.map(s => (
        <div key={s.id} className={css.group}>
          <button
            className={`${css.btn} ${s.active ? css.active : ''} ${s.dim ? css.dim : ''}`}
            title={hint(s)}
            aria-label={s.label}
            aria-pressed={s.active}
            onClick={() => { setOpen(false); s.onSelect() }}
          >
            <Glyph icon={s.icon} />
          </button>
        </div>
      ))}
    </div>
  )
}
