/**
 * useNearbyFrequencies — scans loaded aerodromes and returns those within
 * RADIUS_NM sorted by distance, each with their full frequency list.
 *
 * Loads se-aerodromes.geojson once, then refreshes it every REFRESH_MS in the
 * background so server-side data fixes (e.g. openaip_fill_aerodrome_gaps.py
 * backfills) show up without a full app restart. Updates on every position
 * change. Frequency priority order matches web useAirfieldProximity /
 * useNearestFeature.
 */

import { useState, useEffect, useRef } from 'react'
import type { GpsPosition } from '../utils/gpsTypes'
import { distanceNm } from '../utils/routeCalc'
import { getTileUrls } from '../config'
import { onActiveCountriesChange } from '@open-vfr/shared/countryData'

export interface NearbyFreq {
  service:  string   // TWR, AFIS, APP, GND, ATIS, FIS, INFO, RDO…
  mhz:      number
  callsign: string | null
}

export interface NearbyAerodrome {
  icao:        string
  name:        string
  distNm:      number
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

// Module-level cache — shared across all hook instances. Refetched on a TTL
// (see REFRESH_MS below) rather than only once per app process, so backfilled
// aviation data (e.g. openaip_fill_aerodrome_gaps.py) shows up without a full
// app restart — matches the server's /tiles/*.geojson Cache-Control max-age.
let _cache: CachedAerodrome[] | null = null
let _lastFetchedAt = 0
let _loading = false
const _listeners: Array<(data: CachedAerodrome[]) => void> = []
// Per-country data: a new active country starts a fresh load.
onActiveCountriesChange(() => { _cache = null; _lastFetchedAt = 0; _loading = false })

// Keep in sync with docker/nginx.conf's `location ~ \.geojson$` max-age (300s) —
// no point polling faster than the server will actually revalidate content for.
const REFRESH_MS = 5 * 60 * 1000

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

function loadOnce(onLoad: (data: CachedAerodrome[]) => void) {
  if (_cache) { onLoad(_cache); return }
  _listeners.push(onLoad)
  if (_loading) return
  _loading = true
  // no-store: aviation data (frequencies/fuel/PPR/etc.) is periodically
  // backfilled/corrected server-side outside the AIRAC cycle (e.g.
  // openaip_fill_aerodrome_gaps.py) and must not be served from Android's
  // on-disk OkHttp HTTP cache, which persists across app updates/reinstalls
  // (adb install -r keeps app data) and would otherwise keep honouring a
  // long max-age from whatever the server sent on the FIRST ever fetch on
  // that device, potentially predating a data fix by days.
  fetch(getTileUrls().aerodromes, { cache: 'no-store' })
    .then(r => r.json())
    .then((fc: GeoJSON.FeatureCollection) => {
      _cache = parseAerodromesFC(fc)
      _lastFetchedAt = Date.now()
      _loading = false
      _listeners.forEach(cb => cb(_cache!))
      _listeners.length = 0
    })
    .catch(() => { _loading = false })
}

/**
 * Re-fetch in the background if the cache is older than REFRESH_MS, notifying
 * `onUpdate` only if the fetch succeeds. Safe to call repeatedly (e.g. from a
 * setInterval) — no-ops while a fetch is already in flight or cache is fresh.
 */
function refreshIfStale(onUpdate: (data: CachedAerodrome[]) => void) {
  if (_loading) return
  if (_cache && Date.now() - _lastFetchedAt < REFRESH_MS) return
  _loading = true
  fetch(getTileUrls().aerodromes, { cache: 'no-store' })
    .then(r => r.json())
    .then((fc: GeoJSON.FeatureCollection) => {
      _cache = parseAerodromesFC(fc)
      _lastFetchedAt = Date.now()
      _loading = false
      onUpdate(_cache)
    })
    .catch(() => { _loading = false })
}

const RECOMPUTE_MIN_MS = 1000

export function useNearbyFrequencies(position: GpsPosition | null): NearbyAerodrome[] {
  const [aerodromes, setAerodromes] = useState<CachedAerodrome[]>([])
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
    loadOnce(setAerodromes)
    const id = setInterval(() => refreshIfStale(setAerodromes), REFRESH_MS)
    return () => clearInterval(id)
  }, [])

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
        primaryFreq: pickPrimary(a.freqs),
        frequencies: a.freqs,
      })
    }
    results.sort((a, b) => a.distNm - b.distNm)
    const sig = results.map(r => `${r.icao}:${r.distNm.toFixed(2)}`).join('|')
    if (sig !== lastSigRef.current) {
      lastSigRef.current = sig
      setNearby(results)
    }
  }, [position, aerodromes])

  return nearby
}
