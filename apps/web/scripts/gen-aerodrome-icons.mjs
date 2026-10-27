// Generates the aerodrome chart symbols in public/poi_icons/ (shared with
// native: apps/native/scripts/gen-poi-icons.mjs rasterises them to PNGs).
// Run with: node apps/web/scripts/gen-aerodrome-icons.mjs
//
// Chart convention: a circle with the main runway drawn through it. The runway
// points north in the file; the map layer turns it to the real runway bearing
// (icon-rotate = rwy_brg, aligned to the map).
//
//   ad-<kind>-<bar>
//     kind  civ       filled circle  -- civil, controlled (tower)
//           civ-open  open circle    -- civil, uncontrolled
//           mil       filled red     -- military
//           joint     filled circle in a red ring -- joint civil/military
//           minor     small faint ring -- private / ultralight / glider
//     bar   hard      solid runway (paved)
//           soft      outlined runway (grass, gravel, ...)
//           none      no runway data
//   ad-closed  faint ring with a cross
import { writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { AERODROME_SYMBOL_COLORS } from '@open-vfr/shared/aerodromeSymbol'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'poi_icons')

const { civil: CIVIL, military: MILITARY, minor: MINOR } = AERODROME_SYMBOL_COLORS
const EDGE = '#ffffff'

const KINDS = {
  civ: { r: 7, fill: CIVIL, stroke: EDGE, sw: 1.6, color: CIVIL },
  'civ-open': { r: 7, fill: EDGE, stroke: CIVIL, sw: 2.4, color: CIVIL },
  mil: { r: 7, fill: MILITARY, stroke: EDGE, sw: 1.6, color: MILITARY },
  joint: { r: 7, fill: CIVIL, stroke: EDGE, sw: 1.6, color: CIVIL, ring: MILITARY },
  minor: { r: 5, fill: EDGE, stroke: MINOR, sw: 1.8, color: MINOR, opacity: 0.85, small: true },
}

function bar(kind, style) {
  if (style === 'none') return ''
  const k = KINDS[kind]
  // Wide enough to read its direction at small map sizes, and longer than
  // the circle so the runway sticks out on both sides.
  const w = k.small ? 3.2 : 4.4
  const len = k.small ? 20 : 26.4
  const x = (14 - w / 2).toFixed(2)
  const y = (14 - len / 2).toFixed(2)
  return style === 'hard'
    ? `<rect x="${x}" y="${y}" width="${w}" height="${len}" rx="0.6" fill="${k.color}" stroke="${EDGE}" stroke-width="1.2"/>`
    : `<rect x="${x}" y="${y}" width="${w}" height="${len}" rx="0.6" fill="${EDGE}" stroke="${k.color}" stroke-width="1.4"/>`
}

function svg(body, opacity) {
  const g = opacity ? `<g opacity="${opacity}">${body}</g>` : body
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28">${g}</svg>\n`
}

const written = []
for (const [kind, k] of Object.entries(KINDS)) {
  for (const style of ['hard', 'soft', 'none']) {
    const ring = k.ring ? `<circle cx="14" cy="14" r="${k.r + 2.6}" fill="none" stroke="${k.ring}" stroke-width="2"/>` : ''
    const circle = `<circle cx="14" cy="14" r="${k.r}" fill="${k.fill}" stroke="${k.stroke}" stroke-width="${k.sw}"/>`
    const id = `ad-${kind}-${style}`
    writeFileSync(join(OUT_DIR, `${id}.svg`), svg(ring + circle + bar(kind, style), k.opacity))
    written.push(id)
  }
}
{
  const d = 3.2
  const body = `<circle cx="14" cy="14" r="5.5" fill="${EDGE}" stroke="${MINOR}" stroke-width="1.8"/>`
    + `<path d="M${14 - d},${14 - d}L${14 + d},${14 + d}M${14 + d},${14 - d}L${14 - d},${14 + d}" fill="none" stroke="${MINOR}" stroke-width="1.6" stroke-linecap="round"/>`
  writeFileSync(join(OUT_DIR, 'ad-closed.svg'), svg(body, 0.85))
  written.push('ad-closed')
}
console.log(written.join('\n'))
