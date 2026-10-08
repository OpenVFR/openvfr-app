import { useState, useRef, useEffect } from 'react'
import { bearingDeg, magneticBearingDeg, distanceNm, type RouteWaypoint } from '../utils/routeCalc'
import type { LegOverride } from '../db/index'
import { routeToGpx, gpxToRoute } from '@open-vfr/shared/gpx'
import { iasToTas } from '@open-vfr/shared/airspeed'
import { type Units, DEFAULT_UNITS, nmToDisplay, distLabel, ktsToDisplay, displayToKts, speedLabel } from '../utils/units'
import { useTakeoffTime, useAlternate, useGlobalWind } from '../db/useSettings'
import LegPropsPanel from './LegPropsPanel'
import FindFeature from './FindFeature'
import { TILES_BASE_URL } from '../utils/env'
import { versionedTileUrl } from '@open-vfr/shared/tileManifest'
import css from './RoutePlan.module.css'

// ---------------------------------------------------------------------------
// Reorder helper — moves the waypoint at `from` to position `to`.
// ---------------------------------------------------------------------------
function moveWaypoint(arr: RouteWaypoint[], from: number, to: number): RouteWaypoint[] {
  if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) return arr
  const next = [...arr]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

// ---------------------------------------------------------------------------
// GPX export
// ---------------------------------------------------------------------------
function exportGpx(waypoints: RouteWaypoint[]) {
  const xml = routeToGpx(waypoints, 'Route')
  download('route.gpx', 'application/gpx+xml', xml)
}

// ---------------------------------------------------------------------------
// KML export
// ---------------------------------------------------------------------------
function exportKml(waypoints: RouteWaypoint[]) {
  const placemarks = waypoints.map((w, i) =>
    `    <Placemark><name>${w.name ?? `WP${i + 1}`}</name><Point><coordinates>${w.lng.toFixed(6)},${w.lat.toFixed(6)},0</coordinates></Point></Placemark>`
  ).join('\n')
  const coords = waypoints.map(w => `${w.lng.toFixed(6)},${w.lat.toFixed(6)},0`).join(' ')
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document><name>Route</name>
${placemarks}
    <Placemark><name>Route</name><LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString></Placemark>
  </Document>
</kml>`
  download('route.kml', 'application/vnd.google-earth.kml+xml', xml)
}

function download(filename: string, mime: string, content: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([content], { type: mime }))
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

// ---------------------------------------------------------------------------
// GPX import — parse a .gpx file and resolve named waypoints.
// Priority: <rte>/<rtept> first, then <wpt>, then <trk>/<trkseg>/<trkpt>.
// ---------------------------------------------------------------------------
async function importGpxFile(file: File): Promise<RouteWaypoint[]> {
  const text = await file.text()

  // Prefer proper <rte>/<rtept> parsing (round-trips name + note extension) —
  // covers files exported by open-vfr itself and most other EFBs/GPS tools.
  try {
    const { waypoints } = gpxToRoute(text)
    if (waypoints.length > 0) {
      const lookup = await getIdentifierLookup()
      return waypoints.map(wp => {
        const key = wp.name?.trim().toUpperCase()
        const known = key ? lookup.get(key) : undefined
        return known ? { ...known, note: wp.note } : wp
      })
    }
  } catch { /* no <rte> — fall through to <wpt>/<trk> */ }

  const dom = new DOMParser().parseFromString(text, 'application/xml')

  // Detect parse error (browsers embed a <parsererror> element on failure).
  if (dom.querySelector('parsererror')) throw new Error('Invalid GPX file')

  const wpts   = Array.from(dom.querySelectorAll(':root > wpt'))
  const trkpts = Array.from(dom.querySelectorAll('trk trkseg trkpt'))

  const pts = wpts.length > 0 ? wpts : trkpts
  if (pts.length === 0) throw new Error('No waypoints found in GPX file')

  const lookup = await getIdentifierLookup()
  const result: RouteWaypoint[] = []

  for (const pt of pts) {
    const lat  = parseFloat(pt.getAttribute('lat') ?? '')
    const lng  = parseFloat(pt.getAttribute('lon') ?? '')
    const name = pt.querySelector('name')?.textContent?.trim().toUpperCase() ?? ''
    if (isNaN(lat) || isNaN(lng)) continue
    const known = name ? lookup.get(name) : undefined
    result.push(known ?? { lng, lat, name: name || `${lat.toFixed(4)},${lng.toFixed(4)}` })
  }

  if (result.length === 0) throw new Error('No valid coordinates in GPX file')
  return result
}

// ---------------------------------------------------------------------------
// Keyboard route entry — resolve space-separated identifiers against the
// static GeoJSON sources.  Unknown identifiers fall back to a raw coordinate
// placeholder flagged with a warning so the user can fix them.
// ---------------------------------------------------------------------------
async function resolveKeyboardRoute(input: string): Promise<RouteWaypoint[]> {
  const tokens = input.trim().toUpperCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return []

  // Build a lookup map from all known identifiers across all sources.
  // Loaded lazily — cached in module scope.
  const lookup = await getIdentifierLookup()

  return tokens.map(token => {
    const match = lookup.get(token)
    if (match) return match
    // Unknown token — keep as named placeholder (user can fix by clicking)
    return { lng: 0, lat: 0, name: `?${token}` }
  }).filter(w => w.lng !== 0 || w.lat !== 0 || w.name?.startsWith('?'))
}

let _lookupCache: Map<string, RouteWaypoint> | null = null

async function getIdentifierLookup(): Promise<Map<string, RouteWaypoint>> {
  if (_lookupCache) return _lookupCache
  const map = new Map<string, RouteWaypoint>()

  const sources = [
    { url: versionedTileUrl(TILES_BASE_URL, 'se-aerodromes.geojson'), idKey: 'icao', nameKey: 'icao' },
    { url: versionedTileUrl(TILES_BASE_URL, 'se-navaids.geojson'),    idKey: 'id',   nameKey: 'id'   },
    { url: versionedTileUrl(TILES_BASE_URL, 'se-waypoints.geojson'),  idKey: 'id',   nameKey: 'id'   },
  ]

  await Promise.all(sources.map(async ({ url, idKey, nameKey }) => {
    try {
      const fc = await fetch(url).then(r => r.json()) as {
        features: { geometry: { coordinates: [number, number] }; properties: Record<string, unknown> }[]
      }
      for (const f of fc.features) {
        const id = String(f.properties[idKey] ?? '').toUpperCase()
        if (!id) continue
        map.set(id, {
          lng:  f.geometry.coordinates[0],
          lat:  f.geometry.coordinates[1],
          name: String(f.properties[nameKey] ?? id),
        })
      }
    } catch { /* ignore fetch errors — offline */ }
  }))

  _lookupCache = map
  return map
}

interface Props {
  waypoints:    RouteWaypoint[]
  legOverrides: LegOverride[]
  /** Route activate/deactivate -- shows/hides the drawn route on the map
   *  without clearing its waypoints. Mirrors native's PlanScreen header
   *  Active/Inactive toggle -- lives here in the side pane, not as a
   *  floating map-corner icon button. */
  routeVisible: boolean
  onToggleRouteVisible: () => void
  units?:       Units
  onUndo:       () => void
  onRedo?:      () => void
  canUndo?:     boolean
  canRedo?:     boolean
  onClear:      () => void
  onReplace:    (wps: RouteWaypoint[]) => void
  onAddToRoute?: (wp: { lng: number; lat: number; name: string }) => void
  onSetLegOverride: (idx: number, override: LegOverride) => void
  /** Altitude (ft) assumed for legs without an altitude override: the selected aircraft's cruise altitude. Used for the IAS→TAS conversion. */
  defaultAltFt?: number
  /** Cruise IAS (kt) of the selected aircraft: speed for legs without their own override. */
  defaultSpeedKts?: number
  onSetWaypointNote: (wpIdx: number, note: string) => void
}

export default function RoutePlan({ waypoints, legOverrides, routeVisible, onToggleRouteVisible, units = DEFAULT_UNITS, onUndo, onRedo, canUndo = false, canRedo = false, onClear, onReplace, onAddToRoute, onSetLegOverride, onSetWaypointNote, defaultAltFt, defaultSpeedKts }: Props) {
  const [kbInput, setKbInput] = useState('')
  const [kbError, setKbError] = useState('')
  const [kbLoading, setKbLoading] = useState(false)
  const [showKb, setShowKb] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [activeLeg, setActiveLeg] = useState<number | null>(null)
  const [showMenu, setShowMenu] = useState(false)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [overIdx, setOverIdx] = useState<number | null>(null)
  const menuRef      = useRef<HTMLDivElement>(null)
  const kbRef        = useRef<HTMLInputElement>(null)
  const gpxInputRef  = useRef<HTMLInputElement>(null)
  const [takeoffTime, setTakeoffTime] = useTakeoffTime()
  const [alternate, setAlternate] = useAlternate()
  const [globalWind, setGlobalWind] = useGlobalWind()
  // Local string inputs for WND row (display-unit)
  const [wndDir, setWndDir] = useState(globalWind ? String(globalWind.dirDeg) : '')
  const [wndSpd, setWndSpd] = useState(globalWind ? String(Math.round(ktsToDisplay(globalWind.speedKts, units.speed))) : '')
  const [altInput, setAltInput] = useState('')
  const [altError, setAltError] = useState('')
  const [altLoading, setAltLoading] = useState(false)

  function commitWind() {
    const dir = parseFloat(wndDir)
    const spd = parseFloat(wndSpd)
    if (!isNaN(dir) && !isNaN(spd) && spd >= 0) {
      setGlobalWind({ dirDeg: ((Math.round(dir) % 360) + 360) % 360, speedKts: displayToKts(spd, units.speed) })
    } else if (wndDir.trim() === '' && wndSpd.trim() === '') {
      setGlobalWind(null)
    }
  }

  // Close overflow menu on outside click.
  useEffect(() => {
    if (!showMenu) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setShowMenu(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showMenu])

  // GPX import handler.
  async function handleGpxFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // reset so the same file can be re-imported
    if (!file) return
    try {
      const wps = await importGpxFile(file)
      onReplace(wps)
      setKbError('')
    } catch (err) {
      setKbError(err instanceof Error ? err.message : 'Failed to import GPX')
    }
  }

  // Format a Date as a local datetime-local input value (YYYY-MM-DDTHH:MM).
  function toInputValue(d: Date | null): string {
    if (!d) return ''
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  // Format a Date as UTC time string for display (e.g. "14:32Z").
  function fmtUtc(d: Date): string {
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`
  }
  const legs: { fromName: string; toName: string; brg: number; magBrg: number; dist: number; midLat: number; midLng: number }[] = []
  let totalNm = 0
  let totalEteMin = 0
  let hasAnyEte = false
  for (let i = 0; i < waypoints.length - 1; i++) {
    const from = waypoints[i]
    const to = waypoints[i + 1]
    const dist = distanceNm(from, to)
    const brg = bearingDeg(from, to)
    const magBrg = magneticBearingDeg(from, to)
    const midLat = (from.lat + to.lat) / 2
    const midLng = (from.lng + to.lng) / 2
    totalNm += dist
    legs.push({ fromName: from.name ?? `WP${i + 1}`, toName: to.name ?? `WP${i + 2}`, brg, magBrg, dist, midLat, midLng })
  }

  // Compute per-leg ETE + WCA from override speed + wind (or global wind fallback).
  const legResults: { ete: number | undefined; wcaDeg: number | undefined; tas?: number; gs?: number }[] = legs.map((leg, i) => {
    const ovr: LegOverride = legOverrides[i] ?? {}
    const iasKts = ovr.speedKts ?? defaultSpeedKts
    if (!iasKts || iasKts <= 0) return { ete: undefined, wcaDeg: undefined }
    // Effective wind: per-leg override takes precedence over global wind.
    const effDir = ovr.windDir  ?? globalWind?.dirDeg
    const effSpd = ovr.windSpd  ?? globalWind?.speedKts
    // Leg speed is indicated; time and wind correction use TAS at the leg altitude.
    const tas = iasToTas(iasKts, ovr.altFt ?? defaultAltFt ?? 3500, ovr.oatC)
    let gs = tas
    let wcaDeg: number | undefined
    if (effDir != null && effSpd != null && effSpd > 0) {
      const brg  = (leg.brg  * Math.PI) / 180
      const wRad = (effDir   * Math.PI) / 180
      const hw = effSpd * Math.cos(wRad - brg)
      const xw = effSpd * Math.sin(wRad - brg)
      const wca = Math.asin(Math.max(-1, Math.min(1, xw / tas)))
      wcaDeg = Math.round(wca * 180 / Math.PI)
      gs = tas * Math.cos(wca) - hw
    }
    if (gs <= 0) return { ete: undefined, wcaDeg, tas }
    return { ete: (leg.dist / gs) * 60, wcaDeg, tas, gs }
  })
  const legEtes: (number | undefined)[] = legResults.map(r => r.ete)
  const legWcas: (number | undefined)[]  = legResults.map(r => r.wcaDeg)
  const legSpeedTip = (i: number): string | undefined => {
    const r = legResults[i]
    if (r?.tas == null) return undefined
    const u = speedLabel(units.speed)
    return `TAS ${Math.round(ktsToDisplay(r.tas, units.speed))} ${u}` + (r.gs != null ? ` · GS ${Math.round(ktsToDisplay(r.gs, units.speed))} ${u}` : '')
  }
  const hasAnyWca = legWcas.some(w => w != null && Math.abs(w) >= 1)

  legEtes.forEach(e => {
    if (e != null) { totalEteMin += e; hasAnyEte = true }
  })

  // ETA per waypoint arrival (index 1..n) when takeoff time is set and all
  // preceding legs have a valid ETE.  null = not computable.
  const legEtas: (Date | null)[] = legEtes.map((_, i) => {
    if (!takeoffTime) return null
    let cumMin = 0
    for (let j = 0; j <= i; j++) {
      if (legEtes[j] == null) return null
      cumMin += legEtes[j]!
    }
    return new Date(takeoffTime.getTime() + cumMin * 60_000)
  })

  async function handleKbSubmit() {    if (!kbInput.trim()) return
    setKbLoading(true)
    setKbError('')
    try {
      const wps = await resolveKeyboardRoute(kbInput)
      const unknown = wps.filter(w => w.name?.startsWith('?')).map(w => w.name!.slice(1))
      if (unknown.length > 0) setKbError(`Unknown: ${unknown.join(', ')}`)
      const valid = wps.filter(w => !w.name?.startsWith('?'))
      if (valid.length > 0) { onReplace(valid); setKbInput(''); setShowKb(false) }
    } finally {
      setKbLoading(false)
    }
  }

  async function handleAltSubmit() {
    const token = altInput.trim().toUpperCase()
    if (!token) return
    setAltLoading(true)
    setAltError('')
    try {
      const lookup = await getIdentifierLookup()
      const match = lookup.get(token)
      if (match) {
        setAlternate({ icao: token, name: match.name ?? token, lng: match.lng, lat: match.lat })
        setAltInput('')
      } else {
        setAltError(`Unknown: ${token}`)
      }
    } finally {
      setAltLoading(false)
    }
  }

  return (
    <div className={css.panel}>
      {/* Hidden GPX file input */}
      <input
        ref={gpxInputRef}
        type="file"
        accept=".gpx,application/gpx+xml"
        className={css.hiddenInput}
        aria-label="Import GPX file"
        onChange={handleGpxFileChange}
      />
      <div className={css.header}>
        <span className={css.title}>Route</span>
        <div className={css.actions}>
          {waypoints.length > 0 && (
            <button
              className={`${css.btn} ${css.btnVisToggle} ${!routeVisible ? css.btnVisToggleInactive : ''}`}
              title={routeVisible ? 'Deactivate route (hide on map)' : 'Activate route (show on map)'}
              onClick={onToggleRouteVisible}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18,15A3,3 0 0,1 21,18A3,3 0 0,1 18,21C16.69,21 15.58,20.17 15.17,19H14V17H15.17C15.58,15.83 16.69,15 18,15M18,17A1,1 0 0,0 17,18A1,1 0 0,0 18,19A1,1 0 0,0 19,18A1,1 0 0,0 18,17M18,8A1.43,1.43 0 0,0 19.43,6.57C19.43,5.78 18.79,5.14 18,5.14C17.21,5.14 16.57,5.78 16.57,6.57A1.43,1.43 0 0,0 18,8M18,2.57A4,4 0 0,1 22,6.57C22,9.56 18,14 18,14C18,14 14,9.56 14,6.57A4,4 0 0,1 18,2.57M8.83,17H10V19H8.83C8.42,20.17 7.31,21 6,21A3,3 0 0,1 3,18C3,16.69 3.83,15.58 5,15.17V14H7V15.17C7.85,15.47 8.53,16.15 8.83,17M6,17A1,1 0 0,0 5,18A1,1 0 0,0 6,19A1,1 0 0,0 7,18A1,1 0 0,0 6,17M6,3A3,3 0 0,1 9,6C9,7.31 8.17,8.42 7,8.83V10H5V8.83C3.83,8.42 3,7.31 3,6A3,3 0 0,1 6,3M6,5A1,1 0 0,0 5,6A1,1 0 0,0 6,7A1,1 0 0,0 7,6A1,1 0 0,0 6,5M11,19V17H13V19H11M7,13H5V11H7V13Z" /></svg>
              {routeVisible ? 'Active' : 'Inactive'}
            </button>
          )}
          <button className={css.btn} title="Add waypoint" onClick={() => { setShowAdd(s => !s); setShowKb(false) }}>+</button>
          <button className={css.btn} title="Keyboard route entry" onClick={() => { setShowKb(s => !s); setShowAdd(false); setTimeout(() => kbRef.current?.focus(), 50) }}>⌨</button>
          <button className={css.btn} onClick={onUndo} disabled={!canUndo} title="Undo last route change (Ctrl+Z)">↶</button>
          {onRedo && <button className={css.btn} onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">↷</button>}
          <div className={css.menuWrap} ref={menuRef}>
            <button className={css.btn} title="More actions" onClick={() => setShowMenu(s => !s)}>⋯</button>
            {showMenu && (
              <div className={css.menu}>
                <button className={css.menuItem} onClick={() => { onReplace([...waypoints].reverse()); setShowMenu(false) }} disabled={waypoints.length < 2}>⇄ Reverse</button>
                <button className={css.menuItem} onClick={() => { exportGpx(waypoints); setShowMenu(false) }} disabled={waypoints.length < 2}>↓ GPX</button>
                <button className={css.menuItem} onClick={() => { exportKml(waypoints); setShowMenu(false) }} disabled={waypoints.length < 2}>↓ KML</button>
                <button className={css.menuItem} onClick={() => { gpxInputRef.current?.click(); setShowMenu(false) }}>↑ Import GPX</button>
                <hr className={css.menuDivider} />
                <button className={`${css.menuItem} ${css.menuItemDanger}`} onClick={() => { onClear(); setShowMenu(false) }}>✕ Clear</button>
              </div>
            )}
          </div>
        </div>
      </div>

      {showAdd && (
        <div className={css.kbRow}>
          <FindFeature
            onResult={(r) => { onAddToRoute?.({ lng: r.lng, lat: r.lat, name: r.name }); setShowAdd(false) }}
            onAddToRoute={(wp) => { onAddToRoute?.(wp); setShowAdd(false) }}
          />
        </div>
      )}

      {showKb && (
        <div className={css.kbRow}>
          <input
            ref={kbRef}
            className={css.kbInput}
            placeholder="ESOS ESGG ESSA…"
            value={kbInput}
            onChange={e => { setKbInput(e.target.value); setKbError('') }}
            onKeyDown={e => { if (e.key === 'Enter') handleKbSubmit(); if (e.key === 'Escape') setShowKb(false) }}
            disabled={kbLoading}
          />
          <button className={css.btn} onClick={handleKbSubmit} disabled={kbLoading || !kbInput.trim()}>
            {kbLoading ? '…' : 'Go'}
          </button>
        </div>
      )}
      {kbError && <p className={css.kbError}>{kbError}</p>}

      {/* ── Takeoff Date/Time ───────────────────────────────────────── */}
      <div className={css.depRow}>
        <span className={css.depLabel}>DEP</span>
        <input
          className={css.depInput}
          type="datetime-local"
          title="Planned departure date and time"
          value={toInputValue(takeoffTime)}
          onChange={e => {
            const val = e.target.value
            setTakeoffTime(val ? new Date(val) : null)
          }}
        />
        {takeoffTime && (
          <button className={css.depClear} title="Clear departure time" onClick={() => setTakeoffTime(null)}>✕</button>
        )}
      </div>
      {/* ── Global Wind ──────────────────────────────────────────────── */}
      <div className={css.depRow}>
        <span className={css.depLabel} title="Global wind — applied to all legs unless overridden per-leg">WND</span>
        <input
          className={css.wndInput}
          type="number"
          min={0}
          max={359}
          placeholder="Dir °"
          title="Wind FROM direction (° true)"
          value={wndDir}
          onChange={e => setWndDir(e.target.value)}
          onBlur={commitWind}
          onKeyDown={e => { if (e.key === 'Enter') { commitWind(); e.currentTarget.blur() } }}
        />
        <input
          className={css.wndInput}
          type="number"
          min={0}
          placeholder={`Spd ${speedLabel(units.speed)}`}
          title={`Wind speed (${speedLabel(units.speed)})`}
          value={wndSpd}
          onChange={e => setWndSpd(e.target.value)}
          onBlur={commitWind}
          onKeyDown={e => { if (e.key === 'Enter') { commitWind(); e.currentTarget.blur() } }}
        />
        {globalWind && (
          <button className={css.depClear} title="Clear global wind" onClick={() => { setWndDir(''); setWndSpd(''); setGlobalWind(null) }}>✕</button>
        )}
      </div>
      {legs.length === 0 ? (
        <p className={css.hint}>Click the map to add the next waypoint</p>
      ) : (
        <div className={
          hasAnyWca && takeoffTime && hasAnyEte ? css.plogWcaEteEta :
          hasAnyWca && hasAnyEte               ? css.plogWcaEte :
          hasAnyWca                            ? css.plogWca :
          takeoffTime && hasAnyEte             ? css.plogEteEta :
          hasAnyEte                            ? css.plogEte :
          css.plog
        }>
          <div className={legs.length > 10 ? css.plogBodyScroll : css.plogBody}>
            {legs.map((leg, i) => {
              const ete = legEtes[i]
              const eta = legEtas[i]
              const hasOverride = !!(legOverrides[i]?.altFt || legOverrides[i]?.speedKts || legOverrides[i]?.windDir || legOverrides[i]?.windSpd)
              return (
                <div
                  key={i}
                  className={`${css.row}${activeLeg === i ? ` ${css.rowActive}` : ''}${overIdx === i ? ` ${css.rowDragOver}` : ''}`}
                  onDragOver={(e) => { e.preventDefault(); if (overIdx !== i) setOverIdx(i) }}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (dragIdx != null) onReplace(moveWaypoint(waypoints, dragIdx, i))
                    setDragIdx(null); setOverIdx(null)
                  }}
                  onDragEnd={() => { setDragIdx(null); setOverIdx(null) }}
                >
                  <div
                    className={css.wp}
                    draggable
                    title="Drag to reorder"
                    onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; setDragIdx(i) }}
                  >{leg.fromName}</div>
                  <div
                    className={`${css.arrow}${hasOverride ? ` ${css.arrowSet}` : ''} ${css.arrowBtn}`}
                    title="Edit leg properties"
                    onClick={() => setActiveLeg(i === activeLeg ? null : i)}
                  >→</div>
                  <div
                    className={css.wp}
                    draggable={i === legs.length - 1}
                    title={i === legs.length - 1 ? 'Drag to reorder' : undefined}
                    onDragStart={i === legs.length - 1 ? (e) => { e.dataTransfer.effectAllowed = 'move'; setDragIdx(i + 1) } : undefined}
                  >{leg.toName}</div>
                  <div className={css.brg}>{String(Math.round(leg.magBrg)).padStart(3, '0')}°M</div>
                  {hasAnyWca && (
                    <div className={css.wca}>
                      {legWcas[i] != null && Math.abs(legWcas[i]!) >= 1
                        ? (legWcas[i]! > 0 ? `+${legWcas[i]}` : String(legWcas[i])) + '°'
                        : ''}
                    </div>
                  )}
                  <div className={css.brgTrue}>{String(Math.round(leg.brg)).padStart(3, '0')}°T</div>
                  <div className={css.dist}>{nmToDisplay(leg.dist, units.distance).toFixed(1)} {distLabel(units.distance)}</div>
                  {hasAnyEte && (
                    <div className={css.ete} title={legSpeedTip(i)}>
                      {ete != null
                        ? `${Math.floor(ete)}:${String(Math.round((ete % 1) * 60)).padStart(2, '0')}`
                        : '—'}
                    </div>
                  )}
                  {takeoffTime && hasAnyEte && (
                    <div className={css.eta}>
                      {eta ? fmtUtc(eta) : '—'}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <div className={css.total}>
            <div className={css.totalLabel}>Total</div>
            <div /><div />
            <div />{hasAnyWca && <div />}<div />
            <div className={css.dist}>{nmToDisplay(totalNm, units.distance).toFixed(1)} {distLabel(units.distance)}</div>
            {hasAnyEte && (
              <div className={css.ete}>
                {Math.floor(totalEteMin)}:{String(Math.round((totalEteMin % 1) * 60)).padStart(2, '0')}
              </div>
            )}
            {takeoffTime && hasAnyEte && (
              <div className={css.eta}>
                {legEtas[legEtas.length - 1] ? fmtUtc(legEtas[legEtas.length - 1]!) : '—'}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Alternate Destination ───────────────────────────────────── */}
      {waypoints.length >= 1 && (
        <div className={css.altSection}>
          <div className={css.altRow}>
            <span className={css.altLabel}>ALT</span>
            {alternate ? (
              <>
                <span className={css.altName}>{alternate.icao}</span>
                {waypoints.length >= 1 && (() => {
                  const dest = waypoints[waypoints.length - 1]
                  const d = distanceNm(dest, alternate)
                  return <span className={css.altDist}>{nmToDisplay(d, units.distance).toFixed(1)} {distLabel(units.distance)}</span>
                })()}
                <button className={css.altClear} title="Remove alternate" onClick={() => setAlternate(null)}>✕</button>
              </>
            ) : (
              <>
                <input
                  className={css.altInput}
                  placeholder="ICAO"
                  title="Alternate aerodrome ICAO"
                  value={altInput}
                  onChange={e => { setAltInput(e.target.value.toUpperCase()); setAltError('') }}
                  onKeyDown={e => { if (e.key === 'Enter') handleAltSubmit() }}
                  disabled={altLoading}
                  maxLength={6}
                />
                <button className={css.btn} onClick={handleAltSubmit} disabled={altLoading || !altInput.trim()}>
                  {altLoading ? '…' : 'Set'}
                </button>
              </>
            )}
          </div>
          {altError && <p className={css.kbError}>{altError}</p>}
        </div>
      )}

      {activeLeg !== null && activeLeg < legs.length && (
        <LegPropsPanel
          legIndex={activeLeg}
          fromName={legs[activeLeg].fromName}
          toName={legs[activeLeg].toName}
          distNm={legs[activeLeg].dist}
          trueBrg={legs[activeLeg].brg}
          magBrg={legs[activeLeg].magBrg}
          midLat={legs[activeLeg].midLat}
          midLng={legs[activeLeg].midLng}
          override={legOverrides[activeLeg] ?? {}}
          units={units}
          defaultAltFt={defaultAltFt}
          defaultSpeedKts={defaultSpeedKts}
          globalWind={globalWind}
          wpNote={waypoints[activeLeg + 1]?.note ?? ''}
          onSaveNote={(destWpIdx, note) => onSetWaypointNote(destWpIdx, note)}
          onSave={(idx, ovr) => {
            onSetLegOverride(idx, ovr)
            setActiveLeg(null)
          }}
          onClose={() => setActiveLeg(null)}
        />
      )}
    </div>
  )
}
