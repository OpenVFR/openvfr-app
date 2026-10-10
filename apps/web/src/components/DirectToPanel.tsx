/**
 * DirectToPanel — "Direct To" aerodrome picker for Go Flying mode.
 *
 * Shows all aerodromes sorted by distance from current GPS position.
 * Home airfield always appears first.  Aerodromes reachable within glide
 * range (if aircraft profile is configured) are highlighted green.
 *
 * Filters: free-text search (ICAO / name) + minimum runway length slider.
 *
 * Tapping a row calls `onDirectTo` which replaces the current route with
 * a two-waypoint route: [current position → chosen aerodrome].
 */

import { useState, useEffect, useMemo, useRef } from 'react'
import type { GpsPosition } from '../utils/gpsTypes'
import type { AircraftProfileDocType } from '../db/index'
import type { RouteWaypoint } from '../utils/routeCalc'
import { distanceNm, bearingDeg } from '../utils/routeCalc'
import css from './DirectToPanel.module.css'
import { loadCountryGeojson } from '@open-vfr/shared/countryData'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AerodromeEntry {
  icao:         string
  name:         string
  lat:          number
  lng:          number
  elevationFt:  number
  maxRunwayM:   number   // 0 = unknown
  fuel:         string[]
  type:         string   // 'AD' | 'HP' | 'AH'
}

interface Props {
  position:       GpsPosition
  homeIcao:       string | null
  aircraftProfile?: AircraftProfileDocType
  onDirectTo:     (wp: RouteWaypoint) => void
  onClose:        () => void
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtBrg(d: number): string {
  return Math.round(d).toString().padStart(3, '0') + '°'
}

function fmtDist(nm: number): string {
  if (nm < 10)  return `${nm.toFixed(1)} NM`
  return `${nm.toFixed(0)} NM`
}

function parseMaybeJsonArray<T>(val: unknown): T[] {
  if (Array.isArray(val))          return val as T[]
  if (typeof val === 'string') {
    try { return JSON.parse(val) as T[] } catch { return [] }
  }
  return []
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function DirectToPanel({
  position, homeIcao, aircraftProfile, onDirectTo, onClose,
}: Props) {
  const [aerodromes, setAerodromes] = useState<AerodromeEntry[]>([])
  const [minRunwayM, setMinRunwayM] = useState(0)
  const [search,     setSearch]     = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  // ── Load aerodrome GeoJSON once ───────────────────────────────────────────
  useEffect(() => {
    loadCountryGeojson('aerodromes')
      .then(fc => {
        const entries: AerodromeEntry[] = []
        for (const f of fc.features) {
          const g = f.geometry as GeoJSON.Point
          const p = f.properties as Record<string, unknown>

          const runways = parseMaybeJsonArray<Record<string, unknown>>(p.runways)
          let maxRunwayM = 0
          for (const rwy of runways) {
            const len = Number(rwy.length_m ?? 0)
            if (len > maxRunwayM) maxRunwayM = len
          }

          entries.push({
            icao:        String(p.icao  ?? ''),
            name:        String(p.name  ?? ''),
            lat:         g.coordinates[1],
            lng:         g.coordinates[0],
            elevationFt: Number(p.elevation_ft ?? 0),
            maxRunwayM,
            fuel:        parseMaybeJsonArray<string>(p.fuel),
            type:        String(p.type  ?? 'AD'),
          })
        }
        setAerodromes(entries)
      })
      .catch(console.error)

    // Auto-focus search on open
    const t = setTimeout(() => searchRef.current?.focus(), 60)
    return () => clearTimeout(t)
  }, [])

  // ── Glide range from current altitude ────────────────────────────────────
  // height_ft × glideRatio / 6076.12 ft-per-NM = glide range in NM
  const glideRangeNm = useMemo(() => {
    if (!aircraftProfile || aircraftProfile.glideRatio <= 0) return null
    const altFt = position.altFt
    if (altFt <= 200) return null
    return (altFt * aircraftProfile.glideRatio) / 6076.12
  }, [position.altFt, aircraftProfile])

  // ── Sort + filter ─────────────────────────────────────────────────────────
  const sorted = useMemo(() => {
    const q = search.trim().toUpperCase()
    return aerodromes
      .filter(a => {
        if (minRunwayM > 0 && a.maxRunwayM > 0 && a.maxRunwayM < minRunwayM) return false
        if (q && !a.icao.includes(q) && !a.name.toUpperCase().includes(q)) return false
        return true
      })
      .map(a => {
        const dist    = distanceNm(position, a)
        const bearing = bearingDeg(position, a)
        // Within glide if we have glide range AND dist ≤ glide range AND
        // we're at least 200 ft above the aerodrome elevation
        const withinGlide =
          glideRangeNm !== null &&
          dist <= glideRangeNm &&
          position.altFt > a.elevationFt + 200
        return { ...a, dist, bearing, withinGlide }
      })
      .sort((a, b) => {
        if (a.icao === homeIcao && b.icao !== homeIcao) return -1
        if (b.icao === homeIcao && a.icao !== homeIcao) return  1
        // Glide-reachable aerodromes float to top (after home)
        if (a.withinGlide && !b.withinGlide) return -1
        if (!a.withinGlide && b.withinGlide) return  1
        return a.dist - b.dist
      })
  }, [aerodromes, position, homeIcao, minRunwayM, search, glideRangeNm])

  const hasAvgas = (a: AerodromeEntry) => a.fuel.some(f => f === 'AVGAS' || f.startsWith('100'))
  const hasJet   = (a: AerodromeEntry) => a.fuel.some(f => f === 'A1' || f.startsWith('JET'))

  return (
    <div className={css.backdrop} onClick={onClose}>
      <div className={css.panel} onClick={e => e.stopPropagation()}>

        {/* ── Header ─────────────────────────────────────────────────── */}
        <div className={css.header}>
          <span className={css.title}>Direct To</span>
          {glideRangeNm !== null && (
            <span className={css.glideNote}>
              ⬡ Glide range: {glideRangeNm.toFixed(0)} NM
            </span>
          )}
          <button className={css.closeBtn} onClick={onClose}>✕</button>
        </div>

        {/* ── Filters ────────────────────────────────────────────────── */}
        <div className={css.filters}>
          <input
            ref={searchRef}
            className={css.search}
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search ICAO or name…"
          />
          <label className={css.runwayLabel}>
            <span className={css.runwayText}>
              Min runway: {minRunwayM > 0 ? `${minRunwayM} m` : 'Any'}
            </span>
            <input
              type="range" min={0} max={2000} step={100}
              value={minRunwayM}
              className={css.runwaySlider}
              onChange={e => setMinRunwayM(Number(e.target.value))}
            />
          </label>
        </div>

        {/* ── List ───────────────────────────────────────────────────── */}
        <div className={css.list}>
          {sorted.slice(0, 60).map(a => (
            <button
              key={a.icao}
              className={[
                css.row,
                a.icao === homeIcao ? css.rowHome  : '',
                a.withinGlide       ? css.rowGlide : '',
              ].join(' ')}
              onClick={() => { onDirectTo({ lng: a.lng, lat: a.lat, name: a.icao }); onClose() }}
            >
              <span className={css.rowIcao}>{a.icao}</span>
              <span className={css.rowName}>{a.name}</span>

              <span className={css.rowTags}>
                {a.icao === homeIcao && <span className={css.tagHome}>HOME</span>}
                {a.withinGlide       && <span className={css.tagGlide}>GLIDE</span>}
                {hasAvgas(a)         && <span className={css.tagFuel}>AVGAS</span>}
                {hasJet(a)           && <span className={css.tagFuel}>JET</span>}
                {a.maxRunwayM > 0    && <span className={css.tagRwy}>{a.maxRunwayM}m</span>}
              </span>

              <span className={css.rowNav}>
                <span className={css.rowDist}>{fmtDist(a.dist)}</span>
                <span className={css.rowBrg}>{fmtBrg(a.bearing)}</span>
              </span>
            </button>
          ))}

          {sorted.length === 0 && aerodromes.length > 0 && (
            <div className={css.empty}>No aerodromes match your filter</div>
          )}
          {aerodromes.length === 0 && (
            <div className={css.empty}>Loading…</div>
          )}
        </div>
      </div>
    </div>
  )
}
