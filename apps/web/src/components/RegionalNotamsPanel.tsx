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
   *  clear the list isn't "everything active", mirroring SkyDemon's
   *  "narrow route brief" transparency about scope. */
  routeFiltered?: boolean
  bufferNm?: number
}

export default function RegionalNotamsPanel({ notams, routeFiltered, bufferNm }: Props) {
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
        const expanded = expandedIds.has(n.id)
        const eff = fmtNotamDate(n.effective)
        const exp = fmtNotamDate(n.expires)
        const hasGeo = n.lat !== null && n.lon !== null && n.radiusNm !== null
        return (
          <div key={n.id} className={css.item}>
            <button
              className={css.toggle}
              onClick={() => toggle(n.id)}
              aria-expanded={String(expanded) as 'true' | 'false'}
            >
              <span className={css.id}>{n.id}</span>
              {hasGeo && <span className={css.badge}>MAP</span>}
              <span className={css.period}>{eff}{exp ? ` – ${exp}` : ''}</span>
              <span className={css.chevron}>{expanded ? '▴' : '▾'}</span>
            </button>
            {expanded && <pre className={css.text}>{n.text}</pre>}
          </div>
        )
      })}
    </div>
  )
}
