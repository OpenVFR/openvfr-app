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
import { loadCountryGeojson } from '@open-vfr/shared/countryData'
import {
  buildAirspaceIndex, matchNotamsToAirspace,
  type AirspaceIndexEntry, type MatchedAirspaceNotam,
} from '@open-vfr/shared/notamMapLayers'
import { useActiveCountries } from '../utils/countryData'

export type { MatchedAirspaceNotam }

// The matching itself (designators, sector letters, which circles to hide)
// lives in @open-vfr/shared/notamMapLayers, shared with native.
export function useNotamAirspaceMatch(regionalNotams: NotamItem[]): {
  matches:         MatchedAirspaceNotam[]
  /** NOTAM nmsIds whose designators are all charted -- suppress their ad-hoc circle. */
  matchedNotamIds: Set<string>
} {
  const [airspaceIndex, setAirspaceIndex] = useState<AirspaceIndexEntry[]>([])

  // Load once -- same static-file pattern as useAirspaceWarnings.ts /
  // useAirspaceNotifications.ts (cheap, browser-cached, not a live endpoint).
  const { key: countriesKey } = useActiveCountries()
  useEffect(() => {
    loadCountryGeojson('airspace')
      .then(fc => setAirspaceIndex(buildAirspaceIndex(fc)))
      .catch(() => { /* offline-safe */ })
  }, [countriesKey])

  return useMemo(() => matchNotamsToAirspace(airspaceIndex, regionalNotams), [airspaceIndex, regionalNotams])
}
