/**
 * GPX 1.1 import/export — shared web + native.
 *
 * Supports:
 *   - Routes  (<rte>/<rtept>)   <-> RouteWaypoint[]
 *   - Waypoints (<wpt>)         <-> UserWaypoint[]
 *
 * Custom open-vfr fields (note, folder) are round-tripped via a
 * <extensions><ovfr:xxx> block. Any GPX file lacking these extensions
 * still imports fine (fields simply come back undefined).
 *
 * No XML DOM dependency — uses a tiny hand-rolled parser/serializer so it
 * works identically in browser (Vite/web) and React Native (Hermes) without
 * DOMParser polyfills.
 */

export type RouteWaypoint = {
  lng: number
  lat: number
  name?: string
  note?: string
}

export type UserWaypoint = {
  id?: string
  name: string
  lng: number
  lat: number
  folder?: string
}

const GPX_NS = 'http://www.topografix.com/GPX/1/1'
const OVFR_NS = 'https://open-vfr.app/gpx-ext/1'

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Extract the text content of the first `<tag>...</tag>` inside `xml`. */
function extractTag(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return m ? xmlUnescape(m[1].trim()) : undefined
}

/** Extract all top-level occurrences of `<tag ...>...</tag>` or self-closing `<tag .../>`. */
function extractBlocks(xml: string, tag: string): string[] {
  const blocks: string[] = []
  const re = new RegExp(`<${tag}\\b[^>]*(?:\\/>|>[\\s\\S]*?<\\/${tag}>)`, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) blocks.push(m[0])
  return blocks
}

function attr(block: string, name: string): string | undefined {
  const m = block.match(new RegExp(`${name}="([^"]*)"`, 'i'))
  return m ? xmlUnescape(m[1]) : undefined
}

// ---------------------------------------------------------------------------
// Routes  (RouteWaypoint[])
// ---------------------------------------------------------------------------

export function routeToGpx(waypoints: RouteWaypoint[], routeName = 'Route'): string {
  const pts = waypoints
    .map(wp => {
      const nameTag = wp.name ? `<name>${xmlEscape(wp.name)}</name>` : ''
      const ext =
        wp.note ? `<extensions><ovfr:note xmlns:ovfr="${OVFR_NS}">${xmlEscape(wp.note)}</ovfr:note></extensions>` : ''
      return `    <rtept lat="${wp.lat}" lon="${wp.lng}">${nameTag}${ext}</rtept>`
    })
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="open-vfr" xmlns="${GPX_NS}">
  <rte>
    <name>${xmlEscape(routeName)}</name>
${pts}
  </rte>
</gpx>
`
}

export function gpxToRoute(xml: string): { name: string; waypoints: RouteWaypoint[] } {
  const rteBlocks = extractBlocks(xml, 'rte')
  if (rteBlocks.length === 0) throw new Error('No <rte> element found in GPX file')
  const rte = rteBlocks[0]
  const name = extractTag(rte, 'name') ?? 'Imported Route'

  const waypoints = extractBlocks(rte, 'rtept').map(pt => {
    const lat = Number(attr(pt, 'lat'))
    const lng = Number(attr(pt, 'lon'))
    const wpName = extractTag(pt, 'name')
    const note = extractTag(pt, 'ovfr:note')
    const wp: RouteWaypoint = { lat, lng }
    if (wpName) wp.name = wpName
    if (note) wp.note = note
    return wp
  })

  return { name, waypoints }
}

// ---------------------------------------------------------------------------
// Waypoints  (UserWaypoint[])
// ---------------------------------------------------------------------------

export function waypointsToGpx(waypoints: UserWaypoint[]): string {
  const pts = waypoints
    .map(wp => {
      const nameTag = `<name>${xmlEscape(wp.name)}</name>`
      const ext =
        wp.folder ? `<extensions><ovfr:folder xmlns:ovfr="${OVFR_NS}">${xmlEscape(wp.folder)}</ovfr:folder></extensions>` : ''
      return `  <wpt lat="${wp.lat}" lon="${wp.lng}">${nameTag}${ext}</wpt>`
    })
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="open-vfr" xmlns="${GPX_NS}">
${pts}
</gpx>
`
}

export function gpxToWaypoints(xml: string): UserWaypoint[] {
  return extractBlocks(xml, 'wpt').map(pt => {
    const lat = Number(attr(pt, 'lat'))
    const lng = Number(attr(pt, 'lon'))
    const name = extractTag(pt, 'name') ?? 'Waypoint'
    const folder = extractTag(pt, 'ovfr:folder')
    const wp: UserWaypoint = { name, lat, lng }
    if (folder) wp.folder = folder
    return wp
  })
}

// ---------------------------------------------------------------------------
// Flight track  (<trk>/<trkseg>/<trkpt>)  — recorded flight logs
// ---------------------------------------------------------------------------

export type GpxTrackPoint = {
  lat:    number
  lng:    number
  altFt:  number
  spdKts: number
  trkDeg: number
  /** Unix ms */
  ts:     number
}

const FT_TO_M = 0.3048
/** A hole longer than this starts a new <trkseg>, so viewers don't draw a straight line across a GPS dropout. */
const TRKSEG_GAP_MS = 30_000

/**
 * Serialise a recorded track. Altitude is exported in metres (GPX <ele>), time
 * as ISO 8601 UTC. Ground speed (kt) and track (deg) have no GPX 1.1 field, so
 * they ride in <extensions>; other tools ignore them, gpxToTrack reads them back.
 */
export function trackToGpx(points: GpxTrackPoint[], name = 'Flight'): string {
  const segs: GpxTrackPoint[][] = []
  for (const p of points) {
    const cur = segs[segs.length - 1]
    if (!cur || p.ts - cur[cur.length - 1].ts > TRKSEG_GAP_MS) segs.push([p])
    else cur.push(p)
  }
  const body = segs
    .map((seg) => {
      const pts = seg
        .map((p) => {
          const ele  = Number.isFinite(p.altFt) ? `<ele>${(p.altFt * FT_TO_M).toFixed(1)}</ele>` : ''
          const time = `<time>${new Date(p.ts).toISOString()}</time>`
          const ext  = `<extensions><ovfr:spd xmlns:ovfr="${OVFR_NS}">${Math.round(p.spdKts)}</ovfr:spd><ovfr:trk xmlns:ovfr="${OVFR_NS}">${Math.round(p.trkDeg)}</ovfr:trk></extensions>`
          return `      <trkpt lat="${p.lat}" lon="${p.lng}">${ele}${time}${ext}</trkpt>`
        })
        .join('\n')
      return `    <trkseg>\n${pts}\n    </trkseg>`
    })
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="open-vfr" xmlns="${GPX_NS}">
  <trk>
    <name>${xmlEscape(name)}</name>
${body}
  </trk>
</gpx>
`
}

/** Read a track back (own export or any GPX with <trk>). Missing speed/track become 0; points without a time are skipped. */
export function gpxToTrack(xml: string): { name: string; points: GpxTrackPoint[] } {
  const trk = extractBlocks(xml, 'trk')
  if (trk.length === 0) throw new Error('No <trk> element found in GPX file')
  const name = extractTag(trk[0], 'name') ?? 'Imported flight'
  const points: GpxTrackPoint[] = []
  for (const pt of extractBlocks(trk[0], 'trkpt')) {
    const timeStr = extractTag(pt, 'time')
    const ts = timeStr ? Date.parse(timeStr) : NaN
    const lat = Number(attr(pt, 'lat'))
    const lng = Number(attr(pt, 'lon'))
    if (!Number.isFinite(ts) || !Number.isFinite(lat) || !Number.isFinite(lng)) continue
    const ele = Number(extractTag(pt, 'ele'))
    const spd = extractTag(pt, 'ovfr:spd')
    const trk = extractTag(pt, 'ovfr:trk')
    points.push({
      lat, lng, ts,
      altFt:  Number.isFinite(ele) ? ele / FT_TO_M : 0,
      spdKts: spd !== undefined ? Number(spd) || 0 : NaN,
      trkDeg: trk !== undefined ? Number(trk) || 0 : NaN,
    })
  }
  points.sort((a, b) => a.ts - b.ts)
  fillDerivedMotion(points)
  return { name, points }
}

const NM_PER_DEG = 60

function legNm(a: GpxTrackPoint, b: GpxTrackPoint): number {
  const dLat = (b.lat - a.lat) * NM_PER_DEG
  const dLng = (b.lng - a.lng) * NM_PER_DEG * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180)
  return Math.sqrt(dLat * dLat + dLng * dLng)
}

function legBearingDeg(a: GpxTrackPoint, b: GpxTrackPoint): number {
  const dLat = b.lat - a.lat
  const dLng = (b.lng - a.lng) * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180)
  return (Math.atan2(dLng, dLat) * 180 / Math.PI + 360) % 360
}

/**
 * Files from other tools carry no ground speed or track. Derive them from the
 * movement to the next point (the last point reuses the previous leg), so the
 * stats and take-off/landing detection work on imported logs too.
 */
function fillDerivedMotion(points: GpxTrackPoint[]): void {
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (Number.isFinite(p.spdKts) && Number.isFinite(p.trkDeg)) continue
    const a = i + 1 < points.length ? p : points[i - 1]
    const b = i + 1 < points.length ? points[i + 1] : p
    if (!a || a === b) { if (!Number.isFinite(p.spdKts)) p.spdKts = 0; if (!Number.isFinite(p.trkDeg)) p.trkDeg = 0; continue }
    const hours = (b.ts - a.ts) / 3_600_000
    if (!Number.isFinite(p.spdKts)) p.spdKts = hours > 0 ? Math.round(legNm(a, b) / hours) : 0
    if (!Number.isFinite(p.trkDeg)) p.trkDeg = Math.round(legBearingDeg(a, b))
  }
}

/** Distance along a track in NM (straight legs). */
export function trackDistanceNm(points: { lat: number; lng: number }[]): number {
  let d = 0
  for (let i = 1; i < points.length; i++) d += legNm(points[i - 1] as GpxTrackPoint, points[i] as GpxTrackPoint)
  return d
}

/**
 * Flight-log document fields for a GPX file (`<trk>` with timed points), ready
 * to insert. Departure/arrival and aircraft are unknown (left blank); distance,
 * max altitude and the start/end times come from the track. Throws if the file
 * has fewer than two timed points.
 */
export function gpxToFlightLog(xml: string, id: string, now: number = Date.now()): {
  id: string; startedAt: number; endedAt: number; aircraftId: string; registration: string
  trackJson: string; departureIcao: string; arrivalIcao: string; distanceNm: number; maxAltFt: number; updatedAt: number
} {
  const { points } = gpxToTrack(xml)
  if (points.length < 2) throw new Error('GPX track needs at least two points with a time')
  return {
    id,
    startedAt:     points[0].ts,
    endedAt:       points[points.length - 1].ts,
    aircraftId:    '',
    registration:  '',
    trackJson:     JSON.stringify(points),
    departureIcao: '',
    arrivalIcao:   '',
    distanceNm:    trackDistanceNm(points),
    maxAltFt:      Math.max(0, ...points.map((p) => p.altFt)),
    updatedAt:     now,
  }
}

/** GPX file (name + content) for a stored flight log document. Throws if the track is empty or unreadable. */
export function flightLogToGpx(log: {
  startedAt: number; departureIcao: string; arrivalIcao: string; registration: string; trackJson: string
}): { filename: string; xml: string } {
  const points = JSON.parse(log.trackJson || '[]') as GpxTrackPoint[]
  if (!Array.isArray(points) || points.length === 0) throw new Error('This log has no track points')
  const date = new Date(log.startedAt).toISOString().slice(0, 10)
  const route = [log.departureIcao, log.arrivalIcao].filter(Boolean).join('-')
  const stem = [route, log.registration, date].filter(Boolean).join('_').replace(/[^A-Za-z0-9_-]+/g, '')
  const title = [[log.departureIcao, log.arrivalIcao].filter(Boolean).join(' → '), log.registration, date]
    .filter(Boolean).join(' · ')
  return { filename: `${stem || 'flight'}.gpx`, xml: trackToGpx(points, title) }
}
