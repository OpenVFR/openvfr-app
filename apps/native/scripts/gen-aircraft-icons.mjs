// One-off script: rasterize the web app's aircraft SVGs to white-on-dark PNGs
// for MapLibre RN's Images/icon-image (raster only, no live SVG support).
// Run with: node scripts/gen-aircraft-icons.mjs
import { Resvg } from '@resvg/resvg-js'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = join(__dirname, '..', '..', 'web', 'public', 'aircraft_icons')
const OUT_DIR = join(__dirname, '..', 'assets', 'aircraft_icons')
mkdirSync(OUT_DIR, { recursive: true })

const SIZE = 80 // 40 logical px @ 2x, matches web SZ2

function renderIcon(svgName, strokeColor, outName) {
  const svgPath = join(SRC_DIR, `${svgName}.svg`)
  let svg = readFileSync(svgPath, 'utf8')

  // Same recolor treatment as web's registration code: white fill, dark
  // outline sized proportionally to the viewBox.
  const vbMatch = svg.match(/viewBox="[\d.]+ [\d.]+ ([\d.]+)/)
  const vbWidth = vbMatch ? parseFloat(vbMatch[1]) : 200
  const sw = Math.round(vbWidth * 0.025)
  svg = svg.replace(/(<svg\b)/, `$1 fill="white" stroke="${strokeColor}" stroke-width="${sw}"`)

  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: SIZE },
    background: 'rgba(0,0,0,0)',
  })
  const png = resvg.render().asPng()
  const outPath = join(OUT_DIR, `${outName}.png`)
  writeFileSync(outPath, png)
  console.log('wrote', outPath)
}

// ── Ownship marker set (VerticalProfile-adjacent usage; only 'cessna' is
// currently wired up as the live position icon in AviationMap.tsx) ─────────
const OWNSHIP_ICONS = ['cessna', 'a2', 'b4', 'a7', 'b1']
for (const name of OWNSHIP_ICONS) renderIcon(name, '#1a1a2e', name)

// ── Traffic layer icon set — mirrors web's TRAFFIC_ICON_ENTRIES
// (apps/web/src/utils/trafficIcons.ts) id-for-id and source-svg-for-source-svg,
// so a target renders the identical silhouette on both platforms. iconId
// selection logic itself lives in src/utils/trafficIcons.ts (category+speed
// → id); this script only rasterizes the fixed id→svg mapping. Stroke color
// matches web's traffic-icon registration (#1e293b) rather than the
// ownship set's #1a1a2e — cosmetically distinct outline for the two use
// cases even though both render white-on-dark-outline silhouettes.
const TRAFFIC_ICONS = [
  ['a0',      'traffic-icon-a0'],
  ['a7',      'traffic-icon-a7'],
  ['b1',      'traffic-icon-b1'],
  ['b2',      'traffic-icon-b2'],
  ['b3',      'traffic-icon-b3'],
  ['b4',      'traffic-icon-b4'],
  ['c0',      'traffic-icon-c0'],
  ['cessna',  'traffic-icon-cessna'],
  ['learjet', 'traffic-icon-learjet'],
  ['dh8a',    'traffic-icon-dh8a'],
  ['crjx',    'traffic-icon-crjx'],
  ['a320',    'traffic-icon-a320'],
  ['b737',    'traffic-icon-b737'],
  ['b747',    'traffic-icon-b747'],
  ['a380',    'traffic-icon-a380'],
  ['f15',     'traffic-icon-f15'],
]
for (const [svgName, outName] of TRAFFIC_ICONS) renderIcon(svgName, '#1e293b', outName)
