/**
 * FindDestPanel — "Find a Destination" aerodrome picker.
 *
 * Available in both planning mode and Go Flying mode.  When GPS is active,
 * distances are computed from the aircraft position; otherwise from the map
 * centre passed in as `center`.
 *
 * Filters:
 *   - Free-text search (ICAO / name)
 *   - Fuel type: Any / AVGAS / JET A1
 *   - Surface: Any / Hard (ASPH+CONC) / Grass (GRASS+SAND)
 *   - Minimum runway length slider
 *
 * Row actions:
 *   - Click row → pan map to aerodrome (onFlyTo)
 *   - "+" button → append aerodrome as a route waypoint (onAddToRoute)
 */

import { useState, useEffect, useMemo, useRef } from 'react'
import type { AircraftProfileDocType } from '../db/index'
import type { RouteWaypoint } from '../utils/routeCalc'
import css from './FindDestPanel.module.css'
import { TILES_BASE_URL } from '../utils/env'
import { versionedTileUrl } from '@open-vfr/shared/tileManifest'
import {
  parseAerodromesGeoJson, filterAndSortAerodromes, computeGlideRangeNm,
  aerodromeToWaypoint, hasAvgas, hasJet, isHard, isGrass, fmtBrg, fmtDist,
  type AerodromeEntry, type FuelFilter, type SurfaceFilter,
} from '@open-vfr/shared/findDestination'

interface Centre {
  lat: number
  lng: number
  /** altitude ft — used for glide range when > 200 ft */
  altFt?: number
}

interface Props {
  /** Current GPS/map centre used for distance sorting */
  center:          Centre
  homeIcao:        string | null
  aircraftProfile?: AircraftProfileDocType
  /** Pan the map to this location */
  onFlyTo:         (lat: number, lng: number) => void
  /** Append as a route waypoint */
  onAddToRoute:    (wp: RouteWaypoint) => void
  onClose:         () => void
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function FindDestPanel({
  center, homeIcao, aircraftProfile, onFlyTo, onAddToRoute, onClose,
}: Props) {
  const [aerodromes, setAerodromes] = useState<AerodromeEntry[]>([])
  const [search,      setSearch]    = useState('')
  const [minRunwayM,  setMinRunway] = useState(0)
  const [fuelFilter,  setFuelFilter]    = useState<FuelFilter>('any')
  const [surfFilter,  setSurfFilter]    = useState<SurfaceFilter>('any')
  const searchRef = useRef<HTMLInputElement>(null)

  // ── Load once ──────────────────────────────────────────────────────────────
  useEffect(() => {
    fetch(versionedTileUrl(TILES_BASE_URL, 'se-aerodromes.geojson'))
      .then(r => r.json())
      .then(fc => setAerodromes(parseAerodromesGeoJson(fc)))
      .catch(console.error)

    const t = setTimeout(() => searchRef.current?.focus(), 60)
    return () => clearTimeout(t)
  }, [])

  // ── Glide range ────────────────────────────────────────────────────────────
  const glideRangeNm = useMemo(
    () => computeGlideRangeNm(center, aircraftProfile),
    [center.altFt, aircraftProfile],
  )

  // ── Sort + filter ─────────────────────────────────────────────────────────
  const sorted = useMemo(
    () => filterAndSortAerodromes(
      aerodromes, center, homeIcao,
      { search, minRunwayM, fuelFilter, surfFilter },
      glideRangeNm,
    ),
    [aerodromes, center, homeIcao, minRunwayM, fuelFilter, surfFilter, search, glideRangeNm],
  )

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className={css.backdrop} onClick={onClose}>
      <div className={css.panel} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className={css.header}>
          <span className={css.title}>Find a Destination</span>
          {glideRangeNm !== null && (
            <span className={css.glideNote}>⬡ Glide {glideRangeNm.toFixed(0)} NM</span>
          )}
          <button className={css.closeBtn} onClick={onClose}>✕</button>
        </div>

        {/* Filters */}
        <div className={css.filters}>
          <input
            ref={searchRef}
            className={css.search}
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search ICAO or name…"
          />

          <div className={css.filterRow}>
            <span className={css.filterLabel}>Fuel</span>
            <div className={css.filterBtns}>
              {(['any', 'avgas', 'jet'] as FuelFilter[]).map(v => (
                <button
                  key={v}
                  className={`${css.filterBtn}${fuelFilter === v ? ` ${css.filterBtnActive}` : ''}`}
                  onClick={() => setFuelFilter(v)}
                >
                  {v === 'any' ? 'Any' : v === 'avgas' ? 'AVGAS' : 'JET A1'}
                </button>
              ))}
            </div>

            <span className={css.filterLabel}>Surface</span>
            <div className={css.filterBtns}>
              {(['any', 'hard', 'grass'] as SurfaceFilter[]).map(v => (
                <button
                  key={v}
                  className={`${css.filterBtn}${surfFilter === v ? ` ${css.filterBtnActive}` : ''}`}
                  onClick={() => setSurfFilter(v)}
                >
                  {v === 'any' ? 'Any' : v === 'hard' ? 'Hard' : 'Grass'}
                </button>
              ))}
            </div>
          </div>

          <label className={css.runwayLabel}>
            <span className={css.runwayText}>Min runway: {minRunwayM > 0 ? `${minRunwayM} m` : 'Any'}</span>
            <input
              type="range" min={0} max={2000} step={100}
              value={minRunwayM}
              className={css.runwaySlider}
              onChange={e => setMinRunway(Number(e.target.value))}
            />
          </label>
        </div>

        {/* List */}
        <div className={css.list}>
          {sorted.slice(0, 80).map(a => (
            <div
              key={a.icao}
              className={[
                css.row,
                a.icao === homeIcao ? css.rowHome  : '',
                a.withinGlide       ? css.rowGlide : '',
              ].join(' ')}
            >
              {/* Main clickable area → fly map to */}
              <button
                className={css.rowMain}
                onClick={() => { onFlyTo(a.lat, a.lng); onClose() }}
                title="Fly map to this aerodrome"
              >
                <span className={css.rowIcao}>{a.icao}</span>
                <span className={css.rowName}>{a.name}</span>
                <span className={css.rowTags}>
                  {a.icao === homeIcao && <span className={css.tagHome}>HOME</span>}
                  {a.withinGlide       && <span className={css.tagGlide}>GLIDE</span>}
                  {hasAvgas(a.fuel)    && <span className={css.tagFuel}>AVGAS</span>}
                  {hasJet(a.fuel)      && <span className={css.tagFuel}>JET</span>}
                  {isHard(a.surfaces)  && <span className={css.tagSurf}>ASPH</span>}
                  {isGrass(a.surfaces) && !isHard(a.surfaces) && <span className={css.tagSurfGrass}>GRASS</span>}
                  {a.maxRunwayM > 0    && <span className={css.tagRwy}>{a.maxRunwayM}m</span>}
                </span>
                <span className={css.rowNav}>
                  <span className={css.rowDist}>{fmtDist(a.dist)}</span>
                  <span className={css.rowBrg}>{fmtBrg(a.bearing)}</span>
                </span>
              </button>

              {/* Add to route */}
              <button
                className={css.addBtn}
                onClick={() => onAddToRoute(aerodromeToWaypoint(a))}
                title="Add to route"
              >+</button>
            </div>
          ))}

          {sorted.length === 0 && aerodromes.length > 0 && (
            <div className={css.empty}>No aerodromes match your filters</div>
          )}
          {aerodromes.length === 0 && (
            <div className={css.empty}>Loading…</div>
          )}
        </div>
      </div>
    </div>
  )
}
