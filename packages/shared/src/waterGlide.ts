/**
 * waterGlide — where a route is over water, how far it gets from land, and
 * whether the aircraft could glide to land from its planned altitude there.
 *
 * Water: lakes from the country water dataset (polygons, islands as holes)
 * and the sea from the maximum-elevation grid (`mefGrid.ts`): the pipeline
 * writes every cell that does not touch land (OSM land polygons, any
 * country) as no-data, so inside a grid's extent no-data is open sea.
 * Distance to land over the sea comes from a distance transform of that grid
 * around the route (cells of ~460 m, so to within about a quarter of a NM);
 * over a lake it is the distance to its shore. Outside every loaded grid
 * nothing is known: no stretch is reported there.
 *
 * Glide: from the planned altitude above the water surface, with the
 * profile's glide ratio (or a typical one for the category, marked as
 * assumed). With a wind on the leg the area you can reach is the still-air
 * circle moved downwind by the drift during the glide (wind x glide time,
 * glide time = distance / best-glide speed): land upwind is reached less
 * far, land downwind further. Without one it is a circle. Turns, gusts and
 * the time to set up a glide are not modelled.
 */
import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import type { RouteWaypoint } from './routeCalc'
import { distanceNm } from './routeCalc'
import { coordinateAlongRouteNm } from './virtualRadarCalc'
import { nearestRoutePoint } from './notamRouteFilter'
import { MEF_NODATA, type MefGrid } from './mefGrid'
import type { AircraftCategory } from './types'

const FT_PER_NM = 6076.12
/** Sample spacing along the route, NM. */
const STEP_NM = 0.5
/** Stretches never further than this from land are not reported (rivers, bays, narrow lakes). */
const MIN_REPORT_NM = 1
/** How far around the route the distance transform looks for land, NM. */
const SEARCH_NM = 40

/** Typical best-glide speeds (kt) when the profile has none, for the drift in the wind. */
const DEFAULT_GLIDE_KTS: Record<AircraftCategory, number> = { SEP: 70, MEP: 85, MICRO: 50, GYRO: 50, HELI: 60, TMG: 55, GLIDER: 50 }

/** Typical still-air glide ratios when the profile has none. */
const DEFAULT_GLIDE: Record<AircraftCategory, number> = { SEP: 8, MEP: 8, MICRO: 8, GYRO: 3, HELI: 4, TMG: 20, GLIDER: 30 }

export interface WaterStretch {
  /** 0-based leg where the furthest point lies. */
  legIndex: number
  /** Along the route, NM. */
  fromNm: number
  toNm: number
  name: string
  sea: boolean
  /** Furthest from land, NM, and where (route NM). */
  maxFromLandNm: number
  atNm: number
  /** Planned altitude and water surface there, ft. */
  altFt: number
  surfaceFt: number
  glideRatio: number
  glideAssumed: boolean
  /** Still-air glide distance from the planned altitude, NM. */
  glideRangeNm: number
  /** Altitude needed to reach land in still air from the furthest point, ft (rounded up to 100). */
  neededFt: number
  /** Length of the stretch beyond gliding distance from land, NM (0 = always within). */
  beyondGlideNm: number
  /** Wind on the leg of the furthest point that was used (from, degrees; knots), null when none. */
  wind: { fromDeg: number; kts: number } | null
  /** How far the reachable area is moved downwind from the furthest point, NM (0 without wind). */
  driftNm: number
}

type Poly = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>

function rings(f: Poly): { lat: number; lng: number }[][] {
  const g = f.geometry
  const rs = g.type === 'Polygon' ? g.coordinates : g.coordinates.flat()
  return rs.map(r => r.map(([lng, lat]) => ({ lat: lat!, lng: lng! })))
}

/** Boxes are kept per feature: the water dataset has tens of thousands of lakes and is reused. */
const boxCache = new WeakMap<object, [number, number, number, number]>()
function bboxOf(f: Poly): [number, number, number, number] {
  const hit = boxCache.get(f)
  if (hit) return hit
  const b = bboxRaw(f)
  boxCache.set(f, b)
  return b
}
function bboxRaw(f: Poly): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
  const g = f.geometry
  for (const r of g.type === 'Polygon' ? g.coordinates : g.coordinates.flat()) {
    for (const [x, y] of r) { if (x! < w) w = x!; if (x! > e) e = x!; if (y! < s) s = y!; if (y! > n) n = y! }
  }
  return [w, s, e, n]
}

/**
 * Distance (NM) from each sea cell to the nearest land cell, for the part of
 * a grid around the route: a two-pass chamfer transform over cells of their
 * real size. Land = any cell with a value; sea = no-data inside the grid.
 */
function seaDistance(grid: MefGrid, box: [number, number, number, number]) {
  const c0 = Math.max(0, Math.floor((box[0] - grid.west) / grid.cellLon))
  const c1 = Math.min(grid.cols - 1, Math.ceil((box[2] - grid.west) / grid.cellLon))
  const r0 = Math.max(0, Math.floor((grid.north - box[3]) / grid.cellLat))
  const r1 = Math.min(grid.rows - 1, Math.ceil((grid.north - box[1]) / grid.cellLat))
  if (c1 < c0 || r1 < r0) return null
  const w = c1 - c0 + 1, h = r1 - r0 + 1
  const midLat = grid.north - ((r0 + r1) / 2) * grid.cellLat
  const dy = grid.cellLat * 60
  const dx = grid.cellLon * 60 * Math.cos((midLat * Math.PI) / 180)
  const dd = Math.hypot(dx, dy)
  const d = new Float32Array(w * h).fill(Infinity)
  const sea = new Uint8Array(w * h)
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const code = grid.codes[(r0 + r) * grid.cols + (c0 + c)]!
      if (code === MEF_NODATA) sea[r * w + c] = 1
      else d[r * w + c] = 0
    }
  }
  const at = (r: number, c: number) => d[r * w + c]!
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      let v = at(r, c)
      if (v === 0) continue
      if (c > 0) v = Math.min(v, at(r, c - 1) + dx)
      if (r > 0) {
        v = Math.min(v, at(r - 1, c) + dy)
        if (c > 0) v = Math.min(v, at(r - 1, c - 1) + dd)
        if (c < w - 1) v = Math.min(v, at(r - 1, c + 1) + dd)
      }
      d[r * w + c] = v
    }
  }
  for (let r = h - 1; r >= 0; r--) {
    for (let c = w - 1; c >= 0; c--) {
      let v = at(r, c)
      if (v === 0) continue
      if (c < w - 1) v = Math.min(v, at(r, c + 1) + dx)
      if (r < h - 1) {
        v = Math.min(v, at(r + 1, c) + dy)
        if (c < w - 1) v = Math.min(v, at(r + 1, c + 1) + dd)
        if (c > 0) v = Math.min(v, at(r + 1, c - 1) + dd)
      }
      d[r * w + c] = v
    }
  }
  return {
    /** null = not open sea here (land, no data, or outside). */
    distAt(lat: number, lng: number): number | null {
      const c = Math.floor((lng - grid.west) / grid.cellLon) - c0
      const r = Math.floor((grid.north - lat) / grid.cellLat) - r0
      if (r < 0 || c < 0 || r >= h || c >= w || !sea[r * w + c]) return null
      const v = d[r * w + c]!
      return Number.isFinite(v) ? v : null
    },
  }
}

export function waterStretches(input: {
  waypoints: readonly RouteWaypoint[]
  /** Planned altitude at a distance along the route, ft. */
  altAt: (distNm: number) => number
  grids: readonly MefGrid[]
  water?: GeoJSON.FeatureCollection | null
  aircraft?: { category?: AircraftCategory; glideRatio?: number; bestGlideKts?: number } | null
  /** Wind per leg (from degrees, knots); null/missing = still air on that leg. */
  legWinds?: readonly ({ dirDeg: number; speedKts: number } | null)[]
}): WaterStretch[] {
  const wps = input.waypoints
  if (wps.length < 2) return []
  const legEnds: number[] = [0]
  for (let i = 1; i < wps.length; i++) legEnds.push(legEnds[i - 1]! + distanceNm(wps[i - 1]!, wps[i]!))
  const total = legEnds[legEnds.length - 1]!
  if (!(total > 0)) return []

  // Route box, widened by the search distance (degrees).
  const lats = wps.map(w => w.lat), lngs = wps.map(w => w.lng)
  const padLat = SEARCH_NM / 60, padLng = SEARCH_NM / (60 * Math.cos((((Math.min(...lats) + Math.max(...lats)) / 2) * Math.PI) / 180))
  const box: [number, number, number, number] = [Math.min(...lngs) - padLng, Math.min(...lats) - padLat, Math.max(...lngs) + padLng, Math.max(...lats) + padLat]
  const tight: [number, number, number, number] = [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)]

  const allLakes = (input.water?.features ?? []).filter((f): f is Poly => !!f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'))
    .map(f => ({ f, b: bboxOf(f) }))
  // Near the route (for the stretches) and around it (for where the wind carries the glide).
  const lakes = allLakes.filter(({ b }) => b[0] <= tight[2] && b[2] >= tight[0] && b[1] <= tight[3] && b[3] >= tight[1])
  const lakesAround = allLakes.filter(({ b }) => b[0] <= box[2] && b[2] >= box[0] && b[1] <= box[3] && b[3] >= box[1])
  const seas = input.grids.map(g => seaDistance(g, box)).filter((s): s is NonNullable<typeof s> => !!s)

  const cat = input.aircraft?.category ?? 'SEP'
  const ratio = input.aircraft?.glideRatio && input.aircraft.glideRatio > 0 ? input.aircraft.glideRatio : DEFAULT_GLIDE[cat]
  const assumed = !(input.aircraft?.glideRatio && input.aircraft.glideRatio > 0)

  const glideKts = input.aircraft?.bestGlideKts && input.aircraft.bestGlideKts > 0 ? input.aircraft.bestGlideKts : DEFAULT_GLIDE_KTS[cat]
  const legOfNm = (nm: number) => Math.max(0, Math.min(wps.length - 2, legEnds.findIndex(e => e >= nm - 1e-6) - 1))
  const windAt = (nm: number) => {
    const w = input.legWinds?.[legOfNm(nm)]
    return w && w.speedKts > 0 && Number.isFinite(w.dirDeg) ? w : null
  }

  /** Distance (NM) from a point to the nearest land: 0 on land, null where nothing is known. */
  const landDistAt = (lat: number, lng: number): number | null => {
    for (const { f, b } of lakesAround) {
      if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) continue
      if (!booleanPointInPolygon([lng, lat], f)) continue
      let shore = Infinity
      for (const r of rings(f)) shore = Math.min(shore, nearestRoutePoint({ lat, lng }, r).lateralNm)
      return shore
    }
    let known = false
    for (const sd of seas) {
      const v = sd.distAt(lat, lng)
      if (v !== null) return v
    }
    for (const g of input.grids) {
      const col = Math.floor((lng - g.west) / g.cellLon), row = Math.floor((g.north - lat) / g.cellLat)
      if (row >= 0 && col >= 0 && row < g.rows && col < g.cols) { known = true; if (g.codes[row * g.cols + col] !== MEF_NODATA) return 0 }
    }
    return known ? 0 : null
  }
  /** The point the glide circle is centred on: moved downwind by the drift while gliding `rangeNm`. */
  const driftedCentre = (p: { lat: number; lng: number }, rangeNm: number, w: { dirDeg: number; speedKts: number }) => {
    const drift = rangeNm * (w.speedKts / glideKts)
    const to = ((w.dirDeg + 180) * Math.PI) / 180
    return { drift, lat: p.lat + (drift * Math.cos(to)) / 60, lng: p.lng + (drift * Math.sin(to)) / (60 * Math.cos((p.lat * Math.PI) / 180)) }
  }
  /** Can a glide of `rangeNm` from p reach land? Wind moves the circle; unknown ground near the shifted centre falls back to still air. */
  const reaches = (p: { lat: number; lng: number }, still: number, rangeNm: number, w: { dirDeg: number; speedKts: number } | null): boolean => {
    if (!w) return still <= rangeNm
    const c = driftedCentre(p, rangeNm, w)
    const d = landDistAt(c.lat, c.lng)
    return (d === null ? still : d) <= rangeNm
  }

  type Sample = { nm: number; dist: number; sea: boolean; name: string; surfaceFt: number; lat: number; lng: number }
  const samples: (Sample | null)[] = []
  for (let nm = 0; nm <= total + 1e-6; nm += STEP_NM) {
    const p = coordinateAlongRouteNm([...wps], nm)
    let s: Sample | null = null
    for (const { f, b } of lakes) {
      if (p.lng < b[0] || p.lng > b[2] || p.lat < b[1] || p.lat > b[3]) continue
      if (!booleanPointInPolygon([p.lng, p.lat], f)) continue
      let shore = Infinity
      for (const r of rings(f)) shore = Math.min(shore, nearestRoutePoint(p, r).lateralNm)
      let surface = 0
      for (const g of input.grids) {
        const col = Math.floor((p.lng - g.west) / g.cellLon), row = Math.floor((g.north - p.lat) / g.cellLat)
        const code = row >= 0 && col >= 0 && row < g.rows && col < g.cols ? g.codes[row * g.cols + col]! : MEF_NODATA
        if (code !== MEF_NODATA) surface = Math.max(surface, code * g.unitFt)
      }
      s = { nm, dist: shore, sea: false, name: String(f.properties?.['name'] ?? ''), surfaceFt: surface, lat: p.lat, lng: p.lng }
      break
    }
    if (!s) {
      let best: number | null = null
      for (const sd of seas) { const v = sd.distAt(p.lat, p.lng); if (v !== null && (best === null || v < best)) best = v }
      if (best !== null) s = { nm, dist: best, sea: true, name: '', surfaceFt: 0, lat: p.lat, lng: p.lng }
    }
    samples.push(s)
  }

  // Consecutive water samples of the same kind form a stretch.
  const out: WaterStretch[] = []
  let i = 0
  while (i < samples.length) {
    const first = samples[i]
    if (!first) { i++; continue }
    let j = i
    while (j + 1 < samples.length && samples[j + 1] && samples[j + 1]!.sea === first.sea && samples[j + 1]!.name === first.name) j++
    const run = samples.slice(i, j + 1) as Sample[]
    const far = run.reduce((a, b) => (b.dist > a.dist ? b : a))
    if (far.dist >= MIN_REPORT_NM) {
      const rangeAt = (x: Sample) => Math.max(0, input.altAt(x.nm) - x.surfaceFt) * ratio / FT_PER_NM
      const beyond = run.filter(x => !reaches(x, x.dist, rangeAt(x), windAt(x.nm))).length * STEP_NM
      const altFt = input.altAt(far.nm)
      const legIndex = Math.max(0, legEnds.findIndex(e => e >= far.nm - 1e-6) - 1)
      const fw = windAt(far.nm)
      // Altitude needed from the furthest point: still air has a formula; with wind scan the range up until land is reached.
      let neededFt = Math.ceil((far.surfaceFt + (far.dist * FT_PER_NM) / ratio) / 100) * 100
      if (fw) {
        neededFt = 99_999
        for (let r = 0.25; r <= 60; r += 0.25) {
          if (reaches(far, far.dist, r, fw)) { neededFt = Math.ceil((far.surfaceFt + (r * FT_PER_NM) / ratio) / 100) * 100; break }
        }
      }
      out.push({
        legIndex, fromNm: Math.round(run[0]!.nm * 10) / 10, toNm: Math.round(run[run.length - 1]!.nm * 10) / 10,
        name: first.name, sea: first.sea,
        maxFromLandNm: Math.round(far.dist * 10) / 10, atNm: Math.round(far.nm * 10) / 10,
        altFt, surfaceFt: far.surfaceFt, glideRatio: ratio, glideAssumed: assumed,
        glideRangeNm: Math.round(rangeAt(far) * 10) / 10,
        neededFt,
        beyondGlideNm: Math.round(beyond * 10) / 10,
        wind: fw ? { fromDeg: Math.round(((fw.dirDeg % 360) + 360) % 360), kts: Math.round(fw.speedKts) } : null,
        driftNm: fw ? Math.round(driftedCentre(far, rangeAt(far), fw).drift * 10) / 10 : 0,
      })
    }
    i = j + 1
  }
  return out
}
