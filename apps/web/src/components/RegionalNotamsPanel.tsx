/**
 * RegionalNotamsPanel — plain list of FIR-wide NOTAMs (restricted/danger
 * areas, navaid outages, AIRAC amendments, military notices) that aren't
 * tied to any single airport ICAO.
 *
 * Complements the ad-hoc map circles (useRegionalNotams.ts /
 * useNotamAirspaceMatch.ts, rendered in MapView.tsx) -- this list is the
 * fallback for NOTAMs with no useful geometry to render on the map at all
 * (e.g. general AIRAC amendment announcements, broad military notice text
 * with no coordinates+radius), and also just a straightforward way to
 * review everything currently active without hunting around the map.
 */

import { useState } from 'react'
import { fmtNotamDate, type NotamItem } from '@open-vfr/shared/fetchNotam'
import css from './RegionalNotamsPanel.module.css'

interface Props {
  notams: NotamItem[]
  /** True when `notams` has already been filtered to proximity of the
   *  planned route (see SideDrawer.tsx) -- shown as a small note so it's
   *  clear the list isn't "everything active" but a narrowed-down brief. */
  routeFiltered?: boolean
  bufferNm?: number
  /** "MAP" badge action -- flies the map to this NOTAM's own geometry and
   *  opens it in the shared airspace-style popup (shape thumbnail + text).
   *  Undefined badge click is a no-op (still shown as a plain, non-
   *  interactive indicator) so this panel keeps working standalone. */
  onShowOnMap?: (notam: NotamItem) => void
}

export default function RegionalNotamsPanel({ notams, routeFiltered, bufferNm, onShowOnMap }: Props) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  const toggle = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  if (notams.length === 0) {
    return (
      <div className={css.empty}>
        No active regional NOTAMs{routeFiltered ? ` within ${bufferNm}nm of route` : ''}
      </div>
    )
  }

  return (
    <div>
      {routeFiltered && (
        <div className={css.filterNote}>Filtered to within {bufferNm}nm of planned route</div>
      )}
      {notams.map((n) => {
        // Tracked by nmsId, not the display id -- different issuing
        // authorities reuse the same published NOTAM number (confirmed
        // live: a German and an unrelated Italian NOTAM both "M3011/26"),
        // so expand/collapse state and the React key must use the
        // guaranteed-unique nmsId, not the number shown to the pilot.
        const expanded = expandedIds.has(n.nmsId)
        const eff = fmtNotamDate(n.effective)
        const exp = fmtNotamDate(n.expires)
        const hasGeo = n.polygon !== null || (n.lat !== null && n.lon !== null && n.radiusNm !== null)
        return (
          <div key={n.nmsId} className={css.item}>
            <div className={css.toggle}>
              <button
                className={css.toggleMain}
                onClick={() => toggle(n.nmsId)}
                aria-expanded={String(expanded) as 'true' | 'false'}
              >
                <span className={css.id}>{n.id}</span>
                <span className={css.period}>{eff}{exp ? ` – ${exp}` : ''}</span>
                <span className={css.chevron}>{expanded ? '▴' : '▾'}</span>
              </button>
              {hasGeo && (
                <button
                  className={css.badge}
                  onClick={() => onShowOnMap?.(n)}
                  title="Show on map"
                  disabled={!onShowOnMap}
                >
                  MAP
                </button>
              )}
            </div>
            {expanded && <pre className={css.text}>{n.text}</pre>}
          </div>
        )
      })}
    </div>
  )
}
