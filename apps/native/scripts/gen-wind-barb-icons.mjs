// One-off script: rasterize the WMO-style wind-barb icon set to PNGs for
// MapLibre RN's <Images>/icon-image (native can't canvas-draw icons at
// runtime the way web's registerWindBarbIcon does). Mirrors
// apps/web/src/utils/windBarbIcons.ts's drawWindBarb() geometry exactly
// (shaft + pennant/full-barb/half-barb feathers, calm circle), but built as
// an SVG string and rasterized with @resvg/resvg-js (same technique as
// gen-poi-icons.mjs) instead of node-canvas, since this workspace doesn't
// depend on node-canvas.
//
// Colour is now speed-tiered (blue/green/amber -- SkyDemon's "wind
// feather" convention, see @open-vfr/shared/windBarb's windBarbColorForSpeed,
// the single source of truth for the thresholds used here) rather than a
// flat colour, and the stroke is bolder than the first cut of this icon
// set -- both changes fixing wind arrows that had become nearly invisible
// on the map (2026-09-13 UX pass over-shrunk size/opacity; this script's
// original output was also a flat, thin, pale colour on top of that).
//
// Run with: node scripts/gen-wind-barb-icons.mjs
import { Resvg } from '@resvg/resvg-js'
import { writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dirname, '..', 'assets', 'poi_icons')
mkdirSync(OUT_DIR, { recursive: true })

// Must match @open-vfr/shared/windBarb exactly.
const STEP_KTS = 5
const MIN_KTS = 0
const MAX_KTS = 100
function windBarbColorForSpeed(speedKts) {
  if (speedKts < 10) return '#38bdf8' // light — sky blue
  if (speedKts < 25) return '#4ade80' // moderate — green
  return '#fbbf24' // strong — amber
}

const CANVAS_W = 64
const CANVAS_H = 96
const STROKE_W = 3 // matches web's windBarbIcons.ts drawWindBarb

function buildBarbSvg(bucket, color) {
  const originX = CANVAS_W / 2
  const stationY = CANVAS_H - 6
  const tipY = 10
  const shadowColor = 'rgba(0,0,0,0.55)'

  const shapes = [] // [d-or-line-params, fill|stroke]

  if (bucket < 3) {
    const cy = stationY - 10
    shapes.push({ type: 'circle', cx: originX, cy, r: 7 })
  } else {
    shapes.push({ type: 'line', x1: originX, y1: stationY, x2: originX, y2: tipY })

    let remaining = bucket
    const pennants = Math.floor(remaining / 50); remaining -= pennants * 50
    const fulls = Math.floor(remaining / 10); remaining -= fulls * 10
    const half = remaining >= 5 ? 1 : 0

    const barbGap = 8, barbLen = 15, halfLen = 8
    const rad = Math.PI / 3

    let y = tipY
    for (let i = 0; i < pennants; i++) {
      const y2 = y + barbGap
      shapes.push({
        type: 'tri',
        points: [
          [originX, y],
          [originX + barbLen * Math.sin(rad), y + barbLen * Math.cos(rad) * 0.5],
          [originX, y2],
        ],
      })
      y = y2
    }
    for (let i = 0; i < fulls; i++) {
      shapes.push({ type: 'line', x1: originX, y1: y, x2: originX + barbLen * Math.sin(rad), y2: y + barbLen * Math.cos(rad) })
      y += barbGap
    }
    if (half) {
      shapes.push({ type: 'line', x1: originX, y1: y, x2: originX + halfLen * Math.sin(rad), y2: y + halfLen * Math.cos(rad) })
    }
  }

  // Two passes per shape: a wider dark "shadow" stroke/fill underneath (to
  // approximate canvas's shadowBlur, which resvg's SVG filters render
  // inconsistently at this icon size), then the real coloured shape on top.
  const render = (shapes, stroke, fill, width) =>
    shapes
      .map((s) => {
        if (s.type === 'circle') {
          return `<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`
        }
        if (s.type === 'line') {
          return `<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`
        }
        // tri (pennant) — filled, no separate shadow fill needed as strongly, but keep for consistency
        const d = `M ${s.points[0][0]} ${s.points[0][1]} L ${s.points[1][0]} ${s.points[1][1]} L ${s.points[2][0]} ${s.points[2][1]} Z`
        return `<path d="${d}" fill="${fill}"/>`
      })
      .join('')

  const shadow = render(shapes, shadowColor, shadowColor, STROKE_W + 1.5)
  const main = render(shapes, color, color, STROKE_W)

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_W}" height="${CANVAS_H}" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}">${shadow}${main}</svg>`
}

for (let bucket = MIN_KTS; bucket <= MAX_KTS; bucket += STEP_KTS) {
  const color = windBarbColorForSpeed(bucket)
  const svg = buildBarbSvg(bucket, color)
  const resvg = new Resvg(svg, { background: 'rgba(0,0,0,0)' })
  const png = resvg.render().asPng()
  const outPath = join(OUT_DIR, `wind-barb-${bucket}.png`)
  writeFileSync(outPath, png)
  console.log('wrote', outPath)
}
