// One-off script: rasterize the web app's aircraft SVGs to white-on-dark PNGs
// for MapLibre RN's Images/icon-image (raster only, no live SVG support).
// Run with: node scripts/gen-aircraft-icons.mjs
import { Resvg } from '@resvg/resvg-js'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = join(__dirname, '..', '..', 'public', 'aircraft_icons')
const OUT_DIR = join(__dirname, '..', 'assets', 'aircraft_icons')
mkdirSync(OUT_DIR, { recursive: true })

// Category → source svg, matches src/utils/aircraftIcon.ts CATEGORY_ICON map
const ICONS = ['cessna', 'a2', 'b4', 'a7', 'b1']

const SIZE = 80 // 40 logical px @ 2x, matches web SZ2

for (const name of ICONS) {
  const svgPath = join(SRC_DIR, `${name}.svg`)
  let svg = readFileSync(svgPath, 'utf8')

  // Same recolor treatment as web registerAircraftImageFromSvg: white fill,
  // dark stroke sized proportionally to the viewBox.
  const vbMatch = svg.match(/viewBox="[\d.]+ [\d.]+ ([\d.]+)/)
  const vbWidth = vbMatch ? parseFloat(vbMatch[1]) : 200
  const sw = Math.round(vbWidth * 0.025)
  svg = svg.replace(/(<svg\b)/, `$1 fill="white" stroke="#1a1a2e" stroke-width="${sw}"`)

  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: SIZE },
    background: 'rgba(0,0,0,0)',
  })
  const png = resvg.render().asPng()
  const outPath = join(OUT_DIR, `${name}.png`)
  writeFileSync(outPath, png)
  console.log('wrote', outPath)
}
