/**
 * useNearbyFrequencies — web counterpart to native's own hook of the same
 * name. Scans loaded aerodromes and returns those within RADIUS_NM of the
 * given position, sorted by distance, each with its full frequency list.
 * Plain GPS-radius only -- unlike useVicinityAerodromes.ts's Wx/NOTAM
 * picker, this has NO route-buffer or home-airfield fallback tier, matching
 * native's own Freq tab behaviour exactly (see its doc comment).
 *
 * Reuses useAirfieldBrief.ts's own loadAerodromes() cache (already parses
 * the full AerodromeFeatureProps shape, frequencies included) rather than
 * adding another se-aerodromes.geojson parser.
 */

import { useEffect, useState } from 'react'
import type { GpsPosition } from '../utils/gpsTypes'
import { distanceNm } from '@open-vfr/shared/routeCalc'
import { loadAerodromes, type FullAerodrome } from './useAirfieldBrief'

export interface NearbyFreq {
  service:  string   // TWR, AFIS, APP, GND, ATIS, FIS, INFO, RDO…
  mhz:      number
  callsign: string | null
}

export interface NearbyAerodrome {
  icao:        string
  name:        string
  distNm:      number
  frequencies: NearbyFreq[]
}

const RADIUS_NM = 25   // matches native's useNearbyFrequencies.ts

// Service priority for sorting frequencies within an aerodrome
const FREQ_ORDER = ['TWR', 'AFIS', 'APP', 'DEP', 'ATIS', 'GND', 'SMC', 'INFO', 'FIS', 'RDO', 'RADIO', 'UNICOM']

// Exported (decoupled from FullAerodrome -- takes the raw frequencies array
// directly) so VicinityBriefPanel.tsx can build the same NearbyFreq shape
// from useVicinityAerodromes.ts's route/GPS/home-airfield-prioritized list
// too, for the Frequencies tab's route-fallback (see that file's own
// doc comment) -- one conversion function, not two copies to drift.
export function toNearbyFreqs(frequencies: FullAerodrome['props']['frequencies']): NearbyFreq[] {
  return frequencies
    .filter((f) => f.freq_mhz != null)
    .map((f) => ({ service: (f.service ?? 'COM').toUpperCase(), mhz: f.freq_mhz, callsign: f.callsign ?? null }))
    .sort((a, b) => {
      const ia = FREQ_ORDER.indexOf(a.service)
      const ib = FREQ_ORDER.indexOf(b.service)
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    })
}

export function useNearbyFrequencies(position: GpsPosition | null): NearbyAerodrome[] {
  const [all, setAll] = useState<FullAerodrome[]>([])
  const [nearby, setNearby] = useState<NearbyAerodrome[]>([])

  useEffect(() => { loadAerodromes().then(setAll) }, [])

  useEffect(() => {
    if (!position || all.length === 0) { setNearby([]); return }
    const pos = { lat: position.lat, lng: position.lng }
    const results: NearbyAerodrome[] = []
    for (const a of all) {
      const d = distanceNm(pos, { lat: a.lat, lng: a.lng })
      if (d > RADIUS_NM) continue
      results.push({ icao: a.props.icao, name: a.props.name, distNm: d, frequencies: toNearbyFreqs(a.props.frequencies) })
    }
    results.sort((x, y) => x.distNm - y.distNm)
    setNearby(results)
  }, [position, all])

  return nearby
}
