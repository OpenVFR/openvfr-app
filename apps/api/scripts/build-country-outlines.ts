/**
 * Builds apps/api/src/country-outlines.json: simplified land outlines
 * (including islands) of every region in @open-vfr/shared/regions, used to
 * scope regional NOTAMs to what actually reaches a country (see
 * notamInRegions in @open-vfr/shared/notamRegionScope).
 *
 * Source: Natural Earth 1:10m Admin 0 Countries (public domain),
 *   https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_10m_admin_0_countries.geojson
 *
 * Usage (from apps/api):
 *   npx tsx scripts/build-country-outlines.ts <ne_10m_admin_0_countries.geojson>
 *
 * Polygons are clipped to Europe (overseas territories dropped) and
 * simplified (Douglas-Peucker, SIMPLIFY_DEG) -- a few hundred metres of
 * error is irrelevant next to the NOTAM scope buffer. Re-run only if the
 * region list changes.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { EUROPEAN_REGIONS } from '@open-vfr/shared/regions'

const SIMPLIFY_DEG = 0.005
// Europe incl. Canaries/Azores/Madeira, without e.g. French Guiana, Svalbard.
const EUROPE = { west: -32, south: 27, east: 45, north: 72 }
const MIN_RING_POINTS = 4

type Ring = number[][]
type Poly = Ring[]

function perpDist(p: number[], a: number[], b: number[]): number {
  const [x, y] = p as [number, number]
  const [x1, y1] = a as [number, number]
  const [x2, y2] = b as [number, number]
  const dx = x2 - x1, dy = y2 - y1
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(x - x1, y - y1)
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2))
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))
}

function simplify(ring: Ring, tol: number): Ring {
  if (ring.length <= MIN_RING_POINTS) return ring
  const keep = new Uint8Array(ring.length)
  keep[0] = 1; keep[ring.length - 1] = 1
  const stack: [number, number][] = [[0, ring.length - 1]]
  while (stack.length) {
    const [s, e] = stack.pop()!
    let max = 0, idx = -1
    for (let i = s + 1; i < e; i++) {
      const d = perpDist(ring[i]!, ring[s]!, ring[e]!)
      if (d > max) { max = d; idx = i }
    }
    if (max > tol && idx !== -1) { keep[idx] = 1; stack.push([s, idx], [idx, e]) }
  }
  return ring.filter((_, i) => keep[i]).map(([x, y]) => [Math.round(x! * 1e4) / 1e4, Math.round(y! * 1e4) / 1e4])
}

function inEurope(ring: Ring): boolean {
  const lons = ring.map(p => p[0]!), lats = ring.map(p => p[1]!)
  const cx = (Math.min(...lons) + Math.max(...lons)) / 2
  const cy = (Math.min(...lats) + Math.max(...lats)) / 2
  return cx >= EUROPE.west && cx <= EUROPE.east && cy >= EUROPE.south && cy <= EUROPE.north
}

const src = process.argv[2]
if (!src) { console.error('usage: build-country-outlines.ts <ne_10m_admin_0_countries.geojson>'); process.exit(1) }
const fc = JSON.parse(readFileSync(src, 'utf8')) as {
  features: { properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } }[]
}

const out: Record<string, number[][][][]> = {}
for (const { code } of EUROPEAN_REGIONS) {
  const iso = code.toUpperCase()
  const f = fc.features.find(x => x.properties['ISO_A2_EH'] === iso || x.properties['ISO_A2'] === iso)
  if (!f) { console.error(`no outline for ${code}`); process.exit(1) }
  const polys: Poly[] = f.geometry.type === 'Polygon'
    ? [f.geometry.coordinates as Poly]
    : (f.geometry.coordinates as Poly[])
  const kept: number[][][][] = []
  for (const poly of polys) {
    const outer = poly[0]
    if (!outer || !inEurope(outer)) continue
    const s = simplify(outer, SIMPLIFY_DEG)
    if (s.length >= MIN_RING_POINTS) kept.push([s]) // outer ring only: holes don't matter for "near"
  }
  out[code] = kept
  console.error(`${code}: ${kept.length} polygons, ${kept.reduce((n, p) => n + p[0]!.length, 0)} points`)
}

const here = dirname(fileURLToPath(import.meta.url))
const target = join(here, '..', 'src', 'country-outlines.json')
writeFileSync(target, JSON.stringify(out))
console.error(`wrote ${target}`)
