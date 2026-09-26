/**
 * Shareable map links: parse/build the query-string state that lets a link
 * open the app directly on an aerodrome or a map position.
 *
 *   ?ad=ESSB                 open aerodrome ESSB (fly there + details)
 *   ?c=5939N01756E&z=11      centre on a coordinate (any format that
 *                            coordinateParse understands) at zoom 11
 *
 * Everything is validated -- a malformed or hostile parameter is ignored,
 * never partially applied.
 */
import { parseCoordinate } from './coordinateParse'

export interface MapLink {
  /** ICAO location indicator, uppercase. */
  ad?: string
  center?: { lat: number; lng: number }
  zoom?: number
}

const ICAO_RE = /^[A-Z]{2}[A-Z0-9]{2}$/
const MIN_ZOOM = 3
const MAX_ZOOM = 18

export function parseMapLink(search: string): MapLink {
  const q = new URLSearchParams(search)
  const out: MapLink = {}

  const ad = q.get('ad')?.trim().toUpperCase()
  if (ad && ICAO_RE.test(ad)) out.ad = ad

  const c = q.get('c')
  if (c) {
    const p = parseCoordinate(c)
    if (p) out.center = { lat: p.lat, lng: p.lng }
  }

  const zRaw = q.get('z')
  if (zRaw !== null && zRaw.trim() !== '') {
    const z = Number(zRaw)
    if (Number.isFinite(z) && z >= MIN_ZOOM && z <= MAX_ZOOM) out.zoom = z
  }
  return out
}

/** True when the link carries anything actionable. */
export function hasMapLink(l: MapLink): boolean {
  return !!(l.ad || l.center)
}

/** Query params this module owns -- strip after applying so a reload
 *  doesn't re-trigger the link over whatever the user did since. */
export const MAP_LINK_PARAMS = ['ad', 'c', 'z'] as const

export function stripMapLinkParams(url: string): string {
  const u = new URL(url)
  for (const k of MAP_LINK_PARAMS) u.searchParams.delete(k)
  return u.toString()
}

/** `baseUrl` = app origin + path, e.g. `${location.origin}${location.pathname}`. */
export function buildAerodromeLink(baseUrl: string, icao: string): string {
  const u = new URL(baseUrl)
  u.search = ''
  u.searchParams.set('ad', icao.toUpperCase())
  return u.toString()
}

export function buildPositionLink(baseUrl: string, lat: number, lng: number, zoom?: number): string {
  const u = new URL(baseUrl)
  u.search = ''
  u.searchParams.set('c', `${lat.toFixed(5)},${lng.toFixed(5)}`)
  if (zoom !== undefined) u.searchParams.set('z', String(Math.round(zoom * 10) / 10))
  return u.toString()
}
