/**
 * notamTextSegments.ts -- a NOTAM text cut into plain and coordinate parts,
 * so a detail view can make each coordinate tappable (web + native). Uses the
 * shared coordinate scanner, so every notation it knows is found.
 *
 * NMS texts break lines anywhere, also inside a coordinate
 * ("545000N010000\n0E"); a line break between two digits is looked through,
 * the segment text keeps the original characters.
 */
import { findCoordinates } from './coordinateParse'

export type NotamTextSegment =
  | { kind: 'text'; text: string }
  | { kind: 'coordinate'; text: string; lat: number; lng: number }

export function splitNotamTextCoordinates(text: string): NotamTextSegment[] {
  // Scan a copy without digit-to-digit line breaks; `map[i]` is the offset in
  // `text` of character i of the copy.
  let scan = ''
  const map: number[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if ((ch === '\n' || ch === '\r') && /\d/.test(scan[scan.length - 1] ?? '')) {
      let j = i
      while (text[j] === '\n' || text[j] === '\r') j++
      if (/\d/.test(text[j] ?? '')) { i = j - 1; continue }
    }
    scan += ch
    map.push(i)
  }
  const out: NotamTextSegment[] = []
  let at = 0
  for (const c of findCoordinates(scan)) {
    const start = map[c.start]!
    const end = map[c.end - 1]! + 1
    if (start < at) continue
    if (start > at) out.push({ kind: 'text', text: text.slice(at, start) })
    out.push({ kind: 'coordinate', text: text.slice(start, end), lat: c.lat, lng: c.lng })
    at = end
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) })
  return out
}
