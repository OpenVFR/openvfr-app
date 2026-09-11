/**
 * useNotamAirspaceMatch — matches regional NOTAMs to permanent restricted/
 * danger area polygons in se-airspace.geojson by designator code.
 *
 * NMS-API NOTAM free text references temporary and permanent
 * restricted/danger areas by designator (e.g. "DANGER AREA ESD873 OPTAND
 * COMPLETELY WITHDRAWN", "TEMPORARY RESTRICTED AREA ESR374 KRAKERED..."),
 * and se-airspace.geojson's class R/D/TRA features carry that same
 * designator embedded in their `name` property (e.g. "ESD873 OPTAND").
 * Extracting and matching the two together lets permanent areas show their
 * active NOTAM directly in AirspacePopup instead of only via a separate
 * ad-hoc circle (see useRegionalNotams.ts / useNotamWarnings.ts) drawn
 * approximately on top of the same real-world area.
 *
 * Confirmed (manually, against live staging data) this only matches
 * permanent areas already baked into se-airspace.geojson -- temporary
 * areas established mid-AIRAC-cycle via AIP supplement (the majority of
 * real cases) won't have a polygon to match yet, hence NOT deduplicating
 * ad-hoc circles here for anything unmatched -- only suppress a circle
 * once we've actually found its designator in the static airspace data.
 */

import { useEffect, useState, useMemo } from 'react'
import type { NotamItem } from '@open-vfr/shared/fetchNotam'
import { TILES_BASE_URL } from '../utils/env'
import { versionedTileUrl } from '@open-vfr/shared/tileManifest'

// Matches designators like ESD873, ESR448, ESR5 (1-4 digits) -- Swedish OFMX
// naming convention: 2-letter country prefix + R(estricted)/D(anger) + number.
const DESIGNATOR_RE = /\b([A-Z]{2}[RD]\d{1,4})\b/g

function extractDesignators(text: string): string[] {
  return [...new Set(text.match(DESIGNATOR_RE) ?? [])]
}

interface AirspaceIndexEntry {
  name:       string   // full properties.name, e.g. "ESD873 OPTAND"
  designator: string   // extracted prefix, e.g. "ESD873"
  geometry:   GeoJSON.Polygon | GeoJSON.MultiPolygon
}

export interface MatchedAirspaceNotam {
  airspaceName: string
  geometry:     GeoJSON.Polygon | GeoJSON.MultiPolygon
  notams:       NotamItem[]
}

export function useNotamAirspaceMatch(regionalNotams: NotamItem[]): {
  matches:         MatchedAirspaceNotam[]
  /** NOTAM ids that matched a charted polygon -- suppress their ad-hoc circle. */
  matchedNotamIds: Set<string>
} {
  const [airspaceIndex, setAirspaceIndex] = useState<AirspaceIndexEntry[]>([])

  // Load once -- same static-file pattern as useAirspaceWarnings.ts /
  // useAirspaceNotifications.ts (cheap, browser-cached, not a live endpoint).
  useEffect(() => {
    fetch(versionedTileUrl(TILES_BASE_URL, 'se-airspace.geojson'))
      .then(r => r.json())
      .then((fc: GeoJSON.FeatureCollection) => {
        const arr: AirspaceIndexEntry[] = []
        for (const f of fc.features) {
          const g = f.geometry
          if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') continue
          const p   = f.properties as Record<string, unknown>
          const cls = String(p['class'] ?? '')
          if (cls !== 'R' && cls !== 'D' && cls !== 'TRA') continue
          const name = String(p['name'] ?? '')
          const m = /^([A-Z]{2}[RD]\d{1,4})/.exec(name)
          if (!m) continue
          arr.push({ name, designator: m[1], geometry: g })
        }
        setAirspaceIndex(arr)
      })
      .catch(() => { /* offline-safe */ })
  }, [])

  return useMemo(() => {
    const byDesignator = new Map<string, AirspaceIndexEntry>()
    for (const a of airspaceIndex) byDesignator.set(a.designator, a)

    const grouped = new Map<string, MatchedAirspaceNotam>()
    const matchedNotamIds = new Set<string>()

    for (const n of regionalNotams) {
      for (const d of extractDesignators(n.text)) {
        const airspace = byDesignator.get(d)
        if (!airspace) continue
        matchedNotamIds.add(n.id)
        let entry = grouped.get(airspace.name)
        if (!entry) {
          entry = { airspaceName: airspace.name, geometry: airspace.geometry, notams: [] }
          grouped.set(airspace.name, entry)
        }
        if (!entry.notams.some(x => x.id === n.id)) entry.notams.push(n)
      }
    }

    return { matches: [...grouped.values()], matchedNotamIds }
  }, [airspaceIndex, regionalNotams])
}
