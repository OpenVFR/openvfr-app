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

// Single-line, meaningfully-truncated preview of the NOTAM's free-text body
// -- NMS-API's `text` is already plain English prose (confirmed via
// useNotamAirspaceMatch.ts's quoted real samples, e.g. "DANGER AREA ESD873
// OPTAND COMPLETELY WITHDRAWN"), not raw ICAO Q)/A)/E) telex where the
// first line is usually just codes -- so a plain character-count truncation
// is actually informative here, unlike it would be for classic telex format.
const PREVIEW_LEN = 90
function previewText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > PREVIEW_LEN ? `${flat.slice(0, PREVIEW_LEN)}\u2026` : flat
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

  // Group same-location NOTAMs together (previously unsorted -- whatever
  // order the API happened to return, making a long list impossible to scan
  // even with the new location/preview text below), tie-broken by soonest-
  // expiring first within the same location.
  const sortedNotams = [...notams].sort((a, b) => {
    const locCmp = (a.icaoLocation ?? '').localeCompare(b.icaoLocation ?? '')
    if (locCmp !== 0) return locCmp
    return (a.expires ?? '').localeCompare(b.expires ?? '')
  })

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
      {sortedNotams.map((n) => {
        // Tracked by nmsId, not the display id -- different issuing
        // authorities reuse the same published NOTAM number (confirmed
        // live: a German and an unrelated Italian NOTAM both "M3011/26"),
        // so expand/collapse state and the React key must use the
        // guaranteed-unique nmsId, not the number shown to the pilot.
        const expanded = expandedIds.has(n.nmsId)
        const eff = fmtNotamDate(n.effective)
        const exp = fmtNotamDate(n.expires)
        const hasGeo = n.polygon !== null || (n.lat !== null && n.lon !== null && n.radiusNm !== null)
        const isMilitary = n.classification === 'MILITARY'
        return (
          <div key={n.nmsId} className={css.item}>
            <div className={css.toggle}>
              <button
                className={css.toggleMain}
                onClick={() => toggle(n.nmsId)}
                aria-expanded={String(expanded) as 'true' | 'false'}
              >
                {n.icaoLocation && <span className={css.locBadge}>{n.icaoLocation}</span>}
                {isMilitary && <span className={css.milBadge}>MIL</span>}
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
            {!expanded && (
              <button className={css.preview} onClick={() => toggle(n.nmsId)}>
                {previewText(n.text)}
              </button>
            )}
            {expanded && <pre className={css.text}>{n.text}</pre>}
          </div>
        )
      })}
    </div>
  )
}
