/**
 * useNearbyFrequencies — scans loaded aerodromes and returns those within
 * RADIUS_NM sorted by distance, each with their full frequency list.
 *
 * Loads the active country's aerodromes by their versioned URL (cached per
 * file version, utils/tileDerived): a data fix is a new version and so a new
 * load once the manifest names it, no periodic refetch needed. Updates on every position
 * change. Frequency priority order matches web useAirfieldProximity /
 * useNearestFeature.
 */

import { useState, useEffect, useRef } from 'react'
import type { GpsPosition } from '../utils/gpsTypes'
import { distanceNm } from '../utils/routeCalc'
import { createTileDerived, useTileDerived } from '../utils/tileDerived'

export interface NearbyFreq {
  service:  string   // TWR, AFIS, APP, GND, ATIS, FIS, INFO, RDO…
  mhz:      number
  callsign: string | null
}

export interface NearbyAerodrome {
  icao:        string
  name:        string
  /** Distance when the list was last rebuilt (not refreshed per fix; see lat/lng). */
  distNm:      number
  /** Position, so a display can show a live distance from the current fix. */
  lat?:        number
  lng?:        number
  /** Primary freq — TWR > AFIS > INFO > first available */
  primaryFreq: string | null
  frequencies: NearbyFreq[]
}

const RADIUS_NM = 25

// Service priority for sorting frequencies within an aerodrome
const FREQ_ORDER = ['TWR', 'AFIS', 'APP', 'DEP', 'ATIS', 'GND', 'SMC', 'INFO', 'FIS', 'RDO', 'RADIO', 'UNICOM']
const PRIMARY_ORDER = ['TWR', 'AFIS', 'INFO', 'UNICOM', 'RDO', 'RADIO']

// Exported so useVicinityAerodromes.ts can parse the same raw frequencies
// field for its own route/GPS/home-prioritized list -- used as a fallback
// source for VicinityBriefSheet's Freq tab when this hook's GPS-only list
// is empty (see that file's own doc comment). One parser, not two copies.
export function parseFreqs(raw: unknown): NearbyFreq[] {
  const arr: Array<{ service?: string; freq_mhz?: number; callsign?: string }> =
    Array.isArray(raw) ? raw
    : typeof raw === 'string' ? JSON.parse(raw)
    : []

  return arr
    .filter(f => f.freq_mhz != null)
    .map(f => ({
      service:  (f.service ?? 'COM').toUpperCase(),
      mhz:      f.freq_mhz!,
      callsign: f.callsign ?? null,
    }))
    .sort((a, b) => {
      const ia = FREQ_ORDER.indexOf(a.service)
      const ib = FREQ_ORDER.indexOf(b.service)
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    })
}

export function pickPrimary(freqs: NearbyFreq[]): string | null {
  for (const svc of PRIMARY_ORDER) {
    const f = freqs.find(x => x.service === svc)
    if (f) return f.mhz.toFixed(3)
  }
  return freqs[0]?.mhz.toFixed(3) ?? null
}

interface CachedAerodrome {
  icao:  string
  name:  string
  lat:   number
  lng:   number
  freqs: NearbyFreq[]
}

function parseAerodromesFC(fc: GeoJSON.FeatureCollection): CachedAerodrome[] {
  const arr: CachedAerodrome[] = []
  for (const f of fc.features) {
    if (f.geometry.type !== 'Point') continue
    const p    = f.properties as Record<string, unknown>
    const icao = String(p.icao ?? '')
    const name = String(p.name ?? '')
    if (!icao && !name) continue
    const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates
    const freqs = parseFreqs(p.frequencies)
    arr.push({ icao, name, lat, lng, freqs })
  }
  return arr
}

const loadAerodromes = createTileDerived('aerodromes', parseAerodromesFC)
const NO_AERODROMES: CachedAerodrome[] = []

/**
 * The loaded aerodromes (icao, name, position), loading them if needed. Null
 * when they could not be loaded within `timeoutMs` (offline, no data).
 */
export function getAerodromes(timeoutMs = 20_000): Promise<{ icao: string; name: string; lat: number; lng: number }[] | null> {
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(null), timeoutMs)
    loadAerodromes().then(data => { clearTimeout(t); resolve(data) }, () => { clearTimeout(t); resolve(null) })
  })
}

const RECOMPUTE_MIN_MS = 1000

export function useNearbyFrequencies(position: GpsPosition | null): NearbyAerodrome[] {
  const aerodromes = useTileDerived(loadAerodromes) ?? NO_AERODROMES
  const [nearby,     setNearby]     = useState<NearbyAerodrome[]>([])
  const posRef = useRef(position)
  posRef.current = position
  // Last-committed result signature -- skip setNearby() when the computed
  // list is identical to what's already in state. Without this, every
  // position tick (5 Hz while flying/simulating -- including alt/speed/hdg-
  // only sim-stepper taps, which still emit a fresh position object with
  // unchanged lat/lng) called setNearby(results) unconditionally with a
  // brand-new array reference even when nothing actually changed, adding to
  // the render-pressure class of "Maximum update depth exceeded" bug fixed
  // for the four position-driven alert hooks (see usePositionAlerts.ts) but
  // missed here -- found live via rapid sim-stepper taps, 2026-09-20.
  const lastSigRef = useRef<string>('')
  // Recompute at most once per second. The signature includes distances, so
  // while moving it differs on every 5 Hz tick; committing a state update from
  // an effect on *every* tick makes React's consecutive-passive-update counter
  // climb past 50 ("Maximum update depth exceeded") after ~10 s of flight.
  // Skipped ticks let that counter reset. A second of movement (~0.025 NM per
  // tick at 90 kt) is far below what the distance readout can show.
  const lastRunRef = useRef(0)

  useEffect(() => {
    if (!position || aerodromes.length === 0) {
      if (lastSigRef.current !== '') { lastSigRef.current = ''; setNearby([]) }
      return
    }
    const nowMs = Date.now()
    if (lastSigRef.current !== '' && nowMs - lastRunRef.current < RECOMPUTE_MIN_MS) return
    lastRunRef.current = nowMs
    const pos = { lat: position.lat, lng: position.lng }
    const results: NearbyAerodrome[] = []
    for (const a of aerodromes) {
      const d = distanceNm(pos, { lat: a.lat, lng: a.lng })
      if (d > RADIUS_NM) continue
      results.push({
        icao:        a.icao,
        name:        a.name,
        distNm:      d,
        lat:         a.lat,
        lng:         a.lng,
        primaryFreq: pickPrimary(a.freqs),
        frequencies: a.freqs,
      })
    }
    results.sort((a, b) => a.distNm - b.distNm)
    // Only which aerodromes and their order: a distance in the signature made a
    // state change (an extra MapScreen render) about every second in flight
    // with several fields in range. The readout computes live distances from
    // lat/lng and the current fix instead.
    const sig = results.map(r => r.icao).join('|')
    if (sig !== lastSigRef.current) {
      lastSigRef.current = sig
      setNearby(results)
    }
  }, [position, aerodromes])

  return nearby
}
