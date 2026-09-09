import { useEffect, useRef } from 'react'
import css from './SnapPicker.module.css'
import type { RouteWaypoint } from '../utils/routeCalc'
import { CURRENT_POSITION_LABEL } from '@open-vfr/shared/snapLabels'

export type SnapCandidate = {
  waypoint: RouteWaypoint
  /** Feature type for display (e.g. 'AD', 'VOR', 'NDB', 'MRP', 'RP') */
  kind: string
}

interface Props {
  candidates: SnapCandidate[]
  x: number
  y: number
  onPick: (wp: RouteWaypoint) => void
  onClose: () => void
}

const KIND_CSS: Record<string, string> = {
  AD:  css.kindAd,
  VOR: css.kindVor,
  NDB: css.kindNdb,
  MRP: css.kindMrp,
  RP:  css.kindRp,
  UWP: css.kindUwp,
  PT:  css.kindPt,
}

export default function SnapPicker({ candidates, x, y, onPick, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)

  // Position the panel after mount so it stays within viewport.
  useEffect(() => {
    const el = panelRef.current
    if (!el) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    const rect = el.getBoundingClientRect()
    const left = Math.min(x + 8, vw - rect.width - 4)
    const top  = Math.min(y + 8, vh - rect.height - 4)
    el.style.left = `${left}px`
    el.style.top  = `${top}px`
  }, [x, y])
  return (
    <div className={css.overlay} onClick={onClose}>
      <div
        ref={panelRef}
        className={css.panel}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={css.header}>Add waypoint</div>
        <ul className={css.list}>
          {candidates.map((c, i) => (
            <li key={i}>
              <button
                className={css.item}
                onClick={() => { onPick(c.waypoint); onClose() }}
              >
                <span className={`${css.badge} ${KIND_CSS[c.kind] ?? css.kindDefault}`}>
                  {c.kind}
                </span>
                <span className={css.name}>{c.waypoint.name ?? (c.kind === 'PT' ? CURRENT_POSITION_LABEL : '—')}</span>
              </button>
            </li>
          ))}
          <li>
            <button className={css.item} onClick={onClose}>
              <span className={`${css.badge} ${css.badgeCancel}`}>✕</span>
              <span className={`${css.name} ${css.nameCancel}`}>Cancel</span>
            </button>
          </li>
        </ul>
      </div>
    </div>
  )
}
