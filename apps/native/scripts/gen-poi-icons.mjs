// One-off script: rasterize the POI/obstacle/navaid/aerodrome SVGs
// (public/poi_icons/) to colored PNGs for MapLibre RN's Images/icon-image.
// Colors match src/utils/{obstacle,landmark,navaid,aerodrome}Icons.ts exactly.
// Run with: node scripts/gen-poi-icons.mjs
import { Resvg } from '@resvg/resvg-js'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = join(__dirname, '..', '..', 'web', 'public', 'poi_icons')
const OUT_DIR = join(__dirname, '..', 'assets', 'poi_icons')
mkdirSync(OUT_DIR, { recursive: true })

// [id, color, sizePx] — sizePx matches web's SZ2 (logical px × 2 for HiDPI)
const ICONS = [
  // Obstacles (SZ2=56)
  ['obs-wind-turbine', '#c07800', 56],
  ['obs-tower',        '#c92a2a', 56],
  ['obs-chimney',      '#7c2d12', 56],
  ['obs-building',     '#6b7280', 56],
  ['obs-other',        '#c45a00', 56],
  // Landmarks (SZ2=56)
  ['lmk-church',      '#455a64', 56],
  ['lmk-mast',        '#e65100', 56],
  ['lmk-windmill',    '#5d4037', 56],
  ['lmk-water-tower', '#00695c', 56],
  ['lmk-chimney',     '#bf360c', 56],
  // Navaids/waypoints (SZ2=48)
  ['nav-vor', '#5c4ae4', 48],
  ['nav-ndb', '#c05200', 48],
  ['wp-mrp',  '#0ca678', 48],
  ['wp-rp',   '#20c997', 48],
  // Aerodromes (SZ2=56)
  ['ad-airport',  '#1a56db', 56],
  ['ad-heliport', '#9333ea', 56],
]

for (const [id, color, sizePx] of ICONS) {
  const svgPath = join(SRC_DIR, `${id}.svg`)
  let svg = readFileSync(svgPath, 'utf8')

  // Same recolor injection as web's registerColoredSvgIcon: fill covers the
  // plain-black Temaki/Maki downloads, color covers our currentColor-based
  // hand-written geometric symbols. Both attributes are harmless no-ops on
  // whichever convention doesn't apply to a given source file.
  svg = svg.replace(/(<svg\b)/, `$1 fill="${color}" color="${color}"`)

  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: sizePx },
    background: 'rgba(0,0,0,0)',
  })
  const png = resvg.render().asPng()
  const outPath = join(OUT_DIR, `${id}.png`)
  writeFileSync(outPath, png)
  console.log('wrote', outPath)
}
