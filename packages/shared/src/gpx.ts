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
